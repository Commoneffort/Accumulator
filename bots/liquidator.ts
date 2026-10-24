/**
 * Accumulator liquidator. Watches every position in each market, and when one is past
 * its liquidation threshold, repays the amount the program allows and takes
 * the collateral plus the bonus.
 *
 *   KEYPAIR=~/.config/solana/liquidator.json npx ts-node bots/liquidator.ts
 *
 * Env: RPC (default X1 mainnet), KEYPAIR (required), POLL_SECONDS (default 20),
 *      DRY_RUN=1 to only log what it would do,
 *      KEEP_XNT (native XNT kept for fees, default 0.5).
 *
 * Profit is the bonus (2% on pXNT, 5% on XNT collateral). On XNT collateral,
 * selling it on XDEX costs slippage in a thin pool; the bot doesn't sell.
 */
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import fs from "fs";
import os from "os";

import { AccumulatorClient, Market } from "../sdk/src/client";
import { MAINNET, NATIVE_MINT, BPS } from "../sdk/src/constants";
import { MAINNET_MARKETS } from "../sdk/src/markets";
import { accrued, collateralValue, debtOf, liquidationFee, maxLiquidationRepay, seizeForRepay, withinLimit } from "../sdk/src/math";

const RPC = process.env.RPC ?? MAINNET.rpc;
const POLL = Number(process.env.POLL_SECONDS ?? 20) * 1000;
const DRY = process.env.DRY_RUN === "1";
const KEEP = BigInt(Math.round(Number(process.env.KEEP_XNT ?? 0.5) * 1e9));

function loadKeypair(): Keypair {
  const p = (process.env.KEYPAIR ?? "").replace(/^~/, os.homedir());
  if (!p) throw new Error("set KEYPAIR to the liquidator's keypair file");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

async function tokenBalance(conn: Connection, account: PublicKey): Promise<bigint> {
  const info = await conn.getAccountInfo(account);
  return info ? Buffer.from(info.data).readBigUInt64LE(64) : 0n;
}

async function scan(conn: Connection, accumulator: AccumulatorClient, me: Keypair, m: Market) {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const state = accrued(m, now);
  let price: bigint;
  try {
    price = await accumulator.readPrice(m, "liquidate", now);
  } catch (e) {
    log(`[${m.address.toBase58().slice(0, 6)}] price unavailable: ${(e as Error).message}`);
    return;
  }

  const positions = await accumulator.fetchObligations(m.address);
  const unhealthy = positions
    .map((o) => {
      const debt = debtOf(state, o.borrowScaled);
      const value = collateralValue(o.collateral, price);
      return { o, debt, value };
    })
    .filter((p) => p.debt > 0n && !withinLimit(p.debt, p.value, m.params.liquidationThresholdBps))
    .sort((a, b) => (b.debt > a.debt ? 1 : -1));

  log(`[${m.address.toBase58().slice(0, 6)}] ${positions.length} positions, ${unhealthy.length} liquidatable`);
  if (!unhealthy.length) return;

  const lendAta = getAssociatedTokenAddressSync(m.lendMint, me.publicKey, false, m.lendTokenProgram);
  const collAta = getAssociatedTokenAddressSync(m.collateralMint, me.publicKey, false, m.collateralTokenProgram);

  for (const { o, debt, value } of unhealthy) {
    let repay = maxLiquidationRepay(debt, value, m.params);
    let seize = seizeForRepay(repay, price, m.params.liquidationBonusBps);
    if (seize > o.collateral) {
      seize = o.collateral;
      repay = (collateralValue(seize, price) * BPS) / (BPS + BigInt(m.params.liquidationBonusBps));
    }
    const ixs: TransactionInstruction[] = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
      createAssociatedTokenAccountIdempotentInstruction(me.publicKey, lendAta, me.publicKey, m.lendMint, m.lendTokenProgram),
      createAssociatedTokenAccountIdempotentInstruction(me.publicKey, collAta, me.publicKey, m.collateralMint, m.collateralTokenProgram),
    ];

    let have = await tokenBalance(conn, lendAta);
    if (have < repay && m.lendMint.equals(NATIVE_MINT)) {
      // Wrap native XNT to cover the repay, keeping some for fees.
      const native = BigInt(await conn.getBalance(me.publicKey));
      const wrap = repay - have;
      if (native > wrap + KEEP) {
        ixs.push(SystemProgram.transfer({ fromPubkey: me.publicKey, toPubkey: lendAta, lamports: wrap }), createSyncNativeInstruction(lendAta));
        have += wrap;
      }
    }
    if (have < repay) {
      if (have === 0n) {
        log(`  skip ${o.owner.toBase58()}: no ${m.lendMint.toBase58().slice(0, 6)} balance to repay with`);
        continue;
      }
      repay = have;
      seize = seizeForRepay(repay, price, m.params.liquidationBonusBps);
    }
    // What we receive after the protocol's share of the bonus; accept up to 1% less in case the price moves.
    const take = seize - liquidationFee(seize, m.params.liquidationBonusBps, m.params.liquidationFeeBps);
    const minOut = (take * 99n) / 100n;
    ixs.push(await accumulator.liquidate(m, o.address, me.publicKey, lendAta, collAta, repay, minOut));

    log(`  ${o.owner.toBase58()}: debt ${debt}, repay ${repay}, expect ${take} collateral`);
    if (DRY) continue;
    try {
      const sig = await sendAndConfirmTransaction(conn, new Transaction().add(...ixs), [me], { commitment: "confirmed" });
      log(`  liquidated: ${sig}`);
    } catch (e) {
      log(`  failed: ${(e as Error).message.split("\n")[0]}`);
    }
  }
}

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const me = loadKeypair();
  const accumulator = new AccumulatorClient(conn);
  const markets = (process.env.MARKETS?.split(",").map((s) => new PublicKey(s.trim())) ??
    Object.values(MAINNET_MARKETS).map((m) => m.address)) as PublicKey[];
  log(`liquidator ${me.publicKey.toBase58()} on ${RPC}${DRY ? " (dry run)" : ""}, ${markets.length} markets`);

  for (;;) {
    for (const addr of markets) {
      try {
        const m = await accumulator.fetchMarket(addr);
        await scan(conn, accumulator, me, m);
      } catch (e) {
        log(`[${addr.toBase58().slice(0, 6)}] ${(e as Error).message}`);
      }
    }
    await new Promise((r) => setTimeout(r, POLL));
  }
}

main();

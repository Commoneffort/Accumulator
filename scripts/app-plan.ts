/**
 * Builds the exact instructions the frontend sends (app/src/actions.ts) for a
 * scripted session and saves them to tests-rs/fixtures/app-plan.json. The Rust
 * test tests-rs/tests/app_flows.rs replays them against the compiled program.
 *
 *   npm run app-plan   (then: cd tests-rs && cargo test --release --test app_flows)
 */
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import fs from "fs";
import path from "path";

import * as act from "../app/src/actions";
import { Market, AccumulatorClient } from "../sdk/src/client";
import { NATIVE_MINT } from "../sdk/src/constants";
import { USDC_XNT_PARAMS, XNT_PXNT_PARAMS } from "../sdk/src/markets";
import { Params } from "../sdk/src/math";
import { collateralVaultPda, liquidityVaultPda, marketPda, shareMintPda } from "../sdk/src/pda";

const XNT = 1_000_000_000n;
const USD = 1_000_000n;
const key = (seed: string) => Keypair.fromSeed(Buffer.from(seed.padEnd(32, "-").slice(0, 32)));

const admin = key("admin"), alice = key("alice"), bob = key("bob");
const pxnt = key("pxnt-mint").publicKey;
const stakePool = key("stake-pool").publicKey;
const usdc = key("usdc-mint").publicKey;
const xdex = { pool: key("xdex-pool").publicKey, obs: key("xdex-obs").publicKey, v0: key("xdex-v0").publicKey, v1: key("xdex-v1").publicKey };

function offlineMarket(lendMint: PublicKey, collateralMint: PublicKey, lendTokenProgram: PublicKey, collateralTokenProgram: PublicKey,
  lendDecimals: number, oracleKind: "stakePool" | "xdexTwap", oracleAccounts: PublicKey[], params: Params): Market {
  const address = marketPda(lendMint, collateralMint);
  return {
    address, config: PublicKey.default, lendMint, lendTokenProgram, lendDecimals, collateralMint, collateralTokenProgram,
    collateralDecimals: 9, liquidityVault: liquidityVaultPda(address), collateralVault: collateralVaultPda(address),
    shareMint: shareMintPda(address), oracleKind, oracleAccounts, collateralIsToken0: oracleKind === "xdexTwap",
    params, pendingParams: params, pendingEta: 0n, hasPending: false, borrowPaused: false, cash: 0n, totalBorrowScaled: 0n,
    borrowIndex: 10n ** 18n, protocolFees: 0n, lastAccrualTs: 0n, totalCollateral: 0n, cumulativeBadDebt: 0n, protocolCollateralFees: 0n,
  };
}

(async () => {
  const accumulator = new AccumulatorClient(new Connection("http://127.0.0.1:1"));
  const m1 = offlineMarket(NATIVE_MINT, pxnt, TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, 9, "stakePool", [stakePool], XNT_PXNT_PARAMS);
  const m2 = offlineMarket(usdc, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, 6, "xdexTwap", [xdex.pool, xdex.obs, xdex.v0, xdex.v1], USDC_XNT_PARAMS);
  const ctx = (u: Keypair, m: Market): act.Ctx => ({ conn: null as any, accumulator, user: u.publicKey, market: m });

  const steps: { name: string; signer: string; advance?: number; tx: Transaction }[] = [];
  const add = (name: string, signer: string, tx: Transaction, advance?: number) => steps.push({ name, signer, tx, advance });

  add("init config", "admin", new Transaction().add(await accumulator.initConfig(admin.publicKey, 3_600)));
  add("create XNT/pXNT", "admin", new Transaction().add(await accumulator.createMarket({ admin: admin.publicKey, lendMint: NATIVE_MINT, collateralMint: pxnt,
    lendTokenProgram: TOKEN_PROGRAM_ID, collateralTokenProgram: TOKEN_PROGRAM_ID, params: XNT_PXNT_PARAMS, oracleKind: "stakePool", collateralIsToken0: false, oracleAccounts: [stakePool] })));
  add("create USDC.x/XNT", "admin", new Transaction().add(await accumulator.createMarket({ admin: admin.publicKey, lendMint: usdc, collateralMint: NATIVE_MINT,
    lendTokenProgram: TOKEN_2022_PROGRAM_ID, collateralTokenProgram: TOKEN_PROGRAM_ID, params: USDC_XNT_PARAMS, oracleKind: "xdexTwap", collateralIsToken0: true, oracleAccounts: m2.oracleAccounts })));

  add("alice deposits 100 XNT", "alice", await act.deposit(ctx(alice, m1), 100n * XNT));
  add("alice withdraws 40 shares", "alice", await act.withdraw(ctx(alice, m1), 40n * XNT));
  add("bob adds 50 pXNT", "bob", await act.depositCollateral(ctx(bob, m1), 50n * XNT, false));
  add("bob borrows 30 XNT", "bob", await act.borrow(ctx(bob, m1), 30n * XNT));
  // 30 days at 50% utilization accrue ~0.09 XNT; the app sizes the wrap from its debt estimate
  add("bob repays all XNT", "bob", await act.repay(ctx(bob, m1), null, 30_100_000_000n), 30 * 86_400);
  add("bob withdraws 50 pXNT", "bob", await act.withdrawCollateral(ctx(bob, m1), 50n * XNT));
  add("bob closes XNT/pXNT position", "bob", await act.closePosition(ctx(bob, m1)));

  add("alice deposits 2000 USDC.x", "alice", await act.deposit(ctx(alice, m2), 2_000n * USD));
  add("bob adds 80 XNT", "bob", await act.depositCollateral(ctx(bob, m2), 80n * XNT, false));
  add("bob borrows 7 USDC.x", "bob", await act.borrow(ctx(bob, m2), 7n * USD));
  add("bob repays all USDC.x", "bob", await act.repay(ctx(bob, m2), null, 7n * USD), 86_400);
  add("bob withdraws 80 XNT", "bob", await act.withdrawCollateral(ctx(bob, m2), 80n * XNT));

  const out = {
    keys: { admin: Array.from(admin.secretKey), alice: Array.from(alice.secretKey), bob: Array.from(bob.secretKey) },
    accounts: { pxnt: pxnt.toBase58(), stake_pool: stakePool.toBase58(), usdc: usdc.toBase58(),
      xdex_pool: xdex.pool.toBase58(), xdex_obs: xdex.obs.toBase58(), xdex_v0: xdex.v0.toBase58(), xdex_v1: xdex.v1.toBase58() },
    steps: steps.map((s) => ({
      name: s.name,
      signer: s.signer,
      advance: s.advance ?? 0,
      ixs: s.tx.instructions.map((ix) => ({
        program_id: ix.programId.toBase58(),
        accounts: ix.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), is_signer: k.isSigner, is_writable: k.isWritable })),
        data: Buffer.from(ix.data).toString("base64"),
      })),
    })),
  };
  const file = path.join(__dirname, "../tests-rs/fixtures/app-plan.json");
  fs.writeFileSync(file, JSON.stringify(out, null, 1));
  console.log(`wrote ${steps.length} steps to ${file}`);
})();

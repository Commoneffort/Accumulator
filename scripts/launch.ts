/**
 * Sets up Accumulator on X1 after the program is deployed.
 *
 *   ADMIN=~/.config/solana/accumulator-admin.json npx ts-node scripts/launch.ts <step> [--send]
 *
 * Steps:
 *   status            print config and both markets
 *   init              create the config (2-day timelock) and set the fee treasury, in one transaction
 *   handoff <pubkey>  propose a new admin (it accepts from its own wallet in the app)
 *   pause <market>    stop new borrows at once (repay, deposits, withdrawals, liquidations keep working)
 *   unpause <market>  allow borrows again
 *   create xntPxnt    open the XNT / pXNT market (v1)
 *   create usdcXnt    open the USDC.x / XNT market (v1.1)
 *   queue <market>    queue the market's preset risk settings (applies after the timelock)
 *   apply <market>    apply a queued change once the timelock has passed (anyone can)
 *
 * Without --send every step is only simulated against the live chain.
 */
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import fs from "fs";
import os from "os";

import { AccumulatorClient } from "../sdk/src/client";
import { MAINNET } from "../sdk/src/constants";
import { marketsFor } from "../sdk/src/markets";
import { configPda } from "../sdk/src/pda";

// 2 days on mainnet; TIMELOCK=<seconds> overrides it for testnet.
const TIMELOCK_SECONDS = Number(process.env.TIMELOCK ?? 2 * 24 * 3600);
// NETWORK=testnet uses the testnet market list (testnet USDC and XDEX pool).
const NETWORK = process.env.NETWORK === "testnet" ? "testnet" : "mainnet";
const RPC = process.env.RPC ?? (NETWORK === "testnet" ? "https://rpc.testnet.x1.xyz" : MAINNET.rpc);
const MAINNET_MARKETS = marketsFor(NETWORK);

function admin(): Keypair {
  const p = (process.env.ADMIN ?? "").replace(/^~/, os.homedir());
  if (!p) throw new Error("set ADMIN to the admin keypair file");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

async function run(conn: Connection, tx: Transaction, signer: Keypair, send: boolean) {
  tx.feePayer = signer.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  if (!send) {
    const sim = await conn.simulateTransaction(tx, [signer]);
    console.log(sim.value.err ? `simulation FAILED: ${JSON.stringify(sim.value.err)}` : "simulation ok");
    (sim.value.logs ?? []).forEach((l) => console.log("  " + l));
    console.log("(dry run — add --send to submit)");
    return;
  }
  const sig = await sendAndConfirmTransaction(conn, tx, [signer], { commitment: "confirmed" });
  console.log("sent:", sig);
}

(async () => {
  const [step, which] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const send = process.argv.includes("--send");
  const conn = new Connection(RPC, "confirmed");
  const accumulator = new AccumulatorClient(conn);

  if (!step || step === "status") {
    const cfg = await conn.getAccountInfo(configPda());
    console.log("program:", accumulator.programId.toBase58());
    console.log("config:", configPda().toBase58(), cfg ? "exists" : "not created");
    for (const [name, m] of Object.entries(MAINNET_MARKETS)) {
      const info = await conn.getAccountInfo(m.address);
      if (!info) {
        console.log(`${name} (${m.name}): ${m.address.toBase58()} not created`);
        continue;
      }
      const mk = accumulator.decodeMarket(m.address, info.data);
      const price = await accumulator.readPrice(mk, "liquidate").catch((e) => e.message);
      console.log(`${name} (${m.name}): ${m.address.toBase58()}`);
      console.log(`  cash ${mk.cash}, borrows(scaled) ${mk.totalBorrowScaled}, fees ${mk.protocolFees}, paused ${mk.borrowPaused}`);
      console.log(`  price (WAD) ${price}`);
    }
    return;
  }

  const a = admin();
  if (a.publicKey.equals(MAINNET.compromised)) throw new Error("refusing: ADMIN is the compromised DtZz… key");

  if (step === "init") {
    // Same transaction, so there is never a config without a treasury (the first set has no delay).
    const treasury = new PublicKey(process.env.TREASURY ?? MAINNET.treasury.toBase58());
    console.log(`init config: admin ${a.publicKey.toBase58()}, timelock ${TIMELOCK_SECONDS}s, treasury ${treasury.toBase58()}`);
    const tx = new Transaction().add(await accumulator.initConfig(a.publicKey, TIMELOCK_SECONDS), await accumulator.setTreasury(a.publicKey, treasury));
    await run(conn, tx, a, send);
    return;
  }

  if (step === "handoff") {
    if (!which) throw new Error("usage: handoff <new admin pubkey>");
    const next = new PublicKey(which);
    if (next.equals(MAINNET.compromised)) throw new Error("refusing: that is the compromised key");
    console.log(`propose admin ${next.toBase58()} (it must accept from its own wallet: app footer → Accept admin role)`);
    await run(conn, new Transaction().add(await accumulator.proposeAdmin(a.publicKey, next)), a, send);
    return;
  }

  if (step === "create") {
    const m = MAINNET_MARKETS[which];
    if (!m) throw new Error(`market must be one of: ${Object.keys(MAINNET_MARKETS).join(", ")}`);
    console.log(`create ${m.name} at ${m.address.toBase58()}`);
    const ix = await accumulator.createMarket({ admin: a.publicKey, ...m });
    await run(conn, new Transaction().add(ix), a, send);
    return;
  }

  if (step === "pause" || step === "unpause") {
    const m = MAINNET_MARKETS[which];
    if (!m) throw new Error(`market must be one of: ${Object.keys(MAINNET_MARKETS).join(", ")}`);
    console.log(`${step} borrows on ${m.name}`);
    await run(conn, new Transaction().add(await accumulator.setBorrowPaused(a.publicKey, m.address, step === "pause")), a, send);
    return;
  }

  if (step === "queue" || step === "apply") {
    const m = MAINNET_MARKETS[which];
    if (!m) throw new Error(`market must be one of: ${Object.keys(MAINNET_MARKETS).join(", ")}`);
    const ix = step === "queue" ? await accumulator.queueParams(a.publicKey, m.address, m.params) : await accumulator.applyParams(m.address);
    console.log(`${step} ${m.name} params: LTV ${m.params.maxLtvBps / 100}%, liquidation ${m.params.liquidationThresholdBps / 100}%`);
    await run(conn, new Transaction().add(ix), a, send);
    return;
  }

  throw new Error(`unknown step ${step}`);
})();

/**
 * One-time steps after the Oct 2026 upgrade (treasury + liquidation fee):
 *   1. migrate the config and every old-layout market to the new layout
 *   2. set the fee treasury
 *   3. queue the 10% liquidation fee on each market (applies after the timelock)
 *
 *   NETWORK=testnet ADMIN=~/.config/solana/accumulator-testnet-admin.json TREASURY=<wallet> \
 *     npx ts-node scripts/upgrade-2026-10.ts [--send]
 * Without --send every transaction is only simulated.
 */
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import * as fs from "fs";
import { AccumulatorClient, configPda } from "../sdk/src";

const OLD_MARKET_LEN = 606;
const OLD_CONFIG_LEN = 89;
const FEE_BPS = 1_000;

const rpc = process.env.NETWORK === "testnet" ? "https://rpc.testnet.x1.xyz" : "https://rpc.mainnet.x1.xyz";
const send = process.argv.includes("--send");
const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.ADMIN!.replace(/^~/, process.env.HOME!), "utf8"))));
const treasury = new PublicKey(process.env.TREASURY!);
const conn = new Connection(rpc, "confirmed");
const acc = new AccumulatorClient(conn);

async function run(label: string, ixs: TransactionInstruction[]) {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = admin.publicKey;
  if (!send) {
    tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
    const sim = await conn.simulateTransaction(tx, [admin]);
    console.log(`${label}: simulate ${sim.value.err ? "FAILED " + JSON.stringify(sim.value.err) + "\n" + sim.value.logs?.join("\n") : "ok"}`);
    return;
  }
  const sig = await sendAndConfirmTransaction(conn, tx, [admin]);
  console.log(`${label}: ${sig}`);
}

(async () => {
  console.log(`${rpc} admin ${admin.publicKey.toBase58()} treasury ${treasury.toBase58()} ${send ? "SENDING" : "dry run"}`);
  const cfg = await conn.getAccountInfo(configPda(acc.programId));
  if (cfg?.data.length === OLD_CONFIG_LEN) await run("migrate config", [await acc.migrateConfig(admin.publicKey)]);
  else console.log("config already migrated");
  if (!send && cfg?.data.length === OLD_CONFIG_LEN) {
    console.log("(dry run stops here: later steps need the migrated config)");
    return;
  }

  const all = await conn.getProgramAccounts(acc.programId, { dataSlice: { offset: 0, length: 0 } });
  const old = (await Promise.all(all.map(async (a) => ({ a, info: await conn.getAccountInfo(a.pubkey) }))))
    .filter(({ info }) => info?.data.length === OLD_MARKET_LEN)
    .map(({ a }) => a.pubkey);
  for (const m of old) await run(`migrate market ${m.toBase58()}`, [await acc.migrateMarket(admin.publicKey, m)]);

  const c = await acc.fetchConfig();
  if (c.treasury.equals(PublicKey.default)) await run("set treasury", [await acc.setTreasury(admin.publicKey, treasury)]);
  else console.log(`treasury already ${c.treasury.toBase58()}`);

  for (const { publicKey } of await acc.program.account.market.all()) {
    const m = await acc.fetchMarket(publicKey);
    if (m.params.liquidationFeeBps === FEE_BPS || (m.hasPending && m.pendingParams.liquidationFeeBps === FEE_BPS)) {
      console.log(`fee already set or queued on ${publicKey.toBase58()}`);
      continue;
    }
    await run(`queue ${FEE_BPS / 100}% liquidation fee on ${publicKey.toBase58()}`, [
      await acc.queueParams(admin.publicKey, publicKey, { ...m.params, liquidationFeeBps: FEE_BPS }),
    ]);
  }
  console.log(`queued changes apply after the timelock (${c.timelockSeconds}s): npx ts-node scripts/launch.ts apply`);
})();

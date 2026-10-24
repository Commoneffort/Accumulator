// Applies every queued settings change whose timelock has passed (anyone can).
//   NETWORK=testnet KEYPAIR=<fee payer> npx ts-node scripts/ops/apply-all.ts
import { Connection, Keypair, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import * as fs from "fs";
import { AccumulatorClient } from "../../sdk/src";
(async () => {
  const conn = new Connection(process.env.NETWORK === "testnet" ? "https://rpc.testnet.x1.xyz" : "https://rpc.mainnet.x1.xyz", "confirmed");
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.KEYPAIR!.replace(/^~/, process.env.HOME!), "utf8"))));
  const acc = new AccumulatorClient(conn);
  const now = Math.floor(Date.now() / 1000);
  for (const { publicKey } of await acc.program.account.market.all()) {
    const m = await acc.fetchMarket(publicKey);
    if (!m.hasPending) continue;
    if (Number(m.pendingEta) > now) { console.log(`${publicKey.toBase58()}: waits ${Number(m.pendingEta) - now}s more`); continue; }
    const sig = await sendAndConfirmTransaction(conn, new Transaction().add(await acc.applyParams(publicKey)), [payer]);
    const after = await acc.fetchMarket(publicKey);
    console.log(`${publicKey.toBase58()}: applied, liquidation fee ${after.params.liquidationFeeBps / 100}% of bonus (${sig.slice(0, 16)}…)`);
  }
})();

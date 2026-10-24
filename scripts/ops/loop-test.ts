/**
 * Live check of the app's Loop pXNT code on testnet: loops DEPOSIT XNT at
 * LEVERAGE, prints the position, then unwinds it back to XNT.
 *   KEYPAIR=<wallet> DEPOSIT=1 LEVERAGE=2.5 npx ts-node scripts/ops/loop-test.ts
 */
import { Connection, Keypair, Transaction } from "@solana/web3.js";
import * as fs from "fs";
import { AccumulatorClient, TESTNET_MARKETS, accrued, debtOf, fetchStakePool, obligationPda, totalBorrows, waitForPoolUpdate } from "../../sdk/src";
import { leverageOf, loopTxs, planLoop, planUnwind, unwindTxs } from "../../app/src/loop";

const conn = new Connection("https://rpc.testnet.x1.xyz", "confirmed");
const me = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.KEYPAIR!.replace(/^~/, process.env.HOME!), "utf8"))));
const accumulator = new AccumulatorClient(conn);
const ADDR = TESTNET_MARKETS.xntPxnt.address;

async function sendAll(label: string, txs: Transaction[]) {
  for (const [i, tx] of txs.entries()) {
    await waitForPoolUpdate(conn);
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.sign(me);
    const raw = tx.serialize();
    const sig = await conn.sendRawTransaction(raw);
    const r = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    if (r.value.err) throw new Error(`${label} tx ${i + 1}/${txs.length} failed: ${JSON.stringify(r.value.err)}`);
    console.log(`  ${label} tx ${i + 1}/${txs.length} (${raw.length} bytes, ${tx.instructions.length} ixs): ${sig}`);
  }
}

async function position() {
  const m = await accumulator.fetchMarket(ADDR);
  const o = await accumulator.fetchObligation(obligationPda(ADDR, me.publicKey));
  const s = accrued(m, BigInt(Math.floor(Date.now() / 1000)));
  return { m, s, o, pos: { collateral: o?.collateral ?? 0n, debt: o ? debtOf(s, o.borrowScaled) : 0n } };
}

(async () => {
  const deposit = BigInt(Math.round(Number(process.env.DEPOSIT ?? "1") * 1e9));
  const leverage = Number(process.env.LEVERAGE ?? "2.5");
  const before = await conn.getBalance(me.publicKey);
  const pool = await fetchStakePool(conn);
  let { m, s, o, pos } = await position();
  const price = await accumulator.readPrice(m, "borrow");
  const borrows = totalBorrows(s);
  const room = (s.cash + borrows) * BigInt(m.params.maxUtilizationBps) / 10_000n - borrows;
  const plan = planLoop({ pool, market: m, priceWad: price, start: pos, deposit, leverage, marketRoom: room < s.cash ? room : s.cash });
  console.log(`loop ${Number(deposit) / 1e9} XNT at ${leverage}x: ${plan.steps.length} steps, borrow ${Number(plan.borrowed) / 1e9} XNT, planned leverage ${leverageOf(plan.end, price).toFixed(2)}x`);
  const ctx = { conn, accumulator, user: me.publicKey, market: m };
  await sendAll("loop", await loopTxs(ctx, pool, plan.steps, !!o));
  ({ m, s, o, pos } = await position());
  console.log(`  position: ${Number(pos.collateral) / 1e9} pXNT, debt ${Number(pos.debt) / 1e9} XNT, leverage ${leverageOf(pos, price).toFixed(2)}x`);

  const pool2 = await fetchStakePool(conn);
  const price2 = await accumulator.readPrice(m, "borrow");
  const un = planUnwind({ pool: pool2, market: m, priceWad: price2, start: pos });
  console.log(`unwind: ${un.steps.length} steps, complete ${un.complete}`);
  await sendAll("unwind", await unwindTxs({ ...ctx, market: m }, pool2, un.steps, pos, obligationPda(ADDR, me.publicKey), true));
  ({ pos } = await position());
  const after = await conn.getBalance(me.publicKey);
  console.log(`  position after: ${Number(pos.collateral) / 1e9} pXNT, debt ${Number(pos.debt) / 1e9} XNT`);
  console.log(`  wallet XNT change: ${(after - before) / 1e9} (fees + 0.1% pool fees each way + dust left as pXNT)`);
})().catch((e) => {
  console.error(e.message ?? e);
  if (e.logs) console.error(e.logs.join("\n"));
  process.exit(1);
});

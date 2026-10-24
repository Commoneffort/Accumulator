// Prints each testnet market's state and one wallet's positions.
//   npx ts-node scripts/inspect.ts <wallet>
import { Connection, PublicKey } from "@solana/web3.js";
import { AccumulatorClient, TESTNET_MARKETS, accrued, totalBorrows, utilizationBps, borrowRateBps, obligationPda } from "../sdk/src";

const W = process.argv[2] ? new PublicKey(process.argv[2]) : null;
(async () => {
  const conn = new Connection("https://rpc.testnet.x1.xyz", "confirmed");
  const c = new AccumulatorClient(conn);
  const now = BigInt(Math.floor(Date.now() / 1000));
  for (const def of Object.values(TESTNET_MARKETS)) {
    const m = await c.fetchMarket(def.address).catch(() => null);
    if (!m) { console.log(def.name, "not live"); continue; }
    const s = accrued(m, now);
    const b = totalBorrows(s);
    const u = utilizationBps(b, s.cash);
    const d = 10 ** def.lendDecimals;
    console.log(`\n${def.name} ${def.address.toBase58()}`);
    console.log(`  cash ${Number(s.cash) / d}  borrows ${Number(b) / d}  util ${Number(u) / 100}%  borrowAPR ${Number(borrowRateBps(s.params, u)) / 100}%  fees ${Number(s.protocolFees) / d}  paused ${m.borrowPaused}  lastAccrual ${new Date(Number(m.lastAccrualTs) * 1000).toISOString()}`);
    let price: string;
    try { price = String(Number(await c.readPrice(m, "borrow")) / 1e18); } catch (e) { price = "ERR " + (e as Error).message; }
    console.log(`  borrow price ${price}`);
    if (W) {
      const o = await c.fetchObligation(obligationPda(def.address, W, c.programId)).catch(() => null);
      console.log("  position:", o ? JSON.stringify(o, (_, v) => (typeof v === "bigint" ? v.toString() : v instanceof PublicKey ? v.toBase58() : v)) : "none");
    }
  }
})();

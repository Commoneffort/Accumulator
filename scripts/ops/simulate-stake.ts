/**
 * Simulates (never sends) the app's stake + redeem instructions against the real
 * mainnet stake pools: stake 1 XNT, then redeem the pool tokens it gives, in one
 * transaction. Signature checks are off, so any funded address can be the payer.
 *   WALLET=<funded mainnet address> npx ts-node scripts/ops/simulate-stake.ts
 */
import { Connection, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { MAINNET, depositXntForPxntIxs, fetchStakePool, pxntForXnt, withdrawPxntForXntIx, xntForPxnt } from "../../sdk/src";

(async () => {
  const conn = new Connection(MAINNET.rpc, "confirmed");
  const user = new PublicKey(process.env.WALLET!);
  for (const [name, pool] of [["pXNT (X1 pool)", MAINNET.stakePool], ["rXNT (Ripper Pool)", MAINNET.ripper.stakePool]] as const) {
    const p = await fetchStakePool(conn, pool);
    const amount = 1_000_000_000n;
    const tokens = pxntForXnt(p, amount);
    const ixs = [...depositXntForPxntIxs(p, user, amount, pool), withdrawPxntForXntIx(p, user, tokens, pool)];
    const { blockhash } = await conn.getLatestBlockhash();
    const msg = new TransactionMessage({ payerKey: user, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
    const before = await conn.getBalance(user);
    const sim = await conn.simulateTransaction(new VersionedTransaction(msg), {
      sigVerify: false,
      replaceRecentBlockhash: true,
      accounts: { encoding: "base64", addresses: [user.toBase58()] },
    });
    const after = sim.value.accounts?.[0]?.lamports ?? before;
    console.log(`${name}: ${sim.value.err ? "FAILED " + JSON.stringify(sim.value.err) : "ok"}; token program ${p.tokenProgram.toBase58().slice(0, 8)}…, ` +
      `1 XNT -> ${Number(tokens) / 1e9} tokens -> back ${(Number(BigInt(1e9) + BigInt(after - before)) / 1e9).toFixed(6)} XNT ` +
      `(expected >= ${Number(xntForPxnt(p, tokens)) / 1e9}, incl. account rent and fees)`);
    if (sim.value.err) console.log(sim.value.logs?.join("\n"));
  }
})();

/**
 * Sends every market's accrued fees to the treasury set in the program config
 * (interest fees in the lend token, liquidation fees in the collateral token).
 * Anyone can run it; the payer only covers network fees and, the first time,
 * the treasury's token accounts (~0.002 XNT each). Wrapped XNT lands in the
 * treasury's wXNT account; the treasury unwraps it by closing that account.
 *   NETWORK=testnet KEYPAIR=<payer> npx ts-node scripts/ops/collect-fees.ts [--send]
 */
import { Connection, Keypair, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import * as fs from "fs";
import { AccumulatorClient, accrued } from "../../sdk/src";

(async () => {
  const conn = new Connection(process.env.NETWORK === "testnet" ? "https://rpc.testnet.x1.xyz" : "https://rpc.mainnet.x1.xyz", "confirmed");
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.KEYPAIR!.replace(/^~/, process.env.HOME!), "utf8"))));
  const send = process.argv.includes("--send");
  const acc = new AccumulatorClient(conn);
  const { treasury } = await acc.fetchConfig();
  console.log(`treasury ${treasury.toBase58()} ${send ? "SENDING" : "dry run"}`);
  const now = BigInt(Math.floor(Date.now() / 1000));
  for (const { publicKey } of await acc.program.account.market.all()) {
    const m = await acc.fetchMarket(publicKey);
    const s = accrued(m, now);
    const tx = new Transaction();
    const lendFees = s.protocolFees < s.cash ? s.protocolFees : s.cash;
    if (lendFees > 0n) {
      const to = getAssociatedTokenAddressSync(m.lendMint, treasury, true, m.lendTokenProgram);
      tx.add(createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, to, treasury, m.lendMint, m.lendTokenProgram), await acc.collectFees(m, to));
    }
    if (m.protocolCollateralFees > 0n) {
      const to = getAssociatedTokenAddressSync(m.collateralMint, treasury, true, m.collateralTokenProgram);
      tx.add(createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, to, treasury, m.collateralMint, m.collateralTokenProgram), await acc.collectCollateralFees(m, to));
    }
    const what = `${publicKey.toBase58()}: interest fees ${lendFees} (lend raw units), liquidation fees ${m.protocolCollateralFees} (collateral raw units)`;
    if (!tx.instructions.length) { console.log(`${what} — nothing to collect`); continue; }
    if (!send) { console.log(`${what} — would collect`); continue; }
    console.log(`${what} — ${await sendAndConfirmTransaction(conn, tx, [payer])}`);
  }
})();

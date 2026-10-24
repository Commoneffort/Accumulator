/**
 * Turns XNT into pXNT by depositing into the X1 stake pool (the same pool on
 * testnet and mainnet). pXNT is what Accumulator borrowers post as collateral.
 *
 *   KEYPAIR=~/.config/solana/me.json AMOUNT=10 npx ts-node scripts/get-pxnt.ts           # simulate
 *   KEYPAIR=~/.config/solana/me.json AMOUNT=10 npx ts-node scripts/get-pxnt.ts --send    # deposit
 *
 * RPC defaults to X1 testnet. Note: pXNT redeems for slightly more than 1 XNT
 * (it has earned staking rewards), so you get fewer pXNT than XNT deposited.
 */
import { Connection, Keypair, MessageV0, PublicKey, Transaction, VersionedTransaction, sendAndConfirmTransaction } from "@solana/web3.js";
import fs from "fs";
import os from "os";
import { depositXntForPxnt, isStalePoolError } from "../sdk/src/stakePool";

const RPC = process.env.RPC ?? "https://rpc.testnet.x1.xyz";

(async () => {
  const xnt = Number(process.env.AMOUNT ?? "1");
  const send = process.argv.includes("--send");
  const conn = new Connection(RPC, "confirmed");
  let signer: Keypair | null = null;
  let user: PublicKey;
  if (process.env.KEYPAIR) {
    signer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.KEYPAIR.replace(/^~/, os.homedir()), "utf8"))));
    user = signer.publicKey;
  } else if (process.env.SIMULATE_AS && !send) {
    user = new PublicKey(process.env.SIMULATE_AS); // dry run as any funded address
  } else {
    throw new Error("set KEYPAIR (or SIMULATE_AS=<address> for a dry run)");
  }
  const lamports = BigInt(Math.round(xnt * 1e9));
  const { ixs, dest, rate } = await depositXntForPxnt(conn, user, lamports);
  console.log(`${RPC}\ndeposit ${xnt} XNT from ${user.toBase58()} -> about ${(xnt / rate).toFixed(4)} pXNT (1 pXNT = ${rate.toFixed(6)} XNT)\npXNT account ${dest.toBase58()}`);

  const tx = new Transaction().add(...ixs);
  tx.feePayer = user;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  if (!send) {
    const msg = MessageV0.compile({ payerKey: user, instructions: ixs, recentBlockhash: tx.recentBlockhash! });
    const sim = await conn.simulateTransaction(new VersionedTransaction(msg), { sigVerify: false, replaceRecentBlockhash: true });
    console.log(sim.value.err ? `simulation FAILED: ${JSON.stringify(sim.value.err)}` : "simulation ok");
    (sim.value.logs ?? []).filter((l) => !l.includes("consumed")).forEach((l) => console.log("  " + l));
    console.log("(dry run — add --send to deposit)");
    return;
  }
  // Right after an epoch starts the pool rejects deposits (error 0x11) until its
  // permissionless update runs. Testnet epochs are ~3 minutes, so just wait and retry.
  let sig = "";
  for (let attempt = 1; ; attempt++) {
    try {
      tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
      sig = await sendAndConfirmTransaction(conn, tx, [signer!], { commitment: "confirmed" });
      break;
    } catch (e) {
      const stale = isStalePoolError(e);
      if (!stale || attempt >= 12) throw e;
      console.log(`pool is mid-epoch-update; retrying in 15s (${attempt}/12)`);
      await new Promise((r) => setTimeout(r, 15_000));
    }
  }
  const bal = await conn.getTokenAccountBalance(dest);
  console.log(`done: ${sig}\npXNT balance: ${bal.value.uiAmountString}`);
})().catch((e) => {
  console.error(e?.message ? e.message : e);
  process.exit(1);
});

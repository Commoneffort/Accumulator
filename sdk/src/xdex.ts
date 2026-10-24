/**
 * Minimal XDEX (Raydium CP-swap fork) client: open a pool, swap, read reserves.
 * Account orders follow percolator-vault/app/src/swap.ts and scripts/xdex-pool.ts.
 */
import { PublicKey, SYSVAR_RENT_PUBKEY, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Connection } from "@solana/web3.js";
import { createHash } from "crypto";
import { LAYOUT } from "./constants";

export const XDEX_TESTNET = {
  program: new PublicKey("7EEuq61z9VKdkUzj7G36xGd7ncyz8KBtUwAWVjypYQHf"),
  /** 0.3% fee tier, the one percolator's pools use */
  ammConfig: new PublicKey("3FzzbxwpdJKxRW1yNT7UPYmna17SwC9PRmskMa8A2BuY"),
  /** where XDEX collects its pool-opening fee (0.13 XNT) */
  createPoolFee: new PublicKey("DwhWUT38Dwth5e1NYAJ2SSacYSaLEvct3kMndM7VSbcS"),
};

const disc = (name: string) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
const u64 = (x: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(x);
  return b;
};
const rw = (pubkey: PublicKey, isSigner = false) => ({ pubkey, isSigner, isWritable: true });
const ro = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: false });

export const sortMints = (a: PublicKey, b: PublicKey): [PublicKey, PublicKey] =>
  Buffer.compare(a.toBuffer(), b.toBuffer()) < 0 ? [a, b] : [b, a];

export function xdexAccounts(program: PublicKey, ammConfig: PublicKey, m0: PublicKey, m1: PublicKey) {
  const pda = (...s: Buffer[]) => PublicKey.findProgramAddressSync(s, program)[0];
  const pool = pda(Buffer.from("pool"), ammConfig.toBuffer(), m0.toBuffer(), m1.toBuffer());
  return {
    pool,
    authority: pda(Buffer.from("vault_and_lp_mint_auth_seed")),
    lpMint: pda(Buffer.from("pool_lp_mint"), pool.toBuffer()),
    vault0: pda(Buffer.from("pool_vault"), pool.toBuffer(), m0.toBuffer()),
    vault1: pda(Buffer.from("pool_vault"), pool.toBuffer(), m1.toBuffer()),
    observation: pda(Buffer.from("observation"), pool.toBuffer()),
  };
}

/** Opens a pool; the creator's token accounts for both mints must hold the amounts. Classic SPL tokens. */
export function initPoolIx(x = XDEX_TESTNET, creator: PublicKey, m0: PublicKey, m1: PublicKey, amount0: bigint, amount1: bigint) {
  const a = xdexAccounts(x.program, x.ammConfig, m0, m1);
  const mine = (m: PublicKey) => getAssociatedTokenAddressSync(m, creator);
  return new TransactionInstruction({
    programId: x.program,
    keys: [
      rw(creator, true), ro(x.ammConfig), ro(a.authority), rw(a.pool), ro(m0), ro(m1), rw(a.lpMint),
      rw(mine(m0)), rw(mine(m1)), rw(getAssociatedTokenAddressSync(a.lpMint, creator)),
      rw(a.vault0), rw(a.vault1), rw(x.createPoolFee), rw(a.observation),
      ro(TOKEN_PROGRAM_ID), ro(TOKEN_PROGRAM_ID), ro(TOKEN_PROGRAM_ID), ro(ASSOCIATED_TOKEN_PROGRAM_ID), ro(SystemProgram.programId), ro(SYSVAR_RENT_PUBKEY),
    ],
    data: Buffer.concat([disc("initialize"), u64(amount0), u64(amount1), u64(0n)]),
  });
}

/** swap_base_input on XDEX directly (no router). `from` = 0 sells token 0 for token 1. */
export function swapIx(x = XDEX_TESTNET, payer: PublicKey, m0: PublicKey, m1: PublicKey, from: 0 | 1, amountIn: bigint, minOut: bigint) {
  const a = xdexAccounts(x.program, x.ammConfig, m0, m1);
  const mints = [m0, m1];
  const vaults = [a.vault0, a.vault1];
  const to = 1 - from;
  return new TransactionInstruction({
    programId: x.program,
    keys: [
      rw(payer, true), ro(a.authority), ro(x.ammConfig), rw(a.pool),
      rw(getAssociatedTokenAddressSync(mints[from], payer)), rw(getAssociatedTokenAddressSync(mints[to], payer)),
      rw(vaults[from]), rw(vaults[to]), ro(TOKEN_PROGRAM_ID), ro(TOKEN_PROGRAM_ID), ro(mints[from]), ro(mints[to]), rw(a.observation),
    ],
    data: Buffer.concat([disc("swap_base_input"), u64(amountIn), u64(minOut)]),
  });
}

/** Reserves net of the fees the vaults hold for others (what prices use). */
export async function poolReserves(conn: Connection, pool: PublicKey): Promise<[bigint, bigint]> {
  const p = await conn.getAccountInfo(pool);
  if (!p) throw new Error("pool not found");
  const d = p.data;
  const L = LAYOUT.xdexPool;
  const k = (o: number) => new PublicKey(d.subarray(o, o + 32));
  const fees0 = d.readBigUInt64LE(L.protocolFees0) + d.readBigUInt64LE(L.fundFees0);
  const fees1 = d.readBigUInt64LE(L.protocolFees1) + d.readBigUInt64LE(L.fundFees1);
  const [v0, v1] = await conn.getMultipleAccountsInfo([k(L.vault0), k(L.vault1)]);
  return [v0!.data.readBigUInt64LE(64) - fees0, v1!.data.readBigUInt64LE(64) - fees1];
}

/** Output of a swap at a 0.3% fee (the pool rounds the fee up). */
export function quoteOut(reserveIn: bigint, reserveOut: bigint, amountIn: bigint, feePpm = 3_000n): bigint {
  const fee = (amountIn * feePpm + 999_999n) / 1_000_000n;
  const net = amountIn - fee;
  return (net * reserveOut) / (reserveIn + net);
}

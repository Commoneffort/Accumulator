/**
 * Builds the transactions behind each button. Native XNT is wrapped before it
 * goes in and unwrapped when it comes out, so users only ever see plain XNT.
 */
import { Connection, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { Market, AccumulatorClient, NATIVE_MINT, U64_MAX, obligationPda } from "../../sdk/src";

export interface Ctx {
  conn: Connection;
  accumulator: AccumulatorClient;
  user: PublicKey;
  market: Market;
}

const ata = (owner: PublicKey, mint: PublicKey, program: PublicKey) => getAssociatedTokenAddressSync(mint, owner, false, program);

function ensureAta(c: Ctx, mint: PublicKey, program: PublicKey): [PublicKey, TransactionInstruction] {
  const a = ata(c.user, mint, program);
  return [a, createAssociatedTokenAccountIdempotentInstruction(c.user, a, c.user, mint, program)];
}

function wrapIxs(c: Ctx, account: PublicKey, lamports: bigint): TransactionInstruction[] {
  return [SystemProgram.transfer({ fromPubkey: c.user, toPubkey: account, lamports }), createSyncNativeInstruction(account)];
}

const unwrapIx = (c: Ctx, account: PublicKey) => createCloseAccountInstruction(account, c.user, c.user);

export const lendAccounts = (c: Ctx) => ({
  token: ata(c.user, c.market.lendMint, c.market.lendTokenProgram),
  shares: ata(c.user, c.market.shareMint, c.market.lendTokenProgram),
  collateral: ata(c.user, c.market.collateralMint, c.market.collateralTokenProgram),
  obligation: obligationPda(c.market.address, c.user, c.accumulator.programId),
});

export async function deposit(c: Ctx, amount: bigint): Promise<Transaction> {
  const m = c.market;
  const [token, mkToken] = ensureAta(c, m.lendMint, m.lendTokenProgram);
  const [shares, mkShares] = ensureAta(c, m.shareMint, m.lendTokenProgram);
  const tx = new Transaction().add(mkToken, mkShares);
  const native = m.lendMint.equals(NATIVE_MINT);
  if (native) tx.add(...wrapIxs(c, token, amount));
  tx.add(await c.accumulator.deposit(m, c.user, token, shares, amount));
  if (native) tx.add(unwrapIx(c, token));
  return tx;
}

export async function withdraw(c: Ctx, shares: bigint): Promise<Transaction> {
  const m = c.market;
  const [token, mkToken] = ensureAta(c, m.lendMint, m.lendTokenProgram);
  const tx = new Transaction().add(mkToken, await c.accumulator.withdraw(m, c.user, token, lendAccounts(c).shares, shares));
  if (m.lendMint.equals(NATIVE_MINT)) tx.add(unwrapIx(c, token));
  return tx;
}

export async function depositCollateral(c: Ctx, amount: bigint, hasObligation: boolean): Promise<Transaction> {
  const m = c.market;
  const [coll, mkColl] = ensureAta(c, m.collateralMint, m.collateralTokenProgram);
  const tx = new Transaction().add(mkColl);
  const native = m.collateralMint.equals(NATIVE_MINT);
  if (native) tx.add(...wrapIxs(c, coll, amount));
  if (!hasObligation) tx.add(await c.accumulator.openObligation(m.address, c.user));
  tx.add(await c.accumulator.depositCollateral(m, c.user, coll, amount));
  if (native) tx.add(unwrapIx(c, coll));
  return tx;
}

export async function withdrawCollateral(c: Ctx, amount: bigint): Promise<Transaction> {
  const m = c.market;
  const [coll, mkColl] = ensureAta(c, m.collateralMint, m.collateralTokenProgram);
  const tx = new Transaction().add(mkColl, await c.accumulator.withdrawCollateral(m, c.user, coll, amount));
  if (m.collateralMint.equals(NATIVE_MINT)) tx.add(unwrapIx(c, coll));
  return tx;
}

export async function borrow(c: Ctx, amount: bigint): Promise<Transaction> {
  const m = c.market;
  const [token, mkToken] = ensureAta(c, m.lendMint, m.lendTokenProgram);
  const tx = new Transaction().add(mkToken, await c.accumulator.borrow(m, c.user, token, amount));
  if (m.lendMint.equals(NATIVE_MINT)) tx.add(unwrapIx(c, token));
  return tx;
}

/** `amount` = null repays everything; for native XNT, `debt` sizes the wrap. */
export async function repay(c: Ctx, amount: bigint | null, debt: bigint): Promise<Transaction> {
  const m = c.market;
  const [token, mkToken] = ensureAta(c, m.lendMint, m.lendTokenProgram);
  const tx = new Transaction().add(mkToken);
  const native = m.lendMint.equals(NATIVE_MINT);
  // Interest keeps accruing until the tx lands: wrap a 0.1% cushion; the rest comes back on unwrap.
  if (native) tx.add(...wrapIxs(c, token, amount ?? debt + debt / 1000n + 1n));
  tx.add(await c.accumulator.repay(m, lendAccounts(c).obligation, c.user, token, amount ?? U64_MAX));
  if (native) tx.add(unwrapIx(c, token));
  return tx;
}

export async function closePosition(c: Ctx): Promise<Transaction> {
  return new Transaction().add(await c.accumulator.closeObligation(c.market.address, c.user));
}

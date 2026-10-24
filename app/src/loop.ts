/**
 * Loop pXNT: leveraged staking on the XNT / pXNT market, in a few transactions
 * the wallet approves once.
 *
 *   Loop:   stake XNT -> pXNT -> post as collateral -> borrow XNT -> stake it -> ...
 *   Unwind: withdraw some pXNT -> redeem it for XNT at the stake pool -> repay -> ...
 *
 * Every step leaves the position under the borrow limit on its own, so if a
 * transaction fails midway the position is simply less (or more) levered, never unsafe.
 * Amounts are planned from the stake pool's current rate with small safety margins.
 */
import { ComputeBudgetProgram, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  BPS,
  Market,
  StakePoolInfo,
  U64_MAX,
  WAD,
  borrowRateBps,
  depositXntForPxntIxs,
  pxntForXnt,
  utilizationBps,
  withdrawPxntForXntIx,
  xntForPxnt,
} from "../../sdk/src";
import type { Ctx } from "./actions";

/** Stay this far under the borrow limit (bps of max LTV) so price ticks and interest can't make a step fail. */
const LIMIT_BUFFER_BPS = 9_900n;
const MIN_STEP = 1_000_000n; // 0.001 XNT
const MAX_STEPS = 24;

export interface Position {
  collateral: bigint; // pXNT
  debt: bigint; // XNT
}

export interface LoopStep {
  borrow: bigint; // XNT borrowed this step (0 for the first, which stakes the user's own XNT)
  stake: bigint; // XNT staked this step
  pxnt: bigint; // pXNT posted as collateral
}

export interface UnwindStep {
  withdraw: bigint; // pXNT taken out of the position
  redeem: bigint; // XNT expected back from the stake pool
  repay: bigint | "all";
}

const value = (pxnt: bigint, priceWad: bigint) => (pxnt * priceWad) / WAD;
const limitOf = (pxnt: bigint, priceWad: bigint, maxLtvBps: number) =>
  (value(pxnt, priceWad) * BigInt(maxLtvBps) * LIMIT_BUFFER_BPS) / (BPS * BPS);

/** Equity multiple of a position: collateral value / (collateral value - debt). */
export function leverageOf(p: Position, priceWad: bigint): number {
  const v = Number(value(p.collateral, priceWad));
  return v > Number(p.debt) ? v / (v - Number(p.debt)) : Infinity;
}

/**
 * Plan a loop that stakes `deposit` XNT of the user's own and borrows until the
 * added debt reaches deposit * (leverage - 1), the borrow limit, or what the
 * market can lend (`marketRoom`).
 */
export function planLoop(args: { pool: StakePoolInfo; market: Market; priceWad: bigint; start: Position; deposit: bigint; leverage: number; marketRoom: bigint }) {
  const { pool, market, priceWad, deposit, leverage, marketRoom } = args;
  const target = (deposit * BigInt(Math.round((leverage - 1) * 10_000))) / 10_000n;
  const steps: LoopStep[] = [];
  let pos = { ...args.start };
  const first = pxntForXnt(pool, deposit);
  steps.push({ borrow: 0n, stake: deposit, pxnt: first });
  pos.collateral += first;
  let added = 0n;
  while (steps.length < MAX_STEPS) {
    const room = limitOf(pos.collateral, priceWad, market.params.maxLtvBps) - pos.debt;
    let b = [room, target - added, marketRoom - added].reduce((a, c) => (a < c ? a : c));
    if (b < MIN_STEP) break;
    const p = pxntForXnt(pool, b);
    if (p === 0n) break;
    steps.push({ borrow: b, stake: b, pxnt: p });
    pos = { collateral: pos.collateral + p, debt: pos.debt + b };
    added += b;
  }
  return { steps, end: pos, borrowed: added, reachedTarget: added + MIN_STEP >= target };
}

/** Plan a full unwind: redeem collateral for XNT step by step until the debt is repaid. */
export function planUnwind(args: { pool: StakePoolInfo; market: Market; priceWad: bigint; start: Position }) {
  const { pool, market, priceWad } = args;
  let pos = { ...args.start };
  const steps: UnwindStep[] = [];
  while (pos.debt > 0n && steps.length < MAX_STEPS) {
    // pXNT that covers the whole remaining debt (with 0.3% to spare for interest and rounding)
    const need = (pos.debt * 1_003n) / 1_000n + 1n;
    const coverAll = ((need * pool.supply) / pool.totalLamports) * 1_003n / 1_000n + 2n;
    // pXNT that can leave while staying under the limit
    const keep = (pos.debt * WAD * BPS * BPS) / (priceWad * BigInt(market.params.maxLtvBps) * LIMIT_BUFFER_BPS) + 1n;
    const free = pos.collateral > keep ? pos.collateral - keep : 0n;
    if (coverAll <= free) {
      steps.push({ withdraw: coverAll, redeem: xntForPxnt(pool, coverAll), repay: "all" });
      pos = { collateral: pos.collateral - coverAll, debt: 0n };
      break;
    }
    if (free === 0n) break; // too close to the limit to unwind from collateral; repay some first
    const redeem = xntForPxnt(pool, free);
    if (redeem < MIN_STEP) break;
    steps.push({ withdraw: free, redeem, repay: redeem });
    pos = { collateral: pos.collateral - free, debt: pos.debt - redeem };
  }
  return { steps, end: pos, complete: pos.debt === 0n };
}

/** Borrow APR (bps) after `extra` more is borrowed from the market. */
export function borrowAprAfter(market: Market, cash: bigint, borrows: bigint, extra: bigint): bigint {
  const util = utilizationBps(borrows + extra, cash - (extra > cash ? cash : extra));
  return borrowRateBps(market.params, util);
}

/**
 * Approximate net APY on the user's own XNT at a leverage: staking yield on all
 * collateral, minus borrow interest on the debt.
 */
export function netApy(stakingApy: number, borrowApr: number, leverage: number): number {
  return stakingApy * leverage - borrowApr * (leverage - 1);
}

// ------------------------------------------------------------- transactions

const ata = (owner: PublicKey, mint: PublicKey, program: PublicKey) => getAssociatedTokenAddressSync(mint, owner, false, program);

async function loopStepIxs(c: Ctx, pool: StakePoolInfo, s: LoopStep, open: boolean): Promise<TransactionInstruction[]> {
  const m = c.market;
  const wx = ata(c.user, m.lendMint, m.lendTokenProgram);
  const px = ata(c.user, m.collateralMint, m.collateralTokenProgram);
  const ixs: TransactionInstruction[] = [];
  if (s.borrow > 0n) {
    // borrowed XNT arrives wrapped; unwrap it so the stake pool can take it
    ixs.push(
      createAssociatedTokenAccountIdempotentInstruction(c.user, wx, c.user, m.lendMint, m.lendTokenProgram),
      await c.accumulator.borrow(m, c.user, wx, s.borrow),
      createCloseAccountInstruction(wx, c.user, c.user),
    );
  }
  ixs.push(...depositXntForPxntIxs(pool, c.user, s.stake, m.oracleAccounts[0]));
  if (open) ixs.push(await c.accumulator.openObligation(m.address, c.user));
  ixs.push(await c.accumulator.depositCollateral(m, c.user, px, s.pxnt));
  return ixs;
}

async function unwindStepIxs(c: Ctx, pool: StakePoolInfo, s: UnwindStep, debtNow: bigint, obligation: PublicKey): Promise<TransactionInstruction[]> {
  const m = c.market;
  const wx = ata(c.user, m.lendMint, m.lendTokenProgram);
  const px = ata(c.user, m.collateralMint, m.collateralTokenProgram);
  // "all": wrap the debt plus a 0.2% cushion for interest; what isn't needed comes back on unwrap
  const wrap = s.repay === "all" ? debtNow + debtNow / 500n + 1n : s.repay;
  return [
    createAssociatedTokenAccountIdempotentInstruction(c.user, px, c.user, m.collateralMint, m.collateralTokenProgram),
    await c.accumulator.withdrawCollateral(m, c.user, px, s.withdraw),
    withdrawPxntForXntIx(pool, c.user, s.withdraw, m.oracleAccounts[0]),
    createAssociatedTokenAccountIdempotentInstruction(c.user, wx, c.user, m.lendMint, m.lendTokenProgram),
    SystemProgram.transfer({ fromPubkey: c.user, toPubkey: wx, lamports: wrap }),
    createSyncNativeInstruction(wx),
    await c.accumulator.repay(m, obligation, c.user, wx, s.repay === "all" ? U64_MAX : s.repay),
    createCloseAccountInstruction(wx, c.user, c.user),
  ];
}

/** Pack steps into as few transactions as fit (each step stays whole inside one transaction). */
export function pack(steps: TransactionInstruction[][], payer: PublicKey): Transaction[] {
  const dummy = "11111111111111111111111111111111";
  const budget = () => ComputeBudgetProgram.setComputeUnitLimit({ units: 1_200_000 });
  const fits = (ixs: TransactionInstruction[]) => {
    const tx = new Transaction({ feePayer: payer, recentBlockhash: dummy }).add(budget(), ...ixs);
    try {
      return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length <= 1232;
    } catch {
      return false;
    }
  };
  const out: TransactionInstruction[][] = [];
  for (const s of steps) {
    const cur = out[out.length - 1];
    if (cur && fits([...cur, ...s])) cur.push(...s);
    else out.push([...s]);
  }
  return out.map((ixs) => new Transaction({ feePayer: payer, recentBlockhash: dummy }).add(budget(), ...ixs));
}

export async function loopTxs(c: Ctx, pool: StakePoolInfo, steps: LoopStep[], hasObligation: boolean): Promise<Transaction[]> {
  const ixs = await Promise.all(steps.map((s, i) => loopStepIxs(c, pool, s, i === 0 && !hasObligation)));
  return pack(ixs, c.user);
}

/** Unwind; `toXnt` also redeems the collateral left over at the end for XNT. */
export async function unwindTxs(c: Ctx, pool: StakePoolInfo, steps: UnwindStep[], start: Position, obligation: PublicKey, toXnt: boolean): Promise<Transaction[]> {
  const m = c.market;
  let debt = start.debt;
  let coll = start.collateral;
  const ixs: TransactionInstruction[][] = [];
  for (const s of steps) {
    ixs.push(await unwindStepIxs(c, pool, s, debt, obligation));
    debt = s.repay === "all" ? 0n : debt - s.repay;
    coll -= s.withdraw;
  }
  if (debt === 0n && coll > 0n) {
    const px = ata(c.user, m.collateralMint, m.collateralTokenProgram);
    const last = [
      createAssociatedTokenAccountIdempotentInstruction(c.user, px, c.user, m.collateralMint, m.collateralTokenProgram),
      await c.accumulator.withdrawCollateral(m, c.user, px, coll),
    ];
    if (toXnt) last.push(withdrawPxntForXntIx(pool, c.user, coll, m.oracleAccounts[0]));
    ixs.push(last);
  }
  return pack(ixs, c.user);
}

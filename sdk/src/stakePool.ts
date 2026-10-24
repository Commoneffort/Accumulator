/**
 * Deposit XNT into the X1 stake pool and receive pXNT (the collateral of the
 * XNT / pXNT market). Same pool address on testnet and mainnet.
 */
import { Connection, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { LAYOUT, MAINNET, X1_STAKE_POOL_PROGRAM_ID } from "./constants";

const DEPOSIT_SOL = 14; // StakePoolInstruction::DepositSol(u64)

/** Stake pool error 0x11: the pool hasn't run this epoch's update yet. Retry shortly. */
export const isStalePoolError = (e: unknown) =>
  /0x11\b|custom program error: 0x11|StakePoolNotUpdated/.test(String((e as Error)?.message ?? e) + JSON.stringify((e as { logs?: string[] })?.logs ?? []));

export async function depositXntForPxnt(conn: Connection, user: PublicKey, lamports: bigint, pool = MAINNET.stakePool) {
  const p = await fetchStakePool(conn, pool);
  return {
    ixs: depositXntForPxntIxs(p, user, lamports, pool),
    dest: getAssociatedTokenAddressSync(p.mint, user, false, p.tokenProgram),
    /** XNT per pool token */
    rate: Number(p.totalLamports) / Number(p.supply),
  };
}

/**
 * The pool rejects deposits after an epoch starts until its permissionless
 * update runs (usually seconds; testnet epochs are ~3 minutes). Wait for it so
 * a wallet is never asked to sign a transaction that would fail.
 */
export async function waitForPoolUpdate(conn: Connection, pool = MAINNET.stakePool, timeoutMs = 120_000, onWait?: () => void) {
  const start = Date.now();
  for (let first = true; ; first = false) {
    const [info, epoch] = await Promise.all([conn.getAccountInfo(pool), conn.getEpochInfo()]);
    if (!info) throw new Error("stake pool not found on this network");
    const updated = Number(info.data.readBigUInt64LE(LAYOUT.stakePool.lastUpdateEpoch));
    if (updated >= epoch.epoch) return;
    if (first) onWait?.();
    if (Date.now() - start > timeoutMs) throw new Error("the stake pool hasn't updated for the new epoch yet; try again shortly");
    await new Promise((r) => setTimeout(r, 4_000));
  }
}

// ---------------------------------------------------------------- pool info

export interface StakePoolInfo {
  /** The stake pool program that owns this pool. */
  programId: PublicKey;
  /** Token program of the pool token (classic SPL Token for pXNT, Token-2022 for rXNT). */
  tokenProgram: PublicKey;
  reserve: PublicKey;
  mint: PublicKey;
  managerFee: PublicKey;
  totalLamports: bigint;
  supply: bigint;
  lastUpdateEpoch: number;
  /** Fee taken on SOL (XNT) deposits and withdrawals, as a fraction. */
  solDepositFee: number;
  solWithdrawalFee: number;
  /** Rate (XNT per pXNT) at the end of the previous epoch, if the pool records it. */
  lastEpochRate: number | null;
}

/**
 * Reads the X1 stake pool account. Several fields after the fixed header are
 * optional (1 byte, or 1 + 32 / 1 + 16), so they are walked in order.
 */
export function parseStakePool(d: Buffer, programId = X1_STAKE_POOL_PROGRAM_ID): StakePoolInfo {
  const o = 1; // X1 fork: leading version byte
  const key = (at: number) => new PublicKey(d.subarray(at, at + 32));
  const u64 = (at: number) => d.readBigUInt64LE(at);
  const fee = (at: number) => {
    const den = Number(u64(at));
    return den === 0 ? 0 : Number(u64(at + 8)) / den;
  };
  let i = o + 330 + 16; // after epoch_fee
  const future = () => (i += d[i] === 0 ? 1 : 17);
  const option = () => (i += d[i] === 0 ? 1 : 33);
  future(); // next_epoch_fee
  option(); // preferred deposit validator
  option(); // preferred withdraw validator
  i += 32; // stake deposit + withdrawal fees
  future(); // next stake withdrawal fee
  i += 1; // stake referral fee
  option(); // sol deposit authority
  const solDepositFee = fee(i);
  i += 16 + 1; // sol deposit fee + sol referral fee
  option(); // sol withdraw authority
  const solWithdrawalFee = fee(i);
  i += 16;
  future(); // next sol withdrawal fee
  const lastSupply = i + 16 <= d.length ? u64(i) : 0n;
  const lastTotal = i + 16 <= d.length ? u64(i + 8) : 0n;
  return {
    programId,
    tokenProgram: key(o + 226),
    reserve: key(o + 130),
    mint: key(LAYOUT.stakePool.poolMint),
    managerFee: key(o + 194),
    totalLamports: u64(LAYOUT.stakePool.totalLamports),
    supply: u64(LAYOUT.stakePool.poolTokenSupply),
    lastUpdateEpoch: Number(u64(LAYOUT.stakePool.lastUpdateEpoch)),
    solDepositFee,
    solWithdrawalFee,
    lastEpochRate: lastSupply > 0n ? Number(lastTotal) / Number(lastSupply) : null,
  };
}

export async function fetchStakePool(conn: Connection, pool = MAINNET.stakePool): Promise<StakePoolInfo> {
  const info = await conn.getAccountInfo(pool);
  if (!info) throw new Error("stake pool not found on this network");
  return parseStakePool(info.data, info.owner);
}

/**
 * Staking APY estimated from the pool's growth over its last epoch, compounded
 * over a year of epochs at the network's recent slot time. Null when the pool
 * hasn't recorded a previous epoch yet.
 */
export async function estimateStakingApy(conn: Connection, pool = MAINNET.stakePool): Promise<number | null> {
  const [p, schedule, perf] = await Promise.all([fetchStakePool(conn, pool), conn.getEpochSchedule(), conn.getRecentPerformanceSamples(10)]);
  if (!p.lastEpochRate || p.supply === 0n) return null;
  const growth = Number(p.totalLamports) / Number(p.supply) / p.lastEpochRate - 1;
  const slots = perf.reduce((t, s) => t + s.numSlots, 0);
  const secs = perf.reduce((t, s) => t + s.samplePeriodSecs, 0);
  if (!slots || growth < 0) return growth < 0 ? 0 : null;
  const epochsPerYear = (365 * 86_400) / (schedule.slotsPerEpoch * (secs / slots));
  return Math.pow(1 + growth, epochsPerYear) - 1;
}

/** pXNT received for `lamports`, after the deposit fee, rounded down with a safety margin. */
export function pxntForXnt(p: StakePoolInfo, lamports: bigint, marginBps = 10n): bigint {
  const minted = (lamports * p.supply) / p.totalLamports;
  const afterFee = minted - BigInt(Math.ceil(Number(minted) * p.solDepositFee));
  return (afterFee * (10_000n - marginBps)) / 10_000n;
}

/** XNT received for burning `pxnt`, after the withdrawal fee, rounded down with a safety margin. */
export function xntForPxnt(p: StakePoolInfo, pxnt: bigint, marginBps = 10n): bigint {
  const burned = pxnt - BigInt(Math.ceil(Number(pxnt) * p.solWithdrawalFee));
  const out = (burned * p.totalLamports) / p.supply;
  return (out * (10_000n - marginBps)) / 10_000n;
}

const WITHDRAW_SOL = 16; // StakePoolInstruction::WithdrawSol(u64)
const SYSVAR_CLOCK = new PublicKey("SysvarC1ock11111111111111111111111111111111");
const SYSVAR_STAKE_HISTORY = new PublicKey("SysvarStakeHistory1111111111111111111111111");
const STAKE_PROGRAM = new PublicKey("Stake11111111111111111111111111111111111111");

/** Burn `pxnt` from the user's pXNT account and receive XNT in their wallet, from the pool's reserve. */
export function withdrawPxntForXntIx(p: StakePoolInfo, user: PublicKey, pxnt: bigint, pool = MAINNET.stakePool): TransactionInstruction {
  const [withdrawAuth] = PublicKey.findProgramAddressSync([pool.toBuffer(), Buffer.from("withdraw")], p.programId);
  const from = getAssociatedTokenAddressSync(p.mint, user, false, p.tokenProgram);
  const data = Buffer.alloc(9);
  data[0] = WITHDRAW_SOL;
  data.writeBigUInt64LE(pxnt, 1);
  const w = (pubkey: PublicKey, isSigner = false) => ({ pubkey, isSigner, isWritable: true });
  const r = (pubkey: PublicKey, isSigner = false) => ({ pubkey, isSigner, isWritable: false });
  return new TransactionInstruction({
    programId: p.programId,
    keys: [
      w(pool),
      r(withdrawAuth),
      r(user, true),
      w(from),
      w(p.reserve),
      w(user),
      w(p.managerFee),
      w(p.mint),
      r(SYSVAR_CLOCK),
      r(SYSVAR_STAKE_HISTORY),
      r(STAKE_PROGRAM),
      r(p.tokenProgram),
    ],
    data,
  });
}

/** DepositSol from already-fetched pool info (no network call): creates the pXNT account if needed. */
export function depositXntForPxntIxs(p: StakePoolInfo, user: PublicKey, lamports: bigint, pool = MAINNET.stakePool): TransactionInstruction[] {
  const [withdrawAuth] = PublicKey.findProgramAddressSync([pool.toBuffer(), Buffer.from("withdraw")], p.programId);
  const dest = getAssociatedTokenAddressSync(p.mint, user, false, p.tokenProgram);
  const data = Buffer.alloc(9);
  data[0] = DEPOSIT_SOL;
  data.writeBigUInt64LE(lamports, 1);
  const w = (pubkey: PublicKey, isSigner = false) => ({ pubkey, isSigner, isWritable: true });
  const r = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: false });
  return [
    createAssociatedTokenAccountIdempotentInstruction(user, dest, user, p.mint, p.tokenProgram),
    new TransactionInstruction({
      programId: p.programId,
      keys: [w(pool), r(withdrawAuth), w(p.reserve), w(user, true), w(dest), w(p.managerFee), w(p.managerFee), w(p.mint), r(SystemProgram.programId), r(p.tokenProgram)],
      data,
    }),
  ];
}

/**
 * Off-chain copy of the program's math (programs/accumulator/src/math.rs and
 * oracle.rs), in bigint. Used by the UI and the liquidator to predict exactly
 * what the program will accept.
 */
import { PublicKey } from "@solana/web3.js";
import { BPS, LAYOUT, WAD } from "./constants";

const YEAR = 31_536_000n;
const Q32 = 1n << 32n;
const U128 = (1n << 128n) - 1n;

export interface Params {
  maxLtvBps: number;
  liquidationThresholdBps: number;
  liquidationBonusBps: number;
  closeFactorBps: number;
  reserveFactorBps: number;
  optimalUtilizationBps: number;
  maxUtilizationBps: number;
  baseRateBps: number;
  slope1Bps: number;
  slope2Bps: number;
  depositCap: bigint;
  borrowCap: bigint;
  maxBorrowPerObligation: bigint;
  dustDebt: bigint;
  twapWindowSecs: number;
  /** Share of each liquidation bonus kept by the protocol (paid in collateral). */
  liquidationFeeBps: number;
}

export interface MarketState {
  params: Params;
  cash: bigint;
  totalBorrowScaled: bigint;
  borrowIndex: bigint;
  protocolFees: bigint;
  lastAccrualTs: bigint;
}

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

export function utilizationBps(borrows: bigint, cash: bigint): bigint {
  const total = borrows + cash;
  return total === 0n ? 0n : (borrows * BPS) / total;
}

export function borrowRateBps(p: Params, util: bigint): bigint {
  const opt = BigInt(p.optimalUtilizationBps);
  const base = BigInt(p.baseRateBps);
  const s1 = BigInt(p.slope1Bps);
  const s2 = BigInt(p.slope2Bps);
  if (util <= opt) return base + (s1 * util) / opt;
  const excess = (util > BPS ? BPS : util) - opt;
  return base + s1 + (s2 * excess) / (BPS - opt);
}

export function totalBorrows(m: MarketState): bigint {
  return ceilDiv(m.totalBorrowScaled * m.borrowIndex, WAD);
}

export function lenderAssets(m: MarketState): bigint {
  const a = m.cash + totalBorrows(m) - m.protocolFees;
  return a < 0n ? 0n : a;
}

/** Market state as it will be after interest accrues up to `now`. */
export function accrued(m: MarketState, now: bigint): MarketState {
  if (now <= m.lastAccrualTs || m.totalBorrowScaled === 0n) return { ...m, lastAccrualTs: now > m.lastAccrualTs ? now : m.lastAccrualTs };
  const dt = now - m.lastAccrualTs;
  const before = totalBorrows(m);
  const rate = borrowRateBps(m.params, utilizationBps(before, m.cash));
  const growth = (((rate * WAD) / BPS) * dt) / YEAR;
  const next = { ...m, borrowIndex: (m.borrowIndex * (WAD + growth)) / WAD, lastAccrualTs: now };
  const interest = totalBorrows(next) - before;
  next.protocolFees = m.protocolFees + (interest * BigInt(m.params.reserveFactorBps)) / BPS;
  return next;
}

export function debtOf(m: MarketState, scaled: bigint): bigint {
  return ceilDiv(scaled * m.borrowIndex, WAD);
}

export function collateralValue(amount: bigint, priceWad: bigint): bigint {
  return (amount * priceWad) / WAD;
}

/** Health factor as a float: >1 is safe from liquidation. */
export function healthFactor(debt: bigint, value: bigint, liqThresholdBps: number): number {
  if (debt === 0n) return Infinity;
  return Number((value * BigInt(liqThresholdBps) * 1_000_000n) / (debt * BPS)) / 1_000_000;
}

export function withinLimit(debt: bigint, value: bigint, limitBps: number): boolean {
  return debt * BPS <= value * BigInt(limitBps);
}

/** Largest amount still borrowable at a price, ignoring caps. */
export function borrowCapacity(collateral: bigint, priceWad: bigint, debt: bigint, maxLtvBps: number): bigint {
  const limit = (collateralValue(collateral, priceWad) * BigInt(maxLtvBps)) / BPS;
  return limit > debt ? limit - debt : 0n;
}

export function maxLiquidationRepay(debt: bigint, value: bigint, p: Params): bigint {
  if (debt <= p.dustDebt) return debt;
  const t = (BigInt(p.maxLtvBps) + BigInt(p.liquidationThresholdBps)) / 2n;
  const b = BigInt(p.liquidationBonusBps);
  const vt = (value * t) / BPS;
  const needed = debt > vt ? ((debt - vt) * BPS * BPS) / (BPS * BPS - (BPS + b) * t) + 1n : 0n;
  const close = ceilDiv(debt * BigInt(p.closeFactorBps), BPS);
  let r = needed < close ? needed : close;
  if (r > debt) r = debt;
  return r < 1n ? 1n : r;
}

/** Protocol's cut of a liquidation: `feeBps` of the bonus part of `seize` (mirrors math.rs). */
export function liquidationFee(seize: bigint, bonusBps: number, feeBps: number): bigint {
  const bonusPart = (seize * BigInt(bonusBps)) / (BPS + BigInt(bonusBps));
  return (bonusPart * BigInt(feeBps)) / BPS;
}

export function seizeForRepay(repay: bigint, priceWad: bigint, bonusBps: number): bigint {
  return (((repay * (BPS + BigInt(bonusBps))) / BPS) * WAD) / priceWad;
}

// ------------------------------------------------------------------ prices

const u64At = (d: Uint8Array, at: number) => Buffer.from(d).readBigUInt64LE(at);
const u128At = (d: Uint8Array, at: number) => {
  const b = Buffer.from(d);
  return b.readBigUInt64LE(at) | (b.readBigUInt64LE(at + 8) << 64n);
};
const keyAt = (d: Uint8Array, at: number) => new PublicKey(d.slice(at, at + 32));

export function stakePoolPriceWad(data: Uint8Array): bigint {
  const L = LAYOUT.stakePool;
  const lamports = u64At(data, L.totalLamports);
  const supply = u64At(data, L.poolTokenSupply);
  if (lamports === 0n || supply === 0n) throw new Error("stake pool is empty");
  return (lamports * WAD) / supply;
}

export interface XdexPoolInfo {
  vault0: PublicKey;
  vault1: PublicKey;
  mint0: PublicKey;
  mint1: PublicKey;
  observation: PublicKey;
  fees0: bigint;
  fees1: bigint;
}

export function parseXdexPool(d: Uint8Array): XdexPoolInfo {
  const L = LAYOUT.xdexPool;
  if (d.length !== L.len) throw new Error(`XDEX pool must be ${L.len} bytes`);
  return {
    vault0: keyAt(d, L.vault0),
    vault1: keyAt(d, L.vault1),
    mint0: keyAt(d, L.mint0),
    mint1: keyAt(d, L.mint1),
    observation: keyAt(d, L.observation),
    fees0: u64At(d, L.protocolFees0) + u64At(d, L.fundFees0),
    fees1: u64At(d, L.protocolFees1) + u64At(d, L.fundFees1),
  };
}

export interface Observation {
  ts: bigint;
  cum0: bigint;
  cum1: bigint;
}

export function parseObservations(d: Uint8Array): { index: number; obs: Observation[] } {
  const L = LAYOUT.xdexObservation;
  const index = Buffer.from(d).readUInt16LE(L.index);
  const obs: Observation[] = [];
  for (let i = 0; i < L.count; i++) {
    const at = L.observations + i * L.entryLen;
    obs.push({ ts: u64At(d, at), cum0: u128At(d, at + 8), cum1: u128At(d, at + 24) });
  }
  return { index, obs };
}

export function spotQ32(a0: bigint, a1: bigint): [bigint, bigint] {
  return [(a1 << 32n) / a0, (a0 << 32n) / a1];
}

/** Same TWAP the program computes (oracle.rs `twap_wad`). */
export function twapWad(index: number, obs: Observation[], spot0: bigint, spot1: bigint, now: bigint, window: bigint, token0: boolean): bigint {
  const last = obs[index];
  if (!last || last.ts === 0n) throw new Error("no price history");
  const target = now > window ? now - window : 0n;
  let start: Observation | undefined;
  let oldest: Observation | undefined;
  for (const o of obs) {
    if (o.ts === 0n) continue;
    if (o.ts <= target && (!start || o.ts > start.ts)) start = o;
    if (!oldest || o.ts < oldest.ts) oldest = o;
  }
  if (!start) {
    if (!oldest || now - oldest.ts < window / 2n) throw new Error("price history too short");
    start = oldest;
  }
  const lastCum = token0 ? last.cum0 : last.cum1;
  const startCum = token0 ? start.cum0 : start.cum1;
  const spot = token0 ? spot0 : spot1;
  // Same as the program: the unrecorded tail stays within 2% of the latest recorded interval.
  let prev: Observation | undefined;
  for (const o of obs) if (o.ts > 0n && o.ts < last.ts && (!prev || o.ts > prev.ts)) prev = o;
  let tailPrice = spot;
  if (prev) {
    const ref = (((token0 ? last.cum0 : last.cum1) - (token0 ? prev.cum0 : prev.cum1)) & U128) / (last.ts - prev.ts);
    const lo = (ref * 98n) / 100n, hi = (ref * 102n) / 100n;
    tailPrice = spot < lo ? lo : spot > hi ? hi : spot;
  }
  const tail = now > last.ts ? now - last.ts : 0n;
  const cumNow = (lastCum + tailPrice * tail) & U128;
  const dt = now - start.ts;
  if (dt <= 0n) throw new Error("price history too short");
  const avg = ((cumNow - startCum) & U128) / dt;
  return (avg * WAD) >> 32n;
}

export const priceToQ32Wad = (q32: bigint) => (q32 * WAD) >> 32n;
export { Q32 };

import { PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { MAINNET, NATIVE_MINT, TESTNET } from "./constants";
import { Params } from "./math";
import { marketPda } from "./pda";

const XNT = 1_000_000_000n; // 9 decimals
const USD = 1_000_000n; // USDC.x, 6 decimals

/**
 * v1 — lend XNT, borrow against pXNT (staked XNT).
 * Both sides are XNT, priced by the stake pool's own rate, so there is no
 * market price to manipulate. LTV can be high, like Kamino's SOL/LST mode.
 */
export const XNT_PXNT_PARAMS: Params = {
  maxLtvBps: 8_000,
  liquidationThresholdBps: 8_500,
  liquidationBonusBps: 200,
  closeFactorBps: 5_000,
  reserveFactorBps: 1_000,
  optimalUtilizationBps: 8_500,
  maxUtilizationBps: 9_500,
  baseRateBps: 0,
  // 4% at the kink: below mainnet staking (~5.8%), so looping pays up to just past 85% utilization
  slope1Bps: 400,
  slope2Bps: 10_000,
  // Launch caps (raise later through the 2-day timelock): ~$62k of deposits while the code has only an
  // internal review, and no single position above ~12% of total borrows so a liquidator's capital covers it.
  depositCap: 250_000n * XNT,
  borrowCap: 200_000n * XNT,
  maxBorrowPerObligation: 25_000n * XNT,
  dustDebt: XNT / 100n,
  twapWindowSecs: 0,
  liquidationFeeBps: 1_000, // 10% of the bonus, like Aave
};

/**
 * Lend XNT, borrow against rXNT (Ripper Pool's staked XNT). Same mechanics as
 * pXNT: priced by the pool's own rate on the same X1 stake pool program. A bit
 * more conservative because the pool is third-party run and smaller: 10.6M XNT
 * across 72 validators, a 366k XNT liquid reserve for instant unstaking, and a
 * 0.2% withdrawal fee that liquidators pay to exit.
 */
export const XNT_RXNT_PARAMS: Params = {
  ...XNT_PXNT_PARAMS,
  maxLtvBps: 7_500,
  liquidationThresholdBps: 8_200,
  liquidationBonusBps: 300,
  // caps well under the pool's liquid reserve, so every looper and liquidator can exit at once
  depositCap: 50_000n * XNT,
  borrowCap: 40_000n * XNT,
  maxBorrowPerObligation: 10_000n * XNT,
};

/**
 * v1.1 — lend USDC.x, borrow against XNT, priced by the XDEX TWAP.
 * The XNT/USDC.x pool held about $4.9k of USDC.x on 2026-10-24, so caps stay
 * small: borrows ≤ $1k (under ~2x pool depth), $250 per account, deposits ≤ $10k. Stress tests (tests-rs/tests/stress.rs): at 40% LTV / 55% liquidation
 * a -60%-in-1-hour crash left 0.07% bad debt on average at a $1k cap (vs 3.4%
 * at 50/65), and pump attacks stop paying below about a $20k total cap.
 */
export const USDC_XNT_PARAMS: Params = {
  maxLtvBps: 4_000,
  liquidationThresholdBps: 5_500,
  liquidationBonusBps: 500,
  closeFactorBps: 5_000,
  reserveFactorBps: 1_000,
  optimalUtilizationBps: 8_000,
  maxUtilizationBps: 9_000,
  baseRateBps: 0,
  slope1Bps: 800,
  slope2Bps: 20_000,
  depositCap: 10_000n * USD,
  borrowCap: 1_000n * USD,
  maxBorrowPerObligation: 250n * USD,
  dustDebt: USD,
  twapWindowSecs: 1_200,
  liquidationFeeBps: 1_000,
};

export const MAINNET_MARKETS = {
  xntPxnt: {
    name: "XNT / pXNT",
    lendSymbol: "XNT",
    collateralSymbol: "pXNT",
    lendDecimals: 9,
    collateralDecimals: 9,
    lendIsUsd: false,
    address: marketPda(NATIVE_MINT, MAINNET.pxntMint),
    lendMint: NATIVE_MINT,
    collateralMint: MAINNET.pxntMint,
    lendTokenProgram: TOKEN_PROGRAM_ID,
    collateralTokenProgram: TOKEN_PROGRAM_ID,
    oracleKind: "stakePool" as const,
    collateralIsToken0: false,
    oracleAccounts: [MAINNET.stakePool],
    params: XNT_PXNT_PARAMS,
  },
  xntRxnt: {
    name: "XNT / rXNT",
    lendSymbol: "XNT",
    collateralSymbol: "rXNT",
    lendDecimals: 9,
    collateralDecimals: 9,
    lendIsUsd: false,
    address: marketPda(NATIVE_MINT, MAINNET.ripper.rxntMint),
    lendMint: NATIVE_MINT,
    collateralMint: MAINNET.ripper.rxntMint,
    lendTokenProgram: TOKEN_PROGRAM_ID,
    collateralTokenProgram: TOKEN_2022_PROGRAM_ID,
    oracleKind: "stakePool" as const,
    collateralIsToken0: false,
    oracleAccounts: [MAINNET.ripper.stakePool],
    params: XNT_RXNT_PARAMS,
  },
  usdcXnt: {
    name: "USDC.x / XNT",
    lendSymbol: "USDC.x",
    collateralSymbol: "XNT",
    lendDecimals: 6,
    collateralDecimals: 9,
    lendIsUsd: true,
    address: marketPda(MAINNET.usdcxMint, NATIVE_MINT),
    lendMint: MAINNET.usdcxMint,
    collateralMint: NATIVE_MINT,
    lendTokenProgram: TOKEN_2022_PROGRAM_ID,
    collateralTokenProgram: TOKEN_PROGRAM_ID,
    oracleKind: "xdexTwap" as const,
    // XNT is token 0 of the XDEX pool
    collateralIsToken0: true,
    oracleAccounts: [
      MAINNET.xdexXntUsdc.pool,
      MAINNET.xdexXntUsdc.observation,
      MAINNET.xdexXntUsdc.vault0,
      MAINNET.xdexXntUsdc.vault1,
    ],
    params: USDC_XNT_PARAMS,
  },
} satisfies Record<string, { address: PublicKey } & Record<string, unknown>>;

/** Testnet USDC has 9 decimals, so its caps are restated in 9-decimal units. */
const TUSD = 1_000_000_000n;
export const TESTNET_USDC_XNT_PARAMS: Params = {
  ...USDC_XNT_PARAMS,
  depositCap: 10_000n * TUSD,
  borrowCap: 1_000n * TUSD,
  maxBorrowPerObligation: 250n * TUSD,
  dustDebt: TUSD,
};

export const TESTNET_MARKETS = {
  xntPxnt: MAINNET_MARKETS.xntPxnt, // same stake pool and pXNT on testnet
  // Percolator's mintable test USDC: 6 decimals, so the mainnet USDC.x presets apply as-is
  usdcXnt: {
    ...MAINNET_MARKETS.usdcXnt,
    name: "USDC / XNT",
    lendSymbol: "USDC",
    address: marketPda(TESTNET.testUsdcMint, NATIVE_MINT),
    lendMint: TESTNET.testUsdcMint,
    lendTokenProgram: TOKEN_PROGRAM_ID,
    oracleAccounts: [TESTNET.xdexXntTestUsdc.pool, TESTNET.xdexXntTestUsdc.observation, TESTNET.xdexXntTestUsdc.vault0, TESTNET.xdexXntTestUsdc.vault1],
    params: USDC_XNT_PARAMS,
  },
  // First testnet USDC market (unmintable USDC, stale pool). Kept so positions can be closed.
  legacyUsdcXnt: {
    ...MAINNET_MARKETS.usdcXnt,
    name: "Old USDC / XNT (withdraw only)",
    lendSymbol: "USDC",
    lendDecimals: 9,
    address: marketPda(TESTNET.usdcMint, NATIVE_MINT),
    lendMint: TESTNET.usdcMint,
    oracleAccounts: [TESTNET.xdexXntUsdc.pool, TESTNET.xdexXntUsdc.observation, TESTNET.xdexXntUsdc.vault0, TESTNET.xdexXntUsdc.vault1],
    params: TESTNET_USDC_XNT_PARAMS,
  },
};

export type MarketDef = (typeof MAINNET_MARKETS)[keyof typeof MAINNET_MARKETS];
export const marketsFor = (network: "mainnet" | "testnet"): Record<string, MarketDef> =>
  network === "testnet" ? TESTNET_MARKETS : MAINNET_MARKETS;

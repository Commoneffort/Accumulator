import { BN, Program, Provider } from "@coral-xyz/anchor";
import {
  AccountMeta,
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";

import idl from "./idl/accumulator.json";
import type { Accumulator } from "./idl/accumulator-types";
import { NATIVE_MINT } from "./constants";
import {
  MarketState,
  Params,
  parseObservations,
  parseXdexPool,
  spotQ32,
  stakePoolPriceWad,
  twapWad,
  priceToQ32Wad,
} from "./math";
import {
  collateralVaultPda,
  configPda,
  liquidityVaultPda,
  marketPda,
  obligationPda,
  shareMintPda,
} from "./pda";

export type OracleKind = "stakePool" | "xdexTwap";

export interface Market extends MarketState {
  address: PublicKey;
  config: PublicKey;
  lendMint: PublicKey;
  lendTokenProgram: PublicKey;
  lendDecimals: number;
  collateralMint: PublicKey;
  collateralTokenProgram: PublicKey;
  collateralDecimals: number;
  liquidityVault: PublicKey;
  collateralVault: PublicKey;
  shareMint: PublicKey;
  oracleKind: OracleKind;
  oracleAccounts: PublicKey[];
  collateralIsToken0: boolean;
  pendingParams: Params;
  pendingEta: bigint;
  hasPending: boolean;
  borrowPaused: boolean;
  totalCollateral: bigint;
  cumulativeBadDebt: bigint;
  /** Liquidation fees waiting for the treasury, in collateral raw units. */
  protocolCollateralFees: bigint;
}

export interface Obligation {
  address: PublicKey;
  market: PublicKey;
  owner: PublicKey;
  collateral: bigint;
  borrowScaled: bigint;
}

// Through hex: bn.js's decimal toString has proven fragile when other
// libraries share the process; base 16 is exact and simple.
const big = (v: BN | number | bigint): bigint =>
  typeof v === "bigint" ? v : typeof v === "number" ? BigInt(v) : BigInt("0x" + (v.toString(16) || "0"));

function toParams(p: any): Params {
  return {
    maxLtvBps: p.maxLtvBps,
    liquidationThresholdBps: p.liquidationThresholdBps,
    liquidationBonusBps: p.liquidationBonusBps,
    closeFactorBps: p.closeFactorBps,
    reserveFactorBps: p.reserveFactorBps,
    optimalUtilizationBps: p.optimalUtilizationBps,
    maxUtilizationBps: p.maxUtilizationBps,
    baseRateBps: p.baseRateBps,
    slope1Bps: p.slope1Bps,
    slope2Bps: p.slope2Bps,
    depositCap: big(p.depositCap),
    borrowCap: big(p.borrowCap),
    maxBorrowPerObligation: big(p.maxBorrowPerObligation),
    dustDebt: big(p.dustDebt),
    twapWindowSecs: p.twapWindowSecs,
    liquidationFeeBps: p.liquidationFeeBps ?? 0,
  };
}

export function paramsToIdl(p: Params) {
  return {
    maxLtvBps: p.maxLtvBps,
    liquidationThresholdBps: p.liquidationThresholdBps,
    liquidationBonusBps: p.liquidationBonusBps,
    closeFactorBps: p.closeFactorBps,
    reserveFactorBps: p.reserveFactorBps,
    optimalUtilizationBps: p.optimalUtilizationBps,
    maxUtilizationBps: p.maxUtilizationBps,
    baseRateBps: p.baseRateBps,
    slope1Bps: p.slope1Bps,
    slope2Bps: p.slope2Bps,
    depositCap: new BN(p.depositCap.toString()),
    borrowCap: new BN(p.borrowCap.toString()),
    maxBorrowPerObligation: new BN(p.maxBorrowPerObligation.toString()),
    dustDebt: new BN(p.dustDebt.toString()),
    twapWindowSecs: p.twapWindowSecs,
    liquidationFeeBps: p.liquidationFeeBps,
  };
}

const ro = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: false });

/**
 * Builds Accumulator instructions and reads its accounts. Works with any Connection;
 * signing and sending is left to the caller (wallet adapter, keypair, tests).
 */
export class AccumulatorClient {
  readonly program: Program<Accumulator>;
  readonly programId: PublicKey;

  constructor(readonly connection: Connection, programId?: PublicKey) {
    const withId = programId ? { ...(idl as any), address: programId.toBase58() } : idl;
    this.program = new Program<Accumulator>(withId as any, { connection } as Provider);
    this.programId = this.program.programId;
  }

  // ------------------------------------------------------------- decoding

  decodeMarket(address: PublicKey, data: Buffer | Uint8Array): Market {
    const m: any = this.program.coder.accounts.decode("market", Buffer.from(data));
    return {
      address,
      config: m.config,
      lendMint: m.lendMint,
      lendTokenProgram: m.lendTokenProgram,
      lendDecimals: m.lendDecimals,
      collateralMint: m.collateralMint,
      collateralTokenProgram: m.collateralTokenProgram,
      collateralDecimals: m.collateralDecimals,
      liquidityVault: m.liquidityVault,
      collateralVault: m.collateralVault,
      shareMint: m.shareMint,
      oracleKind: m.oracleKind.stakePool !== undefined ? "stakePool" : "xdexTwap",
      oracleAccounts: m.oracleAccounts,
      collateralIsToken0: m.collateralIsToken0,
      params: toParams(m.params),
      pendingParams: toParams(m.pendingParams),
      pendingEta: big(m.pendingEta),
      hasPending: m.hasPending,
      borrowPaused: m.borrowPaused,
      cash: big(m.cash),
      totalBorrowScaled: big(m.totalBorrowScaled),
      borrowIndex: big(m.borrowIndex),
      protocolFees: big(m.protocolFees),
      lastAccrualTs: big(m.lastAccrualTs),
      totalCollateral: big(m.totalCollateral),
      cumulativeBadDebt: big(m.cumulativeBadDebt),
      protocolCollateralFees: big(m.protocolCollateralFees ?? 0),
    };
  }

  decodeObligation(address: PublicKey, data: Buffer | Uint8Array): Obligation {
    const o: any = this.program.coder.accounts.decode("obligation", Buffer.from(data));
    return { address, market: o.market, owner: o.owner, collateral: big(o.collateral), borrowScaled: big(o.borrowScaled) };
  }

  async fetchMarket(address: PublicKey): Promise<Market> {
    const info = await this.connection.getAccountInfo(address);
    if (!info) throw new Error(`market ${address.toBase58()} not found`);
    return this.decodeMarket(address, info.data);
  }

  async fetchObligation(address: PublicKey): Promise<Obligation | null> {
    const info = await this.connection.getAccountInfo(address);
    return info ? this.decodeObligation(address, info.data) : null;
  }

  /** All positions in a market (for liquidators and dashboards). */
  async fetchObligations(market: PublicKey): Promise<Obligation[]> {
    const accs = await this.connection.getProgramAccounts(this.programId, {
      filters: [
        { memcmp: this.program.coder.accounts.memcmp("obligation") as any },
        { memcmp: { offset: 8, bytes: market.toBase58() } },
      ],
    });
    return accs.map((a) => this.decodeObligation(a.pubkey, a.account.data));
  }

  oracleMetas(m: Market): AccountMeta[] {
    return m.oracleKind === "stakePool" ? [ro(m.oracleAccounts[0])] : m.oracleAccounts.slice(0, 4).map(ro);
  }

  /**
   * Reads the price the program would use right now.
   * `usage` "borrow" = min(TWAP, spot) for XDEX; "liquidate" = TWAP.
   */
  async readPrice(m: Market, usage: "borrow" | "liquidate", now?: bigint): Promise<bigint> {
    const infos = await this.connection.getMultipleAccountsInfo(m.oracleAccounts.slice(0, m.oracleKind === "stakePool" ? 1 : 4));
    if (infos.some((i) => !i)) throw new Error("oracle account missing");
    if (m.oracleKind === "stakePool") return stakePoolPriceWad(infos[0]!.data);
    const pool = parseXdexPool(infos[0]!.data);
    const { index, obs } = parseObservations(infos[1]!.data);
    const a0 = Buffer.from(infos[2]!.data).readBigUInt64LE(64) - pool.fees0;
    const a1 = Buffer.from(infos[3]!.data).readBigUInt64LE(64) - pool.fees1;
    const [s0, s1] = spotQ32(a0, a1);
    const t = now ?? BigInt(Math.floor(Date.now() / 1000));
    const twap = twapWad(index, obs, s0, s1, t, BigInt(m.params.twapWindowSecs), m.collateralIsToken0);
    if (usage === "liquidate") return twap;
    const spot = priceToQ32Wad(m.collateralIsToken0 ? s0 : s1);
    return twap < spot ? twap : spot;
  }

  // ----------------------------------------------------------- admin ixs

  initConfig(admin: PublicKey, timelockSeconds: number): Promise<TransactionInstruction> {
    return this.program.methods
      .initConfig(new BN(timelockSeconds))
      .accountsStrict({ config: configPda(this.programId), admin, systemProgram: SystemProgram.programId })
      .instruction();
  }

  proposeAdmin(admin: PublicKey, newAdmin: PublicKey) {
    return this.program.methods.proposeAdmin(newAdmin).accountsStrict({ config: configPda(this.programId), admin }).instruction();
  }

  acceptAdmin(newAdmin: PublicKey) {
    return this.program.methods.acceptAdmin().accountsStrict({ config: configPda(this.programId), newAdmin }).instruction();
  }

  createMarket(args: {
    admin: PublicKey;
    lendMint: PublicKey;
    collateralMint: PublicKey;
    lendTokenProgram: PublicKey;
    collateralTokenProgram: PublicKey;
    params: Params;
    oracleKind: OracleKind;
    collateralIsToken0: boolean;
    oracleAccounts: PublicKey[];
  }): Promise<TransactionInstruction> {
    const market = marketPda(args.lendMint, args.collateralMint, this.programId);
    const kind = args.oracleKind === "stakePool" ? { stakePool: {} } : { xdexTwap: {} };
    return this.program.methods
      .createMarket(paramsToIdl(args.params), kind as any, args.collateralIsToken0)
      .accountsStrict({
        config: configPda(this.programId),
        admin: args.admin,
        lendMint: args.lendMint,
        collateralMint: args.collateralMint,
        market,
        liquidityVault: liquidityVaultPda(market, this.programId),
        collateralVault: collateralVaultPda(market, this.programId),
        shareMint: shareMintPda(market, this.programId),
        lendTokenProgram: args.lendTokenProgram,
        collateralTokenProgram: args.collateralTokenProgram,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts(args.oracleAccounts.map(ro))
      .instruction();
  }

  queueParams(admin: PublicKey, market: PublicKey, params: Params) {
    return this.program.methods
      .queueParams(paramsToIdl(params))
      .accountsStrict({ config: configPda(this.programId), admin, market })
      .instruction();
  }

  cancelParams(admin: PublicKey, market: PublicKey) {
    return this.program.methods.cancelParams().accountsStrict({ config: configPda(this.programId), admin, market }).instruction();
  }

  applyParams(market: PublicKey) {
    return this.program.methods.applyParams().accountsStrict({ market }).instruction();
  }

  setBorrowPaused(admin: PublicKey, market: PublicKey, paused: boolean) {
    return this.program.methods.setBorrowPaused(paused).accountsStrict({ config: configPda(this.programId), admin, market }).instruction();
  }

  /** Admin: set the fee treasury (first time at once, later changes wait for the timelock). */
  setTreasury(admin: PublicKey, treasury: PublicKey) {
    return this.program.methods.setTreasury(treasury).accountsStrict({ config: configPda(this.programId), admin }).instruction();
  }

  /** Anyone: apply a queued treasury change after the timelock. */
  applyTreasury() {
    return this.program.methods.applyTreasury().accountsStrict({ config: configPda(this.programId) }).instruction();
  }

  async fetchConfig() {
    const c: any = await this.program.account.config.fetch(configPda(this.programId));
    return {
      admin: c.admin as PublicKey,
      pendingAdmin: c.pendingAdmin as PublicKey,
      timelockSeconds: Number(big(c.timelockSeconds)),
      treasury: c.treasury as PublicKey,
      pendingTreasury: c.pendingTreasury as PublicKey,
      treasuryEta: Number(big(c.treasuryEta)),
    };
  }

  /** Anyone: send accrued interest fees to the treasury's token account (u64 max = all). */
  collectFees(m: Market, treasuryToken: PublicKey, amount: bigint = U64_MAX) {
    return this.program.methods
      .collectFees(new BN(amount.toString()))
      .accountsStrict({
        config: configPda(this.programId),
        market: m.address,
        lendMint: m.lendMint,
        liquidityVault: m.liquidityVault,
        treasuryToken,
        lendTokenProgram: m.lendTokenProgram,
      })
      .instruction();
  }

  /** Anyone: send liquidation fees (collateral tokens) to the treasury's token account. */
  collectCollateralFees(m: Market, treasuryToken: PublicKey) {
    return this.program.methods
      .collectCollateralFees()
      .accountsStrict({
        config: configPda(this.programId),
        market: m.address,
        collateralMint: m.collateralMint,
        collateralVault: m.collateralVault,
        treasuryToken,
        collateralTokenProgram: m.collateralTokenProgram,
      })
      .instruction();
  }

  /** Admin, once after the Oct 2026 upgrade: resize old accounts to the new layout. */
  migrateConfig(admin: PublicKey) {
    return this.program.methods
      .migrateConfig()
      .accountsStrict({ config: configPda(this.programId), admin, systemProgram: SystemProgram.programId })
      .instruction();
  }

  migrateMarket(admin: PublicKey, market: PublicKey) {
    return this.program.methods
      .migrateMarket()
      .accountsStrict({ config: configPda(this.programId), market, admin, systemProgram: SystemProgram.programId })
      .instruction();
  }

  accrueInterest(market: PublicKey) {
    return this.program.methods.accrueInterest().accountsStrict({ market }).instruction();
  }

  // ---------------------------------------------------------- lender ixs

  private lendAccounts(m: Market, user: PublicKey, userToken: PublicKey, userShares: PublicKey) {
    return {
      market: m.address,
      user,
      lendMint: m.lendMint,
      liquidityVault: m.liquidityVault,
      shareMint: m.shareMint,
      userToken,
      userShares,
      lendTokenProgram: m.lendTokenProgram,
    };
  }

  deposit(m: Market, user: PublicKey, userToken: PublicKey, userShares: PublicKey, amount: bigint) {
    return this.program.methods
      .deposit(new BN(amount.toString()))
      .accountsStrict(this.lendAccounts(m, user, userToken, userShares))
      .instruction();
  }

  withdraw(m: Market, user: PublicKey, userToken: PublicKey, userShares: PublicKey, shares: bigint) {
    return this.program.methods
      .withdraw(new BN(shares.toString()))
      .accountsStrict(this.lendAccounts(m, user, userToken, userShares))
      .instruction();
  }

  // -------------------------------------------------------- borrower ixs

  openObligation(market: PublicKey, owner: PublicKey) {
    return this.program.methods
      .openObligation()
      .accountsStrict({
        market,
        obligation: obligationPda(market, owner, this.programId),
        owner,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }

  closeObligation(market: PublicKey, owner: PublicKey) {
    return this.program.methods
      .closeObligation()
      .accountsStrict({ obligation: obligationPda(market, owner, this.programId), owner })
      .instruction();
  }

  private collateralAccounts(m: Market, owner: PublicKey, userCollateral: PublicKey) {
    return {
      market: m.address,
      obligation: obligationPda(m.address, owner, this.programId),
      owner,
      collateralMint: m.collateralMint,
      collateralVault: m.collateralVault,
      userCollateral,
      collateralTokenProgram: m.collateralTokenProgram,
    };
  }

  depositCollateral(m: Market, owner: PublicKey, userCollateral: PublicKey, amount: bigint) {
    return this.program.methods
      .depositCollateral(new BN(amount.toString()))
      .accountsStrict(this.collateralAccounts(m, owner, userCollateral))
      .instruction();
  }

  /** Oracle accounts are always attached; the program only reads them when there is debt. */
  withdrawCollateral(m: Market, owner: PublicKey, userCollateral: PublicKey, amount: bigint, oracle = this.oracleMetas(m)) {
    return this.program.methods
      .withdrawCollateral(new BN(amount.toString()))
      .accountsStrict(this.collateralAccounts(m, owner, userCollateral))
      .remainingAccounts(oracle)
      .instruction();
  }

  borrow(m: Market, owner: PublicKey, destination: PublicKey, amount: bigint, oracle = this.oracleMetas(m)) {
    return this.program.methods
      .borrow(new BN(amount.toString()))
      .accountsStrict({
        market: m.address,
        obligation: obligationPda(m.address, owner, this.programId),
        owner,
        lendMint: m.lendMint,
        liquidityVault: m.liquidityVault,
        destination,
        lendTokenProgram: m.lendTokenProgram,
      })
      .remainingAccounts(oracle)
      .instruction();
  }

  /** `amount` = u64 max repays the full debt. */
  repay(m: Market, obligation: PublicKey, payer: PublicKey, source: PublicKey, amount: bigint) {
    return this.program.methods
      .repay(new BN(amount.toString()))
      .accountsStrict({
        market: m.address,
        obligation,
        payer,
        lendMint: m.lendMint,
        liquidityVault: m.liquidityVault,
        source,
        lendTokenProgram: m.lendTokenProgram,
      })
      .instruction();
  }

  liquidate(
    m: Market,
    obligation: PublicKey,
    liquidator: PublicKey,
    liquidatorLend: PublicKey,
    liquidatorCollateral: PublicKey,
    maxRepay: bigint,
    minCollateralOut: bigint,
    oracle = this.oracleMetas(m),
  ) {
    return this.program.methods
      .liquidate(new BN(maxRepay.toString()), new BN(minCollateralOut.toString()))
      .accountsStrict({
        market: m.address,
        obligation,
        liquidator,
        lendMint: m.lendMint,
        collateralMint: m.collateralMint,
        liquidityVault: m.liquidityVault,
        collateralVault: m.collateralVault,
        liquidatorLend,
        liquidatorCollateral,
        lendTokenProgram: m.lendTokenProgram,
        collateralTokenProgram: m.collateralTokenProgram,
      })
      .remainingAccounts(oracle)
      .instruction();
  }
}

export const U64_MAX = (1n << 64n) - 1n;
export { NATIVE_MINT, TOKEN_PROGRAM_ID };

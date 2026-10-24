/**
 * The SDK's off-chain math must agree with the program. These vectors come
 * from the Rust tests (programs/accumulator/src/math.rs, tests-rs/tests/mainnet_fork.rs).
 */
import { expect } from "chai";
import fs from "fs";
import path from "path";
import { WAD } from "../sdk/src/constants";
import {
  Params,
  borrowRateBps,
  maxLiquidationRepay,
  parseObservations,
  parseXdexPool,
  seizeForRepay,
  spotQ32,
  stakePoolPriceWad,
  twapWad,
  withinLimit,
} from "../sdk/src/math";

const params: Params = {
  maxLtvBps: 5_000,
  liquidationThresholdBps: 6_500,
  liquidationBonusBps: 500,
  closeFactorBps: 5_000,
  reserveFactorBps: 1_000,
  optimalUtilizationBps: 8_500,
  maxUtilizationBps: 9_500,
  baseRateBps: 0,
  slope1Bps: 800,
  slope2Bps: 30_000,
  depositCap: 0n,
  borrowCap: 0n,
  maxBorrowPerObligation: 0n,
  dustDebt: 1_000n,
  twapWindowSecs: 1_200,
  liquidationFeeBps: 1_000,
};

describe("SDK math matches the program", () => {
  it("rate curve", () => {
    expect(borrowRateBps(params, 0n)).to.equal(0n);
    expect(borrowRateBps(params, 8_500n)).to.equal(800n);
    expect(borrowRateBps(params, 9_250n)).to.equal(15_800n);
    expect(borrowRateBps(params, 10_000n)).to.equal(30_800n);
  });

  it("liquidation sizing (same vectors as math.rs)", () => {
    const r = maxLiquidationRepay(660_000n, 1_000_000n, params);
    const seized = seizeForRepay(r, WAD, 500);
    expect(withinLimit(660_000n - r, 1_000_000n - seized, 5_750)).to.equal(true);
    expect(withinLimit(660_000n - r + 2_000n, 1_000_000n - seized, 5_750)).to.equal(false);
    expect(maxLiquidationRepay(950_000n, 1_000_000n, params)).to.equal(475_000n);
    expect(maxLiquidationRepay(900n, 1_000n, params)).to.equal(900n);
  });

  it("prices from the mainnet snapshot match the program's", () => {
    const fx = JSON.parse(fs.readFileSync(path.join(__dirname, "../tests-rs/fixtures/mainnet.json"), "utf8"));
    const d = (n: string) => Buffer.from(fx.accounts[n].data, "base64");
    const rate = Number(stakePoolPriceWad(d("stake_pool"))) / 1e18;
    // independent read of the raw fields (X1 layout: total_lamports @259, pool_token_supply @267)
    const raw = Number(d("stake_pool").readBigUInt64LE(259)) / Number(d("stake_pool").readBigUInt64LE(267));
    expect(rate).to.be.closeTo(raw, 1e-9);

    const pool = parseXdexPool(d("xdex_pool"));
    const { index, obs } = parseObservations(d("xdex_observation"));
    const a0 = d("xdex_vault0").readBigUInt64LE(64) - pool.fees0;
    const a1 = d("xdex_vault1").readBigUInt64LE(64) - pool.fees1;
    const [s0, s1] = spotQ32(a0, a1);
    const twap = twapWad(index, obs, s0, s1, BigInt(fx.unix_timestamp), 1_200n, true);
    // tests-rs/tests/mainnet_fork.rs prints $0.2597 for this snapshot (refreshed Oct 24, 2026)
    expect((Number(twap) / 1e18) * 1e3).to.be.closeTo(0.2597, 0.00005);
  });
});

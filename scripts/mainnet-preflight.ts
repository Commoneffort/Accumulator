/**
 * Read-only mainnet launch checks. Sends nothing.
 *
 *   ADMIN=~/.config/solana/accumulator-mainnet-admin.json npx ts-node scripts/mainnet-preflight.ts
 *
 * Exit code 1 if anything FAILs. WARNs are decisions to confirm, not blockers.
 */
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getExtensionTypes, getMint, ExtensionType } from "@solana/spl-token";
import { createHash } from "crypto";
import fs from "fs";
import os from "os";
import {
  ACCUMULATOR_PROGRAM_ID,
  AccumulatorClient,
  MAINNET,
  MAINNET_MARKETS,
  Market,
  Params,
  X1_STAKE_POOL_PROGRAM_ID,
  configPda,
  estimateStakingApy,
  fetchStakePool,
} from "../sdk/src";

const XDEX_MAINNET = new PublicKey("sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN");
const BINARY = "target/deploy-mainnet/accumulator.so";
const PROGRAM_KEYPAIR = process.env.PROGRAM_KEYPAIR ?? "~/.config/solana/accumulator-program-keypair.json";
const ADMIN = process.env.ADMIN ?? "~/.config/solana/accumulator-mainnet-admin.json";
const HEADROOM = 1.25; // deploy with --max-len 25% above today's size so upgrades fit

const home = (p: string) => p.replace(/^~/, os.homedir());
const results: { level: "PASS" | "WARN" | "FAIL"; what: string; detail: string }[] = [];
const pass = (what: string, detail = "") => results.push({ level: "PASS", what, detail });
const warn = (what: string, detail: string) => results.push({ level: "WARN", what, detail });
const fail = (what: string, detail: string) => results.push({ level: "FAIL", what, detail });
const xnt = (lamports: number | bigint) => `${(Number(lamports) / 1e9).toLocaleString("en-US", { maximumFractionDigits: 4 })} XNT`;

/** Mirrors MarketParams::validate in programs/accumulator/src/state.rs. */
function validate(p: Params, twap: boolean): string | null {
  const B = 10_000;
  if (!(p.maxLtvBps > 0 && p.maxLtvBps < p.liquidationThresholdBps && p.liquidationThresholdBps < B)) return "LTV / threshold order";
  if ((B + p.liquidationBonusBps) * p.liquidationThresholdBps >= B * B) return "bonus too large for the threshold";
  if (p.liquidationBonusBps > 2_000) return "bonus above 20%";
  if (p.closeFactorBps <= 0 || p.closeFactorBps > B) return "close factor";
  if (p.reserveFactorBps > 5_000) return "reserve factor above 50%";
  if (p.liquidationFeeBps > 5_000) return "liquidation fee above 50% of the bonus";
  if (p.optimalUtilizationBps <= 0 || p.optimalUtilizationBps >= B) return "kink utilization";
  if (p.maxUtilizationBps <= 0 || p.maxUtilizationBps > B) return "max utilization";
  if (p.baseRateBps + p.slope1Bps + p.slope2Bps > 100_000) return "rate ceiling above 1000%";
  if (twap && (p.twapWindowSecs < 300 || p.twapWindowSecs > 1_500)) return "TWAP window outside 5-25 min";
  return null;
}

(async () => {
  const conn = new Connection(MAINNET.rpc, "confirmed");
  const acc = new AccumulatorClient(conn);
  console.log(`X1 mainnet ${MAINNET.rpc} · genesis ${await conn.getGenesisHash()}\n`);

  // ---- program address and binary
  const prog = await conn.getAccountInfo(ACCUMULATOR_PROGRAM_ID);
  if (!prog) pass("program address free", ACCUMULATOR_PROGRAM_ID.toBase58());
  else warn("program already deployed", `${ACCUMULATOR_PROGRAM_ID.toBase58()} (owner ${prog.owner.toBase58()}): this is an upgrade, not a first deploy`);

  try {
    const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(home(PROGRAM_KEYPAIR), "utf8"))));
    if (kp.publicKey.equals(ACCUMULATOR_PROGRAM_ID)) pass("program keypair matches declare_id", home(PROGRAM_KEYPAIR));
    else fail("program keypair", `${kp.publicKey.toBase58()} is not ${ACCUMULATOR_PROGRAM_ID.toBase58()}`);
  } catch (e) {
    fail("program keypair", `can't read ${home(PROGRAM_KEYPAIR)}: ${(e as Error).message}`);
  }

  let deployNeed = 0;
  if (fs.existsSync(BINARY)) {
    const bin = fs.readFileSync(BINARY);
    const testnetBin = "target/deploy-testnet/accumulator.so";
    const sameAsTestnet = fs.existsSync(testnetBin) && createHash("sha256").update(fs.readFileSync(testnetBin)).digest("hex") === createHash("sha256").update(bin).digest("hex");
    if (sameAsTestnet) fail("binary", "mainnet binary is identical to the testnet build (wrong XDEX program id)");
    const maxLen = Math.ceil(bin.length * HEADROOM);
    const programRent = await conn.getMinimumBalanceForRentExemption(maxLen + 45);
    const bufferRent = await conn.getMinimumBalanceForRentExemption(bin.length + 37);
    deployNeed = programRent + bufferRent + 0.05e9;
    pass("mainnet binary", `${BINARY}, ${bin.length} bytes, sha256 ${createHash("sha256").update(bin).digest("hex")}`);
    pass("deploy cost", `program ${xnt(programRent)} (kept, --max-len ${maxLen}) + buffer ${xnt(bufferRent)} (refunded) + fees`);
  } else fail("mainnet binary", `${BINARY} missing: cargo build-sbf --manifest-path programs/accumulator/Cargo.toml --sbf-out-dir target/deploy-mainnet`);

  // ---- launch key
  try {
    const a = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(home(ADMIN), "utf8"))));
    if (a.publicKey.equals(MAINNET.compromised)) fail("admin key", "this is the compromised DtZz… key");
    const bal = await conn.getBalance(a.publicKey);
    const marketsNeed = 0.15e9; // three markets + vaults + share mints, with margin
    const need = deployNeed + marketsNeed;
    (bal >= need ? pass : fail)("launch key funded", `${a.publicKey.toBase58()} has ${xnt(bal)}, needs about ${xnt(need)}`);
  } catch (e) {
    fail("admin key", `can't read ${home(ADMIN)}: ${(e as Error).message}`);
  }

  // ---- treasury
  if (PublicKey.isOnCurve(MAINNET.treasury.toBytes())) pass("treasury is a wallet address", MAINNET.treasury.toBase58());
  else fail("treasury", "not an on-curve wallet address");

  // ---- config / markets not yet created
  const cfg = await conn.getAccountInfo(configPda());
  (cfg ? warn : pass)("config", cfg ? "already exists: skip `launch init`" : `${configPda().toBase58()} not created yet`);
  for (const d of Object.values(MAINNET_MARKETS)) {
    const info = await conn.getAccountInfo(d.address);
    (info ? warn : pass)(`market ${d.name}`, info ? "already exists" : `${d.address.toBase58()} not created yet`);
    const err = validate(d.params, d.oracleKind === "xdexTwap");
    (err ? fail : pass)(`params ${d.name}`, err ?? `LTV ${d.params.maxLtvBps / 100}% / liq ${d.params.liquidationThresholdBps / 100}% / bonus ${d.params.liquidationBonusBps / 100}% (protocol ${d.params.liquidationFeeBps / 100}% of it) / kink ${d.params.optimalUtilizationBps / 100}% at ${(d.params.baseRateBps + d.params.slope1Bps) / 100}%`);
  }

  // ---- stake pools (price pXNT and rXNT)
  const epoch = (await conn.getEpochInfo()).epoch;
  for (const d of Object.values(MAINNET_MARKETS).filter((x) => x.oracleKind === "stakePool")) {
    const addr = d.oracleAccounts[0];
    const sp = await conn.getAccountInfo(addr);
    if (!sp || !sp.owner.equals(X1_STAKE_POOL_PROGRAM_ID)) {
      fail(`${d.collateralSymbol} stake pool`, `${addr.toBase58()} missing or not owned by the X1 stake pool program`);
      continue;
    }
    const p = await fetchStakePool(conn, addr);
    if (!p.mint.equals(d.collateralMint)) fail(`${d.collateralSymbol} stake pool mint`, p.mint.toBase58());
    if (!p.tokenProgram.equals(d.collateralTokenProgram)) fail(`${d.collateralSymbol} token program`, `pool uses ${p.tokenProgram.toBase58()}, market expects ${d.collateralTokenProgram.toBase58()}`);
    (p.lastUpdateEpoch >= epoch ? pass : warn)(`${d.collateralSymbol} pool updated this epoch`, `last update ${p.lastUpdateEpoch}, epoch ${epoch}`);
    pass(`${d.collateralSymbol} pool`, `1 ${d.collateralSymbol} = ${(Number(p.totalLamports) / Number(p.supply)).toFixed(6)} XNT, ${xnt(p.totalLamports)} staked, deposit fee ${p.solDepositFee * 100}%, withdrawal fee ${p.solWithdrawalFee * 100}%`);
    const reserve = await conn.getBalance(p.reserve);
    const cap = Number(d.params.depositCap);
    (reserve > cap * 5 ? pass : warn)(`${d.collateralSymbol} pool reserve (instant unstake)`, `${xnt(reserve)} vs market deposit cap ${xnt(cap)}`);
    const apy = await estimateStakingApy(conn, addr);
    const kink = (d.params.baseRateBps + d.params.slope1Bps) / 10_000;
    if (apy !== null)
      (apy > kink ? pass : warn)(`${d.collateralSymbol} loop economics`, `staking ~${(apy * 100).toFixed(2)}% vs borrow rate ${(kink * 100).toFixed(1)}% at the kink`);
    const mint = await getMint(conn, d.collateralMint, "confirmed", d.collateralTokenProgram).catch(() => null);
    if (!mint) fail(`${d.collateralSymbol} mint`, "not found");
    else {
      const ext = d.collateralTokenProgram.equals(TOKEN_2022_PROGRAM_ID) ? getExtensionTypes(mint.tlvData) : [];
      const bad = ext.filter((e) => e !== ExtensionType.MetadataPointer && e !== ExtensionType.TokenMetadata);
      (bad.length ? fail : pass)(`${d.collateralSymbol} mint`, bad.length ? `program will refuse: ${bad.map((e) => ExtensionType[e]).join(", ")}` : `${mint.decimals} decimals, extensions: ${ext.map((e) => ExtensionType[e]).join(", ") || "none"}`);
      if (mint.decimals !== d.collateralDecimals) fail(`${d.collateralSymbol} decimals`, `mint ${mint.decimals}, SDK ${d.collateralDecimals}`);
      (mint.freezeAuthority ? warn : pass)(`${d.collateralSymbol} freeze authority`, mint.freezeAuthority?.toBase58() ?? "none");
    }
  }

  // ---- mints
  const usdc = await getMint(conn, MAINNET.usdcxMint, "confirmed", TOKEN_2022_PROGRAM_ID).catch(() => null);
  if (!usdc) fail("USDC.x mint", "not found under Token-2022");
  else {
    (usdc.decimals === MAINNET_MARKETS.usdcXnt.lendDecimals ? pass : fail)("USDC.x decimals", `mint ${usdc.decimals}, SDK ${MAINNET_MARKETS.usdcXnt.lendDecimals}`);
    const ext = getExtensionTypes(usdc.tlvData);
    const bad = ext.filter((e) => e !== ExtensionType.MetadataPointer && e !== ExtensionType.TokenMetadata);
    (bad.length ? fail : pass)("USDC.x extensions", bad.length ? `program will refuse: ${bad.map((e) => ExtensionType[e]).join(", ")}` : ext.map((e) => ExtensionType[e]).join(", ") || "none");
    (usdc.freezeAuthority ? warn : pass)("USDC.x freeze authority", usdc.freezeAuthority ? `${usdc.freezeAuthority.toBase58()} can freeze accounts, including market vaults (bridge risk)` : "none");
  }

  // ---- XDEX price for USDC.x / XNT
  const u = MAINNET_MARKETS.usdcXnt;
  const pool = await conn.getAccountInfo(MAINNET.xdexXntUsdc.pool);
  if (!pool || !pool.owner.equals(XDEX_MAINNET)) fail("XDEX pool", "missing or not owned by the mainnet XDEX program");
  else {
    try {
      const fake = { ...u } as unknown as Market;
      const b = await acc.readPrice(fake, "borrow");
      const l = await acc.readPrice(fake, "liquidate");
      const toUsd = (w: bigint) => (Number(w) / 1e18) * 1e3;
      pass("XDEX TWAP readable", `borrow price $${toUsd(b).toFixed(4)}, liquidation price (20-min TWAP) $${toUsd(l).toFixed(4)}`);
      const v1 = await conn.getTokenAccountBalance(MAINNET.xdexXntUsdc.vault1);
      const depth = Number(v1.value.uiAmount ?? 0);
      const capUsd = Number(u.params.borrowCap) / 1e6;
      (capUsd <= depth * 2 ? pass : warn)("USDC borrow cap vs XDEX depth", `cap $${capUsd.toLocaleString()} vs $${depth.toLocaleString()} USDC.x in the pool (keep cap under ~2x depth)`);
    } catch (e) {
      fail("XDEX TWAP", (e as Error).message);
    }
  }

  // ---- report
  console.log(results.map((r) => `${r.level.padEnd(4)}  ${r.what}${r.detail ? ` — ${r.detail}` : ""}`).join("\n"));
  const f = results.filter((r) => r.level === "FAIL").length;
  const w = results.filter((r) => r.level === "WARN").length;
  console.log(`\n${f} fail, ${w} warn, ${results.length - f - w} pass`);
  process.exit(f ? 1 : 0);
})();

//! Runs the program against real X1 mainnet accounts (snapshot in
//! fixtures/mainnet.json, refresh with `npx ts-node scripts/fetch-fixtures.ts`):
//! the X1 stake pool, the XDEX XNT/USDC.x pool with its price history, and the
//! real pXNT / USDC.x mints.
#![allow(deprecated)]

mod common;

use base64::Engine;
use common::*;
use accumulator::constants::{NATIVE_MINT, WAD};
use accumulator::math::collateral_value;
use accumulator::oracle::{parse_observations, parse_xdex_pool, spot_q32, stake_pool_price, twap_wad};
use accumulator::state::{MarketParams, OracleKind};
use solana_sdk::{account::Account, pubkey::Pubkey, signature::Signer};
use std::str::FromStr;

struct Fixture {
    now: i64,
    keys: std::collections::HashMap<String, Pubkey>,
}

fn load(h: &mut H) -> Fixture {
    let raw = std::fs::read_to_string("fixtures/mainnet.json").expect("run scripts/fetch-fixtures.ts first");
    let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let mut keys = std::collections::HashMap::new();
    for (name, a) in v["accounts"].as_object().unwrap() {
        let pk = Pubkey::from_str(a["pubkey"].as_str().unwrap()).unwrap();
        let data = base64::engine::general_purpose::STANDARD.decode(a["data"].as_str().unwrap()).unwrap();
        h.svm
            .set_account(pk, Account {
                lamports: a["lamports"].as_u64().unwrap(),
                data,
                owner: Pubkey::from_str(a["owner"].as_str().unwrap()).unwrap(),
                executable: false,
                rent_epoch: 0,
            })
            .unwrap();
        keys.insert(name.clone(), pk);
    }
    let now = v["unix_timestamp"].as_i64().unwrap();
    h.set_time(now);
    Fixture { now, keys }
}

fn usdc_params() -> MarketParams {
    MarketParams {
        max_ltv_bps: 5_000,
        liquidation_threshold_bps: 6_500,
        liquidation_bonus_bps: 500,
        close_factor_bps: 5_000,
        reserve_factor_bps: 1_000,
        optimal_utilization_bps: 8_000,
        max_utilization_bps: 9_000,
        base_rate_bps: 0,
        slope1_bps: 800,
        slope2_bps: 20_000,
        deposit_cap: 10_000 * USD,
        borrow_cap: 1_000 * USD,
        max_borrow_per_obligation: 250 * USD,
        dust_debt: USD,
        twap_window_secs: 1_200,
        liquidation_fee_bps: 1_000,
    }
}

#[test]
fn both_launch_markets_on_real_mainnet_accounts() {
    let mut h = H::new();
    let f = load(&mut h);
    let k = |n: &str| f.keys[n];
    let admin = h.payer.insecure_clone();
    h.must(&[h.ix_init_config(&admin.pubkey(), 172_800)], &[&admin]);

    // ---------------------------------------------- XNT / pXNT (stake pool)
    let pxnt = k("pxnt_mint");
    let rate = stake_pool_price(&h.svm.get_account(&k("stake_pool")).unwrap().data, &pxnt).unwrap();
    let r = rate as f64 / WAD as f64;
    println!("pXNT -> XNT rate: {r:.6}");
    assert!(r > 0.9 && r < 1.2, "rate {r}");

    let mut p = MarketParams { twap_window_secs: 0, ..usdc_params() };
    p.max_ltv_bps = 8_000;
    p.liquidation_threshold_bps = 8_500;
    p.liquidation_bonus_bps = 200;
    p.deposit_cap = 500_000 * XNT;
    p.borrow_cap = 400_000 * XNT;
    p.max_borrow_per_obligation = 100_000 * XNT;
    p.dust_debt = XNT / 100;
    let ix = h.ix_create_market(&admin.pubkey(), NATIVE_MINT, pxnt, TOKEN, TOKEN, p, OracleKind::StakePool, false, &[k("stake_pool")]);
    h.must(&[ix], &[&admin]);
    let m1 = market_pda(&NATIVE_MINT, &pxnt);

    let lender = h.user(10_000 * XNT);
    let lx = h.wrap(&lender, 1_000 * XNT);
    let sm = h.market(&m1).share_mint;
    let ls = h.ata(&lender.pubkey(), &sm, TOKEN);
    h.must(&[h.ix_deposit(&m1, &lender.pubkey(), lx, ls, 1_000 * XNT)], &[&lender]);

    let borrower = h.user(10_000 * XNT);
    // real pXNT mint: give the borrower a balance directly
    let bp = Pubkey::new_unique();
    h.set_token_account(bp, pxnt, borrower.pubkey(), 100 * XNT, TOKEN);
    let bx = h.ata(&borrower.pubkey(), &NATIVE_MINT, TOKEN);
    h.must(&[h.ix_open(&m1, &borrower.pubkey()), h.ix_deposit_collateral(&m1, &borrower.pubkey(), bp, 100 * XNT)], &[&borrower]);
    let limit = (collateral_value(100 * XNT as u128, rate).unwrap() * 8_000 / 10_000) as u64;
    let ix = h.ix_borrow(&m1, &borrower.pubkey(), bx, limit + 1);
    h.fails(&[ix], &[&borrower], "BorrowLimitExceeded");
    h.must(&[h.ix_borrow(&m1, &borrower.pubkey(), bx, limit)], &[&borrower]);
    println!("100 pXNT borrows up to {:.4} XNT", limit as f64 / 1e9);

    // ----------------------------------------- USDC.x / XNT (XDEX TWAP)
    let usdc = k("usdcx_mint");
    let pool = h.svm.get_account(&k("xdex_pool")).unwrap();
    let info = parse_xdex_pool(&pool.data).unwrap();
    assert_eq!(info.mint_0, NATIVE_MINT);
    assert_eq!(info.mint_1, usdc);
    let obs = h.svm.get_account(&k("xdex_observation")).unwrap();
    let (idx, list) = parse_observations(&obs.data, &k("xdex_pool")).unwrap();
    let a0 = h.balance(&k("xdex_vault0")) - info.fees_0;
    let a1 = h.balance(&k("xdex_vault1")) - info.fees_1;
    let (s0, s1) = spot_q32(a0, a1).unwrap();
    let twap = twap_wad(idx, &list, s0, s1, f.now as u64, 1_200, true).unwrap();
    let spot = (s0 * WAD) >> 32;
    let usd = |w: u128| w as f64 / WAD as f64 * 1e3;
    println!("XNT on XDEX: 20-min TWAP ${:.4}, spot ${:.4}", usd(twap), usd(spot));
    assert!(usd(twap) > 0.01 && usd(twap) < 10.0);

    let accts = [k("xdex_pool"), k("xdex_observation"), k("xdex_vault0"), k("xdex_vault1")];
    let ix = h.ix_create_market(&admin.pubkey(), usdc, NATIVE_MINT, TOKEN22, TOKEN, usdc_params(), OracleKind::XdexTwap, true, &accts);
    h.must(&[ix], &[&admin]);
    let m2 = market_pda(&usdc, &NATIVE_MINT);

    let lu = Pubkey::new_unique();
    h.set_token_account(lu, usdc, lender.pubkey(), 5_000 * USD, TOKEN22);
    let sm2 = h.market(&m2).share_mint;
    let ls2 = h.ata(&lender.pubkey(), &sm2, TOKEN22);
    h.must(&[h.ix_deposit(&m2, &lender.pubkey(), lu, ls2, 5_000 * USD)], &[&lender]);

    let bx2 = h.wrap(&borrower, 1_000 * XNT);
    let bu = h.ata(&borrower.pubkey(), &usdc, TOKEN22);
    h.must(&[h.ix_open(&m2, &borrower.pubkey()), h.ix_deposit_collateral(&m2, &borrower.pubkey(), bx2, 1_000 * XNT)], &[&borrower]);
    let price = twap.min(spot);
    let limit = (collateral_value(1_000 * XNT as u128, price).unwrap() * 5_000 / 10_000) as u64;
    let ix = h.ix_borrow(&m2, &borrower.pubkey(), bu, limit + 1);
    h.fails(&[ix], &[&borrower], "BorrowLimitExceeded");
    h.must(&[h.ix_borrow(&m2, &borrower.pubkey(), bu, limit)], &[&borrower]);
    println!("1,000 XNT borrows up to ${:.2} USDC.x", limit as f64 / 1e6);

    // per-account cap from the launch params ($250) applies
    let big = h.user(100_000 * XNT);
    let bigx = h.wrap(&big, 50_000 * XNT);
    let bigu = h.ata(&big.pubkey(), &usdc, TOKEN22);
    h.must(&[h.ix_open(&m2, &big.pubkey()), h.ix_deposit_collateral(&m2, &big.pubkey(), bigx, 50_000 * XNT)], &[&big]);
    let ix = h.ix_borrow(&m2, &big.pubkey(), bigu, 251 * USD);
    h.fails(&[ix], &[&big], "AccountBorrowCapExceeded");

    // healthy positions can't be liquidated
    let liq = h.user(1_000 * XNT);
    let qu = Pubkey::new_unique();
    h.set_token_account(qu, usdc, liq.pubkey(), 100 * USD, TOKEN22);
    let qx = h.ata(&liq.pubkey(), &NATIVE_MINT, TOKEN);
    let ix = h.ix_liquidate(&m2, &borrower.pubkey(), &liq.pubkey(), qu, qx, 10 * USD, 0);
    h.fails(&[ix], &[&liq], "PositionHealthy");
}

/// XNT / rXNT on the real Ripper Pool account and the real rXNT mint (Token-2022 collateral):
/// borrow to the limit, a pool loss triggers a liquidation that pays the liquidator in rXNT
/// minus the protocol's share, and that share reaches the treasury.
#[test]
fn rxnt_market_on_real_mainnet_accounts() {
    use accumulator::math::{liquidation_fee, max_liquidation_repay, seize_for_repay};
    let mut h = H::new();
    let f = load(&mut h);
    let k = |n: &str| f.keys[n];
    let admin = h.payer.insecure_clone();
    h.must(&[h.ix_init_config(&admin.pubkey(), 172_800)], &[&admin]);

    let pool = k("ripper_pool");
    let rxnt = k("rxnt_mint");
    let rate = stake_pool_price(&h.svm.get_account(&pool).unwrap().data, &rxnt).unwrap();
    println!("rXNT -> XNT rate: {:.6}", rate as f64 / WAD as f64);
    assert!(rate > WAD && rate < 2 * WAD);

    // sdk/src/markets.ts XNT_RXNT_PARAMS
    let mut p = MarketParams { twap_window_secs: 0, ..usdc_params() };
    p.max_ltv_bps = 7_500;
    p.liquidation_threshold_bps = 8_200;
    p.liquidation_bonus_bps = 300;
    p.optimal_utilization_bps = 8_500;
    p.max_utilization_bps = 9_500;
    p.slope1_bps = 400;
    p.slope2_bps = 10_000;
    p.deposit_cap = 50_000 * XNT;
    p.borrow_cap = 40_000 * XNT;
    p.max_borrow_per_obligation = 10_000 * XNT;
    p.dust_debt = XNT / 100;
    let ix = h.ix_create_market(&admin.pubkey(), NATIVE_MINT, rxnt, TOKEN, TOKEN22, p, OracleKind::StakePool, false, &[pool]);
    h.must(&[ix], &[&admin]);
    let m = market_pda(&NATIVE_MINT, &rxnt);

    let lender = h.user(20_000 * XNT);
    let lx = h.wrap(&lender, 10_000 * XNT);
    let sm = h.market(&m).share_mint;
    let ls = h.ata(&lender.pubkey(), &sm, TOKEN);
    h.must(&[h.ix_deposit(&m, &lender.pubkey(), lx, ls, 10_000 * XNT)], &[&lender]);

    let borrower = h.user(10 * XNT);
    let br = Pubkey::new_unique();
    h.set_token_account(br, rxnt, borrower.pubkey(), 1_000 * XNT, TOKEN22);
    let bx = h.ata(&borrower.pubkey(), &NATIVE_MINT, TOKEN);
    h.must(&[h.ix_open(&m, &borrower.pubkey()), h.ix_deposit_collateral(&m, &borrower.pubkey(), br, 1_000 * XNT)], &[&borrower]);
    let limit = (collateral_value(1_000 * XNT as u128, rate).unwrap() * 7_500 / 10_000) as u64;
    let ix = h.ix_borrow(&m, &borrower.pubkey(), bx, limit + 1);
    h.fails(&[ix], &[&borrower], "BorrowLimitExceeded");
    h.must(&[h.ix_borrow(&m, &borrower.pubkey(), bx, limit)], &[&borrower]);
    println!("1,000 rXNT borrows up to {:.4} XNT", limit as f64 / 1e9);

    // the pool loses 10%: the position (75% LTV) passes the 82% threshold
    let mut acc = h.svm.get_account(&pool).unwrap();
    let total = u64::from_le_bytes(acc.data[259..267].try_into().unwrap());
    acc.data[259..267].copy_from_slice(&(total / 10 * 9).to_le_bytes());
    h.svm.set_account(pool, acc).unwrap();
    let price = stake_pool_price(&h.svm.get_account(&pool).unwrap().data, &rxnt).unwrap();

    let liq = h.user(10 * XNT);
    let qx = h.wrap(&liq, 5 * XNT);
    let mut qa = h.svm.get_account(&qx).unwrap();
    qa.data[64..72].copy_from_slice(&(2_000 * XNT).to_le_bytes()); // give the liquidator wrapped XNT
    qa.lamports += 2_000 * XNT;
    h.svm.set_account(qx, qa).unwrap();
    let qr = Pubkey::new_unique();
    h.set_token_account(qr, rxnt, liq.pubkey(), 0, TOKEN22);
    let mk = h.market(&m);
    let ob = h.obligation(&m, &borrower.pubkey());
    let debt = mk.debt_of(ob.borrow_scaled).unwrap();
    let repay = max_liquidation_repay(debt, collateral_value(ob.collateral as u128, price).unwrap(), &mk.params).unwrap();
    let seize = seize_for_repay(repay, price, 300).unwrap();
    let fee = liquidation_fee(seize, 300, 1_000).unwrap();
    h.must(&[h.ix_liquidate(&m, &borrower.pubkey(), &liq.pubkey(), qx, qr, debt as u64, 0)], &[&liq]);
    assert_eq!(h.balance(&qr) as u128, seize - fee);
    assert_eq!(h.market(&m).protocol_collateral_fees as u128, fee);
    println!("liquidation: repaid {:.4} XNT, liquidator got {:.4} rXNT, protocol {:.4} rXNT", repay as f64 / 1e9, (seize - fee) as f64 / 1e9, fee as f64 / 1e9);

    // the fee goes to the treasury's Token-2022 rXNT account
    let treasury = Pubkey::new_unique();
    h.must(&[h.ix_set_treasury(&admin.pubkey(), treasury)], &[&admin]);
    let tr = Pubkey::new_unique();
    h.set_token_account(tr, rxnt, treasury, 0, TOKEN22);
    let mk = h.market(&m);
    h.must(&[h.ix_collect_collateral_fees(&mk, &m, tr)], &[&liq]);
    assert_eq!(h.balance(&tr) as u128, fee);

    // borrower repays the rest and takes the remaining rXNT home
    let ob = h.obligation(&m, &borrower.pubkey());
    let rest = h.market(&m).debt_of(ob.borrow_scaled).unwrap() as u64;
    h.svm.airdrop(&borrower.pubkey(), rest + XNT).unwrap();
    let bx = h.wrap(&borrower, rest + 1);
    h.must(&[h.ix_repay(&m, &borrower.pubkey(), &borrower.pubkey(), bx, u64::MAX)], &[&borrower]);
    let left = h.obligation(&m, &borrower.pubkey()).collateral;
    h.must(&[h.ix_withdraw_collateral(&m, &borrower.pubkey(), br, left, false)], &[&borrower]);
    assert_eq!(h.balance(&br), left);
}

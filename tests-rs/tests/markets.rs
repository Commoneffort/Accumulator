//! End-to-end tests of the compiled program for both launch market types.

#![allow(deprecated)]

mod common;

use common::*;
use accumulator::constants::{NATIVE_MINT, WAD};
use accumulator::math::{collateral_value, liquidation_fee, max_liquidation_repay, seize_for_repay};
use accumulator::state::{Market, MarketParams, OracleKind};

fn lender_assets_of(m: &Market) -> u128 {
    m.lender_assets().unwrap()
}
use solana_sdk::{pubkey::Pubkey, signature::Signer, system_instruction};

/// Mirrors sdk/src/markets.ts XNT_PXNT_PARAMS, with test-sized caps.
fn pxnt_params() -> MarketParams {
    MarketParams {
        max_ltv_bps: 8_000,
        liquidation_threshold_bps: 8_500,
        liquidation_bonus_bps: 200,
        close_factor_bps: 5_000,
        reserve_factor_bps: 1_000,
        optimal_utilization_bps: 8_500,
        max_utilization_bps: 9_500,
        base_rate_bps: 0,
        slope1_bps: 600,
        slope2_bps: 10_000,
        deposit_cap: 10_000 * XNT,
        borrow_cap: 5_000 * XNT,
        max_borrow_per_obligation: 2_000 * XNT,
        dust_debt: XNT / 100,
        twap_window_secs: 0,
        liquidation_fee_bps: 1_000,
    }
}

/// Mirrors sdk/src/markets.ts USDC_XNT_PARAMS, with test-sized caps.
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
        deposit_cap: 100_000 * USD,
        borrow_cap: 50_000 * USD,
        max_borrow_per_obligation: 10_000 * USD,
        dust_debt: USD,
        twap_window_secs: 1_200,
        liquidation_fee_bps: 1_000,
    }
}

struct Pxnt {
    h: H,
    pxnt: Pubkey,
    pool: Pubkey,
    m: Pubkey,
}

fn pxnt_market(params: MarketParams) -> Pxnt {
    let mut h = H::new();
    let pxnt = h.create_mint(9, TOKEN);
    let pool = Pubkey::new_unique();
    h.set_stake_pool(pool, pxnt, 1_000_000 * XNT, 1_000_000 * XNT); // 1 pXNT = 1 XNT
    let admin = h.payer.insecure_clone();
    h.must(&[h.ix_init_config(&admin.pubkey(), 3_600)], &[&admin]);
    let ix = h.ix_create_market(&admin.pubkey(), NATIVE_MINT, pxnt, TOKEN, TOKEN, params, OracleKind::StakePool, false, &[pool]);
    h.must(&[ix], &[&admin]);
    let m = market_pda(&NATIVE_MINT, &pxnt);
    Pxnt { h, pxnt, pool, m }
}

// ======================================================= market creation

#[test]
fn creation_rejects_bad_price_sources() {
    let mut h = H::new();
    let admin = h.payer.insecure_clone();
    let pxnt = h.create_mint(9, TOKEN);
    let pool = Pubkey::new_unique();
    h.set_stake_pool(pool, pxnt, XNT, XNT);
    h.must(&[h.ix_init_config(&admin.pubkey(), 3_600)], &[&admin]);
    let create = |h: &H, admin: &Pubkey, lend: Pubkey, oracle: Pubkey| {
        h.ix_create_market(admin, lend, pxnt, TOKEN, TOKEN, pxnt_params(), OracleKind::StakePool, false, &[oracle])
    };

    // stake pool for a different mint
    let other = Pubkey::new_unique();
    let other_mint = h.create_mint(9, TOKEN);
    h.set_stake_pool(other, other_mint, XNT, XNT);
    let ix = create(&h, &admin.pubkey(), NATIVE_MINT, other);
    h.fails(&[ix], &[&admin], "OracleAccountMismatch");

    // look-alike stake pool not owned by the stake pool program (claims 10 XNT per pXNT)
    let fake = Pubkey::new_unique();
    h.set_stake_pool(fake, pxnt, 10 * XNT, XNT);
    let mut acc = h.svm.get_account(&fake).unwrap();
    acc.owner = Pubkey::new_unique();
    h.svm.set_account(fake, acc).unwrap();
    let ix = create(&h, &admin.pubkey(), NATIVE_MINT, fake);
    h.fails(&[ix], &[&admin], "OracleWrongOwner");

    // stake-pool pricing only makes sense when lending native XNT
    let lend_other = h.create_mint(9, TOKEN);
    let ix = create(&h, &admin.pubkey(), lend_other, pool);
    h.fails(&[ix], &[&admin], "UnsupportedOracle");

    // only the admin creates markets
    let rando = h.user(10 * XNT);
    let ix = create(&h, &rando.pubkey(), NATIVE_MINT, pool);
    h.fails(&[ix], &[&rando], "Unauthorized");

    // unsafe params
    let mut bad = pxnt_params();
    bad.max_ltv_bps = 9_000;
    let ix = h.ix_create_market(&admin.pubkey(), NATIVE_MINT, pxnt, TOKEN, TOKEN, bad, OracleKind::StakePool, false, &[pool]);
    h.fails(&[ix], &[&admin], "InvalidParams");

    // and the good one works
    let ix = create(&h, &admin.pubkey(), NATIVE_MINT, pool);
    h.must(&[ix], &[&admin]);
    let m = h.market(&market_pda(&NATIVE_MINT, &pxnt));
    assert_eq!(m.borrow_index, WAD);
}

// ============================================================ pXNT market

#[test]
fn pxnt_market_full_cycle() {
    let Pxnt { mut h, pxnt, pool, m } = pxnt_market(pxnt_params());
    let lender = h.user(100_000 * XNT);
    let borrower = h.user(100_000 * XNT);
    let liquidator = h.user(100_000 * XNT);

    // --- lender deposits; shares 1:1 on an empty market
    let lx = h.wrap(&lender, 1_000 * XNT);
    let share_mint = h.market(&m).share_mint;
    let ls = h.ata(&lender.pubkey(), &share_mint, TOKEN);
    h.must(&[h.ix_deposit(&m, &lender.pubkey(), lx, ls, 1_000 * XNT)], &[&lender]);
    assert_eq!(h.balance(&ls), 1_000 * XNT);

    // --- deposit cap
    let whale = h.user(20_000 * XNT);
    let wx = h.wrap(&whale, 10_000 * XNT);
    let ws = h.ata(&whale.pubkey(), &share_mint, TOKEN);
    let ix = h.ix_deposit(&m, &whale.pubkey(), wx, ws, 9_001 * XNT);
    h.fails(&[ix], &[&whale], "DepositCapExceeded");

    // --- tokens sent straight to the vault don't change the share value
    let before = lender_assets_of(&h.market(&m));
    let vault = h.market(&m).liquidity_vault;
    let ix = anchor_spl::token::spl_token::instruction::transfer(&TOKEN, &wx, &vault, &whale.pubkey(), &[], 50 * XNT).unwrap();
    h.must(&[ix], &[&whale]);
    assert_eq!(lender_assets_of(&h.market(&m)), before);

    // --- borrower posts 100 pXNT, borrows 80 XNT (80% LTV)
    let bp = h.mint_to(&pxnt, &borrower.pubkey(), 100 * XNT, TOKEN);
    let bx = h.ata(&borrower.pubkey(), &NATIVE_MINT, TOKEN);
    h.must(
        &[h.ix_open(&m, &borrower.pubkey()), h.ix_deposit_collateral(&m, &borrower.pubkey(), bp, 100 * XNT)],
        &[&borrower],
    );
    h.must(&[h.ix_borrow(&m, &borrower.pubkey(), bx, 80 * XNT)], &[&borrower]);
    assert_eq!(h.balance(&bx), 80 * XNT);

    let ix = h.ix_borrow(&m, &borrower.pubkey(), bx, XNT / 10);
    h.fails(&[ix], &[&borrower], "BorrowLimitExceeded");

    // --- the wrong price account is refused
    let other = Pubkey::new_unique();
    h.set_stake_pool(other, pxnt, 2 * XNT, XNT);
    let ix = h.ix_borrow_with(&m, &borrower.pubkey(), bx, XNT, vec![solana_sdk::instruction::AccountMeta::new_readonly(other, false)]);
    h.fails(&[ix], &[&borrower], "OracleAccountMismatch");

    // --- a new epoch before the stake pool's update: new risk waits, liquidation checks don't
    h.set_epoch(7);
    h.set_stake_pool_epoch(pool, 6);
    let ix = h.ix_borrow(&m, &borrower.pubkey(), bx, XNT / 100);
    h.fails(&[ix], &[&borrower], "StakePoolNotUpdated");
    let ix = h.ix_withdraw_collateral(&m, &borrower.pubkey(), bp, XNT / 100, true);
    h.fails(&[ix], &[&borrower], "StakePoolNotUpdated");
    let qx0 = h.ata(&liquidator.pubkey(), &NATIVE_MINT, TOKEN);
    let qp0 = h.ata(&liquidator.pubkey(), &pxnt, TOKEN);
    let ix = h.ix_liquidate(&m, &borrower.pubkey(), &liquidator.pubkey(), qx0, qp0, XNT, 0);
    h.fails(&[ix], &[&liquidator], "PositionHealthy"); // reached the health check: price was read
    h.set_stake_pool_epoch(pool, 7);

    // --- collateral that backs the loan can't leave
    let ix = h.ix_withdraw_collateral(&m, &borrower.pubkey(), bp, 10 * XNT, true);
    h.fails(&[ix], &[&borrower], "BorrowLimitExceeded");

    // --- a year of interest at 8% utilization: ~0.56% APR
    h.advance(31_536_000);
    h.must(&[h.ix_accrue(&m)], &[&lender]);
    let mk = h.market(&m);
    let debt = h.debt(&m, &borrower.pubkey());
    let interest = debt - 80 * XNT as u128;
    assert!((440_000_000..460_000_000).contains(&interest), "interest {interest}");
    let fee_share = mk.protocol_fees as f64 / interest as f64;
    assert!((0.099..0.101).contains(&fee_share), "fees {fee_share}");
    assert!(lender_assets_of(&mk) > 1_000 * XNT as u128);

    // --- healthy positions can't be liquidated
    let qx = h.wrap(&liquidator, 100 * XNT);
    let qp = h.ata(&liquidator.pubkey(), &pxnt, TOKEN);
    let ix = h.ix_liquidate(&m, &borrower.pubkey(), &liquidator.pubkey(), qx, qp, 10 * XNT, 0);
    h.fails(&[ix], &[&liquidator], "PositionHealthy");

    // --- stake pool rate falls 10%: liquidation repays only enough to reach the target
    h.set_stake_pool(pool, pxnt, 900_000 * XNT, 1_000_000 * XNT);
    let price = 900_000u128 * WAD / 1_000_000;
    let mk = h.market(&m);
    let ob = h.obligation(&m, &borrower.pubkey());
    let debt = mk.debt_of(ob.borrow_scaled).unwrap();
    let value = collateral_value(ob.collateral as u128, price).unwrap();
    let expect_repay = max_liquidation_repay(debt, value, &mk.params).unwrap();
    let ix = h.ix_liquidate(&m, &borrower.pubkey(), &liquidator.pubkey(), qx, qp, 50 * XNT, 0);
    h.must(&[ix], &[&liquidator]);
    // the liquidator gets the seized collateral minus the protocol's 10% of the bonus
    let seized_total = seize_for_repay(expect_repay, price, mk.params.liquidation_bonus_bps).unwrap();
    let fee = liquidation_fee(seized_total, mk.params.liquidation_bonus_bps, mk.params.liquidation_fee_bps).unwrap();
    assert!(fee > 0);
    assert_eq!(h.balance(&qp) as u128, seized_total - fee);
    assert_eq!(h.market(&m).protocol_collateral_fees as u128, fee);
    assert_eq!(h.obligation(&m, &borrower.pubkey()).collateral as u128, 100 * XNT as u128 - seized_total);
    assert_eq!(h.balance(&qx) as u128, 100 * XNT as u128 - expect_repay);
    assert!(expect_repay < debt / 2, "stays under the close factor");
    let ob = h.obligation(&m, &borrower.pubkey());
    let ltv = h.debt(&m, &borrower.pubkey()) as f64 / collateral_value(ob.collateral as u128, price).unwrap() as f64;
    assert!((0.82..0.826).contains(&ltv), "ltv after {ltv}");
    let ix = h.ix_liquidate(&m, &borrower.pubkey(), &liquidator.pubkey(), qx, qp, 10 * XNT, 0);
    h.fails(&[ix], &[&liquidator], "PositionHealthy");

    // --- min_collateral_out protects the liquidator
    h.set_stake_pool(pool, pxnt, 850_000 * XNT, 1_000_000 * XNT);
    let ix = h.ix_liquidate(&m, &borrower.pubkey(), &liquidator.pubkey(), qx, qp, XNT, 100 * XNT);
    h.fails(&[ix], &[&liquidator], "RepayTooLarge");

    // --- rate collapses to 0.3: collateral runs out, the rest is written off
    h.set_stake_pool(pool, pxnt, 300_000 * XNT, 1_000_000 * XNT);
    let assets_before = lender_assets_of(&h.market(&m));
    for _ in 0..10 {
        if h.obligation(&m, &borrower.pubkey()).collateral == 0 {
            break;
        }
        let before = h.market(&m);
        let ix = h.ix_liquidate(&m, &borrower.pubkey(), &liquidator.pubkey(), qx, qp, 100 * XNT, 0);
        h.must(&[ix], &[&liquidator]);
        let after = h.market(&m);
        if after.cumulative_bad_debt > before.cumulative_bad_debt {
            // the liquidation that left lenders with bad debt pays the protocol nothing
            assert_eq!(after.protocol_collateral_fees, before.protocol_collateral_fees);
        }
    }
    let ob = h.obligation(&m, &borrower.pubkey());
    assert_eq!(ob.collateral, 0);
    assert_eq!(ob.borrow_scaled, 0);
    let mk = h.market(&m);
    assert!(mk.cumulative_bad_debt > 0);
    assert_eq!(mk.total_borrow_scaled, 0);
    assert_eq!(mk.protocol_fees, 0, "unclaimed fees absorb bad debt first");
    assert!(lender_assets_of(&mk) < assets_before, "lenders absorb the rest");

    // --- liquidation fees sit in the collateral vault beside borrowers' collateral
    assert_eq!(h.balance(&mk.collateral_vault), mk.total_collateral + mk.protocol_collateral_fees);
    let fees = mk.protocol_collateral_fees;
    assert!(fees > 0);
    // ...and only ever go to the treasury, which anyone may trigger
    let admin = h.payer.insecure_clone();
    let treasury = h.user(XNT);
    let to_admin = h.ata(&admin.pubkey(), &pxnt, TOKEN);
    // no treasury yet: no token account can match it
    let ix = h.ix_collect_collateral_fees(&mk, &m, to_admin);
    h.fails(&[ix], &[&admin], "ConstraintTokenOwner");
    h.must(&[h.ix_set_treasury(&admin.pubkey(), treasury.pubkey())], &[&admin]);
    let ix = h.ix_collect_collateral_fees(&mk, &m, to_admin);
    h.fails(&[ix], &[&admin], "ConstraintTokenOwner");
    let to_treasury = h.ata(&treasury.pubkey(), &pxnt, TOKEN);
    let rando = h.user(XNT);
    h.must(&[h.ix_collect_collateral_fees(&mk, &m, to_treasury)], &[&rando]);
    assert_eq!(h.balance(&to_treasury), fees);
    assert_eq!(h.market(&m).protocol_collateral_fees, 0);
    let ix = h.ix_collect_collateral_fees(&mk, &m, to_treasury);
    h.fails(&[ix], &[&rando], "InsufficientFees");

    // --- lender takes out everything that's left; share supply goes to zero
    let shares = h.balance(&ls);
    let before = h.balance(&lx);
    h.must(&[h.ix_withdraw(&m, &lender.pubkey(), lx, ls, shares)], &[&lender]);
    assert!(h.balance(&lx) > before);
    assert_eq!(h.mint_supply(&share_mint), 0);

    // --- empty position closes and returns rent
    h.must(&[h.ix_close(&m, &borrower.pubkey())], &[&borrower]);
    assert!(h.svm.get_account(&obligation_pda(&m, &borrower.pubkey())).is_none());
}

// =========================================================== market rules

#[test]
fn market_rules() {
    let mut p = pxnt_params();
    p.deposit_cap = 1_000_000 * XNT;
    p.borrow_cap = 1_000_000 * XNT;
    p.max_borrow_per_obligation = 1_000_000 * XNT;
    let Pxnt { mut h, pxnt, m, .. } = pxnt_market(p);
    let admin = h.payer.insecure_clone();
    let lender = h.user(100_000 * XNT);
    let borrower = h.user(100_000 * XNT);

    let lx = h.wrap(&lender, 1_000 * XNT);
    let share_mint = h.market(&m).share_mint;
    let ls = h.ata(&lender.pubkey(), &share_mint, TOKEN);
    h.must(&[h.ix_deposit(&m, &lender.pubkey(), lx, ls, 1_000 * XNT)], &[&lender]);
    let bp = h.mint_to(&pxnt, &borrower.pubkey(), 10_000 * XNT, TOKEN);
    let bx = h.ata(&borrower.pubkey(), &NATIVE_MINT, TOKEN);
    h.must(
        &[h.ix_open(&m, &borrower.pubkey()), h.ix_deposit_collateral(&m, &borrower.pubkey(), bp, 10_000 * XNT)],
        &[&borrower],
    );

    // --- per-account and total borrow caps (with 100 XNT out)
    h.must(&[h.ix_borrow(&m, &borrower.pubkey(), bx, 100 * XNT)], &[&borrower]);
    let mut capped = p;
    capped.max_borrow_per_obligation = 50 * XNT;
    h.must(&[h.ix_queue(&admin.pubkey(), &m, capped)], &[&admin]);
    h.advance(3_601);
    h.must(&[h.ix_apply(&m)], &[&admin]);
    let ix = h.ix_borrow(&m, &borrower.pubkey(), bx, XNT);
    h.fails(&[ix], &[&borrower], "AccountBorrowCapExceeded");
    // borrowing exactly up to the per-account cap is allowed (found in the testnet drill:
    // double rounding used to reject it)
    let room = (50 * XNT as u128 - h.debt(&m, &borrower.pubkey())) as u64;
    let other = h.user(100_000 * XNT);
    let op = h.mint_to(&pxnt, &other.pubkey(), 1_000 * XNT, TOKEN);
    let ox = h.ata(&other.pubkey(), &NATIVE_MINT, TOKEN);
    h.must(&[h.ix_open(&m, &other.pubkey()), h.ix_deposit_collateral(&m, &other.pubkey(), op, 1_000 * XNT)], &[&other]);
    h.must(&[h.ix_borrow(&m, &other.pubkey(), ox, 50 * XNT)], &[&other]);
    let ix = h.ix_borrow(&m, &other.pubkey(), ox, 1);
    h.fails(&[ix], &[&other], "AccountBorrowCapExceeded");
    h.wrap(&other, XNT); // a little extra for the interest accrued meanwhile
    h.must(&[h.ix_repay(&m, &other.pubkey(), &other.pubkey(), ox, u64::MAX)], &[&other]);
    let _ = room;
    let mut capped = p;
    capped.borrow_cap = 50 * XNT;
    h.must(&[h.ix_queue(&admin.pubkey(), &m, capped)], &[&admin]);
    h.advance(3_601);
    h.must(&[h.ix_apply(&m)], &[&admin]);
    let ix = h.ix_borrow(&m, &borrower.pubkey(), bx, XNT);
    h.fails(&[ix], &[&borrower], "BorrowCapExceeded");
    h.must(&[h.ix_queue(&admin.pubkey(), &m, p)], &[&admin]);
    h.advance(3_601);
    h.must(&[h.ix_apply(&m)], &[&admin]);

    // --- utilization is capped at 95% so lenders can exit
    let ix = h.ix_borrow(&m, &borrower.pubkey(), bx, 851 * XNT);
    h.fails(&[ix], &[&borrower], "UtilizationTooHigh");
    h.must(&[h.ix_borrow(&m, &borrower.pubkey(), bx, 849 * XNT)], &[&borrower]);

    // --- lenders can only take idle cash
    let ix = h.ix_withdraw(&m, &lender.pubkey(), lx, ls, 100 * XNT);
    h.fails(&[ix], &[&lender], "InsufficientLiquidity");
    h.must(&[h.ix_withdraw(&m, &lender.pubkey(), lx, ls, 40 * XNT)], &[&lender]);

    // --- rates jump past the kink: ~99% utilization -> ~99%/yr, ~8% over 30 days
    let index0 = h.market(&m).borrow_index;
    h.advance(86_400 * 30);
    h.must(&[h.ix_accrue(&m)], &[&lender]);
    let growth = (h.market(&m).borrow_index - index0) as f64 / WAD as f64;
    assert!((0.07..0.09).contains(&growth), "growth {growth}");

    // --- anyone can repay someone else's loan
    let friend = h.user(1_000 * XNT);
    let fx = h.wrap(&friend, 100 * XNT);
    h.must(&[h.ix_repay(&m, &borrower.pubkey(), &friend.pubkey(), fx, 10 * XNT)], &[&friend]);
    assert_eq!(h.balance(&fx), 90 * XNT);

    // --- u64::MAX repays everything exactly
    h.wrap(&borrower, 200 * XNT);
    h.must(&[h.ix_repay(&m, &borrower.pubkey(), &borrower.pubkey(), bx, u64::MAX)], &[&borrower]);
    assert_eq!(h.obligation(&m, &borrower.pubkey()).borrow_scaled, 0);
    assert_eq!(h.market(&m).total_borrow_scaled, 0);

    // --- with no debt, collateral leaves even without price accounts
    h.must(&[h.ix_withdraw_collateral(&m, &borrower.pubkey(), bp, 1_000 * XNT, false)], &[&borrower]);
    assert_eq!(h.balance(&bp), 1_000 * XNT);

    // --- timelock
    let mut next = p;
    next.max_ltv_bps = 7_000;
    h.must(&[h.ix_queue(&admin.pubkey(), &m, next)], &[&admin]);
    let ix = h.ix_apply(&m);
    h.fails(&[ix], &[&admin], "TimelockNotElapsed");
    h.advance(3_601);
    h.must(&[h.ix_apply(&m)], &[&admin]);
    assert_eq!(h.market(&m).params.max_ltv_bps, 7_000);
    h.must(&[h.ix_queue(&admin.pubkey(), &m, p), h.ix_cancel(&admin.pubkey(), &m)], &[&admin]);
    let ix = h.ix_apply(&m);
    h.fails(&[ix], &[&admin], "NothingQueued");

    let rando = h.user(10 * XNT);
    let ix = h.ix_queue(&rando.pubkey(), &m, p);
    h.fails(&[ix], &[&rando], "Unauthorized");

    // --- pause stops new borrows, not repayment
    h.must(&[h.ix_pause(&admin.pubkey(), &m, true)], &[&admin]);
    let ix = h.ix_borrow(&m, &borrower.pubkey(), bx, XNT);
    h.fails(&[ix], &[&borrower], "BorrowPaused");
    h.must(&[h.ix_pause(&admin.pubkey(), &m, false)], &[&admin]);
    h.must(&[h.ix_borrow(&m, &borrower.pubkey(), bx, XNT)], &[&borrower]);
    h.must(&[h.ix_repay(&m, &borrower.pubkey(), &borrower.pubkey(), bx, u64::MAX)], &[&borrower]);

    // --- interest fees go only to the treasury; anyone can send them, never more than accrued
    let mk = h.market(&m);
    assert!(mk.protocol_fees > 0);
    let treasury = h.user(XNT);
    h.must(&[h.ix_set_treasury(&admin.pubkey(), treasury.pubkey())], &[&admin]);
    assert_eq!(h.config().treasury, treasury.pubkey());
    let to_admin = h.ata(&admin.pubkey(), &NATIVE_MINT, TOKEN);
    let ix = h.ix_collect_fees(&mk, &m, to_admin, u64::MAX);
    h.fails(&[ix], &[&admin], "ConstraintTokenOwner");
    let to_treasury = h.ata(&treasury.pubkey(), &NATIVE_MINT, TOKEN);
    h.must(&[h.ix_collect_fees(&mk, &m, to_treasury, u64::MAX)], &[&rando]);
    assert_eq!(h.balance(&to_treasury), mk.protocol_fees);
    assert_eq!(h.market(&m).protocol_fees, 0);
    let ix = h.ix_collect_fees(&mk, &m, to_treasury, 1);
    h.fails(&[ix], &[&rando], "InsufficientFees");

    // --- changing the treasury later waits for the timelock; only the admin can ask
    let next = h.user(XNT);
    let ix = h.ix_set_treasury(&rando.pubkey(), next.pubkey());
    h.fails(&[ix], &[&rando], "Unauthorized");
    h.must(&[h.ix_set_treasury(&admin.pubkey(), next.pubkey())], &[&admin]);
    assert_eq!(h.config().treasury, treasury.pubkey(), "old treasury stays until the delay passes");
    let ix = h.ix_apply_treasury();
    h.fails(&[ix], &[&rando], "TimelockNotElapsed");
    h.advance(3_601);
    h.must(&[h.ix_apply_treasury()], &[&rando]);
    assert_eq!(h.config().treasury, next.pubkey());

    // --- two-step admin handoff
    let next_admin = h.user(10 * XNT);
    h.must(&[h.ix_propose_admin(&admin.pubkey(), next_admin.pubkey())], &[&admin]);
    let ix = h.ix_accept_admin(&rando.pubkey());
    h.fails(&[ix], &[&rando], "NotPendingAdmin");
    h.must(&[h.ix_accept_admin(&next_admin.pubkey())], &[&next_admin]);
    let ix = h.ix_pause(&admin.pubkey(), &m, true);
    h.fails(&[ix], &[&admin], "Unauthorized");
}

// ============================================================ XDEX market

#[test]
fn usdc_market_priced_by_xdex_twap() {
    let mut h = H::new();
    let admin = h.payer.insecure_clone();
    let usdc = h.create_mint(6, TOKEN22);
    // like mainnet: token 0 = XNT, token 1 = USDC.x (Token-2022)
    let x = Xdex::new(&mut h, NATIVE_MINT, usdc, TOKEN, TOKEN22);
    let m = market_pda(&usdc, &NATIVE_MINT);
    h.must(&[h.ix_init_config(&admin.pubkey(), 3_600)], &[&admin]);
    let create = |h: &H, accts: &[Pubkey], p: MarketParams| {
        h.ix_create_market(&admin.pubkey(), usdc, NATIVE_MINT, TOKEN22, TOKEN, p, OracleKind::XdexTwap, true, accts)
    };

    // --- too little price history
    x.set_history(&mut h, &[1 << 20, 1 << 20], 15);
    x.set_reserves(&mut h, 17_000 * XNT, 4_250 * USD);
    let ix = create(&h, &x.accounts(), usdc_params());
    h.fails(&[ix], &[&admin], "OracleWindowTooShort");

    // --- a pool pairing other tokens
    let other_usd = h.create_mint(6, TOKEN22);
    let other = Xdex::new(&mut h, NATIVE_MINT, other_usd, TOKEN, TOKEN22);
    other.set_flat(&mut h, 17_000 * XNT, 4_250 * USD);
    let ix = create(&h, &other.accounts(), usdc_params());
    h.fails(&[ix], &[&admin], "OracleAccountMismatch");

    // --- a vault swapped for a look-alike account
    x.set_flat(&mut h, 17_000 * XNT, 4_250 * USD);
    let fake_vault = Pubkey::new_unique();
    h.set_token_account(fake_vault, usdc, fake_vault, 1, TOKEN22);
    let mut accts = x.accounts();
    accts[3] = fake_vault;
    let ix = create(&h, &accts, usdc_params());
    h.fails(&[ix], &[&admin], "OracleAccountMismatch");

    // --- TWAP window outside 5-25 minutes
    let mut short = usdc_params();
    short.twap_window_secs = 60;
    let ix = create(&h, &x.accounts(), short);
    h.fails(&[ix], &[&admin], "InvalidParams");

    // --- created at $0.25
    h.must(&[create(&h, &x.accounts(), usdc_params())], &[&admin]);
    let base = 250u128 * WAD / 1_000_000; // $0.25 in raw units
    // XDEX's Q32 prices round down by ~1e-6
    let r = x.twap(&h, 1_200, true) as f64 / base as f64;
    assert!((r - 1.0).abs() < 1e-5, "twap ratio {r}");

    // --- lender deposits USDC.x (Token-2022)
    let lender = h.user(100 * XNT);
    let lu = h.mint_to(&usdc, &lender.pubkey(), 10_000 * USD, TOKEN22);
    let share_mint = h.market(&m).share_mint;
    let ls = h.ata(&lender.pubkey(), &share_mint, TOKEN22);
    h.must(&[h.ix_deposit(&m, &lender.pubkey(), lu, ls, 10_000 * USD)], &[&lender]);

    // --- borrower posts 10,000 XNT ($2,500), borrows to the 50% limit
    let borrower = h.user(50_000 * XNT);
    let bx = h.wrap(&borrower, 10_000 * XNT);
    let bu = h.ata(&borrower.pubkey(), &usdc, TOKEN22);
    h.must(
        &[h.ix_open(&m, &borrower.pubkey()), h.ix_deposit_collateral(&m, &borrower.pubkey(), bx, 10_000 * XNT)],
        &[&borrower],
    );
    let ix = h.ix_borrow(&m, &borrower.pubkey(), bu, 1_251 * USD);
    h.fails(&[ix], &[&borrower], "BorrowLimitExceeded");
    h.must(&[h.ix_borrow(&m, &borrower.pubkey(), bu, 1_200 * USD)], &[&borrower]);

    // --- attacker pumps spot 10x in the same block: borrow limit doesn't move
    x.set_reserves(&mut h, 5_376 * XNT, 13_440 * USD);
    let ix = h.ix_borrow(&m, &borrower.pubkey(), bu, 100 * USD);
    h.fails(&[ix], &[&borrower], "BorrowLimitExceeded");

    // --- held for 14 seconds the 10x pump still barely moves the 20-minute TWAP:
    // the unrecorded tail is held within 2% of the last recorded price (audit fix)
    h.advance(14);
    let t = x.twap(&h, 1_200, true) as f64 / base as f64;
    assert!((0.999..1.001).contains(&t), "twap ratio {t}");
    let ix = h.ix_borrow(&m, &borrower.pubkey(), bu, 200 * USD);
    h.fails(&[ix], &[&borrower], "BorrowLimitExceeded");

    // --- a sudden 99% dump can't force a liquidation, and blocks new borrows
    x.set_flat(&mut h, 17_000 * XNT, 4_250 * USD);
    x.set_reserves(&mut h, 170_000 * XNT, 425 * USD);
    let liquidator = h.user(50_000 * XNT);
    let qu = h.mint_to(&usdc, &liquidator.pubkey(), 5_000 * USD, TOKEN22);
    let qx = h.ata(&liquidator.pubkey(), &NATIVE_MINT, TOKEN);
    let ix = h.ix_liquidate(&m, &borrower.pubkey(), &liquidator.pubkey(), qu, qx, 500 * USD, 0);
    h.fails(&[ix], &[&liquidator], "PositionHealthy");
    let ix = h.ix_borrow(&m, &borrower.pubkey(), bu, USD);
    h.fails(&[ix], &[&borrower], "BorrowLimitExceeded");

    // --- a drop to $0.175 held for the whole window does allow liquidation
    x.set_flat(&mut h, 17_000 * XNT, 2_975 * USD);
    let u0 = h.balance(&qu);
    h.must(&[h.ix_liquidate(&m, &borrower.pubkey(), &liquidator.pubkey(), qu, qx, 1_000 * USD, 0)], &[&liquidator]);
    let paid = (u0 - h.balance(&qu)) as f64 / 1e6;
    let got = h.balance(&qx) as f64 / 1e9;
    // 5% bonus, of which the protocol keeps 10%: the liquidator nets 4.5%
    let bonus = got * 0.175 / paid;
    assert!((1.0435..1.0465).contains(&bonus), "bonus {bonus}");
    let ob = h.obligation(&m, &borrower.pubkey());
    let price = x.twap(&h, 1_200, true);
    let ltv = h.debt(&m, &borrower.pubkey()) as f64 / collateral_value(ob.collateral as u128, price).unwrap() as f64;
    assert!((0.56..0.58).contains(&ltv), "ltv after {ltv}");

    // --- borrower repays and leaves
    let mint_more = h.mint_to(&usdc, &borrower.pubkey(), 1_000 * USD, TOKEN22);
    assert_eq!(mint_more, bu);
    h.must(&[h.ix_repay(&m, &borrower.pubkey(), &borrower.pubkey(), bu, u64::MAX)], &[&borrower]);
    let left = h.obligation(&m, &borrower.pubkey()).collateral;
    h.must(&[h.ix_withdraw_collateral(&m, &borrower.pubkey(), bx, left, true)], &[&borrower]);
    h.must(&[h.ix_close(&m, &borrower.pubkey())], &[&borrower]);

    let _ = system_instruction::transfer; // keep import for helpers
}

// ======================================================= Token-2022 guard

#[test]
fn rejects_mints_with_transfer_fees() {
    use anchor_spl::token_2022::spl_token_2022::{extension::ExtensionType, instruction as t22};
    use anchor_spl::token_2022::spl_token_2022::extension::transfer_fee::instruction as fee_ix;
    let mut h = H::new();
    let admin = h.payer.insecure_clone();
    h.must(&[h.ix_init_config(&admin.pubkey(), 3_600)], &[&admin]);

    // a USDC look-alike that skims 1% on every transfer
    let mint = solana_sdk::signature::Keypair::new();
    let space = ExtensionType::try_calculate_account_len::<anchor_spl::token_2022::spl_token_2022::state::Mint>(&[ExtensionType::TransferFeeConfig]).unwrap();
    let rent = h.svm.minimum_balance_for_rent_exemption(space);
    h.must(
        &[
            system_instruction::create_account(&admin.pubkey(), &mint.pubkey(), rent, space as u64, &TOKEN22),
            fee_ix::initialize_transfer_fee_config(&TOKEN22, &mint.pubkey(), None, None, 100, u64::MAX).unwrap(),
            t22::initialize_mint2(&TOKEN22, &mint.pubkey(), &admin.pubkey(), None, 6).unwrap(),
        ],
        &[&admin, &mint],
    );
    let x = Xdex::new(&mut h, NATIVE_MINT, mint.pubkey(), TOKEN, TOKEN22);
    x.set_flat(&mut h, 17_000 * XNT, 4_250 * USD);
    let ix = h.ix_create_market(&admin.pubkey(), mint.pubkey(), NATIVE_MINT, TOKEN22, TOKEN, usdc_params(), OracleKind::XdexTwap, true, &x.accounts());
    h.fails(&[ix], &[&admin], "UnsupportedMint");
}

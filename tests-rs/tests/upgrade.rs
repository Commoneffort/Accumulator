//! The Oct 2026 upgrade (treasury + liquidation fee) against the real testnet
//! accounts, copied before the upgrade into fixtures/testnet-v1/ (old layout).
//! Every balance and setting must carry over exactly, and the markets must work after.

#![allow(deprecated)]

mod common;

use accumulator::legacy::{ConfigV1, MarketV1};
use accumulator::state::Market;
use anchor_lang::{AccountDeserialize, AnchorDeserialize};
use base64::Engine;
use common::*;
use solana_sdk::{account::Account, pubkey::Pubkey, signature::Signer};
use std::str::FromStr;

const MARKETS: [&str; 5] = [
    "ER6PfPaQiz8gR8vXydi1RbdDbEau1Tbb78km1MpWa9bo",
    "A9roYJiRjwEdi8N4xVx3UbFP7UmejzjXVf2AsaH5vcy1",
    "CKu81vsvJA9qyAKZBWvUmTdKywoxCrfpsR7TKRcNQE2W",
    "68XUBDZnYeS2wTPLCGBvUfSnowLHjtFHjnAvDJzNdtrz",
    "9nK8utLTxfjLv4ZW6SQ1pmgC167pDWjkJmRo6rW5f5qB",
];

fn load(h: &mut H, addr: &str) -> (Pubkey, Vec<u8>) {
    let raw = std::fs::read_to_string(format!("fixtures/testnet-v1/{addr}.json")).unwrap();
    let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let a = &v["account"];
    let data = base64::engine::general_purpose::STANDARD.decode(a["data"][0].as_str().unwrap()).unwrap();
    let key = Pubkey::from_str(addr).unwrap();
    h.svm
        .set_account(key, Account { lamports: a["lamports"].as_u64().unwrap(), data: data.clone(), owner: accumulator::ID, executable: false, rent_epoch: 0 })
        .unwrap();
    (key, data)
}

#[test]
fn testnet_accounts_migrate_without_losing_anything() {
    let mut h = H::new();
    let admin = h.payer.insecure_clone();

    // The real config, with its admin swapped for a key this test holds.
    let (cfg, mut cfg_data) = load(&mut h, "3ifjvuzn6PtQUZTGPtriiDBoRMtCyhEWBzuypmMWEmoD");
    assert_eq!(cfg, config_pda());
    cfg_data[8..40].copy_from_slice(admin.pubkey().as_ref());
    let mut acc = h.svm.get_account(&cfg).unwrap();
    acc.data = cfg_data.clone();
    h.svm.set_account(cfg, acc).unwrap();
    let old_cfg = ConfigV1::deserialize(&mut &cfg_data[8..]).unwrap();

    let markets: Vec<(Pubkey, MarketV1)> = MARKETS
        .iter()
        .map(|a| {
            let (k, d) = load(&mut h, a);
            (k, MarketV1::deserialize(&mut &d[8..]).unwrap())
        })
        .collect();

    // Old-layout markets can't be used until migrated.
    let (m0, _) = markets[0];
    let ix = h.ix_accrue(&m0);
    h.fails(&[ix], &[&admin], "AccountDidNotDeserialize");

    // Markets wait for the config; only the admin migrates.
    let ix = h.ix_migrate_market(&admin.pubkey(), &m0);
    h.fails(&[ix], &[&admin], "AccountDidNotDeserialize");
    let rando = h.user(10 * XNT);
    let ix = h.ix_migrate_config(&rando.pubkey());
    h.fails(&[ix], &[&rando], "Unauthorized");

    h.must(&[h.ix_migrate_config(&admin.pubkey())], &[&admin]);
    let c = h.config();
    assert_eq!(c.admin, admin.pubkey());
    assert_eq!(c.timelock_seconds, old_cfg.timelock_seconds);
    assert_eq!(c.market_count, old_cfg.market_count);
    assert_eq!(c.bump, old_cfg.bump);
    assert_eq!(c.treasury, Pubkey::default());
    let ix = h.ix_migrate_config(&admin.pubkey());
    h.fails(&[ix], &[&admin], "NotMigratable");

    for (k, old) in &markets {
        let ix = h.ix_migrate_market(&rando.pubkey(), k);
        h.fails(&[ix], &[&rando], "Unauthorized");
        h.must(&[h.ix_migrate_market(&admin.pubkey(), k)], &[&admin]);
        let acc = h.svm.get_account(k).unwrap();
        assert_eq!(acc.data.len(), 8 + <Market as anchor_lang::Space>::INIT_SPACE);
        assert!(acc.lamports >= h.svm.minimum_balance_for_rent_exemption(acc.data.len()));
        let m = Market::try_deserialize(&mut acc.data.as_slice()).unwrap();
        assert_eq!(m.config, old.config);
        assert_eq!(m.lend_mint, old.lend_mint);
        assert_eq!(m.collateral_mint, old.collateral_mint);
        assert_eq!(m.liquidity_vault, old.liquidity_vault);
        assert_eq!(m.collateral_vault, old.collateral_vault);
        assert_eq!(m.share_mint, old.share_mint);
        assert_eq!(m.oracle_kind, old.oracle_kind);
        assert_eq!(m.oracle_accounts, old.oracle_accounts);
        assert_eq!(m.collateral_is_token0, old.collateral_is_token0);
        assert_eq!(m.params.max_ltv_bps, old.params.max_ltv_bps);
        assert_eq!(m.params.liquidation_threshold_bps, old.params.liquidation_threshold_bps);
        assert_eq!(m.params.liquidation_bonus_bps, old.params.liquidation_bonus_bps);
        assert_eq!(m.params.reserve_factor_bps, old.params.reserve_factor_bps);
        assert_eq!(m.params.slope2_bps, old.params.slope2_bps);
        assert_eq!(m.params.borrow_cap, old.params.borrow_cap);
        assert_eq!(m.params.max_borrow_per_obligation, old.params.max_borrow_per_obligation);
        assert_eq!(m.params.twap_window_secs, old.params.twap_window_secs);
        assert_eq!(m.params.liquidation_fee_bps, 0, "new fee starts off; raising it goes through the timelock");
        assert_eq!(m.pending_eta, old.pending_eta);
        assert_eq!(m.has_pending, old.has_pending);
        assert_eq!(m.borrow_paused, old.borrow_paused);
        assert_eq!(m.cash, old.cash);
        assert_eq!(m.total_borrow_scaled, old.total_borrow_scaled);
        assert_eq!(m.borrow_index, old.borrow_index);
        assert_eq!(m.protocol_fees, old.protocol_fees);
        assert_eq!(m.last_accrual_ts, old.last_accrual_ts);
        assert_eq!(m.total_collateral, old.total_collateral);
        assert_eq!(m.cumulative_bad_debt, old.cumulative_bad_debt);
        assert_eq!((m.bump, m.liquidity_vault_bump, m.collateral_vault_bump, m.share_mint_bump),
                   (old.bump, old.liquidity_vault_bump, old.collateral_vault_bump, old.share_mint_bump));
        assert_eq!(m.protocol_collateral_fees, 0);
        let ix = h.ix_migrate_market(&admin.pubkey(), k);
        h.fails(&[ix], &[&admin], "NotMigratable");
    }

    // Migrated markets work again: interest accrues on the real XNT market's debt.
    let before = h.market(&m0);
    h.advance(86_400);
    h.must(&[h.ix_accrue(&m0)], &[&admin]);
    let after = h.market(&m0);
    if before.total_borrow_scaled > 0 {
        assert!(after.borrow_index > before.borrow_index);
        assert!(after.protocol_fees > before.protocol_fees);
    }
}

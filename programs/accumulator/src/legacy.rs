//! Account layouts from before the treasury and liquidation-fee upgrade
//! (Oct 2026), kept only so `migrate_config` / `migrate_market` can read
//! accounts created by the first testnet deploy.

use anchor_lang::prelude::*;

use crate::state::{Config, Market, MarketParams, OracleKind};

#[derive(AnchorDeserialize, InitSpace)]
pub struct ConfigV1 {
    pub admin: Pubkey,
    pub pending_admin: Pubkey,
    pub timelock_seconds: i64,
    pub market_count: u64,
    pub bump: u8,
}

#[derive(AnchorDeserialize, Clone, Copy, InitSpace)]
pub struct MarketParamsV1 {
    pub max_ltv_bps: u16,
    pub liquidation_threshold_bps: u16,
    pub liquidation_bonus_bps: u16,
    pub close_factor_bps: u16,
    pub reserve_factor_bps: u16,
    pub optimal_utilization_bps: u16,
    pub max_utilization_bps: u16,
    pub base_rate_bps: u32,
    pub slope1_bps: u32,
    pub slope2_bps: u32,
    pub deposit_cap: u64,
    pub borrow_cap: u64,
    pub max_borrow_per_obligation: u64,
    pub dust_debt: u64,
    pub twap_window_secs: u32,
}

#[derive(AnchorDeserialize, InitSpace)]
pub struct MarketV1 {
    pub config: Pubkey,
    pub lend_mint: Pubkey,
    pub lend_token_program: Pubkey,
    pub lend_decimals: u8,
    pub collateral_mint: Pubkey,
    pub collateral_token_program: Pubkey,
    pub collateral_decimals: u8,
    pub liquidity_vault: Pubkey,
    pub collateral_vault: Pubkey,
    pub share_mint: Pubkey,
    pub oracle_kind: OracleKind,
    pub oracle_accounts: [Pubkey; 4],
    pub collateral_is_token0: bool,
    pub params: MarketParamsV1,
    pub pending_params: MarketParamsV1,
    pub pending_eta: i64,
    pub has_pending: bool,
    pub borrow_paused: bool,
    pub cash: u64,
    pub total_borrow_scaled: u128,
    pub borrow_index: u128,
    pub protocol_fees: u64,
    pub last_accrual_ts: i64,
    pub total_collateral: u64,
    pub cumulative_bad_debt: u64,
    pub bump: u8,
    pub liquidity_vault_bump: u8,
    pub collateral_vault_bump: u8,
    pub share_mint_bump: u8,
}

impl MarketParamsV1 {
    /// Old settings carry over unchanged; the new liquidation fee starts at 0
    /// and can only be raised through the timelock.
    fn upgrade(self) -> MarketParams {
        MarketParams {
            max_ltv_bps: self.max_ltv_bps,
            liquidation_threshold_bps: self.liquidation_threshold_bps,
            liquidation_bonus_bps: self.liquidation_bonus_bps,
            close_factor_bps: self.close_factor_bps,
            reserve_factor_bps: self.reserve_factor_bps,
            optimal_utilization_bps: self.optimal_utilization_bps,
            max_utilization_bps: self.max_utilization_bps,
            base_rate_bps: self.base_rate_bps,
            slope1_bps: self.slope1_bps,
            slope2_bps: self.slope2_bps,
            deposit_cap: self.deposit_cap,
            borrow_cap: self.borrow_cap,
            max_borrow_per_obligation: self.max_borrow_per_obligation,
            dust_debt: self.dust_debt,
            twap_window_secs: self.twap_window_secs,
            liquidation_fee_bps: 0,
        }
    }
}

impl ConfigV1 {
    pub fn upgrade(self) -> Config {
        Config {
            admin: self.admin,
            pending_admin: self.pending_admin,
            timelock_seconds: self.timelock_seconds,
            market_count: self.market_count,
            bump: self.bump,
            treasury: Pubkey::default(),
            pending_treasury: Pubkey::default(),
            treasury_eta: 0,
        }
    }
}

impl MarketV1 {
    pub fn upgrade(self) -> Market {
        Market {
            config: self.config,
            lend_mint: self.lend_mint,
            lend_token_program: self.lend_token_program,
            lend_decimals: self.lend_decimals,
            collateral_mint: self.collateral_mint,
            collateral_token_program: self.collateral_token_program,
            collateral_decimals: self.collateral_decimals,
            liquidity_vault: self.liquidity_vault,
            collateral_vault: self.collateral_vault,
            share_mint: self.share_mint,
            oracle_kind: self.oracle_kind,
            oracle_accounts: self.oracle_accounts,
            collateral_is_token0: self.collateral_is_token0,
            params: self.params.upgrade(),
            pending_params: self.pending_params.upgrade(),
            pending_eta: self.pending_eta,
            has_pending: self.has_pending,
            borrow_paused: self.borrow_paused,
            cash: self.cash,
            total_borrow_scaled: self.total_borrow_scaled,
            borrow_index: self.borrow_index,
            protocol_fees: self.protocol_fees,
            last_accrual_ts: self.last_accrual_ts,
            total_collateral: self.total_collateral,
            cumulative_bad_debt: self.cumulative_bad_debt,
            bump: self.bump,
            liquidity_vault_bump: self.liquidity_vault_bump,
            collateral_vault_bump: self.collateral_vault_bump,
            share_mint_bump: self.share_mint_bump,
            protocol_collateral_fees: 0,
        }
    }
}

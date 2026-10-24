use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::AccumulatorError;

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub pending_admin: Pubkey,
    /// Delay before queued risk changes can be applied. Fixed at init.
    pub timelock_seconds: i64,
    pub market_count: u64,
    pub bump: u8,
    /// Owner of the token accounts protocol fees are paid to. Default = not set yet.
    pub treasury: Pubkey,
    /// A treasury change waiting for the timelock. Default = none.
    pub pending_treasury: Pubkey,
    pub treasury_eta: i64,
}

/// Risk and rate settings for one market. All bps values are out of 10_000.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub struct MarketParams {
    /// Borrow limit: debt may not exceed this share of collateral value.
    pub max_ltv_bps: u16,
    /// Liquidation starts when debt exceeds this share of collateral value.
    pub liquidation_threshold_bps: u16,
    /// Extra collateral a liquidator receives, on top of the debt repaid.
    pub liquidation_bonus_bps: u16,
    /// Most of a position's debt one liquidation may repay.
    pub close_factor_bps: u16,
    /// Share of interest kept as protocol fees.
    pub reserve_factor_bps: u16,
    /// Utilization where the rate curve steepens.
    pub optimal_utilization_bps: u16,
    /// Borrows may not push utilization above this.
    pub max_utilization_bps: u16,
    /// Annual rate at 0% utilization.
    pub base_rate_bps: u32,
    /// Added annual rate from 0% to optimal utilization.
    pub slope1_bps: u32,
    /// Added annual rate from optimal to 100% utilization.
    pub slope2_bps: u32,
    /// Max total lender assets (lend token raw units).
    pub deposit_cap: u64,
    /// Max total borrows (lend token raw units).
    pub borrow_cap: u64,
    /// Max debt of one position (lend token raw units).
    pub max_borrow_per_obligation: u64,
    /// Positions with debt at or under this may be liquidated in full.
    pub dust_debt: u64,
    /// XDEX TWAP window in seconds (ignored for stake pool markets).
    pub twap_window_secs: u32,
    /// Share of each liquidation bonus kept by the protocol (paid in collateral).
    pub liquidation_fee_bps: u16,
}

impl MarketParams {
    pub fn validate(&self) -> Result<()> {
        let ltv = self.max_ltv_bps as u128;
        let liq = self.liquidation_threshold_bps as u128;
        let bonus = self.liquidation_bonus_bps as u128;
        require!(ltv > 0 && ltv < liq && liq < BPS, AccumulatorError::InvalidParams);
        // After a liquidation at the bonus the position must end up safer, and
        // restoring it to max LTV must be possible: (1 + bonus) * ltv < 1.
        require!((BPS + bonus) * ltv < BPS * BPS, AccumulatorError::InvalidParams);
        require!((BPS + bonus) * liq < BPS * BPS, AccumulatorError::InvalidParams);
        require!(bonus <= 2_000, AccumulatorError::InvalidParams);
        require!(
            self.close_factor_bps > 0 && self.close_factor_bps as u128 <= BPS,
            AccumulatorError::InvalidParams
        );
        require!(self.reserve_factor_bps as u128 <= 5_000, AccumulatorError::InvalidParams);
        require!(self.liquidation_fee_bps as u128 <= 5_000, AccumulatorError::InvalidParams);
        require!(
            self.optimal_utilization_bps > 0 && (self.optimal_utilization_bps as u128) < BPS,
            AccumulatorError::InvalidParams
        );
        require!(
            self.max_utilization_bps > 0 && self.max_utilization_bps as u128 <= BPS,
            AccumulatorError::InvalidParams
        );
        // Rates are annual; 1000% at full utilization is a hard ceiling.
        let max_rate = self.base_rate_bps as u128 + self.slope1_bps as u128 + self.slope2_bps as u128;
        require!(max_rate <= 100_000, AccumulatorError::InvalidParams);
        Ok(())
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum OracleKind {
    /// Collateral is a stake pool token, debt is native XNT.
    /// Price = stake pool total_lamports / pool_token_supply. No market price.
    /// Accounts: [stake_pool]
    StakePool,
    /// Price comes from an XDEX pool's on-chain price history (TWAP).
    /// Accounts: [pool, observation, vault_0, vault_1]
    XdexTwap,
}

#[account]
#[derive(InitSpace)]
pub struct Market {
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
    /// Accounts the price is read from, in order. Unused slots are default.
    pub oracle_accounts: [Pubkey; 4],
    /// XDEX only: true when the collateral is the pool's token 0.
    pub collateral_is_token0: bool,

    pub params: MarketParams,
    pub pending_params: MarketParams,
    pub pending_eta: i64,
    pub has_pending: bool,
    pub borrow_paused: bool,

    /// Lend tokens held in the liquidity vault (internal count; donations are ignored).
    pub cash: u64,
    /// Total debt in scaled units: debt = scaled * borrow_index / WAD.
    pub total_borrow_scaled: u128,
    pub borrow_index: u128,
    /// Interest owed to the protocol, in lend raw units.
    pub protocol_fees: u64,
    pub last_accrual_ts: i64,
    pub total_collateral: u64,
    /// Debt written off after liquidations ran out of collateral (lend raw units).
    pub cumulative_bad_debt: u64,

    pub bump: u8,
    pub liquidity_vault_bump: u8,
    pub collateral_vault_bump: u8,
    pub share_mint_bump: u8,

    /// Liquidation fees owed to the protocol, in collateral raw units. Held in the
    /// collateral vault on top of `total_collateral`.
    pub protocol_collateral_fees: u64,
}

#[account]
#[derive(InitSpace)]
pub struct Obligation {
    pub market: Pubkey,
    pub owner: Pubkey,
    pub collateral: u64,
    pub borrow_scaled: u128,
    pub bump: u8,
}

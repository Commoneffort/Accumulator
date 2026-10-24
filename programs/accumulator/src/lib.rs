//! Accumulator — isolated lend/borrow markets on X1.
//!
//! Lenders deposit a token and earn the interest borrowers pay. Borrowers post
//! collateral. Prices come from on-chain data only: the X1 stake pool rate for
//! pXNT, and XDEX's own price history (TWAP) for XNT.

use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod legacy;
pub mod math;
pub mod oracle;
pub mod state;

use instructions::*;
use state::{MarketParams, OracleKind};

declare_id!("BTjwAkUiiGSrhYxTGD8UskZNTT1TMTQjkD4NQtk6Vs9y");

#[program]
pub mod accumulator {
    use super::*;

    // ---- admin ----
    pub fn init_config(ctx: Context<InitConfig>, timelock_seconds: i64) -> Result<()> {
        instructions::admin::init_config(ctx, timelock_seconds)
    }
    pub fn propose_admin(ctx: Context<AdminOnly>, new_admin: Pubkey) -> Result<()> {
        instructions::admin::propose_admin(ctx, new_admin)
    }
    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        instructions::admin::accept_admin(ctx)
    }
    pub fn create_market<'info>(
        ctx: Context<'_, '_, 'info, 'info, CreateMarket<'info>>,
        params: MarketParams,
        oracle_kind: OracleKind,
        collateral_is_token0: bool,
    ) -> Result<()> {
        instructions::admin::create_market(ctx, params, oracle_kind, collateral_is_token0)
    }
    pub fn queue_params(ctx: Context<MarketAdmin>, params: MarketParams) -> Result<()> {
        instructions::admin::queue_params(ctx, params)
    }
    pub fn cancel_params(ctx: Context<MarketAdmin>) -> Result<()> {
        instructions::admin::cancel_params(ctx)
    }
    pub fn apply_params(ctx: Context<ApplyParams>) -> Result<()> {
        instructions::admin::apply_params(ctx)
    }
    pub fn set_borrow_paused(ctx: Context<MarketAdmin>, paused: bool) -> Result<()> {
        instructions::admin::set_borrow_paused(ctx, paused)
    }
    pub fn set_treasury(ctx: Context<AdminOnly>, treasury: Pubkey) -> Result<()> {
        instructions::admin::set_treasury(ctx, treasury)
    }
    pub fn apply_treasury(ctx: Context<ApplyTreasury>) -> Result<()> {
        instructions::admin::apply_treasury(ctx)
    }
    pub fn collect_fees(ctx: Context<CollectFees>, amount: u64) -> Result<()> {
        instructions::admin::collect_fees(ctx, amount)
    }
    pub fn collect_collateral_fees(ctx: Context<CollectCollateralFees>) -> Result<()> {
        instructions::admin::collect_collateral_fees(ctx)
    }
    pub fn migrate_config(ctx: Context<MigrateConfig>) -> Result<()> {
        instructions::admin::migrate_config(ctx)
    }
    pub fn migrate_market(ctx: Context<MigrateMarket>) -> Result<()> {
        instructions::admin::migrate_market(ctx)
    }

    // ---- lenders ----
    pub fn deposit(ctx: Context<Lend>, amount: u64) -> Result<()> {
        instructions::lend::deposit(ctx, amount)
    }
    pub fn withdraw(ctx: Context<Lend>, shares: u64) -> Result<()> {
        instructions::lend::withdraw(ctx, shares)
    }

    // ---- borrowers ----
    pub fn open_obligation(ctx: Context<OpenObligation>) -> Result<()> {
        instructions::borrow::open_obligation(ctx)
    }
    pub fn close_obligation(ctx: Context<CloseObligation>) -> Result<()> {
        instructions::borrow::close_obligation(ctx)
    }
    pub fn deposit_collateral(ctx: Context<Collateral>, amount: u64) -> Result<()> {
        instructions::borrow::deposit_collateral(ctx, amount)
    }
    pub fn withdraw_collateral<'info>(
        ctx: Context<'_, '_, 'info, 'info, Collateral<'info>>,
        amount: u64,
    ) -> Result<()> {
        instructions::borrow::withdraw_collateral(ctx, amount)
    }
    pub fn borrow<'info>(ctx: Context<'_, '_, 'info, 'info, Borrow<'info>>, amount: u64) -> Result<()> {
        instructions::borrow::borrow(ctx, amount)
    }
    pub fn repay(ctx: Context<Repay>, amount: u64) -> Result<()> {
        instructions::borrow::repay(ctx, amount)
    }
    pub fn accrue_interest(ctx: Context<Accrue>) -> Result<()> {
        instructions::borrow::accrue_interest(ctx)
    }

    // ---- liquidators ----
    pub fn liquidate<'info>(
        ctx: Context<'_, '_, 'info, 'info, Liquidate<'info>>,
        max_repay: u64,
        min_collateral_out: u64,
    ) -> Result<()> {
        instructions::liquidate::liquidate(ctx, max_repay, min_collateral_out)
    }
}

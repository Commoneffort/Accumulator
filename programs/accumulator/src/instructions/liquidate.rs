use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::errors::AccumulatorError;
use crate::events::*;
use crate::math::*;
use crate::oracle::{collateral_price, PriceUse};
use crate::state::*;

use super::{transfer_in, transfer_out};

#[derive(Accounts)]
pub struct Liquidate<'info> {
    #[account(
        mut,
        has_one = lend_mint,
        has_one = collateral_mint,
        has_one = liquidity_vault,
        has_one = collateral_vault
    )]
    pub market: Box<Account<'info, Market>>,
    #[account(mut, has_one = market)]
    pub obligation: Box<Account<'info, Obligation>>,
    pub liquidator: Signer<'info>,
    pub lend_mint: Box<InterfaceAccount<'info, Mint>>,
    pub collateral_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut)]
    pub liquidity_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub collateral_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// Liquidator pays debt from here.
    #[account(mut, token::mint = lend_mint, token::token_program = lend_token_program)]
    pub liquidator_lend: Box<InterfaceAccount<'info, TokenAccount>>,
    /// Liquidator receives collateral here.
    #[account(mut, token::mint = collateral_mint, token::token_program = collateral_token_program)]
    pub liquidator_collateral: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = market.lend_token_program)]
    pub lend_token_program: Interface<'info, TokenInterface>,
    #[account(address = market.collateral_token_program)]
    pub collateral_token_program: Interface<'info, TokenInterface>,
    // remaining_accounts: the market's oracle accounts
}

/// Repay part of an unhealthy position's debt and take its collateral plus a
/// bonus. The repay is capped at what brings the position back to safety.
/// `min_collateral_out` (what the liquidator receives, after the protocol's
/// share of the bonus) protects the liquidator from a moved price.
pub fn liquidate<'info>(
    ctx: Context<'_, '_, 'info, 'info, Liquidate<'info>>,
    max_repay: u64,
    min_collateral_out: u64,
) -> Result<()> {
    require!(max_repay > 0, AccumulatorError::ZeroAmount);
    let now = Clock::get()?.unix_timestamp;
    let m = &mut ctx.accounts.market;
    m.accrue(now)?;
    let o = &mut ctx.accounts.obligation;

    let debt = m.debt_of(o.borrow_scaled)?;
    require!(debt > 0, AccumulatorError::PositionHealthy);
    let price = collateral_price(m, ctx.remaining_accounts, now, PriceUse::Liquidate)?;
    let value = collateral_value(o.collateral as u128, price)?;
    require!(
        !within_limit(debt, value, m.params.liquidation_threshold_bps)?,
        AccumulatorError::PositionHealthy
    );

    let allowed = max_liquidation_repay(debt, value, &m.params)?;
    let mut repay = (max_repay as u128).min(allowed);
    let mut seize = seize_for_repay(repay, price, m.params.liquidation_bonus_bps)?;
    if seize > o.collateral as u128 {
        // Not enough collateral for the bonus: take it all, repay what it covers.
        seize = o.collateral as u128;
        repay = repay_for_seize(seize, price, m.params.liquidation_bonus_bps)?.max(1).min(repay);
    }
    // The protocol keeps a share of the bonus; the liquidator gets the rest. No fee when this
    // liquidation takes the last collateral and leaves bad debt: lenders absorb that loss, so
    // the protocol shouldn't profit from it, and the full bonus helps get it done.
    let leaves_bad_debt = seize == o.collateral as u128 && repay < debt;
    let fee = if leaves_bad_debt {
        0
    } else {
        liquidation_fee(seize, m.params.liquidation_bonus_bps, m.params.liquidation_fee_bps)?
    };
    let to_liquidator = seize - fee;
    require!(to_liquidator >= min_collateral_out as u128, AccumulatorError::RepayTooLarge);
    let repay = to_u64(repay)?;
    let seize = to_u64(seize)?;
    let fee = to_u64(fee)?;
    let to_liquidator = to_u64(to_liquidator)?;

    // Pay down debt
    let scaled = if repay as u128 >= debt {
        o.borrow_scaled
    } else {
        m.scaled_for_repay(repay as u128)?.min(o.borrow_scaled)
    };
    o.borrow_scaled -= scaled;
    m.total_borrow_scaled = m.total_borrow_scaled.saturating_sub(scaled);
    m.cash = m.cash.checked_add(repay).ok_or(AccumulatorError::MathOverflow)?;
    o.collateral -= seize;
    m.total_collateral -= seize;
    m.protocol_collateral_fees = m.protocol_collateral_fees.checked_add(fee).ok_or(AccumulatorError::MathOverflow)?;

    // Collateral gone but debt left: write it off so it stops accruing.
    // Unclaimed protocol fees absorb it first; lenders take only the rest.
    let mut bad_debt = 0u64;
    if o.collateral == 0 && o.borrow_scaled > 0 {
        bad_debt = to_u64(m.debt_of(o.borrow_scaled)?)?;
        m.total_borrow_scaled = m.total_borrow_scaled.saturating_sub(o.borrow_scaled);
        o.borrow_scaled = 0;
        m.protocol_fees -= m.protocol_fees.min(bad_debt);
        m.cumulative_bad_debt = m.cumulative_bad_debt.saturating_add(bad_debt);
    }

    let signer = m.signer();
    let (lend_dec, coll_dec) = (m.lend_decimals, m.collateral_decimals);
    let owner = o.owner;

    transfer_in(
        ctx.accounts.liquidator_lend.to_account_info(),
        ctx.accounts.liquidity_vault.to_account_info(),
        ctx.accounts.liquidator.to_account_info(),
        ctx.accounts.lend_mint.to_account_info(),
        ctx.accounts.lend_token_program.to_account_info(),
        repay,
        lend_dec,
    )?;
    transfer_out(
        ctx.accounts.market.to_account_info(),
        &signer,
        ctx.accounts.collateral_vault.to_account_info(),
        ctx.accounts.liquidator_collateral.to_account_info(),
        ctx.accounts.collateral_mint.to_account_info(),
        ctx.accounts.collateral_token_program.to_account_info(),
        to_liquidator,
        coll_dec,
    )?;
    emit!(Liquidated {
        market: ctx.accounts.market.key(),
        owner,
        liquidator: ctx.accounts.liquidator.key(),
        repaid: repay,
        collateral_seized: seize,
        protocol_fee: fee,
        bad_debt,
        price_wad: price,
    });
    Ok(())
}

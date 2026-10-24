use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::errors::AccumulatorError;
use crate::events::*;
use crate::math::*;
use crate::state::*;

use super::{burn_shares, mint_shares, transfer_in, transfer_out};

#[derive(Accounts)]
pub struct Lend<'info> {
    #[account(mut, has_one = lend_mint, has_one = liquidity_vault, has_one = share_mint)]
    pub market: Box<Account<'info, Market>>,
    pub user: Signer<'info>,
    pub lend_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut)]
    pub liquidity_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub share_mint: Box<InterfaceAccount<'info, Mint>>,
    /// User's lend-token account (source on deposit, destination on withdraw).
    #[account(mut, token::mint = lend_mint, token::token_program = lend_token_program)]
    pub user_token: Box<InterfaceAccount<'info, TokenAccount>>,
    /// User's share-token account.
    #[account(mut, token::mint = share_mint, token::token_program = lend_token_program)]
    pub user_shares: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = market.lend_token_program)]
    pub lend_token_program: Interface<'info, TokenInterface>,
}

/// Deposit lend tokens, receive market shares that grow as borrowers pay interest.
pub fn deposit(ctx: Context<Lend>, amount: u64) -> Result<()> {
    require!(amount > 0, AccumulatorError::ZeroAmount);
    let now = Clock::get()?.unix_timestamp;
    let supply = ctx.accounts.share_mint.supply as u128;

    let m = &mut ctx.accounts.market;
    m.accrue(now)?;
    let assets = m.lender_assets()?;
    require!(
        assets + amount as u128 <= m.params.deposit_cap as u128,
        AccumulatorError::DepositCapExceeded
    );
    let shares = to_u64(shares_for_deposit(amount as u128, assets, supply)?)?;
    require!(shares > 0, AccumulatorError::ZeroAmount);
    m.cash = m.cash.checked_add(amount).ok_or(AccumulatorError::MathOverflow)?;
    let signer = m.signer();
    let decimals = m.lend_decimals;

    transfer_in(
        ctx.accounts.user_token.to_account_info(),
        ctx.accounts.liquidity_vault.to_account_info(),
        ctx.accounts.user.to_account_info(),
        ctx.accounts.lend_mint.to_account_info(),
        ctx.accounts.lend_token_program.to_account_info(),
        amount,
        decimals,
    )?;
    mint_shares(
        ctx.accounts.market.to_account_info(),
        &signer,
        ctx.accounts.share_mint.to_account_info(),
        ctx.accounts.user_shares.to_account_info(),
        ctx.accounts.lend_token_program.to_account_info(),
        shares,
    )?;
    emit!(Deposited { market: ctx.accounts.market.key(), user: ctx.accounts.user.key(), amount, shares });
    Ok(())
}

/// Burn shares for lend tokens. Limited by idle cash in the market.
pub fn withdraw(ctx: Context<Lend>, shares: u64) -> Result<()> {
    require!(shares > 0, AccumulatorError::ZeroAmount);
    let now = Clock::get()?.unix_timestamp;
    let supply = ctx.accounts.share_mint.supply as u128;

    let m = &mut ctx.accounts.market;
    m.accrue(now)?;
    let assets = m.lender_assets()?;
    let amount = to_u64(assets_for_shares(shares as u128, assets, supply)?)?;
    require!(amount > 0, AccumulatorError::ZeroAmount);
    // Only idle cash can leave; lent-out funds come back as borrowers repay.
    require!(amount <= m.cash, AccumulatorError::InsufficientLiquidity);
    m.cash -= amount;
    let signer = m.signer();
    let decimals = m.lend_decimals;

    burn_shares(
        ctx.accounts.share_mint.to_account_info(),
        ctx.accounts.user_shares.to_account_info(),
        ctx.accounts.user.to_account_info(),
        ctx.accounts.lend_token_program.to_account_info(),
        shares,
    )?;
    transfer_out(
        ctx.accounts.market.to_account_info(),
        &signer,
        ctx.accounts.liquidity_vault.to_account_info(),
        ctx.accounts.user_token.to_account_info(),
        ctx.accounts.lend_mint.to_account_info(),
        ctx.accounts.lend_token_program.to_account_info(),
        amount,
        decimals,
    )?;
    emit!(Withdrawn { market: ctx.accounts.market.key(), user: ctx.accounts.user.key(), amount, shares });
    Ok(())
}

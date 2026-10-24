use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::constants::*;
use crate::errors::AccumulatorError;
use crate::events::*;
use crate::math::*;
use crate::oracle::{collateral_price, PriceUse};
use crate::state::*;

use super::{transfer_in, transfer_out};

/// Debt must stay within max LTV at the conservative (borrow) price.
fn require_within_borrow_limit(
    m: &Market,
    collateral: u64,
    borrow_scaled: u128,
    oracle: &[AccountInfo],
    now: i64,
) -> Result<()> {
    let debt = m.debt_of(borrow_scaled)?;
    if debt == 0 {
        return Ok(());
    }
    let price = collateral_price(m, oracle, now, PriceUse::Borrow)?;
    let value = collateral_value(collateral as u128, price)?;
    require!(within_limit(debt, value, m.params.max_ltv_bps)?, AccumulatorError::BorrowLimitExceeded);
    Ok(())
}

// ----------------------------------------------------------- open / close

#[derive(Accounts)]
pub struct OpenObligation<'info> {
    pub market: Account<'info, Market>,
    #[account(
        init,
        payer = owner,
        space = 8 + Obligation::INIT_SPACE,
        seeds = [OBLIGATION_SEED, market.key().as_ref(), owner.key().as_ref()],
        bump
    )]
    pub obligation: Account<'info, Obligation>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn open_obligation(ctx: Context<OpenObligation>) -> Result<()> {
    let o = &mut ctx.accounts.obligation;
    o.market = ctx.accounts.market.key();
    o.owner = ctx.accounts.owner.key();
    o.collateral = 0;
    o.borrow_scaled = 0;
    o.bump = ctx.bumps.obligation;
    Ok(())
}

#[derive(Accounts)]
pub struct CloseObligation<'info> {
    #[account(mut, close = owner, has_one = owner)]
    pub obligation: Account<'info, Obligation>,
    #[account(mut)]
    pub owner: Signer<'info>,
}

pub fn close_obligation(ctx: Context<CloseObligation>) -> Result<()> {
    let o = &ctx.accounts.obligation;
    require!(o.collateral == 0 && o.borrow_scaled == 0, AccumulatorError::ObligationNotEmpty);
    Ok(())
}

// ------------------------------------------------------------- collateral

#[derive(Accounts)]
pub struct Collateral<'info> {
    #[account(mut, has_one = collateral_mint, has_one = collateral_vault)]
    pub market: Box<Account<'info, Market>>,
    #[account(
        mut,
        seeds = [OBLIGATION_SEED, market.key().as_ref(), owner.key().as_ref()],
        bump = obligation.bump,
        has_one = market,
        has_one = owner,
    )]
    pub obligation: Box<Account<'info, Obligation>>,
    pub owner: Signer<'info>,
    pub collateral_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut)]
    pub collateral_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// Owner's collateral account (source on deposit, destination on withdraw).
    #[account(mut, token::mint = collateral_mint, token::token_program = collateral_token_program)]
    pub user_collateral: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = market.collateral_token_program)]
    pub collateral_token_program: Interface<'info, TokenInterface>,
    // remaining_accounts (withdraw with debt only): the market's oracle accounts
}

pub fn deposit_collateral(ctx: Context<Collateral>, amount: u64) -> Result<()> {
    require!(amount > 0, AccumulatorError::ZeroAmount);
    let decimals = ctx.accounts.market.collateral_decimals;
    transfer_in(
        ctx.accounts.user_collateral.to_account_info(),
        ctx.accounts.collateral_vault.to_account_info(),
        ctx.accounts.owner.to_account_info(),
        ctx.accounts.collateral_mint.to_account_info(),
        ctx.accounts.collateral_token_program.to_account_info(),
        amount,
        decimals,
    )?;
    let o = &mut ctx.accounts.obligation;
    o.collateral = o.collateral.checked_add(amount).ok_or(AccumulatorError::MathOverflow)?;
    let m = &mut ctx.accounts.market;
    m.total_collateral = m.total_collateral.checked_add(amount).ok_or(AccumulatorError::MathOverflow)?;
    emit!(CollateralDeposited { market: m.key(), owner: o.owner, amount });
    Ok(())
}

pub fn withdraw_collateral<'info>(
    ctx: Context<'_, '_, 'info, 'info, Collateral<'info>>,
    amount: u64,
) -> Result<()> {
    require!(amount > 0, AccumulatorError::ZeroAmount);
    let now = Clock::get()?.unix_timestamp;
    let m = &mut ctx.accounts.market;
    m.accrue(now)?;
    let o = &mut ctx.accounts.obligation;
    require!(amount <= o.collateral, AccumulatorError::InsufficientCollateral);
    let left = o.collateral - amount;
    require_within_borrow_limit(m, left, o.borrow_scaled, ctx.remaining_accounts, now)?;
    o.collateral = left;
    m.total_collateral -= amount;
    let signer = m.signer();
    let decimals = m.collateral_decimals;
    let owner = o.owner;

    transfer_out(
        ctx.accounts.market.to_account_info(),
        &signer,
        ctx.accounts.collateral_vault.to_account_info(),
        ctx.accounts.user_collateral.to_account_info(),
        ctx.accounts.collateral_mint.to_account_info(),
        ctx.accounts.collateral_token_program.to_account_info(),
        amount,
        decimals,
    )?;
    emit!(CollateralWithdrawn { market: ctx.accounts.market.key(), owner, amount });
    Ok(())
}

// ------------------------------------------------------------ borrow / repay

#[derive(Accounts)]
pub struct Borrow<'info> {
    #[account(mut, has_one = lend_mint, has_one = liquidity_vault)]
    pub market: Box<Account<'info, Market>>,
    #[account(
        mut,
        seeds = [OBLIGATION_SEED, market.key().as_ref(), owner.key().as_ref()],
        bump = obligation.bump,
        has_one = market,
        has_one = owner,
    )]
    pub obligation: Box<Account<'info, Obligation>>,
    pub owner: Signer<'info>,
    pub lend_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut)]
    pub liquidity_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = lend_mint, token::token_program = lend_token_program)]
    pub destination: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = market.lend_token_program)]
    pub lend_token_program: Interface<'info, TokenInterface>,
    // remaining_accounts: the market's oracle accounts
}

pub fn borrow<'info>(ctx: Context<'_, '_, 'info, 'info, Borrow<'info>>, amount: u64) -> Result<()> {
    require!(amount > 0, AccumulatorError::ZeroAmount);
    let now = Clock::get()?.unix_timestamp;
    let m = &mut ctx.accounts.market;
    require!(!m.borrow_paused, AccumulatorError::BorrowPaused);
    m.accrue(now)?;
    require!(amount <= m.cash, AccumulatorError::InsufficientLiquidity);

    let a = amount as u128;
    let borrows_after = m.total_borrows()? + a;
    require!(borrows_after <= m.params.borrow_cap as u128, AccumulatorError::BorrowCapExceeded);
    // cash + borrows is unchanged by a borrow, so utilization after = borrows_after / total.
    let util_after = utilization_bps(borrows_after, m.cash as u128 - a)?;
    require!(util_after <= m.params.max_utilization_bps as u128, AccumulatorError::UtilizationTooHigh);

    let o = &mut ctx.accounts.obligation;
    let scaled_after = o.borrow_scaled + m.scaled_for_borrow(a)?;
    // existing debt + this borrow (rounding once), so borrowing exactly the cap is allowed
    require!(
        m.debt_of(o.borrow_scaled)? + a <= m.params.max_borrow_per_obligation as u128,
        AccumulatorError::AccountBorrowCapExceeded
    );
    require_within_borrow_limit(m, o.collateral, scaled_after, ctx.remaining_accounts, now)?;

    m.total_borrow_scaled += scaled_after - o.borrow_scaled;
    o.borrow_scaled = scaled_after;
    m.cash -= amount;
    let signer = m.signer();
    let decimals = m.lend_decimals;
    let owner = o.owner;

    transfer_out(
        ctx.accounts.market.to_account_info(),
        &signer,
        ctx.accounts.liquidity_vault.to_account_info(),
        ctx.accounts.destination.to_account_info(),
        ctx.accounts.lend_mint.to_account_info(),
        ctx.accounts.lend_token_program.to_account_info(),
        amount,
        decimals,
    )?;
    emit!(Borrowed { market: ctx.accounts.market.key(), owner, amount });
    Ok(())
}

#[derive(Accounts)]
pub struct Repay<'info> {
    #[account(mut, has_one = lend_mint, has_one = liquidity_vault)]
    pub market: Box<Account<'info, Market>>,
    #[account(mut, has_one = market)]
    pub obligation: Box<Account<'info, Obligation>>,
    /// Anyone may repay any position.
    pub payer: Signer<'info>,
    pub lend_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut)]
    pub liquidity_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = lend_mint, token::token_program = lend_token_program)]
    pub source: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = market.lend_token_program)]
    pub lend_token_program: Interface<'info, TokenInterface>,
}

/// Repay up to `amount`; pass u64::MAX to repay everything owed.
pub fn repay(ctx: Context<Repay>, amount: u64) -> Result<()> {
    require!(amount > 0, AccumulatorError::ZeroAmount);
    let now = Clock::get()?.unix_timestamp;
    let m = &mut ctx.accounts.market;
    m.accrue(now)?;
    let o = &mut ctx.accounts.obligation;
    let debt = m.debt_of(o.borrow_scaled)?;
    require!(debt > 0, AccumulatorError::ZeroAmount);

    let (paid, scaled) = if amount as u128 >= debt {
        (to_u64(debt)?, o.borrow_scaled)
    } else {
        (amount, m.scaled_for_repay(amount as u128)?.min(o.borrow_scaled))
    };
    o.borrow_scaled -= scaled;
    m.total_borrow_scaled = m.total_borrow_scaled.saturating_sub(scaled);
    m.cash = m.cash.checked_add(paid).ok_or(AccumulatorError::MathOverflow)?;
    let decimals = m.lend_decimals;
    let owner = o.owner;

    transfer_in(
        ctx.accounts.source.to_account_info(),
        ctx.accounts.liquidity_vault.to_account_info(),
        ctx.accounts.payer.to_account_info(),
        ctx.accounts.lend_mint.to_account_info(),
        ctx.accounts.lend_token_program.to_account_info(),
        paid,
        decimals,
    )?;
    emit!(Repaid { market: ctx.accounts.market.key(), owner, amount: paid });
    Ok(())
}

// ------------------------------------------------------------------ accrue

#[derive(Accounts)]
pub struct Accrue<'info> {
    #[account(mut)]
    pub market: Account<'info, Market>,
}

/// Anyone can bring a market's interest up to date (e.g. before reading rates).
pub fn accrue_interest(ctx: Context<Accrue>) -> Result<()> {
    ctx.accounts.market.accrue(Clock::get()?.unix_timestamp)
}

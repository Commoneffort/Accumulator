use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::constants::*;
use crate::errors::AccumulatorError;
use crate::events::*;
use crate::oracle::{collateral_price, PriceUse};
use crate::state::*;

use super::transfer_out;

// ---------------------------------------------------------------- init_config

#[derive(Accounts)]
pub struct InitConfig<'info> {
    #[account(init, payer = admin, space = 8 + Config::INIT_SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn init_config(ctx: Context<InitConfig>, timelock_seconds: i64) -> Result<()> {
    require!(timelock_seconds >= MIN_TIMELOCK_SECONDS, AccumulatorError::TimelockTooShort);
    let c = &mut ctx.accounts.config;
    c.admin = ctx.accounts.admin.key();
    c.pending_admin = Pubkey::default();
    c.timelock_seconds = timelock_seconds;
    c.market_count = 0;
    c.bump = ctx.bumps.config;
    c.treasury = Pubkey::default();
    c.pending_treasury = Pubkey::default();
    c.treasury_eta = 0;
    Ok(())
}

// ------------------------------------------------------------- admin handoff

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ AccumulatorError::Unauthorized)]
    pub config: Account<'info, Config>,
    pub admin: Signer<'info>,
}

pub fn propose_admin(ctx: Context<AdminOnly>, new_admin: Pubkey) -> Result<()> {
    ctx.accounts.config.pending_admin = new_admin;
    Ok(())
}

#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    pub new_admin: Signer<'info>,
}

pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
    let c = &mut ctx.accounts.config;
    require!(
        c.pending_admin != Pubkey::default() && c.pending_admin == ctx.accounts.new_admin.key(),
        AccumulatorError::NotPendingAdmin
    );
    c.admin = c.pending_admin;
    c.pending_admin = Pubkey::default();
    Ok(())
}

// ------------------------------------------------------------- create_market

/// Vault accounting assumes a transfer moves exactly the amount asked. Token-2022
/// extensions such as transfer fees, hooks or confidential transfers break that,
/// so only metadata extensions are allowed.
fn require_plain_mint(mint: &AccountInfo) -> Result<()> {
    use anchor_spl::token_2022::spl_token_2022::extension::{
        BaseStateWithExtensions, ExtensionType, StateWithExtensions,
    };
    use anchor_spl::token_2022::spl_token_2022::state::Mint as Mint22;
    if *mint.owner != anchor_spl::token_2022::ID {
        return Ok(());
    }
    let data = mint.try_borrow_data()?;
    let state = StateWithExtensions::<Mint22>::unpack(&data).map_err(|_| AccumulatorError::UnsupportedMint)?;
    let types = state.get_extension_types().map_err(|_| AccumulatorError::UnsupportedMint)?;
    for t in types {
        require!(
            matches!(t, ExtensionType::MetadataPointer | ExtensionType::TokenMetadata),
            AccumulatorError::UnsupportedMint
        );
    }
    Ok(())
}

#[derive(Accounts)]
pub struct CreateMarket<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ AccumulatorError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(mint::token_program = lend_token_program)]
    pub lend_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mint::token_program = collateral_token_program)]
    pub collateral_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        init,
        payer = admin,
        space = 8 + Market::INIT_SPACE,
        seeds = [MARKET_SEED, lend_mint.key().as_ref(), collateral_mint.key().as_ref()],
        bump
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(
        init,
        payer = admin,
        seeds = [LIQUIDITY_VAULT_SEED, market.key().as_ref()],
        bump,
        token::mint = lend_mint,
        token::authority = market,
        token::token_program = lend_token_program,
    )]
    pub liquidity_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        init,
        payer = admin,
        seeds = [COLLATERAL_VAULT_SEED, market.key().as_ref()],
        bump,
        token::mint = collateral_mint,
        token::authority = market,
        token::token_program = collateral_token_program,
    )]
    pub collateral_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        init,
        payer = admin,
        seeds = [SHARE_MINT_SEED, market.key().as_ref()],
        bump,
        mint::decimals = lend_mint.decimals,
        mint::authority = market,
        mint::token_program = lend_token_program,
    )]
    pub share_mint: Box<InterfaceAccount<'info, Mint>>,

    pub lend_token_program: Interface<'info, TokenInterface>,
    pub collateral_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
    // remaining_accounts: the oracle accounts, in the order the kind expects
}

pub fn create_market<'info>(
    ctx: Context<'_, '_, 'info, 'info, CreateMarket<'info>>,
    params: MarketParams,
    oracle_kind: OracleKind,
    collateral_is_token0: bool,
) -> Result<()> {
    params.validate()?;
    require!(
        ctx.accounts.lend_mint.key() != ctx.accounts.collateral_mint.key(),
        AccumulatorError::InvalidParams
    );
    require_plain_mint(&ctx.accounts.lend_mint.to_account_info())?;
    require_plain_mint(&ctx.accounts.collateral_mint.to_account_info())?;

    let mut oracle_accounts = [Pubkey::default(); 4];
    match oracle_kind {
        OracleKind::StakePool => {
            // pXNT is priced in XNT, so the market must lend native XNT.
            require_keys_eq!(ctx.accounts.lend_mint.key(), NATIVE_MINT, AccumulatorError::UnsupportedOracle);
            require!(ctx.remaining_accounts.len() >= 1, AccumulatorError::OracleAccountMismatch);
            oracle_accounts[0] = ctx.remaining_accounts[0].key();
        }
        OracleKind::XdexTwap => {
            require!(
                params.twap_window_secs >= MIN_TWAP_WINDOW && params.twap_window_secs <= MAX_TWAP_WINDOW,
                AccumulatorError::InvalidParams
            );
            require!(ctx.remaining_accounts.len() >= 4, AccumulatorError::OracleAccountMismatch);
            for i in 0..4 {
                oracle_accounts[i] = ctx.remaining_accounts[i].key();
            }
        }
    }

    let now = Clock::get()?.unix_timestamp;
    let market_key = ctx.accounts.market.key();
    let m = &mut ctx.accounts.market;
    m.config = ctx.accounts.config.key();
    m.lend_mint = ctx.accounts.lend_mint.key();
    m.lend_token_program = ctx.accounts.lend_token_program.key();
    m.lend_decimals = ctx.accounts.lend_mint.decimals;
    m.collateral_mint = ctx.accounts.collateral_mint.key();
    m.collateral_token_program = ctx.accounts.collateral_token_program.key();
    m.collateral_decimals = ctx.accounts.collateral_mint.decimals;
    m.liquidity_vault = ctx.accounts.liquidity_vault.key();
    m.collateral_vault = ctx.accounts.collateral_vault.key();
    m.share_mint = ctx.accounts.share_mint.key();
    m.oracle_kind = oracle_kind;
    m.oracle_accounts = oracle_accounts;
    m.collateral_is_token0 = collateral_is_token0;
    m.params = params;
    m.pending_params = params;
    m.pending_eta = 0;
    m.has_pending = false;
    m.borrow_paused = false;
    m.cash = 0;
    m.total_borrow_scaled = 0;
    m.borrow_index = WAD;
    m.protocol_fees = 0;
    m.last_accrual_ts = now;
    m.total_collateral = 0;
    m.cumulative_bad_debt = 0;
    m.protocol_collateral_fees = 0;
    m.bump = ctx.bumps.market;
    m.liquidity_vault_bump = ctx.bumps.liquidity_vault;
    m.collateral_vault_bump = ctx.bumps.collateral_vault;
    m.share_mint_bump = ctx.bumps.share_mint;

    // Read the price once now: a market whose price source is wrong never opens.
    let price = collateral_price(m, ctx.remaining_accounts, now, PriceUse::Liquidate)?;

    ctx.accounts.config.market_count += 1;
    emit!(MarketCreated {
        market: market_key,
        lend_mint: m.lend_mint,
        collateral_mint: m.collateral_mint,
        oracle_kind,
        price_wad: price,
    });
    Ok(())
}

// ------------------------------------------------------- timelocked changes

#[derive(Accounts)]
pub struct MarketAdmin<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ AccumulatorError::Unauthorized)]
    pub config: Account<'info, Config>,
    pub admin: Signer<'info>,
    #[account(mut, has_one = config)]
    pub market: Account<'info, Market>,
}

pub fn queue_params(ctx: Context<MarketAdmin>, params: MarketParams) -> Result<()> {
    params.validate()?;
    if ctx.accounts.market.oracle_kind == OracleKind::XdexTwap {
        require!(
            params.twap_window_secs >= MIN_TWAP_WINDOW && params.twap_window_secs <= MAX_TWAP_WINDOW,
            AccumulatorError::InvalidParams
        );
    }
    let eta = Clock::get()?.unix_timestamp + ctx.accounts.config.timelock_seconds;
    let m = &mut ctx.accounts.market;
    m.pending_params = params;
    m.pending_eta = eta;
    m.has_pending = true;
    emit!(ParamsQueued { market: m.key(), eta });
    Ok(())
}

pub fn cancel_params(ctx: Context<MarketAdmin>) -> Result<()> {
    let m = &mut ctx.accounts.market;
    require!(m.has_pending, AccumulatorError::NothingQueued);
    m.has_pending = false;
    Ok(())
}

#[derive(Accounts)]
pub struct ApplyParams<'info> {
    #[account(mut)]
    pub market: Account<'info, Market>,
}

/// Anyone can apply a queued change once the timelock has passed.
pub fn apply_params(ctx: Context<ApplyParams>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let m = &mut ctx.accounts.market;
    require!(m.has_pending, AccumulatorError::NothingQueued);
    require!(now >= m.pending_eta, AccumulatorError::TimelockNotElapsed);
    // Interest so far accrues under the old rate curve.
    m.accrue(now)?;
    m.params = m.pending_params;
    m.has_pending = false;
    emit!(ParamsApplied { market: m.key() });
    Ok(())
}

/// Pausing new borrows only lowers risk, so it takes effect at once.
/// Repay, deposits, withdrawals and liquidations keep working.
pub fn set_borrow_paused(ctx: Context<MarketAdmin>, paused: bool) -> Result<()> {
    ctx.accounts.market.borrow_paused = paused;
    emit!(BorrowPauseSet { market: ctx.accounts.market.key(), paused });
    Ok(())
}

// ------------------------------------------------------------------ treasury

/// The first treasury is set at once; changing it later waits for the timelock,
/// so a stolen admin key can't quietly redirect fees.
pub fn set_treasury(ctx: Context<AdminOnly>, treasury: Pubkey) -> Result<()> {
    require!(treasury != Pubkey::default(), AccumulatorError::InvalidParams);
    let c = &mut ctx.accounts.config;
    if c.treasury == Pubkey::default() {
        c.treasury = treasury;
        emit!(TreasurySet { treasury });
    } else {
        let eta = Clock::get()?.unix_timestamp + c.timelock_seconds;
        c.pending_treasury = treasury;
        c.treasury_eta = eta;
        emit!(TreasuryQueued { treasury, eta });
    }
    Ok(())
}

#[derive(Accounts)]
pub struct ApplyTreasury<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
}

/// Anyone can apply a queued treasury change once the timelock has passed.
pub fn apply_treasury(ctx: Context<ApplyTreasury>) -> Result<()> {
    let c = &mut ctx.accounts.config;
    require!(c.pending_treasury != Pubkey::default(), AccumulatorError::NothingQueued);
    require!(Clock::get()?.unix_timestamp >= c.treasury_eta, AccumulatorError::TimelockNotElapsed);
    c.treasury = c.pending_treasury;
    c.pending_treasury = Pubkey::default();
    emit!(TreasurySet { treasury: c.treasury });
    Ok(())
}

// ------------------------------------------------------------- collect fees

#[derive(Accounts)]
pub struct CollectFees<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, has_one = config, has_one = lend_mint, has_one = liquidity_vault)]
    pub market: Box<Account<'info, Market>>,
    pub lend_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut)]
    pub liquidity_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// Must belong to the configured treasury.
    #[account(mut, token::mint = lend_mint, token::authority = config.treasury, token::token_program = lend_token_program)]
    pub treasury_token: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = market.lend_token_program)]
    pub lend_token_program: Interface<'info, TokenInterface>,
}

/// Sends accrued interest fees to the treasury. Anyone can call it: the
/// destination is fixed, and only fees from idle cash ever move, never lender funds.
/// `amount` is capped at what is available (u64::MAX = all of it).
pub fn collect_fees(ctx: Context<CollectFees>, amount: u64) -> Result<()> {
    require!(ctx.accounts.config.treasury != Pubkey::default(), AccumulatorError::TreasuryNotSet);
    let now = Clock::get()?.unix_timestamp;
    let m = &mut ctx.accounts.market;
    m.accrue(now)?;
    let amount = amount.min(m.protocol_fees).min(m.cash);
    require!(amount > 0, AccumulatorError::InsufficientFees);
    m.protocol_fees -= amount;
    m.cash -= amount;
    let signer = m.signer();
    let decimals = m.lend_decimals;

    transfer_out(
        ctx.accounts.market.to_account_info(),
        &signer,
        ctx.accounts.liquidity_vault.to_account_info(),
        ctx.accounts.treasury_token.to_account_info(),
        ctx.accounts.lend_mint.to_account_info(),
        ctx.accounts.lend_token_program.to_account_info(),
        amount,
        decimals,
    )?;
    emit!(FeesCollected { market: ctx.accounts.market.key(), amount, treasury: ctx.accounts.config.treasury });
    Ok(())
}

#[derive(Accounts)]
pub struct CollectCollateralFees<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, has_one = config, has_one = collateral_mint, has_one = collateral_vault)]
    pub market: Box<Account<'info, Market>>,
    pub collateral_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut)]
    pub collateral_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// Must belong to the configured treasury.
    #[account(mut, token::mint = collateral_mint, token::authority = config.treasury, token::token_program = collateral_token_program)]
    pub treasury_token: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = market.collateral_token_program)]
    pub collateral_token_program: Interface<'info, TokenInterface>,
}

/// Sends the protocol's share of liquidation bonuses (collateral tokens) to the
/// treasury. Anyone can call it; borrowers' collateral is never touched.
pub fn collect_collateral_fees(ctx: Context<CollectCollateralFees>) -> Result<()> {
    require!(ctx.accounts.config.treasury != Pubkey::default(), AccumulatorError::TreasuryNotSet);
    let m = &mut ctx.accounts.market;
    let amount = m.protocol_collateral_fees;
    require!(amount > 0, AccumulatorError::InsufficientFees);
    m.protocol_collateral_fees = 0;
    let signer = m.signer();
    let decimals = m.collateral_decimals;

    transfer_out(
        ctx.accounts.market.to_account_info(),
        &signer,
        ctx.accounts.collateral_vault.to_account_info(),
        ctx.accounts.treasury_token.to_account_info(),
        ctx.accounts.collateral_mint.to_account_info(),
        ctx.accounts.collateral_token_program.to_account_info(),
        amount,
        decimals,
    )?;
    emit!(CollateralFeesCollected { market: ctx.accounts.market.key(), amount, treasury: ctx.accounts.config.treasury });
    Ok(())
}

// ---------------------------------------------------------------- migration

/// Grow an account to `new_len`, the admin paying the extra rent.
fn grow<'info>(acc: &AccountInfo<'info>, admin: &AccountInfo<'info>, system: &AccountInfo<'info>, new_len: usize) -> Result<()> {
    let need = Rent::get()?.minimum_balance(new_len).saturating_sub(acc.lamports());
    if need > 0 {
        anchor_lang::system_program::transfer(
            CpiContext::new(system.clone(), anchor_lang::system_program::Transfer { from: admin.clone(), to: acc.clone() }),
            need,
        )?;
    }
    acc.resize(new_len)?;
    Ok(())
}

#[derive(Accounts)]
pub struct MigrateConfig<'info> {
    /// CHECK: read as the old layout below; seeds and owner pin it to this program's config.
    #[account(mut, seeds = [CONFIG_SEED], bump, owner = crate::ID)]
    pub config: UncheckedAccount<'info>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

/// One-time upgrade of a config created before the treasury fields existed.
pub fn migrate_config(ctx: Context<MigrateConfig>) -> Result<()> {
    use crate::legacy::ConfigV1;
    let acc = ctx.accounts.config.to_account_info();
    let old_len = 8 + ConfigV1::INIT_SPACE;
    let old = {
        let data = acc.try_borrow_data()?;
        require!(data.len() == old_len && data[..8] == *Config::DISCRIMINATOR, AccumulatorError::NotMigratable);
        ConfigV1::deserialize(&mut &data[8..])?
    };
    require_keys_eq!(old.admin, ctx.accounts.admin.key(), AccumulatorError::Unauthorized);
    grow(&acc, &ctx.accounts.admin.to_account_info(), &ctx.accounts.system_program.to_account_info(), 8 + Config::INIT_SPACE)?;
    let new = old.upgrade();
    let mut data = acc.try_borrow_mut_data()?;
    new.try_serialize(&mut &mut data[..])?;
    Ok(())
}

#[derive(Accounts)]
pub struct MigrateMarket<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ AccumulatorError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
    /// CHECK: read as the old layout below; owner, discriminator and config are checked.
    #[account(mut, owner = crate::ID)]
    pub market: UncheckedAccount<'info>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

/// One-time upgrade of a market created before the liquidation fee existed.
/// Every setting and balance carries over; the new fee starts at 0.
pub fn migrate_market(ctx: Context<MigrateMarket>) -> Result<()> {
    use crate::legacy::MarketV1;
    let acc = ctx.accounts.market.to_account_info();
    let old_len = 8 + MarketV1::INIT_SPACE;
    let old = {
        let data = acc.try_borrow_data()?;
        require!(data.len() == old_len && data[..8] == *Market::DISCRIMINATOR, AccumulatorError::NotMigratable);
        MarketV1::deserialize(&mut &data[8..])?
    };
    require_keys_eq!(old.config, ctx.accounts.config.key(), AccumulatorError::NotMigratable);
    grow(&acc, &ctx.accounts.admin.to_account_info(), &ctx.accounts.system_program.to_account_info(), 8 + Market::INIT_SPACE)?;
    let new = old.upgrade();
    let mut data = acc.try_borrow_mut_data()?;
    new.try_serialize(&mut &mut data[..])?;
    Ok(())
}

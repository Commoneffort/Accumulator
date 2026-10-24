pub mod admin;
pub mod borrow;
pub mod lend;
pub mod liquidate;

pub use admin::*;
pub use borrow::*;
pub use lend::*;
pub use liquidate::*;

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    burn, mint_to, transfer_checked, Burn, MintTo, TransferChecked,
};

use crate::constants::MARKET_SEED;
use crate::state::Market;

/// What the market PDA needs to sign for its vaults and share mint.
pub struct MarketSigner {
    pub lend_mint: Pubkey,
    pub collateral_mint: Pubkey,
    pub bump: u8,
}

impl Market {
    pub fn signer(&self) -> MarketSigner {
        MarketSigner { lend_mint: self.lend_mint, collateral_mint: self.collateral_mint, bump: self.bump }
    }
}

/// User-signed transfer into a vault.
pub fn transfer_in<'info>(
    from: AccountInfo<'info>,
    to: AccountInfo<'info>,
    authority: AccountInfo<'info>,
    mint: AccountInfo<'info>,
    token_program: AccountInfo<'info>,
    amount: u64,
    decimals: u8,
) -> Result<()> {
    transfer_checked(
        CpiContext::new(token_program, TransferChecked { from, mint, to, authority }),
        amount,
        decimals,
    )
}

/// Market-signed transfer out of a vault.
#[allow(clippy::too_many_arguments)]
pub fn transfer_out<'info>(
    market: AccountInfo<'info>,
    s: &MarketSigner,
    from: AccountInfo<'info>,
    to: AccountInfo<'info>,
    mint: AccountInfo<'info>,
    token_program: AccountInfo<'info>,
    amount: u64,
    decimals: u8,
) -> Result<()> {
    let bump = [s.bump];
    let seeds: &[&[u8]] = &[MARKET_SEED, s.lend_mint.as_ref(), s.collateral_mint.as_ref(), &bump];
    transfer_checked(
        CpiContext::new_with_signer(
            token_program,
            TransferChecked { from, mint, to, authority: market },
            &[seeds],
        ),
        amount,
        decimals,
    )
}

pub fn mint_shares<'info>(
    market: AccountInfo<'info>,
    s: &MarketSigner,
    share_mint: AccountInfo<'info>,
    to: AccountInfo<'info>,
    token_program: AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    let bump = [s.bump];
    let seeds: &[&[u8]] = &[MARKET_SEED, s.lend_mint.as_ref(), s.collateral_mint.as_ref(), &bump];
    mint_to(
        CpiContext::new_with_signer(
            token_program,
            MintTo { mint: share_mint, to, authority: market },
            &[seeds],
        ),
        amount,
    )
}

pub fn burn_shares<'info>(
    share_mint: AccountInfo<'info>,
    from: AccountInfo<'info>,
    authority: AccountInfo<'info>,
    token_program: AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    burn(
        CpiContext::new(token_program, Burn { mint: share_mint, from, authority }),
        amount,
    )
}

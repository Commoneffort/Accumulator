use anchor_lang::prelude::*;

use crate::state::OracleKind;

#[event]
pub struct MarketCreated {
    pub market: Pubkey,
    pub lend_mint: Pubkey,
    pub collateral_mint: Pubkey,
    pub oracle_kind: OracleKind,
    pub price_wad: u128,
}

#[event]
pub struct ParamsQueued {
    pub market: Pubkey,
    pub eta: i64,
}

#[event]
pub struct ParamsApplied {
    pub market: Pubkey,
}

#[event]
pub struct BorrowPauseSet {
    pub market: Pubkey,
    pub paused: bool,
}

#[event]
pub struct FeesCollected {
    pub market: Pubkey,
    /// Interest fees, in lend tokens.
    pub amount: u64,
    pub treasury: Pubkey,
}

#[event]
pub struct CollateralFeesCollected {
    pub market: Pubkey,
    /// Liquidation fees, in collateral tokens.
    pub amount: u64,
    pub treasury: Pubkey,
}

#[event]
pub struct TreasurySet {
    pub treasury: Pubkey,
}

#[event]
pub struct TreasuryQueued {
    pub treasury: Pubkey,
    pub eta: i64,
}

#[event]
pub struct Deposited {
    pub market: Pubkey,
    pub user: Pubkey,
    pub amount: u64,
    pub shares: u64,
}

#[event]
pub struct Withdrawn {
    pub market: Pubkey,
    pub user: Pubkey,
    pub amount: u64,
    pub shares: u64,
}

#[event]
pub struct CollateralDeposited {
    pub market: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
}

#[event]
pub struct CollateralWithdrawn {
    pub market: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
}

#[event]
pub struct Borrowed {
    pub market: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
}

#[event]
pub struct Repaid {
    pub market: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
}

#[event]
pub struct Liquidated {
    pub market: Pubkey,
    pub owner: Pubkey,
    pub liquidator: Pubkey,
    pub repaid: u64,
    /// Collateral taken from the position, including the protocol fee.
    pub collateral_seized: u64,
    /// Part of the seized collateral kept by the protocol.
    pub protocol_fee: u64,
    pub bad_debt: u64,
    pub price_wad: u128,
}

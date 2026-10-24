use anchor_lang::prelude::*;

#[error_code]
pub enum AccumulatorError {
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Invalid market parameters")]
    InvalidParams,
    #[msg("Timelock must be at least the protocol minimum")]
    TimelockTooShort,
    #[msg("Signer is not the admin")]
    Unauthorized,
    #[msg("No pending admin, or signer is not the pending admin")]
    NotPendingAdmin,
    #[msg("No parameter change is queued")]
    NothingQueued,
    #[msg("Queued change is not yet executable")]
    TimelockNotElapsed,
    #[msg("Borrowing is paused on this market")]
    BorrowPaused,
    #[msg("Deposit cap reached")]
    DepositCapExceeded,
    #[msg("Borrow cap reached")]
    BorrowCapExceeded,
    #[msg("Per-account borrow cap reached")]
    AccountBorrowCapExceeded,
    #[msg("Borrow would push utilization above the market maximum")]
    UtilizationTooHigh,
    #[msg("Not enough liquidity in the market")]
    InsufficientLiquidity,
    #[msg("Not enough collateral")]
    InsufficientCollateral,
    #[msg("Position would exceed the borrow limit")]
    BorrowLimitExceeded,
    #[msg("Position is healthy and cannot be liquidated")]
    PositionHealthy,
    #[msg("Repay amount is above what may be liquidated")]
    RepayTooLarge,
    #[msg("Position still has debt or collateral")]
    ObligationNotEmpty,
    #[msg("Oracle accounts do not match the market")]
    OracleAccountMismatch,
    #[msg("Oracle account has the wrong owner")]
    OracleWrongOwner,
    #[msg("Oracle account data is invalid")]
    OracleInvalidData,
    #[msg("Price history does not cover the required window")]
    OracleWindowTooShort,
    #[msg("Oracle price is zero")]
    OracleZeroPrice,
    #[msg("Unsupported oracle kind for these mints")]
    UnsupportedOracle,
    #[msg("Not enough protocol fees")]
    InsufficientFees,
    #[msg("Token-2022 mints may only carry metadata extensions")]
    UnsupportedMint,
    #[msg("No treasury has been set")]
    TreasuryNotSet,
    #[msg("Account is not in the expected old layout")]
    NotMigratable,
    #[msg("The stake pool hasn't updated for this epoch yet; try again shortly")]
    StakePoolNotUpdated,
}

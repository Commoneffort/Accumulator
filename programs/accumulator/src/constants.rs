use anchor_lang::prelude::*;

/// Fixed-point scale for indexes and prices.
pub const WAD: u128 = 1_000_000_000_000_000_000;
pub const BPS: u128 = 10_000;
pub const SECONDS_PER_YEAR: u128 = 31_536_000;

pub const CONFIG_SEED: &[u8] = b"config";
pub const MARKET_SEED: &[u8] = b"market";
pub const LIQUIDITY_VAULT_SEED: &[u8] = b"liquidity";
pub const COLLATERAL_VAULT_SEED: &[u8] = b"collateral";
pub const SHARE_MINT_SEED: &[u8] = b"shares";
pub const OBLIGATION_SEED: &[u8] = b"obligation";

/// Shortest allowed delay between queuing and applying risk changes.
/// Mainnet configs should use far more (e.g. 2 days); the floor keeps tests fast.
pub const MIN_TIMELOCK_SECONDS: i64 = 60;

/// XDEX AMM (Raydium CP-swap layout). XDEX runs a separate program on testnet;
/// build with `--features testnet` for that network.
#[cfg(not(feature = "testnet"))]
pub const XDEX_PROGRAM_ID: Pubkey = pubkey!("sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN");
#[cfg(feature = "testnet")]
pub const XDEX_PROGRAM_ID: Pubkey = pubkey!("7EEuq61z9VKdkUzj7G36xGd7ncyz8KBtUwAWVjypYQHf");
/// X1 fork of the SPL stake pool program.
pub const X1_STAKE_POOL_PROGRAM_ID: Pubkey = pubkey!("XPoo1Fx6KNgeAzFcq2dPTo95bWGUSj5KdPVqYj9CZux");
/// Wrapped native XNT (same address as wSOL).
pub const NATIVE_MINT: Pubkey = pubkey!("So11111111111111111111111111111111111111112");

/// TWAP window bounds. XDEX keeps 100 snapshots at least 15s apart, so a busy
/// pool may only cover 25 minutes of history.
pub const MIN_TWAP_WINDOW: u32 = 300;
pub const MAX_TWAP_WINDOW: u32 = 1_500;

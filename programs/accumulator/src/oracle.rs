//! Prices without a price feed.
//!
//! * Stake pool markets value pXNT by the pool's own exchange rate.
//! * XDEX markets use the pool's on-chain price history (Raydium CP-swap
//!   layout): a time-weighted average that can't be moved inside one transaction.
//!
//! All prices are WAD-scaled "lend raw units per collateral raw unit".

use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::AccumulatorError;
use crate::state::{Market, OracleKind};

// ---- X1 stake pool layout (x1-labs/stake-pool: leading `version: u8`) ----
const SP_ACCOUNT_TYPE: usize = 1;
const SP_POOL_MINT: usize = 163;
const SP_TOTAL_LAMPORTS: usize = 259;
const SP_POOL_TOKEN_SUPPLY: usize = 267;
const SP_LAST_UPDATE_EPOCH: usize = 275;
const SP_ACCOUNT_TYPE_STAKE_POOL: u8 = 1;

// ---- XDEX pool layout ----
pub const XDEX_POOL_LEN: usize = 637;
const XP_VAULT_0: usize = 72;
const XP_VAULT_1: usize = 104;
const XP_MINT_0: usize = 168;
const XP_MINT_1: usize = 200;
const XP_OBSERVATION: usize = 296;
const XP_PROTOCOL_FEES_0: usize = 341;
const XP_PROTOCOL_FEES_1: usize = 349;
const XP_FUND_FEES_0: usize = 357;
const XP_FUND_FEES_1: usize = 365;

// ---- XDEX observation layout ----
pub const XDEX_OBSERVATION_LEN: usize = 4075;
const XO_INITIALIZED: usize = 8;
const XO_INDEX: usize = 9;
const XO_POOL: usize = 11;
const XO_OBSERVATIONS: usize = 43;
const XO_ENTRY_LEN: usize = 40;
pub const XO_COUNT: usize = 100;

// ---- SPL token account layout (Token and Token-2022 share the base) ----
const TA_MINT: usize = 0;
const TA_AMOUNT: usize = 64;

fn read_u64(d: &[u8], at: usize) -> Result<u64> {
    let b = d.get(at..at + 8).ok_or(AccumulatorError::OracleInvalidData)?;
    Ok(u64::from_le_bytes(b.try_into().unwrap()))
}
fn read_u128(d: &[u8], at: usize) -> Result<u128> {
    let b = d.get(at..at + 16).ok_or(AccumulatorError::OracleInvalidData)?;
    Ok(u128::from_le_bytes(b.try_into().unwrap()))
}
fn read_key(d: &[u8], at: usize) -> Result<Pubkey> {
    let b = d.get(at..at + 32).ok_or(AccumulatorError::OracleInvalidData)?;
    Ok(Pubkey::new_from_array(b.try_into().unwrap()))
}

/// pXNT -> XNT rate from stake pool data, after checking the pool mint.
pub fn stake_pool_price(data: &[u8], expected_mint: &Pubkey) -> Result<u128> {
    require!(
        data.get(SP_ACCOUNT_TYPE) == Some(&SP_ACCOUNT_TYPE_STAKE_POOL),
        AccumulatorError::OracleInvalidData
    );
    require!(read_key(data, SP_POOL_MINT)? == *expected_mint, AccumulatorError::OracleAccountMismatch);
    let lamports = read_u64(data, SP_TOTAL_LAMPORTS)? as u128;
    let supply = read_u64(data, SP_POOL_TOKEN_SUPPLY)? as u128;
    require!(lamports > 0 && supply > 0, AccumulatorError::OracleZeroPrice);
    Ok(lamports.checked_mul(WAD).ok_or(AccumulatorError::MathOverflow)? / supply)
}

pub struct XdexPool {
    pub vault_0: Pubkey,
    pub vault_1: Pubkey,
    pub mint_0: Pubkey,
    pub mint_1: Pubkey,
    pub observation: Pubkey,
    pub fees_0: u64,
    pub fees_1: u64,
}

pub fn parse_xdex_pool(d: &[u8]) -> Result<XdexPool> {
    require!(d.len() == XDEX_POOL_LEN, AccumulatorError::OracleInvalidData);
    Ok(XdexPool {
        vault_0: read_key(d, XP_VAULT_0)?,
        vault_1: read_key(d, XP_VAULT_1)?,
        mint_0: read_key(d, XP_MINT_0)?,
        mint_1: read_key(d, XP_MINT_1)?,
        observation: read_key(d, XP_OBSERVATION)?,
        fees_0: read_u64(d, XP_PROTOCOL_FEES_0)?
            .checked_add(read_u64(d, XP_FUND_FEES_0)?)
            .ok_or(AccumulatorError::MathOverflow)?,
        fees_1: read_u64(d, XP_PROTOCOL_FEES_1)?
            .checked_add(read_u64(d, XP_FUND_FEES_1)?)
            .ok_or(AccumulatorError::MathOverflow)?,
    })
}

/// Token account (mint, amount).
pub fn parse_token_account(d: &[u8]) -> Result<(Pubkey, u64)> {
    Ok((read_key(d, TA_MINT)?, read_u64(d, TA_AMOUNT)?))
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Observation {
    pub ts: u64,
    pub cum_0: u128,
    pub cum_1: u128,
}

// Heap, not stack: 100 snapshots are 4KB, the whole SBF stack frame.
pub fn parse_observations(d: &[u8], pool: &Pubkey) -> Result<(usize, Vec<Observation>)> {
    require!(d.len() == XDEX_OBSERVATION_LEN, AccumulatorError::OracleInvalidData);
    require!(d[XO_INITIALIZED] == 1, AccumulatorError::OracleInvalidData);
    require!(read_key(d, XO_POOL)? == *pool, AccumulatorError::OracleAccountMismatch);
    let index = u16::from_le_bytes([d[XO_INDEX], d[XO_INDEX + 1]]) as usize;
    require!(index < XO_COUNT, AccumulatorError::OracleInvalidData);
    let mut obs = Vec::with_capacity(XO_COUNT);
    for i in 0..XO_COUNT {
        let at = XO_OBSERVATIONS + i * XO_ENTRY_LEN;
        obs.push(Observation {
            ts: read_u64(d, at)?,
            cum_0: read_u128(d, at + 8)?,
            cum_1: read_u128(d, at + 24)?,
        });
    }
    Ok((index, obs))
}

/// Spot prices in Q32, exactly as XDEX records them:
/// token 0 priced in token 1, and token 1 priced in token 0.
pub fn spot_q32(amount_0: u64, amount_1: u64) -> Result<(u128, u128)> {
    require!(amount_0 > 0 && amount_1 > 0, AccumulatorError::OracleZeroPrice);
    let a0 = amount_0 as u128;
    let a1 = amount_1 as u128;
    Ok(((a1 << 32) / a0, (a0 << 32) / a1))
}

/// Time-weighted average of token 0's (or token 1's) price over `window`
/// seconds ending at `now`, in WAD. The stretch since the newest snapshot is
/// filled in at the current spot price, the same way XDEX would record it.
pub fn twap_wad(
    newest: usize,
    obs: &[Observation],
    spot_0_q32: u128,
    spot_1_q32: u128,
    now: u64,
    window: u64,
    token0: bool,
) -> Result<u128> {
    let last = *obs.get(newest).ok_or(AccumulatorError::OracleInvalidData)?;
    require!(last.ts > 0, AccumulatorError::OracleWindowTooShort);
    let target = now.saturating_sub(window);

    // Newest snapshot at or before the window start; else the oldest one.
    let mut start: Option<Observation> = None;
    let mut oldest: Option<Observation> = None;
    for o in obs.iter().filter(|o| o.ts > 0) {
        if o.ts <= target && start.map_or(true, |s| o.ts > s.ts) {
            start = Some(*o);
        }
        if oldest.map_or(true, |s| o.ts < s.ts) {
            oldest = Some(*o);
        }
    }
    let start = match start {
        Some(s) => s,
        None => {
            // History shorter than the window: accept it only if it covers half.
            let o = oldest.ok_or(AccumulatorError::OracleWindowTooShort)?;
            require!(now.saturating_sub(o.ts) >= window / 2, AccumulatorError::OracleWindowTooShort);
            o
        }
    };

    let (last_cum, start_cum, spot) = if token0 {
        (last.cum_0, start.cum_0, spot_0_q32)
    } else {
        (last.cum_1, start.cum_1, spot_1_q32)
    };
    // The stretch since the newest snapshot has no recorded price. XDEX writes a
    // snapshot at most every 15s, so a pump-borrow-unwind inside one transaction
    // records nothing: the current spot can't be trusted here. Keep the tail
    // within 2% of the latest recorded interval; real moves show up as soon as
    // the next snapshot is written (any swap 15s+ after the last one does that).
    let prev = obs.iter().filter(|o| o.ts > 0 && o.ts < last.ts).max_by_key(|o| o.ts).copied();
    let tail_price = match prev {
        Some(pv) => {
            let (pc, lc) = if token0 { (pv.cum_0, last.cum_0) } else { (pv.cum_1, last.cum_1) };
            let reference = lc.wrapping_sub(pc) / (last.ts - pv.ts) as u128;
            spot.clamp(reference * 98 / 100, reference * 102 / 100)
        }
        None => spot,
    };
    let tail = now.saturating_sub(last.ts) as u128;
    let cum_now = last_cum.wrapping_add(tail_price.wrapping_mul(tail));
    let dt = now.saturating_sub(start.ts) as u128;
    require!(dt > 0, AccumulatorError::OracleWindowTooShort);
    let avg_q32 = cum_now.wrapping_sub(start_cum) / dt;
    let price = avg_q32.checked_mul(WAD).ok_or(AccumulatorError::MathOverflow)? >> 32;
    require!(price > 0, AccumulatorError::OracleZeroPrice);
    Ok(price)
}

/// Which price a check needs.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum PriceUse {
    /// Opening risk (borrow, withdraw collateral): the lower of TWAP and spot,
    /// so a pump can't raise the borrow limit.
    Borrow,
    /// Liquidation: TWAP only, so a sudden dump can't force liquidations.
    Liquidate,
}

/// Reads the collateral price for `market` from `accounts`, which must be the
/// market's oracle accounts in order.
pub fn collateral_price(
    market: &Market,
    accounts: &[AccountInfo],
    now: i64,
    usage: PriceUse,
) -> Result<u128> {
    match market.oracle_kind {
        OracleKind::StakePool => {
            let pool = accounts.first().ok_or(AccumulatorError::OracleAccountMismatch)?;
            require_keys_eq!(pool.key(), market.oracle_accounts[0], AccumulatorError::OracleAccountMismatch);
            require_keys_eq!(*pool.owner, X1_STAKE_POOL_PROGRAM_ID, AccumulatorError::OracleWrongOwner);
            let data = pool.try_borrow_data()?;
            // The rate only moves when the pool runs its per-epoch update. Until that runs in a new
            // epoch the old rate still shows, which would let a known loss be borrowed against before
            // it lands. New risk waits for the update (usually minutes); liquidations never wait.
            if usage == PriceUse::Borrow {
                let updated = read_u64(&data, SP_LAST_UPDATE_EPOCH)?;
                require!(updated >= Clock::get()?.epoch, AccumulatorError::StakePoolNotUpdated);
            }
            stake_pool_price(&data, &market.collateral_mint)
        }
        OracleKind::XdexTwap => {
            require!(accounts.len() >= 4, AccumulatorError::OracleAccountMismatch);
            for i in 0..4 {
                require_keys_eq!(accounts[i].key(), market.oracle_accounts[i], AccumulatorError::OracleAccountMismatch);
            }
            let (pool_ai, obs_ai, v0_ai, v1_ai) = (&accounts[0], &accounts[1], &accounts[2], &accounts[3]);
            require_keys_eq!(*pool_ai.owner, XDEX_PROGRAM_ID, AccumulatorError::OracleWrongOwner);
            require_keys_eq!(*obs_ai.owner, XDEX_PROGRAM_ID, AccumulatorError::OracleWrongOwner);

            let pool = parse_xdex_pool(&pool_ai.try_borrow_data()?)?;
            check_xdex_accounts(market, &pool, pool_ai.key, obs_ai.key, v0_ai.key, v1_ai.key)?;

            let (m0, a0) = parse_token_account(&v0_ai.try_borrow_data()?)?;
            let (m1, a1) = parse_token_account(&v1_ai.try_borrow_data()?)?;
            require_keys_eq!(m0, pool.mint_0, AccumulatorError::OracleAccountMismatch);
            require_keys_eq!(m1, pool.mint_1, AccumulatorError::OracleAccountMismatch);
            let net_0 = a0.checked_sub(pool.fees_0).ok_or(AccumulatorError::OracleInvalidData)?;
            let net_1 = a1.checked_sub(pool.fees_1).ok_or(AccumulatorError::OracleInvalidData)?;
            let (s0, s1) = spot_q32(net_0, net_1)?;

            let (newest, obs) = parse_observations(&obs_ai.try_borrow_data()?, pool_ai.key)?;
            let now_u = u64::try_from(now).map_err(|_| AccumulatorError::MathOverflow)?;
            let twap = twap_wad(
                newest,
                &obs,
                s0,
                s1,
                now_u,
                market.params.twap_window_secs as u64,
                market.collateral_is_token0,
            )?;
            match usage {
                PriceUse::Liquidate => Ok(twap),
                PriceUse::Borrow => {
                    let spot_q32 = if market.collateral_is_token0 { s0 } else { s1 };
                    let spot = spot_q32.checked_mul(WAD).ok_or(AccumulatorError::MathOverflow)? >> 32;
                    Ok(twap.min(spot))
                }
            }
        }
    }
}

/// The pool must pair exactly the market's two mints, and the passed
/// observation and vaults must be the pool's own.
pub fn check_xdex_accounts(
    market: &Market,
    pool: &XdexPool,
    _pool_key: &Pubkey,
    obs_key: &Pubkey,
    v0_key: &Pubkey,
    v1_key: &Pubkey,
) -> Result<()> {
    require_keys_eq!(pool.observation, *obs_key, AccumulatorError::OracleAccountMismatch);
    require_keys_eq!(pool.vault_0, *v0_key, AccumulatorError::OracleAccountMismatch);
    require_keys_eq!(pool.vault_1, *v1_key, AccumulatorError::OracleAccountMismatch);
    let (coll, lend) = if market.collateral_is_token0 {
        (pool.mint_0, pool.mint_1)
    } else {
        (pool.mint_1, pool.mint_0)
    };
    require_keys_eq!(coll, market.collateral_mint, AccumulatorError::OracleAccountMismatch);
    require_keys_eq!(lend, market.lend_mint, AccumulatorError::OracleAccountMismatch);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const Q32: u128 = 1 << 32;

    /// Builds a price history where token 0 traded at `price_q32` (token 1 per
    /// token 0) from `start` with a snapshot every `step` seconds.
    fn history(start: u64, step: u64, prices_q32: &[u128]) -> (usize, Vec<Observation>) {
        let mut obs = vec![Observation::default(); XO_COUNT];
        let mut cum0 = 0u128;
        let mut cum1 = 0u128;
        for (i, p) in prices_q32.iter().enumerate() {
            obs[i] = Observation { ts: start + step * i as u64, cum_0: cum0, cum_1: cum1 };
            cum0 = cum0.wrapping_add(p * step as u128);
            cum1 = cum1.wrapping_add((Q32 * Q32 / p) * step as u128);
        }
        (prices_q32.len() - 1, obs)
    }

    fn q32(price: f64) -> u128 {
        (price * Q32 as f64) as u128
    }

    #[test]
    fn mainnet_snapshot_matches_spot() {
        // From the XNT/USDC.x pool on Oct 23, 2026: TWAP 0.0002453 raw (= $0.245)
        let p = q32(0.000_245_3);
        let (n, obs) = history(1_000, 60, &[p; 40]);
        let now = obs[n].ts + 10;
        let w = twap_wad(n, &obs, p, Q32 * Q32 / p, now, 1_200, true).unwrap();
        let usd = w as f64 / WAD as f64 * 1_000.0; // 9 vs 6 decimals
        assert!((usd - 0.2453).abs() < 0.0001, "{usd}");
    }

    #[test]
    fn same_transaction_pump_barely_moves_twap() {
        // Flat price for 20 minutes, then the attacker pumps spot 10x right now.
        let p = q32(0.000_25);
        let (n, obs) = history(10_000, 15, &[p; 100]);
        let now = obs[n].ts + 14; // pumped 14s after the last snapshot (no new one yet)
        let pumped = p * 10;
        let w = twap_wad(n, &obs, pumped, Q32 * Q32 / pumped, now, 1_200, true).unwrap();
        let base = p * WAD >> 32;
        // 14s of a 1200s window at 10x -> about +10.5%
        assert!(w < base * 112 / 100, "twap {w} vs base {base}");
    }

    #[test]
    fn same_transaction_mega_pump_cannot_move_twap() {
        // Audit finding: a snapshot was written <15s ago, so a pump-borrow-unwind in one
        // transaction writes none. A 1000x spot must not move the 20-minute average.
        let p = q32(0.000_25);
        let (n, obs) = history(10_000, 15, &[p; 100]);
        let now = obs[n].ts + 14;
        let pumped = p * 1_000;
        let w = twap_wad(n, &obs, pumped, Q32 * Q32 / pumped, now, 1_200, true).unwrap();
        let base = p * WAD >> 32;
        assert!(w < base * 103 / 100, "twap moved {}x", w as f64 / base as f64);
        // and a 1000x dump can't push it down much either
        let dumped = p / 1_000;
        let w = twap_wad(n, &obs, dumped, Q32 * Q32 / dumped, now, 1_200, true).unwrap();
        assert!(w > base * 97 / 100, "twap fell to {}x", w as f64 / base as f64);
    }

    #[test]
    fn a_pump_held_for_the_whole_window_shows_up() {
        // If the attacker holds 2x for the full window (paying arbitrage the whole
        // time), the TWAP does reach it, which is why LTV is 50%.
        let p = q32(0.000_25);
        let mut prices = vec![p; 20];
        prices.extend(vec![p * 2; 80]);
        let (n, obs) = history(10_000, 15, &prices);
        let now = obs[n].ts;
        let w = twap_wad(n, &obs, p * 2, Q32 * Q32 / (p * 2), now, 1_185, true).unwrap();
        let base = p * WAD >> 32;
        assert!(w > base * 19 / 10);
    }

    #[test]
    fn quiet_pool_uses_spot_for_the_gap() {
        // One old snapshot, no swaps since: price is the spot price.
        let p = q32(0.000_2);
        let (n, obs) = history(1_000, 15, &[p, p]);
        let now = 100_000;
        let w = twap_wad(n, &obs, p, Q32 * Q32 / p, now, 1_200, true).unwrap();
        assert_eq!(w, p * WAD >> 32);
    }

    #[test]
    fn short_history_is_rejected() {
        let p = q32(0.000_2);
        let (n, obs) = history(1_000, 15, &[p, p]);
        // only 25s of history against a 1200s window
        assert!(twap_wad(n, &obs, p, Q32 * Q32 / p, 1_025, 1_200, true).is_err());
    }

    #[test]
    fn token1_side_is_the_inverse() {
        let p = q32(0.000_25);
        let (n, obs) = history(1_000, 60, &[p; 30]);
        let now = obs[n].ts;
        let w1 = twap_wad(n, &obs, p, Q32 * Q32 / p, now, 1_200, false).unwrap();
        let expect = 4_000.0;
        let got = w1 as f64 / WAD as f64;
        assert!((got - expect).abs() / expect < 0.001, "{got}");
    }

    #[test]
    fn cumulative_wraparound_is_handled() {
        let p = q32(0.000_25);
        let (n, mut obs) = history(1_000, 60, &[p; 30]);
        // shift every cumulative so the sums wrap past u128::MAX
        for o in obs.iter_mut() {
            o.cum_0 = o.cum_0.wrapping_add(u128::MAX - 1_000);
        }
        let now = obs[n].ts;
        let w = twap_wad(n, &obs, p, Q32 * Q32 / p, now, 1_200, true).unwrap();
        assert_eq!(w, p * WAD >> 32);
    }

    #[test]
    fn spot_matches_xdex_formula() {
        // Mainnet vaults net of fees: 17,031.64 XNT and 4,227.46 USDC.x
        let (s0, _) = spot_q32(17_031_640_000_000, 4_227_460_000).unwrap();
        let usd = (s0 as f64 / Q32 as f64) * 1_000.0;
        assert!((usd - 0.2482).abs() < 0.0001, "{usd}");
    }

    #[test]
    fn stake_pool_rate_reads_x1_layout() {
        let mint = Pubkey::new_unique();
        let mut d = vec![0u8; 877];
        d[0] = 1; // version
        d[SP_ACCOUNT_TYPE] = 1;
        d[SP_POOL_MINT..SP_POOL_MINT + 32].copy_from_slice(mint.as_ref());
        d[SP_TOTAL_LAMPORTS..SP_TOTAL_LAMPORTS + 8].copy_from_slice(&340_297_882_383_446_300u64.to_le_bytes());
        d[SP_POOL_TOKEN_SUPPLY..SP_POOL_TOKEN_SUPPLY + 8].copy_from_slice(&341_112_431_205_900_670u64.to_le_bytes());
        let p = stake_pool_price(&d, &mint).unwrap();
        let r = p as f64 / WAD as f64;
        assert!((r - 0.997_612).abs() < 0.000_001, "{r}");
        // wrong mint is refused
        assert!(stake_pool_price(&d, &Pubkey::new_unique()).is_err());
    }
}

//! Pure accounting math. Everything here is unit-tested without a validator.

use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::AccumulatorError;
use crate::state::{Market, MarketParams};

pub fn mul_div(a: u128, b: u128, c: u128) -> Result<u128> {
    require!(c > 0, AccumulatorError::MathOverflow);
    Ok(a.checked_mul(b).ok_or(AccumulatorError::MathOverflow)? / c)
}

pub fn mul_div_ceil(a: u128, b: u128, c: u128) -> Result<u128> {
    require!(c > 0, AccumulatorError::MathOverflow);
    let p = a.checked_mul(b).ok_or(AccumulatorError::MathOverflow)?;
    Ok(p / c + if p % c == 0 { 0 } else { 1 })
}

pub fn to_u64(v: u128) -> Result<u64> {
    u64::try_from(v).map_err(|_| error!(AccumulatorError::MathOverflow))
}

/// Utilization in bps = borrows / (cash + borrows).
pub fn utilization_bps(borrows: u128, cash: u128) -> Result<u128> {
    let total = cash.checked_add(borrows).ok_or(AccumulatorError::MathOverflow)?;
    if total == 0 {
        return Ok(0);
    }
    mul_div(borrows, BPS, total)
}

/// Annual borrow rate in bps: a two-slope curve that turns steep past the kink,
/// so high utilization pulls borrowed funds back and lenders can exit.
pub fn borrow_rate_bps(p: &MarketParams, util_bps: u128) -> Result<u128> {
    let opt = p.optimal_utilization_bps as u128;
    let base = p.base_rate_bps as u128;
    let s1 = p.slope1_bps as u128;
    let s2 = p.slope2_bps as u128;
    if util_bps <= opt {
        Ok(base + mul_div(s1, util_bps, opt)?)
    } else {
        let excess = util_bps.min(BPS) - opt;
        Ok(base + s1 + mul_div(s2, excess, BPS - opt)?)
    }
}

impl Market {
    pub fn total_borrows(&self) -> Result<u128> {
        mul_div_ceil(self.total_borrow_scaled, self.borrow_index, WAD)
    }

    /// What lenders own: cash plus outstanding borrows, minus protocol fees.
    pub fn lender_assets(&self) -> Result<u128> {
        Ok((self.cash as u128 + self.total_borrows()?).saturating_sub(self.protocol_fees as u128))
    }

    pub fn utilization_bps(&self) -> Result<u128> {
        utilization_bps(self.total_borrows()?, self.cash as u128)
    }

    /// Compound interest since the last accrual into the borrow index.
    pub fn accrue(&mut self, now: i64) -> Result<()> {
        if now <= self.last_accrual_ts {
            return Ok(());
        }
        let dt = (now - self.last_accrual_ts) as u128;
        self.last_accrual_ts = now;
        if self.total_borrow_scaled == 0 {
            return Ok(());
        }
        let before = self.total_borrows()?;
        let rate = borrow_rate_bps(&self.params, utilization_bps(before, self.cash as u128)?)?;
        // growth = rate * dt / year, as a WAD fraction
        let growth = mul_div(rate * WAD / BPS, dt, SECONDS_PER_YEAR)?;
        self.borrow_index = mul_div(self.borrow_index, WAD + growth, WAD)?;
        let after = self.total_borrows()?;
        let interest = after.saturating_sub(before);
        let fee = mul_div(interest, self.params.reserve_factor_bps as u128, BPS)?;
        self.protocol_fees = to_u64(self.protocol_fees as u128 + fee)?;
        Ok(())
    }

    /// Debt of a position, rounded up in the protocol's favor.
    pub fn debt_of(&self, scaled: u128) -> Result<u128> {
        mul_div_ceil(scaled, self.borrow_index, WAD)
    }

    /// Scaled units added for a new borrow (rounded up).
    pub fn scaled_for_borrow(&self, amount: u128) -> Result<u128> {
        mul_div_ceil(amount, WAD, self.borrow_index)
    }

    /// Scaled units removed for a repayment (rounded down).
    pub fn scaled_for_repay(&self, amount: u128) -> Result<u128> {
        mul_div(amount, WAD, self.borrow_index)
    }
}

/// Shares minted for a deposit. The +1 offsets stop share-price games on an
/// empty market; donations can't move the price because `cash` is internal.
pub fn shares_for_deposit(amount: u128, assets: u128, supply: u128) -> Result<u128> {
    mul_div(amount, supply + 1, assets + 1)
}

/// Assets paid out for burning shares (rounded down).
pub fn assets_for_shares(shares: u128, assets: u128, supply: u128) -> Result<u128> {
    mul_div(shares, assets + 1, supply + 1)
}

/// Value of collateral in lend units: amount * price / WAD.
pub fn collateral_value(amount: u128, price_wad: u128) -> Result<u128> {
    mul_div(amount, price_wad, WAD)
}

/// True when debt <= value * limit_bps.
pub fn within_limit(debt: u128, value: u128, limit_bps: u16) -> Result<bool> {
    Ok(debt.checked_mul(BPS).ok_or(AccumulatorError::MathOverflow)?
        <= value.checked_mul(limit_bps as u128).ok_or(AccumulatorError::MathOverflow)?)
}

/// LTV a liquidation restores a position to: halfway between the borrow limit
/// and the liquidation threshold, so it is safe again with a buffer.
pub fn liquidation_target_bps(p: &MarketParams) -> u128 {
    (p.max_ltv_bps as u128 + p.liquidation_threshold_bps as u128) / 2
}

/// Most a liquidator may repay in one call: only enough to bring the position
/// back to the target LTV, and never more than the close factor, unless the
/// debt is dust, which can be cleared in full.
///
/// Solving (V - R(1+b)) * T = D - R for R gives R = (D - V*T) / (1 - (1+b)T).
pub fn max_liquidation_repay(debt: u128, value: u128, p: &MarketParams) -> Result<u128> {
    if debt <= p.dust_debt as u128 {
        return Ok(debt);
    }
    let l = liquidation_target_bps(p);
    let b = p.liquidation_bonus_bps as u128;
    let vl = mul_div(value, l, BPS)?;
    let needed = if debt > vl {
        // scale numerator and denominator by BPS^2
        let num = (debt - vl).checked_mul(BPS * BPS).ok_or(AccumulatorError::MathOverflow)?;
        let den = BPS * BPS - (BPS + b) * l;
        num / den + 1
    } else {
        0
    };
    let close = mul_div_ceil(debt, p.close_factor_bps as u128, BPS)?;
    Ok(needed.min(close).min(debt).max(1))
}

/// Collateral paid to a liquidator for repaying `repay`: repay * (1+bonus) / price.
pub fn seize_for_repay(repay: u128, price_wad: u128, bonus_bps: u16) -> Result<u128> {
    let with_bonus = mul_div(repay, BPS + bonus_bps as u128, BPS)?;
    mul_div(with_bonus, WAD, price_wad)
}

/// Protocol's cut of a liquidation: `fee_bps` of the bonus part of `seize`.
/// The bonus part is seize * bonus / (1 + bonus); rounded down so the
/// liquidator never gets less than the fee formula implies.
pub fn liquidation_fee(seize: u128, bonus_bps: u16, fee_bps: u16) -> Result<u128> {
    let bonus_part = mul_div(seize, bonus_bps as u128, BPS + bonus_bps as u128)?;
    mul_div(bonus_part, fee_bps as u128, BPS)
}

/// Inverse of `seize_for_repay`: debt that `collateral` covers at the bonus.
pub fn repay_for_seize(collateral: u128, price_wad: u128, bonus_bps: u16) -> Result<u128> {
    let value = collateral_value(collateral, price_wad)?;
    mul_div(value, BPS, BPS + bonus_bps as u128)
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use crate::state::OracleKind;

    pub fn params() -> MarketParams {
        MarketParams {
            max_ltv_bps: 5_000,
            liquidation_threshold_bps: 6_500,
            liquidation_bonus_bps: 500,
            close_factor_bps: 5_000,
            reserve_factor_bps: 1_000,
            optimal_utilization_bps: 8_500,
            max_utilization_bps: 9_500,
            base_rate_bps: 0,
            slope1_bps: 800,
            slope2_bps: 30_000,
            deposit_cap: u64::MAX,
            borrow_cap: u64::MAX,
            max_borrow_per_obligation: u64::MAX,
            dust_debt: 1_000,
            twap_window_secs: 1_200,
            liquidation_fee_bps: 1_000,
        }
    }

    pub fn market() -> Market {
        Market {
            config: Pubkey::default(),
            lend_mint: Pubkey::default(),
            lend_token_program: Pubkey::default(),
            lend_decimals: 9,
            collateral_mint: Pubkey::default(),
            collateral_token_program: Pubkey::default(),
            collateral_decimals: 9,
            liquidity_vault: Pubkey::default(),
            collateral_vault: Pubkey::default(),
            share_mint: Pubkey::default(),
            oracle_kind: OracleKind::StakePool,
            oracle_accounts: [Pubkey::default(); 4],
            collateral_is_token0: false,
            params: params(),
            pending_params: params(),
            pending_eta: 0,
            has_pending: false,
            borrow_paused: false,
            cash: 0,
            total_borrow_scaled: 0,
            borrow_index: WAD,
            protocol_fees: 0,
            last_accrual_ts: 0,
            total_collateral: 0,
            cumulative_bad_debt: 0,
            bump: 0,
            liquidity_vault_bump: 0,
            collateral_vault_bump: 0,
            share_mint_bump: 0,
            protocol_collateral_fees: 0,
        }
    }

    #[test]
    fn default_params_are_valid() {
        params().validate().unwrap();
    }

    #[test]
    fn rejects_unsafe_params() {
        let mut p = params();
        p.max_ltv_bps = 7_000; // above liquidation threshold
        assert!(p.validate().is_err());
        let mut p = params();
        p.liquidation_threshold_bps = 9_600;
        p.liquidation_bonus_bps = 500; // 1.05 * 0.96 > 1
        assert!(p.validate().is_err());
        let mut p = params();
        p.optimal_utilization_bps = 10_000;
        assert!(p.validate().is_err());
    }

    #[test]
    fn rate_curve_has_a_kink() {
        let p = params();
        assert_eq!(borrow_rate_bps(&p, 0).unwrap(), 0);
        assert_eq!(borrow_rate_bps(&p, 8_500).unwrap(), 800);
        // halfway past the kink: 800 + 30000 * 750/1500
        assert_eq!(borrow_rate_bps(&p, 9_250).unwrap(), 800 + 15_000);
        assert_eq!(borrow_rate_bps(&p, 10_000).unwrap(), 30_800);
    }

    #[test]
    fn interest_accrues_and_fees_split() {
        let mut m = market();
        m.cash = 500_000_000_000;
        m.total_borrow_scaled = 500_000_000_000; // 50% utilization
        m.accrue(SECONDS_PER_YEAR as i64).unwrap();
        // rate at 50% = 800 * 5000/8500 = 470 bps -> ~4.70% simple over one step
        let debt = m.total_borrows().unwrap();
        let interest = debt - 500_000_000_000;
        assert!(interest > 23_400_000_000 && interest < 23_600_000_000, "{interest}");
        assert_eq!(m.protocol_fees as u128, interest / 10);
        // lenders gain interest minus fees
        let assets = m.lender_assets().unwrap();
        assert_eq!(assets, 1_000_000_000_000 + interest - interest / 10);
    }

    #[test]
    fn accrual_is_noop_without_borrows_or_time() {
        let mut m = market();
        m.cash = 10;
        m.accrue(100).unwrap();
        assert_eq!(m.borrow_index, WAD);
        m.accrue(50).unwrap(); // clock going back does nothing
        assert_eq!(m.last_accrual_ts, 100);
    }

    #[test]
    fn shares_round_trip_never_profits() {
        let assets = 1_000_000u128;
        let supply = 999_000u128;
        let s = shares_for_deposit(12_345, assets, supply).unwrap();
        let back = assets_for_shares(s, assets + 12_345, supply + s).unwrap();
        assert!(back <= 12_345);
    }

    #[test]
    fn first_depositor_cannot_inflate() {
        // attacker deposits 1, then nobody can donate (cash is internal),
        // so a second deposit gets fair shares.
        let s1 = shares_for_deposit(1, 0, 0).unwrap();
        assert_eq!(s1, 1);
        let s2 = shares_for_deposit(1_000_000, 1, s1).unwrap();
        assert_eq!(s2, 1_000_000);
    }

    #[test]
    fn debt_rounds_against_borrower() {
        let mut m = market();
        m.borrow_index = WAD + WAD / 3;
        let scaled = m.scaled_for_borrow(100).unwrap();
        assert!(m.debt_of(scaled).unwrap() >= 100);
        let repaid = m.scaled_for_repay(100).unwrap();
        assert!(repaid <= scaled);
    }

    #[test]
    fn liquidation_restores_to_target_ltv() {
        let p = params();
        // collateral value 1000, debt 660 -> 66% LTV, just above 65% threshold
        let value = 1_000_000u128;
        let debt = 660_000u128;
        let r = max_liquidation_repay(debt, value, &p).unwrap();
        let price = WAD; // 1:1 for the check
        let seized = seize_for_repay(r, price, p.liquidation_bonus_bps).unwrap();
        let new_debt = debt - r;
        let new_value = value - seized;
        // ends at (or just under) the 57.5% target, between limit and threshold
        assert!(within_limit(new_debt, new_value, 5_750).unwrap());
        assert!(!within_limit(new_debt + 2_000, new_value, 5_750).unwrap());
        // and repays less than the 50% close factor
        assert!(r < debt / 2);
    }

    #[test]
    fn liquidation_capped_by_close_factor() {
        let p = params();
        // deeply underwater: debt 950 vs value 1000
        let r = max_liquidation_repay(950_000, 1_000_000, &p).unwrap();
        assert_eq!(r, 475_000);
    }

    #[test]
    fn dust_can_be_cleared() {
        let p = params();
        assert_eq!(max_liquidation_repay(900, 1_000, &p).unwrap(), 900);
    }

    #[test]
    fn seize_and_repay_are_inverse() {
        let price = 245_000_000_000_000u128; // 0.000245 USDC raw per XNT raw
        let seized = seize_for_repay(1_000_000, price, 500).unwrap();
        let repay = repay_for_seize(seized, price, 500).unwrap();
        assert!(repay <= 1_000_000 && repay >= 999_999);
    }

    #[test]
    fn liquidation_fee_is_a_share_of_the_bonus_only() {
        // 1_000 repaid at a 5% bonus seizes 1_050: 50 of that is bonus, 10% of it = 5 goes to the protocol.
        assert_eq!(liquidation_fee(1_050, 500, 1_000).unwrap(), 5);
        // No fee setting, no fee.
        assert_eq!(liquidation_fee(1_050, 500, 0).unwrap(), 0);
        // The fee can never exceed the bonus, so the liquidator always gets at least the debt's worth.
        for seize in [1u128, 7, 1_050, 123_456_789, u64::MAX as u128] {
            let fee = liquidation_fee(seize, 2_000, 5_000).unwrap();
            let bonus = seize * 2_000 / 12_000;
            assert!(fee <= bonus, "fee {fee} > bonus {bonus}");
        }
    }
}

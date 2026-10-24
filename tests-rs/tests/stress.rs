//! Agent-based stress tests: the compiled Accumulator program in LiteSVM, driven by
//! bots through adverse markets. Prints a report and writes
//! fixtures/stress-report.json.
//!
//!   cargo test --release --test stress -- --ignored --nocapture
//!
//! The XDEX pool is a real constant-product AMM (0.25% fee) that records
//! price snapshots exactly like XDEX: before a swap, at most every 15 seconds,
//! into a 100-entry ring. Bots:
//!   * arbitrageur  pulls the pool price toward an outside "fair" price path,
//!                  closing a set share of the gap per minute (weak when XNT
//!                  has few markets, strong when it has many)
//!   * borrowers    open at 25-49% LTV; half are active and defend their
//!                  position (add collateral / repay) when health drops
//!   * lenders      deposit USDC; may run for the exits
//!   * liquidator   liquidates when the program allows it AND it is profitable
//!                  after selling the seized XNT into the pool
//!   * attacker     pumps the pool, holds, borrows against inflated XNT, walks
#![allow(deprecated, clippy::too_many_arguments)]

mod common;

use common::*;
use accumulator::constants::{NATIVE_MINT, WAD};
use accumulator::math::{collateral_value, liquidation_fee, max_liquidation_repay, seize_for_repay, within_limit};
use accumulator::state::{MarketParams, OracleKind};
use solana_sdk::{account::Account, pubkey::Pubkey, signature::{Keypair, Signer}};
use std::fmt::Write as _;

const FEE_BPS: u128 = 25;

// ------------------------------------------------------------------ RNG

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn f(&mut self) -> f64 {
        (self.next() % 1_000_000) as f64 / 1_000_000.0
    }
    fn range(&mut self, a: f64, b: f64) -> f64 {
        a + (b - a) * self.f()
    }
    fn gauss(&mut self) -> f64 {
        let (u, v) = (self.f().max(1e-9), self.f());
        (-2.0 * u.ln()).sqrt() * (std::f64::consts::TAU * v).cos()
    }
}

// ------------------------------------------------------------------ AMM

/// Constant-product pool, token 0 = XNT (9 dp), token 1 = USDC (6 dp).
struct Amm {
    x: u128,
    y: u128,
    obs: Vec<(u64, u128, u128)>,
    idx: usize,
}

impl Amm {
    fn new(x: u128, y: u128, now: u64) -> Self {
        // 100 snapshots a minute apart, flat at the opening price
        let mut a = Amm { x, y, obs: vec![(0, 0, 0); 100], idx: 99 };
        let (p0, p1) = a.q32();
        for i in 0..100u64 {
            let t = now - 60 * (99 - i);
            a.obs[i as usize] = (t, p0 * 60 * i as u128, p1 * 60 * i as u128);
        }
        a
    }
    fn q32(&self) -> (u128, u128) {
        ((self.y << 32) / self.x, (self.x << 32) / self.y)
    }
    /// USDC per XNT
    fn price(&self) -> f64 {
        (self.y as f64 / 1e6) / (self.x as f64 / 1e9)
    }
    /// XDEX records the pre-swap price, at most once every 15 seconds.
    fn observe(&mut self, t: u64) {
        let last = self.obs[self.idx];
        if t < last.0 + 15 {
            return;
        }
        let (p0, p1) = self.q32();
        let dt = (t - last.0) as u128;
        self.idx = (self.idx + 1) % 100;
        self.obs[self.idx] = (t, last.1.wrapping_add(p0 * dt), last.2.wrapping_add(p1 * dt));
    }
    fn quote_x_in(&self, dx: u128) -> u128 {
        let e = dx * (10_000 - FEE_BPS) / 10_000;
        self.y * e / (self.x + e)
    }
    fn swap_x_in(&mut self, dx: u128, t: u64) -> u128 {
        self.observe(t);
        let dy = self.quote_x_in(dx);
        self.x += dx;
        self.y -= dy;
        dy
    }
    fn swap_y_in(&mut self, dy: u128, t: u64) -> u128 {
        self.observe(t);
        let e = dy * (10_000 - FEE_BPS) / 10_000;
        let dx = self.x * e / (self.y + e);
        self.y += dy;
        self.x -= dx;
        dx
    }
    /// Trade so the price closes `strength` of the (log) gap to `target`.
    /// Returns USDC the trader paid (negative = received).
    fn move_toward(&mut self, target: f64, strength: f64, t: u64) -> f64 {
        let p = self.price();
        if (p / target - 1.0).abs() < 0.002 {
            return 0.0;
        }
        let goal = p * (target / p).powf(strength);
        let k = self.x as f64 * self.y as f64;
        let goal_raw = goal * 1e6 / 1e9; // USDC raw per XNT raw
        let x_new = (k / goal_raw).sqrt();
        if x_new > self.x as f64 {
            let dy = self.swap_x_in((x_new - self.x as f64) as u128, t);
            -(dy as f64 / 1e6)
        } else {
            let y_new = k / x_new;
            let dy = (y_new - self.y as f64).max(1.0) as u128;
            self.swap_y_in(dy, t);
            dy as f64 / 1e6
        }
    }
    fn write(&self, h: &mut H, xd: &Xdex) {
        xd.set_reserves(h, self.x as u64, self.y as u64);
        let mut d = vec![0u8; accumulator::oracle::XDEX_OBSERVATION_LEN];
        d[8] = 1;
        d[9..11].copy_from_slice(&(self.idx as u16).to_le_bytes());
        d[11..43].copy_from_slice(xd.pool.as_ref());
        for (i, (ts, c0, c1)) in self.obs.iter().enumerate() {
            let at = 43 + i * 40;
            d[at..at + 8].copy_from_slice(&ts.to_le_bytes());
            d[at + 8..at + 24].copy_from_slice(&c0.to_le_bytes());
            d[at + 24..at + 40].copy_from_slice(&c1.to_le_bytes());
        }
        h.svm
            .set_account(xd.observation, Account { lamports: 30_000_000, data: d, owner: accumulator::constants::XDEX_PROGRAM_ID, executable: false, rent_epoch: 0 })
            .unwrap();
    }
}

// ---------------------------------------------------------------- world

struct Borrower {
    kp: Keypair,
    xnt: Pubkey,
    usdc: Pubkey,
    active: bool,
    spare_xnt: u64,
}
impl Borrower {
    fn usdc_ata(&self) -> Pubkey {
        self.usdc
    }
}

#[derive(Default, Clone)]
struct Stats {
    liquidations: u32,
    skipped_unprofitable: u32,
    defended: u32,
    liquidator_spent_usd: f64,
    liquidator_got_usd: f64,
    max_util: f64,
    max_twap_gap: f64,
    worst_insolvency_usd: f64,
    failed_txs: u32,
}

struct Lender {
    kp: Keypair,
    usdc: Pubkey,
    shares: Pubkey,
    deposited: u64,
}

struct World {
    lenders: Vec<Lender>,
    h: H,
    xd: Xdex,
    amm: Amm,
    usdc: Pubkey,
    m: Pubkey,
    borrowers: Vec<Borrower>,
    liq: Keypair,
    liq_usdc: Pubkey,
    liq_xnt: Pubkey,
    deposits: u64,
    window: u64,
    initial_debt: u64,
    st: Stats,
    rng: Rng,
}

fn usdc_params(borrow_cap_usd: u64) -> MarketParams {
    MarketParams {
        max_ltv_bps: 5_000,
        liquidation_threshold_bps: 6_500,
        liquidation_bonus_bps: 500,
        close_factor_bps: 5_000,
        reserve_factor_bps: 1_000,
        optimal_utilization_bps: 8_000,
        max_utilization_bps: 9_000,
        base_rate_bps: 0,
        slope1_bps: 800,
        slope2_bps: 20_000,
        deposit_cap: 10 * borrow_cap_usd * USD + 10_000 * USD,
        borrow_cap: borrow_cap_usd * USD,
        max_borrow_per_obligation: (borrow_cap_usd / 4).max(250) * USD,
        dust_debt: USD,
        twap_window_secs: 1_200,
        liquidation_fee_bps: 1_000,
    }
}

struct Setup {
    pool_xnt: u64,
    price: f64,
    borrow_cap_usd: u64,
    lend_usd: u64,
    borrowers: usize,
    seed: u64,
    liquidator_usd: u64,
    ltv: (f64, f64),
    /// (max LTV bps, liquidation threshold bps, TWAP window secs)
    risk: (u16, u16, u32),
    /// liquidation bonus bps
    bonus: u16,
    /// protocol share of the bonus, bps
    liq_fee: u16,
}

impl Default for Setup {
    fn default() -> Self {
        // mainnet today: ~17k XNT / ~$4.2k in the pool; launch caps
        Setup { pool_xnt: 17_000, price: 0.25, borrow_cap_usd: 1_000, lend_usd: 5_000, borrowers: 20, seed: 7, liquidator_usd: 5_000, ltv: (0.5, 0.98), risk: (5_000, 6_500, 1_200), bonus: 500, liq_fee: 1_000 }
    }
}

impl World {
    fn new(s: Setup) -> World {
        let mut h = H::new();
        let admin = h.payer.insecure_clone();
        let usdc = h.create_mint(6, TOKEN22);
        let xd = Xdex::new(&mut h, NATIVE_MINT, usdc, TOKEN, TOKEN22);
        let x = s.pool_xnt as u128 * 1_000_000_000;
        let y = (s.pool_xnt as f64 * s.price * 1e6) as u128;
        let amm = Amm::new(x, y, h.now as u64);
        amm.write(&mut h, &xd);
        h.must(&[h.ix_init_config(&admin.pubkey(), 3_600)], &[&admin]);
        let mut params = usdc_params(s.borrow_cap_usd);
        params.max_ltv_bps = s.risk.0;
        params.liquidation_threshold_bps = s.risk.1;
        params.twap_window_secs = s.risk.2;
        params.liquidation_bonus_bps = s.bonus;
        params.liquidation_fee_bps = s.liq_fee;
        let ix = h.ix_create_market(&admin.pubkey(), usdc, NATIVE_MINT, TOKEN22, TOKEN, params, OracleKind::XdexTwap, true, &xd.accounts());
        h.must(&[ix], &[&admin]);
        let m = market_pda(&usdc, &NATIVE_MINT);

        // lenders
        let lend = s.lend_usd.min(params.deposit_cap / USD);
        let mut lenders = vec![];
        for _ in 0..4 {
            let l = h.user(10 * XNT);
            let amt = lend / 4 * USD;
            let lu = h.mint_to(&usdc, &l.pubkey(), amt, TOKEN22);
            let sm = h.market(&m).share_mint;
            let ls = h.ata(&l.pubkey(), &sm, TOKEN22);
            h.must(&[h.ix_deposit(&m, &l.pubkey(), lu, ls, amt)], &[&l]);
            lenders.push(Lender { kp: l, usdc: lu, shares: ls, deposited: amt });
        }

        let s = Setup { ..s };
        let mut w = World {
            lenders,
            h,
            xd,
            amm,
            usdc,
            m,
            borrowers: vec![],
            liq: Keypair::new(),
            liq_usdc: Pubkey::default(),
            liq_xnt: Pubkey::default(),
            deposits: lend * USD,
            window: s.risk.2 as u64,
            initial_debt: 0,
            st: Stats::default(),
            rng: Rng(s.seed),
        };
        let liq = w.h.user(1_000 * XNT);
        w.liq_usdc = w.h.mint_to(&usdc, &liq.pubkey(), s.liquidator_usd * USD, TOKEN22);
        w.liq_xnt = w.h.ata(&liq.pubkey(), &NATIVE_MINT, TOKEN);
        w.liq = liq;

        // borrowers open positions until the caps bind
        let price = w.twap();
        for i in 0..s.borrowers {
            // borrowers sit at the given share of the market's borrow limit
            let ltv = w.rng.range(s.ltv.0, s.ltv.1) * params.max_ltv_bps as f64 / 10_000.0;
            // size collateral so the per-account cap doesn't dilute the LTV
            let cap_usd = params.max_borrow_per_obligation as f64 / 1e6;
            let coll_xnt = (w.rng.range(0.3, 1.0) * cap_usd / ltv / s.price).max(200.0) as u64;
            let kp = w.h.user((coll_xnt * 2 + 100) * XNT);
            let xnt = w.h.wrap(&kp, coll_xnt * XNT);
            let usdc_ata = w.h.ata(&kp.pubkey(), &usdc, TOKEN22);
            w.h.must(&[w.h.ix_open(&m, &kp.pubkey()), w.h.ix_deposit_collateral(&m, &kp.pubkey(), xnt, coll_xnt * XNT)], &[&kp]);
            let value = collateral_value(coll_xnt as u128 * XNT as u128, price.min(w.spot())).unwrap();
            let want = ((value as f64 * ltv) as u64).min(params.max_borrow_per_obligation);
            let room = {
                let mk = w.h.market(&m);
                let used = mk.total_borrows().unwrap() as u64;
                params.borrow_cap.saturating_sub(used).min(mk.cash * 9 / 10)
            };
            let amt = want.min(room);
            if amt > USD {
                let ix = w.h.ix_borrow(&m, &kp.pubkey(), usdc_ata, amt);
                if w.h.send(&[ix], &[&kp]).is_err() {
                    w.st.failed_txs += 1;
                }
            }
            w.initial_debt = w.h.market(&m).total_borrows().unwrap() as u64;
            w.borrowers.push(Borrower { kp, xnt, usdc: usdc_ata, active: i % 2 == 0, spare_xnt: coll_xnt });
        }
        w
    }

    fn twap(&self) -> u128 {
        self.xd.twap(&self.h, self.window, true)
    }
    fn spot(&self) -> u128 {
        let (s0, _) = accumulator::oracle::spot_q32(self.amm.x as u64, self.amm.y as u64).unwrap();
        s0 * WAD >> 32
    }
    fn usd(w: u128) -> f64 {
        w as f64 / WAD as f64 * 1e3
    }

    /// One tick: time passes, arbitrage trades, borrowers react, liquidator acts.
    fn step(&mut self, dt: i64, fair: f64, arb_per_min: f64, liquidator_on: bool) {
        self.h.advance(dt);
        let t = self.h.now as u64;
        if arb_per_min > 0.0 {
            let s = 1.0 - (1.0 - arb_per_min).powf(dt as f64 / 60.0);
            self.amm.move_toward(fair, s.min(1.0), t);
        }
        self.amm.write(&mut self.h, &self.xd);
        // anyone can accrue; bots do it each tick so debts reflect interest
        let p = self.h.payer.insecure_clone();
        let ix = self.h.ix_accrue(&self.m);
        self.h.must(&[ix], &[&p]);
        let twap = self.twap();
        self.st.max_twap_gap = self.st.max_twap_gap.max((Self::usd(twap) / fair - 1.0).abs());

        let mk = self.h.market(&self.m);
        let params = mk.params;
        let apr = accumulator::math::borrow_rate_bps(&params, mk.utilization_bps().unwrap()).unwrap() as f64 / 100.0;
        // borrowers
        for i in 0..self.borrowers.len() {
            let b = &self.borrowers[i];
            let ob = self.h.obligation(&self.m, &b.kp.pubkey());
            if ob.borrow_scaled == 0 || !b.active {
                continue;
            }
            let debt = mk.debt_of(ob.borrow_scaled).unwrap();
            // expensive money: active borrowers pay down 5% of debt per hour above 30% APR
            if apr > 30.0 {
                let pay = ((debt as f64 * 0.05 * dt as f64 / 3_600.0) as u64).min(self.h.balance(&b.usdc_ata()));
                if pay > USD / 10 {
                    let kp = b.kp.insecure_clone();
                    let owner = b.kp.pubkey();
                    let src = b.usdc_ata();
                    let ix = self.h.ix_repay(&self.m, &owner, &owner, src, pay);
                    let _ = self.h.send(&[ix], &[&kp]);
                }
            }
            let value = collateral_value(ob.collateral as u128, twap).unwrap();
            // defend below health 1.15 (debt above 56.5% of collateral)
            if !within_limit(debt, value, 5_650).unwrap() {
                let add = (ob.collateral / 3).min(b.spare_xnt * XNT);
                if add > XNT {
                    let kp = b.kp.insecure_clone();
                    let (xnt, owner) = (b.xnt, b.kp.pubkey());
                    let mut topup = vec![solana_sdk::system_instruction::transfer(&owner, &xnt, add)];
                    topup.push(anchor_spl::token::spl_token::instruction::sync_native(&TOKEN, &xnt).unwrap());
                    topup.push(self.h.ix_deposit_collateral(&self.m, &owner, xnt, add));
                    if self.h.send(&topup, &[&kp]).is_ok() {
                        self.borrowers[i].spare_xnt -= add / XNT;
                        self.st.defended += 1;
                    }
                }
            }
        }

        // liquidator
        if liquidator_on {
            for i in 0..self.borrowers.len() {
                let mk = self.h.market(&self.m);
                let owner = self.borrowers[i].kp.pubkey();
                let ob = self.h.obligation(&self.m, &owner);
                if ob.borrow_scaled == 0 {
                    continue;
                }
                let debt = mk.debt_of(ob.borrow_scaled).unwrap();
                let value = collateral_value(ob.collateral as u128, twap).unwrap();
                if within_limit(debt, value, params.liquidation_threshold_bps).unwrap() {
                    continue;
                }
                let max_repay = max_liquidation_repay(debt, value, &params).unwrap();
                let inv = self.h.balance(&self.liq_usdc) as u128;
                // largest chunk (max, 1/2, 1/4 ... 1/64) whose seized XNT sells for at
                // least the repay + 0.5%; smaller chunks lose less to slippage
                let mut chosen = None;
                for shift in 0..7 {
                    let mut repay = (max_repay >> shift).min(inv);
                    let mut seize = seize_for_repay(repay, twap, params.liquidation_bonus_bps).unwrap();
                    if seize > ob.collateral as u128 {
                        seize = ob.collateral as u128;
                        repay = accumulator::math::repay_for_seize(seize, twap, params.liquidation_bonus_bps).unwrap().min(inv);
                    }
                    if repay < USD as u128 / 10 {
                        break;
                    }
                    // the protocol keeps its share of the bonus; the liquidator sells only the rest
                    let take = seize - liquidation_fee(seize, params.liquidation_bonus_bps, params.liquidation_fee_bps).unwrap();
                    if self.amm.quote_x_in(take) * 1000 >= repay * 1005 {
                        chosen = Some(repay);
                        break;
                    }
                }
                let Some(repay) = chosen else {
                    self.st.skipped_unprofitable += 1;
                    continue;
                };
                let before_x = self.h.balance(&self.liq_xnt);
                let before_u = self.h.balance(&self.liq_usdc);
                let ix = self.h.ix_liquidate(&self.m, &owner, &self.liq.pubkey(), self.liq_usdc, self.liq_xnt, repay as u64, 0);
                let lk = self.liq.insecure_clone();
                if self.h.send(&[ix], &[&lk]).is_ok() {
                    let got_x = self.h.balance(&self.liq_xnt) - before_x;
                    let paid = before_u - self.h.balance(&self.liq_usdc);
                    let sold = self.amm.swap_x_in(got_x as u128, self.h.now as u64) as u64;
                    self.amm.write(&mut self.h, &self.xd);
                    // proceeds of the sale land in the liquidator's USDC account
                    let p = self.h.payer.insecure_clone();
                    let mint_ix = anchor_spl::token_2022::spl_token_2022::instruction::mint_to(&TOKEN22, &self.usdc, &self.liq_usdc, &p.pubkey(), &[], sold).unwrap();
                    self.h.must(&[mint_ix], &[&p]);
                    self.st.liquidations += 1;
                    self.st.liquidator_spent_usd += paid as f64 / 1e6;
                    self.st.liquidator_got_usd += sold as f64 / 1e6;
                } else {
                    self.st.failed_txs += 1;
                }
            }
        }

        let mk = self.h.market(&self.m);
        self.st.max_util = self.st.max_util.max(mk.utilization_bps().unwrap() as f64 / 100.0);
        let ins = self.insolvency(fair);
        self.st.worst_insolvency_usd = self.st.worst_insolvency_usd.max(ins);
    }

    /// Every lender tries to withdraw everything; returns the share of deposits that got out.
    fn bank_run(&mut self) -> f64 {
        let mut out = 0u64;
        for i in 0..self.lenders.len() {
            let mk = self.h.market(&self.m);
            let l = &self.lenders[i];
            let shares = self.h.balance(&l.shares);
            if shares == 0 {
                continue;
            }
            let supply = self.h.mint_supply(&mk.share_mint) as u128;
            let assets = mk.lender_assets().unwrap();
            let max_shares = ((mk.cash as u128) * (supply + 1) / (assets + 1)) as u64;
            let take = shares.min(max_shares.saturating_sub(1));
            if take == 0 {
                continue;
            }
            let (kp, la, ls) = (l.kp.insecure_clone(), l.usdc, l.shares);
            let before = self.h.balance(&la);
            let ix = self.h.ix_withdraw(&self.m, &kp.pubkey(), la, ls, take);
            if self.h.send(&[ix], &[&kp]).is_ok() {
                out += self.h.balance(&la) - before;
            }
        }
        out as f64 / self.lenders.iter().map(|l| l.deposited).sum::<u64>() as f64
    }

    /// Debt not covered by collateral at the fair price (what lenders would lose).
    fn insolvency(&self, fair: f64) -> f64 {
        let mk = self.h.market(&self.m);
        self.borrowers
            .iter()
            .map(|b| {
                let ob = self.h.obligation(&self.m, &b.kp.pubkey());
                let debt = mk.debt_of(ob.borrow_scaled).unwrap() as f64 / 1e6;
                let coll = ob.collateral as f64 / 1e9 * fair;
                (debt - coll).max(0.0)
            })
            .sum::<f64>()
            + mk.cumulative_bad_debt as f64 / 1e6
    }

    fn report(&self, name: &str, fair_end: f64) -> Row {
        let mk = self.h.market(&self.m);
        let debt = mk.total_borrows().unwrap() as f64 / 1e6;
        let unbacked = self.insolvency(fair_end) - mk.cumulative_bad_debt as f64 / 1e6;
        let lender_value = mk.cash as f64 / 1e6 + debt - unbacked - mk.protocol_fees as f64 / 1e6;
        let deposits = self.deposits as f64 / 1e6;
        Row {
            name: name.into(),
            lender_pnl_pct: (lender_value / deposits - 1.0) * 100.0,
            bad_debt_usd: mk.cumulative_bad_debt as f64 / 1e6 + unbacked,
            liquidations: self.st.liquidations,
            skipped: self.st.skipped_unprofitable,
            defended: self.st.defended,
            liq_profit_usd: self.st.liquidator_got_usd - self.st.liquidator_spent_usd,
            max_util: self.st.max_util,
            max_twap_gap_pct: self.st.max_twap_gap * 100.0,
            end_pool_price: self.amm.price(),
            open_debt_usd: debt,
            initial_debt_usd: self.initial_debt as f64 / 1e6,
            failed_txs: self.st.failed_txs,
        }
    }
}

#[derive(Clone)]
struct Row {
    name: String,
    lender_pnl_pct: f64,
    bad_debt_usd: f64,
    liquidations: u32,
    skipped: u32,
    defended: u32,
    liq_profit_usd: f64,
    max_util: f64,
    max_twap_gap_pct: f64,
    end_pool_price: f64,
    open_debt_usd: f64,
    initial_debt_usd: f64,
    failed_txs: u32,
}

/// Runs a price path. `fair(t)` is seconds since start -> USD per XNT.
fn run(name: &str, s: Setup, secs: i64, dt: i64, arb: f64, fair: impl Fn(i64) -> f64, liq_online: impl Fn(i64) -> bool) -> Row {
    if !name.starts_with("seed") { eprintln!("running: {name}"); }
    let mut w = World::new(s);
    let mut t = 0;
    while t < secs {
        t += dt;
        w.step(dt, fair(t), arb, liq_online(t));
    }
    w.report(name, fair(secs))
}

// ------------------------------------------------------------- attacks

struct Attack {
    name: String,
    pump: f64,
    hold_secs: i64,
    arb: f64,
    cap_usd: u64,
    attacker_pnl_usd: f64,
    borrowed_usd: f64,
    protocol_loss_usd: f64,
}

/// Attacker buys XNT to pump the pool `pump`x, keeps it there for `hold_secs`
/// against arbitrage, then borrows the maximum against XNT and never repays.
fn attack(pump: f64, hold_secs: i64, arb_per_min: f64, cap_usd: u64) -> Attack {
    eprintln!("attack: pump {pump}x hold {hold_secs}s");
    let mut w = World::new(Setup { borrowers: 0, borrow_cap_usd: cap_usd, lend_usd: cap_usd * 2, ..Default::default() });
    let fair = w.amm.price();
    let mut spent = 0.0f64; // USDC into the pool
    let mut xnt_bought = 0.0f64;
    let target = fair * pump;
    let dt = 15;
    let mut t = 0;
    // pump, then defend the pumped price every 15s against the arbitrageur
    loop {
        let p = w.amm.price();
        let k = w.amm.x as f64 * w.amm.y as f64;
        let x_new = (k / (target * 1e6 / 1e9)).sqrt();
        if x_new < w.amm.x as f64 {
            let dy = (k / x_new - w.amm.y as f64) as u128;
            let dx = w.amm.swap_y_in(dy, w.h.now as u64);
            spent += dy as f64 / 1e6;
            xnt_bought += dx as f64 / 1e9;
        }
        let _ = p;
        if t >= hold_secs {
            break;
        }
        w.h.advance(dt);
        t += dt;
        let s = 1.0 - (1.0 - arb_per_min).powf(dt as f64 / 60.0);
        w.amm.move_toward(fair, s, w.h.now as u64);
        w.amm.write(&mut w.h, &w.xd);
    }
    w.amm.write(&mut w.h, &w.xd);

    // borrow as much as the program allows, across as many accounts as the
    // market's total cap permits (per-account caps don't stop a determined attacker)
    let price = w.twap().min(w.spot());
    let params = w.h.market(&w.m).params;
    let need_value = params.max_borrow_per_obligation as u128 * 10_000 / params.max_ltv_bps as u128;
    let coll_each = (need_value * WAD / price) as u64 + XNT;
    let mut coll = 0u64;
    let mut total = 0u64;
    for _ in 0..64 {
        let kp = w.h.user(coll_each * 2 + 10_000 * XNT);
        let xnt = w.h.wrap(&kp, coll_each);
        let ua = w.h.ata(&kp.pubkey(), &w.usdc, TOKEN22);
        w.h.must(&[w.h.ix_open(&w.m, &kp.pubkey()), w.h.ix_deposit_collateral(&w.m, &kp.pubkey(), xnt, coll_each)], &[&kp]);
        coll += coll_each;
        // binary search the largest borrow that succeeds (probe on a copy of the chain)
        let (mut lo, mut hi) = (0u64, params.max_borrow_per_obligation);
        while hi - lo > USD / 100 {
            let mid = (lo + hi) / 2;
            let ix = w.h.ix_borrow(&w.m, &kp.pubkey(), ua, mid);
            let snapshot = w.h.svm.clone();
            let ok = w.h.send(&[ix], &[&kp]).is_ok();
            w.h.svm = snapshot;
            if ok { lo = mid } else { hi = mid }
        }
        if lo < USD {
            break;
        }
        let ix = w.h.ix_borrow(&w.m, &kp.pubkey(), ua, lo);
        w.h.must(&[ix], &[&kp]);
        total += lo;
    }
    let borrowed = total as f64 / 1e6;
    // unwind: sell the pumped XNT back into the pool
    let back = w.amm.swap_x_in((xnt_bought * 1e9) as u128, w.h.now as u64) as f64 / 1e6;
    let coll_value = coll as f64 / 1e9 * fair;
    let attacker_pnl = borrowed + back - spent - coll_value;
    let protocol_loss = (borrowed - coll_value).max(0.0);
    Attack {
        name: format!("pump {pump}x, hold {}m, arb {:.0}%/min, cap ${cap_usd}", hold_secs / 60, arb_per_min * 100.0),
        pump,
        hold_secs,
        arb: arb_per_min,
        cap_usd,
        attacker_pnl_usd: attacker_pnl,
        borrowed_usd: borrowed,
        protocol_loss_usd: protocol_loss,
    }
}

// ------------------------------------------------------ pXNT market stress

struct PxRow {
    name: String,
    bad_debt_xnt: f64,
    liquidations: u32,
    lender_pnl_pct: f64,
}

/// XNT / pXNT: no market price; risk is the stake pool rate falling
/// (validator losses) and interest outgrowing collateral at high utilization.
fn pxnt_scenario(name: &str, rate_path: impl Fn(i64) -> f64, secs: i64, dt: i64, util_target: f64) -> PxRow {
    let mut h = H::new();
    let admin = h.payer.insecure_clone();
    let pxnt = h.create_mint(9, TOKEN);
    let pool = Pubkey::new_unique();
    let supply = 1_000_000_000u64 * XNT;
    let set_rate = |h: &mut H, r: f64| h.set_stake_pool(pool, pxnt, (supply as f64 * r) as u64, supply);
    set_rate(&mut h, rate_path(0));
    h.must(&[h.ix_init_config(&admin.pubkey(), 3_600)], &[&admin]);
    let params = MarketParams {
        max_ltv_bps: 8_000,
        liquidation_threshold_bps: 8_500,
        liquidation_bonus_bps: 200,
        close_factor_bps: 5_000,
        reserve_factor_bps: 1_000,
        optimal_utilization_bps: 8_500,
        max_utilization_bps: 9_500,
        base_rate_bps: 0,
        slope1_bps: 600,
        slope2_bps: 10_000,
        deposit_cap: 500_000 * XNT,
        borrow_cap: 400_000 * XNT,
        max_borrow_per_obligation: 100_000 * XNT,
        dust_debt: XNT / 100,
        twap_window_secs: 0,
        liquidation_fee_bps: 1_000,
    };
    let ix = h.ix_create_market(&admin.pubkey(), NATIVE_MINT, pxnt, TOKEN, TOKEN, params, OracleKind::StakePool, false, &[pool]);
    h.must(&[ix], &[&admin]);
    let m = market_pda(&NATIVE_MINT, &pxnt);
    let lender = h.user(300_000 * XNT);
    let lx = h.wrap(&lender, 200_000 * XNT);
    let sm = h.market(&m).share_mint;
    let ls = h.ata(&lender.pubkey(), &sm, TOKEN);
    h.must(&[h.ix_deposit(&m, &lender.pubkey(), lx, ls, 200_000 * XNT)], &[&lender]);

    let mut rng = Rng(11);
    let mut bs = vec![];
    let target_debt = (200_000.0 * util_target) as u64;
    let mut opened = 0u64;
    while opened < target_debt {
        let coll = rng.range(2_000.0, 30_000.0) as u64;
        let ltv = rng.range(0.6, 0.79);
        let kp = h.user(10 * XNT);
        let pa = h.mint_to(&pxnt, &kp.pubkey(), coll * XNT, TOKEN);
        let xa = h.ata(&kp.pubkey(), &NATIVE_MINT, TOKEN);
        h.must(&[h.ix_open(&m, &kp.pubkey()), h.ix_deposit_collateral(&m, &kp.pubkey(), pa, coll * XNT)], &[&kp]);
        let amt = ((coll as f64 * rate_path(0) * ltv) as u64).min(target_debt - opened + 1).max(1) * XNT;
        if h.send(&[h.ix_borrow(&m, &kp.pubkey(), xa, amt)], &[&kp]).is_ok() {
            opened += amt / XNT;
        } else {
            break;
        }
        bs.push(kp);
    }
    let liq = h.user(1_000_000 * XNT);
    let lxnt = h.wrap(&liq, 500_000 * XNT);
    let lpx = h.ata(&liq.pubkey(), &pxnt, TOKEN);
    let mut liqs = 0u32;
    let mut t = 0;
    while t < secs {
        t += dt;
        h.advance(dt);
        let r = rate_path(t);
        set_rate(&mut h, r);
        let price = (r * WAD as f64) as u128;
        let ix = h.ix_accrue(&m);
        let p = h.payer.insecure_clone();
        h.must(&[ix], &[&p]);
        let mk = h.market(&m);
        for b in &bs {
            let ob = h.obligation(&m, &b.pubkey());
            if ob.borrow_scaled == 0 {
                continue;
            }
            let debt = mk.debt_of(ob.borrow_scaled).unwrap();
            if !within_limit(debt, collateral_value(ob.collateral as u128, price).unwrap(), 8_500).unwrap() {
                let ix = h.ix_liquidate(&m, &b.pubkey(), &liq.pubkey(), lxnt, lpx, debt as u64, 0);
                if h.send(&[ix], &[&liq]).is_ok() {
                    liqs += 1;
                }
            }
        }
    }
    let mk = h.market(&m);
    let r = rate_path(secs);
    let unbacked: f64 = bs
        .iter()
        .map(|b| {
            let ob = h.obligation(&m, &b.pubkey());
            (mk.debt_of(ob.borrow_scaled).unwrap() as f64 - ob.collateral as f64 * r).max(0.0) / 1e9
        })
        .sum();
    let bad = mk.cumulative_bad_debt as f64 / 1e9 + unbacked;
    let lender_value = mk.cash as f64 / 1e9 + mk.total_borrows().unwrap() as f64 / 1e9 - unbacked - mk.protocol_fees as f64 / 1e9;
    PxRow { name: name.into(), bad_debt_xnt: bad, liquidations: liqs, lender_pnl_pct: (lender_value / 200_000.0 - 1.0) * 100.0 }
}

// ------------------------------------------------------------- Loop pXNT

struct LoopSetup {
    /// loop only while the borrow rate after the step stays under the staking yield; unwind when it rises above
    rational: bool,
    /// stake pool rate multiplied by this on day 1 (validator losses)
    slash: Option<f64>,
    /// lenders try to withdraw everything every day from day 1
    lender_run: bool,
    days: i64,
    /// XNT lent into the market
    lent: u64,
}
impl Default for LoopSetup {
    fn default() -> Self {
        LoopSetup { rational: true, slash: None, lender_run: false, days: 90, lent: 200_000 }
    }
}

struct LoopRow {
    name: String,
    util: f64,
    borrow_apr: f64,
    supply_apy: f64,
    avg_leverage: f64,
    liquidated: u32,
    bad_debt_xnt: f64,
    interest_fees_xnt: f64,
    liq_fees_pxnt: f64,
    looper_return_pct: f64,
    lender_out_pct: f64,
}

struct Looper {
    kp: Keypair,
    xa: Pubkey,
    pa: Pubkey,
    equity: f64,
    target: f64,
    liquidated: bool,
}

const STAKE_APY: f64 = 0.058;
const POOL_FEE: f64 = 0.001;

/// Loopers stake, borrow and restake through the real program; the stake pool
/// itself is simulated (pXNT minted / XNT paid out at the pool rate less 0.1%).
fn loop_scenario(name: &str, s: LoopSetup) -> LoopRow {
    let mut h = H::new();
    let admin = h.payer.insecure_clone();
    let pxnt = h.create_mint(9, TOKEN);
    let pool = Pubkey::new_unique();
    let supply = 1_000_000_000u64 * XNT;
    let rate_at = |t: i64, slashed: bool| (1.0 + STAKE_APY).powf(t as f64 / 31_536_000.0) * if slashed { s.slash.unwrap_or(1.0) } else { 1.0 };
    let set_rate = |h: &mut H, r: f64| h.set_stake_pool(pool, pxnt, (supply as f64 * r) as u64, supply);
    set_rate(&mut h, 1.0);
    h.must(&[h.ix_init_config(&admin.pubkey(), 3_600)], &[&admin]);
    let params = MarketParams {
        max_ltv_bps: 8_000, liquidation_threshold_bps: 8_500, liquidation_bonus_bps: 200, close_factor_bps: 5_000,
        reserve_factor_bps: 1_000, optimal_utilization_bps: 8_500, max_utilization_bps: 9_500, base_rate_bps: 0,
        slope1_bps: 400, slope2_bps: 10_000, deposit_cap: 5_000_000 * XNT, borrow_cap: 4_000_000 * XNT,
        max_borrow_per_obligation: 100_000 * XNT, dust_debt: XNT / 100, twap_window_secs: 0, liquidation_fee_bps: 1_000,
    };
    let ix = h.ix_create_market(&admin.pubkey(), NATIVE_MINT, pxnt, TOKEN, TOKEN, params, OracleKind::StakePool, false, &[pool]);
    h.must(&[ix], &[&admin]);
    let m = market_pda(&NATIVE_MINT, &pxnt);
    let lent = s.lent;
    let lender = h.user((lent + 10) * XNT);
    let lx = h.wrap(&lender, lent * XNT);
    let sm = h.market(&m).share_mint;
    let ls = h.ata(&lender.pubkey(), &sm, TOKEN);
    h.must(&[h.ix_deposit(&m, &lender.pubkey(), lx, ls, lent * XNT)], &[&lender]);
    let sink = Pubkey::new_unique();
    let sink_x = h.ata(&sink, &NATIVE_MINT, TOKEN);

    let apr_at = |h: &H, extra: u128| {
        let mk = h.market(&m);
        let b = mk.total_borrows().unwrap() + extra;
        let cash = (mk.cash as u128).saturating_sub(extra);
        accumulator::math::borrow_rate_bps(&params, accumulator::math::utilization_bps(b, cash).unwrap()).unwrap() as f64 / 10_000.0
    };

    // --- 40 loopers open positions with their own XNT
    let mut rng = Rng(21);
    let mut ls_: Vec<Looper> = (0..40)
        .map(|_| {
            let equity = rng.range(2_000.0, 20_000.0);
            let target = rng.range(2.0, 4.0);
            let kp = h.user(10 * XNT);
            let p0 = (equity * (1.0 - POOL_FEE) * 1e9) as u64;
            let pa = h.mint_to(&pxnt, &kp.pubkey(), p0, TOKEN);
            let xa = h.ata(&kp.pubkey(), &NATIVE_MINT, TOKEN);
            h.must(&[h.ix_open(&m, &kp.pubkey()), h.ix_deposit_collateral(&m, &kp.pubkey(), pa, p0)], &[&kp]);
            Looper { kp, xa, pa, equity, target, liquidated: false }
        })
        .collect();

    // one loop step: borrow, "stake" (send the XNT to the pool, receive pXNT), post it
    let step = |h: &mut H, l: &Looper, rate: f64, rational: bool| -> bool {
        let mk = h.market(&m);
        let ob = h.obligation(&m, &l.kp.pubkey());
        let debt = mk.debt_of(ob.borrow_scaled).unwrap() as f64 / 1e9;
        let value = ob.collateral as f64 / 1e9 * rate;
        let want = l.equity * (l.target - 1.0) - debt;
        let room = value * 0.8 * 0.99 - debt;
        let b = want.min(room).min(l.equity);
        if b < 1.0 {
            return false;
        }
        let amt = (b * 1e9) as u64;
        if rational && apr_at(h, amt as u128) >= STAKE_APY {
            return false;
        }
        if h.send(&[h.ix_borrow(&m, &l.kp.pubkey(), l.xa, amt)], &[&l.kp]).is_err() {
            return false;
        }
        let t = anchor_spl::token::spl_token::instruction::transfer(&TOKEN, &l.xa, &sink_x, &l.kp.pubkey(), &[], amt).unwrap();
        h.must(&[t], &[&l.kp]);
        let p = (amt as f64 / rate * (1.0 - POOL_FEE)) as u64;
        let pa = h.mint_to(&pxnt, &l.kp.pubkey(), p, TOKEN);
        h.must(&[h.ix_deposit_collateral(&m, &l.kp.pubkey(), pa, p)], &[&l.kp]);
        true
    };
    // one unwind step: take out what the limit allows, redeem at the pool, repay
    let unwind = |h: &mut H, l: &Looper, rate: f64| {
        let mk = h.market(&m);
        let ob = h.obligation(&m, &l.kp.pubkey());
        let debt = mk.debt_of(ob.borrow_scaled).unwrap() as f64 / 1e9;
        if debt <= 0.0 {
            return;
        }
        let keep = debt / (rate * 0.8 * 0.99);
        let free = (ob.collateral as f64 / 1e9 - keep).max(0.0);
        let w = free.min(debt / (rate * (1.0 - POOL_FEE)) * 1.003);
        if w < 0.01 {
            return;
        }
        let wa = (w * 1e9) as u64;
        if h.send(&[h.ix_withdraw_collateral(&m, &l.kp.pubkey(), l.pa, wa, true)], &[&l.kp]).is_err() {
            return;
        }
        let got = (w * rate * (1.0 - POOL_FEE) * 1e9) as u64;
        h.svm.airdrop(&l.kp.pubkey(), got + XNT).unwrap();
        h.wrap(&l.kp, got);
        let _ = h.send(&[h.ix_repay(&m, &l.kp.pubkey(), &l.kp.pubkey(), l.xa, got)], &[&l.kp]);
    };

    for _round in 0..30 {
        let mut any = false;
        for l in &ls_ {
            any |= step(&mut h, l, 1.0, s.rational);
        }
        if !any {
            break;
        }
    }

    // --- run time forward
    let liq = h.user(2_000_000 * XNT);
    let lq = h.wrap(&liq, 1_000_000 * XNT);
    let lpx = h.ata(&liq.pubkey(), &pxnt, TOKEN);
    let (mut util_sum, mut apr_sum, mut n) = (0.0, 0.0, 0.0);
    let mut lender_out = 0u64;
    let dt = 6 * 3_600;
    let mut t = 0;
    while t < s.days * 86_400 {
        t += dt;
        h.advance(dt);
        let r = rate_at(t, t > 86_400);
        set_rate(&mut h, r);
        let p = h.payer.insecure_clone();
        h.must(&[h.ix_accrue(&m)], &[&p]);
        // liquidations
        let price = (r * WAD as f64) as u128;
        for l in ls_.iter_mut() {
            let mk = h.market(&m);
            let ob = h.obligation(&m, &l.kp.pubkey());
            if ob.borrow_scaled == 0 {
                continue;
            }
            let debt = mk.debt_of(ob.borrow_scaled).unwrap();
            if !within_limit(debt, collateral_value(ob.collateral as u128, price).unwrap(), 8_500).unwrap() {
                let ix = h.ix_liquidate(&m, &l.kp.pubkey(), &liq.pubkey(), lq, lpx, debt as u64, 0);
                if h.send(&[ix], &[&liq]).is_ok() {
                    l.liquidated = true;
                }
            }
        }
        // rational loopers unwind while borrowing costs more than staking pays
        if s.rational && apr_at(&h, 0) > STAKE_APY {
            for l in &ls_ {
                unwind(&mut h, l, r);
                if apr_at(&h, 0) <= STAKE_APY {
                    break;
                }
            }
        }
        if s.lender_run && t > 86_400 {
            let mk = h.market(&m);
            let shares = h.balance(&ls);
            let assets = accumulator::math::assets_for_shares(shares as u128, mk.lender_assets().unwrap(), h.mint_supply(&sm) as u128).unwrap();
            let take = (mk.cash as u128).min(assets);
            if take > XNT as u128 {
                let sh = (take * h.mint_supply(&sm) as u128 / (mk.lender_assets().unwrap() + 1)) as u64;
                let before = h.balance(&lx);
                if h.send(&[h.ix_withdraw(&m, &lender.pubkey(), lx, ls, sh.min(shares))], &[&lender]).is_ok() {
                    lender_out += h.balance(&lx) - before;
                }
            }
        }
        let mk = h.market(&m);
        util_sum += mk.utilization_bps().unwrap() as f64 / 100.0;
        apr_sum += apr_at(&h, 0);
        n += 1.0;
    }

    let mk = h.market(&m);
    let r = rate_at(s.days * 86_400, true);
    let mut unbacked = 0.0;
    let mut ret = vec![];
    let mut levs = vec![];
    for l in &ls_ {
        let ob = h.obligation(&m, &l.kp.pubkey());
        let debt = mk.debt_of(ob.borrow_scaled).unwrap() as f64 / 1e9;
        let value = ob.collateral as f64 / 1e9 * r * (1.0 - POOL_FEE);
        unbacked += (debt - value).max(0.0);
        ret.push(((value - debt).max(0.0) / l.equity - 1.0) * 100.0);
        if value > debt {
            levs.push(value / (value - debt));
        }
    }
    let bad = mk.cumulative_bad_debt as f64 / 1e9 + unbacked;
    let apr = apr_sum / n;
    let util = util_sum / n;
    let mean = |v: &Vec<f64>| if v.is_empty() { 0.0 } else { v.iter().sum::<f64>() / v.len() as f64 };
    LoopRow {
        name: name.into(),
        util,
        borrow_apr: apr * 100.0,
        supply_apy: apr * util / 100.0 * 0.9 * 100.0,
        avg_leverage: mean(&levs),
        liquidated: ls_.iter().filter(|l| l.liquidated).count() as u32,
        bad_debt_xnt: bad,
        interest_fees_xnt: mk.protocol_fees as f64 / 1e9,
        liq_fees_pxnt: mk.protocol_collateral_fees as f64 / 1e9,
        looper_return_pct: mean(&ret),
        lender_out_pct: lender_out as f64 / 1e9 / lent as f64 * 100.0,
    }
}

// ------------------------------------------------------------- the suite

#[test]
#[ignore]
fn stress_suite() {
    let day = 86_400;
    let p0 = 0.25;
    let mut rows = vec![];
    let always = |_t: i64| true;

    // --- price paths at launch settings (pool ~$8.5k, $1k borrow cap)
    rows.push(run("calm: 30 days random walk (60%/yr vol)", Setup::default(), 30 * day, 900, 0.3,
        |t| { let mut r = Rng(3); let mut p = p0; for _ in 0..(t / 900) { p *= (0.6 * (900.0f64 / 31_536_000.0).sqrt() * r.gauss()).exp(); } p }, always));
    rows.push(run("slow crash: -70% over 3 days", Setup::default(), 3 * day, 300, 0.3,
        |t| p0 * (1.0 - 0.7 * (t as f64 / (3 * day) as f64).min(1.0)), always));
    rows.push(run("fast crash: -50% in 1 hour, stays down", Setup::default(), 6 * 3_600, 60, 0.3,
        |t| if t < 3_600 { p0 * (1.0 - 0.5 * t as f64 / 3_600.0) } else { p0 * 0.5 }, always));
    rows.push(run("flash crash: -60% for 10 min, then recovers", Setup::default(), 2 * 3_600, 30, 0.5,
        |t| if (1_800..2_400).contains(&t) { p0 * 0.4 } else { p0 }, always));
    rows.push(run("capitulation: -85% in 2 hours, weak arbitrage", Setup::default(), 8 * 3_600, 60, 0.1,
        |t| p0 * (1.0 - 0.85 * (t as f64 / 7_200.0).min(1.0)), always));
    rows.push(run("crash -60% in 1h while liquidator offline 6h", Setup::default(), 12 * 3_600, 60, 0.3,
        |t| p0 * (1.0 - 0.6 * (t as f64 / 3_600.0).min(1.0)), |t| t > 6 * 3_600));
    rows.push(run("liquidity crunch: crash -60% with pool 5x thinner", Setup { pool_xnt: 3_400, ..Default::default() }, 6 * 3_600, 60, 0.3,
        |t| p0 * (1.0 - 0.6 * (t as f64 / 3_600.0).min(1.0)), always));
    rows.push(run("rate spiral: no repayments for 1 year at cap", Setup { lend_usd: 1_100, ..Default::default() }, 365 * day, 6 * 3_600, 0.3,
        |_| p0, always));
    // --- what if caps were raised before liquidity grows
    rows.push(run("caps 10x ($10k) + crash -60% in 1h", Setup { borrow_cap_usd: 10_000, lend_usd: 20_000, borrowers: 40, ..Default::default() }, 6 * 3_600, 60, 0.3,
        |t| p0 * (1.0 - 0.6 * (t as f64 / 3_600.0).min(1.0)), always));
    rows.push(run("caps 50x ($50k) + crash -60% in 1h", Setup { borrow_cap_usd: 50_000, lend_usd: 100_000, borrowers: 60, ..Default::default() }, 6 * 3_600, 60, 0.3,
        |t| p0 * (1.0 - 0.6 * (t as f64 / 3_600.0).min(1.0)), always));
    rows.push(run("pool 10x deeper, caps 10x + crash -60% in 1h", Setup { pool_xnt: 170_000, borrow_cap_usd: 10_000, lend_usd: 20_000, borrowers: 40, ..Default::default() }, 6 * 3_600, 60, 0.3,
        |t| p0 * (1.0 - 0.6 * (t as f64 / 3_600.0).min(1.0)), always));

    // --- worst case at launch caps: every borrower at 90-99.8% of the borrow limit (45-49.9% LTV)
    let edge = || Setup { ltv: (0.9, 0.998), ..Default::default() };
    rows.push(run("EDGE LTV, launch caps: fast crash -50% in 1h", edge(), 6 * 3_600, 60, 0.3,
        |t| if t < 3_600 { p0 * (1.0 - 0.5 * t as f64 / 3_600.0) } else { p0 * 0.5 }, always));
    rows.push(run("EDGE LTV, launch caps: capitulation -85% in 2h", edge(), 8 * 3_600, 60, 0.1,
        |t| p0 * (1.0 - 0.85 * (t as f64 / 7_200.0).min(1.0)), always));
    rows.push(run("EDGE LTV, launch caps: slow crash -70% over 3 days", edge(), 3 * day, 300, 0.3,
        |t| p0 * (1.0 - 0.7 * (t as f64 / (3 * day) as f64).min(1.0)), always));
    rows.push(run("EDGE LTV, launch caps: flash crash -60% for 10 min", edge(), 2 * 3_600, 30, 0.5,
        |t| if (1_800..2_400).contains(&t) { p0 * 0.4 } else { p0 }, always));
    rows.push(run("EDGE LTV, launch caps: -60% in 1h, liquidator off 6h", edge(), 12 * 3_600, 60, 0.3,
        |t| p0 * (1.0 - 0.6 * (t as f64 / 3_600.0).min(1.0)), |t| t > 6 * 3_600));

    // --- the same crash across 8 random markets, by cap size
    let mut sweep = vec![];
    for &(cap, risk) in &[
        (1_000u64, (5_000u16, 6_500u16, 1_200u32)), (5_000, (5_000, 6_500, 1_200)), (10_000, (5_000, 6_500, 1_200)), (25_000, (5_000, 6_500, 1_200)),
        (1_000, (4_000, 5_500, 1_200)), (5_000, (4_000, 5_500, 1_200)), (10_000, (4_000, 5_500, 1_200)),
        (1_000, (5_000, 6_500, 600)), (5_000, (5_000, 6_500, 600)),
    ] {
        let mut bad = vec![];
        let mut pnl = vec![];
        for seed in 1..=8u64 {
            let r = run(&format!("seed {seed}"), Setup { seed, borrow_cap_usd: cap, lend_usd: cap * 2, borrowers: 30, ltv: (0.6, 0.999), risk, ..Default::default() },
                6 * 3_600, 60, 0.3, |t| p0 * (1.0 - 0.6 * (t as f64 / 3_600.0).min(1.0)), always);
            bad.push(r.bad_debt_usd / r.initial_debt_usd.max(1.0) * 100.0);
            pnl.push(r.lender_pnl_pct);
        }
        let mean = |v: &Vec<f64>| v.iter().sum::<f64>() / v.len() as f64;
        let worst = |v: &Vec<f64>| v.iter().cloned().fold(f64::MIN, f64::max);
        let lowest = |v: &Vec<f64>| v.iter().cloned().fold(f64::MAX, f64::min);
        sweep.push((cap, risk, mean(&bad), worst(&bad), mean(&pnl), lowest(&pnl)));
    }

    // --- liquidation bonus: does a bigger bonus get liquidations going sooner in a fast crash?
    let mut bonus_sweep = vec![];
    for &cap in &[1_000u64, 5_000] {
        for &bonus in &[500u16, 800, 1_000, 1_200] {
            let (mut bad, mut pnl, mut liqs) = (vec![], vec![], 0u32);
            for seed in 1..=8u64 {
                let r = run(&format!("seed {seed}"), Setup { seed, borrow_cap_usd: cap, lend_usd: cap * 2, borrowers: 30, ltv: (0.6, 0.999), risk: (4_000, 5_500, 1_200), bonus, ..Default::default() },
                    6 * 3_600, 60, 0.3, |t| p0 * (1.0 - 0.6 * (t as f64 / 3_600.0).min(1.0)), always);
                bad.push(r.bad_debt_usd / r.initial_debt_usd.max(1.0) * 100.0);
                pnl.push(r.lender_pnl_pct);
                liqs += r.liquidations;
            }
            let mean = |v: &Vec<f64>| v.iter().sum::<f64>() / v.len() as f64;
            let worst = |v: &Vec<f64>| v.iter().cloned().fold(f64::MIN, f64::max);
            bonus_sweep.push((cap, bonus, mean(&bad), worst(&bad), mean(&pnl), liqs / 8));
        }
    }
    // --- protocol share of the bonus: does taking it slow liquidations down?
    let mut fee_sweep = vec![];
    for &cap in &[1_000u64, 5_000] {
        for &fee in &[0u16, 1_000, 2_500, 5_000] {
            let (mut bad, mut pnl, mut liqs, mut skip) = (vec![], vec![], 0u32, 0u32);
            for seed in 1..=8u64 {
                let r = run(&format!("seed {seed}"), Setup { seed, borrow_cap_usd: cap, lend_usd: cap * 2, borrowers: 30, ltv: (0.6, 0.999), risk: (4_000, 5_500, 1_200), bonus: 500, liq_fee: fee, ..Default::default() },
                    6 * 3_600, 60, 0.3, |t| p0 * (1.0 - 0.6 * (t as f64 / 3_600.0).min(1.0)), always);
                bad.push(r.bad_debt_usd / r.initial_debt_usd.max(1.0) * 100.0);
                pnl.push(r.lender_pnl_pct);
                liqs += r.liquidations;
                skip += r.skipped;
            }
            let mean = |v: &Vec<f64>| v.iter().sum::<f64>() / v.len() as f64;
            let worst = |v: &Vec<f64>| v.iter().cloned().fold(f64::MIN, f64::max);
            fee_sweep.push((cap, fee, mean(&bad), worst(&bad), mean(&pnl), liqs / 8, skip / 8));
        }
    }

    // --- bank run: every lender pulls out at once, at the caps' maximum utilization
    eprintln!("running: bank run");
    let mut bank = vec![];
    {
        let mut w = World::new(Setup { lend_usd: 1_150, borrowers: 30, ..Default::default() });
        let first = w.bank_run();
        let mut series = vec![(0i64, first)];
        let mut got = first;
        for hour in 1..=72 {
            w.step(3_600, p0, 0.3, true);
            got += w.bank_run();
            if [1, 6, 24, 72].contains(&hour) {
                series.push((hour, got));
            }
        }
        let mk = w.h.market(&w.m);
        let apr = accumulator::math::borrow_rate_bps(&mk.params, mk.utilization_bps().unwrap()).unwrap() as f64 / 100.0;
        bank.push((series, apr, mk.utilization_bps().unwrap() as f64 / 100.0));
    }

    // --- manipulation attacks
    let mut attacks = vec![];
    for &(pump, hold, arb, cap) in &[
        (2.0, 0, 0.3, 1_000), (2.0, 1_200, 0.3, 1_000), (3.0, 1_200, 0.3, 1_000), (5.0, 2_400, 0.1, 1_000),
        (3.0, 1_200, 0.1, 1_000), (3.0, 1_200, 0.1, 10_000), (5.0, 2_400, 0.1, 50_000),
        // very weak arbitrage (XNT has one market): where does an attack start to pay?
        (3.0, 1_200, 0.05, 5_000), (3.0, 1_200, 0.05, 10_000), (3.0, 1_200, 0.05, 20_000), (3.0, 1_200, 0.05, 40_000),
        (5.0, 1_200, 0.05, 20_000), (5.0, 1_200, 0.05, 40_000),
    ] {
        attacks.push(attack(pump, hold, arb, cap));
    }

    // --- XNT / pXNT market
    let px = vec![
        pxnt_scenario("validator loss: rate -5% at once", |t| if t > 3_600 { 1.0 * 0.95 } else { 1.0 }, 2 * 86_400, 3_600, 0.85),
        pxnt_scenario("validator loss: rate -20% at once", |t| if t > 3_600 { 0.8 } else { 1.0 }, 2 * 86_400, 3_600, 0.85),
        pxnt_scenario("validator loss: rate -30% at once", |t| if t > 3_600 { 0.7 } else { 1.0 }, 2 * 86_400, 3_600, 0.85),
        pxnt_scenario("interest spiral: 95% utilization for 2 years", |t| 1.0 + 0.07 * t as f64 / 31_536_000.0, 2 * 365 * 86_400, 86_400, 0.95),
    ];

    // --- Loop pXNT (leveraged staking) on the XNT / pXNT market
    let lp = vec![
        loop_scenario("rational loopers, 90 days", LoopSetup::default()),
        loop_scenario("validator loss -5% on day 1", LoopSetup { slash: Some(0.95), ..Default::default() }),
        loop_scenario("validator loss -10% on day 1", LoopSetup { slash: Some(0.90), ..Default::default() }),
        loop_scenario("validator loss -15% on day 1", LoopSetup { slash: Some(0.85), ..Default::default() }),
        loop_scenario("validator loss -25% on day 1", LoopSetup { slash: Some(0.75), ..Default::default() }),
        loop_scenario("lenders all withdraw from day 1", LoopSetup { lender_run: true, ..Default::default() }),
        loop_scenario("irrational loopers at the cap, 1 year", LoopSetup { rational: false, days: 365, ..Default::default() }),
        loop_scenario("irrational loopers + -10% loss", LoopSetup { rational: false, slash: Some(0.90), ..Default::default() }),
        loop_scenario("deep market (2M lent): loopers reach 2-4x", LoopSetup { lent: 2_000_000, ..Default::default() }),
        loop_scenario("deep market + -10% loss", LoopSetup { lent: 2_000_000, slash: Some(0.90), ..Default::default() }),
        loop_scenario("deep market + -15% loss", LoopSetup { lent: 2_000_000, slash: Some(0.85), ..Default::default() }),
        loop_scenario("deep market + -25% loss", LoopSetup { lent: 2_000_000, slash: Some(0.75), ..Default::default() }),
    ];

    // --- print + save
    let mut out = String::new();
    writeln!(out, "\nUSDC / XNT market (XDEX TWAP) — launch settings unless noted").unwrap();
    writeln!(out, "{:<48} {:>9} {:>9} {:>5} {:>5} {:>5} {:>8} {:>6} {:>7} {:>8}", "scenario", "lenders%", "baddebt$", "liqs", "skip", "def", "liq$", "util%", "twap±%", "debt$").unwrap();
    for r in &rows {
        writeln!(out, "{:<48} {:>9.2} {:>9.2} {:>5} {:>5} {:>5} {:>8.2} {:>6.1} {:>7.1} {:>8.0}",
            r.name, r.lender_pnl_pct, r.bad_debt_usd, r.liquidations, r.skipped, r.defended, r.liq_profit_usd, r.max_util, r.max_twap_gap_pct, r.open_debt_usd).unwrap();
    }
    writeln!(out, "\nCrash -60% in 1h, 8 random markets each (borrowers at 60-100% of their borrow limit; bad debt as % of loans made)").unwrap();
    writeln!(out, "{:>8} {:>16} {:>16} {:>16} {:>14} {:>14}", "cap $", "LTV/liq/window", "bad debt % mean", "bad debt % worst", "lenders % mean", "lenders % worst").unwrap();
    for (cap, r, m, w, pm, pw) in &sweep {
        writeln!(out, "{:>8} {:>16} {:>16.2} {:>16.2} {:>14.2} {:>14.2}", cap, format!("{}/{}/{}m", r.0 / 100, r.1 / 100, r.2 / 60), m, w, pm, pw).unwrap();
    }
    writeln!(out, "\nLiquidation bonus vs a -60%-in-1h crash (40/55 LTV, 8 markets each; bad debt as % of loans)").unwrap();
    writeln!(out, "{:>8} {:>7} {:>16} {:>16} {:>14} {:>10}", "cap $", "bonus", "bad debt % mean", "bad debt % worst", "lenders % mean", "liqs/run").unwrap();
    for (cap, b, m, w, p, l) in &bonus_sweep {
        writeln!(out, "{:>8} {:>6}% {:>16.2} {:>16.2} {:>14.2} {:>10}", cap, b / 100, m, w, p, l).unwrap();
    }
    for (series, apr, util) in &bank {
        writeln!(out, "\nBank run (lenders all withdraw; active borrowers repay above 30% APR)").unwrap();
        for (h, got) in series {
            writeln!(out, "  after {:>2}h: lenders have withdrawn {:>5.1}% of deposits", h, got * 100.0).unwrap();
        }
        writeln!(out, "  utilization after 72h {:.1}%, borrow APR {:.1}%", util, apr).unwrap();
    }
    writeln!(out, "\nManipulation: pump the pool, hold, borrow max across accounts, never repay").unwrap();
    writeln!(out, "{:<44} {:>10} {:>12} {:>12}", "attack", "borrowed$", "attacker P&L$", "protocol loss$").unwrap();
    for a in &attacks {
        writeln!(out, "{:<44} {:>10.2} {:>12.2} {:>12.2}", a.name, a.borrowed_usd, a.attacker_pnl_usd, a.protocol_loss_usd).unwrap();
    }
    writeln!(out, "\nXNT / pXNT market (stake pool rate)").unwrap();
    writeln!(out, "{:<44} {:>12} {:>6} {:>10}", "scenario", "baddebt XNT", "liqs", "lenders%").unwrap();
    for r in &px {
        writeln!(out, "{:<44} {:>12.2} {:>6} {:>10.2}", r.name, r.bad_debt_xnt, r.liquidations, r.lender_pnl_pct).unwrap();
    }
    writeln!(out, "\nLiquidation fee (protocol share of a 5% bonus) vs a -60%-in-1h crash (40/55 LTV, 8 markets each)").unwrap();
    writeln!(out, "{:>8} {:>7} {:>16} {:>16} {:>14} {:>10} {:>10}", "cap $", "fee", "bad debt % mean", "bad debt % worst", "lenders % mean", "liqs/run", "skips/run").unwrap();
    for (cap, f, m, w, p, l, k) in &fee_sweep {
        writeln!(out, "{:>8} {:>6}% {:>16.2} {:>16.2} {:>14.2} {:>10} {:>10}", cap, f / 100, m, w, p, l, k).unwrap();
    }
    writeln!(out, "\nLoop pXNT: 200k XNT lent unless noted, 40 loopers (2-20k XNT, target 2-4x), staking 5.8%/yr, 0.1% stake pool fee each way").unwrap();
    writeln!(out, "{:<40} {:>6} {:>7} {:>7} {:>6} {:>7} {:>9} {:>9} {:>9} {:>8} {:>9}", "scenario", "util%", "bAPR%", "sAPY%", "lever", "liqd", "baddebt", "fees XNT", "liqfee px", "looper%", "lenderOut").unwrap();
    for r in &lp {
        writeln!(out, "{:<40} {:>6.1} {:>7.2} {:>7.2} {:>6.2} {:>7} {:>9.2} {:>9.1} {:>9.2} {:>8.2} {:>8.1}%",
            r.name, r.util, r.borrow_apr, r.supply_apy, r.avg_leverage, r.liquidated, r.bad_debt_xnt, r.interest_fees_xnt, r.liq_fees_pxnt, r.looper_return_pct, r.lender_out_pct).unwrap();
    }
    println!("{out}");

    let json = serde_json::json!({
        "usdc_xnt": rows.iter().map(|r| serde_json::json!({
            "scenario": r.name, "lender_pnl_pct": r.lender_pnl_pct, "bad_debt_usd": r.bad_debt_usd,
            "liquidations": r.liquidations, "skipped_unprofitable": r.skipped, "defended": r.defended,
            "liquidator_profit_usd": r.liq_profit_usd, "max_util_pct": r.max_util, "max_twap_gap_pct": r.max_twap_gap_pct,
            "end_pool_price": r.end_pool_price, "open_debt_usd": r.open_debt_usd, "failed_txs": r.failed_txs })).collect::<Vec<_>>(),
        "attacks": attacks.iter().map(|a| serde_json::json!({
            "attack": a.name, "pump": a.pump, "hold_secs": a.hold_secs, "arb_per_min": a.arb, "cap_usd": a.cap_usd,
            "borrowed_usd": a.borrowed_usd, "attacker_pnl_usd": a.attacker_pnl_usd, "protocol_loss_usd": a.protocol_loss_usd })).collect::<Vec<_>>(),
        "crash_sweep": sweep.iter().map(|(c, r, m, w, pm, pw)| serde_json::json!({
            "cap_usd": c, "max_ltv_bps": r.0, "liq_threshold_bps": r.1, "twap_window_secs": r.2, "bad_debt_pct_mean": m, "bad_debt_pct_worst": w, "lender_pnl_pct_mean": pm, "lender_pnl_pct_worst": pw })).collect::<Vec<_>>(),
        "bonus_sweep": bonus_sweep.iter().map(|(c, b, m, w, p, l)| serde_json::json!({
            "cap_usd": c, "bonus_bps": b, "bad_debt_pct_mean": m, "bad_debt_pct_worst": w, "lender_pnl_pct_mean": p, "liquidations_per_run": l })).collect::<Vec<_>>(),
        "bank_run": bank.iter().map(|(s, apr, util)| serde_json::json!({
            "withdrawn_share_by_hour": s.iter().map(|(h, g)| serde_json::json!({"hour": h, "share": g})).collect::<Vec<_>>(),
            "util_pct_after": util, "borrow_apr_after": apr })).collect::<Vec<_>>(),
        "fee_sweep": fee_sweep.iter().map(|(c, f, m, w, p, l, k)| serde_json::json!({
            "cap_usd": c, "liq_fee_bps": f, "bad_debt_pct_mean": m, "bad_debt_pct_worst": w, "lender_pnl_pct_mean": p, "liquidations_per_run": l, "skipped_per_run": k })).collect::<Vec<_>>(),
        "loop_pxnt": lp.iter().map(|r| serde_json::json!({
            "scenario": r.name, "util_pct": r.util, "borrow_apr_pct": r.borrow_apr, "supply_apy_pct": r.supply_apy, "avg_leverage": r.avg_leverage,
            "loopers_liquidated": r.liquidated, "bad_debt_xnt": r.bad_debt_xnt, "interest_fees_xnt": r.interest_fees_xnt,
            "liquidation_fees_pxnt": r.liq_fees_pxnt, "looper_return_pct": r.looper_return_pct, "lender_withdrawn_pct": r.lender_out_pct })).collect::<Vec<_>>(),
        "xnt_pxnt": px.iter().map(|r| serde_json::json!({
            "scenario": r.name, "bad_debt_xnt": r.bad_debt_xnt, "liquidations": r.liquidations, "lender_pnl_pct": r.lender_pnl_pct })).collect::<Vec<_>>(),
    });
    std::fs::write("fixtures/stress-report.json", serde_json::to_string_pretty(&json).unwrap()).unwrap();
}

//! LiteSVM harness: the compiled Accumulator program plus stand-in XDEX pools and
//! stake pools whose prices tests can set at will.
#![allow(dead_code, deprecated)]

use anchor_lang::{AccountDeserialize, InstructionData, ToAccountMetas};
use anchor_spl::associated_token::spl_associated_token_account as ata_prog;
use anchor_spl::token::spl_token;
use anchor_spl::token_2022::spl_token_2022;
use litesvm::LiteSVM;
use accumulator::constants::*;
use accumulator::state::{Market, MarketParams, Obligation, OracleKind};
use solana_sdk::{
    account::Account,
    clock::Clock,
    instruction::{AccountMeta, Instruction},
    program_option::COption,
    program_pack::Pack,
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    system_instruction, system_program,
    transaction::Transaction,
};

pub const XNT: u64 = 1_000_000_000;
pub const USD: u64 = 1_000_000;
pub const TOKEN: Pubkey = spl_token::ID;
pub const TOKEN22: Pubkey = spl_token_2022::ID;

pub struct H {
    pub svm: LiteSVM,
    pub payer: Keypair,
    pub now: i64,
}

pub fn pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &accumulator::ID).0
}
pub fn config_pda() -> Pubkey {
    pda(&[CONFIG_SEED])
}
pub fn market_pda(lend: &Pubkey, coll: &Pubkey) -> Pubkey {
    pda(&[MARKET_SEED, lend.as_ref(), coll.as_ref()])
}
pub fn obligation_pda(market: &Pubkey, owner: &Pubkey) -> Pubkey {
    pda(&[OBLIGATION_SEED, market.as_ref(), owner.as_ref()])
}

fn ro(k: Pubkey) -> AccountMeta {
    AccountMeta::new_readonly(k, false)
}

impl H {
    pub fn new() -> Self {
        let mut svm = LiteSVM::new().with_lamports(u64::MAX / 4);
        svm.add_program_from_file(accumulator::ID, "../target/deploy/accumulator.so").unwrap();
        let payer = Keypair::new();
        svm.airdrop(&payer.pubkey(), 1_000_000 * XNT).unwrap();
        let mut h = H { svm, payer, now: 1_800_000_000 };
        h.set_time(h.now);
        if h.svm.get_account(&NATIVE_MINT).is_none() {
            h.mint_at(NATIVE_MINT, 9, None, TOKEN);
        }
        h
    }

    pub fn set_time(&mut self, ts: i64) {
        self.now = ts;
        let mut c: Clock = self.svm.get_sysvar();
        c.unix_timestamp = ts;
        c.slot += 1;
        self.svm.set_sysvar(&c);
    }
    /// Move the cluster to `epoch` (the stake pool check compares against it).
    pub fn set_epoch(&mut self, epoch: u64) {
        let mut c: Clock = self.svm.get_sysvar();
        c.epoch = epoch;
        self.svm.set_sysvar(&c);
    }
    /// Mark a stand-in stake pool as updated for `epoch`.
    pub fn set_stake_pool_epoch(&mut self, addr: Pubkey, epoch: u64) {
        let mut a = self.svm.get_account(&addr).unwrap();
        a.data[275..283].copy_from_slice(&epoch.to_le_bytes());
        self.svm.set_account(addr, a).unwrap();
    }
    pub fn advance(&mut self, secs: i64) {
        self.set_time(self.now + secs);
    }

    pub fn user(&mut self, lamports: u64) -> Keypair {
        let k = Keypair::new();
        self.svm.airdrop(&k.pubkey(), lamports).unwrap();
        k
    }

    /// Sends; on failure returns the program logs joined (they hold the Anchor error code).
    pub fn send(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> Result<(), String> {
        let tx = Transaction::new_signed_with_payer(ixs, Some(&signers[0].pubkey()), signers, self.svm.latest_blockhash());
        let r = self.svm.send_transaction(tx);
        self.svm.expire_blockhash();
        r.map(|_| ()).map_err(|e| format!("{:?}\n{}", e.err, e.meta.logs.join("\n")))
    }

    pub fn must(&mut self, ixs: &[Instruction], signers: &[&Keypair]) {
        if let Err(e) = self.send(ixs, signers) {
            panic!("tx failed: {e}");
        }
    }

    pub fn fails(&mut self, ixs: &[Instruction], signers: &[&Keypair], code: &str) {
        match self.send(ixs, signers) {
            Ok(()) => panic!("expected {code}, but the transaction succeeded"),
            Err(e) => assert!(e.contains(&format!("Error Code: {code}")), "expected {code}, got:\n{e}"),
        }
    }

    // ---------------------------------------------------------------- tokens

    pub fn mint_at(&mut self, addr: Pubkey, decimals: u8, authority: Option<Pubkey>, program: Pubkey) {
        let mut data = vec![0u8; spl_token::state::Mint::LEN];
        spl_token::state::Mint {
            mint_authority: authority.map(COption::Some).unwrap_or(COption::None),
            supply: 0,
            decimals,
            is_initialized: true,
            freeze_authority: COption::None,
        }
        .pack_into_slice(&mut data);
        self.svm
            .set_account(addr, Account { lamports: 10_000_000, data, owner: program, executable: false, rent_epoch: 0 })
            .unwrap();
    }

    pub fn create_mint(&mut self, decimals: u8, program: Pubkey) -> Pubkey {
        let k = Pubkey::new_unique();
        let auth = self.payer.pubkey();
        self.mint_at(k, decimals, Some(auth), program);
        k
    }

    pub fn ata(&mut self, owner: &Pubkey, mint: &Pubkey, program: Pubkey) -> Pubkey {
        let a = ata_prog::get_associated_token_address_with_program_id(owner, mint, &program);
        if self.svm.get_account(&a).is_none() {
            let ix = ata_prog::instruction::create_associated_token_account_idempotent(&self.payer.pubkey(), owner, mint, &program);
            let p = self.payer.insecure_clone();
            self.must(&[ix], &[&p]);
        }
        a
    }

    pub fn mint_to(&mut self, mint: &Pubkey, owner: &Pubkey, amount: u64, program: Pubkey) -> Pubkey {
        let a = self.ata(owner, mint, program);
        let ix = spl_token_2022::instruction::mint_to(&program, mint, &a, &self.payer.pubkey(), &[], amount).unwrap();
        let p = self.payer.insecure_clone();
        self.must(&[ix], &[&p]);
        a
    }

    /// Wraps native XNT into the owner's wrapped-XNT account.
    pub fn wrap(&mut self, owner: &Keypair, amount: u64) -> Pubkey {
        let a = self.ata(&owner.pubkey(), &NATIVE_MINT, TOKEN);
        self.must(
            &[
                system_instruction::transfer(&owner.pubkey(), &a, amount),
                spl_token::instruction::sync_native(&TOKEN, &a).unwrap(),
            ],
            &[owner],
        );
        a
    }

    pub fn balance(&self, acct: &Pubkey) -> u64 {
        self.svm.get_account(acct).map(|a| u64::from_le_bytes(a.data[64..72].try_into().unwrap())).unwrap_or(0)
    }

    pub fn mint_supply(&self, mint: &Pubkey) -> u64 {
        let a = self.svm.get_account(mint).unwrap();
        u64::from_le_bytes(a.data[36..44].try_into().unwrap())
    }

    /// Raw token account with any balance (pool vaults).
    pub fn set_token_account(&mut self, addr: Pubkey, mint: Pubkey, owner: Pubkey, amount: u64, program: Pubkey) {
        let mut data = vec![0u8; spl_token::state::Account::LEN];
        spl_token::state::Account {
            mint,
            owner,
            amount,
            delegate: COption::None,
            state: spl_token::state::AccountState::Initialized,
            is_native: COption::None,
            delegated_amount: 0,
            close_authority: COption::None,
        }
        .pack_into_slice(&mut data);
        self.svm
            .set_account(addr, Account { lamports: 3_000_000, data, owner: program, executable: false, rent_epoch: 0 })
            .unwrap();
    }

    // ------------------------------------------------------- stake pool mock

    pub fn set_stake_pool(&mut self, addr: Pubkey, pool_mint: Pubkey, total_lamports: u64, pool_token_supply: u64) {
        let mut d = vec![0u8; 877];
        d[0] = 1; // version (X1 fork)
        d[1] = 1; // AccountType::StakePool
        d[163..195].copy_from_slice(pool_mint.as_ref());
        d[259..267].copy_from_slice(&total_lamports.to_le_bytes());
        d[267..275].copy_from_slice(&pool_token_supply.to_le_bytes());
        self.svm
            .set_account(addr, Account { lamports: 10_000_000, data: d, owner: X1_STAKE_POOL_PROGRAM_ID, executable: false, rent_epoch: 0 })
            .unwrap();
    }

    // ------------------------------------------------------------- reading

    pub fn market(&self, addr: &Pubkey) -> Market {
        let a = self.svm.get_account(addr).unwrap();
        Market::try_deserialize(&mut a.data.as_slice()).unwrap()
    }
    pub fn obligation(&self, market: &Pubkey, owner: &Pubkey) -> Obligation {
        let a = self.svm.get_account(&obligation_pda(market, owner)).unwrap();
        Obligation::try_deserialize(&mut a.data.as_slice()).unwrap()
    }
    pub fn debt(&self, market: &Pubkey, owner: &Pubkey) -> u128 {
        let m = self.market(market);
        m.debt_of(self.obligation(market, owner).borrow_scaled).unwrap()
    }

    // --------------------------------------------------------- instructions

    pub fn ix_init_config(&self, admin: &Pubkey, timelock: i64) -> Instruction {
        Instruction {
            program_id: accumulator::ID,
            accounts: accumulator::accounts::InitConfig { config: config_pda(), admin: *admin, system_program: system_program::ID }
                .to_account_metas(None),
            data: accumulator::instruction::InitConfig { timelock_seconds: timelock }.data(),
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn ix_create_market(
        &self,
        admin: &Pubkey,
        lend: Pubkey,
        coll: Pubkey,
        lend_prog: Pubkey,
        coll_prog: Pubkey,
        params: MarketParams,
        kind: OracleKind,
        token0: bool,
        oracle: &[Pubkey],
    ) -> Instruction {
        let market = market_pda(&lend, &coll);
        let mut accounts = accumulator::accounts::CreateMarket {
            config: config_pda(),
            admin: *admin,
            lend_mint: lend,
            collateral_mint: coll,
            market,
            liquidity_vault: pda(&[LIQUIDITY_VAULT_SEED, market.as_ref()]),
            collateral_vault: pda(&[COLLATERAL_VAULT_SEED, market.as_ref()]),
            share_mint: pda(&[SHARE_MINT_SEED, market.as_ref()]),
            lend_token_program: lend_prog,
            collateral_token_program: coll_prog,
            system_program: system_program::ID,
        }
        .to_account_metas(None);
        accounts.extend(oracle.iter().map(|k| ro(*k)));
        Instruction {
            program_id: accumulator::ID,
            accounts,
            data: accumulator::instruction::CreateMarket { params, oracle_kind: kind, collateral_is_token0: token0 }.data(),
        }
    }

    fn admin_accts(&self, admin: &Pubkey, market: &Pubkey) -> Vec<AccountMeta> {
        accumulator::accounts::MarketAdmin { config: config_pda(), admin: *admin, market: *market }.to_account_metas(None)
    }

    pub fn ix_queue(&self, admin: &Pubkey, market: &Pubkey, params: MarketParams) -> Instruction {
        Instruction { program_id: accumulator::ID, accounts: self.admin_accts(admin, market), data: accumulator::instruction::QueueParams { params }.data() }
    }
    pub fn ix_cancel(&self, admin: &Pubkey, market: &Pubkey) -> Instruction {
        Instruction { program_id: accumulator::ID, accounts: self.admin_accts(admin, market), data: accumulator::instruction::CancelParams {}.data() }
    }
    pub fn ix_pause(&self, admin: &Pubkey, market: &Pubkey, paused: bool) -> Instruction {
        Instruction { program_id: accumulator::ID, accounts: self.admin_accts(admin, market), data: accumulator::instruction::SetBorrowPaused { paused }.data() }
    }
    pub fn ix_apply(&self, market: &Pubkey) -> Instruction {
        Instruction {
            program_id: accumulator::ID,
            accounts: accumulator::accounts::ApplyParams { market: *market }.to_account_metas(None),
            data: accumulator::instruction::ApplyParams {}.data(),
        }
    }
    pub fn ix_accrue(&self, market: &Pubkey) -> Instruction {
        Instruction {
            program_id: accumulator::ID,
            accounts: accumulator::accounts::Accrue { market: *market }.to_account_metas(None),
            data: accumulator::instruction::AccrueInterest {}.data(),
        }
    }
    pub fn ix_propose_admin(&self, admin: &Pubkey, new_admin: Pubkey) -> Instruction {
        Instruction {
            program_id: accumulator::ID,
            accounts: accumulator::accounts::AdminOnly { config: config_pda(), admin: *admin }.to_account_metas(None),
            data: accumulator::instruction::ProposeAdmin { new_admin }.data(),
        }
    }
    pub fn ix_accept_admin(&self, new_admin: &Pubkey) -> Instruction {
        Instruction {
            program_id: accumulator::ID,
            accounts: accumulator::accounts::AcceptAdmin { config: config_pda(), new_admin: *new_admin }.to_account_metas(None),
            data: accumulator::instruction::AcceptAdmin {}.data(),
        }
    }
    pub fn ix_collect_fees(&self, m: &Market, market: &Pubkey, treasury_token: Pubkey, amount: u64) -> Instruction {
        Instruction {
            program_id: accumulator::ID,
            accounts: accumulator::accounts::CollectFees {
                config: config_pda(),
                market: *market,
                lend_mint: m.lend_mint,
                liquidity_vault: m.liquidity_vault,
                treasury_token,
                lend_token_program: m.lend_token_program,
            }
            .to_account_metas(None),
            data: accumulator::instruction::CollectFees { amount }.data(),
        }
    }
    pub fn ix_collect_collateral_fees(&self, m: &Market, market: &Pubkey, treasury_token: Pubkey) -> Instruction {
        Instruction {
            program_id: accumulator::ID,
            accounts: accumulator::accounts::CollectCollateralFees {
                config: config_pda(),
                market: *market,
                collateral_mint: m.collateral_mint,
                collateral_vault: m.collateral_vault,
                treasury_token,
                collateral_token_program: m.collateral_token_program,
            }
            .to_account_metas(None),
            data: accumulator::instruction::CollectCollateralFees {}.data(),
        }
    }
    pub fn ix_set_treasury(&self, admin: &Pubkey, treasury: Pubkey) -> Instruction {
        Instruction {
            program_id: accumulator::ID,
            accounts: accumulator::accounts::AdminOnly { config: config_pda(), admin: *admin }.to_account_metas(None),
            data: accumulator::instruction::SetTreasury { treasury }.data(),
        }
    }
    pub fn ix_apply_treasury(&self) -> Instruction {
        Instruction {
            program_id: accumulator::ID,
            accounts: accumulator::accounts::ApplyTreasury { config: config_pda() }.to_account_metas(None),
            data: accumulator::instruction::ApplyTreasury {}.data(),
        }
    }
    pub fn ix_migrate_config(&self, admin: &Pubkey) -> Instruction {
        Instruction {
            program_id: accumulator::ID,
            accounts: accumulator::accounts::MigrateConfig { config: config_pda(), admin: *admin, system_program: system_program::ID }
                .to_account_metas(None),
            data: accumulator::instruction::MigrateConfig {}.data(),
        }
    }
    pub fn ix_migrate_market(&self, admin: &Pubkey, market: &Pubkey) -> Instruction {
        Instruction {
            program_id: accumulator::ID,
            accounts: accumulator::accounts::MigrateMarket {
                config: config_pda(),
                market: *market,
                admin: *admin,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: accumulator::instruction::MigrateMarket {}.data(),
        }
    }
    pub fn config(&self) -> accumulator::state::Config {
        let a = self.svm.get_account(&config_pda()).unwrap();
        accumulator::state::Config::try_deserialize(&mut a.data.as_slice()).unwrap()
    }

    fn lend_accts(&self, m: &Market, market: &Pubkey, user: &Pubkey, token: Pubkey, shares: Pubkey) -> Vec<AccountMeta> {
        accumulator::accounts::Lend {
            market: *market,
            user: *user,
            lend_mint: m.lend_mint,
            liquidity_vault: m.liquidity_vault,
            share_mint: m.share_mint,
            user_token: token,
            user_shares: shares,
            lend_token_program: m.lend_token_program,
        }
        .to_account_metas(None)
    }
    pub fn ix_deposit(&self, market: &Pubkey, user: &Pubkey, token: Pubkey, shares: Pubkey, amount: u64) -> Instruction {
        let m = self.market(market);
        Instruction { program_id: accumulator::ID, accounts: self.lend_accts(&m, market, user, token, shares), data: accumulator::instruction::Deposit { amount }.data() }
    }
    pub fn ix_withdraw(&self, market: &Pubkey, user: &Pubkey, token: Pubkey, shares: Pubkey, amount: u64) -> Instruction {
        let m = self.market(market);
        Instruction {
            program_id: accumulator::ID,
            accounts: self.lend_accts(&m, market, user, token, shares),
            data: accumulator::instruction::Withdraw { shares: amount }.data(),
        }
    }

    pub fn ix_open(&self, market: &Pubkey, owner: &Pubkey) -> Instruction {
        Instruction {
            program_id: accumulator::ID,
            accounts: accumulator::accounts::OpenObligation {
                market: *market,
                obligation: obligation_pda(market, owner),
                owner: *owner,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: accumulator::instruction::OpenObligation {}.data(),
        }
    }
    pub fn ix_close(&self, market: &Pubkey, owner: &Pubkey) -> Instruction {
        Instruction {
            program_id: accumulator::ID,
            accounts: accumulator::accounts::CloseObligation { obligation: obligation_pda(market, owner), owner: *owner }.to_account_metas(None),
            data: accumulator::instruction::CloseObligation {}.data(),
        }
    }

    fn coll_accts(&self, m: &Market, market: &Pubkey, owner: &Pubkey, user_coll: Pubkey) -> Vec<AccountMeta> {
        accumulator::accounts::Collateral {
            market: *market,
            obligation: obligation_pda(market, owner),
            owner: *owner,
            collateral_mint: m.collateral_mint,
            collateral_vault: m.collateral_vault,
            user_collateral: user_coll,
            collateral_token_program: m.collateral_token_program,
        }
        .to_account_metas(None)
    }
    pub fn oracle_metas(&self, m: &Market) -> Vec<AccountMeta> {
        match m.oracle_kind {
            OracleKind::StakePool => vec![ro(m.oracle_accounts[0])],
            OracleKind::XdexTwap => m.oracle_accounts.iter().map(|k| ro(*k)).collect(),
        }
    }
    pub fn ix_deposit_collateral(&self, market: &Pubkey, owner: &Pubkey, user_coll: Pubkey, amount: u64) -> Instruction {
        let m = self.market(market);
        Instruction {
            program_id: accumulator::ID,
            accounts: self.coll_accts(&m, market, owner, user_coll),
            data: accumulator::instruction::DepositCollateral { amount }.data(),
        }
    }
    pub fn ix_withdraw_collateral(&self, market: &Pubkey, owner: &Pubkey, user_coll: Pubkey, amount: u64, with_oracle: bool) -> Instruction {
        let m = self.market(market);
        let mut accounts = self.coll_accts(&m, market, owner, user_coll);
        if with_oracle {
            accounts.extend(self.oracle_metas(&m));
        }
        Instruction { program_id: accumulator::ID, accounts, data: accumulator::instruction::WithdrawCollateral { amount }.data() }
    }
    pub fn ix_borrow_with(&self, market: &Pubkey, owner: &Pubkey, dest: Pubkey, amount: u64, oracle: Vec<AccountMeta>) -> Instruction {
        let m = self.market(market);
        let mut accounts = accumulator::accounts::Borrow {
            market: *market,
            obligation: obligation_pda(market, owner),
            owner: *owner,
            lend_mint: m.lend_mint,
            liquidity_vault: m.liquidity_vault,
            destination: dest,
            lend_token_program: m.lend_token_program,
        }
        .to_account_metas(None);
        accounts.extend(oracle);
        Instruction { program_id: accumulator::ID, accounts, data: accumulator::instruction::Borrow { amount }.data() }
    }
    pub fn ix_borrow(&self, market: &Pubkey, owner: &Pubkey, dest: Pubkey, amount: u64) -> Instruction {
        let o = self.oracle_metas(&self.market(market));
        self.ix_borrow_with(market, owner, dest, amount, o)
    }
    pub fn ix_repay(&self, market: &Pubkey, borrower: &Pubkey, payer: &Pubkey, source: Pubkey, amount: u64) -> Instruction {
        let m = self.market(market);
        Instruction {
            program_id: accumulator::ID,
            accounts: accumulator::accounts::Repay {
                market: *market,
                obligation: obligation_pda(market, borrower),
                payer: *payer,
                lend_mint: m.lend_mint,
                liquidity_vault: m.liquidity_vault,
                source,
                lend_token_program: m.lend_token_program,
            }
            .to_account_metas(None),
            data: accumulator::instruction::Repay { amount }.data(),
        }
    }
    #[allow(clippy::too_many_arguments)]
    pub fn ix_liquidate(
        &self,
        market: &Pubkey,
        borrower: &Pubkey,
        liquidator: &Pubkey,
        liq_lend: Pubkey,
        liq_coll: Pubkey,
        max_repay: u64,
        min_out: u64,
    ) -> Instruction {
        let m = self.market(market);
        let mut accounts = accumulator::accounts::Liquidate {
            market: *market,
            obligation: obligation_pda(market, borrower),
            liquidator: *liquidator,
            lend_mint: m.lend_mint,
            collateral_mint: m.collateral_mint,
            liquidity_vault: m.liquidity_vault,
            collateral_vault: m.collateral_vault,
            liquidator_lend: liq_lend,
            liquidator_collateral: liq_coll,
            lend_token_program: m.lend_token_program,
            collateral_token_program: m.collateral_token_program,
        }
        .to_account_metas(None);
        accounts.extend(self.oracle_metas(&m));
        Instruction {
            program_id: accumulator::ID,
            accounts,
            data: accumulator::instruction::Liquidate { max_repay, min_collateral_out: min_out }.data(),
        }
    }
}

// ------------------------------------------------------------------ XDEX mock

/// A fake XDEX pool: pool account, price history and vaults, all settable.
pub struct Xdex {
    pub pool: Pubkey,
    pub observation: Pubkey,
    pub vault0: Pubkey,
    pub vault1: Pubkey,
    pub mint0: Pubkey,
    pub mint1: Pubkey,
    pub prog0: Pubkey,
    pub prog1: Pubkey,
}

const Q32: u128 = 1 << 32;

impl Xdex {
    pub fn new(h: &mut H, mint0: Pubkey, mint1: Pubkey, prog0: Pubkey, prog1: Pubkey) -> Self {
        let x = Xdex {
            pool: Pubkey::new_unique(),
            observation: Pubkey::new_unique(),
            vault0: Pubkey::new_unique(),
            vault1: Pubkey::new_unique(),
            mint0,
            mint1,
            prog0,
            prog1,
        };
        let mut d = vec![0u8; accumulator::oracle::XDEX_POOL_LEN];
        d[72..104].copy_from_slice(x.vault0.as_ref());
        d[104..136].copy_from_slice(x.vault1.as_ref());
        d[168..200].copy_from_slice(mint0.as_ref());
        d[200..232].copy_from_slice(mint1.as_ref());
        d[296..328].copy_from_slice(x.observation.as_ref());
        h.svm
            .set_account(x.pool, Account { lamports: 10_000_000, data: d, owner: XDEX_PROGRAM_ID, executable: false, rent_epoch: 0 })
            .unwrap();
        x
    }

    pub fn accounts(&self) -> Vec<Pubkey> {
        vec![self.pool, self.observation, self.vault0, self.vault1]
    }

    pub fn set_reserves(&self, h: &mut H, a0: u64, a1: u64) {
        h.set_token_account(self.vault0, self.mint0, self.pool, a0, self.prog0);
        h.set_token_account(self.vault1, self.mint1, self.pool, a1, self.prog1);
    }

    /// History ending now: a snapshot every `step` seconds, token 0 trading at
    /// prices_q32[i] (token 1 per token 0) during interval i.
    pub fn set_history(&self, h: &mut H, prices_q32: &[u128], step: u64) {
        let n = prices_q32.len().min(100);
        let mut d = vec![0u8; accumulator::oracle::XDEX_OBSERVATION_LEN];
        d[8] = 1;
        d[9..11].copy_from_slice(&((n - 1) as u16).to_le_bytes());
        d[11..43].copy_from_slice(self.pool.as_ref());
        let start = h.now as u64 - step * (n as u64 - 1);
        let (mut c0, mut c1) = (0u128, 0u128);
        for (i, p) in prices_q32.iter().take(n).enumerate() {
            let at = 43 + i * 40;
            d[at..at + 8].copy_from_slice(&(start + step * i as u64).to_le_bytes());
            d[at + 8..at + 24].copy_from_slice(&c0.to_le_bytes());
            d[at + 24..at + 40].copy_from_slice(&c1.to_le_bytes());
            c0 = c0.wrapping_add(p * step as u128);
            c1 = c1.wrapping_add((Q32 * Q32 / p) * step as u128);
        }
        h.svm
            .set_account(self.observation, Account { lamports: 30_000_000, data: d, owner: XDEX_PROGRAM_ID, executable: false, rent_epoch: 0 })
            .unwrap();
    }

    /// 100 snapshots, 15s apart, flat at the reserves' price; reserves set to match.
    pub fn set_flat(&self, h: &mut H, a0: u64, a1: u64) {
        let p = ((a1 as u128) << 32) / a0 as u128;
        self.set_history(h, &vec![p; 100], 15);
        self.set_reserves(h, a0, a1);
    }

    /// TWAP the program would use for liquidation, read from the mock accounts.
    pub fn twap(&self, h: &H, window: u64, token0: bool) -> u128 {
        let obs = h.svm.get_account(&self.observation).unwrap();
        let (idx, list) = accumulator::oracle::parse_observations(&obs.data, &self.pool).unwrap();
        let (s0, s1) = accumulator::oracle::spot_q32(h.balance(&self.vault0), h.balance(&self.vault1)).unwrap();
        accumulator::oracle::twap_wad(idx, &list, s0, s1, h.now as u64, window, token0).unwrap()
    }
}

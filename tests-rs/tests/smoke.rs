use anchor_lang::{InstructionData, ToAccountMetas};
use litesvm::LiteSVM;
use solana_sdk::{instruction::Instruction, signature::{Keypair, Signer}, transaction::Transaction};

#[test]
fn smoke() {
    let mut svm = LiteSVM::new();
    svm.add_program_from_file(accumulator::ID, "../target/deploy/accumulator.so").unwrap();
    let admin = Keypair::new();
    svm.airdrop(&admin.pubkey(), 10_000_000_000).unwrap();
    let config = anchor_lang::prelude::Pubkey::find_program_address(&[b"config"], &accumulator::ID).0;
    let ix = Instruction {
        program_id: accumulator::ID,
        accounts: accumulator::accounts::InitConfig { config, admin: admin.pubkey(), system_program: anchor_lang::system_program::ID }.to_account_metas(None),
        data: accumulator::instruction::InitConfig { timelock_seconds: 3600 }.data(),
    };
    let tx = Transaction::new_signed_with_payer(&[ix], Some(&admin.pubkey()), &[&admin], svm.latest_blockhash());
    svm.send_transaction(tx).unwrap();
}

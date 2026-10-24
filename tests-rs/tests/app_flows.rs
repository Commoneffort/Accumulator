//! Replays the instructions the frontend builds (fixtures/app-plan.json, made
//! by `npm run app-plan` from app/src/actions.ts) against the compiled program.
#![allow(deprecated)]

mod common;

use base64::Engine;
use common::*;
use accumulator::constants::NATIVE_MINT;
use solana_sdk::{
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    signature::{Keypair, Signer},
};
use std::str::FromStr;

fn pk(v: &serde_json::Value) -> Pubkey {
    Pubkey::from_str(v.as_str().unwrap()).unwrap()
}

#[test]
fn frontend_transactions_work_end_to_end() {
    let raw = std::fs::read_to_string("fixtures/app-plan.json").expect("run `npm run app-plan` first");
    let plan: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let kp = |n: &str| {
        let bytes: Vec<u8> = plan["keys"][n].as_array().unwrap().iter().map(|b| b.as_u64().unwrap() as u8).collect();
        Keypair::from_bytes(&bytes).unwrap()
    };
    let (admin, alice, bob) = (kp("admin"), kp("alice"), kp("bob"));
    let a = &plan["accounts"];
    let (pxnt, stake_pool, usdc) = (pk(&a["pxnt"]), pk(&a["stake_pool"]), pk(&a["usdc"]));

    let mut h = H::new();
    for k in [&admin, &alice, &bob] {
        h.svm.airdrop(&k.pubkey(), 1_000 * XNT).unwrap();
    }
    // the world the app's transactions expect
    h.mint_at(pxnt, 9, None, TOKEN);
    h.mint_at(usdc, 6, None, TOKEN22);
    h.set_stake_pool(stake_pool, pxnt, 1_000_000 * XNT, 1_000_000 * XNT);
    let x = Xdex {
        pool: pk(&a["xdex_pool"]),
        observation: pk(&a["xdex_obs"]),
        vault0: pk(&a["xdex_v0"]),
        vault1: pk(&a["xdex_v1"]),
        mint0: NATIVE_MINT,
        mint1: usdc,
        prog0: TOKEN,
        prog1: TOKEN22,
    };
    {
        let mut d = vec![0u8; accumulator::oracle::XDEX_POOL_LEN];
        d[72..104].copy_from_slice(x.vault0.as_ref());
        d[104..136].copy_from_slice(x.vault1.as_ref());
        d[168..200].copy_from_slice(NATIVE_MINT.as_ref());
        d[200..232].copy_from_slice(usdc.as_ref());
        d[296..328].copy_from_slice(x.observation.as_ref());
        h.svm
            .set_account(x.pool, solana_sdk::account::Account { lamports: 10_000_000, data: d, owner: accumulator::constants::XDEX_PROGRAM_ID, executable: false, rent_epoch: 0 })
            .unwrap();
    }
    x.set_flat(&mut h, 17_000 * XNT, 4_250 * USD);
    let bob_pxnt = anchor_spl::associated_token::get_associated_token_address_with_program_id(&bob.pubkey(), &pxnt, &TOKEN);
    h.set_token_account(bob_pxnt, pxnt, bob.pubkey(), 50 * XNT, TOKEN);
    let alice_usdc = anchor_spl::associated_token::get_associated_token_address_with_program_id(&alice.pubkey(), &usdc, &TOKEN22);
    h.set_token_account(alice_usdc, usdc, alice.pubkey(), 2_000 * USD, TOKEN22);
    let bob_usdc = anchor_spl::associated_token::get_associated_token_address_with_program_id(&bob.pubkey(), &usdc, &TOKEN22);

    let m1 = market_pda(&NATIVE_MINT, &pxnt);
    let m2 = market_pda(&usdc, &NATIVE_MINT);

    for step in plan["steps"].as_array().unwrap() {
        let name = step["name"].as_str().unwrap();
        let advance = step["advance"].as_i64().unwrap();
        if advance > 0 {
            h.advance(advance);
            // keep the XDEX history current, as a live pool would be
            x.set_flat(&mut h, 17_000 * XNT, 4_250 * USD);
        }
        if name == "bob repays all USDC.x" {
            // the 7 borrowed plus a little for interest
            h.set_token_account(bob_usdc, usdc, bob.pubkey(), 10 * USD, TOKEN22);
        }
        let signer = match step["signer"].as_str().unwrap() {
            "admin" => &admin,
            "alice" => &alice,
            _ => &bob,
        };
        let ixs: Vec<Instruction> = step["ixs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|ix| Instruction {
                program_id: pk(&ix["program_id"]),
                accounts: ix["accounts"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|k| AccountMeta {
                        pubkey: pk(&k["pubkey"]),
                        is_signer: k["is_signer"].as_bool().unwrap(),
                        is_writable: k["is_writable"].as_bool().unwrap(),
                    })
                    .collect(),
                data: base64::engine::general_purpose::STANDARD.decode(ix["data"].as_str().unwrap()).unwrap(),
            })
            .collect();
        let before = h.svm.get_balance(&signer.pubkey()).unwrap_or(0);
        if let Err(e) = h.send(&ixs, &[signer]) {
            panic!("step '{name}' failed:\n{e}");
        }
        let after = h.svm.get_balance(&signer.pubkey()).unwrap_or(0);
        println!("ok  {name:<32} native XNT {:+.4}", (after as f64 - before as f64) / 1e9);

        match name {
            "alice deposits 100 XNT" => assert_eq!(h.market(&m1).cash, 100 * XNT),
            "alice withdraws 40 shares" => assert_eq!(h.market(&m1).cash, 60 * XNT),
            "bob borrows 30 XNT" => assert!(after - before > 29 * XNT, "borrowed XNT arrives unwrapped"),
            "bob repays all XNT" => assert_eq!(h.obligation(&m1, &bob.pubkey()).borrow_scaled, 0),
            "bob closes XNT/pXNT position" => assert!(h.svm.get_account(&obligation_pda(&m1, &bob.pubkey())).map_or(true, |a| a.lamports == 0)),
            "alice deposits 2000 USDC.x" => assert_eq!(h.market(&m2).cash, 2_000 * USD),
            "bob borrows 7 USDC.x" => assert_eq!(h.balance(&bob_usdc), 7 * USD),
            "bob repays all USDC.x" => assert_eq!(h.obligation(&m2, &bob.pubkey()).borrow_scaled, 0),
            "bob withdraws 80 XNT" => {
                assert_eq!(h.obligation(&m2, &bob.pubkey()).collateral, 0);
                assert!(after - before > 79 * XNT, "collateral comes back as native XNT");
            }
            _ => {}
        }
    }
    // no wrapped-XNT accounts left behind: the app unwraps every time
    for u in [&alice, &bob] {
        let w = anchor_spl::associated_token::get_associated_token_address_with_program_id(&u.pubkey(), &NATIVE_MINT, &TOKEN);
        assert!(h.svm.get_account(&w).map_or(true, |a| a.lamports == 0), "leftover wXNT account");
    }
}

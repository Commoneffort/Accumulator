# Accumulator security review

**Date:** 2026-10-24 · **Scope:** `programs/accumulator` (all instructions, math, oracle readers), plus how the SDK and app mirror the on-chain math · **Program:** `BTjwAkUiiGSrhYxTGD8UskZNTT1TMTQjkD4NQtk6Vs9y`

This is an internal review by the same team that wrote the code, backed by tests that run the compiled program. It is not a replacement for an independent audit before mainnet.

## Summary

| ID | Severity | Finding | Status |
|---|---|---|---|
| H-01 | High | A pump inside one transaction could move the XDEX average ~12x | **Fixed**, test added, live on testnet |
| M-01 | Medium | Borrowing exactly the per-account cap was refused | **Fixed**, test added, live on testnet |

## Findings and resolutions

### H-01: same-transaction pump moved the XDEX average (fixed)

The average fills the seconds since XDEX's newest snapshot using the pool's *current* price. XDEX writes a snapshot at most every 15 seconds, so an attacker could make a tiny swap (snapshot written), then within 14 seconds pump the pool, borrow and swap back in one transaction. No snapshot would be written for the pump, and the pumped price would count for up to 14 of the 1,200 seconds. A 1,000x pump moved the average **12.5x** in a test, and with round-trip swaps costing only fees, an attacker could borrow about 5x the fair value of their collateral, up to the borrow caps.

**Fix:** the unrecorded stretch is held within 2% of the latest recorded interval's price. Real moves appear once the next snapshot is written; any swap 15 seconds after the previous one writes it. Test: `same_transaction_mega_pump_cannot_move_twap` (1,000x pump and 1,000x dump both stay within 3%). The SDK's copy of the math was changed to match.

### M-01: per-account cap rounding (fixed)

The cap check rounded debt up twice, so borrowing exactly `max_borrow_per_obligation` failed by one base unit. Found in the live testnet drill. Now compares existing debt + new amount. Test in `market_rules`.

## Checked and found sound

- **Account validation:** every account is tied to the market by `has_one`, seeds or address constraints; positions are PDAs of (market, owner); price accounts must match the keys stored at market creation and be owned by the expected program.
- **Signers:** only the owner can borrow or withdraw collateral; anyone can repay or liquidate (intended); admin actions check the config's admin.
- **Token handling:** `transfer_checked` with mint and decimals; vaults and share mint are owned by the market PDA; token programs are checked against the market; Token-2022 mints with anything beyond metadata are refused.
- **Arithmetic:** checked math throughout, `overflow-checks = true` in release builds; rounding favors the protocol (debt up, shares and payouts down).
- **Share price:** internal cash accounting ignores tokens sent straight to a vault; virtual +1 offsets on an empty market.
- **Liquidation bounds:** only unhealthy positions, repay capped at the close factor and the amount that restores the target LTV, slippage guard for the liquidator, bad debt written off when collateral runs out (protocol fees absorb it first).
- **Admin limits:** two-step admin handoff, timelocked settings with validation, instant pause that only stops new borrows, fee collection limited to accrued fees and idle cash.

## Second review: treasury, liquidation fee, migration, Loop pXNT (Oct 24, 2026)

| ID | Severity | Finding | Status |
|---|---|---|---|
| L-01 | Low | The protocol took its share of the liquidation bonus even on a liquidation that left lenders with bad debt | **Fixed**, test added, live on testnet |
| L-02 | Low | Loop's net APY ignored the stake pool's fees and could mislead at high leverage, where the loop's own borrowing raises the rate | **Fixed** in the app |
| L-03 | Low | Unwind defaulted to redeeming all collateral for XNT, including pXNT the user may have wanted to keep earning | **Fixed** in the app |
| L-04 | Low | After an epoch boundary and before the stake pool's update, pXNT was still valued at the previous epoch's rate, so a loss landing at that update could be borrowed against first | **Fixed**: borrowing and collateral withdrawal with debt wait for the update; liquidations don't. Test added, live on testnet |
| I-01 | Info | The first treasury is set without a delay | **Resolved**: `launch.ts init` creates the config and sets the treasury in one transaction |
| I-02 | Info | The one-time migration instructions stay in the program | Admin-only and accept only old-layout accounts; remove in a later upgrade |

**L-01.** When a liquidation took a position's last collateral and debt remained, the protocol still kept 10% of the
bonus while lenders absorbed the written-off debt. Now no fee is taken on that liquidation; the liquidator keeps the
full bonus. `pxnt_market_full_cycle` checks that the liquidation which creates bad debt adds no protocol fee.

**L-02.** The estimate now subtracts the stake pool's 0.1% in and 0.1% out, shows the borrow rate before and after the
loop, suggests the leverage with the best net APY for the amount entered, and refuses any loop that would earn less
than plain staking.

**L-03.** Unwind now returns the remaining pXNT by default; redeeming it for XNT is an explicit choice.

Checked and found sound in the new code:

- **Treasury:** fees can only reach token accounts owned by the configured treasury (owner checked by the token
  constraint); payouts are capped at accrued fees and idle cash; later treasury changes wait for the timelock and
  only the admin can queue them.
- **Liquidation fee:** never more than the bonus part of the seizure, so the liquidator always receives at least the
  debt's worth; `min_collateral_out` applies to what the liquidator receives; the collateral vault always equals
  borrowers' collateral plus unpaid fees (tested), and borrowers can't withdraw the fee part.
- **Migration:** admin-only, checks owner, discriminator, exact old size and the config link; idempotent; tested on
  copies of every real testnet account with every field compared.
- **Loop pXNT (client only):** uses existing instructions; every step stays under 99% of the borrow limit on its own,
  so a failed transaction leaves a healthy position; amounts carry safety margins against pool rate changes. Run
  live on testnet: loop at 2.5x and full unwind.
- **Simulations:** the stress suite was re-run with the fee and a new Loop pXNT suite; no new program issue found.
  Details are kept in the internal notes.

## Before mainnet

- Move the program upgrade authority and the protocol admin to a multisig.
- Get an independent audit.

## Tests

23 unit tests (math, oracle, attack cases), 8 integration tests against the compiled program (including real mainnet accounts and the app's own transactions), an agent-based stress suite, and a live testnet drill.

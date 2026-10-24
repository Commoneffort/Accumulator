# Accumulator — lend and borrow on X1

Lenders deposit XNT or USDC.x and earn the interest borrowers pay. Borrowers post
collateral and borrow against it. Each market is isolated: its own lenders,
collateral and risk settings, so trouble in one can't drain another.

Accumulator needs no price feed. X1 has no Pyth or Switchboard, and XNT trades only on
XDEX, so every price comes from on-chain data:

| Market | Lend | Collateral | Price | Max LTV / liquidation |
| --- | --- | --- | --- | --- |
| v1 `XNT / pXNT` | XNT | pXNT (staked XNT) | X1 stake pool rate (`total_lamports / pool_token_supply`) | 80% / 85%, 2% bonus |
| v1.1 `USDC.x / XNT` | USDC.x | XNT | XDEX XNT/USDC.x 20-minute TWAP from the pool's own price history | 50% / 65%, 5% bonus |

Program ID: `BTjwAkUiiGSrhYxTGD8UskZNTT1TMTQjkD4NQtk6Vs9y` (keypair in `target/deploy/accumulator-keypair.json`).

- **Testnet: live** since 2026-10-23. Markets: XNT / pXNT, and USDC / XNT lending percolator's mintable test USDC `7jpU…` (6 decimals), priced by testnet XDEX (`7EEuq61z…`) pool `8SgXc…`. Fund testers with `spl-token mint 7jpU… <amount> <account> --mint-authority ~/percolator/percolator-vault/keys/x1-faucet.json`. The first USDC market (`4dr9…`, unmintable) stays listed as withdraw-only. 5-minute timelock. The testnet binary is built with `cargo build-sbf --manifest-path programs/accumulator/Cargo.toml --features testnet --sbf-out-dir target/deploy-testnet`. **Never deploy `target/deploy-testnet/` to mainnet.** Upgrade authority and admin: `~/.config/solana/accumulator-testnet-admin.json` (`G2w3VMSDi7wcNxnp6dhaFu8VNiqhCEs6L5MngtPJh7Kt`). App: https://accumulator-x1.vercel.app/?network=testnet
- **Mainnet: not deployed.**
- Get pXNT on either network: `KEYPAIR=… AMOUNT=10 npx ts-node scripts/get-pxnt.ts --send` (or the "Stake XNT for pXNT" box in the app).

## How the safety works

- **No raw spot prices.** XDEX pools keep 100 price snapshots on-chain (Raydium CP-swap layout). Accumulator averages them over 20 minutes, so a price pushed inside one transaction barely moves it. In tests, a 10x pump held for 14 seconds moved the average about 10%.
- **The conservative price for each action.** Borrowing and withdrawing collateral use the lower of TWAP and spot, so a pump can't raise a borrow limit. Liquidations use TWAP only, so a sudden dump can't force them.
- **Attacks have to pay.** Inflating collateral only profits if price × LTV > 1. At 50% LTV that means holding XNT's 20-minute average above 2x while arbitrage trades against you. Borrow caps on the USDC.x market (1,000 USDC.x total, 250 per account at launch) stay below what that would cost in today's ~$9k pool.
- **Gentle liquidations.** A liquidator may repay only enough to bring the position back to the midpoint between max LTV and the liquidation threshold (82.5% / 57.5%), never more than 50% of the debt, unless the debt is dust.
- **Bad debt** (collateral gone, debt left) is written off at once. Unclaimed protocol fees absorb it first; lenders take only the rest.
- **Lenders can always exit.** Rates climb steeply past 85% utilization (80% on USDC.x), and borrows may not push utilization past 95% (90%).
- **Internal accounting.** Tokens sent straight to a vault are ignored, so share-price inflation games don't work.
- **The admin can't move lender funds.** Admin powers: create markets, queue risk changes (applied after a 2-day timelock, by anyone), pause new borrows (instant; repay, deposits and liquidations keep working), and collect accrued protocol fees from idle cash. Admin handoff is two-step.
- **Fail closed.** Wrong owner, wrong layout, mismatched mints or vaults, or too little price history all reject the transaction. Token-2022 mints with anything beyond metadata extensions (transfer fees, hooks…) are refused at market creation.

## Layout

```
programs/accumulator/      Anchor program (Rust)
  src/math.rs         interest, shares, liquidation sizing (+ unit tests)
  src/oracle.rs       stake pool rate and XDEX TWAP readers (+ unit tests)
  src/instructions/   admin, lend, borrow, liquidate
sdk/src/            TypeScript SDK: AccumulatorClient, PDAs, off-chain copy of the math, launch presets
app/                Frontend (Vite + React, X1/Backpack wallet)
bots/liquidator.ts  Liquidation bot
scripts/launch.ts   Mainnet setup (simulates unless --send)
scripts/fetch-fixtures.ts  Snapshot the live mainnet accounts Accumulator reads
scripts/app-plan.ts Build the frontend's transactions for the replay test
tests-rs/           Integration tests: the compiled program in LiteSVM
tests/sdk.test.ts   SDK math matches the program
```

## Build and test

```bash
anchor build && npm run sync-idl    # program + IDL into the SDK
npm run test:unit                   # 22 Rust unit tests (math, oracle)
npm run test:program                # 8 LiteSVM integration tests, incl. real mainnet accounts and the app's own txs
npm test                            # SDK parity tests
npm run fixtures                    # refresh the mainnet snapshot (read-only RPC)
cd app && npm run dev               # frontend on http://127.0.0.1:5174 (VITE_RPC to override)
npm run deploy                      # build + publish to https://accumulator-x1.vercel.app (VERCEL_TOKEN in .env)
```

The integration tests are in Rust because the LiteSVM Node bindings crash
intermittently (`std::bad_alloc`) on this setup.

## Deploy and launch

**Mainnet: follow `MAINNET.md`** (keys, preflight, exact commands, handover). The steps below are the short version.

1. Make a **new** upgrade-authority / admin key. Never use the compromised `id.json` (`DtZz…`).
2. Deploy (about 4.1 XNT of rent for the 580 KB program):
   ```bash
   anchor deploy --provider.cluster https://rpc.mainnet.x1.xyz --provider.wallet ~/.config/solana/accumulator-admin.json
   ```
3. Set up, simulating first:
   ```bash
   ADMIN=~/.config/solana/accumulator-admin.json npx ts-node scripts/launch.ts init             # dry run
   ADMIN=~/.config/solana/accumulator-admin.json npx ts-node scripts/launch.ts init --send
   ADMIN=… npx ts-node scripts/launch.ts create xntPxnt --send
   ADMIN=… npx ts-node scripts/launch.ts create usdcXnt --send   # v1.1, when ready
   npx ts-node scripts/launch.ts status
   ```
4. Run a liquidator (anyone can):
   ```bash
   KEYPAIR=~/.config/solana/liquidator.json DRY_RUN=1 npx ts-node bots/liquidator.ts
   ```

## Stress tests and drills

`cd tests-rs && cargo test --release --test stress -- --ignored --nocapture` runs the agent-based stress suite; `scripts/drill/drill.ts` runs the
live testnet drill. Results and the risk notes drawn from them are in `internal/RISK-NOTES.md`, which is kept out of
anything published.

## Fees and treasury

- 10% of interest (`reserve_factor_bps`) and 10% of each liquidation bonus (`liquidation_fee_bps`, paid in collateral) go to the protocol.
- Fees can only go to token accounts owned by the treasury in the config (`DyKtYX7jpkp7VLmwoGVTup1PXYYJBoeuv3XEG1Jpe1GV`, a Ledger).
  The first `set_treasury` applies at once; later changes wait for the timelock (`apply_treasury`, anyone).
- Anyone can pay fees out: `NETWORK=testnet KEYPAIR=<payer> npx ts-node scripts/ops/collect-fees.ts --send`.
  XNT fees arrive as wrapped XNT; the treasury unwraps by closing that token account.

## Loop pXNT / rXNT

Markets: XNT / pXNT (X1 stake pool), XNT / rXNT (Ripper Pool, same stake pool program, Token-2022 token), USDC.x / XNT (XDEX TWAP).

The app's Loop tab (`app/src/loop.ts`, `app/src/Loop.tsx`) stakes XNT, borrows XNT against the pXNT and restakes, in a
few transactions signed once; Unwind redeems pXNT at the stake pool (WithdrawSol) to repay. Every step stays under the
borrow limit on its own. Net APY ≈ staking APY × leverage − borrow APR × (leverage − 1); the app refuses to loop at a loss.
Live check: `KEYPAIR=<wallet> DEPOSIT=1 LEVERAGE=2.5 npx ts-node scripts/ops/loop-test.ts` (testnet).

## Oct 2026 upgrade (testnet done)

The treasury and liquidation-fee fields changed the Config and Market layouts. After upgrading a program that already
has accounts, run `scripts/upgrade-2026-10.ts` (migrates every old account, sets the treasury, queues the fee), then
`scripts/ops/apply-all.ts` once the timelock passes. On a fresh mainnet deploy the same script only sets the treasury.
`tests-rs/tests/upgrade.rs` migrates copies of the real testnet accounts and checks nothing changes.

## Security review

See `AUDIT.md` (Oct 24, 2026). One high-severity issue was found and fixed: a pump inside one transaction could move
the XDEX average ~12x because the stretch since XDEX's last snapshot used the current price. That stretch is now held
within 2% of the latest recorded price. Fixed and deployed to testnet with an attack test.

## Before real money

- **Get an outside audit.** There is an internal review (`AUDIT.md`) but no independent audit yet.
- **XDEX is upgradeable** (authority `cveZ26…NNY`). If it changes its account layout, Accumulator rejects the price, which pauses borrowing and liquidations in the USDC.x market until a fix. Watch for XDEX upgrades.
- **Liquidating pXNT** pays liquidators in pXNT. They exit through the stake pool (withdrawal fees apply), which the 2% bonus has to cover.
- **The stake pool rate updates once per epoch.** Between updates it lags slightly, always on the low side.
- **The USDC.x market is small on purpose.** Raise its caps (2-day timelock) only as XDEX liquidity grows.

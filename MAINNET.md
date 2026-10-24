# Mainnet launch runbook

Status on Oct 24, 2026: everything is built and checked, and **nothing is deployed to mainnet**. Each step below
changes mainnet only when you run it with `--send` (or `solana program deploy`); run it only after you've approved it.

`npx ts-node` below means `NODE_OPTIONS=--no-experimental-strip-types npx ts-node --transpile-only`.

## 0. Decisions

| Decision | Setting (decided Oct 24, 2026) | Why |
|---|---|---|
| XNT market kink rate (`slope1`) | **4%** at 85% use (was 6%) | Mainnet staking pays ~5.8%; at 6% looping paid only well below the kink. Simulated: utilization settles ~85%, lenders ~3.7%, 3x loopers ~11%/yr |
| XNT / pXNT caps | **250k XNT deposits / 200k borrows / 25k per account** | ~$62k at risk while only internally reviewed; no position above ~12% of borrows, so liquidator capital covers any one |
| XNT / rXNT (Ripper Pool) | **75% LTV / 82% liquidation / 3% bonus; 50k XNT deposits / 40k borrows / 10k per account; 4% kink** | Same program, same pricing as pXNT. Third-party pool, 10.6M XNT over 72 validators, 366k XNT liquid reserve and a 0.2% withdrawal fee, so caps sit at ~1/7 of the reserve and LTV a little lower |
| USDC.x / XNT caps | **$10k deposits / $1k borrows / $250 per account** | XDEX pool holds ~$4.9k USDC.x; keep borrows under ~2x depth (stress: 0.07% bad debt in a -60%/1h crash at $1k) |
| Open USDC.x / XNT on day 1 | **Yes, once the liquidator holds ~300 USDC.x** | The $1k borrow cap bounds the loss: the worst simulated crash (-85% in 2h, weak arbitrage) left ~$480 of bad debt. Its liquidations need USDC.x on hand and sell XNT into the same thin pool |
| Final admin + upgrade authority | Launch key `DTpN5p…`, then a Ledger (or multisig), step 6 | Not yet chosen which Ledger |
| Independent audit | Before raising caps above launch levels | Internal review only (`AUDIT.md`) |

Caps rise later through the 2-day timelock (`launch.ts queue`). Settings live in `sdk/src/markets.ts`; after a change run
`npm run build`, `npm test` and `cd tests-rs && cargo test --release`, then the preflight.

Verified against mainnet on Oct 24: XDEX pool `CAJeVEo…` is owned by `sEsYH97…`; token 0 = XNT (9 decimals) in vault
`8wvV4HK…`, token 1 = USDC.x `B69chRz…` (Token-2022, **6 decimals**) in vault `7iw2adw…`; observation `4oUvUgz…` points
back to the pool. The SDK matches all of these, and `tests-rs/tests/mainnet_fork.rs` runs the mainnet binary on fresh
copies of these accounts (20-min TWAP $0.2633).

## 1. Keys

| Role | File | Address |
|---|---|---|
| Program id | `~/.config/solana/accumulator-program-keypair.json` (copy of `target/deploy/accumulator-keypair.json`) | `BTjwAkUiiGSrhYxTGD8UskZNTT1TMTQjkD4NQtk6Vs9y` |
| Launch: fee payer, first upgrade authority, first admin (needs ~10.5 XNT) | `~/.config/solana/accumulator-mainnet-admin.json` | `DTpN5pDvFnxQTfsZaMCVqUjGGdG8MNwsFxEBsGfsVnNy` |
| Fee treasury (Ledger) | — | `DyKtYX7jpkp7VLmwoGVTup1PXYYJBoeuv3XEG1Jpe1GV` |
| Liquidator bot | `~/.config/solana/accumulator-liquidator.json` | `EngchjyRLEKqDTV9NP9Atzx4q6VGv23MwFaJCELMcYm` |

Back up the program and launch key files offline. Never use `DtZz8J1…` (compromised; still on disk as
`~/.config/solana/Dtzz.json`). The scripts refuse it.

## 2. Fund and check

Send **~10.5 XNT** to the launch key (5.7 stays as program rent, 4.5 is refunded after the deploy). Then:

```bash
npx ts-node scripts/mainnet-preflight.ts      # read-only; must end with 0 fail
```

Last run (Oct 24): 29 pass, 1 fail (launch key unfunded). Also simulated on mainnet: the app's stake + redeem
transactions on both the X1 pool and the Ripper Pool (`scripts/ops/simulate-stake.ts`).

## 3. Deploy the program

The mainnet binary is `target/deploy-mainnet/accumulator.so` (built **without** `--features testnet`; never deploy
`target/deploy-testnet/`). Rebuild it after any code or settings change and re-run the preflight.

```bash
cargo build-sbf --manifest-path programs/accumulator/Cargo.toml --sbf-out-dir target/deploy-mainnet
rm -f target/deploy-mainnet/accumulator-keypair.json    # build-sbf drops a random keypair here; never use it
sha256sum target/deploy-mainnet/accumulator.so          # f3253e9b…b28c at the time of writing

solana program deploy target/deploy-mainnet/accumulator.so \
  --url https://rpc.mainnet.x1.xyz \
  --program-id ~/.config/solana/accumulator-program-keypair.json \
  --keypair ~/.config/solana/accumulator-mainnet-admin.json \
  --fee-payer ~/.config/solana/accumulator-mainnet-admin.json \
  --upgrade-authority ~/.config/solana/accumulator-mainnet-admin.json \
  --max-len 816270
solana program show BTjwAkUiiGSrhYxTGD8UskZNTT1TMTQjkD4NQtk6Vs9y --url https://rpc.mainnet.x1.xyz \
  --keypair ~/.config/solana/accumulator-mainnet-admin.json
```

`--max-len` leaves 25% room so later upgrades don't need `solana program extend`.

## 4. Config + treasury, then the first market

Each step simulates first; add `--send` to submit.

```bash
export ADMIN=~/.config/solana/accumulator-mainnet-admin.json
npx ts-node scripts/launch.ts init            # config (2-day timelock) + treasury, one transaction
npx ts-node scripts/launch.ts init --send
npx ts-node scripts/launch.ts create xntPxnt
npx ts-node scripts/launch.ts create xntPxnt --send
npx ts-node scripts/launch.ts create xntRxnt --send
npx ts-node scripts/launch.ts create usdcXnt --send     # after funding the liquidator with USDC.x
npx ts-node scripts/launch.ts status
```

Before each `--send`, run the same line without it: it simulates against mainnet.

The site needs no change: https://accumulator-x1.vercel.app shows mainnet markets as live as soon as they exist.
Update the Docs page's "Addresses" row ("mainnet not deployed yet") and redeploy the site.

## 5. Liquidator and housekeeping

```bash
# fund EngchjyRLEKqDTV9NP9Atzx4q6VGv23MwFaJCELMcYm with XNT (and USDC.x once that market opens), then:
sudo cp bots/accumulator-liquidator.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now accumulator-liquidator
journalctl -u accumulator-liquidator -f
```

Fee payouts to the treasury (anyone can run; weekly is plenty):

```bash
KEYPAIR=~/.config/solana/accumulator-liquidator.json npx ts-node scripts/ops/collect-fees.ts --send
```

Settings changes: `launch.ts queue <market>` (admin), then after 2 days `scripts/ops/apply-all.ts` (anyone).

## 6. Hand over the keys

```bash
# admin role: propose, then accept from the Ledger wallet in the app (footer: "Accept admin role")
npx ts-node scripts/launch.ts handoff <LEDGER_PUBKEY> --send

# upgrade authority (future upgrades then need the Ledger: --upgrade-authority usb://ledger)
solana program set-upgrade-authority BTjwAkUiiGSrhYxTGD8UskZNTT1TMTQjkD4NQtk6Vs9y \
  --new-upgrade-authority <LEDGER_PUBKEY> --skip-new-upgrade-authority-signer-check \
  --url https://rpc.mainnet.x1.xyz --keypair ~/.config/solana/accumulator-mainnet-admin.json
```

Check `solana program show` and `launch.ts status` afterwards, then empty the launch key.

## If something goes wrong

- **Stop new borrowing at once:** `npx ts-node scripts/launch.ts pause <market> --send` (repay, deposits, withdrawals and liquidations keep working).
- **Code fix:** build, test, deploy to testnet, then upgrade mainnet with the upgrade authority.
- The admin can never move lender deposits or borrower collateral, with or without these steps.

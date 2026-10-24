import { MAINNET_MARKETS, ACCUMULATOR_PROGRAM_ID, TESTNET_MARKETS } from "../../sdk/src";

type Def = (typeof MAINNET_MARKETS)[keyof typeof MAINNET_MARKETS];
const pct = (bps: number) => `${(bps / 100).toFixed(0)}%`;
const amt = (v: bigint, d: number) => (Number(v) / 10 ** d).toLocaleString("en-US", { maximumFractionDigits: 0 });

const SECTIONS = [
  ["earn", "Earn"],
  ["borrow", "Borrow"],
  ["health", "Health & liquidation"],
  ["prices", "Where prices come from"],
  ["markets", "Markets & settings"],
  ["safety", "What the admin can and can't do"],
  ["risks", "Risks"],
  ["testnet", "Try it on testnet"],
  ["addresses", "Addresses"],
  ["faq", "FAQ"],
] as const;

function MarketRow({ d }: { d: Def }) {
  const p = d.params;
  return (
    <tr>
      <th scope="row">{d.name}</th>
      <td>{d.lendSymbol}</td>
      <td>{d.collateralSymbol}</td>
      <td className="r num">{pct(p.maxLtvBps)}</td>
      <td className="r num">{pct(p.liquidationThresholdBps)}</td>
      <td className="r num">{pct(p.liquidationBonusBps)}</td>
      <td className="r num">
        {pct(p.slope1Bps)} at {pct(p.optimalUtilizationBps)}, {pct(p.baseRateBps + p.slope1Bps + p.slope2Bps)} at 100%
      </td>
      <td className="r num">
        {amt(p.borrowCap, d.lendDecimals)} {d.lendSymbol}
      </td>
      <td>{d.oracleKind === "stakePool" ? "Stake pool rate" : `XDEX ${p.twapWindowSecs / 60}-min average`}</td>
    </tr>
  );
}

export function Docs({ onOpenApp }: { onOpenApp: () => void }) {
  const mainnet = Object.values(MAINNET_MARKETS) as Def[];
  const testnet = Object.values(TESTNET_MARKETS) as Def[];
  return (
    <div className="docs">
      <nav className="docs-toc" aria-label="On this page">
        <span className="toc-title">Docs</span>
        {SECTIONS.map(([id, label]) => (
          <a key={id} href={`#docs-${id}`}>
            {label}
          </a>
        ))}
        <button className="cta small" onClick={onOpenApp}>
          Open the app
        </button>
      </nav>

      <article className="docs-body">
        <header className="docs-hero">
          <span className="eyebrow">Accumulator docs</span>
          <h1>
            Lend to <span className="neon">earn</span>. Borrow without selling.
          </h1>
          <p className="lede">
            Accumulator is a lending market on X1. Lenders deposit XNT or USDC and earn the interest borrowers pay. Borrowers lock
            collateral and take a loan against it. Every price comes from data already on X1, with no outside oracle.
          </p>
        </header>

        <section id="docs-earn">
          <h2>Earn</h2>
          <p>
            Deposit a token into a market and you get <strong>market shares</strong> back. Borrowers pay interest into the
            market every second, so each share is worth a little more over time. When you withdraw, your shares are turned
            back into the token, including everything they earned.
          </p>
          <ul>
            <li>
              <strong>Supply APY</strong> is what you earn right now: the borrow rate × the share of deposits that are lent
              out × 0.9. The protocol keeps 10% of interest; lenders get the other 90%.
            </li>
            <li>The rate moves with demand. More borrowing means a higher APY, often sharply higher past the market's "kink".</li>
            <li>
              You can withdraw any amount that isn't lent out. If most deposits are borrowed, rates climb steeply, which pushes
              borrowers to repay and frees up cash for you.
            </li>
            <li>Your shares are ordinary tokens in your wallet. Sending tokens straight to a market's vault doesn't change their value.</li>
          </ul>
        </section>

        <section id="docs-borrow">
          <h2>Borrow</h2>
          <p>
            Lock collateral, then borrow up to the market's <strong>borrow limit</strong> (max LTV): the share of your
            collateral's value you can take as a loan. Interest is added to your debt continuously. Repay any time, any amount;
            anyone can repay a loan for someone else.
          </p>
          <ul>
            <li>
              <strong>XNT / pXNT:</strong> lock pXNT (staked XNT), borrow XNT. Both sides are XNT, so only the stake pool's
              exchange rate matters, not the market price of XNT. Use it to get liquidity without unstaking, or to loop
              staking.
            </li>
            <li>
              <strong>USDC / XNT:</strong> lock XNT, borrow USDC. Get dollars without selling your XNT. If XNT falls, your
              position gets riskier.
            </li>
            <li>The app wraps and unwraps XNT for you; you only ever see plain XNT in your wallet.</li>
          </ul>
        </section>

        <section id="docs-health">
          <h2>Health & liquidation</h2>
          <p>
            <strong>Health</strong> = collateral value × liquidation threshold ÷ debt. Above 1.00 you're safe. At or below
            1.00, anyone may repay part of your debt and take that much of your collateral plus a <strong>bonus</strong>.
          </p>
          <ul>
            <li>
              A liquidation only repays enough to bring you back to safety (halfway between the borrow limit and the
              liquidation threshold), never more than half your debt at once. You keep the rest.
            </li>
            <li>Very small debts can be cleared in one go.</li>
            <li>
              If collateral runs out before the debt is covered, the remainder is written off. Unclaimed protocol fees absorb
              it first; lenders share the rest.
            </li>
            <li>To stay safe: add collateral or repay when health gets close to 1.10.</li>
          </ul>
        </section>

        <section id="docs-prices">
          <h2>Where prices come from</h2>
          <p>X1 has no Pyth or Switchboard, and XNT trades only on XDEX, so Accumulator reads prices straight from X1:</p>
          <ul>
            <li>
              <strong>pXNT</strong> is valued by the X1 stake pool's own exchange rate (total XNT staked ÷ pXNT supply). It
              can't be pumped by trading.
            </li>
            <li>
              <strong>XNT in USDC</strong> uses XDEX's on-chain price history: an average over the last 20 minutes, which a
              trade inside one transaction barely moves.
            </li>
            <li>
              <strong>Borrowing</strong> uses the lower of that average and the current price, so a pump can't raise your
              limit. <strong>Liquidation</strong> uses the average only, so a sudden wick can't liquidate you.
            </li>
            <li>If the price accounts look wrong in any way (wrong owner, pool, vault or too little history), the action is refused.</li>
          </ul>
        </section>

        <section id="docs-markets">
          <h2>Markets & settings</h2>
          <div className="table-wrap">
            <table className="grid">
              <thead>
                <tr>
                  <th>Market</th>
                  <th>Lend</th>
                  <th>Collateral</th>
                  <th className="r">Borrow limit</th>
                  <th className="r">Liquidation at</th>
                  <th className="r">Bonus</th>
                  <th className="r">Borrow rate</th>
                  <th className="r">Borrow cap</th>
                  <th>Price</th>
                </tr>
              </thead>
              <tbody>
                {mainnet.map((d) => (
                  <MarketRow key={d.name} d={d} />
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted small">Mainnet launch presets. Live values are shown in the app and can only change after the timelock.</p>
        </section>

        <section id="docs-safety">
          <h2>What the admin can and can't do</h2>
          <div className="two">
            <div>
              <h3 className="good">Can</h3>
              <ul>
                <li>Open new markets</li>
                <li>Queue risk changes, which apply only after a 2-day delay</li>
                <li>Pause new borrows (repay, deposits, withdrawals and liquidations keep working)</li>
                <li>Collect the protocol's 10% share of interest, from idle cash only</li>
              </ul>
            </div>
            <div>
              <h3 className="bad">Can't</h3>
              <ul>
                <li>Move lenders' deposits or borrowers' collateral</li>
                <li>Change settings instantly</li>
                <li>Block withdrawals or repayments</li>
                <li>Use a price source other than the one fixed when the market opened</li>
              </ul>
            </div>
          </div>
        </section>

        <section id="docs-risks">
          <h2>Risks</h2>
          <ul>
            <li>
              <strong>No independent audit yet.</strong> The program has had an internal security review (one high-severity
              issue found and fixed) and extensive testing, but no outside audit.
            </li>
            <li>
              <strong>Bad debt.</strong> If collateral loses value faster than loans can be liquidated, some loans can end
              up worth more than their collateral. Lenders in that market share the loss.
            </li>
            <li>
              <strong>Withdrawals can wait.</strong> You can only withdraw what isn't lent out. In a rush to exit, it takes
              rising rates and repayments to free up cash.
            </li>
            <li>
              <strong>Borrow rates can spike.</strong> Near full utilization rates climb steeply (up to ~208% a year in the
              USDC market) to pull borrowed funds back.
            </li>
          </ul>
        </section>

        <section id="docs-testnet">
          <h2>Try it on testnet</h2>
          <ol>
            <li>Switch the network to <strong>Testnet</strong> (top left) and connect your X1 wallet.</li>
            <li>
              <strong>Earn:</strong> pick a market, open <em>Lend</em>, and deposit testnet XNT or test USDC.
            </li>
            <li>
              <strong>Get pXNT</strong> in <em>Borrow XNT</em> → "Stake XNT for pXNT" (deposits into the X1 stake pool).
            </li>
            <li>
              <strong>Borrow:</strong> add collateral, borrow, then watch your health as prices move.
            </li>
          </ol>
          <p className="muted small">Testnet markets: {testnet.map((d) => d.name).join(", ")}. Test USDC is percolator's mintable test token.</p>
        </section>

        <section id="docs-addresses">
          <h2>Addresses</h2>
          <table className="grid kv">
            <tbody>
              <tr><th scope="row">Program (testnet; mainnet not deployed yet)</th><td className="addr">{ACCUMULATOR_PROGRAM_ID.toBase58()}</td></tr>
              {testnet.map((d) => (
                <tr key={d.name}><th scope="row">Testnet market: {d.name}</th><td className="addr">{d.address.toBase58()}</td></tr>
              ))}
              {mainnet.map((d) => (
                <tr key={d.name}><th scope="row">Mainnet market (when opened): {d.name}</th><td className="addr">{d.address.toBase58()}</td></tr>
              ))}
            </tbody>
          </table>
        </section>

        <section id="docs-faq">
          <h2>FAQ</h2>
          <details><summary>Is the APY fixed?</summary><p>No. It changes every second with how much is borrowed. The app always shows the current rate.</p></details>
          <details><summary>Where does the yield come from?</summary><p>Only from borrowers paying interest. There are no token emissions; if nobody borrows, lenders earn 0%.</p></details>
          <details><summary>Can I lose money lending?</summary><p>Yes, if loans go bad faster than they can be liquidated, or through a bug. See Risks.</p></details>
          <details><summary>Why can't I withdraw everything right now?</summary><p>Part of the deposits is lent out. You can take what's idle; the rest frees up as borrowers repay or get liquidated.</p></details>
          <details><summary>Why is my borrow limit lower than I expected?</summary><p>Borrowing uses the lower of XDEX's 20-minute average and its current price, so a recent pump doesn't count yet.</p></details>
        </section>
      </article>
    </div>
  );
}

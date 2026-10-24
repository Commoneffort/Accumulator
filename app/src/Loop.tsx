import { useEffect, useMemo, useState } from "react";
import { Connection, Transaction } from "@solana/web3.js";
import { BPS, Market, StakePoolInfo, estimateStakingApy, fetchStakePool, obligationPda, waitForPoolUpdate } from "../../sdk/src";
import type { Ctx } from "./actions";
import { borrowAprAfter, leverageOf, loopTxs, netApy, planLoop, planUnwind, unwindTxs, Position } from "./loop";

const fmtX = (v: bigint, digits = 4) => (Number(v) / 1e9).toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: 2 });
const pctN = (x: number) => `${(x * 100).toFixed(2)}%`;

/**
 * Loop a staked-XNT token (pXNT, rXNT): stake XNT, borrow XNT against it, stake that too, repeat,
 * for leveraged staking yield. Only offered on the stake-pool-priced market.
 */
export function LoopPanel(props: {
  conn: Connection;
  market: Market;
  /** collateral token symbol, e.g. pXNT or rXNT */
  symbol: string;
  priceWad: bigint | null;
  cash: bigint;
  borrows: bigint;
  position: Position;
  hasObligation: boolean;
  walletXnt: bigint;
  connected: boolean;
  busy: string | null;
  runMany: (label: string, build: (c: Ctx) => Promise<Transaction[]>) => void;
}) {
  const { conn, market: m, priceWad, cash, borrows, position, busy, symbol: sym } = props;
  const poolAddr = m.oracleAccounts[0];
  const [pool, setPool] = useState<StakePoolInfo | null>(null);
  const [stakeApy, setStakeApy] = useState<number | null>(null);
  const [amount, setAmount] = useState("");
  const [lev, setLev] = useState(2.5);
  // off by default: unwinding then returns the staked token, which keeps earning; ticking it redeems everything to XNT
  const [toXnt, setToXnt] = useState(false);

  useEffect(() => {
    let live = true;
    const load = () => {
      fetchStakePool(conn, poolAddr).then((p) => live && setPool(p)).catch(() => {});
      estimateStakingApy(conn, poolAddr).then((a) => live && setStakeApy(a)).catch(() => {});
    };
    load();
    const t = setInterval(load, 60_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [conn, poolAddr]);
  // the pool's fee to stake plus its fee to redeem, charged on the whole position once each way
  const roundTrip = pool ? pool.solDepositFee + pool.solWithdrawalFee : 0.002;
  const feeText = (f: number) => `${(f * 100).toFixed(1)}%`;

  // highest leverage that still sits a little under the borrow limit
  const maxLev = Math.min(4, Math.floor((1 / (1 - (m.params.maxLtvBps / 10_000) * 0.97)) * 4) / 4);
  const deposit = /^\d*\.?\d*$/.test(amount) && amount !== "" && amount !== "." ? BigInt(Math.floor(Number(amount) * 1e9)) : 0n;
  const room = (a: bigint, b: bigint) => (a > b ? a - b : 0n);
  const marketRoom = [
    cash,
    room(((cash + borrows) * BigInt(m.params.maxUtilizationBps)) / BPS, borrows),
    room(m.params.borrowCap, borrows),
    room(m.params.maxBorrowPerObligation, position.debt),
  ].reduce((a, b) => (a < b ? a : b));

  const plan = useMemo(
    () => (pool && priceWad && deposit > 0n ? planLoop({ pool, market: m, priceWad, start: position, deposit, leverage: lev, marketRoom }) : null),
    [pool, priceWad, deposit, lev, marketRoom, m, position],
  );
  const after = plan?.end ?? position;
  const levAfter = priceWad ? leverageOf(after, priceWad) : 1;
  const aprNow = Number(borrowAprAfter(m, cash, borrows, 0n)) / 10_000;
  const aprAfter = Number(borrowAprAfter(m, cash, borrows, plan?.borrowed ?? 0n)) / 10_000;
  // net of the stake pool's 0.1% in and 0.1% out on the whole position, spread over a year
  const net = stakeApy !== null && isFinite(levAfter) ? netApy(stakeApy, aprAfter, levAfter) - roundTrip * levAfter : null;

  // Your own borrowing raises the rate, so more leverage can earn less. Find the best leverage for this amount.
  const best = useMemo(() => {
    if (!pool || !priceWad || deposit === 0n || stakeApy === null) return null;
    let top: { lev: number; net: number; reached: number } | null = null;
    for (let x = 1.25; x <= maxLev + 1e-9; x += 0.25) {
      const p = planLoop({ pool, market: m, priceWad, start: position, deposit, leverage: x, marketRoom });
      const L = leverageOf(p.end, priceWad);
      if (!isFinite(L)) continue;
      const n = netApy(stakeApy, Number(borrowAprAfter(m, cash, borrows, p.borrowed)) / 10_000, L) - roundTrip * L;
      if (!top || n > top.net + 1e-6) top = { lev: x, net: n, reached: L };
    }
    return top;
  }, [pool, priceWad, deposit, stakeApy, maxLev, m, position, marketRoom, cash, borrows, roundTrip]);
  const breakEven = stakeApy !== null && levAfter > 1 ? (stakeApy * levAfter) / (levAfter - 1) : null;
  const valueAfter = priceWad ? Number((after.collateral * priceWad) / 10n ** 18n) : 0;
  const health = after.debt > 0n ? (valueAfter * (m.params.liquidationThresholdBps / 10_000)) / Number(after.debt) : Infinity;
  const dropToLiq = after.debt > 0n && valueAfter > 0 ? 1 - Number(after.debt) / (valueAfter * (m.params.liquidationThresholdBps / 10_000)) : null;
  const worse = net !== null && stakeApy !== null && net < stakeApy;
  const tooMuch = deposit > props.walletXnt;

  const unwind = useMemo(
    () => (pool && priceWad && position.debt > 0n ? planUnwind({ pool, market: m, priceWad, start: position }) : null),
    [pool, priceWad, position, m],
  );
  const levNow = priceWad ? leverageOf(position, priceWad) : 1;

  return (
    <div className="pad">
      <div className="earn-inline loop-head">
        <span>Leveraged staking</span>
        <b className="num">{net !== null ? pctN(net) : stakeApy !== null ? pctN(stakeApy) : "—"}</b>
        <span>
          {net !== null && deposit > 0n
            ? `estimated net APY at ${levAfter.toFixed(2)}x after stake pool fees, vs ${pctN(stakeApy!)} plain staking`
            : `staking APY ${stakeApy !== null ? pctN(stakeApy) : "…"} (estimated from the stake pool's last epoch)`}
        </span>
      </div>
      <p className="muted small">
        Stakes your XNT for {sym}, borrows XNT against it, stakes that too, and repeats, in one approval. You earn staking yield
        on the whole position and pay the borrow rate on the debt. Both sides are XNT, so XNT's price doesn't matter; the risk
        is the borrow rate rising above the staking yield.
      </p>
      <p className="muted small">
        Staking yield is added once per epoch (about 22 hours on mainnet) when the stake pool updates, while borrow interest
        accrues every second. Looping and unwinding are instant through the pool's reserve, but a loop held for less than a
        few epochs usually earns less than the pool's fees ({pool ? `${feeText(pool.solDepositFee)} in, ${feeText(pool.solWithdrawalFee)} out` : "…"}).
      </p>

      <div className="amount">
        <div className="amount-head">
          <label htmlFor="loop-amt">Your XNT</label>
          <button type="button" className="link" disabled={!props.connected} onClick={() => setAmount((Number(props.walletXnt) / 1e9).toFixed(4))}>
            Max {fmtX(props.walletXnt)}
          </button>
        </div>
        <span className="field">
          <input id="loop-amt" inputMode="decimal" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} disabled={!props.connected || !!busy} />
          <span className="muted">XNT</span>
        </span>
      </div>
      <div className="amount">
        <div className="amount-head">
          <label htmlFor="loop-lev">Leverage</label>
          <span className="num">{lev.toFixed(2)}x</span>
        </div>
        <input id="loop-lev" className="slider" type="range" min={1.25} max={maxLev} step={0.25} value={lev} onChange={(e) => setLev(Number(e.target.value))} />
      </div>

      {plan && (
        <table className="grid kv compact">
          <tbody>
            <tr><th scope="row">Position after</th><td className="r num">{fmtX(after.collateral)} {sym} · debt {fmtX(after.debt)} XNT</td></tr>
            <tr><th scope="row">Borrow APR now → after</th><td className="r num">{pctN(aprNow)} → {pctN(aprAfter)}</td></tr>
            {breakEven !== null && <tr><th scope="row">Loses money if borrow APR passes</th><td className="r num">{pctN(breakEven)}</td></tr>}
            <tr><th scope="row">Health after</th><td className="r num">{isFinite(health) ? health.toFixed(2) : "—"}</td></tr>
            {dropToLiq !== null && <tr><th scope="row">Liquidated if the {sym} rate falls</th><td className="r num">{pctN(dropToLiq)}</td></tr>}
            <tr><th scope="row">Steps</th><td className="r num">{plan.steps.length}</td></tr>
          </tbody>
        </table>
      )}
      {plan && !plan.reachedTarget && (
        <p className="warn small">
          The market can lend only {fmtX(marketRoom)} XNT right now, so this reaches {levAfter.toFixed(2)}x instead of {lev.toFixed(2)}x.
        </p>
      )}
      {best && Math.abs(best.lev - lev) > 1e-9 && net !== null && best.net > net + 0.0005 && (
        <p className="small best-lev">
          Best for this amount right now: <b className="num">{best.reached.toFixed(2)}x</b> at about <b className="num">{pctN(best.net)}</b>.{" "}
          <button type="button" className="link" onClick={() => setLev(best.lev)}>Use it</button>
          <span className="muted"> More leverage earns less here because your own borrowing pushes the rate up.</span>
        </p>
      )}
      {worse && (
        <p className="warn small">
          Borrowing costs {pctN(aprAfter)} here, more than the {pctN(breakEven ?? 0)} break-even, so looping earns less than plain staking right now.
        </p>
      )}
      <button
        className="btn wide"
        disabled={!props.connected || !!busy || !plan || tooMuch || worse || plan.steps.length < 2}
        onClick={() => plan && pool && props.runMany(`Loop ${lev.toFixed(2)}x`, async (c) => {
          // the pool refuses deposits until it has run this epoch's update
          await waitForPoolUpdate(c.conn, poolAddr);
          return loopTxs(c, await fetchStakePool(c.conn, poolAddr), plan.steps, props.hasObligation);
        })}
      >
        {busy?.startsWith("Loop") ? "Confirm…" : tooMuch ? "Above wallet balance" : `Loop to ${plan ? levAfter.toFixed(2) : lev.toFixed(2)}x`}
      </button>

      {position.debt > 0n && (
        <div className="unwind">
          <h3>Unwind</h3>
          <p className="muted small">
            Your position: {fmtX(position.collateral)} {sym}, debt {fmtX(position.debt)} XNT ({isFinite(levNow) ? levNow.toFixed(2) : "—"}x). Unwinding
            redeems {sym} at the stake pool step by step to repay the debt, then returns what's left.
          </p>
          <label className="check">
            <input type="checkbox" checked={toXnt} onChange={(e) => setToXnt(e.target.checked)} /> Receive XNT (redeem the rest of the {sym}, {pool ? feeText(pool.solWithdrawalFee) : "…"} pool fee)
          </label>
          {unwind && !unwind.complete && (
            <p className="warn small">The position is too close to its limit to unwind from collateral alone. Repay some XNT in the Borrow tab first.</p>
          )}
          <button
            className="btn ghost wide"
            disabled={!props.connected || !!busy || !unwind || !unwind.complete}
            onClick={() => unwind && pool && props.runMany("Unwind", async (c) => {
              await waitForPoolUpdate(c.conn, poolAddr);
              return unwindTxs(c, await fetchStakePool(c.conn, poolAddr), unwind.steps, position, obligationPda(c.market.address, c.user, c.accumulator.programId), toXnt);
            })}
          >
            {busy === "Unwind" ? "Confirm…" : `Unwind fully${unwind ? ` (${unwind.steps.length} steps)` : ""}`}
          </button>
        </div>
      )}
    </div>
  );
}

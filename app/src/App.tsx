import { useCallback, useEffect, useMemo, useState } from "react";
import { Connection, Transaction } from "@solana/web3.js";
import {
  BPS,
  MAINNET,
  MAINNET_MARKETS,
  TESTNET_MARKETS,
  Market,
  AccumulatorClient,
  Obligation,
  accrued,
  borrowCapacity,
  borrowRateBps,
  collateralValue,
  debtOf,
  healthFactor,
  lenderAssets,
  totalBorrows,
  utilizationBps,
  depositXntForPxnt,
  isStalePoolError,
  waitForPoolUpdate,
} from "../../sdk/src";
import { useX1Wallet } from "./useX1Wallet";
import { RateChart } from "./RateChart";
import { Hero } from "./Hero";
import { LoopPanel } from "./Loop";
import { Docs } from "./Docs";
import * as act from "./actions";

type MarketDef = (typeof MAINNET_MARKETS)[keyof typeof MAINNET_MARKETS];
const DEFS: MarketDef[] = Object.values(MAINNET_MARKETS);

type Net = "mainnet" | "testnet";
const TESTNET_RPC = "https://rpc.testnet.x1.xyz";
const NETWORKS: Record<Net, { label: string; rpc: string; defs: MarketDef[]; txUrl: (sig: string) => string; note?: string }> = {
  mainnet: {
    label: "Mainnet",
    rpc: import.meta.env.VITE_RPC ?? MAINNET.rpc,
    defs: DEFS,
    txUrl: (sig) => `https://explorer.x1.xyz/tx/${sig}`,
  },
  testnet: {
    label: "Testnet",
    rpc: TESTNET_RPC,
    // testnet XDEX and testnet USDC (9 decimals)
    defs: Object.values(TESTNET_MARKETS),
    txUrl: (sig) => `https://explorer.testnet.x1.xyz/tx/${sig}`,
    note: "Testnet: test tokens only. USDC / XNT is priced by the testnet XDEX pool, which is small, so its price can be moved easily.",
  },
};
function initialNet(): Net {
  const q = new URLSearchParams(window.location.search).get("network");
  if (q === "testnet" || q === "mainnet") return q;
  try {
    const v = localStorage.getItem("accumulator-network");
    if (v === "testnet" || v === "mainnet") return v;
  } catch {
    /* storage unavailable */
  }
  return "mainnet";
}

type Tab = "lend" | "borrow" | "loop";

interface Loaded {
  def: MarketDef;
  market: Market | null;
  shareSupply: bigint;
  priceBorrow: bigint | null;
  priceLiq: bigint | null;
  priceError?: string;
}
interface UserState {
  native: bigint;
  lendBal: bigint;
  collBal: bigint;
  shares: bigint;
  obligation: Obligation | null;
}

// ------------------------------------------------------------------ format

function fmt(v: bigint, decimals: number, digits = 2): string {
  const n = Number(v) / 10 ** decimals;
  if (n !== 0 && Math.abs(n) < 10 ** -digits) return `<${(10 ** -digits).toFixed(digits)}`;
  return n.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: Math.min(digits, 2) });
}
/** More decimals for small balances, so accruing interest is visible. */
function fmtLive(v: bigint, decimals: number): string {
  const n = Number(v) / 10 ** decimals;
  return fmt(v, decimals, n < 1_000 ? decimals : n < 100_000 ? 4 : 2);
}
const usd = (n: number) =>
  n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}k` : `$${n.toFixed(2)}`;
const pct = (bps: bigint | number) => `${(Number(bps) / 100).toFixed(2)}%`;
function parseAmount(s: string, decimals: number): bigint | null {
  const t = s.trim();
  if (!/^\d*\.?\d*$/.test(t) || t === "" || t === ".") return null;
  const [w, f = ""] = t.split(".");
  if (f.length > decimals) return null;
  return BigInt(w || "0") * 10n ** BigInt(decimals) + BigInt((f + "0".repeat(decimals)).slice(0, decimals) || "0");
}
function fmtPlain(v: bigint, d: number): string {
  const s = v.toString().padStart(d + 1, "0");
  const w = s.slice(0, s.length - d);
  const f = s.slice(s.length - d).replace(/0+$/, "");
  return f ? `${w}.${f}` : w;
}
const lendDec = (l: Loaded) => l.market?.lendDecimals ?? l.def.lendDecimals;
const collDec = (l: Loaded) => l.market?.collateralDecimals ?? l.def.collateralDecimals;
/** Collateral price in human units (lend tokens per collateral token). */
const humanPrice = (w: bigint, l: Loaded) => (Number(w) / 1e18) * 10 ** (collDec(l) - lendDec(l));

/** Live numbers for a market (accrued to now). */
function stats(l: Loaded) {
  const m = l.market;
  if (!m) return null;
  const s = accrued(m, BigInt(Math.floor(Date.now() / 1000)));
  const borrows = totalBorrows(s);
  const util = utilizationBps(borrows, s.cash);
  const borrowApr = borrowRateBps(s.params, util);
  const supplyApr = (borrowApr * util * (BPS - BigInt(s.params.reserveFactorBps))) / (BPS * BPS);
  return { s, borrows, util, borrowApr, supplyApr, assets: lenderAssets(s) };
}

// --------------------------------------------------------------------- app

export default function App() {
  const wallet = useX1Wallet();
  const [net, setNet] = useState<Net>(initialNet);
  const N = NETWORKS[net];
  const conn = useMemo(() => new Connection(N.rpc, "confirmed"), [N.rpc]);
  const accumulator = useMemo(() => new AccumulatorClient(conn), [conn]);
  const [loaded, setLoaded] = useState<Loaded[]>([]);
  const [user, setUser] = useState<Record<string, UserState>>({});
  const [selected, setSelected] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string; sig?: string } | null>(null);
  const [tab, setTab] = useState<Tab>("lend");
  const [view, setView] = useState<"app" | "docs">(() => (window.location.hash.startsWith("#docs") ? "docs" : "app"));
  useEffect(() => {
    const on = () => setView(window.location.hash.startsWith("#docs") ? "docs" : "app");
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const openView = (v: "app" | "docs") => {
    window.location.hash = v === "docs" ? "docs" : "";
    setView(v);
    window.scrollTo({ top: 0 });
  };
  /** Open a market's Lend or Borrow panel and bring it into view. */
  const go = (i: number, t: Tab) => {
    setSelected(i);
    setTab(t);
    if (view !== "app") openView("app");
    requestAnimationFrame(() => document.getElementById("actions")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };

  function switchNet(n: Net) {
    if (n === net) return;
    setLoaded([]);
    setUser({});
    setSelected(0);
    setNet(n);
    try {
      localStorage.setItem("accumulator-network", n);
    } catch {
      /* storage unavailable */
    }
    const url = new URL(window.location.href);
    url.searchParams.set("network", n);
    window.history.replaceState(null, "", url);
  }
  const [updated, setUpdated] = useState<Date | null>(null);
  // re-render every second so interest visibly accrues between refreshes
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1_000);
    return () => clearInterval(t);
  }, []);

  const refresh = useCallback(async () => {
    const out: Loaded[] = [];
    for (const def of N.defs) {
      const info = await conn.getAccountInfo(def.address).catch(() => null);
      const market = info ? accumulator.decodeMarket(def.address, info.data) : null;
      let shareSupply = 0n;
      let priceBorrow: bigint | null = null;
      let priceLiq: bigint | null = null;
      let priceError: string | undefined;
      if (market) {
        const mint = await conn.getAccountInfo(market.shareMint);
        if (mint) shareSupply = Buffer.from(mint.data).readBigUInt64LE(36);
      }
      // Before launch the price can still be read from the accounts the market will use.
      const priced = market ?? ({ ...def } as unknown as Market);
      try {
        priceBorrow = await accumulator.readPrice(priced, "borrow");
        priceLiq = await accumulator.readPrice(priced, "liquidate");
      } catch (e) {
        priceError = (e as Error).message;
      }
      out.push({ def, market, shareSupply, priceBorrow, priceLiq, priceError });
    }
    setLoaded(out);
    setUpdated(new Date());

    if (!wallet.publicKey) return setUser({});
    const pk = wallet.publicKey;
    const next: Record<string, UserState> = {};
    const native = BigInt(await conn.getBalance(pk));
    for (const l of out) {
      if (!l.market) continue;
      const a = act.lendAccounts({ conn, accumulator, user: pk, market: l.market });
      const [t, s, k] = await conn.getMultipleAccountsInfo([a.token, a.shares, a.collateral]);
      const bal = (i: typeof t) => (i ? Buffer.from(i.data).readBigUInt64LE(64) : 0n);
      next[l.def.address.toBase58()] = {
        native,
        lendBal: bal(t),
        collBal: bal(k),
        shares: bal(s),
        obligation: await accumulator.fetchObligation(a.obligation),
      };
    }
    setUser(next);
  }, [conn, accumulator, wallet.publicKey, N.defs]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 15_000);
    return () => clearInterval(t);
  }, [refresh]);

  async function send(label: string, build: () => Promise<Transaction>) {
    if (!wallet.publicKey) return;
    setBusy(label);
    setToast(null);
    try {
      const tx = await build();
      tx.feePayer = wallet.publicKey;
      const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      const signed = await wallet.signTransaction(tx);
      const sig = await conn.sendRawTransaction(signed.serialize());
      await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
      setToast({ kind: "ok", text: `${label} confirmed`, sig });
      await refresh();
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      const code = isStalePoolError(e)
        ? "the stake pool is updating for the new epoch, try again in a minute"
        : /Error Message: ([^."]+)/.exec(msg)?.[1] ?? msg.split("\n")[0];
      setToast({ kind: "err", text: `${label} failed: ${code}` });
    } finally {
      setBusy(null);
    }
  }

  /** Several transactions, one wallet approval, sent in order. Stops at the first failure. */
  async function sendMany(label: string, build: () => Promise<Transaction[]>) {
    if (!wallet.publicKey) return;
    setBusy(label);
    setToast(null);
    let done = 0;
    let total = 0;
    try {
      const txs = await build();
      total = txs.length;
      const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
      for (const tx of txs) {
        tx.feePayer = wallet.publicKey;
        tx.recentBlockhash = blockhash;
      }
      const signed = txs.length === 1 ? [await wallet.signTransaction(txs[0])] : await wallet.signAllTransactions(txs);
      let last = "";
      for (const tx of signed) {
        last = await conn.sendRawTransaction(tx.serialize());
        const r = await conn.confirmTransaction({ signature: last, blockhash, lastValidBlockHeight }, "confirmed");
        if (r.value.err) throw new Error(`transaction ${done + 1} of ${total} failed`);
        done++;
        if (done < total) setToast({ kind: "ok", text: `${label}: ${done} of ${total} confirmed…`, sig: last });
      }
      setToast({ kind: "ok", text: `${label} confirmed (${total} transaction${total > 1 ? "s" : ""})`, sig: last });
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      const why = isStalePoolError(e) ? "the stake pool is updating for the new epoch" : /Error Message: ([^."]+)/.exec(msg)?.[1] ?? msg.split("\n")[0];
      setToast({
        kind: "err",
        text: done > 0 ? `${label} stopped after ${done} of ${total} (${why}). Your position is safe; run it again to continue.` : `${label} failed: ${why}`,
      });
    } finally {
      setBusy(null);
      await refresh();
    }
  }

  // XNT in USD, from the XDEX-priced market (USDC.x per XNT)
  const usdMarket = loaded.find((l) => l.def.oracleKind === "xdexTwap");
  const xntUsd = usdMarket?.priceLiq ? humanPrice(usdMarket.priceLiq, usdMarket) : null;
  const pxntMarket = loaded.find((l) => l.def.oracleKind === "stakePool");
  const pxntRate = pxntMarket?.priceLiq ? humanPrice(pxntMarket.priceLiq, pxntMarket) : null;
  const toUsd = (l: Loaded, v: bigint) =>
    l.def.lendIsUsd ? Number(v) / 10 ** lendDec(l) : xntUsd !== null ? (Number(v) / 1e9) * xntUsd : 0;
  const totals = loaded.reduce(
    (t, l) => {
      const st = stats(l);
      return st ? { supplied: t.supplied + toUsd(l, st.assets), borrowed: t.borrowed + toUsd(l, st.borrows) } : t;
    },
    { supplied: 0, borrowed: 0 },
  );
  const live = loaded.filter((l) => l.market).length;
  // No XDEX (testnet): total in XNT instead of USD
  const xntTotals = loaded.reduce(
    (t, l) => {
      const st = stats(l);
      return st && l.def.lendSymbol === "XNT" ? { s: t.s + Number(st.assets) / 1e9, b: t.b + Number(st.borrows) / 1e9 } : t;
    },
    { s: 0, b: 0 },
  );
  const fmtTotal = (usdV: number, xntV: number) =>
    !live ? "—" : xntUsd !== null ? usd(usdV) : `${xntV.toLocaleString("en-US", { maximumFractionDigits: 2 })} XNT`;
  const [timelock, setTimelock] = useState<number | null>(null);
  useEffect(() => {
    // the delay on risk changes, read from the program's config
    import("../../sdk/src").then(({ configPda }) =>
      conn.getAccountInfo(configPda(accumulator.programId)).then((i) => setTimelock(i ? Number(i.data.readBigInt64LE(72)) : null)).catch(() => setTimelock(null)),
    );
  }, [conn, accumulator]);
  // admin handoff: the proposed admin accepts from its own wallet (e.g. a Ledger through Backpack)
  const [pendingAdmin, setPendingAdmin] = useState<string | null>(null);
  useEffect(() => {
    accumulator.fetchConfig().then((c) => setPendingAdmin(c.pendingAdmin.toBase58())).catch(() => setPendingAdmin(null));
  }, [accumulator, updated]);
  const canAccept = !!wallet.publicKey && pendingAdmin === wallet.publicKey.toBase58();
  const timelockText = timelock === null ? "2 days" : timelock >= 86_400 ? `${timelock / 86_400} days` : `${Math.round(timelock / 60)} minutes`;
  const cur = loaded[selected];
  // the best yield on offer right now, for the hero
  const best = loaded
    .map((l, i) => ({ l, i, apy: stats(l) ? Number(stats(l)!.supplyApr) / 100 : -1 }))
    .filter((b) => b.l.market && !b.l.def.name.startsWith("Old"))
    .sort((a, b) => b.apy - a.apy)[0];

  // What the hero's gravitational field shows: one ring per live market.
  const fieldIdx = loaded.map((l, i) => ({ l, i, st: stats(l) })).filter((x) => x.st && !x.l.def.name.startsWith("Old"));
  const valueOf = (l: Loaded, v: bigint) => (xntUsd !== null ? toUsd(l, v) : Number(v) / 10 ** lendDec(l));
  const field = fieldIdx.map(({ l, st }) => ({
    name: l.def.name,
    weight: Math.sqrt(Math.max(valueOf(l, st!.assets), 0)),
    util: Number(st!.util) / 10_000,
    apy: Number(st!.supplyApr) / 10_000,
  }));
  const fieldFocus = fieldIdx.findIndex((x) => x.i === selected);
  // interest flowing to lenders right now, per second (USD, or XNT when there is no XNT price)
  const YEAR = 31_536_000;
  const interestPerSecond = fieldIdx.reduce((t, { l, st }) => {
    if (xntUsd === null && l.def.lendSymbol !== "XNT") return t;
    return t + (valueOf(l, st!.assets) * Number(st!.supplyApr)) / 10_000 / YEAR;
  }, 0);

  return (
    <div className="shell">
      <header className="top">
        <div className="brand">
          <a className="logo" href="/" aria-label="Accumulator home">
            <img className="wordmark" src="/accumulator.png" alt="Accumulator" />
          </a>
          <div className="seg" role="group" aria-label="Network">
            {(Object.keys(NETWORKS) as Net[]).map((n) => (
              <button key={n} className={n === net ? "on" : ""} aria-pressed={n === net} onClick={() => switchNet(n)}>
                {NETWORKS[n].label}
              </button>
            ))}
          </div>
        </div>
        <nav className="views" aria-label="Pages">
          <button className={view === "app" ? "on" : ""} onClick={() => openView("app")}>App</button>
          <button className={view === "docs" ? "on" : ""} onClick={() => openView("docs")}>Docs</button>
        </nav>
        <nav className="top-right">
          <span className="muted small">{updated ? `Updated ${updated.toLocaleTimeString()}` : "Loading…"}</span>
          {wallet.connected ? (
            <button className="btn ghost" onClick={wallet.disconnect} title="Disconnect">
              {wallet.publicKey!.toBase58().slice(0, 4)}…{wallet.publicKey!.toBase58().slice(-4)}
            </button>
          ) : (
            <button className="btn" onClick={() => wallet.connect().catch((e) => setToast({ kind: "err", text: e.message }))}>
              {wallet.connecting ? "Connecting…" : "Connect wallet"}
            </button>
          )}
        </nav>
      </header>

      {view === "docs" ? (
        <main>
          <Docs onOpenApp={() => openView("app")} />
        </main>
      ) : (
      <main>
        <Hero
          bestApy={best ? best.apy : null}
          bestMarket={best ? best.l.def.name : null}
          lendSymbol={best ? best.l.def.lendSymbol : null}
          onEarn={() => go(best ? best.i : 0, "lend")}
          onBorrow={() => go(selected, "borrow")}
          onDocs={() => openView("docs")}
          field={field}
          focus={fieldFocus}
          interestPerSecond={interestPerSecond}
          interestUnit={xntUsd !== null ? "$" : "XNT"}
          testnet={net === "testnet"}
        />
        <section className="tiles" aria-label="Protocol summary">
          <Tile label="Total supplied" value={fmtTotal(totals.supplied, xntTotals.s)} sub={`${live} of ${N.defs.length} markets live`} />
          <Tile label="Total borrowed" value={fmtTotal(totals.borrowed, xntTotals.b)} sub="across all markets" />
          <Tile label="XNT price" value={xntUsd !== null ? `$${xntUsd.toFixed(4)}` : "—"} sub={usdMarket ? "XDEX 20-minute average" : "no XDEX on this network"} />
          <Tile label="pXNT rate" value={pxntRate !== null ? `${pxntRate.toFixed(6)} XNT` : "—"} sub="X1 stake pool exchange rate" />
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>Markets</h2>
            <span className="muted small">Rates move with utilization; balances grow every second as interest accrues</span>
          </div>
          <div className="table-wrap">
            <table className="grid">
              <thead>
                <tr>
                  <th>Market</th>
                  <th>Actions</th>
                  <th className="r earn-th" title="Set by utilization: it rises when more is borrowed and falls when more is lent. Interest itself accrues every second.">Earn APY</th>
                  <th className="r">Borrow APR</th>
                  <th className="r">Supplied</th>
                  <th className="r">Borrowed</th>
                  <th>Utilization</th>
                  <th className="r">Collateral price</th>
                  <th className="r">Max LTV / liq.</th>
                  <th className="r">Pricing</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {loaded.length === 0 && (
                  <tr>
                    <td colSpan={11} className="muted">
                      Loading markets…
                    </td>
                  </tr>
                )}
                {loaded.map((l, i) => {
                  const st = stats(l);
                  const d = lendDec(l);
                  return (
                    <tr
                      key={l.def.name}
                      className={i === selected ? "sel" : ""}
                      onClick={() => setSelected(i)}
                      tabIndex={0}
                      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && setSelected(i)}
                      aria-selected={i === selected}
                    >
                      <td>
                        <div className="mkt">
                          <strong>{l.def.name}</strong>
                          <span className="muted small">
                            lend {l.def.lendSymbol} · collateral {l.def.collateralSymbol}
                          </span>
                        </div>
                      </td>
                      <td>
                        <div className="row-actions">
                          <button className="act lend" onClick={(e) => { e.stopPropagation(); go(i, "lend"); }}>Lend</button>
                          <button className="act borrow" onClick={(e) => { e.stopPropagation(); go(i, "borrow"); }}>Borrow</button>
                          {l.def.oracleKind === "stakePool" && (
                            <button className="act loop" title="Leveraged staking" onClick={(e) => { e.stopPropagation(); go(i, "loop"); }}>Loop</button>
                          )}
                        </div>
                      </td>
                      <td className={`r num ${st ? "pos" : "muted"}`}>{st ? pct(st.supplyApr) : "—"}</td>
                      <td className="r num">{st ? pct(st.borrowApr) : "—"}</td>
                      <td className="r num ticking">{st ? `${fmtLive(st.assets, d)} ${l.def.lendSymbol}` : "—"}</td>
                      <td className="r num ticking">{st ? `${fmtLive(st.borrows, d)} ${l.def.lendSymbol}` : "—"}</td>
                      <td>
                        <UtilBar bps={st ? Number(st.util) : null} max={(l.market?.params ?? l.def.params).maxUtilizationBps} />
                      </td>
                      <td className="r num">
                        {l.priceLiq
                          ? `${humanPrice(l.priceLiq, l).toFixed(4)} ${l.def.lendSymbol}`
                          : l.priceError
                            ? <span className="warn">unavailable</span>
                            : "—"}
                      </td>
                      <td className="r num">
                        {pct((l.market?.params ?? l.def.params).maxLtvBps)} / {pct((l.market?.params ?? l.def.params).liquidationThresholdBps)}
                      </td>
                      <td className="r small muted">{l.def.oracleKind === "stakePool" ? "Stake pool rate" : "XDEX TWAP"}</td>
                      <td>
                        <span className={`pill ${l.market ? (l.market.borrowPaused ? "warn" : "live") : "soon"}`}>
                          {l.market ? (l.market.borrowPaused ? "Borrows paused" : "Live") : "Not live yet"}
                        </span>
                      </td>

                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        {cur && (
          <section className="detail">
            <MarketDetail l={cur} />
            <ActionPanel
              key={cur.def.name}
              tab={tab}
              setTab={setTab}
              l={cur}
              u={user[cur.def.address.toBase58()]}
              connected={wallet.connected}
              busy={busy}
              run={(label, f) => send(label, () => f({ conn, accumulator, user: wallet.publicKey!, market: cur.market! }))}
              conn={conn}
              runMany={(label, f) => sendMany(label, () => f({ conn, accumulator, user: wallet.publicKey!, market: cur.market! }))}
            />
          </section>
        )}

        {wallet.connected && <Positions loaded={loaded} user={user} onSelect={setSelected} />}
      </main>
      )}

      {toast && (
        <div className={`toast ${toast.kind}`} role="status">
          <span>{toast.text}</span>
          {toast.sig && (
            <a href={N.txUrl(toast.sig)} target="_blank" rel="noreferrer">
              View transaction
            </a>
          )}
          <button aria-label="Dismiss" onClick={() => setToast(null)}>
            ×
          </button>
        </div>
      )}

      {canAccept && (
        <div className="accept-admin">
          <span>This wallet has been proposed as the Accumulator admin.</span>
          <button className="btn" disabled={!!busy} onClick={() => send("Accept admin role", async () => new Transaction().add(await accumulator.acceptAdmin(wallet.publicKey!)))}>
            Accept admin role
          </button>
        </div>
      )}
      <footer className="foot">
        <span className="foot-brand">
          <img className="foot-mark" src="/accumulator-icon.png" alt="" />
          <span>
          Program <span className="addr">{accumulator.programId.toBase58()}</span>
          </span>
        </span>
        <span>Prices come only from on-chain data. Risk changes wait {timelockText}. The admin cannot move lender funds.</span>
      </footer>
    </div>
  );
}

// ------------------------------------------------------------------ pieces

function Tile({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="tile">
      <span className="tile-label">{label}</span>
      <span className="tile-value num">{value}</span>
      <span className="muted small">{sub}</span>
    </div>
  );
}

function UtilBar({ bps, max }: { bps: number | null; max: number }) {
  if (bps === null) return <span className="muted">—</span>;
  const w = Math.min(100, bps / 100);
  return (
    <div className="util" title={`Borrows may not exceed ${max / 100}% utilization`}>
      <div className="util-track">
        <div className="util-fill" style={{ width: `${w}%` }} />
        <div className="util-cap" style={{ left: `${max / 100}%` }} />
      </div>
      <span className="num small">{(bps / 100).toFixed(1)}%</span>
    </div>
  );
}

function MarketDetail({ l }: { l: Loaded }) {
  const p = l.market?.params ?? l.def.params;
  const st = stats(l);
  const d = lendDec(l);
  const rows: [string, string][] = [
    ["Max LTV (borrow limit)", pct(p.maxLtvBps)],
    ["Liquidation threshold", pct(p.liquidationThresholdBps)],
    ["Liquidation bonus", pct(p.liquidationBonusBps)],
    ["Max repaid per liquidation", pct(p.closeFactorBps)],
    ["Reserve factor (protocol share of interest)", pct(p.reserveFactorBps)],
    ["Utilization cap for new borrows", pct(p.maxUtilizationBps)],
    ["Deposit cap", `${fmt(p.depositCap, d, 0)} ${l.def.lendSymbol}`],
    ["Borrow cap", `${fmt(p.borrowCap, d, 0)} ${l.def.lendSymbol}`],
    ["Borrow cap per account", `${fmt(p.maxBorrowPerObligation, d, 0)} ${l.def.lendSymbol}`],
    [
      "Price source",
      l.def.oracleKind === "stakePool"
        ? "X1 stake pool rate (no market price)"
        : `XDEX TWAP, ${p.twapWindowSecs / 60} min; lower of TWAP and spot for borrows`,
    ],
  ];
  return (
    <div className="panel">
      <div className="panel-head">
        <h2>{l.def.name}</h2>
        <span className="muted small">Market {l.def.address.toBase58().slice(0, 8)}…</span>
      </div>
      <div className="chart-block">
        <RateChart params={p} currentBps={st ? Number(st.util) : null} />
      </div>
      <table className="grid kv">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <th scope="row">{k}</th>
              <td className="r num">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Positions({ loaded, user, onSelect }: { loaded: Loaded[]; user: Record<string, UserState>; onSelect: (i: number) => void }) {
  const rows = loaded
    .map((l, i) => {
      const u = user[l.def.address.toBase58()];
      const st = stats(l);
      if (!u || !st || !l.market) return null;
      const deposited = l.shareSupply > 0n ? (u.shares * (st.assets + 1n)) / (l.shareSupply + 1n) : 0n;
      const ob = u.obligation;
      const debt = ob ? debtOf(st.s, ob.borrowScaled) : 0n;
      const coll = ob?.collateral ?? 0n;
      const health = l.priceLiq ? healthFactor(debt, collateralValue(coll, l.priceLiq), l.market.params.liquidationThresholdBps) : Infinity;
      if (deposited === 0n && coll === 0n && debt === 0n) return null;
      return { l, i, deposited, coll, debt, health };
    })
    .filter(Boolean) as { l: Loaded; i: number; deposited: bigint; coll: bigint; debt: bigint; health: number }[];
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Your positions</h2>
      </div>
      <div className="table-wrap">
        <table className="grid">
          <thead>
            <tr>
              <th>Market</th>
              <th className="r">Deposited</th>
              <th className="r">Collateral</th>
              <th className="r">Debt</th>
              <th className="r">Health</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
                  No positions yet.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.l.def.name} onClick={() => onSelect(r.i)} tabIndex={0}>
                <td>
                  <strong>{r.l.def.name}</strong>
                </td>
                <td className="r num">
                  {fmt(r.deposited, lendDec(r.l), 4)} {r.l.def.lendSymbol}
                </td>
                <td className="r num">
                  {fmt(r.coll, collDec(r.l), 4)} {r.l.def.collateralSymbol}
                </td>
                <td className="r num">
                  {fmt(r.debt, lendDec(r.l), 4)} {r.l.def.lendSymbol}
                </td>
                <td className="r num">
                  <Health h={r.debt === 0n ? Infinity : r.health} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Health({ h }: { h: number }) {
  if (!isFinite(h)) return <span className="muted">—</span>;
  const kind = h < 1.1 ? "bad" : h < 1.3 ? "warn" : "good";
  const word = h < 1 ? "Liquidatable" : h < 1.1 ? "At risk" : h < 1.3 ? "Watch" : "Safe";
  return (
    <span className={`health ${kind}`}>
      <span aria-hidden>{kind === "good" ? "●" : "▲"}</span> {h > 100 ? ">100" : h.toFixed(2)} · {word}
    </span>
  );
}

// ------------------------------------------------------------ action panel

function ActionPanel({
  tab,
  setTab,
  l,
  u,
  connected,
  busy,
  run,
  runMany,
  conn,
}: {
  tab: Tab;
  setTab: (t: Tab) => void;
  l: Loaded;
  u?: UserState;
  connected: boolean;
  busy: string | null;
  run: (label: string, f: (c: act.Ctx) => Promise<Transaction>) => void;
  runMany: (label: string, f: (c: act.Ctx) => Promise<Transaction[]>) => void;
  conn: Connection;
}) {
  const m = l.market;
  const ls = l.def.lendSymbol;
  const cs = l.def.collateralSymbol;
  const canLoop = l.def.oracleKind === "stakePool";

  const tabs = (
    <div className="tabs big-tabs" role="tablist">
      <button role="tab" aria-selected={tab === "lend"} className={`lend ${tab === "lend" ? "on" : ""}`} onClick={() => setTab("lend")}>
        <span className="tab-kicker">EARN</span>
        Lend {ls}
      </button>
      <button role="tab" aria-selected={tab === "borrow"} className={`borrow ${tab === "borrow" ? "on" : ""}`} onClick={() => setTab("borrow")}>
        <span className="tab-kicker">GET LIQUIDITY</span>
        Borrow {ls}
      </button>
      {canLoop && (
        <button role="tab" aria-selected={tab === "loop"} className={`borrow ${tab === "loop" ? "on" : ""}`} onClick={() => setTab("loop")}>
          <span className="tab-kicker">MULTIPLY</span>
          Loop {cs}
        </button>
      )}
    </div>
  );

  if (!m) {
    return (
      <div className="panel actions" id="actions">
        {tabs}
        <div className="pad">
          <h3>Not live yet</h3>
          <p className="muted">
            This market opens once the admin creates it, with the settings on the left. Its price source is already
            readable on-chain, so the collateral price shown above is live.
          </p>
          <p className="small muted">
            Market address <span className="addr">{l.def.address.toBase58()}</span>
          </p>
        </div>
      </div>
    );
  }

  const st = stats(l)!;
  const ld = m.lendDecimals;
  const cd = m.collateralDecimals;
  const feeReserve = 10_000_000n; // keep 0.01 XNT for fees
  const spendable = (bal: bigint, native: boolean) =>
    u ? (native ? (u.native > feeReserve ? u.native - feeReserve : 0n) + bal : bal) : 0n;
  const walletLend = spendable(u?.lendBal ?? 0n, ls === "XNT");
  const walletColl = spendable(u?.collBal ?? 0n, cs === "XNT");
  const myAssets = u && l.shareSupply > 0n ? (u.shares * (st.assets + 1n)) / (l.shareSupply + 1n) : 0n;

  const ob = u?.obligation ?? null;
  const debt = ob ? debtOf(st.s, ob.borrowScaled) : 0n;
  const coll = ob?.collateral ?? 0n;
  const health = l.priceLiq ? healthFactor(debt, collateralValue(coll, l.priceLiq), m.params.liquidationThresholdBps) : Infinity;
  const capacity = l.priceBorrow ? borrowCapacity(coll, l.priceBorrow, debt, m.params.maxLtvBps) : 0n;
  const total = st.s.cash + st.borrows;
  const utilRoom = (() => {
    const maxB = (total * BigInt(m.params.maxUtilizationBps)) / BPS;
    return maxB > st.borrows ? maxB - st.borrows : 0n;
  })();
  const room = (a: bigint, b: bigint) => (a > b ? a - b : 0n);
  const limits: [bigint, string][] = [
    [capacity, `your collateral (${pct(m.params.maxLtvBps)} max LTV)`],
    [st.s.cash, "the market's idle cash"],
    [utilRoom, `the market's ${pct(m.params.maxUtilizationBps)} utilization cap`],
    [room(m.params.borrowCap, st.borrows), "the market's total borrow cap"],
    [room(m.params.maxBorrowPerObligation, debt), "the per-account borrow cap"],
  ];
  const [maxBorrow, limitedBy] = limits.reduce((a, b) => (b[0] < a[0] ? b : a));
  const marketLimited = limitedBy.startsWith("the market's idle") || limitedBy.includes("utilization");
  const maxWithdrawColl =
    debt === 0n
      ? coll
      : l.priceBorrow
        ? room(coll, (debt * BPS * 10n ** 18n) / (BigInt(m.params.maxLtvBps) * l.priceBorrow) + 1n)
        : 0n;
  const liqPrice =
    debt > 0n && coll > 0n ? (Number(debt) / Number(coll)) * 10 ** (cd - ld) * (10_000 / m.params.liquidationThresholdBps) : null;

  if (tab === "loop" && canLoop) {
    return (
      <div className="panel actions" id="actions">
        {tabs}
        <LoopPanel
          conn={conn}
          market={m}
          symbol={cs}
          priceWad={l.priceBorrow}
          cash={st.s.cash}
          borrows={st.borrows}
          position={{ collateral: coll, debt }}
          hasObligation={!!ob}
          walletXnt={u ? (u.native > feeReserve * 5n ? u.native - feeReserve * 5n : 0n) : 0n}
          connected={connected}
          busy={busy}
          runMany={runMany}
        />
        {!connected && <p className="muted small pad-x">Connect a wallet to loop.</p>}
      </div>
    );
  }

  return (
    <div className="panel actions" id="actions">
      {tabs}
      {tab === "lend" ? (
        <div className="pad">
          <div className="earn-inline">
            <span>You earn</span>
            <b className="num">{pct(st.supplyApr)}</b>
            <span>APY on {ls}, paid by borrowers</span>
          </div>
          <table className="grid kv compact">
            <tbody>
              <tr>
                <th scope="row">Your deposit</th>
                <td className="r num">
                  {fmt(myAssets, ld, 4)} {ls}
                </td>
              </tr>
              <tr>
                <th scope="row">Supply APY</th>
                <td className="r num pos">{pct(st.supplyApr)}</td>
              </tr>
              <tr>
                <th scope="row">Idle cash (withdrawable now)</th>
                <td className="r num">
                  {fmt(st.s.cash, ld)} {ls}
                </td>
              </tr>
            </tbody>
          </table>
          <AmountForm label="Deposit" symbol={ls} decimals={ld} max={walletLend} disabled={!connected || !!busy} busy={busy === "Deposit"}
            onSubmit={(a) => run("Deposit", (c) => act.deposit(c, a))} />
          <AmountForm label="Withdraw" symbol={ls} decimals={ld} max={myAssets < st.s.cash ? myAssets : st.s.cash}
            disabled={!connected || !!busy || !u?.shares} busy={busy === "Withdraw"}
            onSubmit={(a) => {
              // amount -> shares, rounded up so the user gets at least `a`, capped at what they hold
              const sh = (a * (l.shareSupply + 1n) + st.assets) / (st.assets + 1n);
              run("Withdraw", (c) => act.withdraw(c, a >= myAssets || sh > u!.shares ? u!.shares : sh));
            }} />
        </div>
      ) : (
        <div className="pad">
          <table className="grid kv compact">
            <tbody>
              <tr>
                <th scope="row">Collateral</th>
                <td className="r num">
                  {fmt(coll, cd, 4)} {cs}
                </td>
              </tr>
              <tr>
                <th scope="row">Debt</th>
                <td className="r num">
                  {fmt(debt, ld, 4)} {ls}
                </td>
              </tr>
              <tr>
                <th scope="row">Health</th>
                <td className="r num">
                  <Health h={debt === 0n ? Infinity : health} />
                </td>
              </tr>
              <tr>
                <th scope="row">Can borrow</th>
                <td className="r num">
                  {fmt(maxBorrow, ld, 4)} {ls}
                  {coll > 0n && <span className="muted small limit-why">limited by {limitedBy}</span>}
                </td>
              </tr>
              <tr>
                <th scope="row">Borrow APR</th>
                <td className="r num">{pct(st.borrowApr)}</td>
              </tr>
              {liqPrice !== null && (
                <tr>
                  <th scope="row">Liquidated if 1 {cs} falls to</th>
                  <td className="r num">
                    {liqPrice.toFixed(4)} {ls}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          {coll > 0n && marketLimited && maxBorrow < capacity / 10n && (
            <p className="warn small">
              This market is {pct(st.util)} lent out, so there is little {ls} left to borrow. It frees up as lenders deposit or
              borrowers repay. Your collateral alone would allow {fmt(capacity, ld, 4)} {ls}.
            </p>
          )}
          {canLoop && (
            <AmountForm label={`Stake XNT for ${cs}`} symbol="XNT" decimals={9} max={spendable(0n, true)} disabled={!connected || !!busy}
              busy={busy === `Stake XNT for ${cs}`}
              hint={l.priceLiq ? `1 ${cs} = ${humanPrice(l.priceLiq, l).toFixed(4)} XNT, via its stake pool` : undefined}
              onSubmit={(a) =>
                run(`Stake XNT for ${cs}`, async (c) => {
                  // don't ask for a signature the pool would reject mid-update
                  const pool = c.market.oracleAccounts[0];
                  await waitForPoolUpdate(c.conn, pool);
                  return new Transaction().add(...(await depositXntForPxnt(c.conn, c.user, a, pool)).ixs);
                })
              } />
          )}
          <AmountForm label="Add collateral" symbol={cs} decimals={cd} max={walletColl} disabled={!connected || !!busy} busy={busy === "Add collateral"}
            onSubmit={(a) => run("Add collateral", (c) => act.depositCollateral(c, a, !!ob))} />
          <AmountForm label="Borrow" symbol={ls} decimals={ld} max={maxBorrow} disabled={!connected || !!busy || coll === 0n || m.borrowPaused}
            busy={busy === "Borrow"} onSubmit={(a) => run("Borrow", async (c) => {
              // pXNT is priced by the stake pool, which must have run this epoch's update first
              if (l.def.oracleKind === "stakePool") await waitForPoolUpdate(c.conn, c.market.oracleAccounts[0]);
              return act.borrow(c, a);
            })} />
          <AmountForm label="Repay" symbol={ls} decimals={ld} max={debt} disabled={!connected || !!busy || debt === 0n} busy={busy === "Repay"}
            onSubmit={(a) => run("Repay", (c) => act.repay(c, a >= debt - debt / 1000n ? null : a, debt))} />
          <AmountForm label="Withdraw collateral" symbol={cs} decimals={cd} max={maxWithdrawColl} disabled={!connected || !!busy || coll === 0n}
            busy={busy === "Withdraw collateral"} onSubmit={(a) => run("Withdraw collateral", async (c) => {
              if (l.def.oracleKind === "stakePool" && debt > 0n) await waitForPoolUpdate(c.conn, c.market.oracleAccounts[0]);
              return act.withdrawCollateral(c, a);
            })} />
          {ob && coll === 0n && debt === 0n && (
            <button className="btn ghost wide" disabled={!!busy} onClick={() => run("Close position", (c) => act.closePosition(c))}>
              Close empty position (refunds rent)
            </button>
          )}
          <p className="muted small">
            Below health 1.00, anyone may repay part of your debt and take {pct(m.params.liquidationBonusBps)} extra collateral, only
            enough to bring you back to safety.
          </p>
        </div>
      )}
      {!connected && <p className="muted small pad-x">Connect a wallet to deposit or borrow.</p>}
    </div>
  );
}

function AmountForm(props: {
  label: string;
  symbol: string;
  decimals: number;
  max: bigint;
  disabled: boolean;
  busy: boolean;
  hint?: string;
  onSubmit: (amount: bigint) => void;
}) {
  const [v, setV] = useState("");
  const amount = parseAmount(v, props.decimals);
  const tooMuch = amount !== null && amount > props.max;
  const id = `amt-${props.label.replace(/\s+/g, "-").toLowerCase()}`;
  return (
    <form
      className="amount"
      onSubmit={(e) => {
        e.preventDefault();
        if (amount && !tooMuch) props.onSubmit(amount);
      }}
    >
      <div className="amount-head">
        <label htmlFor={id}>{props.label}</label>
        <button type="button" className="link" onClick={() => setV(fmtPlain(props.max, props.decimals))} disabled={props.disabled}>
          Max {fmt(props.max, props.decimals, 4)}
        </button>
      </div>
      <div className="amount-row">
        <span className="field">
          <input id={id} inputMode="decimal" placeholder="0.00" value={v} onChange={(e) => setV(e.target.value)} disabled={props.disabled} />
          <span className="muted">{props.symbol}</span>
        </span>
        <button className="btn" disabled={props.disabled || !amount || tooMuch}>
          {props.busy ? "Confirm…" : tooMuch ? "Above max" : props.label}
        </button>
      </div>
      {props.hint && <span className="muted small">{props.hint}</span>}
    </form>
  );
}

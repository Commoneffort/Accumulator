import { useEffect, useState } from "react";

const LINES = ["Your XNT is sleeping.", "Lend it. Earn yield.", "Borrow without selling.", "No oracles. No middlemen.", "Interest, paid every second."];

/** Types each line, holds, deletes, moves on. Shows the first line still if motion is reduced. */
function Typer({ lines }: { lines: string[] }) {
  const reduced = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const [i, setI] = useState(0);
  const [n, setN] = useState(reduced ? lines[0].length : 0);
  const [del, setDel] = useState(false);
  useEffect(() => {
    if (reduced) return;
    const full = lines[i];
    const t = setTimeout(
      () => {
        if (!del && n < full.length) setN(n + 1);
        else if (!del) setDel(true);
        else if (n > 0) setN(n - 1);
        else {
          setDel(false);
          setI((i + 1) % lines.length);
        }
      },
      !del && n === full.length ? 1800 : del ? 28 : 55,
    );
    return () => clearTimeout(t);
  }, [n, del, i, lines, reduced]);
  return (
    <span className="typer" aria-label={lines.join(" ")}>
      <span aria-hidden>{lines[i].slice(0, n)}</span>
      <span className="caret" aria-hidden />
    </span>
  );
}

export function Hero({
  bestApy,
  bestMarket,
  lendSymbol,
  onEarn,
  onBorrow,
  onDocs,
  testnet,
}: {
  bestApy: number | null;
  bestMarket: string | null;
  lendSymbol: string | null;
  onEarn: () => void;
  onBorrow: () => void;
  onDocs: () => void;
  testnet: boolean;
}) {
  return (
    <section className="hero" aria-label="Earn with Accumulator">
      <div className="hero-copy">
        <h1>
          <Typer lines={LINES} />
        </h1>
        <p className="hero-sub">
          Deposit XNT or USDC into Accumulator and earn the interest borrowers pay. Withdraw any time liquidity allows. Prices come
          only from on-chain data, and the admin can't touch your deposit.
        </p>
        <div className="hero-ctas">
          <button className="cta" onClick={onEarn}>
            Start earning <span aria-hidden>→</span>
          </button>
          <button className="cta ghost" onClick={onBorrow}>
            Borrow
          </button>
          <button className="link big" onClick={onDocs}>
            How it works
          </button>
        </div>
      </div>
      <div className="earn-card" role="group" aria-label="Best current yield">
        <span className="earn-word">EARN</span>
        <span className="earn-apy num">{bestApy !== null && bestApy > 0 ? `${bestApy.toFixed(2)}%` : "—"}</span>
        <span className="earn-label">
          {bestApy !== null && bestApy > 0 ? (
            <>
              APY on {lendSymbol} in {bestMarket}
            </>
          ) : (
            "APY appears once borrowers are paying interest"
          )}
        </span>
        <span className="earn-foot">Paid by borrowers · accrues every second · {testnet ? "testnet tokens" : "variable rate"}</span>
      </div>
    </section>
  );
}

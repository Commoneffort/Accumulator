import { Suspense, lazy, useEffect, useRef, useState } from "react";
import type { FieldMarket } from "./GravitationalField";

// three.js is large; load it after the page so the markets show up first
const GravitationalField = lazy(() => import("./GravitationalField"));

const LINES = ["Your XNT is sleeping.", "Lend it. Earn yield.", "Borrow without selling.", "No oracles. No middlemen.", "Interest, paid every second."];
const reducedMotion = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** Types each line, holds, deletes, moves on. Shows the first line still if motion is reduced. */
function Typer({ lines }: { lines: string[] }) {
  const reduced = reducedMotion();
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

/** Interest paid to lenders since the page opened, counting up live. */
function InterestTicker({ perSecond, unit }: { perSecond: number; unit: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const rate = useRef(perSecond);
  rate.current = perSecond;
  useEffect(() => {
    let total = 0;
    let last = performance.now();
    let frame = 0;
    const draw = () => {
      if (ref.current) ref.current.textContent = unit === "$" ? `$${total.toFixed(6)}` : `${total.toFixed(6)} ${unit}`;
    };
    if (reducedMotion()) {
      const t = setInterval(() => {
        total += rate.current;
        draw();
      }, 1000);
      return () => clearInterval(t);
    }
    const tick = (now: number) => {
      total += rate.current * ((now - last) / 1000);
      last = now;
      draw();
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [unit]);
  return <span ref={ref} className="num ticker" />;
}

export function Hero({
  bestApy,
  bestMarket,
  lendSymbol,
  field,
  focus,
  interestPerSecond,
  interestUnit,
  onEarn,
  onBorrow,
  onDocs,
  testnet,
}: {
  bestApy: number | null;
  bestMarket: string | null;
  lendSymbol: string | null;
  field: FieldMarket[];
  focus: number;
  interestPerSecond: number;
  interestUnit: string;
  onEarn: () => void;
  onBorrow: () => void;
  onDocs: () => void;
  testnet: boolean;
}) {
  const hasApy = bestApy !== null && bestApy > 0;
  return (
    <section className="hero" aria-label="Earn with Accumulator">
      <div className="hero-field">
        <Suspense fallback={<div className="gfield gfield-static" />}>
          <GravitationalField markets={field} focus={focus} />
        </Suspense>
      </div>
      <div className="hero-copy">
        <span className="eyebrow">Lending on X1</span>
        <h1>
          <Typer lines={LINES} />
        </h1>
        <p className="hero-sub">
          Deposit XNT or USDC into Accumulator and earn the interest borrowers pay. Withdraw any time liquidity allows. Prices come
          only from on-chain data, and the admin can't touch your deposit.
        </p>
        <div className="earn-card" role="group" aria-label="Best current yield">
          <span className="earn-word">EARN</span>
          <div className="earn-main">
            <span className="earn-apy num">{hasApy ? `${bestApy!.toFixed(2)}%` : "—"}</span>
            <span className="earn-label">
              {hasApy ? (
                <>
                  APY on {lendSymbol} in {bestMarket}
                </>
              ) : (
                "APY appears once borrowers are paying interest"
              )}
            </span>
          </div>
        </div>
        {interestPerSecond > 0 && (
          <p className="earn-flow">
            <span className="flow-dot" aria-hidden /> Paid to lenders since you opened this page:{" "}
            <InterestTicker perSecond={interestPerSecond} unit={interestUnit} />
          </p>
        )}
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
      <p className="field-legend">
        Each ring is a market, sized by deposits. Streams falling into the core are borrowed liquidity. The core pulses
        faster as lender APY rises. {testnet ? "Testnet data." : "Live data."}
      </p>
    </section>
  );
}

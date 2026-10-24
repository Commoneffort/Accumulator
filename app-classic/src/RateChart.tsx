import { useEffect, useRef, useState } from "react";
import { BPS, Params, borrowRateBps } from "../../sdk/src";

/** Borrow APR and supply APY (in %) at a utilization (bps). */
function rates(p: Params, u: number) {
  const borrow = Number(borrowRateBps(p, BigInt(u))) / 100;
  const supply = (borrow * (u / 10_000) * (10_000 - p.reserveFactorBps)) / 10_000;
  return { borrow, supply };
}

function niceStep(max: number) {
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
}

const H = 260;
const M = { l: 48, r: 92, t: 16, b: 36 };

/**
 * The market's interest-rate curve: what borrowers pay and lenders earn at each
 * utilization, with today's utilization marked. Hover for exact values.
 */
export function RateChart({ params, currentBps }: { params: Params; currentBps: number | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(640);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(320, e.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);

  const pw = w - M.l - M.r;
  const ph = H - M.t - M.b;
  const pts = Array.from({ length: 101 }, (_, i) => ({ u: i * 100, ...rates(params, i * 100) }));
  const yMaxRaw = pts[100].borrow;
  const step = niceStep(yMaxRaw);
  const yMax = Math.ceil(yMaxRaw / step) * step;
  const x = (u: number) => M.l + (u / 10_000) * pw;
  const y = (v: number) => M.t + ph - (v / yMax) * ph;
  const path = (k: "borrow" | "supply") => pts.map((p, i) => `${i ? "L" : "M"}${x(p.u).toFixed(1)} ${y(p[k]).toFixed(1)}`).join("");
  const yTicks = Array.from({ length: Math.round(yMax / step) + 1 }, (_, i) => i * step);
  const kink = params.optimalUtilizationBps;
  const cap = params.maxUtilizationBps;
  const now = currentBps === null ? null : Math.min(10_000, currentBps);
  const end = pts[100];

  // keep the two end labels apart
  let yb = y(end.borrow);
  let ys = y(end.supply);
  if (Math.abs(yb - ys) < 16) ys = yb + 16;
  ys = Math.min(ys, M.t + ph);

  const h = hover === null ? null : rates(params, hover);

  function onMove(e: React.PointerEvent<SVGRectElement>) {
    const r = (e.currentTarget as SVGRectElement).getBoundingClientRect();
    const u = Math.round(((e.clientX - r.left) / r.width) * 100) * 100;
    setHover(Math.max(0, Math.min(10_000, u)));
  }

  return (
    <figure className="chart" ref={ref}>
      <figcaption className="chart-head">
        <span className="chart-title">Interest rate by utilization</span>
        <span className="legend">
          <span className="key">
            <i style={{ background: "var(--series-1)" }} /> Borrow APR
          </span>
          <span className="key">
            <i style={{ background: "var(--series-2)" }} /> Supply APY
          </span>
        </span>
      </figcaption>
      <svg width={w} height={H} role="img" aria-label={`Borrow APR rises from ${params.baseRateBps / 100}% to ${end.borrow.toFixed(0)}% at full utilization, steepening past ${kink / 100}%.`}>
        {/* no-new-borrows zone past the utilization cap */}
        <rect x={x(cap)} y={M.t} width={x(10_000) - x(cap)} height={ph} fill="var(--zone)" />
        <text x={x(cap) + 4} y={M.t + 12} className="ax small">no new borrows</text>

        <g>
          {yTicks.map((t) => (
            <g key={t}>
              <line x1={M.l} x2={M.l + pw} y1={y(t)} y2={y(t)} stroke="var(--grid)" />
              <text x={M.l - 8} y={y(t) + 4} textAnchor="end" className="ax">
                {t}%
              </text>
            </g>
          ))}
          {[0, 2_000, 4_000, 6_000, 8_000, 10_000].map((u) => (
            <text key={u} x={x(u)} y={H - 14} textAnchor="middle" className="ax">
              {u / 100}%
            </text>
          ))}
          <text x={M.l + pw / 2} y={H - 1} textAnchor="middle" className="ax">
            utilization (borrowed ÷ supplied)
          </text>
        </g>

        {/* kink */}
        <line x1={x(kink)} x2={x(kink)} y1={M.t} y2={M.t + ph} stroke="var(--grid-strong)" strokeDasharray="2 4" />
        <text x={x(kink) - 4} y={M.t + 12} textAnchor="end" className="ax small">
          kink {kink / 100}%
        </text>

        <path d={path("supply")} fill="none" stroke="var(--series-2)" strokeWidth={2} strokeLinejoin="round" />
        <path d={path("borrow")} fill="none" stroke="var(--series-1)" strokeWidth={2} strokeLinejoin="round" />

        {/* direct labels */}
        <text x={x(10_000) + 8} y={yb + 4} className="lbl">
          Borrow {end.borrow.toFixed(0)}%
        </text>
        <text x={x(10_000) + 8} y={ys + 4} className="lbl">
          Supply {end.supply.toFixed(0)}%
        </text>

        {/* today */}
        {now !== null && (
          <g>
            <line x1={x(now)} x2={x(now)} y1={M.t} y2={M.t + ph} stroke="var(--ref)" strokeDasharray="4 3" />
            <circle cx={x(now)} cy={y(rates(params, now).borrow)} r={4.5} fill="var(--series-1)" stroke="var(--surface)" strokeWidth={2} />
            <circle cx={x(now)} cy={y(rates(params, now).supply)} r={4.5} fill="var(--series-2)" stroke="var(--surface)" strokeWidth={2} />
            <text x={x(now) + 6} y={M.t + ph - 6} className="lbl">
              now {(now / 100).toFixed(1)}%
            </text>
          </g>
        )}

        {/* hover */}
        {hover !== null && h && (
          <g pointerEvents="none">
            <line x1={x(hover)} x2={x(hover)} y1={M.t} y2={M.t + ph} stroke="var(--crosshair)" />
            <circle cx={x(hover)} cy={y(h.borrow)} r={4} fill="var(--series-1)" stroke="var(--surface)" strokeWidth={2} />
            <circle cx={x(hover)} cy={y(h.supply)} r={4} fill="var(--series-2)" stroke="var(--surface)" strokeWidth={2} />
          </g>
        )}
        <rect x={M.l} y={M.t} width={pw} height={ph} fill="transparent" pointerEvents="all" style={{ cursor: "crosshair" }} onPointerMove={onMove} onPointerLeave={() => setHover(null)} />
      </svg>
      {hover !== null && h && (
        <div className="tip" style={{ left: Math.min(x(hover) + 12, w - 170), top: M.t + 8 }}>
          <strong>{hover / 100}% utilized</strong>
          <span>
            <i style={{ background: "var(--series-1)" }} /> Borrow APR <b className="num">{h.borrow.toFixed(2)}%</b>
          </span>
          <span>
            <i style={{ background: "var(--series-2)" }} /> Supply APY <b className="num">{h.supply.toFixed(2)}%</b>
          </span>
          {hover > cap && <em>Above the {cap / 100}% cap: only interest can push it here</em>}
        </div>
      )}
    </figure>
  );
}

void BPS;

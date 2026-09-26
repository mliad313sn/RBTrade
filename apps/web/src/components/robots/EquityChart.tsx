'use client';

import { fmtRatioPct } from '@/lib/robots/format';

export interface EquityChartProps {
  t: number[];
  equity: number[];
  drawdown: number[];
  oosStart: number | null;
  currency: string;
}

const W = 760;
const H = 220;
const PAD = { l: 8, r: 8, t: 16, b: 18 };

/**
 * Backtest equity net of costs: in-sample line (blue), out-of-sample line (orange, dashed) after
 * the divider, drawdown area underneath. Text labels and the dash pattern carry the IS/OOS meaning,
 * so colour is never the only cue. SIMULATED watermark.
 */
export function EquityChart({ t, equity, drawdown, oosStart, currency }: EquityChartProps) {
  if (t.length < 2)
    return <p className="text-sm text-muted">Run a backtest to see the equity curve.</p>;
  const x0 = t[0]!;
  const x1 = t[t.length - 1]!;
  const lo = Math.min(...equity);
  const hi = Math.max(...equity);
  const span = hi - lo || 1;
  const X = (v: number) => PAD.l + ((v - x0) / (x1 - x0 || 1)) * (W - PAD.l - PAD.r);
  const Y = (v: number) => PAD.t + (1 - (v - lo) / span) * (H * 0.72 - PAD.t);
  const ddTop = H * 0.76;
  const ddMin = Math.min(...drawdown, -0.0001);
  const DD = (v: number) => ddTop + (v / ddMin) * (H - PAD.b - ddTop);
  const split =
    oosStart === null
      ? t.length
      : Math.max(
          1,
          t.findIndex((v) => v > oosStart),
        );
  const idx = split < 0 ? t.length : split;
  const path = (a: number, b: number) =>
    t
      .slice(a, b)
      .map((v, i) => `${i ? 'L' : 'M'}${X(v).toFixed(1)},${Y(equity[a + i]!).toFixed(1)}`)
      .join(' ');
  const dd = `M${X(x0)},${ddTop} ${t.map((v, i) => `L${X(v).toFixed(1)},${DD(drawdown[i]!).toFixed(1)}`).join(' ')} L${X(x1)},${ddTop} Z`;
  const divider = oosStart !== null && idx < t.length ? X(t[idx]!) : null;
  const first = equity[0]!;
  const last = equity[equity.length - 1]!;
  const worst = Math.min(...drawdown);
  return (
    <figure className="m-0" data-testid="equity-chart">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        role="img"
        aria-labelledby="eq-title eq-desc"
      >
        <title id="eq-title">Backtest equity, net of costs (SIMULATED)</title>
        <desc id="eq-desc">
          {`Equity from ${first.toFixed(0)} to ${last.toFixed(0)} ${currency}; worst drawdown ${fmtRatioPct(worst)}. ${divider !== null ? 'The dashed orange part after the divider is out-of-sample.' : ''}`}
        </desc>
        <text
          x={W / 2}
          y={H / 2}
          textAnchor="middle"
          fontSize="34"
          fill="var(--k-text-muted)"
          opacity="0.08"
          fontWeight="700"
        >
          SIMULATED
        </text>
        <path d={dd} fill="var(--k-text-muted)" opacity="0.18" />
        <path
          d={path(0, Math.min(idx + 1, t.length))}
          fill="none"
          stroke="var(--k-up)"
          strokeWidth="1.6"
        />
        {divider !== null ? (
          <>
            <path
              d={path(idx, t.length)}
              fill="none"
              stroke="var(--k-down)"
              strokeWidth="1.6"
              strokeDasharray="5 2"
            />
            <line
              x1={divider}
              x2={divider}
              y1={PAD.t - 6}
              y2={H - PAD.b}
              stroke="var(--k-border)"
              strokeDasharray="3 3"
            />
            <text x={divider + 4} y={PAD.t} fontSize="10" fill="var(--k-down)" fontWeight="700">
              OUT-OF-SAMPLE →
            </text>
          </>
        ) : null}
        <text x={PAD.l} y={H - 4} fontSize="10" fill="var(--k-text-muted)">
          {new Date(x0).toISOString().slice(0, 10)}
        </text>
        <text x={W - PAD.r} y={H - 4} fontSize="10" fill="var(--k-text-muted)" textAnchor="end">
          {new Date(x1).toISOString().slice(0, 10)}
        </text>
        <text
          x={W - PAD.r}
          y={ddTop + 12}
          fontSize="10"
          fill="var(--k-text-muted)"
          textAnchor="end"
        >
          Drawdown {fmtRatioPct(worst)}
        </text>
      </svg>
    </figure>
  );
}

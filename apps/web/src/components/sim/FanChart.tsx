'use client';

import { forwardRef, useId } from 'react';

import { bandPath, linear, linePath, niceTicks, periodTicks } from '@/lib/sim/chart';
import { fmtCompact } from '@/lib/sim/format';
import type { SimResult } from '@/lib/sim/types';

export interface FanChartProps {
  result: SimResult;
  /** Scenario A overlay for A/B compare (its median and P5–P95 outline, dashed). */
  compare?: { label: string; result: SimResult } | null;
  /** Hide sample paths, ruin floor and axis detail (Novice band chart). */
  simple?: boolean;
  title: string;
  periodLabel?: (k: number) => string;
  height?: number;
}

const W = 760;
const PAD = { top: 18, right: 58, bottom: 30, left: 12 };

/**
 * Percentile fan chart (SVG). Everything is drawn from the api response; nothing is interpolated.
 * Colours are CSS variables so the PNG export can inline the live theme values.
 */
export const FanChart = forwardRef<SVGSVGElement, FanChartProps>(function FanChart(
  { result, compare, simple = false, title, periodLabel = (k) => `M${k}`, height = 460 },
  ref,
) {
  const titleId = useId();
  const H = height;
  const b = result.bands;
  const n = b.p50.length;
  const values = [
    ...b.p5,
    ...b.p95,
    result.startingCapital,
    ...(simple ? [] : [result.ruinFloor]),
    ...(simple ? [] : result.samplePaths.flat()),
  ];
  if (compare) values.push(...compare.result.bands.p5, ...compare.result.bands.p95);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const padY = (hi - lo) * 0.06 || 1;
  const y = linear([Math.max(0, lo - padY), hi + padY], [H - PAD.bottom, PAD.top]);
  const x = linear([0, Math.max(n - 1, 1)], [PAD.left, W - PAD.right]);
  const xs = b.p50.map((_, i) => x(i));
  const ys = (arr: number[]) => arr.map((v) => y(v));
  const yTicks = niceTicks(y.domain[0], y.domain[1], 6);
  const xTicks = periodTicks(n - 1, 5);
  const last = n - 1;
  const summary =
    `${title}. After ${last} ${simple ? 'months' : 'periods'}: middle outcome ${fmtCompact(b.p50[last]!)}, ` +
    `9 in 10 ${simple ? 'made-up years' : 'paths'} between ${fmtCompact(b.p5[last]!)} and ${fmtCompact(b.p95[last]!)}; start ${fmtCompact(result.startingCapital)}` +
    (simple ? '.' : `; ruin floor ${fmtCompact(result.ruinFloor)}. Simulated, not a forecast.`);

  const cxs = compare
    ? compare.result.bands.p50.map((_, i) =>
        linear([0, Math.max(compare.result.bands.p50.length - 1, 1)], [PAD.left, W - PAD.right])(i),
      )
    : [];

  return (
    <svg
      ref={ref}
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-labelledby={titleId}
      className="w-full h-auto block"
      data-testid="fan-chart"
      xmlns="http://www.w3.org/2000/svg"
      fontFamily="IBM Plex Mono, ui-monospace, monospace"
    >
      <title id={titleId}>{summary}</title>
      <rect x="0" y="0" width={W} height={H} fill="var(--k-panel)" />
      {yTicks.map((t) => (
        <g key={`y${t}`}>
          <line
            x1={PAD.left}
            x2={W - PAD.right}
            y1={y(t)}
            y2={y(t)}
            stroke="var(--k-border)"
            strokeWidth="1"
          />
          <text x={W - PAD.right + 8} y={y(t) + 4} fontSize="11" fill="var(--k-text-muted)">
            {fmtCompact(t)}
          </text>
        </g>
      ))}
      {xTicks.map((k) => (
        <text
          key={`x${k}`}
          x={x(k)}
          y={H - 10}
          fontSize="11"
          fill="var(--k-text-muted)"
          textAnchor="middle"
        >
          {periodLabel(k)}
        </text>
      ))}
      <path
        d={bandPath(xs, ys(b.p95), ys(b.p5))}
        fill="var(--k-accent)"
        fillOpacity="0.18"
        data-series="p5-p95"
      />
      <path
        d={bandPath(xs, ys(b.p75), ys(b.p25))}
        fill="var(--k-accent)"
        fillOpacity="0.38"
        data-series="p25-p75"
      />
      {simple
        ? null
        : result.samplePaths.map((p, i) => (
            <path
              key={`s${i}`}
              d={linePath(xs, ys(p))}
              fill="none"
              stroke="var(--k-ai)"
              strokeWidth="1.2"
              strokeOpacity="0.85"
              data-series="sample"
            />
          ))}
      {compare ? (
        <g data-series="compare">
          <path
            d={linePath(cxs, ys(compare.result.bands.p95))}
            fill="none"
            stroke="var(--k-warn)"
            strokeWidth="1.2"
            strokeDasharray="2 3"
          />
          <path
            d={linePath(cxs, ys(compare.result.bands.p5))}
            fill="none"
            stroke="var(--k-warn)"
            strokeWidth="1.2"
            strokeDasharray="2 3"
          />
          <path
            d={linePath(cxs, ys(compare.result.bands.p50))}
            fill="none"
            stroke="var(--k-warn)"
            strokeWidth="2"
            strokeDasharray="6 4"
          />
        </g>
      ) : null}
      <line
        x1={PAD.left}
        x2={W - PAD.right}
        y1={y(result.startingCapital)}
        y2={y(result.startingCapital)}
        stroke="var(--k-text-muted)"
        strokeWidth="1"
        strokeDasharray="4 4"
        data-series="start"
      />
      {simple || result.ruinFloor <= 0 ? null : (
        <line
          x1={PAD.left}
          x2={W - PAD.right}
          y1={y(result.ruinFloor)}
          y2={y(result.ruinFloor)}
          stroke="var(--k-down)"
          strokeWidth="1.5"
          strokeDasharray="6 5"
          data-series="ruin"
        />
      )}
      <path
        d={linePath(xs, ys(b.p50))}
        fill="none"
        stroke="var(--k-text)"
        strokeWidth="2.5"
        data-series="median"
      />
      <text
        x={W - PAD.right - 12}
        y={H - PAD.bottom - 14}
        textAnchor="end"
        fontSize={simple ? 34 : 46}
        fontWeight="700"
        letterSpacing="8"
        fill="var(--k-text)"
        fillOpacity="0.07"
        data-testid="simulated-watermark"
      >
        SIMULATED
      </text>
    </svg>
  );
});

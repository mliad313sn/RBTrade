'use client';

import { useId } from 'react';

import { fmtPct } from '@/lib/sim/format';
import type { SimResult } from '@/lib/sim/types';

const W = 300;
const H = 150;
const PAD = { top: 8, bottom: 22, left: 4, right: 4 };

/** Max-drawdown histogram. Bars at or beyond the P95 drawdown are the "worst 5%" (orange + hatch). */
export function DrawdownHistogram({ result }: { result: SimResult }) {
  const id = useId();
  const { edges, counts } = result.maxDrawdown.histogram;
  const max = Math.max(...counts, 1);
  const bw = (W - PAD.left - PAD.right) / counts.length;
  const p95 = result.maxDrawdown.p95;
  const labels = [
    0,
    Math.floor(counts.length / 3),
    Math.floor((2 * counts.length) / 3),
    counts.length - 1,
  ];
  return (
    <figure className="m-0">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-labelledby={id}
        className="w-full h-auto block"
        data-testid="drawdown-histogram"
      >
        <title id={id}>
          {`Maximum drawdown across paths: median ${fmtPct(result.maxDrawdown.median)}, 95th percentile ${fmtPct(result.maxDrawdown.p95)}.`}
        </title>
        <defs>
          <pattern
            id={`${id}-hatch`}
            width="4"
            height="4"
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(45)"
          >
            <line x1="0" y1="0" x2="0" y2="4" stroke="var(--k-bg)" strokeWidth="1.5" />
          </pattern>
        </defs>
        {counts.map((c, i) => {
          const h = ((H - PAD.top - PAD.bottom) * c) / max;
          const tail = edges[i + 1]! > p95; // the bin holding the 95th percentile, and beyond
          const xPos = PAD.left + i * bw + 1;
          const yPos = H - PAD.bottom - h;
          return (
            <g key={i} data-tail={tail ? 'true' : 'false'}>
              <rect
                x={xPos}
                y={yPos}
                width={Math.max(bw - 2, 1)}
                height={h}
                fill={tail ? 'var(--k-down)' : 'var(--k-accent)'}
              />
              {tail && h > 0 ? (
                <rect
                  x={xPos}
                  y={yPos}
                  width={Math.max(bw - 2, 1)}
                  height={h}
                  fill={`url(#${id}-hatch)`}
                />
              ) : null}
            </g>
          );
        })}
        <line
          x1={PAD.left}
          x2={W - PAD.right}
          y1={H - PAD.bottom}
          y2={H - PAD.bottom}
          stroke="var(--k-border)"
        />
        {labels.map((i) => (
          <text
            key={i}
            x={PAD.left + i * bw}
            y={H - 6}
            fontSize="10"
            fill="var(--k-text-muted)"
            fontFamily="IBM Plex Mono, monospace"
          >
            {i === counts.length - 1
              ? `${Math.round(edges[i]! * 100)}%+`
              : `${Math.round(edges[i]! * 100)}%`}
          </text>
        ))}
      </svg>
      <figcaption className="text-[11px] text-muted mt-1">
        <span aria-hidden="true" className="inline-block w-2 h-2 bg-down mr-1 align-middle" />
        Hatched orange: the worst 5% of paths (at or beyond the 95th percentile).
      </figcaption>
    </figure>
  );
}

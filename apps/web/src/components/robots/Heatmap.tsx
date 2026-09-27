'use client';

import { fmtNum } from '@/lib/robots/format';
import type { SensitivityResult } from '@/lib/robots/types';

/** Blue scale on validation Sharpe; the number is always printed, so colour is not the only cue. */
function shade(v: number | null | undefined, lo: number, hi: number): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return 'var(--k-raised)';
  const r = hi === lo ? 0.5 : (v - lo) / (hi - lo);
  const pct = Math.round(15 + r * 70);
  return `color-mix(in srgb, var(--k-up) ${pct}%, var(--k-panel))`;
}

/**
 * Sensitivity heatmap (goal 06 §5): validation Sharpe over two parameters; current cell outlined.
 * IRTC R3-01: the validation segment is the end of the in-sample window, so choosing a cell never
 * reads the out-of-sample holdout.
 */
export function Heatmap({ data }: { data: SensitivityResult }) {
  const vals = data.cells
    .flat()
    .map((c) => c.validationSharpe)
    .filter((v): v is number => typeof v === 'number');
  const lo = vals.length ? Math.min(...vals) : 0;
  const hi = vals.length ? Math.max(...vals) : 1;
  return (
    <figure className="m-0" data-testid="heatmap">
      <table className="w-full border-separate text-xs" style={{ borderSpacing: 2 }}>
        <caption className="mb-1 text-left text-xs text-muted">
          Sharpe (validation, holdout unused) · {data.y.param} ↓ × {data.x.param} →
        </caption>
        <thead>
          <tr>
            <th scope="col" className="text-muted">
              <span className="k-sr-only">
                {data.y.param} \ {data.x.param}
              </span>
            </th>
            {data.x.values.map((x) => (
              <th key={x} scope="col" className="k-num font-normal text-muted">
                {x}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.cells.map((row, i) => (
            <tr key={data.y.values[i]}>
              <th scope="row" className="k-num pr-1 text-right font-normal text-muted">
                {data.y.values[i]}
              </th>
              {row.map((c) => {
                const current = c.x === data.x.current && c.y === data.y.current;
                return (
                  <td
                    key={`${c.x}-${c.y}`}
                    className="k-num px-1 py-1 text-center"
                    style={{
                      background: shade(c.validationSharpe, lo, hi),
                      outline: current ? '2px solid var(--k-focus)' : undefined,
                      color: 'var(--k-text)',
                    }}
                    title={
                      c.error ??
                      `${data.x.param} ${c.x}, ${data.y.param} ${c.y}: validation Sharpe ${fmtNum(c.validationSharpe)}, ${c.validationTrades ?? 0} validation trades`
                    }
                    aria-label={
                      current
                        ? `current cell, validation Sharpe ${fmtNum(c.validationSharpe)}`
                        : undefined
                    }
                  >
                    {c.error ? '×' : fmtNum(c.validationSharpe)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <figcaption className="mt-1 text-xs text-muted">{data.note}</figcaption>
    </figure>
  );
}

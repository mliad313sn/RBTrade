'use client';

import { fmtDays, fmtNum, fmtR, fmtRatioPct } from '@/lib/robots/format';
import type { Metrics } from '@/lib/robots/types';

type Col = { label: string; m: Metrics | null; tone?: string };

const ROWS: Array<{ label: string; get: (m: Metrics) => string }> = [
  { label: 'CAGR', get: (m) => fmtRatioPct(m.cagr) },
  { label: 'Sharpe', get: (m) => fmtNum(m.sharpe) },
  { label: 'Sortino', get: (m) => fmtNum(m.sortino) },
  { label: 'Calmar', get: (m) => fmtNum(m.calmar) },
  { label: 'Max drawdown', get: (m) => fmtRatioPct(m.maxDrawdown) },
  { label: 'DD duration', get: (m) => fmtDays(m.maxDrawdownDays) },
  { label: 'Win rate', get: (m) => fmtRatioPct(m.winRate) },
  { label: 'Profit factor', get: (m) => fmtNum(m.profitFactor) },
  { label: 'Expectancy', get: (m) => fmtR(m.expectancyR) },
  { label: 'Expectancy (ccy)', get: (m) => fmtNum(m.expectancyCcy, 0) },
  {
    label: 'Trades · exposure',
    get: (m) => `${m.trades} · ${m.exposurePct === null ? '—' : `${Math.round(m.exposurePct)}%`}`,
  },
  { label: 'Turnover', get: (m) => (m.turnover === null ? '—' : `${fmtNum(m.turnover, 1)}×/yr`) },
  {
    label: 'Cost drag',
    get: (m) => (m.costDragPct === null ? '—' : `${fmtNum(m.costDragPct, 1)}%/yr`),
  },
];

/** KPI table: in-sample / out-of-sample / walk-forward / live (SIMULATED estimates). */
export function KpiTable({ columns }: { columns: Col[] }) {
  return (
    <table className="w-full border-collapse text-sm" data-testid="kpi-table">
      <caption className="k-sr-only">Performance metrics by split (SIMULATED)</caption>
      <thead>
        <tr className="text-left text-xs uppercase text-muted">
          <th scope="col" className="py-1 font-semibold">
            Metric
          </th>
          {columns.map((c) => (
            <th
              key={c.label}
              scope="col"
              className="py-1 text-right font-semibold"
              style={c.tone ? { color: c.tone } : undefined}
            >
              {c.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {ROWS.map((r) => (
          <tr key={r.label} className="border-t" style={{ borderColor: 'var(--k-border)' }}>
            <th scope="row" className="py-1 text-left font-normal text-muted">
              {r.label}
            </th>
            {columns.map((c) => (
              <td
                key={c.label}
                className="k-num py-1 text-right"
                style={c.tone ? { color: c.tone } : undefined}
              >
                {c.m ? r.get(c.m) : '—'}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

'use client';

import { Panel } from '@kora/ui';
import type { ReactNode } from 'react';

import { fmtChange, fmtCompact, fmtExpectancy, fmtPct } from '@/lib/sim/format';
import type {
  PaperAnalytics,
  PaperSource,
  RealityCheck,
  Scenario,
  SimResult,
} from '@/lib/sim/types';

function Tile({
  label,
  testId,
  value,
  children,
}: {
  label: string;
  testId: string;
  value?: number;
  children: ReactNode;
}) {
  return (
    <div
      className="k-panel p-3 flex flex-col gap-1 min-w-0"
      data-testid={testId}
      data-value={value}
    >
      <span className="text-[11px] uppercase tracking-wider text-muted font-semibold">{label}</span>
      {children}
    </div>
  );
}

const dirClass = { up: 'text-up', down: 'text-down', flat: 'text-muted' } as const;

/** The five KPI tiles under the fan chart (prototype order). */
export function KpiTiles({ result }: { result: SimResult }) {
  const f = result.finalEquity;
  const change = fmtChange(f.p50 / result.startingCapital - 1);
  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-2" data-testid="kpi-tiles">
      <Tile label="Median final equity" testId="kpi-median" value={f.p50}>
        <span className="k-num text-2xl">{fmtCompact(f.p50)}</span>
        <span className={`k-num text-xs ${dirClass[change.dir]}`}>{change.text}</span>
      </Tile>
      {/* IRTC R5-23: the values wrap inside the tile, and each is coloured (with a glyph) by where it
          ends against the starting capital: a P5 above the start is a gain, not "down". */}
      <Tile label="P5 · P95 final" testId="kpi-range" value={f.p5}>
        <span className="k-num text-base flex flex-wrap gap-x-1 min-w-0">
          {([['5th', f.p5], ['95th', f.p95]] as const).map(([pct, v], i) => {
            const dir = v > result.startingCapital ? 'up' : v < result.startingCapital ? 'down' : 'flat';
            return (
              <span key={pct} className="whitespace-nowrap">
                {i ? <span className="text-muted">· </span> : null}
                <span className={dirClass[dir]} aria-label={`${pct} percentile ${fmtCompact(v)}`}>
                  <span aria-hidden="true">{dir === 'up' ? '▲' : dir === 'down' ? '▼' : ''}</span>
                  {fmtCompact(v)}
                </span>
              </span>
            );
          })}
        </span>
      </Tile>
      <Tile label="P(ending below start)" testId="kpi-below-start" value={result.probEndBelowStart}>
        <span className={`k-num text-2xl ${result.probEndBelowStart > 0 ? 'text-down' : ''}`}>
          {fmtPct(result.probEndBelowStart)}
        </span>
      </Tile>
      <Tile label="Risk of ruin (hit floor)" testId="kpi-ruin" value={result.riskOfRuin}>
        <span className={`k-num text-2xl ${result.riskOfRuin > 0 ? 'text-down' : ''}`}>
          {fmtPct(result.riskOfRuin)}
        </span>
        {result.riskOfRuinApprox !== null ? (
          <span className="text-[11px] text-muted">
            closed form ≈ {fmtPct(result.riskOfRuinApprox)}
          </span>
        ) : null}
      </Tile>
      <Tile label="Expectancy / trade" testId="kpi-expectancy" value={result.expectancyR}>
        <span className={`k-num text-2xl ${result.expectancyR > 0 ? 'text-up' : 'text-down'}`}>
          {fmtExpectancy(result.expectancyR, result.expectancyUnit)}
        </span>
        <span className="text-[11px] text-muted">after costs</span>
      </Tile>
    </div>
  );
}

/** Full Kelly has no upper bound when the sample has no losing trade (goal 10 contract fix). */
const UNBOUNDED = 'not defined: no losing trade in the sample';

/** Kelly, streak, time under water, trades simulated. */
export function RiskTable({ result }: { result: SimResult }) {
  const rows: [string, string][] = [
    result.expectancyUnit === 'pct'
      ? ['Full Kelly (multiple of your paper sizing)', result.kelly.full === null ? UNBOUNDED : `${result.kelly.full.toFixed(2)}×`]
      : ['Kelly fraction (full, after costs)', result.kelly.full === null ? UNBOUNDED : fmtPct(result.kelly.full)],
    [
      result.expectancyUnit === 'pct' ? 'Your sizing / Kelly' : 'Your risk / Kelly',
      result.kelly.full === null ? '—' : result.kelly.ratio === null ? 'no edge' : `${result.kelly.ratio.toFixed(2)}×`,
    ],
    ['Longest losing streak (median)', `${result.longestLosingStreak.median} trades`],
    ['Periods under water (median)', `${result.timeUnderWater.median} of ${result.periods}`],
    ['Max drawdown P95', fmtPct(result.maxDrawdown.p95)],
    ['Total trades simulated', (result.paths * result.tradesPerPath).toLocaleString('en-US')],
  ];
  if (result.effective.blockSize !== null)
    rows.push(['Bootstrap block size', `${result.effective.blockSize} trades`]);
  return (
    <dl className="m-0 grid grid-cols-[1fr_auto] gap-x-3 gap-y-2 text-sm" data-testid="risk-table">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-text">{k}</dt>
          <dd className="m-0 k-num text-right">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

const SEVERITY = {
  critical: { icon: '⛔', label: 'Critical', cls: 'border-kill text-text' },
  warning: { icon: '⚠', label: 'Warning', cls: 'border-warn text-text' },
  info: { icon: 'ⓘ', label: 'Note', cls: 'border-accent text-text' },
} as const;

export function RealityChecks({ checks }: { checks: RealityCheck[] }) {
  if (checks.length === 0) {
    return (
      <p
        className="m-0 p-3 rounded border border-border bg-accent-surface text-sm"
        data-testid="reality-ok"
      >
        Inputs look internally consistent. Run the stress test before trusting the median.
      </p>
    );
  }
  return (
    <ul className="list-none m-0 p-0 flex flex-col gap-2" data-testid="reality-checks">
      {checks.map((c) => {
        const s = SEVERITY[c.severity];
        return (
          <li
            key={c.code}
            className={`p-3 rounded border-l-4 border border-border bg-raised text-sm ${s.cls}`}
            data-code={c.code}
            data-severity={c.severity}
          >
            <strong className="block">
              <span aria-hidden="true">{s.icon} </span>
              <span className="k-sr-only">{s.label}: </span>
              {c.title}
            </strong>
            <span className="text-muted">{c.message}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** Paper-account analytics (realised). Shows the fixture label until goal 03 supplies real fills. */
export function PaperCard({
  analytics,
  source,
  onClose,
}: {
  analytics: PaperAnalytics;
  source: PaperSource;
  onClose: () => void;
}) {
  const pct = (v: number | null, d = 1) => (v === null ? '—' : `${v.toFixed(d)}%`);
  const rows: [string, string][] = [
    ['Closed trades', String(analytics.trades)],
    ['Win rate', pct(analytics.winRatePct)],
    ['Profit factor', analytics.profitFactor === null ? '—' : analytics.profitFactor.toFixed(2)],
    [
      'Expectancy / trade',
      analytics.expectancy === null
        ? '—'
        : `$${analytics.expectancy} (${pct(analytics.expectancyPct, 2)})`,
    ],
    ['Net realised P&L', `$${analytics.netPnl}`],
    ['Max drawdown (realised)', pct(analytics.maxDrawdownPct)],
    ['Cost drag (fees + slippage)', `${pct(analytics.costDragPct, 2)} of start`],
    ['Exposure (time in market)', pct(analytics.exposurePct)],
  ];
  return (
    <Panel
      title="Paper account"
      actions={
        <button type="button" className="k-btn k-btn--ghost k-btn--sm" onClick={onClose}>
          Back to assumptions
        </button>
      }
      data-testid="paper-card"
    >
      <p className="mt-0 text-[11px] text-warn font-semibold" data-testid="paper-source">
        {source.label}
      </p>
      <dl className="m-0 grid grid-cols-[1fr_auto] gap-x-3 gap-y-1.5 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt>{k}</dt>
            <dd className="m-0 k-num text-right">{v}</dd>
          </div>
        ))}
      </dl>
    </Panel>
  );
}

const COMPARE_ROWS: {
  label: string;
  get: (r: SimResult) => number;
  fmt: (v: number, r: SimResult) => string;
  higherIsBetter: boolean;
}[] = [
  {
    label: 'Median final equity',
    get: (r) => r.finalEquity.p50,
    fmt: (v) => fmtCompact(v),
    higherIsBetter: true,
  },
  {
    label: 'P5 final equity',
    get: (r) => r.finalEquity.p5,
    fmt: (v) => fmtCompact(v),
    higherIsBetter: true,
  },
  {
    label: 'P95 final equity',
    get: (r) => r.finalEquity.p95,
    fmt: (v) => fmtCompact(v),
    higherIsBetter: true,
  },
  {
    label: 'P(ending below start)',
    get: (r) => r.probEndBelowStart,
    fmt: (v) => fmtPct(v),
    higherIsBetter: false,
  },
  { label: 'Risk of ruin', get: (r) => r.riskOfRuin, fmt: (v) => fmtPct(v), higherIsBetter: false },
  {
    label: 'Max drawdown (median)',
    get: (r) => r.maxDrawdown.median,
    fmt: (v) => fmtPct(v),
    higherIsBetter: false,
  },
  {
    label: 'Expectancy / trade',
    get: (r) => r.expectancyR,
    fmt: (v, r) => fmtExpectancy(v, r.expectancyUnit),
    higherIsBetter: true,
  },
];

/** A/B table: pinned scenario A against the current run B. */
export function CompareTable({ a, b }: { a: Scenario; b: Scenario }) {
  return (
    <table className="w-full text-sm border-collapse" data-testid="compare-table">
      <caption className="text-left text-[11px] uppercase tracking-wider text-muted font-semibold pb-2">
        Scenario compare: A (dashed yellow on the chart) vs B (current)
      </caption>
      <thead>
        <tr className="text-muted text-[11px] uppercase">
          <th scope="col" className="text-left font-semibold py-1">
            Metric
          </th>
          <th scope="col" className="text-right font-semibold">
            A · {a.origin}
          </th>
          <th scope="col" className="text-right font-semibold">
            B · {b.origin}
          </th>
          <th scope="col" className="text-right font-semibold">
            B vs A
          </th>
        </tr>
      </thead>
      <tbody>
        {COMPARE_ROWS.map((row) => {
          const va = row.get(a.result);
          const vb = row.get(b.result);
          const diff = vb - va;
          const better = diff === 0 ? null : diff > 0 === row.higherIsBetter;
          return (
            <tr key={row.label} className="border-t border-border">
              <th scope="row" className="text-left font-normal py-1.5">
                {row.label}
              </th>
              <td className="k-num text-right">{row.fmt(va, a.result)}</td>
              <td className="k-num text-right">{row.fmt(vb, b.result)}</td>
              <td
                className={`k-num text-right ${better === null ? 'text-muted' : better ? 'text-up' : 'text-down'}`}
              >
                {better === null ? '=' : `${diff > 0 ? '▲' : '▼'} ${better ? 'better' : 'worse'}`}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

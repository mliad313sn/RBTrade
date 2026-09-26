import type { Scenario } from './types';

function cell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return '';
  const s =
    typeof v === 'number'
      ? Number.isInteger(v)
        ? String(v)
        : v.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')
      : v;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const row = (...cells: (string | number | null | undefined)[]) => cells.map(cell).join(',');

/**
 * CSV export of one or two scenarios: a SIMULATED header, the assumptions, the KPIs and the
 * per-period percentile bands. Everything in the file traces to the api response.
 */
export function buildCsv(scenarios: Scenario[], generatedAt: Date = new Date()): string {
  if (scenarios.length === 0) throw new Error('nothing to export');
  const lines: string[] = [
    row('# KORA Gain Simulator export: SIMULATED, not a forecast, not investment advice'),
    row('# generated_at', generatedAt.toISOString()),
    '',
    row('section', 'metric', ...scenarios.map((s) => s.label)),
  ];
  const a = (name: string, get: (s: Scenario) => string | number | null) =>
    lines.push(row('assumption', name, ...scenarios.map(get)));
  a('origin', (s) => s.origin);
  a('starting_capital', (s) => s.result.startingCapital);
  a('sizing_model', (s) =>
    s.origin === 'paper' ? 'as traded (paper account)' : s.request.sizingModel,
  );
  a('risk_pct', (s) => (s.origin === 'paper' ? null : s.request.riskPct));
  a('win_rate_pct_effective', (s) => s.result.effective.winRatePct);
  a('avg_win', (s) => s.result.effective.avgWinR);
  a('cost_per_trade_r', (s) => s.result.effective.costPerTradeR);
  a('stress_edge_cut_pct', (s) => (s.origin === 'paper' ? null : s.request.stressEdgeCutPct));
  a('fat_tail_prob_pct', (s) => (s.origin === 'paper' ? null : s.request.fatTailProbPct));
  a('trades_per_path', (s) => s.result.tradesPerPath);
  a('periods', (s) => s.result.periods);
  a('ruin_floor', (s) => s.result.ruinFloor);
  a('paths', (s) => s.result.paths);
  a('seed', (s) => s.result.seed);
  a('input_hash', (s) => s.result.inputHash);
  const k = (name: string, get: (s: Scenario) => string | number | null) =>
    lines.push(row('kpi', name, ...scenarios.map(get)));
  k('final_equity_p5', (s) => s.result.finalEquity.p5);
  k('final_equity_p50', (s) => s.result.finalEquity.p50);
  k('final_equity_p95', (s) => s.result.finalEquity.p95);
  k('final_equity_mean', (s) => s.result.finalEquity.mean);
  k('prob_end_below_start', (s) => s.result.probEndBelowStart);
  k('risk_of_ruin', (s) => s.result.riskOfRuin);
  k('risk_of_ruin_closed_form', (s) => s.result.riskOfRuinApprox);
  k('max_drawdown_median', (s) => s.result.maxDrawdown.median);
  k('max_drawdown_p95', (s) => s.result.maxDrawdown.p95);
  k('periods_under_water_median', (s) => s.result.timeUnderWater.median);
  k('longest_losing_streak_median', (s) => s.result.longestLosingStreak.median);
  k(`expectancy_after_costs`, (s) => s.result.expectancyR);
  k('expectancy_unit', (s) => s.result.expectancyUnit);
  k('kelly_full', (s) => s.result.kelly.full);
  k('user_over_kelly', (s) => s.result.kelly.ratio);
  k(
    'reality_checks',
    (s) => s.result.realityChecks.map((c) => `${c.severity}:${c.code}`).join(' ') || 'none',
  );
  lines.push('');
  lines.push(
    row(
      'period',
      ...scenarios.flatMap((s) => ['p5', 'p25', 'p50', 'p75', 'p95'].map((p) => `${s.label}_${p}`)),
    ),
  );
  const periods = Math.max(...scenarios.map((s) => s.result.bands.p50.length));
  for (let i = 0; i < periods; i++) {
    lines.push(
      row(
        i,
        ...scenarios.flatMap((s) => {
          const b = s.result.bands;
          return [b.p5[i], b.p25[i], b.p50[i], b.p75[i], b.p95[i]];
        }),
      ),
    );
  }
  return `${lines.join('\n')}\n`;
}

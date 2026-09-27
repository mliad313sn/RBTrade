import { describe, expect, it } from 'vitest';

import { bandPath, linear, linePath, niceTicks, periodTicks } from './chart';
import { buildCsv } from './csv';
import { fmtChange, fmtCompact, fmtExpectancy, fmtMoney, fmtPct } from './format';
import { findJargon, PRACTICE_GLOSSARY } from './glossary';
import { HOW_CAREFUL, HOW_OFTEN, practiceRequest, yearOutcomes } from './practice';
import type { ProjectRequest, Scenario, SimResult } from './types';

const result = (over: Partial<SimResult> = {}): SimResult => ({
  kind: 'project',
  simulated: true,
  inputHash: 'abc',
  cache: 'miss',
  seed: 1,
  paths: 10_000,
  tradesPerPath: 40,
  periods: 2,
  startingCapital: 10_000,
  ruinFloor: 5_000,
  bands: {
    p5: [10_000, 9_000, 8_000],
    p25: [10_000, 9_500, 9_200],
    p50: [10_000, 10_100, 10_300.5],
    p75: [10_000, 10_600, 11_000],
    p95: [10_000, 11_000, 12_000],
    mean: [10_000, 10_100, 10_300],
  },
  samplePaths: [],
  finalEquity: {
    p5: 8_000,
    p25: 9_200,
    p50: 10_300.5,
    p75: 11_000,
    p95: 12_000,
    mean: 10_300,
    histogram: { edges: [], counts: [] },
  },
  probEndBelowStart: 0.4,
  riskOfRuin: 0.01,
  riskOfRuinApprox: 0.012,
  maxDrawdown: { median: 0.1, p95: 0.2, histogram: { edges: [], counts: [] } },
  timeUnderWater: { median: 1, p95: 2 },
  longestLosingStreak: { median: 4, p95: 7 },
  expectancyR: 0.05,
  expectancyGrossR: 0.1,
  expectancyUnit: 'r',
  kelly: { full: 0.05, userFraction: 0.01, ratio: 0.2 },
  effective: {
    winRatePct: 45,
    avgWinR: 1.8,
    avgLossR: 1,
    costPerTradeR: 0.05,
    riskFraction: 0.01,
    blockSize: null,
  },
  realityChecks: [
    { code: 'small_sample', severity: 'warning', title: 'Small sample', message: 'x, "y"' },
  ],
  elapsedMs: 10,
  disclaimer: 'SIMULATED.',
  ...over,
});

describe('practice mapping', () => {
  it('maps the three plain inputs to parameters with a skill-free edge and costs on', () => {
    const r = practiceRequest({ amount: 5_000, often: 'weekly', careful: 'bold' });
    expect(r).toMatchObject({
      startingCapital: 5_000,
      tradesPerPeriod: 6,
      riskPct: 3,
      horizonPeriods: 12,
      winRatePct: 50,
      avgWinR: 1,
    });
    expect(r.costPerTradeR).toBeGreaterThan(0);
    expect(practiceRequest({ amount: 5, often: 'rarely', careful: 'very' }).startingCapital).toBe(
      100,
    );
    expect(
      practiceRequest({ amount: 1e9, often: 'daily', careful: 'balanced' }).startingCapital,
    ).toBe(1_000_000);
    expect(Object.values(HOW_OFTEN).map((o) => o.tradesPerMonth)).toEqual([2, 6, 20]);
    expect(Object.values(HOW_CAREFUL).map((o) => o.riskPct)).toEqual([0.5, 1, 3]);
  });

  it('good / typical / bad year are the 95th, 50th and 5th of the simulated finals', () => {
    const y = yearOutcomes(result());
    expect(y.map((o) => [o.key, o.end, o.change])).toEqual([
      ['good', 12_000, 2_000],
      ['typical', 10_300.5, 300.5],
      ['bad', 8_000, -2_000],
    ]);
  });
});

describe('plain language', () => {
  it('finds jargon as whole words, case-insensitive', () => {
    expect(findJargon('The Median path and the P95 band')).toEqual(['p95', 'median']);
    expect(findJargon('Fat tails and a stop loss')).toEqual(['stop loss', 'fat tail']);
    expect(findJargon('A typical year with costs and a safety net')).toEqual([]);
    expect(findJargon('sharpened pencils')).toEqual([]);
  });

  it('the glossary itself is jargon-free', () => {
    for (const g of PRACTICE_GLOSSARY) expect(findJargon(`${g.term} ${g.meaning}`)).toEqual([]);
  });
});

describe('formatting', () => {
  it('formats estimates compactly with explicit direction cues', () => {
    expect(fmtCompact(19_432)).toBe('19.4k');
    expect(fmtCompact(950)).toBe('950');
    expect(fmtCompact(Number.NaN)).toBe('—');
    expect(fmtMoney(1234.6)).toBe('$1,235');
    expect(fmtPct(0.0312)).toBe('3.1%');
    expect(fmtChange(0.937)).toEqual({ text: '▲ +93.7%', dir: 'up' });
    expect(fmtChange(-0.12)).toEqual({ text: '▼ −12.0%', dir: 'down' });
    expect(fmtChange(0)).toEqual({ text: '0.0%', dir: 'flat' });
    expect(fmtExpectancy(0.147, 'r')).toBe('+0.147 R');
    expect(fmtExpectancy(-0.12, 'pct')).toBe('−0.12%');
  });
});

describe('chart helpers', () => {
  it('scales and ticks', () => {
    const s = linear([0, 10], [100, 0]);
    expect(s(5)).toBe(50);
    expect(niceTicks(4_750, 32_700, 5)).toEqual([5_000, 10_000, 15_000, 20_000, 25_000, 30_000]);
    expect(niceTicks(3, 3)).toEqual([3]);
    expect(periodTicks(24)).toEqual([0, 6, 12, 18, 24]);
    expect(linePath([0, 1], [2, 3])).toBe('M0.0,2.0L1.0,3.0');
    expect(bandPath([0, 1], [1, 1], [2, 2])).toBe('M0.0,1.0L1.0,1.0L1.0,2.0L0.0,2.0Z');
  });
});

describe('CSV export', () => {
  const request = {
    riskPct: 1,
    sizingModel: 'fixed_fractional',
    stressEdgeCutPct: 0,
    fatTailProbPct: 3,
  } as ProjectRequest;
  const a: Scenario = { label: 'A', origin: 'assumptions', request, result: result() };
  const b: Scenario = {
    label: 'B',
    origin: 'paper',
    request,
    result: result({ finalEquity: { ...result().finalEquity, p50: 9_000 } }),
  };

  it('has a SIMULATED header, assumptions, KPIs and one row per period', () => {
    const csv = buildCsv([a, b], new Date('2026-09-26T00:00:00Z'));
    const lines = csv.trim().split('\n');
    expect(lines[0]).toContain('SIMULATED');
    expect(lines).toContain('section,metric,A,B');
    expect(lines).toContain('kpi,final_equity_p50,10300.5,9000');
    expect(lines).toContain('assumption,sizing_model,fixed_fractional,as traded (paper account)');
    expect(lines).toContain('kpi,reality_checks,warning:small_sample,warning:small_sample');
    expect(lines).toContain('period,A_p5,A_p25,A_p50,A_p75,A_p95,B_p5,B_p25,B_p50,B_p75,B_p95');
    expect(lines.at(-1)).toBe('2,8000,9200,10300.5,11000,12000,8000,9200,10300.5,11000,12000');
  });

  it('refuses an empty export and escapes quotes', () => {
    expect(() => buildCsv([])).toThrow('nothing to export');
    const withQuote: Scenario = { ...a, label: 'A "base", v1' };
    expect(buildCsv([withQuote])).toContain('"A ""base"", v1"');
  });

  it('IRTC R1-11: neutralises spreadsheet formulas in text cells, keeps numbers numeric', () => {
    for (const label of [
      '=HYPERLINK("http://evil.example","x")',
      '+cmd|calc',
      '-2+3',
      '@SUM(A1)',
      '\tx',
      '\rx',
    ]) {
      const csv = buildCsv([{ ...a, label }]);
      const header = csv.split('\n').find((l) => l.startsWith('section,metric,'))!;
      const cell = header.slice('section,metric,'.length).replace(/^"|"$/g, '');
      expect(cell.startsWith("'"), label).toBe(true);
    }
    const lines = buildCsv([{ ...a, label: 'Plain' }], new Date('2026-09-26T00:00:00Z'))
      .trim()
      .split('\n');
    expect(lines).toContain('kpi,final_equity_p50,10300.5');
    // negative numbers (numbers or numeric strings) are data, not formulas
    const neg = buildCsv([{ ...a, label: '-12.50' }]);
    expect(neg).toContain('section,metric,-12.50');
  });
});

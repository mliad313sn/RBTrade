import type { ProjectRequest, SimResult } from './types';

/**
 * Novice "Practice": three plain-language inputs mapped to simulator parameters.
 *
 * The edge is deliberately skill-free (S2 decision, docs/plans/05-gain-simulator.md §2): half the
 * trades win, wins and losses are the same size, every trade pays a small cost, and a few losses
 * jump past the safety net. That is the honest default for someone without a tested method.
 */
export type HowOften = 'rarely' | 'weekly' | 'daily';
export type HowCareful = 'very' | 'balanced' | 'bold';

export const HOW_OFTEN: Record<HowOften, { label: string; hint: string; tradesPerMonth: number }> =
  {
    rarely: {
      label: 'A couple of times a month',
      hint: 'about 2 trades a month',
      tradesPerMonth: 2,
    },
    weekly: { label: 'Once or twice a week', hint: 'about 6 trades a month', tradesPerMonth: 6 },
    daily: { label: 'Most days', hint: 'about 20 trades a month', tradesPerMonth: 20 },
  };

export const HOW_CAREFUL: Record<HowCareful, { label: string; hint: string; riskPct: number }> = {
  very: {
    label: 'Very careful',
    hint: 'each trade can lose at most $0.50 of every $100',
    riskPct: 0.5,
  },
  balanced: {
    label: 'In between',
    hint: 'each trade can lose at most $1 of every $100',
    riskPct: 1,
  },
  bold: { label: 'Bold', hint: 'each trade can lose up to $3 of every $100', riskPct: 3 },
};

export const PRACTICE_ASSUMPTIONS = {
  winRatePct: 50,
  avgWinR: 1,
  costPerTradeR: 0.05,
  fatTailProbPct: 2,
  fatTailMultiple: 2,
  months: 12,
} as const;

export const MIN_AMOUNT = 100;
export const MAX_AMOUNT = 1_000_000;

export interface PracticeInput {
  amount: number;
  often: HowOften;
  careful: HowCareful;
}

export function practiceRequest(input: PracticeInput): ProjectRequest {
  const amount = Math.min(Math.max(input.amount, MIN_AMOUNT), MAX_AMOUNT);
  return {
    startingCapital: amount,
    sizingModel: 'fixed_fractional',
    riskPct: HOW_CAREFUL[input.careful].riskPct,
    fixedAmount: 100,
    kellyFraction: 0.5,
    winRatePct: PRACTICE_ASSUMPTIONS.winRatePct,
    avgWinR: PRACTICE_ASSUMPTIONS.avgWinR,
    costPerTradeR: PRACTICE_ASSUMPTIONS.costPerTradeR,
    tradesPerPeriod: HOW_OFTEN[input.often].tradesPerMonth,
    horizonPeriods: PRACTICE_ASSUMPTIONS.months,
    ruinFloorPct: 0,
    fatTailProbPct: PRACTICE_ASSUMPTIONS.fatTailProbPct,
    fatTailMultiple: PRACTICE_ASSUMPTIONS.fatTailMultiple,
    stressEdgeCutPct: 0,
    withdrawals: { perPeriod: 0, oneOff: [] },
    seed: 1,
    paths: 10_000,
  };
}

export interface YearOutcome {
  key: 'good' | 'typical' | 'bad';
  title: string;
  explain: string;
  end: number;
  change: number;
}

/** Good / typical / bad year: 1-in-20 better, the middle, 1-in-20 worse. */
export function yearOutcomes(result: SimResult): YearOutcome[] {
  const start = result.startingCapital;
  const f = result.finalEquity;
  return [
    {
      key: 'good',
      title: 'Good year',
      explain: 'Only 1 in 20 practice years ended higher than this.',
      end: f.p95,
      change: f.p95 - start,
    },
    {
      key: 'typical',
      title: 'Typical year',
      explain: 'Half of the practice years ended above this, half below.',
      end: f.p50,
      change: f.p50 - start,
    },
    {
      key: 'bad',
      title: 'Bad year',
      explain: 'Only 1 in 20 practice years ended lower than this.',
      end: f.p5,
      change: f.p5 - start,
    },
  ];
}

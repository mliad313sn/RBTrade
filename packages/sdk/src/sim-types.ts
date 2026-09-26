/**
 * Gain simulator wire types (B-506; mirror of apps/api/src/sim/sim.schemas.ts and the quant SimResult).
 * Simulation numbers are statistical estimates (floats), never booked money (ADR 0005).
 */

export type SizingModel = 'fixed_fractional' | 'fixed_amount' | 'kelly_fraction';
export type Severity = 'info' | 'warning' | 'critical';

export interface ProjectRequest {
  startingCapital: number;
  sizingModel: SizingModel;
  riskPct: number;
  fixedAmount: number;
  kellyFraction: number;
  winRatePct: number;
  avgWinR: number;
  costPerTradeR: number;
  tradesPerPeriod: number;
  horizonPeriods: number;
  ruinFloorPct: number;
  fatTailProbPct: number;
  fatTailMultiple: number;
  stressEdgeCutPct: number;
  withdrawals: { perPeriod: number; oneOff: { period: number; amount: number }[] };
  seed: number;
  paths: number;
}

export interface Histogram {
  edges: number[];
  counts: number[];
}

export interface RealityCheck {
  code: string;
  severity: Severity;
  title: string;
  message: string;
}

export interface SimResult {
  kind: 'project' | 'from_trades';
  simulated: true;
  inputHash: string;
  cache: 'hit' | 'miss';
  seed: number;
  paths: number;
  tradesPerPath: number;
  periods: number;
  startingCapital: number;
  ruinFloor: number;
  bands: {
    p5: number[];
    p25: number[];
    p50: number[];
    p75: number[];
    p95: number[];
    mean: number[];
  };
  samplePaths: number[][];
  finalEquity: {
    p5: number;
    p25: number;
    p50: number;
    p75: number;
    p95: number;
    mean: number;
    histogram: Histogram;
  };
  probEndBelowStart: number;
  riskOfRuin: number;
  riskOfRuinApprox: number | null;
  maxDrawdown: { median: number; p95: number; histogram: Histogram };
  timeUnderWater: { median: number; p95: number };
  longestLosingStreak: { median: number; p95: number };
  expectancyR: number;
  expectancyGrossR: number;
  expectancyUnit: 'r' | 'pct';
  kelly: { full: number; userFraction: number; ratio: number | null };
  effective: {
    winRatePct: number;
    avgWinR: number;
    avgLossR: number;
    costPerTradeR: number;
    riskFraction: number | null;
    blockSize: number | null;
  };
  realityChecks: RealityCheck[];
  elapsedMs: number;
  disclaimer: string;
  auditEventId?: string;
}

export interface PaperAnalytics {
  simulatedSource: boolean;
  startingCapital: string;
  endingEquity: string;
  netPnl: string;
  equityCurve: { ts: string; equity: string; drawdownPct: number }[];
  maxDrawdownPct: number;
  currentDrawdownPct: number;
  trades: number;
  wins: number;
  losses: number;
  winRatePct: number | null;
  profitFactor: number | null;
  expectancy: string | null;
  expectancyPct: number | null;
  avgWin: string | null;
  avgLoss: string | null;
  totalFees: string;
  totalSlippage: string;
  costDragPct: number;
  costShareOfGrossPct: number | null;
  exposurePct: number | null;
  tradeReturnsPct: number[];
}

export interface PaperSource {
  kind: 'fixture' | 'engine';
  label: string;
  simulated: true;
}

export interface PaperProjection {
  source: PaperSource;
  analytics: PaperAnalytics;
  projection: SimResult;
}

/** B-505: a saved, named scenario (inputs only; results are recomputed, seeded). */
export interface SavedScenario {
  id: string;
  kind: 'practice' | 'pro';
  name: string;
  input: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface PaperProjectRequest {
  tradesPerPeriod: number;
  horizonPeriods: number;
  ruinFloorPct: number;
  seed: number;
  paths: number;
}

/** A run kept for display: what was asked and what came back. */
export interface Scenario {
  label: string;
  origin: 'assumptions' | 'paper' | 'backtest';
  request: ProjectRequest;
  result: SimResult;
}

import type { ChecklistItem, RobotLimits, StrategyDefinition, StrategyIssue } from '@kora/domain';

import type { SimResult } from '../sim/types';

export interface VersionDto {
  id: string;
  strategyId: string;
  version: number;
  contentHash: string;
  shortHash: string;
  definition: StrategyDefinition;
  authorId: string;
  reason: string;
  createdAt: string;
}

export interface StrategySummary {
  id: string;
  name: string;
  latestVersion: number;
  updatedAt: string;
  latest?: VersionDto;
}

export interface StrategyDetail extends StrategySummary {
  versions: VersionDto[];
  trials: number;
}

export interface ValidationResult {
  valid: boolean;
  issues: StrategyIssue[];
  contentHash: string | null;
  shortHash: string | null;
  warmupBars: number | null;
}

/** Metrics for one segment (quant `metrics.py`); floats are SIMULATED estimates. */
export interface Metrics {
  bars: number;
  trades: number;
  cagr: number | null;
  sharpe: number | null;
  sortino: number | null;
  calmar: number | null;
  maxDrawdown: number | null;
  maxDrawdownDays: number | null;
  winRate: number | null;
  profitFactor: number | null;
  expectancyR: number | null;
  expectancyCcy: number | null;
  exposurePct: number | null;
  turnover: number | null;
  costDragPct: number | null;
  netPnl?: number | null;
}

export interface BtTrade {
  symbol: string;
  side: 'long' | 'short';
  qty: string;
  entryTs: number;
  entryPrice: string;
  exitTs: number;
  exitPrice: string;
  reason: string;
  netPnl: number;
  rMultiple: number;
  segment: 'is' | 'oos' | 'wf';
}

export interface BacktestResult {
  runId: string;
  kind: 'backtest';
  versionId: string;
  version: number;
  shortHash: string;
  trialsTotal: number;
  trialsAdded: number;
  oosStart: number;
  metrics: { inSample: Metrics; outOfSample: Metrics; all: Metrics };
  warnings: Array<{ code: string; message: string }>;
  overfitting: { trials: number; dsr: number | null; sr0: number | null };
  equity: { t: number[]; equity: number[]; drawdown: number[] };
  trades: BtTrade[];
  guard: { passed: boolean; checkpoints: number };
  baseCurrency: string;
  symbols: string[];
  timeframe: string;
}

export interface WalkForwardResult {
  runId: string;
  trialsTotal: number;
  kind: 'walk_forward';
  folds: Array<{
    fold: number;
    testStart: number;
    testEnd: number;
    oosSharpe: number | null;
    oosTrades: number;
    params: Record<string, number>;
  }>;
  metrics: Metrics;
  trades: BtTrade[];
}

/** Heatmap cell: scored on the validation segment, never on the out-of-sample holdout (R3-01). */
export interface SensitivityCell {
  x: number;
  y: number;
  validationSharpe?: number | null;
  isSharpe?: number | null;
  validationTrades?: number;
  error?: string;
}

export interface SensitivityResult {
  runId: string;
  trialsTotal: number;
  kind: 'sensitivity';
  x: { param: string; values: number[]; current: number };
  y: { param: string; values: number[]; current: number };
  cells: SensitivityCell[][];
  metric?: 'validation_sharpe';
  note: string;
}

export interface RunSummary {
  id: string;
  strategyId: string;
  versionId: string;
  kind: 'backtest' | 'walk_forward' | 'optimise' | 'sensitivity';
  summary: Record<string, unknown>;
  createdAt: string;
}

export interface RobotSummary {
  id: string;
  name: string;
  strategyId: string;
  strategyName: string;
  versionId: string;
  version: number;
  shortHash: string;
  symbols: string[];
  timeframe: string;
  status: 'draft' | 'running' | 'paused' | 'stopped';
  pauseReason: string | null;
  pnl: string;
  equity: string;
  lastHeartbeatAt: string | null;
  environment: 'PAPER';
}

export interface LimitUse {
  used: string;
  limit: string;
}

export interface RobotDetail extends RobotSummary {
  baseCurrency: string;
  accountHalted: boolean;
  limits: RobotLimits;
  limitsHash: string;
  heartbeatMs: number;
  book: {
    equity: string;
    pnl: string;
    grossExposure: string;
    positions: Array<{ symbol: string; qty: string; avgPrice: string; unrealised: string }>;
  };
  limitsUsage: Record<
    'dailyLoss' | 'weeklyLoss' | 'maxDrawdownPct' | 'ordersPerMinute' | 'grossExposure',
    LimitUse
  >;
  kpis: {
    backtestRunId: string | null;
    inSample: Metrics | null;
    outOfSample: Metrics | null;
    walkForward: Metrics | null;
    live: {
      days: number;
      trackingError30dPct: number | null;
      pnl: string;
      returnPct: string;
      fills: number;
    };
  };
}

export interface ChecklistView {
  robotId: string;
  items: ChecklistItem[];
  complete: boolean;
  liveTradingEnabled: boolean;
  blockedReason: string | null;
  limitsHash: string;
  history: Array<{ id: string; outcome: string; createdAt: string }>;
}

export interface AuditItem {
  id: string;
  ts: string;
  actorType: string;
  actorId: string;
  action: string;
  entity: string;
  entityId: string | null;
  payload: Record<string, unknown>;
}

export type SimProjection = SimResult;

import { z } from 'zod';

import { PARAM_NAME, STRATEGY_TIMEFRAMES, StrategyDefinitionSchema } from './dsl.js';

/** Robot lifecycle (goal 06). LIVE is never reachable while `LIVE_TRADING_ENABLED=false`. */
export const ROBOT_STATUSES = ['draft', 'running', 'paused', 'stopped'] as const;
export type RobotStatus = (typeof ROBOT_STATUSES)[number];
export const ROBOT_MODES = ['PAPER', 'LIVE'] as const;
export type RobotMode = (typeof ROBOT_MODES)[number];

const decimalString = z.string().regex(/^\d{1,15}(\.\d{1,8})?$/, 'Use a positive decimal amount');

/**
 * Per-robot risk limits (goal 06 §7). Loss limits are in the account currency; drawdown in % of the
 * robot's peak equity; gross exposure as a multiple of the robot's equity. SIMULATED defaults (OQ-R7).
 */
export const RobotLimitsSchema = z.strictObject({
  dailyLoss: decimalString,
  weeklyLoss: decimalString,
  maxDrawdownPct: z.number().gt(0).max(50),
  ordersPerMinute: z.number().int().min(1).max(120),
  grossExposure: z.number().gt(0).max(30),
});
export type RobotLimits = z.infer<typeof RobotLimitsSchema>;

/** Prototype defaults (Robots artboard): −2,500 / −6,000 / −10 % / 20 per minute / 3×. */
export const DEFAULT_ROBOT_LIMITS: RobotLimits = {
  dailyLoss: '2500',
  weeklyLoss: '6000',
  maxDrawdownPct: 10,
  ordersPerMinute: 20,
  grossExposure: 3,
};

export const CreateStrategySchema = z.strictObject({
  definition: StrategyDefinitionSchema,
  reason: z.string().trim().min(1).max(300).default('Initial version'),
});
export const CreateVersionSchema = z.strictObject({
  definition: StrategyDefinitionSchema,
  reason: z.string().trim().min(3, 'Say why the strategy changed (at least 3 characters)').max(300),
  /** Optimistic concurrency: the version the edit started from. */
  baseVersionId: z.uuid(),
});

const epochMs = z.number().int().min(0).max(8_640_000_000_000);

export const SplitSchema = z.strictObject({
  /** Start of the out-of-sample period (epoch ms). Default: the last `oosFraction` of the bars. */
  oosStart: epochMs.optional(),
  oosFraction: z.number().gt(0).lt(1).default(0.3),
});

export const BacktestRequestSchema = z.strictObject({
  versionId: z.uuid(),
  /** Override the strategy's instruments (must be registry symbols). */
  symbols: z.array(z.string().min(1).max(32)).min(1).max(10).optional(),
  from: epochMs.optional(),
  to: epochMs.optional(),
  capital: decimalString.default('100000'),
  split: SplitSchema.default({ oosFraction: 0.3 }),
  paramOverrides: z.record(z.string().regex(PARAM_NAME), z.number().finite()).default({}),
  /** Cost-model overrides; every other term comes from the registry (same as the paper engine). */
  spreadTicks: z.number().min(0).max(1000).optional(),
});
export type BacktestRequest = z.infer<typeof BacktestRequestSchema>;

export const WalkForwardRequestSchema = BacktestRequestSchema.extend({
  mode: z.enum(['anchored', 'rolling']).default('anchored'),
  folds: z.number().int().min(2).max(12).default(4),
  /** Share of each fold window used for training (rolling) or the first training window (anchored). */
  trainFraction: z.number().gt(0.2).lt(0.9).default(0.6),
  /** Optional per-fold re-optimisation grid (each fold picks the best in-sample assignment). */
  grid: z
    .record(z.string().regex(PARAM_NAME), z.array(z.number().finite()).min(1).max(12))
    .optional(),
});
export type WalkForwardRequest = z.infer<typeof WalkForwardRequestSchema>;

export const OptimiseRequestSchema = BacktestRequestSchema.extend({
  method: z.enum(['grid', 'random']).default('grid'),
  grid: z.record(z.string().regex(PARAM_NAME), z.array(z.number().finite()).min(1).max(50)),
  samples: z.number().int().min(1).max(1000).default(50),
  seed: z
    .number()
    .int()
    .min(0)
    .max(2 ** 31 - 1)
    .default(1),
  maxCombos: z.number().int().min(1).max(1000).optional(),
  /**
   * Share of the pre-holdout bars that ranks the combinations (IRTC R3-01). The out-of-sample
   * holdout is never read while ranking; it is scored once, for the selected combination.
   */
  validationFraction: z.number().min(0.1).max(0.5).default(0.3),
});
export type OptimiseRequest = z.infer<typeof OptimiseRequestSchema>;

export const SensitivityRequestSchema = BacktestRequestSchema.extend({
  x: z.strictObject({
    param: z.string().regex(PARAM_NAME),
    values: z.array(z.number().finite()).min(2).max(12),
  }),
  y: z.strictObject({
    param: z.string().regex(PARAM_NAME),
    values: z.array(z.number().finite()).min(2).max(12),
  }),
  /** Cells are scored on the validation segment, never on the out-of-sample holdout (R3-01). */
  validationFraction: z.number().min(0.1).max(0.5).default(0.3),
});
export type SensitivityRequest = z.infer<typeof SensitivityRequestSchema>;

export const CreateRobotSchema = z.strictObject({
  name: z.string().trim().min(1).max(60),
  versionId: z.uuid(),
  allocation: decimalString.default('100000'),
  limits: RobotLimitsSchema.default(DEFAULT_ROBOT_LIMITS),
});
export const RobotReasonSchema = z.strictObject({ reason: z.string().trim().min(1).max(300) });
export const RobotVersionSwitchSchema = z.strictObject({
  versionId: z.uuid(),
  reason: z.string().trim().min(3).max(300),
});
export const RobotLimitsUpdateSchema = z.strictObject({
  limits: RobotLimitsSchema,
  reason: z.string().trim().min(3).max(300),
});
export const RiskSignoffSchema = z.strictObject({
  limitsHash: z.string().regex(/^[0-9a-f]{64}$/),
  note: z.string().trim().min(3).max(500),
});
export const PromoteSchema = z.strictObject({
  totpCode: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code from your authenticator app'),
});

/** Tri-state condition result (warm-up, missing data, AI regime before goal 07). */
export type ConditionResult = true | false | 'not_available';

/** One evaluated condition of a signal (stored for explainability, goal 07 `get_signal_features`). */
export interface SignalCondition {
  block: 'entry' | 'filter' | 'exit';
  index: number;
  type: string;
  label: string;
  result: ConditionResult;
  /** Operand values at the decision bar (null while warming up). */
  values: Record<string, number | null>;
  /** Normalised margin of the condition from its threshold, signed (+ supports the action). */
  contribution: number | null;
}

export type SignalAction = 'enter_long' | 'enter_short' | 'exit' | 'hold' | 'blocked';

export const TIMEFRAMES_FOR_ROBOTS = STRATEGY_TIMEFRAMES;

/** Promotion checklist item (goal 06 §9). */
export interface ChecklistItem {
  id: 'oos_sharpe' | 'oos_trades' | 'paper_tracking' | 'risk_signoff';
  label: string;
  pass: boolean;
  evidence: Record<string, string | number | boolean | null>;
}

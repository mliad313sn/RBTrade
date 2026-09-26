import { z } from 'zod';

/**
 * Strategy DSL `kora.strategy` v1 (goal 06). One schema shared by the web builder, the api, the
 * quant backtester (pydantic mirror, see services/quant/src/kora_quant/bt/dsl.py) and the bot runner.
 *
 * - Blocks: ENTRY (side + AND-ed conditions), FILTERS (AND-ed), EXIT (stop, target, trailing, time
 *   stop, exit conditions: any one exits) and SIZE (sizing model + max open positions).
 * - Numbers are plain numbers or named parameter references `{ "param": "fast" }`; parameter values
 *   live in `params`, so optimisation, sensitivity and "edit params" are data changes.
 * - Conditions evaluate to `true`, `false` or `not_available` (warm-up, no calendar data, or the AI
 *   regime filter before goal 07). An unavailable condition never opens a position, except an
 *   `ai_regime` condition with `whenUnavailable: "ignore"` which is skipped (and recorded).
 *
 * Saved versions are immutable and identified by a content hash (see `strategyContentHash`).
 */

export const STRATEGY_SCHEMA_ID = 'kora.strategy';
export const STRATEGY_SCHEMA_VERSION = 1;

export const STRATEGY_TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1D'] as const;
export type StrategyTimeframe = (typeof STRATEGY_TIMEFRAMES)[number];

export const PARAM_NAME = /^[a-z][a-z0-9_]{0,31}$/;
export const MAX_PERIOD = 500;

export const ParamRefSchema = z.strictObject({
  param: z.string().regex(PARAM_NAME, 'Parameter names use lowercase letters, digits and _'),
});
export type ParamRef = z.infer<typeof ParamRefSchema>;

/** A number or a named parameter reference. */
export const NumSchema = z.union([z.number().finite(), ParamRefSchema]);
export type Num = z.infer<typeof NumSchema>;

export const INDICATORS = [
  'close',
  'open',
  'high',
  'low',
  'volume',
  'ema',
  'sma',
  'rsi',
  'atr',
  'adx',
  'roc',
  'highest',
  'lowest',
  'realised_vol',
] as const;
export type IndicatorName = (typeof INDICATORS)[number];

/** Indicators that need a look-back period. */
export const PERIODIC_INDICATORS: readonly IndicatorName[] = [
  'ema',
  'sma',
  'rsi',
  'atr',
  'adx',
  'roc',
  'highest',
  'lowest',
  'realised_vol',
];

export const INDICATOR_LABELS: Record<IndicatorName, string> = {
  close: 'Close',
  open: 'Open',
  high: 'High',
  low: 'Low',
  volume: 'Volume',
  ema: 'EMA',
  sma: 'SMA',
  rsi: 'RSI',
  atr: 'ATR',
  adx: 'ADX',
  roc: 'ROC %',
  highest: 'Highest high',
  lowest: 'Lowest low',
  realised_vol: 'Realised vol %',
};

export const OperandSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('indicator'),
    name: z.enum(INDICATORS),
    period: NumSchema.optional(),
  }),
  z.strictObject({ kind: z.literal('const'), value: NumSchema }),
]);
export type Operand = z.infer<typeof OperandSchema>;

export const COMPARE_OPS = ['gt', 'gte', 'lt', 'lte'] as const;
export type CompareOp = (typeof COMPARE_OPS)[number];
export const COMPARE_OP_SYMBOL: Record<CompareOp, string> = {
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
};

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24 h)');
const id = z
  .string()
  .regex(/^[a-z0-9-]{1,40}$/)
  .optional();

export const AI_REGIMES = ['trending', 'ranging', 'volatile'] as const;

export const ConditionSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('compare'),
    id,
    left: OperandSchema,
    op: z.enum(COMPARE_OPS),
    right: OperandSchema,
  }),
  z.strictObject({
    type: z.literal('cross'),
    id,
    left: OperandSchema,
    direction: z.enum(['above', 'below']),
    right: OperandSchema,
  }),
  z.strictObject({
    type: z.literal('session_window'),
    id,
    label: z.string().max(40).optional(),
    timezone: z.string().min(1).max(64),
    start: HHMM,
    end: HHMM,
    /** ISO weekdays 1 (Mon) … 7 (Sun); empty or absent = every day. */
    days: z.array(z.number().int().min(1).max(7)).max(7).optional(),
  }),
  z.strictObject({ type: z.literal('venue_open'), id }),
  z.strictObject({
    type: z.literal('no_event'),
    id,
    withinMinutes: NumSchema,
    impact: z.literal('high').default('high'),
  }),
  z.strictObject({
    type: z.literal('ai_regime'),
    id,
    regime: z.enum(AI_REGIMES),
    minProbability: NumSchema,
    /** Until goal 07 the regime model is not available: `ignore` skips the filter, `block` blocks entries. */
    whenUnavailable: z.enum(['ignore', 'block']).default('ignore'),
  }),
]);
export type Condition = z.infer<typeof ConditionSchema>;
export type ConditionType = Condition['type'];

export const StopSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('atr'), multiple: NumSchema, period: NumSchema }),
  z.strictObject({ kind: z.literal('percent'), pct: NumSchema }),
]);
export const TargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('atr'), multiple: NumSchema, period: NumSchema }),
  z.strictObject({ kind: z.literal('r'), multiple: NumSchema }),
  z.strictObject({ kind: z.literal('percent'), pct: NumSchema }),
]);
export const TrailingSchema = z.strictObject({
  /** Start trailing once the trade is this many R in profit (by the bar's favourable extreme). */
  afterR: NumSchema,
  kind: z.literal('atr'),
  multiple: NumSchema,
  period: NumSchema,
});

export const ExitSchema = z.strictObject({
  stop: StopSchema,
  target: TargetSchema.optional(),
  trailing: TrailingSchema.optional(),
  timeStopBars: NumSchema.optional(),
  /** Exit at the next open when any of these is true. */
  conditions: z.array(ConditionSchema).max(8).default([]),
});
export type ExitBlock = z.infer<typeof ExitSchema>;

export const SizeSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('risk_pct'),
    pct: NumSchema,
    maxOpenPositions: z.number().int().min(1).max(20),
  }),
  z.strictObject({
    kind: z.literal('fixed'),
    /** Quantity in instrument units (decimal string, snapped to the registry qty grid). */
    qty: z.string().regex(/^\d+(\.\d+)?$/, 'Quantity must be a positive decimal'),
    maxOpenPositions: z.number().int().min(1).max(20),
  }),
  z.strictObject({
    kind: z.literal('vol_target'),
    annualVolPct: NumSchema,
    lookback: NumSchema,
    maxOpenPositions: z.number().int().min(1).max(20),
  }),
]);
export type SizeBlock = z.infer<typeof SizeSchema>;

export const ParamSpecSchema = z
  .strictObject({
    value: z.number().finite(),
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
    step: z.number().finite().positive().optional(),
    integer: z.boolean().default(false),
    label: z.string().max(40).optional(),
  })
  .superRefine((p, ctx) => {
    if (p.min !== undefined && p.max !== undefined && p.min > p.max)
      ctx.addIssue({ code: 'custom', message: 'min must not exceed max', path: ['min'] });
    if (p.integer && !Number.isInteger(p.value))
      ctx.addIssue({
        code: 'custom',
        message: 'This parameter must be a whole number',
        path: ['value'],
      });
  });
export type ParamSpec = z.infer<typeof ParamSpecSchema>;

export const StrategyDefinitionSchema = z.strictObject({
  schema: z.literal(STRATEGY_SCHEMA_ID),
  schemaVersion: z.literal(STRATEGY_SCHEMA_VERSION),
  name: z.string().trim().min(1, 'Give the strategy a name').max(60),
  description: z.string().max(500).optional(),
  universe: z.strictObject({
    symbols: z
      .array(z.string().regex(/^[A-Z0-9][A-Z0-9._/-]{0,31}$/, 'Unknown symbol format'))
      .min(1, 'Pick at least one instrument')
      .max(10, 'At most 10 instruments per strategy'),
    timeframe: z.enum(STRATEGY_TIMEFRAMES),
  }),
  params: z.record(z.string().regex(PARAM_NAME), ParamSpecSchema).default({}),
  entry: z.strictObject({
    side: z.enum(['long', 'short']),
    conditions: z.array(ConditionSchema).min(1, 'Add at least one entry condition').max(8),
  }),
  filters: z.array(ConditionSchema).max(8).default([]),
  exit: ExitSchema,
  size: SizeSchema,
});
export type StrategyDefinition = z.infer<typeof StrategyDefinitionSchema>;
export type StrategyDefinitionInput = z.input<typeof StrategyDefinitionSchema>;

// ---- Parameter resolution and semantic validation ------------------------------------------------

export interface StrategyIssue {
  path: string;
  message: string;
  severity: 'error' | 'warning';
}

export function isParamRef(v: unknown): v is ParamRef {
  return typeof v === 'object' && v !== null && 'param' in v;
}

/** Resolves a number or parameter reference against the params (with optional overrides). */
export function resolveNum(
  v: Num,
  params: Record<string, ParamSpec>,
  overrides: Record<string, number> = {},
): number {
  if (typeof v === 'number') return v;
  const o = overrides[v.param];
  if (o !== undefined) return o;
  const p = params[v.param];
  if (!p) throw new Error(`Unknown parameter "${v.param}"`);
  return p.value;
}

/** Walks every Num in the definition with its JSON path. */
export function forEachNum(
  def: StrategyDefinition,
  fn: (v: Num, path: string, role: 'period' | 'value') => void,
): void {
  const operand = (o: Operand, path: string) => {
    if (o.kind === 'const') fn(o.value, `${path}.value`, 'value');
    else if (o.period !== undefined) fn(o.period, `${path}.period`, 'period');
  };
  const conds = (cs: readonly Condition[], base: string) =>
    cs.forEach((c, i) => {
      const p = `${base}.${i}`;
      if (c.type === 'compare' || c.type === 'cross') {
        operand(c.left, `${p}.left`);
        operand(c.right, `${p}.right`);
      } else if (c.type === 'no_event') fn(c.withinMinutes, `${p}.withinMinutes`, 'value');
      else if (c.type === 'ai_regime') fn(c.minProbability, `${p}.minProbability`, 'value');
    });
  conds(def.entry.conditions, 'entry.conditions');
  conds(def.filters, 'filters');
  conds(def.exit.conditions, 'exit.conditions');
  const s = def.exit.stop;
  if (s.kind === 'atr') {
    fn(s.multiple, 'exit.stop.multiple', 'value');
    fn(s.period, 'exit.stop.period', 'period');
  } else fn(s.pct, 'exit.stop.pct', 'value');
  const t = def.exit.target;
  if (t?.kind === 'atr') {
    fn(t.multiple, 'exit.target.multiple', 'value');
    fn(t.period, 'exit.target.period', 'period');
  } else if (t?.kind === 'r') fn(t.multiple, 'exit.target.multiple', 'value');
  else if (t?.kind === 'percent') fn(t.pct, 'exit.target.pct', 'value');
  const tr = def.exit.trailing;
  if (tr) {
    fn(tr.afterR, 'exit.trailing.afterR', 'value');
    fn(tr.multiple, 'exit.trailing.multiple', 'value');
    fn(tr.period, 'exit.trailing.period', 'period');
  }
  if (def.exit.timeStopBars !== undefined) fn(def.exit.timeStopBars, 'exit.timeStopBars', 'period');
  const z0 = def.size;
  if (z0.kind === 'risk_pct') fn(z0.pct, 'size.pct', 'value');
  else if (z0.kind === 'vol_target') {
    fn(z0.annualVolPct, 'size.annualVolPct', 'value');
    fn(z0.lookback, 'size.lookback', 'period');
  }
}

function sameOperand(a: Operand, b: Operand): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Semantic checks beyond the schema: parameter references, ranges, periods, obviously broken
 * conditions. Errors block saving and backtesting; warnings are shown in the validation panel.
 */
export function validateStrategySemantics(
  def: StrategyDefinition,
  overrides: Record<string, number> = {},
): StrategyIssue[] {
  const issues: StrategyIssue[] = [];
  const used = new Set<string>();
  for (const [name, p] of Object.entries(def.params)) {
    const v = overrides[name] ?? p.value;
    if (p.min !== undefined && v < p.min)
      issues.push({
        path: `params.${name}`,
        message: `${name} = ${v} is below its minimum ${p.min}.`,
        severity: 'error',
      });
    if (p.max !== undefined && v > p.max)
      issues.push({
        path: `params.${name}`,
        message: `${name} = ${v} is above its maximum ${p.max}.`,
        severity: 'error',
      });
  }
  forEachNum(def, (v, path, role) => {
    if (isParamRef(v)) {
      used.add(v.param);
      if (!def.params[v.param]) {
        issues.push({
          path,
          message: `Unknown parameter "${v.param}". Add it under params.`,
          severity: 'error',
        });
        return;
      }
    }
    const n = resolveNum(v, def.params, overrides);
    if (role === 'period' && (!Number.isInteger(n) || n < 1 || n > MAX_PERIOD))
      issues.push({
        path,
        message: `Periods must be whole numbers from 1 to ${MAX_PERIOD} (got ${n}).`,
        severity: 'error',
      });
  });
  const pos = (path: string, v: Num | undefined, label: string, max?: number) => {
    if (v === undefined) return;
    if (isParamRef(v) && !def.params[v.param]) return;
    const n = resolveNum(v, def.params, overrides);
    if (!(n > 0)) issues.push({ path, message: `${label} must be above zero.`, severity: 'error' });
    else if (max !== undefined && n > max)
      issues.push({ path, message: `${label} above ${max} is refused.`, severity: 'error' });
  };
  const s = def.exit.stop;
  if (s.kind === 'atr') pos('exit.stop.multiple', s.multiple, 'The ATR stop multiple', 20);
  else pos('exit.stop.pct', s.pct, 'The stop percentage', 50);
  const t = def.exit.target;
  if (t?.kind === 'atr' || t?.kind === 'r')
    pos('exit.target.multiple', t.multiple, 'The target multiple', 50);
  if (t?.kind === 'percent') pos('exit.target.pct', t.pct, 'The target percentage', 500);
  if (def.exit.trailing) {
    pos('exit.trailing.afterR', def.exit.trailing.afterR, 'Trail after R', 50);
    pos('exit.trailing.multiple', def.exit.trailing.multiple, 'The trailing ATR multiple', 20);
  }
  if (def.size.kind === 'risk_pct')
    pos('size.pct', def.size.pct, 'Risk per trade (% of equity)', 5);
  if (def.size.kind === 'vol_target')
    pos('size.annualVolPct', def.size.annualVolPct, 'Target volatility', 100);
  if (def.size.kind === 'fixed' && !(Number(def.size.qty) > 0))
    issues.push({
      path: 'size.qty',
      message: 'The fixed quantity must be above zero.',
      severity: 'error',
    });

  const checkConds = (cs: readonly Condition[], base: string) =>
    cs.forEach((c, i) => {
      const p = `${base}.${i}`;
      if ((c.type === 'compare' || c.type === 'cross') && sameOperand(c.left, c.right))
        issues.push({
          path: p,
          message: 'Both sides of this condition are the same, so it can never change.',
          severity: 'error',
        });
      if (
        (c.type === 'compare' || c.type === 'cross') &&
        c.left.kind === 'const' &&
        c.right.kind === 'const'
      )
        issues.push({
          path: p,
          message: 'Compare an indicator with something: two constants never change.',
          severity: 'error',
        });
      for (const side of ['left', 'right'] as const) {
        if (c.type !== 'compare' && c.type !== 'cross') continue;
        const o = c[side];
        if (
          o.kind === 'indicator' &&
          PERIODIC_INDICATORS.includes(o.name) &&
          o.period === undefined
        )
          issues.push({
            path: `${p}.${side}.period`,
            message: `${INDICATOR_LABELS[o.name]} needs a period.`,
            severity: 'error',
          });
      }
      if (c.type === 'ai_regime') {
        const n =
          isParamRef(c.minProbability) && !def.params[c.minProbability.param]
            ? 0.5
            : resolveNum(c.minProbability, def.params, overrides);
        if (n <= 0 || n >= 1)
          issues.push({
            path: `${p}.minProbability`,
            message: 'The regime probability must be between 0 and 1.',
            severity: 'error',
          });
        issues.push({
          path: p,
          message:
            c.whenUnavailable === 'block'
              ? 'The AI regime filter arrives with goal 07. Until then it is "not available" and blocks every entry.'
              : 'The AI regime filter arrives with goal 07. Until then it is "not available" and is skipped (recorded on each signal).',
          severity: 'warning',
        });
      }
      if (c.type === 'session_window' && !isValidTimeZone(c.timezone))
        issues.push({
          path: `${p}.timezone`,
          message: `Unknown time zone "${c.timezone}".`,
          severity: 'error',
        });
    });
  checkConds(def.entry.conditions, 'entry.conditions');
  checkConds(def.filters, 'filters');
  checkConds(def.exit.conditions, 'exit.conditions');
  for (const name of Object.keys(def.params))
    if (!used.has(name))
      issues.push({
        path: `params.${name}`,
        message: `Parameter "${name}" is not used by any block.`,
        severity: 'warning',
      });
  if (
    !def.exit.target &&
    !def.exit.trailing &&
    !def.exit.conditions.length &&
    def.exit.timeStopBars === undefined
  )
    issues.push({
      path: 'exit',
      message:
        'Only the stop can close a trade. Add a target, trailing stop, time stop or exit condition.',
      severity: 'warning',
    });
  return issues;
}

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export interface StrategyValidation {
  valid: boolean;
  definition: StrategyDefinition | null;
  issues: StrategyIssue[];
}

/** Schema + semantic validation with plain-language issues (the builder's validation panel). */
export function validateStrategy(
  input: unknown,
  overrides: Record<string, number> = {},
): StrategyValidation {
  const parsed = StrategyDefinitionSchema.safeParse(input);
  if (!parsed.success) {
    return {
      valid: false,
      definition: null,
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
        severity: 'error' as const,
      })),
    };
  }
  const issues = validateStrategySemantics(parsed.data, overrides);
  return { valid: !issues.some((i) => i.severity === 'error'), definition: parsed.data, issues };
}

/** Bars needed before the first reliable signal (EMA/ADX warm-up ≈ 3 × the longest period). */
export function warmupBars(
  def: StrategyDefinition,
  overrides: Record<string, number> = {},
): number {
  let longest = 2;
  forEachNum(def, (v, _path, role) => {
    if (role !== 'period') return;
    try {
      longest = Math.max(longest, resolveNum(v, def.params, overrides));
    } catch {
      /* unknown param: reported by validation */
    }
  });
  return Math.min(3 * longest + 2, 3 * MAX_PERIOD + 2);
}

/** Parameter changes between two definitions (for version reasons and the audit payload). */
export function paramsDiff(
  prev: StrategyDefinition | null,
  next: StrategyDefinition,
): Array<{ name: string; from: number | null; to: number | null }> {
  const out: Array<{ name: string; from: number | null; to: number | null }> = [];
  const names = new Set([...Object.keys(prev?.params ?? {}), ...Object.keys(next.params)]);
  for (const n of [...names].sort()) {
    const a = prev?.params[n]?.value ?? null;
    const b = next.params[n]?.value ?? null;
    if (a !== b) out.push({ name: n, from: a, to: b });
  }
  return out;
}

/** Applies parameter values (e.g. an optimisation result) and returns a new definition. */
export function withParams(
  def: StrategyDefinition,
  values: Record<string, number>,
): StrategyDefinition {
  const params: Record<string, ParamSpec> = {};
  for (const [k, p] of Object.entries(def.params))
    params[k] = values[k] === undefined ? p : { ...p, value: values[k] };
  return { ...def, params };
}

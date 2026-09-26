import {
  COMPARE_OP_SYMBOL,
  INDICATOR_LABELS,
  isParamRef,
  type Condition,
  type Num,
  type Operand,
  type ParamSpec,
  type StrategyDefinition,
  type StrategyTimeframe,
} from './dsl.js';

/**
 * Builder block catalog (the prototype's chips). Each block knows which section it goes into, the
 * parameters it introduces (named, so they can be optimised later) and how to build its DSL piece.
 * The pure `addBlock` / `removeBlock` helpers keep the web builder thin and unit-tested.
 */
export type BlockSection =
  | 'entry'
  | 'filter'
  | 'exit_condition'
  | 'stop'
  | 'target'
  | 'trailing'
  | 'time_stop'
  | 'size';
export const CONDITION_SECTIONS: readonly BlockSection[] = ['entry', 'filter', 'exit_condition'];

export interface BlockCatalogEntry {
  id: string;
  label: string;
  description: string;
  /** Sections the block may be dropped into. */
  sections: readonly BlockSection[];
  /** Parameters the block introduces (base names; made unique when added). */
  params: Record<string, ParamSpec>;
  /** Builds the piece; `p(name)` returns the reference to the (possibly renamed) parameter. */
  build: (p: (name: string) => Num) => unknown;
}

const ind = (name: Extract<Operand, { kind: 'indicator' }>['name'], period?: Num): Operand =>
  period === undefined ? { kind: 'indicator', name } : { kind: 'indicator', name, period };
const int = (value: number, min: number, max: number, step: number, label: string): ParamSpec => ({
  value,
  min,
  max,
  step,
  integer: true,
  label,
});
const real = (value: number, min: number, max: number, step: number, label: string): ParamSpec => ({
  value,
  min,
  max,
  step,
  integer: false,
  label,
});

const COND: readonly BlockSection[] = CONDITION_SECTIONS;

export const BLOCK_CATALOG: readonly BlockCatalogEntry[] = [
  {
    id: 'ema_cross_up',
    label: 'EMA crosses above EMA',
    description: 'The fast exponential average crosses above the slow one on a closed bar.',
    sections: COND,
    params: { fast: int(20, 5, 60, 5, 'Fast EMA'), slow: int(50, 20, 200, 10, 'Slow EMA') },
    build: (p): Condition => ({
      type: 'cross',
      left: ind('ema', p('fast')),
      direction: 'above',
      right: ind('ema', p('slow')),
    }),
  },
  {
    id: 'ema_cross_down',
    label: 'EMA crosses below EMA',
    description: 'The fast exponential average crosses below the slow one on a closed bar.',
    sections: COND,
    params: { fast: int(20, 5, 60, 5, 'Fast EMA'), slow: int(50, 20, 200, 10, 'Slow EMA') },
    build: (p): Condition => ({
      type: 'cross',
      left: ind('ema', p('fast')),
      direction: 'below',
      right: ind('ema', p('slow')),
    }),
  },
  {
    id: 'adx_above',
    label: 'ADX above',
    description: 'Trend strength (ADX 14) is above a threshold.',
    sections: COND,
    params: { adx_min: real(22, 10, 40, 2, 'ADX threshold') },
    build: (p): Condition => ({
      type: 'compare',
      left: ind('adx', 14),
      op: 'gt',
      right: { kind: 'const', value: p('adx_min') },
    }),
  },
  {
    id: 'rsi_below',
    label: 'RSI below',
    description: 'Momentum (RSI 14) is below a level (oversold).',
    sections: COND,
    params: { rsi_low: real(30, 5, 50, 5, 'RSI level') },
    build: (p): Condition => ({
      type: 'compare',
      left: ind('rsi', 14),
      op: 'lt',
      right: { kind: 'const', value: p('rsi_low') },
    }),
  },
  {
    id: 'rsi_above',
    label: 'RSI above',
    description: 'Momentum (RSI 14) is above a level.',
    sections: COND,
    params: { rsi_high: real(55, 50, 95, 5, 'RSI level') },
    build: (p): Condition => ({
      type: 'compare',
      left: ind('rsi', 14),
      op: 'gt',
      right: { kind: 'const', value: p('rsi_high') },
    }),
  },
  {
    id: 'close_above_ema',
    label: 'Close above EMA',
    description: 'The bar closes above its exponential average.',
    sections: COND,
    params: { trend_len: int(100, 10, 300, 10, 'Trend EMA') },
    build: (p): Condition => ({
      type: 'compare',
      left: ind('close'),
      op: 'gt',
      right: ind('ema', p('trend_len')),
    }),
  },
  {
    id: 'breakout_high',
    label: 'Breakout above prior high',
    description: 'The close is above the highest high of the previous N bars.',
    sections: COND,
    params: { lookback: int(20, 5, 100, 5, 'Breakout bars') },
    build: (p): Condition => ({
      type: 'compare',
      left: ind('close'),
      op: 'gt',
      right: ind('highest', p('lookback')),
    }),
  },
  {
    id: 'breakdown_low',
    label: 'Breakdown below prior low',
    description: 'The close is below the lowest low of the previous N bars.',
    sections: COND,
    params: { lookback: int(20, 5, 100, 5, 'Breakdown bars') },
    build: (p): Condition => ({
      type: 'compare',
      left: ind('close'),
      op: 'lt',
      right: ind('lowest', p('lookback')),
    }),
  },
  {
    id: 'session_window',
    label: 'Session window',
    description: 'Only between two local times in a time zone (e.g. London + New York hours).',
    sections: COND,
    params: {},
    build: (): Condition => ({
      type: 'session_window',
      label: 'London + NY',
      timezone: 'Europe/London',
      start: '07:00',
      end: '21:00',
    }),
  },
  {
    id: 'venue_open',
    label: 'Venue open',
    description: "Only while the instrument's venue is in session (registry calendar).",
    sections: COND,
    params: {},
    build: (): Condition => ({ type: 'venue_open' }),
  },
  {
    id: 'no_event',
    label: 'No high-impact event',
    description: 'No high-impact economic event within N minutes (SIMULATED calendar).',
    sections: ['filter', 'entry'],
    params: { event_min: int(60, 5, 240, 5, 'Event window (min)') },
    build: (p): Condition => ({ type: 'no_event', withinMinutes: p('event_min'), impact: 'high' }),
  },
  {
    id: 'ai_regime',
    label: 'AI regime',
    description: 'Market regime from the AI model (goal 07). Until then it reads "not available".',
    sections: ['entry', 'filter'],
    params: {},
    build: (): Condition => ({
      type: 'ai_regime',
      regime: 'trending',
      minProbability: 0.6,
      whenUnavailable: 'ignore',
    }),
  },
  {
    id: 'stop_atr',
    label: 'Stop × ATR',
    description: 'Protective stop a multiple of ATR (14) away from the entry.',
    sections: ['stop'],
    params: { stop_atr: real(1.5, 0.5, 4, 0.25, 'Stop × ATR') },
    build: (p) => ({ kind: 'atr', multiple: p('stop_atr'), period: 14 }),
  },
  {
    id: 'stop_pct',
    label: 'Stop %',
    description: 'Protective stop a percentage away from the entry.',
    sections: ['stop'],
    params: { stop_pct: real(2, 0.25, 10, 0.25, 'Stop %') },
    build: (p) => ({ kind: 'percent', pct: p('stop_pct') }),
  },
  {
    id: 'target_atr',
    label: 'Target × ATR',
    description: 'Take profit a multiple of ATR (14) away from the entry.',
    sections: ['target'],
    params: { target_atr: real(3, 1, 8, 0.5, 'Target × ATR') },
    build: (p) => ({ kind: 'atr', multiple: p('target_atr'), period: 14 }),
  },
  {
    id: 'target_r',
    label: 'Target in R',
    description: 'Take profit at a multiple of the initial risk.',
    sections: ['target'],
    params: { target_r: real(2, 0.5, 10, 0.5, 'Target (R)') },
    build: (p) => ({ kind: 'r', multiple: p('target_r') }),
  },
  {
    id: 'trail_after_r',
    label: 'Trail after R',
    description: 'Once the trade is this many R in profit, trail the stop at a multiple of ATR.',
    sections: ['trailing'],
    params: {
      trail_r: real(1, 0.5, 3, 0.5, 'Trail after R'),
      trail_atr: real(1.5, 0.5, 4, 0.25, 'Trail × ATR'),
    },
    build: (p) => ({ afterR: p('trail_r'), kind: 'atr', multiple: p('trail_atr'), period: 14 }),
  },
  {
    id: 'time_stop',
    label: 'Time stop',
    description: 'Exit after N bars in the trade.',
    sections: ['time_stop'],
    params: { max_bars: int(48, 2, 500, 2, 'Max bars') },
    build: (p) => p('max_bars'),
  },
  {
    id: 'risk_pct',
    label: 'Risk % equity',
    description: 'Size each trade so the stop loses this % of equity; max open positions.',
    sections: ['size'],
    params: { risk_pct: real(0.75, 0.1, 2, 0.05, 'Risk % equity') },
    build: (p) => ({ kind: 'risk_pct', pct: p('risk_pct'), maxOpenPositions: 3 }),
  },
  {
    id: 'fixed_qty',
    label: 'Fixed size',
    description: 'The same quantity on every trade.',
    sections: ['size'],
    params: {},
    build: () => ({ kind: 'fixed', qty: '1', maxOpenPositions: 1 }),
  },
  {
    id: 'vol_target',
    label: 'Volatility target',
    description: 'Size so each position runs at a target annualised volatility.',
    sections: ['size'],
    params: { target_vol: real(20, 5, 60, 5, 'Target vol %') },
    build: (p) => ({
      kind: 'vol_target',
      annualVolPct: p('target_vol'),
      lookback: 30,
      maxOpenPositions: 2,
    }),
  },
];

export function catalogEntry(id: string): BlockCatalogEntry {
  const e = BLOCK_CATALOG.find((b) => b.id === id);
  if (!e) throw new Error(`Unknown block ${id}`);
  return e;
}

/** A starting point for the builder: ATR stop and % risk sizing, no entry yet (invalid until one is added). */
export function blankStrategy(
  name = 'New strategy',
  symbols: string[] = ['BTCUSD'],
  timeframe: StrategyTimeframe = '1h',
): StrategyDefinition {
  return {
    schema: 'kora.strategy',
    schemaVersion: 1,
    name,
    universe: { symbols, timeframe },
    params: {
      stop_atr: real(1.5, 0.5, 4, 0.25, 'Stop × ATR'),
      risk_pct: real(0.5, 0.1, 2, 0.05, 'Risk % equity'),
    },
    entry: { side: 'long', conditions: [] },
    filters: [],
    exit: { stop: { kind: 'atr', multiple: { param: 'stop_atr' }, period: 14 }, conditions: [] },
    size: { kind: 'risk_pct', pct: { param: 'risk_pct' }, maxOpenPositions: 1 },
  };
}

function uniqueName(base: string, taken: Record<string, unknown>): string {
  if (!(base in taken)) return base;
  for (let i = 2; ; i++) if (!(`${base}_${i}` in taken)) return `${base}_${i}`;
}

/** Adds a catalog block to a section; condition blocks append, the others replace. */
export function addBlock(
  def: StrategyDefinition,
  blockId: string,
  section: BlockSection,
): StrategyDefinition {
  const entry = catalogEntry(blockId);
  if (!entry.sections.includes(section))
    throw new Error(`${entry.label} cannot go into ${section}`);
  // A replaced block's parameters are released first, so its names can be reused.
  const released: Record<BlockSection, unknown> = {
    entry: null,
    filter: null,
    exit_condition: null,
    stop: 'stop',
    target: 'target',
    trailing: 'trailing',
    time_stop: 'timeStopBars',
    size: null,
  };
  const key = released[section] as keyof StrategyDefinition['exit'] | null;
  const strip = key
    ? { ...def, exit: { ...def.exit, [key]: undefined } }
    : section === 'size'
      ? { ...def, size: { ...def.size, pct: 0, annualVolPct: 0, lookback: 0 } as never }
      : def;
  const keep = pruneParams(strip as StrategyDefinition).params;
  const params = { ...keep };
  const rename: Record<string, string> = {};
  for (const [name, spec] of Object.entries(entry.params)) {
    const n = uniqueName(name, params);
    rename[name] = n;
    params[n] = spec;
  }
  const piece = entry.build((n) => ({ param: rename[n] ?? n })) as never;
  const next: StrategyDefinition = {
    ...def,
    params,
    entry: { ...def.entry },
    exit: { ...def.exit },
    filters: [...def.filters],
  };
  switch (section) {
    case 'entry':
      next.entry.conditions = [...def.entry.conditions, piece];
      break;
    case 'filter':
      next.filters = [...def.filters, piece];
      break;
    case 'exit_condition':
      next.exit.conditions = [...def.exit.conditions, piece];
      break;
    case 'stop':
      next.exit.stop = piece;
      break;
    case 'target':
      next.exit.target = piece;
      break;
    case 'trailing':
      next.exit.trailing = piece;
      break;
    case 'time_stop':
      next.exit.timeStopBars = piece;
      break;
    case 'size':
      next.size = {
        ...(piece as StrategyDefinition['size']),
        maxOpenPositions: def.size.maxOpenPositions,
      };
      break;
  }
  return pruneParams(next);
}

/** Removes a condition (by section + index) or an optional exit block. The stop and size cannot be removed. */
export function removeBlock(
  def: StrategyDefinition,
  section: BlockSection,
  index = 0,
): StrategyDefinition {
  const next: StrategyDefinition = {
    ...def,
    entry: { ...def.entry },
    exit: { ...def.exit },
    filters: [...def.filters],
  };
  if (section === 'entry')
    next.entry.conditions = def.entry.conditions.filter((_, i) => i !== index);
  else if (section === 'filter') next.filters = def.filters.filter((_, i) => i !== index);
  else if (section === 'exit_condition')
    next.exit.conditions = def.exit.conditions.filter((_, i) => i !== index);
  else if (section === 'target') delete next.exit.target;
  else if (section === 'trailing') delete next.exit.trailing;
  else if (section === 'time_stop') delete next.exit.timeStopBars;
  else throw new Error('The stop and the sizing block can be replaced but not removed');
  return pruneParams(next);
}

/** Drops parameters no block references any more. */
export function pruneParams(def: StrategyDefinition): StrategyDefinition {
  const json = JSON.stringify({ ...def, params: undefined });
  const params: Record<string, ParamSpec> = {};
  for (const [k, v] of Object.entries(def.params))
    if (json.includes(`"param":"${k}"`)) params[k] = v;
  return { ...def, params };
}

// ---- Human-readable labels (chips, audit, explanations) ---------------------------------------

export function numLabel(v: Num, params: Record<string, ParamSpec>): string {
  if (!isParamRef(v)) return String(v);
  const p = params[v.param];
  return p ? String(p.value) : `{${v.param}}`;
}

export function operandLabel(o: Operand, params: Record<string, ParamSpec>): string {
  if (o.kind === 'const') return numLabel(o.value, params);
  const base = INDICATOR_LABELS[o.name];
  return o.period === undefined ? base : `${base} ${numLabel(o.period, params)}`;
}

export function conditionLabel(c: Condition, params: Record<string, ParamSpec>): string {
  switch (c.type) {
    case 'compare':
      return `${operandLabel(c.left, params)} ${COMPARE_OP_SYMBOL[c.op]} ${operandLabel(c.right, params)}`;
    case 'cross':
      return `${operandLabel(c.left, params)} crosses ${c.direction} ${operandLabel(c.right, params)}`;
    case 'session_window':
      return `${c.label ?? 'Session'} ${c.start}–${c.end} (${c.timezone})`;
    case 'venue_open':
      return 'Venue open';
    case 'no_event':
      return `No high-impact event within ${numLabel(c.withinMinutes, params)} min`;
    case 'ai_regime':
      return `AI regime = ${c.regime} (p > ${numLabel(c.minProbability, params)})`;
  }
}

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { paramsHash, strategyContentHash } from '../strategy-hash.js';
import {
  addBlock,
  BLOCK_CATALOG,
  blankStrategy,
  conditionLabel,
  pruneParams,
  removeBlock,
} from './catalog.js';
import { canonicalStrategyJson, shortHash } from './canonical.js';
import {
  paramsDiff,
  resolveNum,
  StrategyDefinitionSchema,
  validateStrategy,
  warmupBars,
  withParams,
  type StrategyDefinition,
} from './dsl.js';
import {
  BacktestRequestSchema,
  CreateVersionSchema,
  DEFAULT_ROBOT_LIMITS,
  OptimiseRequestSchema,
  PromoteSchema,
  RobotLimitsSchema,
} from './robots.js';
import { STRATEGY_TEMPLATES, TREND_X } from './templates.js';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe('strategy DSL schema', () => {
  it('accepts every template and they validate without errors', () => {
    for (const t of STRATEGY_TEMPLATES) {
      const v = validateStrategy(t.definition);
      expect(
        v.issues.filter((i) => i.severity === 'error'),
        t.id,
      ).toEqual([]);
      expect(v.valid).toBe(true);
    }
  });

  it('rejects unknown keys, bad timeframes and empty entries with plain messages', () => {
    const bad = clone(TREND_X) as unknown as Record<string, unknown>;
    bad.extra = 1;
    expect(validateStrategy(bad).valid).toBe(false);
    const tf = clone(TREND_X) as unknown as { universe: { timeframe: string } };
    tf.universe.timeframe = '2h';
    expect(validateStrategy(tf).valid).toBe(false);
    const empty = clone(TREND_X);
    empty.entry.conditions = [];
    const v = validateStrategy(empty);
    expect(v.valid).toBe(false);
    expect(v.issues[0]!.message).toBe('Add at least one entry condition');
  });

  it('reports semantic errors: unknown params, out-of-range values, bad periods, identical operands', () => {
    const d = clone(TREND_X);
    d.params.fast!.value = 3; // below min 5
    const v1 = validateStrategy(d);
    expect(v1.valid).toBe(false);
    expect(v1.issues.find((i) => i.path === 'params.fast')!.message).toMatch(/below its minimum/);

    const d2 = clone(TREND_X);
    d2.entry.conditions[0] = {
      type: 'cross',
      left: { kind: 'indicator', name: 'ema', period: { param: 'nope' } },
      direction: 'above',
      right: { kind: 'indicator', name: 'ema', period: 50 },
    };
    expect(
      validateStrategy(d2).issues.some((i) => /Unknown parameter "nope"/.test(i.message)),
    ).toBe(true);

    const d3 = clone(TREND_X);
    d3.entry.conditions[1] = {
      type: 'compare',
      left: { kind: 'indicator', name: 'adx', period: 0.5 },
      op: 'gt',
      right: { kind: 'const', value: 20 },
    };
    expect(
      validateStrategy(d3).issues.some((i) => /Periods must be whole numbers/.test(i.message)),
    ).toBe(true);

    const d4 = clone(TREND_X);
    d4.entry.conditions[1] = {
      type: 'compare',
      left: { kind: 'indicator', name: 'rsi', period: 14 },
      op: 'gt',
      right: { kind: 'indicator', name: 'rsi', period: 14 },
    };
    expect(validateStrategy(d4).issues.some((i) => /same/.test(i.message))).toBe(true);

    const d5 = clone(TREND_X);
    d5.entry.conditions[1] = {
      type: 'compare',
      left: { kind: 'const', value: 1 },
      op: 'gt',
      right: { kind: 'const', value: 2 },
    };
    expect(validateStrategy(d5).issues.some((i) => /two constants/.test(i.message))).toBe(true);

    const d6 = clone(TREND_X);
    d6.entry.conditions[1] = {
      type: 'compare',
      left: { kind: 'indicator', name: 'ema' },
      op: 'gt',
      right: { kind: 'const', value: 2 },
    };
    expect(validateStrategy(d6).issues.some((i) => /needs a period/.test(i.message))).toBe(true);

    const d7 = clone(TREND_X);
    d7.params.risk_pct = { value: 9, integer: false };
    expect(validateStrategy(d7).issues.some((i) => /above 5 is refused/.test(i.message))).toBe(
      true,
    );

    const d8 = clone(TREND_X);
    d8.filters.push({
      type: 'session_window',
      timezone: 'Mars/Olympus',
      start: '08:00',
      end: '17:00',
    });
    expect(validateStrategy(d8).issues.some((i) => /Unknown time zone/.test(i.message))).toBe(true);

    const d9 = clone(TREND_X);
    d9.entry.conditions[2] = {
      type: 'ai_regime',
      regime: 'trending',
      minProbability: 1.5,
      whenUnavailable: 'block',
    };
    const v9 = validateStrategy(d9);
    expect(v9.issues.some((i) => /between 0 and 1/.test(i.message))).toBe(true);
    expect(v9.issues.some((i) => /blocks every entry/.test(i.message))).toBe(true);
  });

  it('warns (not errors) about the AI regime filter before goal 07, unused params and stop-only exits', () => {
    const v = validateStrategy(TREND_X);
    expect(v.valid).toBe(true);
    expect(v.issues.find((i) => i.path === 'entry.conditions.2')!.message).toMatch(
      /goal 07.*skipped/,
    );
    const d = clone(TREND_X);
    d.params.unused = { value: 1, integer: false };
    delete d.exit.target;
    delete d.exit.trailing;
    const w = validateStrategy(d)
      .issues.filter((i) => i.severity === 'warning')
      .map((i) => i.message);
    expect(w.some((m) => /not used/.test(m))).toBe(true);
    expect(w.some((m) => /Only the stop/.test(m))).toBe(true);
  });

  it('resolves params with overrides and computes warm-up from the longest period', () => {
    expect(resolveNum({ param: 'fast' }, TREND_X.params)).toBe(20);
    expect(resolveNum({ param: 'fast' }, TREND_X.params, { fast: 30 })).toBe(30);
    expect(resolveNum(7, TREND_X.params)).toBe(7);
    expect(() => resolveNum({ param: 'x' }, TREND_X.params)).toThrow(/Unknown parameter/);
    expect(warmupBars(TREND_X)).toBe(3 * 50 + 2);
    expect(warmupBars(TREND_X, { slow: 100 })).toBe(302);
  });

  it('diffs params and applies new values immutably', () => {
    const next = withParams(TREND_X, { stop_atr: 1.4 });
    expect(TREND_X.params.stop_atr!.value).toBe(1.5);
    expect(paramsDiff(TREND_X, next)).toEqual([{ name: 'stop_atr', from: 1.5, to: 1.4 }]);
    expect(paramsDiff(null, TREND_X).length).toBe(Object.keys(TREND_X.params).length);
  });
});

describe('content hash', () => {
  it('is stable across key order and changes with any parameter', () => {
    const reverse = (v: unknown): unknown =>
      Array.isArray(v)
        ? v.map(reverse)
        : v && typeof v === 'object'
          ? Object.fromEntries(
              Object.entries(v)
                .reverse()
                .map(([k, x]) => [k, reverse(x)]),
            )
          : v;
    const reordered = reverse(TREND_X) as StrategyDefinition;
    expect(Object.keys(reordered)[0]).toBe('size');
    expect(strategyContentHash(reordered)).toBe(strategyContentHash(TREND_X));
    const h = strategyContentHash(TREND_X);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(shortHash(h)).toMatch(/^#[0-9a-f]{6}$/);
    expect(strategyContentHash(withParams(TREND_X, { stop_atr: 1.4 }))).not.toBe(h);
    expect(paramsHash({ a: 1, b: 2 })).toBe(paramsHash({ b: 2, a: 1 }));
  });

  it('canonicalises numbers, drops undefined, refuses non-finite values', () => {
    expect(canonicalStrategyJson({ b: 1.5, a: [true, null, 'x'], c: undefined, d: -0 })).toBe(
      '{"a":[true,null,"x"],"b":1.5,"d":0}',
    );
    expect(() => canonicalStrategyJson({ a: Number.NaN })).toThrow();
    expect(() => canonicalStrategyJson({ a: () => 1 })).toThrow();
  });
});

describe('builder catalog', () => {
  it('builds Trend-X from blocks and matches the template logic', () => {
    let d = blankStrategy('Trend-X', ['EURUSD', 'GBPUSD', 'XAUUSD'], '1h');
    expect(validateStrategy(d).valid).toBe(false);
    d = addBlock(d, 'ema_cross_up', 'entry');
    d = addBlock(d, 'adx_above', 'entry');
    d = addBlock(d, 'ai_regime', 'entry');
    d = addBlock(d, 'no_event', 'filter');
    d = addBlock(d, 'target_atr', 'target');
    d = addBlock(d, 'trail_after_r', 'trailing');
    d = addBlock(d, 'risk_pct', 'size');
    const v = validateStrategy(d);
    expect(v.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(d.entry.conditions.map((c) => conditionLabel(c, d.params))).toEqual([
      'EMA 20 crosses above EMA 50',
      'ADX 14 > 22',
      'AI regime = trending (p > 0.6)',
    ]);
    expect(conditionLabel(d.filters[0]!, d.params)).toBe('No high-impact event within 60 min');
    expect(Object.keys(d.params).sort()).toEqual([
      'adx_min',
      'event_min',
      'fast',
      'risk_pct',
      'slow',
      'stop_atr',
      'target_atr',
      'trail_atr',
      'trail_r',
    ]);
  });

  it('renames clashing params, replaces single blocks, removes optional blocks and prunes params', () => {
    let d = addBlock(blankStrategy(), 'ema_cross_up', 'entry');
    d = addBlock(d, 'ema_cross_down', 'exit_condition');
    expect(Object.keys(d.params)).toEqual(
      expect.arrayContaining(['fast', 'slow', 'fast_2', 'slow_2']),
    );
    d = addBlock(d, 'stop_pct', 'stop');
    expect(d.exit.stop.kind).toBe('percent');
    expect(d.params.stop_atr).toBeUndefined();
    d = addBlock(d, 'time_stop', 'time_stop');
    expect(d.exit.timeStopBars).toEqual({ param: 'max_bars' });
    d = removeBlock(d, 'time_stop');
    expect(d.exit.timeStopBars).toBeUndefined();
    expect(d.params.max_bars).toBeUndefined();
    d = removeBlock(d, 'exit_condition', 0);
    expect(d.params.fast_2).toBeUndefined();
    expect(() => removeBlock(d, 'stop')).toThrow(/cannot be removed|not removed/);
    expect(() => addBlock(d, 'stop_atr', 'entry')).toThrow(/cannot go into/);
    expect(() => addBlock(d, 'nope', 'entry')).toThrow(/Unknown block/);
    d = addBlock(d, 'target_r', 'target');
    d = addBlock(d, 'breakout_high', 'filter');
    d = removeBlock(d, 'filter', 0);
    d = removeBlock(d, 'target');
    d = addBlock(d, 'trail_after_r', 'trailing');
    d = removeBlock(d, 'trailing');
    d = removeBlock(d, 'entry', 0);
    expect(pruneParams(d).params).toEqual({
      risk_pct: d.params.risk_pct,
      stop_pct: d.params.stop_pct,
    });
  });

  it('every catalog block produces a piece that validates in each of its sections', () => {
    for (const b of BLOCK_CATALOG) {
      for (const s of b.sections) {
        let d = addBlock(blankStrategy(), 'rsi_below', 'entry');
        d = addBlock(d, b.id, s);
        expect(StrategyDefinitionSchema.safeParse(d).success, `${b.id} in ${s}`).toBe(true);
        expect(
          validateStrategy(d).issues.filter((i) => i.severity === 'error'),
          `${b.id} in ${s}`,
        ).toEqual([]);
      }
    }
  });

  it('labels every condition type', () => {
    const p = TREND_X.params;
    expect(conditionLabel({ type: 'venue_open' }, p)).toBe('Venue open');
    expect(
      conditionLabel(
        { type: 'session_window', timezone: 'Europe/London', start: '08:00', end: '17:00' },
        p,
      ),
    ).toBe('Session 08:00–17:00 (Europe/London)');
    expect(
      conditionLabel(
        {
          type: 'compare',
          left: { kind: 'indicator', name: 'close' },
          op: 'lte',
          right: { kind: 'const', value: { param: 'zz' } },
        },
        p,
      ),
    ).toBe('Close ≤ {zz}');
  });
});

describe('robot and research request schemas', () => {
  it('validates limits, backtest and optimisation requests and promotion codes', () => {
    expect(RobotLimitsSchema.parse(DEFAULT_ROBOT_LIMITS)).toEqual(DEFAULT_ROBOT_LIMITS);
    expect(
      RobotLimitsSchema.safeParse({ ...DEFAULT_ROBOT_LIMITS, maxDrawdownPct: 0 }).success,
    ).toBe(false);
    const b = BacktestRequestSchema.parse({ versionId: '0b7f3c52-0f8e-4b8e-9d0c-1c2d3e4f5a6b' });
    expect(b.split.oosFraction).toBe(0.3);
    expect(b.capital).toBe('100000');
    expect(
      OptimiseRequestSchema.safeParse({
        versionId: '0b7f3c52-0f8e-4b8e-9d0c-1c2d3e4f5a6b',
        grid: { fast: [10, 20] },
        maxCombos: 5000,
      }).success,
    ).toBe(false);
    expect(PromoteSchema.safeParse({ totpCode: '12345' }).success).toBe(false);
    expect(
      CreateVersionSchema.safeParse({
        definition: TREND_X,
        reason: 'x',
        baseVersionId: '0b7f3c52-0f8e-4b8e-9d0c-1c2d3e4f5a6b',
      }).success,
    ).toBe(false);
  });
});

describe('cross-language fixtures', () => {
  it('the quant test fixture holds the current templates and JSON Schema (UPDATE_FIXTURES=1 rewrites it)', () => {
    const file = resolve(
      import.meta.dirname,
      '../../../../services/quant/tests/fixtures/strategy_templates.json',
    );
    const expected = `${JSON.stringify(
      {
        templates: STRATEGY_TEMPLATES.map((t) => ({ id: t.id, definition: t.definition })),
        jsonSchema: z.toJSONSchema(StrategyDefinitionSchema, { io: 'input' }),
      },
      null,
      2,
    )}\n`;
    if (process.env.UPDATE_FIXTURES === '1' || !existsSync(file)) writeFileSync(file, expected);
    expect(readFileSync(file, 'utf8')).toBe(expected);
  });
});

import { describe, expect, it } from 'vitest';

import { dec } from '../decimal.js';
import {
  evaluateRisk,
  fillsImmediately,
  RISK_CODES,
  type RiskCode,
  type RiskContext,
} from './risk.js';

const limits = {
  maxOrderNotional: '1000000',
  maxPositionNotional: '2000000',
  maxLeverage: '30',
  dailyLossLimit: '5000',
  weeklyLossLimit: '10000',
  maxOrdersPerMinute: 60,
};

/** A clean context: a 100k EUR/USD market buy on a 100k account, nothing wrong. */
const ctx = (p: Partial<RiskContext> = {}, o: Partial<RiskContext['order']> = {}): RiskContext => ({
  order: {
    type: 'market',
    execType: 'market',
    tif: 'gtc',
    reduceOnly: false,
    postOnly: false,
    source: 'manual',
    prices: [],
    hasStopLoss: true,
    marketable: true,
    ...o,
  },
  baseCcy: 'USD',
  instrumentStatus: 'active',
  session: 'open',
  marketData: 'ok',
  fxAvailable: true,
  mid: dec('1.08420'),
  fatFingerPct: dec('1'),
  notionalBase: dec('108421'),
  positionQtyBefore: dec('0'),
  positionQtyAfter: dec('100000'),
  positionNotionalAfter: dec('108421'),
  grossExposureAfter: dec('108421'),
  equity: dec('100000'),
  marginAfter: dec('3610'),
  dayPnl: dec('0'),
  weekPnl: dec('0'),
  ordersLastMinute: 0,
  limits,
  novice: false,
  halted: false,
  previewIssues: [],
  availableNow: null,
  qty: dec('100000'),
  ...p,
});

const codes = (c: RiskContext): RiskCode[] => evaluateRisk(c).map((v) => v.code);

/** For each rule: the negative (violating) context; the positive case is the clean context. */
const NEGATIVE: Record<RiskCode, () => RiskContext> = {
  MAX_ORDER_NOTIONAL: () => ctx({ notionalBase: dec('1000001') }),
  FAT_FINGER: () =>
    ctx({}, { type: 'limit', execType: 'limit', prices: [dec('1.1000')], marketable: false }),
  MAX_POSITION: () => ctx({ positionNotionalAfter: dec('2000001') }),
  MAX_LEVERAGE: () => ctx({ grossExposureAfter: dec('3000001') }),
  INSUFFICIENT_MARGIN: () => ctx({ marginAfter: dec('100001') }),
  DAILY_LOSS_LIMIT: () => ctx({ dayPnl: dec('-5000') }),
  WEEKLY_LOSS_LIMIT: () => ctx({ weekPnl: dec('-10000') }),
  ORDER_RATE_LIMIT: () => ctx({ ordersLastMinute: 60 }),
  SESSION_CLOSED: () => ctx({ session: 'closed' }),
  INSTRUMENT_NOT_TRADABLE: () => ctx({ instrumentStatus: 'halted' }),
  NO_MARKET_DATA: () => ctx({ marketData: 'no_quote', mid: null }),
  MARKET_DATA_STALE: () => ctx({ marketData: 'stale' }),
  FEED_NOT_OK: () => ctx({ marketData: 'feed_not_ok' }),
  FX_RATE_UNAVAILABLE: () => ctx({ fxAvailable: false }),
  NOVICE_ORDER_TYPE: () =>
    ctx({ novice: true }, { type: 'limit', execType: 'limit', marketable: false }),
  NOVICE_STOP_REQUIRED: () => ctx({ novice: true }, { hasStopLoss: false }),
  NOVICE_LEVERAGE: () => ctx({ novice: true, grossExposureAfter: dec('100001') }),
  REDUCE_ONLY_WOULD_INCREASE: () => ctx({}, { reduceOnly: true }),
  POST_ONLY_WOULD_TAKE: () =>
    ctx({}, { type: 'limit', execType: 'limit', postOnly: true, marketable: true }),
  STOP_LOSS_WRONG_SIDE: () =>
    ctx({
      previewIssues: [
        { code: 'STOP_LOSS_WRONG_SIDE', message: 'The stop loss must be below the entry price.' },
      ],
    }),
  TAKE_PROFIT_WRONG_SIDE: () =>
    ctx({
      previewIssues: [
        {
          code: 'TAKE_PROFIT_WRONG_SIDE',
          message: 'The take profit must be above the entry price.',
        },
      ],
    }),
  TRADING_HALTED: () =>
    ctx({ halted: true }, { source: 'robot:0b3c9a4e-1f2d-4c5b-9a8e-7d6c5b4a3f21' }),
  FOK_INSUFFICIENT_DEPTH: () => ctx({ availableNow: dec('50000') }, { tif: 'fok' }),
};

describe('pre-trade risk rules', () => {
  it('the clean order passes every rule (positive case)', () => {
    expect(evaluateRisk(ctx())).toEqual([]);
  });

  it.each(RISK_CODES.map((c) => [c]))(
    '%s: rejects with a machine code and a plain-language message',
    (code) => {
      const v = evaluateRisk(NEGATIVE[code]());
      const hit = v.find((x) => x.code === code);
      expect(hit, `expected ${code} in ${v.map((x) => x.code).join(',')}`).toBeDefined();
      expect(hit!.message.length).toBeGreaterThan(20);
      expect(hit!.message).toMatch(/[.)]$/);
      expect(hit!.message).not.toMatch(/undefined|NaN|\[object/);
    },
  );

  it('covers every code with a negative case', () => {
    expect(Object.keys(NEGATIVE).sort()).toEqual([...RISK_CODES].sort());
  });

  it('positive edges: at-limit values pass', () => {
    expect(codes(ctx({ notionalBase: dec('1000000') }))).toEqual([]);
    expect(codes(ctx({ dayPnl: dec('-4999.99'), weekPnl: dec('-9999.99') }))).toEqual([]);
    expect(codes(ctx({ ordersLastMinute: 59 }))).toEqual([]);
    expect(codes(ctx({ grossExposureAfter: dec('3000000') }))).toEqual([]);
    expect(
      codes(
        ctx({}, { type: 'limit', execType: 'limit', prices: [dec('1.0950')], marketable: false }),
      ),
    ).toEqual([]); // 0.997% away
  });

  it('reducing orders are exempt from exposure and loss-limit rules, and novices can close without a stop', () => {
    const reducing = {
      positionQtyBefore: dec('100000'),
      positionQtyAfter: dec('0'),
      positionNotionalAfter: dec('0'),
    };
    expect(
      codes(
        ctx({
          ...reducing,
          dayPnl: dec('-9000'),
          weekPnl: dec('-20000'),
          grossExposureAfter: dec('9999999'),
          marginAfter: dec('999999'),
        }),
      ),
    ).toEqual([]);
    expect(codes(ctx({ ...reducing, novice: true }, { hasStopLoss: false }))).toEqual([]);
    expect(codes(ctx({ ...reducing }, { reduceOnly: true }))).toEqual([]);
    // A reduce-only order larger than the position is clipped by the engine, so it is allowed.
    expect(
      codes(
        ctx({ positionQtyBefore: dec('100'), positionQtyAfter: dec('-100'), grossExposureAfter: dec('9999999') }, { reduceOnly: true }),
      ),
    ).toEqual([]);
    // A plain flip is not reducing: exposure rules apply.
    expect(
      codes(ctx({ positionQtyBefore: dec('100'), positionQtyAfter: dec('-100'), grossExposureAfter: dec('9999999') })),
    ).toContain('MAX_LEVERAGE');
    // Reduce-only in the same direction as the position increases it.
    expect(
      codes(ctx({ positionQtyBefore: dec('100'), positionQtyAfter: dec('200') }, { reduceOnly: true })),
    ).toContain('REDUCE_ONLY_WOULD_INCREASE');
  });

  it('resting orders are held (not rejected) on stale data, feed trouble or a closed session', () => {
    const resting = {
      type: 'limit' as const,
      execType: 'limit' as const,
      marketable: false,
      prices: [dec('1.08')],
    };
    expect(codes(ctx({ marketData: 'stale', session: 'closed' }, resting))).toEqual([]);
    expect(codes(ctx({ marketData: 'feed_not_ok' }, resting))).toEqual([]);
    expect(fillsImmediately(ctx({}, { ...resting, tif: 'ioc' }))).toBe(true);
    expect(fillsImmediately(ctx({}, { ...resting, marketable: true }))).toBe(true);
    expect(fillsImmediately(ctx({}, resting))).toBe(false);
    expect(codes(ctx({ session: 'break' }))).toEqual(['SESSION_CLOSED']);
    expect(evaluateRisk(ctx({ session: 'break' }))[0]!.message).toContain('on a break');
  });

  it('manual orders are not blocked by the halt; zero equity is unbounded leverage', () => {
    expect(codes(ctx({ halted: true }))).toEqual([]);
    const v = evaluateRisk(ctx({ equity: dec('0'), marginAfter: dec('0') }));
    expect(v.find((x) => x.code === 'MAX_LEVERAGE')!.message).toContain('unbounded');
  });

  it('runs well under the 5 ms target', () => {
    const c = NEGATIVE.FAT_FINGER();
    const n = 5000;
    const t0 = performance.now();
    for (let i = 0; i < n; i++) evaluateRisk(c);
    const perCallMs = (performance.now() - t0) / n;
    expect(perCallMs).toBeLessThan(0.5);
  });
});

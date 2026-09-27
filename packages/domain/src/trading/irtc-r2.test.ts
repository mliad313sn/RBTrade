import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { Decimal, dec } from '../decimal.js';
import { commission, commissionRaw, incrementalCommission, type FeeSchedule } from './costs.js';
import { depositJournal, depositReversalJournal, isBalanced } from './ledger.js';
import { orderShapeIssues, PlaceOrderSchema } from './orders.js';
import {
  evaluateFillExposure,
  evaluateRisk,
  isReducing,
  type FillExposureContext,
  type RiskContext,
} from './risk.js';

/** IRTC seat R2 regression tests for the pure domain functions (docs/review/IRTC-R2-fixes.md). */

const limits = {
  maxOrderNotional: '1000000',
  maxPositionNotional: '2000000',
  maxLeverage: '30',
  dailyLossLimit: '5000',
  weeklyLossLimit: '10000',
  maxOrdersPerMinute: 60,
};

const fillCtx = (p: Partial<FillExposureContext> = {}): FillExposureContext => ({
  baseCcy: 'USD',
  source: 'manual',
  halted: false,
  positionQtyBefore: dec('0'),
  positionQtyAfter: dec('100000'),
  positionNotionalAfter: dec('108421'),
  grossExposureAfter: dec('108421'),
  equity: dec('100000'),
  marginAfter: dec('3610'),
  dayPnl: dec('0'),
  weekPnl: dec('0'),
  limits,
  novice: false,
  ...p,
});

describe('R2-21: re-check before a resting order fills', () => {
  it('passes a healthy fill and any fill that reduces the position', () => {
    expect(evaluateFillExposure(fillCtx())).toEqual([]);
    // Deep in the daily loss, a closing fill still passes.
    expect(
      evaluateFillExposure(
        fillCtx({
          positionQtyBefore: dec('900000'),
          positionQtyAfter: dec('0'),
          dayPnl: dec('-9000'),
        }),
      ),
    ).toEqual([]);
  });

  it('refuses a fill that adds exposure past a loss limit, margin, leverage or position limit', () => {
    const codes = (p: Partial<FillExposureContext>) =>
      evaluateFillExposure(fillCtx(p)).map((v) => v.code);
    expect(codes({ dayPnl: dec('-5000') })).toEqual(['DAILY_LOSS_LIMIT']);
    expect(codes({ weekPnl: dec('-10000') })).toEqual(['WEEKLY_LOSS_LIMIT']);
    expect(codes({ marginAfter: dec('100001') })).toEqual(['INSUFFICIENT_MARGIN']);
    expect(codes({ grossExposureAfter: dec('3000001') })).toEqual(['MAX_LEVERAGE']);
    expect(codes({ positionNotionalAfter: dec('2000001') })).toEqual(['MAX_POSITION']);
    // A flip that ends larger than the position it started from adds exposure.
    expect(
      codes({
        positionQtyBefore: dec('100000'),
        positionQtyAfter: dec('-150000'),
        dayPnl: dec('-6000'),
      }),
    ).toEqual(['DAILY_LOSS_LIMIT']);
  });

  it('applies Novice cooling-off and the borrowing cap, and blocks robots while halted', () => {
    const codes = (p: Partial<FillExposureContext>) =>
      evaluateFillExposure(fillCtx(p)).map((v) => v.code);
    expect(codes({ novice: true, coolingOff: 'losing_trades' })).toEqual([
      'NOVICE_LEVERAGE',
      'NOVICE_COOLING_OFF',
    ]);
    expect(codes({ novice: true, noviceMaxLeverage: dec('2') })).toEqual([]);
    expect(codes({ halted: true, source: 'robot:0b5a3a4e-1c52-4d1e-9d4f-1e1e1e1e1e1e' })).toEqual([
      'TRADING_HALTED',
    ]);
    expect(codes({ halted: true })).toEqual([]);
  });

  it('isReducing: flat → any is not reducing; reduce-only opposite always is', () => {
    expect(isReducing(dec('0'), dec('1'))).toBe(false);
    expect(isReducing(dec('10'), dec('4'))).toBe(true);
    expect(isReducing(dec('10'), dec('-4'))).toBe(false);
    expect(isReducing(dec('10'), dec('-4'), true)).toBe(true);
  });
});

describe('R2-14: FX staleness never blocks reducing orders', () => {
  const base = (p: Partial<RiskContext>): RiskContext => ({
    order: {
      type: 'market',
      execType: 'market',
      tif: 'gtc',
      reduceOnly: true,
      postOnly: false,
      source: 'manual',
      prices: [],
      hasStopLoss: false,
      marketable: true,
    },
    baseCcy: 'EUR',
    instrumentStatus: 'active',
    session: 'open',
    marketData: 'ok',
    fxAvailable: false,
    fxRateKnown: true,
    mid: dec('58001'),
    fatFingerPct: dec('5'),
    notionalBase: dec('26000'),
    positionQtyBefore: dec('0.5'),
    positionQtyAfter: dec('0'),
    positionNotionalAfter: dec('0'),
    grossExposureAfter: dec('0'),
    equity: dec('90000'),
    marginAfter: dec('0'),
    dayPnl: dec('0'),
    weekPnl: dec('0'),
    ordersLastMinute: 0,
    limits,
    novice: false,
    halted: false,
    previewIssues: [],
    availableNow: null,
    qty: dec('0.5'),
    ...p,
  });
  const codes = (p: Partial<RiskContext>) => evaluateRisk(base(p)).map((v) => v.code);

  it('a close with a stale but known rate passes; new exposure or no rate at all is refused', () => {
    expect(codes({})).toEqual([]);
    expect(codes({ fxRateKnown: false })).toEqual(['FX_RATE_UNAVAILABLE']);
    expect(
      codes({
        positionQtyBefore: dec('0'),
        positionQtyAfter: dec('0.5'),
        positionNotionalAfter: dec('26000'),
      }),
    ).toContain('FX_RATE_UNAVAILABLE');
  });
});

describe('R2-06: the minimum commission is charged once per order', () => {
  const fees: FeeSchedule = {
    id: 'sim-equity-xnas',
    commissionBps: '0',
    commissionPerUnit: '0.005',
    commissionMin: '1',
    swapLongBps: '0',
    swapShortBps: '0',
    fxConversionBps: '25',
    simulated: true,
  };
  const one = new Decimal(1);

  it('three 100-share levels cost 1.50 in total, as the preview (one commission on 300)', () => {
    let raw = new Decimal(0);
    let total = new Decimal(0);
    for (const [i, px] of ['221.38', '221.39', '221.40'].entries()) {
      total = total.add(incrementalCommission(fees, raw, i > 0, dec('100'), dec(px), one, 'USD'));
      raw = raw.add(commissionRaw(fees, dec('100'), dec(px), one));
    }
    expect(total.toFixed(2)).toBe('1.50');
    expect(commission(fees, dec('300'), dec('221.39'), one, 'USD').toFixed(2)).toBe('1.50');
  });

  it('property: however an order is split, its fills add up to one order commission', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(fc.integer({ min: 1, max: 500 }), fc.integer({ min: 100, max: 50_000 })),
          { minLength: 1, maxLength: 12 },
        ),
        fc.constantFrom('0', '0.2', '1'),
        fc.constantFrom('0', '0.005'),
        fc.constantFrom('0', '1', '5'),
        (pieces, bps, perUnit, min) => {
          const fs = {
            ...fees,
            commissionBps: bps,
            commissionPerUnit: perUnit,
            commissionMin: min,
          };
          let raw = new Decimal(0);
          let total = new Decimal(0);
          pieces.forEach(([q, p], i) => {
            const qty = dec(String(q));
            const price = new Decimal(p).div(100);
            total = total.add(incrementalCommission(fs, raw, i > 0, qty, price, one, 'USD'));
            raw = raw.add(commissionRaw(fs, qty, price, one));
          });
          const expected = raw.lt(dec(min)) ? dec(min) : raw;
          return total.eq(expected.toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN));
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe('R2-05: a currency change reverses the deposit and deposits the converted amount', () => {
  it('both journals balance and net the cash to the converted balance', () => {
    const rev = depositReversalJournal(dec('100000'), 'USD');
    const dep = depositJournal(dec('14821500'), 'JPY');
    expect(isBalanced(rev) && isBalanced(dep)).toBe(true);
    expect(rev.kind).toBe('adjustment');
    expect(rev.lines.find((l) => l.account === 'cash')!.amount.toFixed()).toBe('-100000');
  });
});

describe('R2-16: order shape', () => {
  const base = { clientOrderId: 'c1', symbol: 'EURUSD', side: 'buy', qty: '10000' } as const;

  it('stop orders cannot be IOC or FOK', () => {
    for (const tif of ['ioc', 'fok'] as const) {
      expect(
        PlaceOrderSchema.safeParse({ ...base, type: 'stop', stopPrice: '1.08900', tif }).success,
      ).toBe(false);
      expect(
        PlaceOrderSchema.safeParse({ ...base, type: 'trailing', trailAmount: '0.001', tif })
          .success,
      ).toBe(false);
    }
    expect(
      PlaceOrderSchema.safeParse({ ...base, type: 'stop', stopPrice: '1.08900', tif: 'gtc' })
        .success,
    ).toBe(true);
  });

  it('trailing stops take no limit or stop price', () => {
    const issues = orderShapeIssues(
      PlaceOrderSchema.safeParse({ ...base, type: 'trailing', trailAmount: '0.001' }).data!,
    );
    expect(issues).toEqual([]);
    expect(
      PlaceOrderSchema.safeParse({
        ...base,
        type: 'trailing',
        trailAmount: '0.001',
        limitPrice: '1.08',
      }).success,
    ).toBe(false);
    expect(
      PlaceOrderSchema.safeParse({
        ...base,
        type: 'trailing',
        trailAmount: '0.001',
        stopPrice: '1.081',
      }).success,
    ).toBe(false);
  });
});

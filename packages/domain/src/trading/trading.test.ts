import { describe, expect, it } from 'vitest';

import { Decimal, dec } from '../decimal.js';
import { summarizeAccount, valuePosition } from './account.js';
import {
  availableSize,
  commission,
  convert,
  notional,
  priceMultiplier,
  spreadCost,
  swapAmount,
  vwap,
  walkBook,
  type FeeSchedule,
} from './costs.js';
import { UnbalancedJournalError } from './ledger.js';
import { currencyDecimals, formatAmount, formatPct, roundMoney, sum } from './money.js';
import {
  AmendOrderSchema,
  execTypeFor,
  isRobotSource,
  oppositeSide,
  ORDER_SOURCE_RE,
  PlaceOrderSchema,
  PreviewOrderSchema,
  sideSign,
} from './orders.js';
import { applyFill, FLAT, markFor } from './position.js';
import {
  ALL_ORDER_STATUSES,
  assertTransition,
  canTransition,
  InvalidTransitionError,
  isOpen,
  isTerminal,
  ORDER_TRANSITIONS,
  reachableFrom,
  statusAfterFill,
} from './state-machine.js';

describe('order state machine', () => {
  const allowed: Record<string, string[]> = {
    new: ['accepted', 'rejected'],
    accepted: ['working', 'cancelled', 'rejected', 'expired'],
    working: ['partially_filled', 'filled', 'cancelled', 'expired'],
    partially_filled: ['partially_filled', 'filled', 'cancelled', 'expired'],
    filled: [],
    cancelled: [],
    rejected: [],
    expired: [],
  };

  it('is exhaustive: every (from, to) pair of the 8 states is explicitly allowed or refused', () => {
    let checked = 0;
    for (const from of ALL_ORDER_STATUSES) {
      for (const to of ALL_ORDER_STATUSES) {
        checked += 1;
        const ok = allowed[from]!.includes(to);
        expect(canTransition(from, to), `${from} → ${to}`).toBe(ok);
        if (ok) expect(() => assertTransition(from, to)).not.toThrow();
        else expect(() => assertTransition(from, to)).toThrow(InvalidTransitionError);
      }
    }
    expect(checked).toBe(64);
    expect(Object.keys(ORDER_TRANSITIONS).sort()).toEqual([...ALL_ORDER_STATUSES].sort());
  });

  it('every state is reachable from new; terminal states have no exits', () => {
    expect(reachableFrom('new')).toEqual(new Set(ALL_ORDER_STATUSES));
    expect(ALL_ORDER_STATUSES.filter(isTerminal)).toEqual([
      'filled',
      'cancelled',
      'rejected',
      'expired',
    ]);
    expect(ALL_ORDER_STATUSES.filter(isOpen)).toEqual([
      'new',
      'accepted',
      'working',
      'partially_filled',
    ]);
  });

  it('derives the status after a fill', () => {
    expect(statusAfterFill(dec('0'), dec('10'))).toBe('working');
    expect(statusAfterFill(dec('4'), dec('10'))).toBe('partially_filled');
    expect(statusAfterFill(dec('10'), dec('10'))).toBe('filled');
  });
});

describe('order request schema', () => {
  const ok = { clientOrderId: 'c-1', symbol: 'EURUSD', side: 'buy', qty: '100000' };
  const issues = (body: object) => {
    const r = PlaceOrderSchema.safeParse(body);
    return r.success ? [] : r.error.issues.map((i) => i.message);
  };

  it('accepts each order type in its valid shape with defaults', () => {
    expect(PlaceOrderSchema.parse({ ...ok, type: 'market' })).toMatchObject({
      tif: 'gtc',
      reduceOnly: false,
      postOnly: false,
      source: 'manual',
    });
    expect(issues({ ...ok, type: 'limit', limitPrice: '1.08' })).toEqual([]);
    expect(issues({ ...ok, type: 'stop', stopPrice: '1.09' })).toEqual([]);
    expect(issues({ ...ok, type: 'stop_limit', stopPrice: '1.09', limitPrice: '1.091' })).toEqual(
      [],
    );
    expect(issues({ ...ok, type: 'trailing', trailAmount: '0.001' })).toEqual([]);
    expect(
      issues({ ...ok, type: 'bracket', stopLossPrice: '1.07', takeProfitPrice: '1.09' }),
    ).toEqual([]);
    expect(
      issues({
        ...ok,
        type: 'bracket',
        entryType: 'limit',
        limitPrice: '1.08',
        stopLossPrice: '1.07',
        takeProfitPrice: '1.09',
      }),
    ).toEqual([]);
    expect(
      issues({
        ...ok,
        type: 'oco',
        legs: [
          { type: 'limit', limitPrice: '1.07' },
          { type: 'stop', stopPrice: '1.09' },
        ],
      }),
    ).toEqual([]);
    expect(
      issues({
        ...ok,
        type: 'limit',
        limitPrice: '1.08',
        tif: 'gtd',
        expireAt: '2026-10-01T00:00:00Z',
      }),
    ).toEqual([]);
  });

  it('explains inconsistent shapes in plain language', () => {
    expect(issues({ ...ok, type: 'market', limitPrice: '1' })).toContain(
      'A market order has no limit price',
    );
    expect(issues({ ...ok, type: 'market', stopPrice: '1' })).toContain(
      'A market order has no stop price',
    );
    expect(issues({ ...ok, type: 'market', postOnly: true })).toContain(
      'A market order cannot be post-only',
    );
    expect(issues({ ...ok, type: 'limit' })).toContain('A limit order needs a limit price');
    expect(issues({ ...ok, type: 'limit', limitPrice: '1', stopPrice: '1' })).toContain(
      'A limit order has no stop price; use stop-limit',
    );
    expect(issues({ ...ok, type: 'stop' })).toContain('A stop order needs a stop price');
    expect(issues({ ...ok, type: 'stop', stopPrice: '1', limitPrice: '1' })).toContain(
      'A stop order has no limit price; use stop-limit',
    );
    expect(issues({ ...ok, type: 'stop_limit' })).toEqual(
      expect.arrayContaining([
        'A stop-limit order needs a stop price',
        'A stop-limit order needs a limit price',
      ]),
    );
    expect(issues({ ...ok, type: 'trailing' })).toContain(
      'A trailing stop needs a trailing distance',
    );
    expect(issues({ ...ok, type: 'bracket' })).toEqual(
      expect.arrayContaining(['A bracket needs a stop loss', 'A bracket needs a take profit']),
    );
    expect(
      issues({
        ...ok,
        type: 'bracket',
        entryType: 'limit',
        stopLossPrice: '1',
        takeProfitPrice: '2',
      }),
    ).toContain('A limit bracket entry needs a limit price');
    expect(
      issues({ ...ok, type: 'bracket', limitPrice: '1', stopLossPrice: '1', takeProfitPrice: '2' }),
    ).toContain('A market bracket entry has no limit price');
    expect(issues({ ...ok, type: 'oco' })).toContain('An OCO order needs two legs');
    expect(
      issues({
        ...ok,
        type: 'oco',
        stopLossPrice: '1',
        takeProfitPrice: '2',
        legs: [{ type: 'limit' }, { type: 'stop_limit' }],
      }),
    ).toEqual(
      expect.arrayContaining([
        'OCO legs cannot carry attached stops',
        'OCO legs cannot carry attached targets',
        'This leg needs a limit price',
        'This leg needs a stop price',
      ]),
    );
    expect(issues({ ...ok, type: 'market', trailAmount: '1' })).toContain(
      'Only trailing stops take a trailing distance',
    );
    expect(
      issues({
        ...ok,
        type: 'market',
        legs: [
          { type: 'limit', limitPrice: '1' },
          { type: 'stop', stopPrice: '2' },
        ],
      }),
    ).toContain('Only OCO orders take legs');
    expect(issues({ ...ok, type: 'market', entryType: 'market' })).toContain(
      'Only brackets take an entry type',
    );
    expect(issues({ ...ok, type: 'market', tif: 'gtd' })).toContain(
      'Good-till-date needs an expiry time',
    );
    expect(issues({ ...ok, type: 'market', expireAt: '2026-10-01T00:00:00Z' })).toContain(
      'Only good-till-date orders take an expiry time',
    );
    expect(issues({ ...ok, type: 'limit', limitPrice: '1', postOnly: true, tif: 'ioc' })).toContain(
      'Post-only cannot be immediate-or-cancel or fill-or-kill',
    );
    expect(issues({ ...ok, type: 'market', reduceOnly: true, stopLossPrice: '1' })).toContain(
      'A reduce-only order cannot open protective orders',
    );
    expect(issues({ ...ok, type: 'market', qty: '0' })).toContain('Must be greater than zero');
    expect(issues({ ...ok, type: 'market', qty: '1e5' })).toContain(
      'Use a decimal number such as 1.2345',
    );
    expect(issues({ ...ok, type: 'market', source: 'robot:x' }).length).toBeGreaterThan(0);
    expect(issues({ ...ok, type: 'market', clientOrderId: 'bad id!' }).length).toBeGreaterThan(0);
  });

  it('preview does not need a client order id; amend needs a field', () => {
    expect(
      PreviewOrderSchema.safeParse({ symbol: 'EURUSD', side: 'buy', qty: '1', type: 'market' })
        .success,
    ).toBe(true);
    expect(
      PreviewOrderSchema.safeParse({ symbol: 'EURUSD', side: 'buy', qty: '1', type: 'limit' })
        .success,
    ).toBe(false);
    expect(AmendOrderSchema.safeParse({}).success).toBe(false);
    expect(AmendOrderSchema.safeParse({ qty: '5' }).success).toBe(true);
  });

  it('helpers', () => {
    expect(execTypeFor({ type: 'bracket' })).toBe('market');
    expect(execTypeFor({ type: 'bracket', entryType: 'limit' })).toBe('limit');
    expect(execTypeFor({ type: 'oco' })).toBe('none');
    expect(execTypeFor({ type: 'stop' })).toBe('stop');
    expect(sideSign('buy')).toBe(1);
    expect(sideSign('sell')).toBe(-1);
    expect(oppositeSide('buy')).toBe('sell');
    expect(oppositeSide('sell')).toBe('buy');
    expect(isRobotSource('robot:123')).toBe(true);
    expect(isRobotSource('manual')).toBe(false);
    expect(ORDER_SOURCE_RE.test('robot:0b3c9a4e-1f2d-4c5b-9a8e-7d6c5b4a3f21')).toBe(true);
    expect(ORDER_SOURCE_RE.test('robot:nope')).toBe(false);
  });
});

describe('money', () => {
  it('uses ISO minor units', () => {
    expect(currencyDecimals('USD')).toBe(2);
    expect(currencyDecimals('JPY')).toBe(0);
    expect(currencyDecimals('KWD')).toBe(3);
    expect(roundMoney('2.125', 'USD').toFixed()).toBe('2.12');
    expect(formatAmount('1234.5', 'JPY')).toBe('1234');
    expect(formatPct(dec('0.0020433'))).toBe('0.20');
    expect(sum([dec('1'), dec('2.5')]).toFixed()).toBe('3.5');
  });
});

describe('positions', () => {
  const m = new Decimal(1);
  it('averages on increase, keeps the average on reduce, resets on flip and on flat', () => {
    let r = applyFill(FLAT, { side: 'buy', qty: dec('100'), price: dec('10') }, m);
    r = applyFill(r.position, { side: 'buy', qty: dec('100'), price: dec('12') }, m);
    expect(r.position.avgPrice.toFixed()).toBe('11');
    r = applyFill(r.position, { side: 'sell', qty: dec('50'), price: dec('13') }, m);
    expect(r.realizedPnl.toFixed()).toBe('100');
    expect(r.position.avgPrice.toFixed()).toBe('11');
    r = applyFill(r.position, { side: 'sell', qty: dec('200'), price: dec('9') }, m);
    expect(r.closedQty.toFixed()).toBe('150');
    expect(r.openedQty.toFixed()).toBe('50');
    expect(r.realizedPnl.toFixed()).toBe('-300');
    expect(r.position).toEqual({ qty: dec('-50'), avgPrice: dec('9') });
    r = applyFill(r.position, { side: 'buy', qty: dec('50'), price: dec('8') }, dec('50'));
    expect(r.realizedPnl.toFixed()).toBe('2500');
    expect(r.position.qty.isZero()).toBe(true);
    expect(() => applyFill(FLAT, { side: 'buy', qty: dec('0'), price: dec('1') }, m)).toThrow(
      RangeError,
    );
  });

  it('marks longs at the bid and shorts at the ask', () => {
    expect(markFor(dec('1'), '1.1', '1.2').toFixed()).toBe('1.1');
    expect(markFor(dec('-1'), '1.1', '1.2').toFixed()).toBe('1.2');
  });
});

describe('costs and execution', () => {
  const fs: FeeSchedule = {
    id: 'f',
    commissionBps: '1',
    commissionPerUnit: '0',
    commissionMin: '2',
    swapLongBps: '-365',
    swapShortBps: '120',
    fxConversionBps: '25',
    simulated: true,
  };

  it('multiplier modes are registry-driven', () => {
    expect(priceMultiplier({ contractSize: '100000' }, 'unit').toFixed()).toBe('1');
    expect(priceMultiplier({ contractSize: '50' }, 'contract').toFixed()).toBe('50');
    expect(priceMultiplier({ contractSize: '1000' }, 'percent_of_par').toFixed()).toBe('0.01');
    expect(notional(dec('-2'), dec('10'), dec('50')).toFixed()).toBe('1000');
  });

  it('commission (minimum), spread, swap (ACT/360, signed) and conversion', () => {
    expect(commission(fs, dec('1'), dec('100'), new Decimal(1), 'USD').toFixed()).toBe('2');
    expect(commission(fs, dec('100'), dec('1000'), new Decimal(1), 'USD').toFixed()).toBe('10');
    expect(spreadCost(dec('10'), dec('1.0'), dec('1.2'), new Decimal(1)).toFixed()).toBe('1');
    expect(swapAmount(fs, dec('360'), dec('100'), new Decimal(1), 1).toFixed()).toBe('-3.65');
    expect(swapAmount(fs, dec('-360'), dec('100'), new Decimal(1), 2).toFixed()).toBe('2.4');
    expect(swapAmount(fs, dec('0'), dec('100'), new Decimal(1), 1).toFixed()).toBe('0');
    expect(convert(dec('100'), dec('1.1'), '25', false)).toEqual({
      base: dec('110'),
      cost: dec('0.275'),
    });
    expect(convert(dec('100'), dec('1'), '25', true).cost.isZero()).toBe(true);
  });

  it('walks the book with impact and volatility terms and never crosses a limit', () => {
    const asks: Array<[string, string]> = [
      ['1.0001', '100'],
      ['1.0003', '100'],
      ['1.0005', '100'],
    ];
    const p = {
      tickSize: '0.0001',
      impactTicks: '1',
      volFactor: '0.5',
      maxLevels: 10,
      lastMidMove: dec('0.0003'),
    };
    const w = walkBook('buy', asks, dec('250'), p);
    // vol term: 0.5 × 0.0003 = 0.00015 → 0.0002 (ceil to tick); level k adds k ticks
    expect(w.fills.map((f) => [f.qty.toFixed(), f.price.toFixed()])).toEqual([
      ['100', '1.0003'],
      ['100', '1.0006'],
      ['50', '1.0009'],
    ]);
    expect(w.remaining.isZero()).toBe(true);
    const limited = walkBook('buy', asks, dec('250'), { ...p, volFactor: '0' }, dec('1.0003'));
    expect(limited.fills.map((f) => f.price.toFixed())).toEqual(['1.0001', '1.0003']);
    expect(limited.remaining.toFixed()).toBe('50');
    const bids: Array<[string, string]> = [
      ['0.9999', '10'],
      ['0.9997', '0'],
      ['0.9995', '10'],
    ];
    const s = walkBook('sell', bids, dec('30'), {
      ...p,
      volFactor: '0',
      impactTicks: '0',
      maxLevels: 2,
    });
    expect(s.fills).toHaveLength(1);
    expect(s.remaining.toFixed()).toBe('20');
    const floor = walkBook('sell', [['0.0001', '5']], dec('5'), {
      ...p,
      tickSize: '0.0001',
      volFactor: '1',
      lastMidMove: dec('0.01'),
    });
    expect(floor.fills[0]!.price.toFixed()).toBe('0.0001');
    expect(vwap([])).toBeNull();
    expect(vwap(w.fills)!.toFixed(6)).toBe('1.000540');
    expect(availableSize('buy', asks, 2).toFixed()).toBe('200');
    expect(availableSize('buy', asks, 10, dec('1.0001')).toFixed()).toBe('100');
    expect(availableSize('sell', bids, 10, dec('0.9998')).toFixed()).toBe('10');
  });
});

describe('account valuation', () => {
  it('sums unrealised, exposure and margin in base currency; flags unpriced positions', () => {
    const s = summarizeAccount(dec('10000'), [
      {
        symbol: 'A',
        qty: dec('10'),
        avgPrice: dec('100'),
        mark: dec('110'),
        multiplier: new Decimal(1),
        fxRate: dec('1.5'),
        marginRate: dec('0.1'),
      },
      {
        symbol: 'B',
        qty: dec('-1'),
        avgPrice: dec('50'),
        mark: null,
        multiplier: new Decimal(1),
        fxRate: dec('1'),
        marginRate: dec('0.2'),
      },
      {
        symbol: 'C',
        qty: dec('0'),
        avgPrice: dec('0'),
        mark: null,
        multiplier: new Decimal(1),
        fxRate: null,
        marginRate: dec('1'),
      },
    ]);
    expect(s.unrealizedPnl.toFixed()).toBe('150');
    expect(s.equity.toFixed()).toBe('10150');
    expect(s.grossExposure.toFixed()).toBe('1700'); // 10 × 110 × 1.5 + 1 × 50
    expect(s.marginUsed.toFixed()).toBe('175');
    expect(s.marginFree.toFixed()).toBe('9975');
    expect(s.unpriced).toEqual(['B']);
    expect(s.leverage.toFixed(4)).toBe('0.1675');
    expect(summarizeAccount(dec('0'), []).leverage.toFixed()).toBe('0');
    expect(
      summarizeAccount(dec('-1'), [
        {
          symbol: 'A',
          qty: dec('1'),
          avgPrice: dec('1'),
          mark: dec('1'),
          multiplier: new Decimal(1),
          fxRate: dec('1'),
          marginRate: dec('1'),
        },
      ]).leverage.gt(1000),
    ).toBe(true);
    expect(
      valuePosition({
        symbol: 'Z',
        qty: dec('0'),
        avgPrice: dec('1'),
        mark: dec('1'),
        multiplier: new Decimal(1),
        fxRate: dec('1'),
        marginRate: dec('1'),
      }).priced,
    ).toBe(true);
  });
  it('exports the ledger error type', () => {
    expect(new UnbalancedJournalError('x')).toBeInstanceOf(Error);
  });
});

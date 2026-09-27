import { dec, TIMEFRAMES, type Timeframe } from '@kora/domain';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  aggregateBars,
  BarBuilder,
  CandleTracker,
  isValidBar,
  mergeBars,
  type OhlcvBar,
} from './bars.js';

const T0 = Date.parse('2026-09-25T10:00:00Z');
const bar = (
  sec: number,
  o: string,
  h: string,
  l: string,
  c: string,
  v: string,
  n = 1,
): OhlcvBar => ({
  bucket: T0 + sec * 1000,
  open: o,
  high: h,
  low: l,
  close: c,
  volume: v,
  trades: n,
});

describe('aggregateBars vs hand-computed bars', () => {
  // Six 1 s bars spanning two minutes (10:00:00, :30, :59 | 10:01:00, :15, :59).
  const bars1s = [
    bar(0, '1.08400', '1.08410', '1.08395', '1.08405', '1000', 2),
    bar(30, '1.08405', '1.08430', '1.08401', '1.08428', '3000', 3),
    bar(59, '1.08428', '1.08429', '1.08380', '1.08390', '2000', 1),
    bar(60, '1.08391', '1.08392', '1.08370', '1.08372', '500', 1),
    bar(75, '1.08372', '1.08450', '1.08372', '1.08449', '4500', 4),
    bar(119, '1.08449', '1.08449', '1.08440', '1.08441', '1000', 2),
  ];

  it('1m: open first, high max, low min, close last, sums', () => {
    expect(aggregateBars(bars1s, '1m')).toEqual([
      {
        bucket: T0,
        open: '1.08400',
        high: '1.08430',
        low: '1.08380',
        close: '1.08390',
        volume: '6000',
        trades: 6,
      },
      {
        bucket: T0 + 60_000,
        open: '1.08391',
        high: '1.08450',
        low: '1.08370',
        close: '1.08441',
        volume: '6000',
        trades: 7,
      },
    ]);
  });

  it('5m and 15m buckets align to UTC and equal the one-step aggregate', () => {
    const five = {
      bucket: T0,
      open: '1.08400',
      high: '1.08450',
      low: '1.08370',
      close: '1.08441',
      volume: '12000',
      trades: 13,
    };
    expect(aggregateBars(bars1s, '5m')).toEqual([five]);
    expect(aggregateBars(aggregateBars(bars1s, '1m'), '15m')).toEqual([five]);
    const late = [bar(-1, '1.0', '1.0', '1.0', '1.0', '1')]; // 09:59:59 → previous 15m bucket
    expect(aggregateBars(late, '15m')[0]!.bucket).toBe(Date.parse('2026-09-25T09:45:00Z'));
  });

  it('volume precision can be forced; unordered input is rejected', () => {
    expect(
      aggregateBars(
        [bar(0, '1', '1', '1', '1', '0.1'), bar(1, '1', '2', '1', '2', '0.2')],
        '1m',
        3,
      )[0]!.volume,
    ).toBe('0.300');
    expect(aggregateBars([bar(0, '1', '1', '1', '1', '1')], '1m', 2)[0]!.volume).toBe('1.00');
    expect(() =>
      aggregateBars([bar(5, '1', '1', '1', '1', '1'), bar(1, '1', '1', '1', '1', '1')], '1m'),
    ).toThrow(RangeError);
  });

  it('property: hierarchical aggregation equals direct aggregation and bars stay valid', () => {
    const barArb = fc.array(
      fc.record({
        gap: fc.integer({ min: 1, max: 400 }),
        o: fc.integer({ min: 1, max: 9999 }),
        c: fc.integer({ min: 1, max: 9999 }),
        up: fc.integer({ min: 0, max: 50 }),
        dn: fc.integer({ min: 0, max: 50 }),
        v: fc.integer({ min: 0, max: 1000 }),
        n: fc.integer({ min: 0, max: 9 }),
      }),
      { minLength: 1, maxLength: 300 },
    );
    const chain: Timeframe[] = ['1m', '5m', '15m', '1h', '4h', '1D'];
    fc.assert(
      fc.property(barArb, (rows) => {
        let t = T0;
        const input: OhlcvBar[] = rows.map((r) => {
          t += r.gap * 1000;
          const hi = Math.max(r.o, r.c) + r.up;
          const lo = Math.max(1, Math.min(r.o, r.c) - r.dn);
          return {
            bucket: t,
            open: String(r.o),
            high: String(hi),
            low: String(lo),
            close: String(r.c),
            volume: String(r.v),
            trades: r.n,
          };
        });
        let prev = input;
        for (const tf of chain) {
          const hier = aggregateBars(prev, tf);
          const direct = aggregateBars(input, tf);
          if (JSON.stringify(hier) !== JSON.stringify(direct)) return false;
          if (!direct.every(isValidBar)) return false;
          const vol = direct.reduce((a, b) => a.add(dec(b.volume)), dec(0));
          if (!vol.eq(input.reduce((a, b) => a.add(dec(b.volume)), dec(0)))) return false;
          prev = hier;
        }
        return true;
      }),
      { numRuns: 200 },
    );
  });
});

describe('BarBuilder and CandleTracker', () => {
  it('builds 1 s bars from trades and closes them on the next second or on flush', () => {
    const b = new BarBuilder(() => 0);
    const tr = (ms: number, price: string, qty: string) => ({
      symbol: 'X',
      price,
      qty,
      exchangeTs: T0 + ms,
    });
    expect(b.onTrade(tr(100, '10', '1'))).toEqual([]);
    expect(b.onTrade(tr(900, '12', '2'))).toEqual([]);
    expect(b.onTrade(tr(500, '9', '1'))).toEqual([]); // same second, out of order is still merged by time bucket
    const closed = b.onTrade(tr(1200, '11', '1'));
    expect(closed).toEqual([
      { bucket: T0, open: '10', high: '12', low: '9', close: '9', volume: '4', trades: 3 },
    ]);
    expect(b.onTrade(tr(200, '1', '1'))).toEqual([]); // late trade for a closed second is ignored
    expect(b.peek('X')!.bucket).toBe(T0 + 1000);
    expect(b.flush(T0 + 1500)).toEqual([]);
    expect(b.flush(T0 + 2000)).toHaveLength(1);
    expect(b.peek('X')).toBeUndefined();
  });

  it('tracks in-progress candles per timeframe and emits closed ones on rollover', () => {
    const c = new CandleTracker('simulated');
    const first = c.update('X', bar(0, '10', '11', '9', '10', '1'), 1, 0);
    expect(first.map((x) => x.tf)).toEqual(TIMEFRAMES.filter((t) => t !== '1s'));
    expect(first.every((x) => !x.closed)).toBe(true);
    c.update('X', bar(30, '10', '13', '10', '12', '2'), 2, 0);
    expect(c.current('X', '1m')).toMatchObject({ high: '13', close: '12', volume: '3', trades: 2 });
    const roll = c.update('X', bar(61, '12', '12', '8', '8', '1'), 3, 0);
    const closed1m = roll.find((x) => x.tf === '1m' && x.closed)!;
    expect(closed1m).toMatchObject({
      bucket: T0,
      open: '10',
      high: '13',
      low: '9',
      close: '12',
      volume: '3',
      seq: 3,
    });
    expect(roll.find((x) => x.tf === '5m')).toMatchObject({
      closed: false,
      low: '8',
      close: '8',
      volume: '4',
    });
  });

  it('mergeBars and isValidBar', () => {
    const m = mergeBars(bar(0, '5', '6', '4', '5', '1.5'), bar(0, '5', '7', '3', '6', '0.5'), 1);
    expect(m).toMatchObject({
      open: '5',
      high: '7',
      low: '3',
      close: '6',
      volume: '2.0',
      trades: 2,
    });
    expect(isValidBar(m)).toBe(true);
    expect(isValidBar({ ...m, high: '1' })).toBe(false);
  });
});

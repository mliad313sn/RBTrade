import type { DepthDelta, DepthSnapshot } from '@kora/domain';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { Conflator, systemClock, type ConflatorClock } from './conflator.js';
import { SeqGapDetector } from './gap-detector.js';
import { diffDepth, OrderBook } from './order-book.js';

describe('SeqGapDetector', () => {
  it('classifies first, ok, duplicate and gap; reset after resync', () => {
    const g = new SeqGapDetector();
    expect(g.check('k', 5)).toEqual({ status: 'first' });
    expect(g.check('k', 6)).toEqual({ status: 'ok' });
    expect(g.check('k', 6)).toEqual({ status: 'duplicate', last: 6 });
    expect(g.check('k', 9)).toEqual({ status: 'gap', expected: 7, got: 9 });
    expect(g.check('k', 10)).toEqual({ status: 'ok' });
    g.reset('k', 20);
    expect(g.lastSeq('k')).toBe(20);
    expect(g.check('k', 21)).toEqual({ status: 'ok' });
    g.forget('k');
    expect(g.check('k', 1)).toEqual({ status: 'first' });
    expect(g.gaps).toBe(1);
  });

  it('property: reports exactly the missing ranges of an increasing sequence', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 1, max: 500 }), { minLength: 1, maxLength: 100 }),
        (xs) => {
          const seqs = [...xs].sort((a, b) => a - b);
          const g = new SeqGapDetector();
          let missing = 0;
          let reported = 0;
          seqs.forEach((s, i) => {
            const r = g.check('k', s);
            if (i > 0) missing += s - seqs[i - 1]! - 1;
            if (r.status === 'gap') reported += r.got - r.expected;
          });
          return (
            missing === reported &&
            g.gaps === seqs.filter((s, i) => i > 0 && s !== seqs[i - 1]! + 1).length
          );
        },
      ),
    );
  });
});

const meta = { source: 's', exchangeTs: 1, receivedTs: 1 };
const snap = (
  seq: number,
  bids: Array<[string, string]>,
  asks: Array<[string, string]>,
): DepthSnapshot => ({ type: 'depth_snapshot', symbol: 'X', bids, asks, seq, ...meta });
const delta = (
  seq: number,
  bids: Array<[string, string]>,
  asks: Array<[string, string]>,
  prevSeq?: number,
): DepthDelta => ({
  type: 'depth_delta',
  symbol: 'X',
  bids,
  asks,
  seq,
  ...(prevSeq === undefined ? {} : { prevSeq }),
  ...meta,
});

describe('OrderBook', () => {
  it('applies snapshot + contiguous deltas, removes zero levels, sorts best first', () => {
    const b = new OrderBook('X');
    expect(b.applyDelta(delta(1, [], []))).toBe('no_snapshot');
    expect(b.snapshot(5, 0)).toBeNull();
    b.applySnapshot(
      snap(
        10,
        [
          ['99', '1'],
          ['100', '2'],
        ],
        [
          ['101', '1'],
          ['102', '3'],
        ],
      ),
    );
    expect(
      b.applyDelta(
        delta(
          11,
          [
            ['100', '0'],
            ['98.5', '4'],
          ],
          [['100.5', '1']],
        ),
      ),
    ).toBe('ok');
    expect(b.top(2)).toEqual({
      bids: [
        ['99', '1'],
        ['98.5', '4'],
      ],
      asks: [
        ['100.5', '1'],
        ['101', '1'],
      ],
    });
    expect(b.applyDelta(delta(11, [], []))).toBe('stale');
    expect(b.applyDelta(delta(13, [], []))).toBe('gap');
    expect(b.seq).toBe(11);
    expect(b.snapshot(1, 99)).toMatchObject({
      type: 'depth_snapshot',
      seq: 11,
      receivedTs: 99,
      bids: [['99', '1']],
    });
    b.clear();
    expect(b.seq).toBeNull();
  });

  it('accepts overlapping ranged deltas (prevSeq) and flags real gaps', () => {
    const b = new OrderBook('X');
    b.applySnapshot(snap(1002, [['10', '1']], [['11', '1']]));
    expect(b.applyDelta(delta(1003, [['10', '2']], [], 1000))).toBe('ok');
    expect(b.applyDelta(delta(1004, [], [], 1003))).toBe('ok');
    expect(b.applyDelta(delta(1012, [], [], 1009))).toBe('gap');
  });

  it('diffDepth produces a delta that rebuilds the next book', () => {
    const a = snap(
      1,
      [
        ['10', '1'],
        ['9', '1'],
      ],
      [['11', '1']],
    );
    const n = snap(
      2,
      [
        ['10', '3'],
        ['8', '1'],
      ],
      [
        ['11', '1'],
        ['12', '2'],
      ],
    );
    const d = diffDepth(a, n, '0');
    const b = new OrderBook('X');
    b.applySnapshot(a);
    expect(b.applyDelta(d)).toBe('ok');
    expect(b.top(10)).toEqual({ bids: n.bids, asks: n.asks });
  });
});

class FakeClock implements ConflatorClock {
  t = 0;
  private timers: Array<{ at: number; fn: () => void; id: number }> = [];
  private next = 1;
  now() {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number) {
    const id = this.next++;
    this.timers.push({ at: this.t + ms, fn, id });
    return id;
  }
  clearTimeout(h: unknown) {
    this.timers = this.timers.filter((x) => x.id !== h);
  }
  advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at);
      const t = this.timers[0];
      if (!t || t.at > end) break;
      this.timers.shift();
      this.t = t.at;
      t.fn();
    }
    this.t = end;
  }
}

describe('Conflator (token bucket: 10/s sustained, burst 2)', () => {
  it('passes a steady 10 Hz stream through with no delay, even with jitter', () => {
    const clock = new FakeClock();
    const out: Array<[number, number]> = [];
    const c = new Conflator<number>((_, v) => out.push([clock.t, v]), 10, 2, clock);
    const arrivals: number[] = [];
    let t = 0;
    for (let i = 0; i < 100; i++) {
      t = i * 100 + (i % 3 === 0 ? 40 : i % 3 === 1 ? -40 : 0); // ±40 ms jitter
      arrivals.push(t);
    }
    for (const [i, at] of arrivals.entries()) {
      clock.advance(at - clock.t);
      c.offer('q', i);
    }
    expect(out).toHaveLength(100);
    expect(out.every(([sentAt, v]) => sentAt === arrivals[v])).toBe(true);
    expect(c.conflated).toBe(0);
  });

  it('property: never more than 10·T/1000 + 2 sends in any window T, and the last value is always delivered', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 150 }), { minLength: 1, maxLength: 300 }),
        (gaps) => {
          const clock = new FakeClock();
          const sends: Array<[number, number]> = [];
          const c = new Conflator<number>((_, v) => sends.push([clock.t, v]), 10, 2, clock);
          gaps.forEach((g, i) => {
            clock.advance(g);
            c.offer('q', i);
          });
          clock.advance(2000);
          for (let i = 0; i < sends.length; i++) {
            for (let j = i + 1; j < sends.length; j++) {
              const count = j - i + 1;
              if (count > (10 * (sends[j]![0] - sends[i]![0])) / 1000 + 2 + 1e-9) return false;
            }
          }
          const vals = sends.map((s) => s[1]);
          return (
            vals.at(-1) === gaps.length - 1 && vals.every((v, i) => i === 0 || v > vals[i - 1]!)
          );
        },
      ),
      { numRuns: 200 },
    );
  });

  it('drop() cancels pending values; close() clears all; rejects bad config', () => {
    const clock = new FakeClock();
    const out: number[] = [];
    const c = new Conflator<number>((_, v) => out.push(v), 1, 1, clock);
    c.offer('a', 1);
    c.offer('a', 2);
    c.offer('a', 3);
    expect(c.conflated).toBe(1);
    c.drop('a');
    c.offer('b', 1);
    c.offer('b', 2);
    c.close();
    clock.advance(5000);
    expect(out).toEqual([1, 1]);
    expect(() => new Conflator(() => undefined, 0)).toThrow(RangeError);
    expect(() => new Conflator(() => undefined, 10, 0)).toThrow(RangeError);
    expect(typeof systemClock.now()).toBe('number');
    const h = systemClock.setTimeout(() => undefined, 1000);
    systemClock.clearTimeout(h);
  });

  it('a held value is flushed as soon as a token refills', () => {
    const clock = new FakeClock();
    const out: Array<[number, number]> = [];
    const c = new Conflator<number>((_, v) => out.push([clock.t, v]), 10, 2, clock);
    for (let i = 0; i < 5; i++) c.offer('q', i); // burst of 5 at t=0
    clock.advance(1000);
    expect(out).toEqual([
      [0, 0],
      [0, 1],
      [100, 4],
    ]);
  });
});

import { describe, expect, it } from 'vitest';

import { atr, bollinger, ema, rsi, sma, trueRange, vwapSeries as vwap, type OhlcvBar } from './indicators.js';

/**
 * Reference series. The SMA/EMA and RSI series are the widely reproduced StockCharts
 * "ChartSchool" worked examples (published values rounded to 2 dp). ATR, Bollinger and VWAP are
 * checked against small hand-computed series (working shown in the comments) and against a naive
 * re-implementation of the textbook definition on a longer series.
 */

// StockCharts EMA/SMA example: 30 closes, 10-day SMA and EMA.
const CLOSES_EMA = [
  22.27, 22.19, 22.08, 22.17, 22.18, 22.13, 22.23, 22.43, 22.24, 22.29, 22.15, 22.39, 22.38, 22.61, 23.36, 24.05, 23.75, 23.83, 23.95, 23.63,
  23.82, 23.87, 23.65, 23.19, 23.1, 23.33, 22.68, 23.1, 22.4, 22.17,
];
const SMA10 = [22.22, 22.21, 22.23, 22.26, 22.3, 22.42, 22.61, 22.77, 22.91, 23.08, 23.21, 23.38, 23.53, 23.65, 23.71, 23.68, 23.61, 23.51, 23.43, 23.28, 23.13];
const EMA10 = [22.22, 22.21, 22.24, 22.27, 22.33, 22.52, 22.8, 22.97, 23.13, 23.28, 23.34, 23.43, 23.51, 23.54, 23.47, 23.4, 23.39, 23.26, 23.23, 23.08, 22.92];

// StockCharts RSI example (Wilder, 14 periods): 33 closes, RSI from index 14.
const CLOSES_RSI = [
  44.3389, 44.0902, 44.1497, 43.6124, 44.3278, 44.8264, 45.0955, 45.4245, 45.8433, 46.0826, 45.8931, 46.0328, 45.614, 46.282, 46.282, 46.0028,
  46.0328, 46.4116, 46.2222, 45.6439, 46.2122, 46.2521, 45.7137, 46.4515, 45.7835, 45.3548, 44.0288, 44.1783, 44.2181, 44.5672, 43.4205, 42.6628,
  43.1314,
];
const RSI14 = [70.53, 66.32, 66.55, 69.41, 66.36, 57.97, 62.93, 63.26, 56.06, 62.38, 54.71, 50.42, 39.99, 41.46, 41.87, 45.46, 37.3, 33.08, 37.77];

const tail = (s: Array<number | null>, from: number) => s.slice(from).map((v) => (v === null ? null : Math.round(v * 100) / 100));

describe('sma / ema (StockCharts reference)', () => {
  it('10-day SMA matches the published values', () => {
    const s = sma(CLOSES_EMA, 10);
    expect(s.slice(0, 9).every((v) => v === null)).toBe(true);
    const got = s.slice(9);
    got.forEach((v, i) => expect(Math.abs(v! - SMA10[i]!)).toBeLessThanOrEqual(0.006));
  });

  it('10-day EMA matches the published values (±0.01)', () => {
    const got = tail(ema(CLOSES_EMA, 10), 9);
    got.forEach((v, i) => expect(Math.abs(v! - EMA10[i]!)).toBeLessThanOrEqual(0.011));
  });

  it('warm-up and short input', () => {
    expect(ema([1, 2], 3)).toEqual([null, null]);
    expect(sma([5], 1)).toEqual([5]);
    expect(() => sma([1], 0)).toThrow(RangeError);
    expect(() => ema([1], 1.5)).toThrow(RangeError);
  });
});

describe('rsi (Wilder, StockCharts reference)', () => {
  it('14-period RSI matches the published values (±0.02)', () => {
    const r = rsi(CLOSES_RSI, 14);
    expect(r.slice(0, 14).every((v) => v === null)).toBe(true);
    tail(r, 14).forEach((v, i) => expect(Math.abs(v! - RSI14[i]!)).toBeLessThanOrEqual(0.02));
  });

  it('flat and one-way series', () => {
    expect(rsi([1, 1, 1, 1], 3)[3]).toBe(50);
    expect(rsi([1, 2, 3, 4, 5], 3)[4]).toBe(100);
    expect(rsi([5, 4, 3, 2, 1], 3)[4]).toBe(0);
    expect(rsi([1, 2], 3)).toEqual([null, null]);
  });
});

describe('bollinger', () => {
  it('hand-computed 4-period bands (population sd)', () => {
    // Window [2,4,4,4] mean 3.5; deviations -1.5,.5,.5,.5; ss = 2.25+.25*3 = 3; var .75; sd .8660254
    // Window [4,4,4,5] mean 4.25; ss = .0625*3 + .5625 = .75; var .1875; sd .4330127
    const b = bollinger([2, 4, 4, 4, 5], 4, 2);
    expect(b.middle[3]).toBeCloseTo(3.5, 10);
    expect(b.upper[3]).toBeCloseTo(3.5 + 2 * 0.8660254, 6);
    expect(b.lower[3]).toBeCloseTo(3.5 - 2 * 0.8660254, 6);
    expect(b.middle[4]).toBeCloseTo(4.25, 10);
    expect(b.upper[4]).toBeCloseTo(4.25 + 2 * 0.4330127, 6);
    expect(b.upper[2]).toBeNull();
  });

  it('matches a naive definition on the reference closes', () => {
    const b = bollinger(CLOSES_EMA, 20, 2);
    for (let i = 19; i < CLOSES_EMA.length; i++) {
      const w = CLOSES_EMA.slice(i - 19, i + 1);
      const m = w.reduce((a, c) => a + c, 0) / 20;
      const sd = Math.sqrt(w.reduce((a, c) => a + (c - m) ** 2, 0) / 20);
      expect(b.upper[i]).toBeCloseTo(m + 2 * sd, 10);
      expect(b.lower[i]).toBeCloseTo(m - 2 * sd, 10);
    }
  });
});

const bar = (t: number, high: number, low: number, close: number, volume = 0): OhlcvBar => ({ t, high, low, close, volume });

describe('atr', () => {
  // TR: bar0 = 2 (12-10); bar1 = max(13-11, |13-11|, |11-11|) = 2; bar2 = max(1, |12-12.5|... ) see below
  const bars = [bar(0, 12, 10, 11), bar(1, 13, 11, 12.5), bar(2, 12, 11, 11.5), bar(3, 15, 12, 14), bar(4, 14, 13, 13.5)];
  it('true range uses the previous close', () => {
    // bar2: H-L 1, |H-pc| = |12-12.5| = .5, |L-pc| = |11-12.5| = 1.5 → 1.5
    // bar3: H-L 3, |15-11.5| = 3.5, |12-11.5| = .5 → 3.5
    // bar4: H-L 1, |14-14| = 0, |13-14| = 1 → 1
    expect(trueRange(bars)).toEqual([2, 2, 1.5, 3.5, 1]);
  });

  it('3-period Wilder ATR by hand', () => {
    // seed = (2+2+1.5)/3 = 1.8333…; next = (1.8333·2 + 3.5)/3 = 2.3888…; next = (2.3888·2 + 1)/3 = 1.9259…
    const a = atr(bars, 3);
    expect(a.slice(0, 2)).toEqual([null, null]);
    expect(a[2]).toBeCloseTo(5.5 / 3, 10);
    expect(a[3]).toBeCloseTo(((5.5 / 3) * 2 + 3.5) / 3, 10);
    expect(a[4]).toBeCloseTo(((((5.5 / 3) * 2 + 3.5) / 3) * 2 + 1) / 3, 10);
    expect(atr(bars.slice(0, 2), 3)).toEqual([null, null]);
  });
});

describe('vwap', () => {
  it('cumulative typical price × volume, reset each UTC day', () => {
    const day = 86_400_000;
    const bars = [bar(0, 11, 9, 10, 100), bar(60_000, 12, 10, 11, 300), bar(day, 20, 18, 19, 50), bar(day + 60_000, 21, 19, 20, 0)];
    const v = vwap(bars);
    // tp0 = 10, tp1 = 11 → (1000 + 3300) / 400 = 10.75
    expect(v[0]).toBeCloseTo(10, 10);
    expect(v[1]).toBeCloseTo(10.75, 10);
    // new day: tp = 19
    expect(v[2]).toBeCloseTo(19, 10);
    expect(v[3]).toBeCloseTo(19, 10);
    expect(vwap([bar(0, 1, 1, 1, 0)])).toEqual([null]);
  });
});

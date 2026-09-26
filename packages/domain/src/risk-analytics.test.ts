import { describe, expect, it } from 'vitest';

import { dec } from './decimal.js';
import { correlationClusters, historicalVar, netExposureByCurrency, pearson, quantile, simpleReturns, VAR_MIN_OBSERVATIONS } from './risk-analytics.js';

describe('net exposure by currency', () => {
  const rates: Record<string, string> = { USD: '1', EUR: '1.1', JPY: '0.0068' };
  const toBase = (c: string) => (rates[c] ? dec(rates[c]) : null);

  it('FX pairs expose both legs; equities expose their quote currency', () => {
    const r = netExposureByCurrency(
      [
        { symbol: 'EURUSD', qty: '100000', price: '1.1', multiplier: '1', baseCcy: 'EUR', quoteCcy: 'USD' },
        { symbol: 'AAPL', qty: '100', price: '200', multiplier: '1', baseCcy: null, quoteCcy: 'USD' },
        { symbol: 'USDJPY', qty: '-50000', price: '150', multiplier: '1', baseCcy: 'USD', quoteCcy: 'JPY' },
      ],
      toBase,
    );
    const by = Object.fromEntries(r.map((e) => [e.currency, e]));
    // EUR: +100,000 → 110,000 USD
    expect(by.EUR).toEqual({ currency: 'EUR', amount: '100000', amountBase: '110000.00' });
    // USD: −110,000 (EURUSD) + 20,000 (AAPL) − 50,000 (short USDJPY) = −140,000
    expect(by.USD!.amount).toBe('-140000');
    // JPY: +7,500,000 → 51,000 USD
    expect(by.JPY).toEqual({ currency: 'JPY', amount: '7500000', amountBase: '51000.00' });
    expect(r[0]!.currency).toBe('USD'); // largest absolute base amount first
  });

  it('flat currencies drop out; unknown FX leaves amountBase null', () => {
    const r = netExposureByCurrency(
      [
        { symbol: 'X', qty: '10', price: '5', multiplier: '1', baseCcy: null, quoteCcy: 'ZAR' },
        { symbol: 'Y', qty: '-10', price: '5', multiplier: '1', baseCcy: null, quoteCcy: 'USD' },
        { symbol: 'Z', qty: '10', price: '5', multiplier: '1', baseCcy: null, quoteCcy: 'USD' },
      ],
      toBase,
    );
    expect(r).toEqual([{ currency: 'ZAR', amount: '50', amountBase: null }]);
  });
});

describe('historical VaR', () => {
  it('type-7 quantile matches numpy', () => {
    // numpy.quantile([1,2,3,4,5,6,7,8,9,10], 0.05) = 1.45
    expect(quantile([10, 9, 8, 7, 6, 5, 4, 3, 2, 1], 0.05)).toBeCloseTo(1.45, 12);
    expect(quantile([3], 0.5)).toBe(3);
    expect(() => quantile([], 0.5)).toThrow(RangeError);
    expect(() => quantile([1], 2)).toThrow(RangeError);
  });

  it('revalues today’s positions on aligned returns', () => {
    // 20 returns: −10 %, −9 %, …, +9 %; one long position worth 1,000.
    const rets = Array.from({ length: 20 }, (_, i) => (i - 10) / 100);
    const r = historicalVar({ positions: [{ symbol: 'A', valueBase: 1000 }], returns: { A: rets } });
    // P&L sorted −100…+90 step 10; 5 % quantile at h = 19·0.05 = 0.95 → −100 + .95·10 = −90.5 → VaR 90.50
    expect(r).toMatchObject({ method: 'historical', confidence: 0.95, horizonDays: 1, value: '90.50', observations: 20, required: VAR_MIN_OBSERVATIONS });
    // A short of the same size loses on the up moves: 5 % quantile of −P&L series → 80.50
    expect(historicalVar({ positions: [{ symbol: 'A', valueBase: -1000 }], returns: { A: rets } }).value).toBe('80.50');
  });

  it('short history or no positions', () => {
    expect(historicalVar({ positions: [{ symbol: 'A', valueBase: 1 }], returns: { A: [0.01, 0.02] } })).toMatchObject({ value: null, observations: 2 });
    expect(historicalVar({ positions: [{ symbol: 'A', valueBase: 1 }], returns: {} }).value).toBeNull();
    expect(historicalVar({ positions: [], returns: {} })).toMatchObject({ value: '0.00', observations: 0 });
    // A hedge that never loses has zero VaR (floored).
    const up = Array.from({ length: 25 }, () => 0.01);
    expect(historicalVar({ positions: [{ symbol: 'A', valueBase: 100 }], returns: { A: up } }).value).toBe('0.00');
  });
});

describe('correlation clusters', () => {
  it('pearson and single-linkage clusters at |ρ| ≥ 0.7', () => {
    const a = [0.01, -0.02, 0.03, -0.01, 0.02, 0.0];
    const b = a.map((x) => 2 * x + 0.001); // ρ = 1
    const c = a.map((x) => -x); // ρ = −1 (hedge: still one risk cluster)
    const d = [0.01, 0.01, -0.01, -0.01, 0.01, -0.01];
    expect(pearson(a, b)).toBeCloseTo(1, 12);
    expect(pearson(a, [1, 1, 1, 1, 1, 1])).toBeNull();
    expect(pearson([1, 2], [2, 1])).toBeNull();
    const r = correlationClusters({ B: b, A: a, C: c, D: d });
    expect(r.symbols).toEqual(['A', 'B', 'C', 'D']);
    expect(r.matrix[0]![0]).toBe(1);
    expect(r.matrix[0]![2]).toBe(-1);
    expect(r.clusters).toEqual([['A', 'B', 'C']]);
    const sr = simpleReturns([100, 110, 99, 0, 5]);
    expect(sr).toHaveLength(3);
    [0.1, -0.1, -1].forEach((v, i) => expect(sr[i]).toBeCloseTo(v, 12));
  });
});

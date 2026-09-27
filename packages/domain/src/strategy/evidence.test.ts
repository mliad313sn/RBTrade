import { describe, expect, it } from 'vitest';

import {
  deflatedSharpe,
  expectedMaxSharpe,
  normCdf,
  normInv,
  probabilisticSharpe,
  trialSharpeVariance,
} from './dsr.js';
import { evidenceEligibility, holdoutDeflatedSharpe } from './evidence.js';

describe('deflated Sharpe (TS port of bt/dsr.py, IRTC R3-02)', () => {
  it('reproduces the Bailey & López de Prado (2014) example: SR0 0.1132, DSR 0.9004', () => {
    const { dsr, sr0 } = deflatedSharpe(2.5 / Math.sqrt(250), 1250, -3, 10, 100, 0.5 / 250);
    expect(sr0).toBeCloseTo(0.1132, 4);
    expect(dsr!).toBeCloseTo(0.9004, 4);
  });

  it('normal helpers are accurate and inverse of each other', () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 7);
    expect(normCdf(1.959963985)).toBeCloseTo(0.975, 6);
    for (const p of [0.001, 0.02, 0.3, 0.5, 0.9, 0.99, 0.9999])
      expect(normCdf(normInv(p))).toBeCloseTo(p, 7);
    expect(normInv(0)).toBe(-Infinity);
    expect(normInv(1)).toBe(Infinity);
    expect(Number.isNaN(normInv(2))).toBe(true);
  });

  it('PSR and expected max behave like the Python reference', () => {
    expect(probabilisticSharpe(0.1, 0.1, 500, 0, 3)).toBeCloseTo(0.5, 7);
    expect(probabilisticSharpe(0.1, 0, 1, 0, 3)).toBeNull();
    expect(probabilisticSharpe(3, 0, 100, 5, 3)).toBeNull();
    expect(expectedMaxSharpe(1, 1)).toBe(0);
    expect(expectedMaxSharpe(0, 50)).toBe(0);
    const a = deflatedSharpe(0.08, 750, 0, 3, 1, 0.001).dsr!;
    const b = deflatedSharpe(0.08, 750, 0, 3, 50, 0.001).dsr!;
    expect(a).toBeGreaterThan(b);
    expect(trialSharpeVariance([1])).toBe(0);
    expect(trialSharpeVariance([1, 3])).toBe(2);
  });
});

describe('promotion evidence rules (IRTC R3-02)', () => {
  const universe = ['BTCUSD'];

  it('only a server-chosen backtest (universe, all history, default split, registry costs, own params) is evidence', () => {
    expect(evidenceEligibility('backtest', { split: { oosFraction: 0.3 } }, universe)).toEqual({
      eligible: true,
      reasons: [],
    });
    expect(evidenceEligibility('backtest', { symbols: ['BTCUSD'] }, universe).eligible).toBe(true);
    const gamed = evidenceEligibility(
      'backtest',
      {
        symbols: ['ETHUSD'],
        from: 1,
        split: { oosFraction: 0.2 },
        paramOverrides: { fast: 7 },
        spreadTicks: 0,
      },
      universe,
    );
    expect(gamed.eligible).toBe(false);
    expect(gamed.reasons).toEqual([
      'symbols_override',
      'custom_window',
      'custom_split',
      'param_overrides',
      'cost_override',
    ]);
    expect(evidenceEligibility('optimise', {}, universe).reasons).toEqual(['not_a_backtest']);
    expect(
      evidenceEligibility('backtest', { split: { oosStart: 5, oosFraction: 0.3 } }, universe)
        .reasons,
    ).toEqual(['custom_split']);
  });

  it('a noise-level holdout with a high point Sharpe fails the deflated test once trials are counted', () => {
    // e_split (IRTC R3 report): OOS Sharpe 4.28 annualised on about 50 days of a driftless random walk.
    const noise = {
      oosSharpe: 4.28,
      oosTrades: 120,
      oosPeriodSharpe: 4.28 / Math.sqrt(365),
      oosObservations: 50,
      oosSkew: 0,
      oosKurtosis: 3,
    };
    const one = holdoutDeflatedSharpe(noise, { count: 1, periodSharpes: [] });
    const many = holdoutDeflatedSharpe(noise, {
      count: 16,
      periodSharpes: [-0.1, 0.05, 0.2, -0.15, 0.12, 0.3, -0.05, 0.08],
    });
    expect(one.dsr!).toBeLessThan(0.95);
    expect(many.dsr!).toBeLessThan(one.dsr!);
    expect(many.trials).toBe(16);
    expect(holdoutDeflatedSharpe(null, { count: 0, periodSharpes: [] })).toMatchObject({
      dsr: null,
      trials: 1,
    });
  });
});

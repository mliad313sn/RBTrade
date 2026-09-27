import { describe, expect, it } from 'vitest';

import { buildBins, calibrationView } from './calibration';
import { clusteredEdge, MIN_EDGE_CLUSTERS, type EdgeObservation } from './edge-stat';

const H = 3_600_000;

/** Deterministic PRNG (mulberry32) and standard normals (Box–Muller). */
function rng(seed: number) {
  let a = seed >>> 0;
  const u = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const n = () => Math.sqrt(-2 * Math.log(u() || 1e-12)) * Math.cos(2 * Math.PI * u());
  return { u, n };
}

/**
 * The IRTC R3-03 no-skill world: 8 instruments of one region (pairwise correlation 0.5), 1h bars,
 * a 24-bar horizon, and a forecast on every bar of every instrument (what the calibration table
 * holds after 24 hourly re-scans replayed shifted phases, or from live per-bar forecasts). The
 * direction is past 24-bar momentum: persistent and shared like a model's forecasts, with no skill
 * on a random walk, so the true edge is exactly zero (no cost, so the null mean is 0).
 */
function noSkillWorld(seed: number, bars = 2424, instruments = 8, h = 24) {
  const r = rng(seed);
  const t0 = Date.UTC(2026, 0, 5);
  const common = Array.from({ length: bars + h }, () => r.n());
  const rows: Array<EdgeObservation & { predicted: number; outcome: boolean }> = [];
  for (let i = 0; i < instruments; i++) {
    const logp = [0];
    for (let k = 0; k < bars + h; k++)
      logp.push(logp[k]! + 0.004 * (Math.SQRT1_2 * common[k]! + Math.SQRT1_2 * r.n()));
    for (let k = h; k < bars; k++) {
      // Past momentum: persistent across bars and shared across the region, but no skill on a
      // random walk (the future move is independent of the past).
      const up = logp[k]! - logp[k - h]! >= 0;
      const move = Math.exp(logp[k + h]! - logp[k]!) - 1;
      const net = up ? move : -move;
      rows.push({
        predicted: 0.5 + 0.49 * r.u(),
        outcome: net > 0,
        netReturn: net,
        predictedAt: t0 + k * H,
        resolvedAt: t0 + (k + h) * H,
      });
    }
  }
  return rows;
}

describe('edge after costs accounts for overlapping and cross-correlated predictions (IRTC R3-03)', () => {
  it('keeps the false "positive edge" rate near nominal in a no-skill world (pooled test does not)', () => {
    const seeds = 120;
    let pooledPositive = 0;
    let clusteredPositive = 0;
    const pooledT: number[] = [];
    const clusteredT: number[] = [];
    for (let s = 1; s <= seeds; s++) {
      const rows = noSkillWorld(s);
      const pooled = calibrationView('trend:test:1d', buildBins(rows), { minN: 30 });
      const edge = clusteredEdge(rows);
      expect(edge.clusters).toBeGreaterThanOrEqual(MIN_EDGE_CLUSTERS);
      const clustered = calibrationView('trend:test:1d', buildBins(rows), {
        minN: 30,
        edgeStat: edge,
      });
      if (pooled.edge === 'positive') pooledPositive += 1;
      if (clustered.edge === 'positive') clusteredPositive += 1;
      pooledT.push(pooled.tStat ?? 0);
      clusteredT.push(edge.tStat ?? 0);
    }
    const sd = (xs: number[]) => {
      const m = xs.reduce((a, b) => a + b, 0) / xs.length;
      return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
    };
    // Nominal one-sided rate for t >= 2 is about 2.3 %. The pooled row-count test is far above it.
    expect(pooledPositive / seeds).toBeGreaterThan(0.15);
    expect(sd(pooledT)).toBeGreaterThan(3);
    expect(clusteredPositive / seeds).toBeLessThanOrEqual(0.06);
    expect(sd(clusteredT)).toBeLessThan(1.4);
  });

  it('uses time buckets of one horizon as the effective sample size', () => {
    const rows = noSkillWorld(7, 264);
    const e = clusteredEdge(rows);
    expect(e.method).toBe('time_bucket_hac');
    expect(e.n).toBe(8 * 240);
    expect(e.bucketMs).toBe(24 * H);
    expect(e.clusters).toBe(10);
    expect(e.lag).toBe(1);
    // Fewer than MIN_EDGE_CLUSTERS buckets can never be called a positive edge.
    const v = calibrationView('trend:test:1d', buildBins(rows), {
      minN: 30,
      edgeStat: { ...e, tStat: 50, mean: 0.01 },
    });
    expect(e.clusters).toBeLessThan(MIN_EDGE_CLUSTERS);
    expect(v.edge).toBe('insufficient_data');
  });

  it('a real, persistent edge is still detected', () => {
    const rows = noSkillWorld(3, 2000).map((r) => ({
      ...r,
      netReturn: r.netReturn! + 0.01,
    }));
    const e = clusteredEdge(rows);
    const v = calibrationView('trend:test:1d', buildBins(rows), { minN: 30, edgeStat: e });
    expect(e.clusters).toBeGreaterThanOrEqual(MIN_EDGE_CLUSTERS);
    expect(v.edge).toBe('positive');
  });

  it('handles empty, single-bucket and instantaneous rows', () => {
    expect(clusteredEdge([])).toMatchObject({ clusters: 0, mean: null, tStat: null });
    const one = clusteredEdge([{ netReturn: 0.1, predictedAt: 1, resolvedAt: 2 }]);
    expect(one).toMatchObject({ clusters: 1, mean: 0.1, tStat: null });
    const inst = clusteredEdge([
      { netReturn: 0.1, predictedAt: 1, resolvedAt: null },
      { netReturn: 0.3, predictedAt: 1, resolvedAt: 1 },
      { netReturn: -0.1, predictedAt: 5, resolvedAt: null },
      { netReturn: null, predictedAt: 9, resolvedAt: null },
    ]);
    expect(inst).toMatchObject({ n: 3, clusters: 2, bucketMs: 0, lag: 0 });
  });
});

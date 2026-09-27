/**
 * Calibration maths (goal 07 §4; reused by 07B). A confidence figure is only ever the observed hit
 * rate of past predictions in the same score bin, read from the calibration table — never a number
 * the model produced. "Edge" is judged on results net of costs.
 */

import { MIN_EDGE_CLUSTERS, type ClusteredEdge } from './edge-stat';

export interface PredictionOutcome {
  predicted: number;
  outcome: boolean;
  /** Result after costs (R multiple or return); positive = made money after costs. */
  netReturn: number | null;
}

export interface CalibrationBin {
  bin: number;
  lo: number;
  hi: number;
  n: number;
  hits: number;
  meanPredicted: number | null;
  meanNetReturn: number | null;
  netReturnSd: number | null;
}

export const BIN_COUNT = 10;

export function binIndex(p: number): number {
  if (!Number.isFinite(p)) return 0;
  return Math.min(BIN_COUNT - 1, Math.max(0, Math.floor(p * BIN_COUNT)));
}

const r6 = (x: number) => Math.round(x * 1e6) / 1e6;

export function buildBins(rows: readonly PredictionOutcome[]): CalibrationBin[] {
  const bins: CalibrationBin[] = Array.from({ length: BIN_COUNT }, (_, i) => ({
    bin: i,
    lo: i / BIN_COUNT,
    hi: (i + 1) / BIN_COUNT,
    n: 0,
    hits: 0,
    meanPredicted: null,
    meanNetReturn: null,
    netReturnSd: null,
  }));
  const acc = bins.map(() => ({ p: 0, r: [] as number[] }));
  for (const row of rows) {
    const i = binIndex(row.predicted);
    bins[i]!.n += 1;
    if (row.outcome) bins[i]!.hits += 1;
    acc[i]!.p += row.predicted;
    if (row.netReturn !== null && Number.isFinite(row.netReturn)) acc[i]!.r.push(row.netReturn);
  }
  bins.forEach((b, i) => {
    const a = acc[i]!;
    if (b.n) b.meanPredicted = r6(a.p / b.n);
    if (a.r.length) {
      const m = a.r.reduce((x, y) => x + y, 0) / a.r.length;
      b.meanNetReturn = r6(m);
      b.netReturnSd =
        a.r.length > 1
          ? r6(Math.sqrt(a.r.reduce((x, y) => x + (y - m) ** 2, 0) / (a.r.length - 1)))
          : 0;
    }
  });
  return bins;
}

export type Edge = 'positive' | 'none' | 'insufficient_data';

export interface CalibrationView {
  modelKey: string;
  n: number;
  hitRate: number | null;
  meanNetReturn: number | null;
  tStat: number | null;
  edge: Edge;
  edgeStatement: string;
  /** The calibrated confidence for `rawScore`, or null (no score, or its bin is too small). */
  confidence: { value: number; n: number; saidAs: number; bin: number } | null;
  reliabilityLine: string | null;
  minN: number;
  bins: CalibrationBin[];
  source: string | null;
  updatedAt: string | null;
  /** Effective sample size of the edge test (time buckets, IRTC R3-03); null = pooled rows. */
  edgeClusters?: number | null;
  /** Time buckets a positive edge needs (MIN_EDGE_CLUSTERS), so statements quoting it trace to data. */
  minEdgeClusters?: number;
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const r4 = (x: number) => Math.round(x * 1e4) / 1e4;

export function reliabilityLine(saidAs: number, hitRate: number, n: number): string {
  return `When we said ${Math.round(saidAs * 100) / 100}, it worked ${Math.round(hitRate * 100)}% of the time (n=${n})`;
}

export function calibrationView(
  modelKey: string,
  bins: readonly CalibrationBin[],
  opts: {
    rawScore?: number | null;
    minN: number;
    source?: string | null;
    updatedAt?: string | null;
    /**
     * IRTC R3-03: the dependence-aware edge statistic (time buckets + HAC). When given it replaces
     * the pooled row-count t-test, and a positive edge needs MIN_EDGE_CLUSTERS buckets. `null`
     * means the dependence is unknown (no statistic built from the rows): the pooled test may still
     * say "none", but never "positive". Omitted = the pooled test alone (pure-maths callers).
     */
    edgeStat?: ClusteredEdge | null;
  },
): CalibrationView {
  const N = bins.reduce((a, b) => a + b.n, 0);
  const hits = bins.reduce((a, b) => a + b.hits, 0);
  // Pooled mean / variance of net returns from per-bin moments.
  const withR = bins.filter((b) => b.meanNetReturn !== null && b.n > 0);
  const nR = withR.reduce((a, b) => a + b.n, 0);
  let mean: number | null = null;
  let t: number | null = null;
  if (nR > 0) {
    mean = withR.reduce((a, b) => a + b.n * b.meanNetReturn!, 0) / nR;
    if (nR > 1) {
      const ss = withR.reduce(
        (a, b) => a + (b.n - 1) * (b.netReturnSd ?? 0) ** 2 + b.n * (b.meanNetReturn! - mean!) ** 2,
        0,
      );
      const sd = Math.sqrt(ss / (nR - 1));
      t = sd > 0 ? (mean / sd) * Math.sqrt(nR) : mean > 0 ? Infinity : 0;
    }
  }
  const es = opts.edgeStat;
  if (es) {
    mean = es.mean;
    t = es.tStat;
  }
  let edge: Edge;
  if (N < opts.minN || mean === null) edge = 'insufficient_data';
  else if (!(mean > 0 && (t ?? 0) >= 2)) edge = 'none';
  else if (es === null || (es && es.clusters < MIN_EDGE_CLUSTERS)) edge = 'insufficient_data';
  else edge = 'positive';
  const edgeStatement =
    edge === 'none'
      ? 'No edge after costs.'
      : edge !== 'insufficient_data'
        ? 'Positive after costs on past predictions, which does not guarantee future results.'
        : N < opts.minN || mean === null
          ? `Not enough history to judge an edge (n=${N}, need ${opts.minN}).`
          : es
            ? `Not enough independent history to judge an edge (${es.clusters} time buckets, need ${MIN_EDGE_CLUSTERS}).`
            : 'Not enough independent history to judge an edge: the dependence between past predictions has not been measured yet.';

  let confidence: CalibrationView['confidence'] = null;
  let line: string | null = null;
  if (opts.rawScore !== undefined && opts.rawScore !== null && Number.isFinite(opts.rawScore)) {
    const b = bins[binIndex(opts.rawScore)];
    if (b && b.n >= opts.minN && b.meanPredicted !== null) {
      const value = r2(b.hits / b.n);
      confidence = { value, n: b.n, saidAs: r2(b.meanPredicted), bin: b.bin };
      line = reliabilityLine(b.meanPredicted, b.hits / b.n, b.n);
    }
  }
  return {
    modelKey,
    n: N,
    hitRate: N ? r4(hits / N) : null,
    meanNetReturn: mean === null ? null : r4(mean),
    tStat: t === null ? null : Number.isFinite(t) ? r2(t) : null,
    edge,
    edgeStatement,
    confidence,
    reliabilityLine: line,
    minN: opts.minN,
    bins: [...bins],
    source: opts.source ?? null,
    updatedAt: opts.updatedAt ?? null,
    edgeClusters: es ? es.clusters : null,
    minEdgeClusters: MIN_EDGE_CLUSTERS,
  };
}

/** Maps a signal's mean condition contribution (−1…1) to a raw score in 0…1. */
export function scoreFromContributions(
  contribs: ReadonlyArray<number | null | undefined>,
): number | null {
  const xs = contribs.filter((c): c is number => typeof c === 'number' && Number.isFinite(c));
  if (!xs.length) return null;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.round(((m + 1) / 2) * 1e5) / 1e5;
}

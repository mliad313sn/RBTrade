/**
 * "Edge after costs" with dependence accounted for (IRTC R3-03).
 *
 * Predictions are not independent: an h-bar forecast made every bar overlaps the next h − 1, and
 * forecasts for instruments of one region at the same time share the market move. Counting every
 * row as an independent draw inflates the t-statistic several-fold (the IRTC no-skill simulation
 * reached t = 9 on pure noise). This statistic:
 *
 * 1. clusters rows in time buckets of one typical horizon (the median predicted→resolved span), so
 *    every forecast made in the same bucket, on any instrument, is one observation (their mean);
 * 2. treats the bucket means as a time series and takes a HAC (Newey–West style) variance of their
 *    mean, with a lag covering the longest horizon in buckets (overlap between adjacent buckets);
 * 3. reports the number of buckets as the effective sample size.
 *
 * A positive edge then needs t ≥ 2 on this statistic and at least `MIN_EDGE_CLUSTERS` buckets.
 */

export interface EdgeObservation {
  netReturn: number | null;
  /** Epoch ms when the prediction was made. */
  predictedAt: number;
  /** Epoch ms when its outcome was known (null or ≤ predictedAt when unknown / instantaneous). */
  resolvedAt: number | null;
}

export interface ClusteredEdge {
  method: 'time_bucket_hac';
  /** Rows with a finite net return. */
  n: number;
  /** Time buckets (effective, roughly independent observations). */
  clusters: number;
  bucketMs: number;
  lag: number;
  mean: number | null;
  tStat: number | null;
}

/** Fewer buckets than this can never show a positive edge (≈ 30 independent observations). */
export const MIN_EDGE_CLUSTERS = 30;
const MAX_LAG = 10;

export function clusteredEdge(rows: readonly EdgeObservation[]): ClusteredEdge {
  const obs = rows.filter(
    (r): r is EdgeObservation & { netReturn: number } =>
      r.netReturn !== null && Number.isFinite(r.netReturn) && Number.isFinite(r.predictedAt),
  );
  const spans = obs
    .map((r) =>
      r.resolvedAt !== null && r.resolvedAt > r.predictedAt ? r.resolvedAt - r.predictedAt : 0,
    )
    .filter((d) => d > 0)
    .sort((a, b) => a - b);
  const bucketMs = spans.length ? spans[Math.floor(spans.length / 2)]! : 0;
  const lag = bucketMs
    ? Math.min(MAX_LAG, Math.max(1, Math.ceil(spans[spans.length - 1]! / bucketMs)))
    : 0;
  const empty: ClusteredEdge = {
    method: 'time_bucket_hac',
    n: obs.length,
    clusters: 0,
    bucketMs,
    lag,
    mean: null,
    tStat: null,
  };
  if (!obs.length) return empty;

  const sums = new Map<number, { s: number; k: number }>();
  for (const r of obs) {
    const key = bucketMs ? Math.floor(r.predictedAt / bucketMs) : r.predictedAt;
    const b = sums.get(key) ?? { s: 0, k: 0 };
    b.s += r.netReturn;
    b.k += 1;
    sums.set(key, b);
  }
  const keys = [...sums.keys()].sort((a, b) => a - b);
  const x = new Map(keys.map((k) => [k, sums.get(k)!.s / sums.get(k)!.k]));
  const m = keys.length;
  const mean = keys.reduce((a, k) => a + x.get(k)!, 0) / m;
  if (m < 2) return { ...empty, clusters: m, mean };

  // Autocovariances by bucket distance (sparse keys: only pairs exactly l buckets apart).
  const gamma = (l: number) => {
    let s = 0;
    for (const k of keys) {
      const other = x.get(k + l);
      if (other !== undefined) s += (x.get(k)! - mean) * (other - mean);
    }
    return s / m;
  };
  const g0 = gamma(0) * (m / (m - 1));
  let longRun = g0;
  if (bucketMs) {
    // Truncated kernel (exact for the MA(lag) dependence overlapping horizons create); if a sample
    // makes it smaller than the plain variance, keep the plain variance (never deflate the error).
    let acc = g0;
    for (let l = 1; l <= lag; l++) acc += 2 * gamma(l);
    longRun = Math.max(g0, acc);
  }
  const se = Math.sqrt(longRun / m);
  const tStat = se > 0 ? mean / se : mean > 0 ? Infinity : 0;
  return { ...empty, clusters: m, mean, tStat };
}

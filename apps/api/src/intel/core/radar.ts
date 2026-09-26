import type { FeatureRow, TrendKind } from './trend-card';
import { REGION_LABELS, type RadarRegion } from './taxonomy';

/**
 * Market Radar aggregation (goal 07B §6): a heat map by region, asset class or sector and a ranked
 * list of emerging trends, computed from the latest scan's feature rows. Numbers only; colour in the
 * UI is always paired with ▲▼ and +/− text.
 */

export type RadarGroupBy = 'region' | 'assetClass' | 'sector';

export interface RadarFilters {
  region?: RadarRegion;
  assetClass?: string;
  sector?: string;
}

export interface HeatCell {
  key: string;
  label: string;
  instruments: number;
  up: number;
  down: number;
  trending: number;
  /** Mean momentum z-score of the group (signed). */
  meanMomentumZ: number | null;
  top: { symbol: string; momentumZ: number } | null;
}

export interface RankedTrend {
  rank: number;
  symbol: string;
  name: string;
  region: RadarRegion;
  assetClass: string;
  sector: string;
  kind: TrendKind;
  score: number;
  momentumZ: number | null;
  slopeT: number | null;
  regimeTrending: number | null;
  detectedAt: string;
}

export function applyFilters<T extends { region: string; assetClass: string; sector: string }>(
  rows: T[],
  f: RadarFilters,
): T[] {
  return rows.filter(
    (r) =>
      (!f.region || r.region === f.region) &&
      (!f.assetClass || r.assetClass === f.assetClass) &&
      (!f.sector || r.sector === f.sector),
  );
}

const r2 = (x: number) => Math.round(x * 100) / 100;

export function heatMap(rows: FeatureRow[], groupBy: RadarGroupBy): HeatCell[] {
  const groups = new Map<string, FeatureRow[]>();
  for (const row of rows) {
    const key =
      groupBy === 'region' ? row.region : groupBy === 'assetClass' ? row.assetClass : row.sector;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const cells: HeatCell[] = [];
  for (const [key, list] of groups) {
    const moms = list
      .map((x) => ({ symbol: x.symbol, m: x.features.mom_z }))
      .filter(
        (x): x is { symbol: string; m: number } => typeof x.m === 'number' && Number.isFinite(x.m),
      );
    const top = moms.reduce<{ symbol: string; m: number } | null>(
      (best, x) => (!best || Math.abs(x.m) > Math.abs(best.m) ? x : best),
      null,
    );
    cells.push({
      key,
      label:
        groupBy === 'region' ? (REGION_LABELS[key as RadarRegion] ?? key) : key.replace(/_/g, ' '),
      instruments: list.length,
      up: moms.filter((x) => x.m > 0).length,
      down: moms.filter((x) => x.m < 0).length,
      trending: list.filter(
        (x) => x.trend && ['up', 'down', 'breakout_up', 'breakout_down'].includes(x.trend.kind),
      ).length,
      meanMomentumZ: moms.length ? r2(moms.reduce((a, x) => a + x.m, 0) / moms.length) : null,
      top: top ? { symbol: top.symbol, momentumZ: r2(top.m) } : null,
    });
  }
  return cells.sort((a, b) => a.key.localeCompare(b.key));
}

export function rankTrends(
  rows: Array<FeatureRow & { detectedAt: string }>,
  limit = 25,
): RankedTrend[] {
  return rows
    .filter(
      (x): x is FeatureRow & { detectedAt: string; trend: NonNullable<FeatureRow['trend']> } =>
        x.trend !== null,
    )
    .sort((a, b) => b.trend.score - a.trend.score || a.symbol.localeCompare(b.symbol))
    .slice(0, limit)
    .map((x, i) => ({
      rank: i + 1,
      symbol: x.symbol,
      name: x.name,
      region: x.region,
      assetClass: x.assetClass,
      sector: x.sector,
      kind: x.trend.kind,
      score: x.trend.score,
      momentumZ: typeof x.features.mom_z === 'number' ? r2(x.features.mom_z) : null,
      slopeT: typeof x.features.slope_t === 'number' ? r2(x.features.slope_t) : null,
      regimeTrending:
        typeof x.features.regime_trending === 'number' ? r2(x.features.regime_trending) : null,
      detectedAt: x.detectedAt,
    }));
}

/** The biggest movers by |momentum z| (shown even when no trend label fires). */
export function movers(
  rows: FeatureRow[],
  limit = 5,
): Array<{ symbol: string; name: string; momentumZ: number }> {
  return rows
    .map((x) => ({ symbol: x.symbol, name: x.name, m: x.features.mom_z }))
    .filter(
      (x): x is { symbol: string; name: string; m: number } =>
        typeof x.m === 'number' && Number.isFinite(x.m),
    )
    .sort((a, b) => Math.abs(b.m) - Math.abs(a.m))
    .slice(0, limit)
    .map((x) => ({ symbol: x.symbol, name: x.name, momentumZ: r2(x.m) }));
}

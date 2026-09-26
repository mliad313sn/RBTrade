import { Injectable, NotFoundException } from '@nestjs/common';
import { PROVIDER_MATRIX } from '@kora/market-data';

import { CalibrationService } from '../ai/calibration.service';
import { loadAiConfig } from '../ai/core/config';
import { DISCLAIMER } from '../ai/core/types';
import { DbService } from '../db/db.service';
import { InstrumentsRepository } from '../market-data/instruments.repository';
import {
  applyFilters,
  heatMap,
  movers,
  rankTrends,
  type RadarFilters,
  type RadarGroupBy,
} from './core/radar';
import {
  radarRegion,
  RADAR_REGIONS,
  REGION_LABELS,
  sectorOf,
  trendModelKey,
  type RadarRegion,
} from './core/taxonomy';
import {
  buildTrendCard,
  movingItem,
  type FeatureRow,
  type ForecastRow,
  type NewsItem,
  type TrendCard,
  type TrendKind,
} from './core/trend-card';
import { loadIntelConfig } from './intel-config';
import { NEWS_STUBS } from './news-adapters';

export interface RegistryRow {
  symbol: string;
  name: string;
  assetClass: string;
  venue: string;
  region: RadarRegion;
  sector: string;
  currency: string;
  pricePrecision: number;
}

interface FeatureDbRow {
  symbol: string;
  timeframe: string;
  bar_ts: Date | null;
  last_close: number | null;
  features: Record<string, number | null>;
  scan_id: string;
  kind: TrendKind | null;
  score: number | null;
  detected_at: Date | null;
}

interface ForecastDbRow {
  horizon: string;
  horizon_bars: number;
  status: 'ok' | 'insufficient_data';
  direction: 'up' | 'down' | null;
  p_up: number | null;
  p_direction: number | null;
  skill: Record<string, unknown>;
  drivers: ForecastRow['drivers'];
  model_key: string;
  predicted_at: Date | null;
}

export interface NewsQuery {
  symbol?: string;
  region?: RadarRegion;
  hours: number;
  limit: number;
}

/**
 * Reads for the Market Radar, trend cards, news, the novice "What's moving" card and the public
 * reliability page. Everything returned is computed from stored scans, forecasts, calibration rows
 * and news; nothing is generated here.
 */
@Injectable()
export class IntelReadService {
  constructor(
    private readonly db: DbService,
    private readonly repo: InstrumentsRepository,
    private readonly calibration: CalibrationService,
  ) {}

  async registry(): Promise<Map<string, RegistryRow>> {
    const reg = await this.repo.load();
    const out = new Map<string, RegistryRow>();
    for (const spec of reg.instruments.values()) {
      if (spec.status !== 'active') continue;
      const venue = reg.venues.get(spec.venue);
      out.set(spec.symbol, {
        symbol: spec.symbol,
        name: spec.displayName,
        assetClass: spec.assetClass,
        venue: spec.venue,
        region: radarRegion(venue?.region ?? 'global'),
        sector: sectorOf(spec.symbol, spec.assetClass),
        currency: spec.quoteCcy,
        pricePrecision: spec.pricePrecision,
      });
    }
    return out;
  }

  async featureRows(): Promise<Array<FeatureRow & { detectedAt: string }>> {
    const tf = loadIntelConfig().timeframe;
    const reg = await this.registry();
    const rows = await this.db.query<FeatureDbRow>(
      `SELECT f.symbol, f.timeframe, f.bar_ts, f.last_close, f.features, f.scan_id::text,
              t.kind, t.score, t.detected_at
         FROM intel_features f
         LEFT JOIN intel_trends t ON t.scan_id = f.scan_id AND t.symbol = f.symbol
        WHERE f.timeframe = $1`,
      [tf],
    );
    return rows
      .filter((r) => reg.has(r.symbol))
      .map((r) => {
        const g = reg.get(r.symbol)!;
        return {
          ...g,
          timeframe: r.timeframe,
          barTs: r.bar_ts?.toISOString() ?? null,
          lastClose: r.last_close,
          features: r.features,
          trend: r.kind && r.score !== null ? { kind: r.kind, score: r.score } : null,
          detectedAt: (r.detected_at ?? r.bar_ts ?? new Date(0)).toISOString(),
        };
      });
  }

  async radar(filters: RadarFilters, window: 'day' | 'week', groupBy: RadarGroupBy) {
    const all = await this.featureRows();
    const rows = applyFilters(all, filters);
    const since = Date.now() - (window === 'day' ? 1 : 7) * 86_400_000;
    const scan = await this.db.query<{ created_at: Date; instruments: number }>(
      'SELECT created_at, instruments FROM intel_scans WHERE timeframe = $1 ORDER BY id DESC LIMIT 1',
      [loadIntelConfig().timeframe],
    );
    const recent = rows.filter((r) => r.trend && Date.parse(r.detectedAt) >= since);
    return {
      simulated: true,
      timeframe: loadIntelConfig().timeframe,
      window,
      groupBy,
      filters,
      scannedAt: scan[0]?.created_at.toISOString() ?? null,
      instruments: rows.length,
      heatMap: heatMap(rows, groupBy),
      trends: rankTrends(recent),
      movers: movers(rows),
      regions: RADAR_REGIONS.map((r) => ({ key: r, label: REGION_LABELS[r] })),
      method:
        'Trend labels come from scanner features only (regime filter, momentum, breakouts, compression); they rank patterns in SIMULATED data and are not forecasts.',
      disclaimer: DISCLAIMER,
    };
  }

  async forecast(symbol: string, horizon: string): Promise<ForecastRow | null> {
    const r = await this.db.query<ForecastDbRow>(
      `SELECT horizon, horizon_bars, status, direction, p_up, p_direction, skill, drivers, model_key, predicted_at
         FROM intel_forecasts WHERE symbol = $1 AND horizon = $2 ORDER BY id DESC LIMIT 1`,
      [symbol, horizon],
    );
    const f = r[0];
    if (!f) return null;
    return {
      horizon: f.horizon,
      horizonBars: f.horizon_bars,
      status: f.status,
      direction: f.direction,
      pUp: f.p_up,
      pDirection: f.p_direction,
      skill: f.skill,
      drivers: f.drivers,
      modelKey: f.model_key,
      predictedAt: f.predicted_at?.toISOString() ?? null,
    };
  }

  async news(q: NewsQuery): Promise<{
    simulated: true;
    articles: Array<NewsItem & { symbols: string[]; scoreStatus: string | null }>;
  }> {
    const reg = await this.registry();
    let symbols: string[] | null = null;
    if (q.symbol) symbols = [q.symbol];
    else if (q.region)
      symbols = [...reg.values()].filter((r) => r.region === q.region).map((r) => r.symbol);
    const rows = await this.db.query<{
      id: string;
      title: string;
      language: string | null;
      source_name: string;
      url: string;
      published_at: Date;
      status: string | null;
      translated_title: string | null;
      sentiment: number | null;
      relevance: number | null;
      novelty: number | null;
      event_type: string | null;
      symbols: string[] | null;
    }>(
      `SELECT a.id, a.title, a.language, a.source_name, a.url, a.published_at,
              s.status, s.translated_title, s.sentiment, s.relevance, s.novelty, s.event_type,
              (SELECT array_agg(e.ref ORDER BY e.ref) FROM news_entities e WHERE e.article_id = a.id AND e.kind = 'symbol') AS symbols
         FROM news_articles a
         LEFT JOIN news_scores s ON s.article_id = a.id
        WHERE a.dedup_of IS NULL
          AND a.published_at >= now() - make_interval(hours => $1)
          AND ($2::text[] IS NULL OR EXISTS (
                SELECT 1 FROM news_entities e WHERE e.article_id = a.id AND e.kind = 'symbol' AND e.ref = ANY($2)))
        ORDER BY a.published_at DESC
        LIMIT $3`,
      [q.hours, symbols, q.limit],
    );
    return {
      simulated: true,
      articles: rows.map((r) => ({
        id: r.id,
        title: r.title,
        translatedTitle: r.translated_title,
        language: r.language,
        source: r.source_name,
        url: r.url,
        publishedAt: r.published_at.toISOString(),
        sentiment: r.status === 'ok' ? r.sentiment : null,
        relevance: r.status === 'ok' ? r.relevance : null,
        novelty: r.status === 'ok' ? r.novelty : null,
        eventType: r.status === 'ok' ? r.event_type : null,
        scoreStatus: r.status,
        symbols: r.symbols ?? [],
      })),
    };
  }

  async trendCard(symbol: string, horizon: string): Promise<TrendCard> {
    const rows = await this.featureRows();
    const row = rows.find((r) => r.symbol === symbol);
    if (!row)
      throw new NotFoundException({
        error: 'not_scanned',
        message: `${symbol} has not been scanned yet.`,
      });
    const f = await this.forecast(symbol, horizon);
    const modelKey = f?.modelKey ?? trendModelKey(row.region, horizon);
    const cal =
      f?.status === 'ok' && f.pDirection !== null
        ? await this.calibration.view(modelKey, f.pDirection, loadAiConfig().calibrationMinN)
        : null;
    const news = await this.news({ symbol, hours: 168, limit: 5 });
    return buildTrendCard(row, horizon, f, cal, news.articles, modelKey);
  }

  /** Novice "What's moving and why" (plain words; goal 08 places the card on the novice Home). */
  async whatsMoving(limit = 3) {
    const rows = await this.featureRows();
    const top = rows
      .filter((r) => r.trend)
      .sort((a, b) => b.trend!.score - a.trend!.score)
      .slice(0, limit);
    const horizon = loadIntelConfig().horizons[0]?.label ?? '1d';
    const items = [];
    for (const r of top) items.push(movingItem(await this.trendCard(r.symbol, horizon)));
    return {
      simulated: true,
      items,
      note: 'Practice market with SIMULATED prices. This shows what moved, not what to do.',
      disclaimer: DISCLAIMER,
    };
  }

  /** Public track record per model and region, from stored predictions and outcomes. */
  async reliability() {
    const minN = loadAiConfig().calibrationMinN;
    const rows = await this.db.query<{
      model_key: string;
      source: string;
      n: number;
      resolved: number;
      hits: number;
      mean_net: number | null;
      first_at: Date | null;
      last_at: Date | null;
    }>(
      `SELECT model_key, source, count(*)::int AS n, count(outcome)::int AS resolved,
              count(*) FILTER (WHERE outcome)::int AS hits, avg(net_return) AS mean_net,
              min(predicted_at) AS first_at, max(predicted_at) AS last_at
         FROM ai_predictions WHERE model_key LIKE 'trend:%'
        GROUP BY model_key, source ORDER BY model_key, source`,
    );
    const keys = [...new Set(rows.map((r) => r.model_key))];
    const models = [];
    for (const key of keys) {
      const [, model, region, horizon] = key.split(':');
      const view = await this.calibration.view(key, null, minN);
      const by = (src: string) => rows.find((r) => r.model_key === key && r.source === src);
      const live = by('live');
      const replay = by('history_replay');
      const stat = (x: typeof live) =>
        x
          ? {
              forecasts: x.n,
              resolved: x.resolved,
              hitRate: x.resolved ? Math.round((x.hits / x.resolved) * 1e4) / 1e4 : null,
              meanNetReturn: x.mean_net === null ? null : Math.round(x.mean_net * 1e8) / 1e8,
              from: x.first_at?.toISOString() ?? null,
              to: x.last_at?.toISOString() ?? null,
            }
          : { forecasts: 0, resolved: 0, hitRate: null, meanNetReturn: null, from: null, to: null };
      models.push({
        modelKey: key,
        model,
        region,
        regionLabel: REGION_LABELS[region as RadarRegion] ?? region,
        horizon,
        live: stat(live),
        replay: stat(replay),
        edge: view.edge,
        edgeStatement: view.edgeStatement,
        bins: view.bins
          .filter((b) => b.n > 0)
          .map((b) => ({
            lo: b.lo,
            hi: b.hi,
            n: b.n,
            meanPredicted: b.meanPredicted,
            observed: Math.round((b.hits / b.n) * 1e4) / 1e4,
          })),
        minN,
      });
    }
    return {
      simulated: true,
      generatedAt: new Date().toISOString(),
      method:
        'Every forecast is stored with its timestamp before its outcome is known (live), or replayed out of sample from the walk-forward (replay). Outcome: the price moved in the forecast direction by more than the round-trip cost. Bins compare the stated probability with how often it happened.',
      models,
      disclaimer: DISCLAIMER,
    };
  }

  providers() {
    return {
      matrix: PROVIDER_MATRIX,
      news: NEWS_STUBS.map((s) => ({
        id: s.id,
        flag: s.flag,
        enabled: process.env[s.flag] === 'true',
        flagged: true,
        licensed: false,
        regions: s.regions,
        languages: s.languages,
      })),
      dataStatus:
        'All market data and news in KORA are SIMULATED until a licensed data contract exists (OQ-M3, OQ-M4).',
    };
  }
}

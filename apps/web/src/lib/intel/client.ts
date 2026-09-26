/**
 * Browser client for the goal 07B market intelligence endpoints (same-origin /api proxy, cookie
 * session, CSRF header). All data is SIMULATED; nothing here can place an order.
 */
import { AiApiError, streamAnswer, type AiAnswer } from '@/lib/ai/client';

export type RadarRegion = 'americas' | 'europe' | 'africa' | 'asia' | 'oceania' | 'global';
export type TrendKind = 'up' | 'down' | 'range' | 'breakout_up' | 'breakout_down' | 'reversal' | 'vol_regime';

export interface HeatCell {
  key: string;
  label: string;
  instruments: number;
  up: number;
  down: number;
  trending: number;
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

export interface RadarData {
  simulated: true;
  timeframe: string;
  window: 'day' | 'week';
  groupBy: 'region' | 'assetClass' | 'sector';
  scannedAt: string | null;
  instruments: number;
  heatMap: HeatCell[];
  trends: RankedTrend[];
  movers: Array<{ symbol: string; name: string; momentumZ: number }>;
  regions: Array<{ key: RadarRegion; label: string }>;
  method: string;
  disclaimer: string;
}

export interface NewsItem {
  id: string;
  title: string;
  translatedTitle: string | null;
  language: string | null;
  source: string;
  url: string;
  publishedAt: string;
  sentiment: number | null;
  relevance: number | null;
  novelty: number | null;
  eventType: string | null;
}

export type ProbabilityView =
  | { status: 'calibrated'; value: number; n: number; saidAs: number; reliabilityLine: string; edgeStatement: string }
  | { status: 'no_reliable_signal'; label: 'No reliable signal'; reason: string };

export interface TrendCard {
  symbol: string;
  name: string;
  venue: string;
  region: RadarRegion;
  regionLabel: string;
  assetClass: string;
  sector: string;
  currency: string;
  timeframe: string;
  horizon: string;
  asOf: string | null;
  simulated: true;
  trend: { kind: TrendKind; label: string; score: number } | null;
  direction: 'up' | 'down' | null;
  probability: ProbabilityView;
  skill: Record<string, unknown> | null;
  modelKey: string;
  drivers: Array<{ feature: string; label: string; value: number; contribution: number }>;
  regime: { trending: number | null; ranging: number | null; volatile: number | null };
  risk: {
    lastClose: number | null;
    atr: number | null;
    atrPct: number | null;
    volRatio: number | null;
    momentumZ: number | null;
    eventMinutes: number | null;
  };
  invalidation: { side: 'below' | 'above'; level: number; atrMultiple: number; rule: string } | null;
  news: NewsItem[];
  disclaimer: string;
}

export interface MovingItem {
  symbol: string;
  name: string;
  headline: string;
  why: string | null;
  whySource: { id: string; source: string; url: string } | null;
  confidence: string | null;
}

export interface AlertRule {
  trendKinds: TrendKind[];
  region?: RadarRegion;
  assetClass?: string;
  sector?: string;
  symbol?: string;
  minScore: number;
}

export interface AlertsData {
  alerts: Array<{ id: string; name: string; rule: AlertRule; active: boolean; createdAt: string }>;
  events: Array<{ id: string; alertId: string; symbol: string; detail: Record<string, unknown>; createdAt: string }>;
  evaluatedBy: 'server';
}

export interface ReliabilityData {
  simulated: true;
  generatedAt: string;
  method: string;
  models: Array<{
    modelKey: string;
    model: string;
    region: string;
    regionLabel: string;
    horizon: string;
    live: { forecasts: number; resolved: number; hitRate: number | null; meanNetReturn: number | null };
    replay: { forecasts: number; resolved: number; hitRate: number | null; meanNetReturn: number | null };
    edge: 'positive' | 'none' | 'insufficient_data';
    edgeStatement: string;
    bins: Array<{ lo: number; hi: number; n: number; meanPredicted: number | null; observed: number }>;
    minN: number;
  }>;
  disclaimer: string;
}

export interface OrderDraftResponse {
  draftId: string;
  status: 'draft';
  prefill: Record<string, string>;
  message: string;
}

const HEADERS = { accept: 'application/json', 'x-kora-csrf': '1' };

async function call<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { ...HEADERS, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'include',
    cache: 'no-store',
  });
  const text = await res.text();
  const data = (text ? JSON.parse(text) : {}) as Record<string, unknown>;
  if (!res.ok) throw new AiApiError(res.status, String(data.message ?? res.statusText));
  return data as T;
}

const qs = (o: Record<string, string | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
};

export const intelApi = {
  radar: (f: { region?: string; assetClass?: string; sector?: string; window?: string; groupBy?: string }) =>
    call<RadarData>('GET', `/intel/radar${qs(f)}`),
  card: (symbol: string, horizon = '1d') =>
    call<TrendCard>('GET', `/intel/trends/${encodeURIComponent(symbol)}${qs({ horizon })}`),
  explain: (symbol: string, horizon: string, onDelta: (t: string) => void, mode?: 'pro' | 'novice') =>
    streamAnswer(`/intel/trends/${encodeURIComponent(symbol)}/explain`, { horizon, ...(mode ? { mode } : {}) }, onDelta) as Promise<AiAnswer>,
  draft: (symbol: string, horizon: string) =>
    call<OrderDraftResponse>('POST', `/intel/trends/${encodeURIComponent(symbol)}/draft`, { horizon }),
  whatsMoving: () => call<{ items: MovingItem[]; note: string; disclaimer: string }>('GET', '/intel/whats-moving'),
  alerts: () => call<AlertsData>('GET', '/intel/alerts'),
  createAlert: (name: string, rule: AlertRule) => call<{ id: string }>('POST', '/intel/alerts', { name, rule }),
  deleteAlert: (id: string) => call<{ deleted: true }>('DELETE', `/intel/alerts/${id}`),
};

/** Plain-number formatting helpers (colour is never the only cue: ▲▼ and +/− always shown). */
export function signed(x: number | null | undefined, digits = 2): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return '—';
  const s = Math.abs(x).toFixed(digits);
  return `${x > 0 ? '+' : x < 0 ? '−' : ''}${s}`;
}

export function arrow(x: number | null | undefined): string {
  if (x === null || x === undefined || !Number.isFinite(x) || x === 0) return '•';
  return x > 0 ? '▲' : '▼';
}

export const TREND_LABELS: Record<TrendKind, string> = {
  up: 'Uptrend',
  down: 'Downtrend',
  range: 'Range',
  breakout_up: 'Breakout up',
  breakout_down: 'Breakout down',
  reversal: 'Reversal',
  vol_regime: 'Volatility regime',
};

export function trendArrow(kind: TrendKind): string {
  return kind === 'up' || kind === 'breakout_up' ? '▲' : kind === 'down' || kind === 'breakout_down' ? '▼' : '◆';
}

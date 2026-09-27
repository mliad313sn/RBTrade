import type { CalibrationView } from '../../ai/core/calibration';
import { DISCLAIMER } from '../../ai/core/types';
import { unsafeDisplayText } from './news-score';
import { FEATURE_LABELS, REGION_LABELS, TREND_KIND_LABELS, type RadarRegion } from './taxonomy';

/**
 * Trend cards (goal 07B §5): every figure comes from the scan, the forecast, the calibration table or
 * stored news; the model only writes the plain-language summary from this card (grounding), and the
 * numeric-fidelity guard checks it. A probability is shown only when the calibration table shows an
 * edge after costs and the current score's bin has enough resolved forecasts; otherwise the card says
 * "No reliable signal" and gives the reason.
 */

export type TrendKind =
  | 'up'
  | 'down'
  | 'range'
  | 'breakout_up'
  | 'breakout_down'
  | 'reversal'
  | 'vol_regime';

export interface FeatureRow {
  symbol: string;
  name: string;
  assetClass: string;
  venue: string;
  region: RadarRegion;
  sector: string;
  currency: string;
  pricePrecision: number;
  timeframe: string;
  barTs: string | null;
  lastClose: number | null;
  features: Record<string, number | null>;
  trend: { kind: TrendKind; score: number } | null;
}

export interface ForecastRow {
  horizon: string;
  horizonBars: number;
  status: 'ok' | 'insufficient_data';
  direction: 'up' | 'down' | null;
  pUp: number | null;
  pDirection: number | null;
  skill: Record<string, unknown>;
  drivers: Array<{ feature: string; value: number; contribution: number }>;
  modelKey: string;
  predictedAt: string | null;
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
  | {
      status: 'calibrated';
      value: number;
      n: number;
      saidAs: number;
      reliabilityLine: string;
      edgeStatement: string;
    }
  | { status: 'no_reliable_signal'; label: 'No reliable signal'; reason: string };

export function probabilityView(
  f: ForecastRow | null,
  cal: CalibrationView | null,
): ProbabilityView {
  const none = (reason: string): ProbabilityView => ({
    status: 'no_reliable_signal',
    label: 'No reliable signal',
    reason,
  });
  if (!f) return none('No forecast has been computed for this horizon yet.');
  if (f.status !== 'ok' || f.pDirection === null)
    return none('Not enough SIMULATED history to test this horizon out of sample.');
  if (!cal || cal.n === 0) return none('No resolved forecasts in the calibration table yet.');
  if (cal.edge === 'insufficient_data')
    return none(`Not enough resolved forecasts to judge skill (n=${cal.n}, need ${cal.minN}).`);
  if (cal.edge === 'none') return none(`No edge after costs in past forecasts (n=${cal.n}).`);
  if (!cal.confidence || !cal.reliabilityLine)
    return none(`Too few past forecasts at this score level (need ${cal.minN}).`);
  return {
    status: 'calibrated',
    value: cal.confidence.value,
    n: cal.confidence.n,
    saidAs: cal.confidence.saidAs,
    reliabilityLine: cal.reliabilityLine.replace(' it worked ', ' it happened '),
    edgeStatement: cal.edgeStatement,
  };
}

const r = (x: number | null | undefined, d = 4): number | null =>
  x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d;

export function directionOf(
  kind: TrendKind | undefined,
  forecast: ForecastRow | null,
): 'up' | 'down' | null {
  if (forecast?.direction) return forecast.direction;
  if (kind === 'up' || kind === 'breakout_up') return 'up';
  if (kind === 'down' || kind === 'breakout_down') return 'down';
  return null;
}

export interface Invalidation {
  side: 'below' | 'above';
  level: number;
  atrMultiple: number;
  rule: string;
}

/** "What would invalidate this view": a close beyond last ∓ 2 × ATR against the direction. */
export function invalidation(
  direction: 'up' | 'down' | null,
  lastClose: number | null,
  atr: number | null,
  precision: number,
): Invalidation | null {
  if (!direction || lastClose === null || atr === null || !(atr > 0)) return null;
  const level = direction === 'up' ? lastClose - 2 * atr : lastClose + 2 * atr;
  const rounded = Math.round(level * 10 ** precision) / 10 ** precision;
  const side = direction === 'up' ? 'below' : 'above';
  return {
    side,
    level: rounded,
    atrMultiple: 2,
    rule: `A close ${side} ${rounded.toFixed(precision)} (2 × ATR from the last close) or a switch to the volatile regime would invalidate this view.`,
  };
}

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
  invalidation: Invalidation | null;
  news: NewsItem[];
  disclaimer: string;
}

export function buildTrendCard(
  row: FeatureRow,
  horizon: string,
  forecast: ForecastRow | null,
  cal: CalibrationView | null,
  news: NewsItem[],
  modelKey: string,
): TrendCard {
  const f = row.features;
  const atr = r(f.atr, Math.min(8, row.pricePrecision + 2));
  const direction = directionOf(row.trend?.kind, forecast);
  return {
    symbol: row.symbol,
    name: row.name,
    venue: row.venue,
    region: row.region,
    regionLabel: REGION_LABELS[row.region],
    assetClass: row.assetClass,
    sector: row.sector,
    currency: row.currency,
    timeframe: row.timeframe,
    horizon,
    asOf: row.barTs,
    simulated: true,
    trend: row.trend
      ? {
          kind: row.trend.kind,
          label: TREND_KIND_LABELS[row.trend.kind] ?? row.trend.kind,
          score: row.trend.score,
        }
      : null,
    direction,
    probability: probabilityView(forecast, cal),
    skill: forecast?.status === 'ok' ? forecast.skill : null,
    modelKey,
    drivers: (forecast?.drivers ?? []).map((d) => ({
      feature: d.feature,
      label: FEATURE_LABELS[d.feature] ?? d.feature,
      value: r(d.value) ?? 0,
      contribution: r(d.contribution) ?? 0,
    })),
    regime: {
      trending: r(f.regime_trending, 2),
      ranging: r(f.regime_ranging, 2),
      volatile: r(f.regime_volatile, 2),
    },
    risk: {
      lastClose: row.lastClose,
      atr,
      atrPct: row.lastClose && atr ? r((atr / row.lastClose) * 100, 2) : null,
      volRatio: r(f.vol_ratio, 2),
      momentumZ: r(f.mom_z, 2),
      eventMinutes:
        f.event_minutes === null || f.event_minutes === undefined
          ? null
          : Math.round(f.event_minutes),
    },
    invalidation: invalidation(direction, row.lastClose, atr, row.pricePrecision),
    news,
    disclaimer: DISCLAIMER,
  };
}

/** Novice "What's moving and why" item: plain words, no advice, a probability only if calibrated. */
export interface MovingItem {
  symbol: string;
  name: string;
  headline: string;
  why: string | null;
  whySource: { id: string; source: string; url: string } | null;
  confidence: string | null;
  /**
   * The same facts as structured fields, so the novice Home can word them in the viewer's language
   * (goal 08 i18n): the kind of move, the cited news and the calibrated odds (null unless calibrated).
   */
  move: MoveKind;
  news: { title: string; source: string } | null;
  odds: { per100: number; n: number } | null;
}

/** Plain-word kind of move shown to novices. */
export type MoveKind = 'up' | 'down' | 'choppy' | 'turned' | 'quiet';

/** "Toyota Motor Corporation" → "Toyota Motor": plain-word headlines for novices. */
export function shortName(name: string): string {
  const s = name
    .replace(
      /[,.]?\s+(Corporation|Incorporated|Inc\.?|Ltd\.?|plc|S\.A\.|SE|AG|Holdings|Group|Co\.,?\s*Ltd\.?|Co\.?)(\s|$).*$/i,
      '',
    )
    .replace(/\s+Class [A-Z]$/, '')
    .trim();
  return s || name;
}

const HEADLINES: Record<MoveKind, (name: string) => string> = {
  up: (n) => `${n} has gone up more than usual. That is a big move for it.`,
  down: (n) => `${n} has gone down more than usual. That is a big move for it.`,
  choppy: (n) => `${n} is moving up and down a lot. Prices can jump fast now.`,
  turned: (n) => `${n} has turned around. It went the other way after a big move.`,
  quiet: (n) => `${n} has stayed in a small range. It has not moved much.`,
};

export function movingItem(card: TrendCard): MovingItem {
  const k = card.trend?.kind;
  const name = shortName(card.name);
  const move: MoveKind =
    k === 'up' || k === 'breakout_up'
      ? 'up'
      : k === 'down' || k === 'breakout_down'
        ? 'down'
        : k === 'vol_regime'
          ? 'choppy'
          : k === 'reversal'
            ? 'turned'
            : 'quiet';
  const headline = HEADLINES[move](name);
  const top = card.news[0] ?? null;
  // IRTC R4-05: a title that fails the advice/injection check is never shown to a novice.
  const title = top
    ? ([top.translatedTitle, top.title].find((t) => !!t && !unsafeDisplayText(t)) ?? null)
    : null;
  const why = top && title ? `In the news: "${title}" (${top.source}).` : null;
  const odds =
    card.probability.status === 'calibrated'
      ? { per100: Math.round(card.probability.value * 100), n: card.probability.n }
      : null;
  const confidence = odds
    ? `In the past, forecasts like this came true about ${odds.per100} times out of 100 (${odds.n} cases).`
    : null;
  return {
    symbol: card.symbol,
    name,
    headline,
    why,
    whySource: top ? { id: top.id, source: top.source, url: top.url } : null,
    confidence,
    move,
    news: top && title ? { title, source: top.source } : null,
    odds,
  };
}

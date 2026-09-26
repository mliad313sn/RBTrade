import { z } from 'zod';

import { DECIMAL_STRING } from './decimal.js';
import type { SessionCalendar } from './sessions.js';

/**
 * Normalised market data schema (goal 02, ADR 0002). One internal shape for every source.
 * Prices and sizes are decimal strings rounded with the instrument registry; timestamps are
 * epoch milliseconds (safe integers).
 */

export const ASSET_CLASSES = [
  'equity',
  'etf',
  'bond',
  'future',
  'option',
  'fx',
  'metal',
  'energy',
  'agri',
  'crypto',
  'index',
  'cfd',
  'fund',
] as const;
export type AssetClass = (typeof ASSET_CLASSES)[number];

const ASSET_CLASS_LABELS: Record<AssetClass, string> = {
  equity: 'Equity',
  etf: 'ETF',
  bond: 'Bond',
  future: 'Future',
  option: 'Option',
  fx: 'FX',
  metal: 'Metal',
  energy: 'Energy',
  agri: 'Agri',
  crypto: 'Crypto',
  index: 'Index',
  cfd: 'CFD',
  fund: 'Fund',
};

/** Human label, e.g. cfd on index → "Index CFD" (prototype watchlist wording). */
export function assetClassLabel(assetClass: AssetClass, underlying?: AssetClass | null): string {
  if (underlying && (assetClass === 'cfd' || assetClass === 'future' || assetClass === 'option')) {
    return `${ASSET_CLASS_LABELS[underlying]} ${ASSET_CLASS_LABELS[assetClass]}`;
  }
  return ASSET_CLASS_LABELS[assetClass];
}

export const REGIONS = ['africa', 'asia', 'europe', 'north_america', 'south_america', 'oceania', 'global'] as const;
export type Region = (typeof REGIONS)[number];

export const TIMEFRAMES = ['1s', '1m', '5m', '15m', '1h', '4h', '1D'] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];
export const TIMEFRAME_SECONDS: Record<Timeframe, number> = {
  '1s': 1,
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3600,
  '4h': 14_400,
  '1D': 86_400,
};
export function isTimeframe(v: string): v is Timeframe {
  return (TIMEFRAMES as readonly string[]).includes(v);
}
/** Bucket start (epoch ms, UTC-aligned) for a timestamp. */
export function bucketStart(ts: number, tf: Timeframe): number {
  const size = TIMEFRAME_SECONDS[tf] * 1000;
  return Math.floor(ts / size) * size;
}

/** Internal symbol code: upper-case, digits, '.', '_' or '-' (e.g. EURUSD, 7203.XTKS). */
export const SYMBOL_RE = /^[A-Z0-9][A-Z0-9._-]{0,31}$/;
export const MIC_RE = /^[A-Z0-9]{4}$/;

const decimalString = z.string().regex(DECIMAL_STRING, 'decimal string');
const positiveDecimal = decimalString.refine((s) => !s.startsWith('-') && /[1-9]/.test(s), 'must be > 0');
const nonNegDecimal = decimalString.refine((s) => !s.startsWith('-'), 'must be >= 0');
const epochMs = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const symbol = z.string().regex(SYMBOL_RE);

export const MdMetaSchema = z.object({
  source: z.string().min(1).max(64),
  exchangeTs: epochMs,
  receivedTs: epochMs,
  seq: z.number().int().nonnegative(),
});
export type MdMeta = z.infer<typeof MdMetaSchema>;

export const QuoteSchema = MdMetaSchema.extend({
  type: z.literal('quote'),
  symbol,
  bid: positiveDecimal,
  ask: positiveDecimal,
  bidSize: nonNegDecimal,
  askSize: nonNegDecimal,
  stale: z.boolean(),
});
export type Quote = z.infer<typeof QuoteSchema>;

export const TradeSchema = MdMetaSchema.extend({
  type: z.literal('trade'),
  symbol,
  tradeId: z.string().min(1).max(64),
  price: positiveDecimal,
  qty: positiveDecimal,
  /** Aggressor side. */
  side: z.enum(['buy', 'sell']),
});
export type Trade = z.infer<typeof TradeSchema>;

export const DepthLevelSchema = z.tuple([positiveDecimal, nonNegDecimal]);
export type DepthLevel = z.infer<typeof DepthLevelSchema>;

export const DepthSnapshotSchema = MdMetaSchema.extend({
  type: z.literal('depth_snapshot'),
  symbol,
  /** Best first: bids descending, asks ascending. */
  bids: z.array(DepthLevelSchema),
  asks: z.array(DepthLevelSchema),
});
export type DepthSnapshot = z.infer<typeof DepthSnapshotSchema>;

export const DepthDeltaSchema = MdMetaSchema.extend({
  type: z.literal('depth_delta'),
  symbol,
  /** Size "0" removes the level. */
  bids: z.array(DepthLevelSchema),
  asks: z.array(DepthLevelSchema),
  /**
   * Venues with ranged update ids: the delta applies to any book whose seq is in [prevSeq, seq).
   * Absent = strictly contiguous (book seq must be seq - 1).
   */
  prevSeq: z.number().int().nonnegative().optional(),
});
export type DepthDelta = z.infer<typeof DepthDeltaSchema>;

export const CandleSchema = MdMetaSchema.extend({
  type: z.literal('candle'),
  symbol,
  tf: z.enum(TIMEFRAMES),
  /** Bucket start, epoch ms UTC. */
  bucket: epochMs,
  open: positiveDecimal,
  high: positiveDecimal,
  low: positiveDecimal,
  close: positiveDecimal,
  volume: nonNegDecimal,
  trades: z.number().int().nonnegative(),
  /** False while the bucket is still forming. */
  closed: z.boolean(),
});
export type Candle = z.infer<typeof CandleSchema>;

export const FEED_STATES = ['up', 'down', 'resyncing', 'disabled'] as const;
export const FeedHealthSchema = z.object({
  source: z.string(),
  state: z.enum(FEED_STATES),
  lastMessageTs: epochMs.nullable(),
  gaps: z.number().int().nonnegative(),
  resyncs: z.number().int().nonnegative(),
  lastResync: z
    .object({ symbol, stream: z.string(), expected: z.number().int(), got: z.number().int(), ts: epochMs })
    .nullable(),
});
export type FeedHealth = z.infer<typeof FeedHealthSchema>;

export const FeedStatusSchema = z.object({
  type: z.literal('status'),
  state: z.enum(['ok', 'degraded', 'down']),
  ts: epochMs,
  feeds: z.array(FeedHealthSchema),
  staleSymbols: z.array(symbol),
  reason: z.string().nullable(),
});
export type FeedStatus = z.infer<typeof FeedStatusSchema>;

export const CalendarEventSchema = z.object({
  id: z.string(),
  /** ISO-8601 UTC. */
  time: z.iso.datetime(),
  country: z.string().regex(/^[A-Z]{2}$/),
  currency: z.string().regex(/^[A-Z]{3}$/),
  impact: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  title: z.string().min(1).max(120),
  source: z.string(),
});
export type CalendarEvent = z.infer<typeof CalendarEventSchema>;

export type MarketDataMessage = Quote | Trade | DepthSnapshot | DepthDelta | Candle;

/**
 * Payload of `trades:{symbol}` (B-210). The feed publishes the prints of one flush interval as a
 * batch, so channel conflation (latest value wins) never drops a print.
 */
export interface TradesBatch {
  type: 'trades';
  symbol: string;
  trades: Array<Pick<Trade, 'tradeId' | 'price' | 'qty' | 'side' | 'exchangeTs' | 'seq'>>;
}

export const INSTRUMENT_STATUSES = ['active', 'halted', 'delisted'] as const;
export type InstrumentStatus = (typeof INSTRUMENT_STATUSES)[number];

/** Registry row (goal 02). Every price/qty rounding comes from here, never from literals. */
export interface InstrumentSpec {
  symbol: string;
  displayName: string;
  venue: string;
  venueSymbol: string | null;
  isin: string | null;
  figi: string | null;
  assetClass: AssetClass;
  underlyingClass: AssetClass | null;
  /** ISO 4217 / crypto code for FX, metals and crypto; null for equities, futures, etc. */
  baseCcy: string | null;
  /** Trading (quote) currency. */
  quoteCcy: string;
  tickSize: string;
  pricePrecision: number;
  pipSize: string | null;
  contractSize: string;
  minQty: string;
  qtyStep: string;
  qtyPrecision: number;
  /** Instrument-level override of the venue calendar (null = use the venue's). */
  tradingSessions: InstrumentSessions | null;
  /** Initial margin rate by client tier. SIMULATED placeholders (OQ-M1). */
  marginRates: Record<string, string>;
  feeScheduleId: string;
  status: InstrumentStatus;
  simulated: boolean;
}

export type InstrumentSessions = SessionCalendar & { timezone: string };

export interface Venue {
  mic: string;
  isoMic: boolean;
  operatingMic: string | null;
  name: string;
  country: string;
  region: Region;
  timezone: string;
  currency: string;
  calendar: SessionCalendar;
  calendarSource: string;
  status: 'active' | 'inactive';
  simulated: boolean;
}

// ---- Channels -------------------------------------------------------------------------------

export type ChannelKind = 'quotes' | 'depth' | 'candles' | 'trades' | 'status' | 'orders' | 'positions' | 'account' | 'risk';
/** Private trading channels (goal 03), keyed by account id; the gateway checks ownership. */
export const PRIVATE_CHANNEL_KINDS = ['orders', 'positions', 'account'] as const;
export type PrivateChannelKind = (typeof PRIVATE_CHANNEL_KINDS)[number];
export interface ParsedChannel {
  kind: ChannelKind;
  symbol: string | null;
  tf: Timeframe | null;
  accountId: string | null;
}
export const quoteChannel = (s: string): string => `quotes:${s}`;
export const depthChannel = (s: string): string => `depth:${s}`;
/** Time and sales (B-210): batches of prints, see `TradesBatch`. */
export const tradesChannel = (s: string): string => `trades:${s}`;
export const candleChannel = (s: string, tf: Timeframe): string => `candles:${s}:${tf}`;
export const ordersChannel = (accountId: string): string => `orders:${accountId}`;
export const positionsChannel = (accountId: string): string => `positions:${accountId}`;
export const accountChannel = (accountId: string): string => `account:${accountId}`;
export const STATUS_CHANNEL = 'status';
/** Goal 09: risk officer console alerts (breaches, kill switch, robots, reconciliation). 2nd line only. */
export const RISK_ALERTS_CHANNEL = 'risk:alerts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isPrivateChannelKind(kind: ChannelKind): kind is PrivateChannelKind {
  return (PRIVATE_CHANNEL_KINDS as readonly string[]).includes(kind);
}

export function parseChannel(ch: string): ParsedChannel | null {
  if (ch === STATUS_CHANNEL) return { kind: 'status', symbol: null, tf: null, accountId: null };
  if (ch === RISK_ALERTS_CHANNEL) return { kind: 'risk', symbol: null, tf: null, accountId: null };
  const parts = ch.split(':');
  const [kind, sym, tf] = parts;
  if ((kind === 'orders' || kind === 'positions' || kind === 'account') && parts.length === 2 && sym && UUID_RE.test(sym)) {
    return { kind, symbol: null, tf: null, accountId: sym };
  }
  if (!sym || !SYMBOL_RE.test(sym)) return null;
  if ((kind === 'quotes' || kind === 'depth' || kind === 'trades') && parts.length === 2) return { kind, symbol: sym, tf: null, accountId: null };
  if (kind === 'candles' && parts.length === 3 && tf && isTimeframe(tf)) return { kind, symbol: sym, tf, accountId: null };
  return null;
}

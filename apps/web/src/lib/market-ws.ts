import { dec, quantize, type Quote } from '@kora/domain';

/** Port of the api's /ws endpoint as seen by the browser (same hostname as the page, so the session cookie is sent). */
export function apiWsPort(env: Record<string, string | undefined> = process.env): string {
  if (env.API_PUBLIC_WS_PORT) return env.API_PUBLIC_WS_PORT;
  try {
    const u = new URL(env.API_INTERNAL_URL ?? 'http://127.0.0.1:4000');
    return u.port || (u.protocol === 'https:' ? '443' : '80');
  } catch {
    return '4000';
  }
}

/** Prototype watchlist ("Watchlist · Majors"), in artboard order. */
export const MAJORS = [
  'EURUSD',
  'GBPUSD',
  'USDJPY',
  'XAUUSD',
  'BTCUSD',
  'ETHUSD',
  'US500',
  'NAS100',
  'AAPL',
  'NVDA',
  'WTI',
];

export interface WatchlistRowView {
  mid: string | null;
  /** Change vs the UTC day open as a ratio (decimal string), null when unknown. */
  change: string | null;
  stale: boolean;
}

/** Mid and change computed with decimals at the registry precision (never floats). */
export function watchlistRow(
  quote: Pick<Quote, 'bid' | 'ask' | 'stale'> | null,
  dayOpen: string | null,
  pricePrecision: number,
): WatchlistRowView {
  if (!quote) return { mid: null, change: null, stale: false };
  const mid = quantize(dec(quote.bid).add(dec(quote.ask)).div(2), pricePrecision);
  const change =
    dayOpen && !dec(dayOpen).isZero() ? mid.sub(dec(dayOpen)).div(dec(dayOpen)).toFixed(6) : null;
  return { mid: mid.toFixed(pricePrecision), change, stale: quote.stale };
}

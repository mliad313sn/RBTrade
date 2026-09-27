import type { Candle, DepthDelta, DepthSnapshot, Quote, Timeframe, Trade } from '@kora/domain';

/**
 * The one interface every market data source implements (goal 02, ADR 0002). Adapters emit
 * messages already normalised to the internal schema, each carrying source, exchangeTs,
 * receivedTs and a per-(symbol, stream) seq. Consumers check seq with `SeqGapDetector` and call
 * `snapshot()` to resync after a gap.
 */

export type Unsubscribe = () => void;

export type AdapterState = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface AdapterHealth {
  source: string;
  state: AdapterState;
  lastMessageTs: number | null;
  detail: string | null;
}

export interface MarketDataAdapter {
  readonly source: string;
  /** Streams whose seq is contiguous per symbol, so gap detection applies (default: both true). */
  readonly contiguousSeq?: { quotes: boolean; trades: boolean };
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  subscribeQuotes(symbols: string[], onQuote: (q: Quote) => void): Unsubscribe;
  subscribeTrades(symbols: string[], onTrade: (t: Trade) => void): Unsubscribe;
  subscribeDepth(
    symbols: string[],
    levels: number,
    onDepth: (d: DepthSnapshot | DepthDelta) => void,
  ): Unsubscribe;
  /** Historical candles with bucket in [from, to). */
  getCandles(symbol: string, tf: Timeframe, from: number, to: number): Promise<Candle[]>;
  /** Current state for a resync after a gap. */
  snapshot(
    symbol: string,
    levels: number,
  ): Promise<{ quote: Quote | null; depth: DepthSnapshot | null }>;
  health(): AdapterHealth;
  /** Called on every state change (connect, disconnect, error). */
  onStateChange(listener: (h: AdapterHealth) => void): Unsubscribe;
  /** Whether the symbol is expected to tick at `now` (session awareness); default true. */
  isActive?(symbol: string, now: number): boolean;
}

/** A stub or unconfigured adapter was asked to reach a real venue. */
export class AdapterNotConfiguredError extends Error {
  constructor(source: string, reason: string) {
    super(`${source}: ${reason}`);
    this.name = 'AdapterNotConfiguredError';
  }
}

/** Small helper for listener sets. */
export class Listeners<T> {
  private readonly set = new Set<(v: T) => void>();

  add(fn: (v: T) => void): Unsubscribe {
    this.set.add(fn);
    return () => this.set.delete(fn);
  }

  emit(v: T): void {
    for (const fn of this.set) fn(v);
  }

  get size(): number {
    return this.set.size;
  }
}

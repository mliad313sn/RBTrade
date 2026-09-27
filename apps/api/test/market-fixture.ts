import { depthChannel, quoteChannel, STATUS_CHANNEL, type DepthLevel, type DepthSnapshot, type FeedStatus, type Quote } from '@kora/domain';
import { Redis } from 'ioredis';

/**
 * Deterministic SIMULATED market for trading integration tests: writes quotes, depth and feed status
 * into the goal 02 Redis last-value cache (and publishes them on the bus), exactly as the feed does.
 * `touch()` re-stamps everything with the current (possibly faked) clock so nothing goes stale.
 */
export class MarketFixture {
  private readonly redis: Redis;
  private readonly prefix: string;
  private seq = 1;
  readonly quotes = new Map<string, Quote>();
  readonly depths = new Map<string, DepthSnapshot>();
  private statusState: FeedStatus['state'] = 'ok';
  private feedState: 'up' | 'down' = 'up';
  private staleSymbols: string[] = [];
  private statusTs: number | null = null;

  constructor() {
    this.redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:56379', { maxRetriesPerRequest: 2 });
    this.prefix = process.env.KORA_MD_REDIS_PREFIX ?? 'kora:md:';
  }

  private async put(channel: string, msg: unknown): Promise<void> {
    const json = JSON.stringify(msg);
    await this.redis.set(`${this.prefix}last:${channel}`, json, 'EX', 3600);
    await this.redis.publish(`${this.prefix}${channel}`, json);
  }

  /** Feed status; `ts` defaults to now (pass an old ts to simulate a lost heartbeat). */
  async status(opts: { state?: FeedStatus['state']; feed?: 'up' | 'down'; staleSymbols?: string[]; ts?: number | null } = {}): Promise<void> {
    if (opts.state) this.statusState = opts.state;
    if (opts.feed) this.feedState = opts.feed;
    if (opts.staleSymbols) this.staleSymbols = opts.staleSymbols;
    if (opts.ts !== undefined) this.statusTs = opts.ts;
    const now = Date.now();
    const s: FeedStatus = {
      type: 'status',
      state: this.statusState,
      ts: this.statusTs ?? now,
      feeds: [{ source: 'simulated', state: this.feedState, lastMessageTs: now, gaps: 0, resyncs: 0, lastResync: null }],
      staleSymbols: this.staleSymbols,
      reason: this.statusState === 'ok' ? null : 'test',
    };
    await this.put(STATUS_CHANNEL, s);
  }

  async quote(symbol: string, bid: string, ask: string, opts: { bidSize?: string; askSize?: string; stale?: boolean; receivedTs?: number } = {}): Promise<Quote> {
    const now = Date.now();
    const q: Quote = {
      type: 'quote',
      symbol,
      bid,
      ask,
      bidSize: opts.bidSize ?? '1000000000',
      askSize: opts.askSize ?? '1000000000',
      stale: opts.stale ?? false,
      source: 'simulated',
      exchangeTs: opts.receivedTs ?? now,
      receivedTs: opts.receivedTs ?? now,
      seq: this.seq++,
    };
    this.quotes.set(symbol, q);
    await this.put(quoteChannel(symbol), q);
    return q;
  }

  async depth(symbol: string, bids: DepthLevel[], asks: DepthLevel[]): Promise<void> {
    const now = Date.now();
    const d: DepthSnapshot = { type: 'depth_snapshot', symbol, bids, asks, source: 'simulated', exchangeTs: now, receivedTs: now, seq: this.seq++ };
    this.depths.set(symbol, d);
    await this.put(depthChannel(symbol), d);
  }

  async clearDepth(symbol: string): Promise<void> {
    this.depths.delete(symbol);
    await this.redis.del(`${this.prefix}last:${depthChannel(symbol)}`);
  }

  /** Re-stamps status, quotes and depth with the current clock (new sequence numbers). */
  async touch(): Promise<void> {
    await this.status();
    for (const q of [...this.quotes.values()]) await this.quote(q.symbol, q.bid, q.ask, { bidSize: q.bidSize, askSize: q.askSize, stale: q.stale });
    for (const d of [...this.depths.values()]) await this.depth(d.symbol, d.bids, d.asks);
  }

  /** Standard SIMULATED book for the preview fixtures (+ conversion pairs). */
  async standard(): Promise<void> {
    await this.status({ state: 'ok', feed: 'up', staleSymbols: [], ts: null });
    await this.quote('EURUSD', '1.08419', '1.08421');
    await this.quote('XAUUSD', '2395.30', '2395.50');
    await this.quote('BTCUSD', '64811.5', '64813.5');
    await this.quote('AAPL', '221.36', '221.38');
    await this.quote('SAP.XETR', '202.38', '202.42');
    await this.quote('GBPUSD', '1.26410', '1.26414');
    await this.quote('USDJPY', '148.214', '148.216');
  }

  async close(): Promise<void> {
    this.redis.disconnect();
  }
}

/**
 * IRTC R6-15: the one date constant the trading scenarios derive from. A Wednesday when FX, US
 * equities (10:00 New York) and Xetra (16:00 Frankfurt) are all open, in US and EU summer time
 * (moving it into winter time shifts the session edges the scenarios use by one hour).
 */
export const MARKET_OPEN_UTC = new Date('2026-09-30T14:00:00Z');

/**
 * Effective date of the seeded legal content (migration 0091 disclosures, the appropriateness
 * questionnaire). A scenario clock before it has no risk warning or questionnaire in force.
 */
export const SEED_EFFECTIVE_UTC = new Date('2026-09-26T00:00:00Z');

/**
 * A UTC wall-clock time `days` after the Wednesday of MARKET_OPEN_UTC (0 = that Wednesday,
 * -2 = the Monday before, 2 = Friday, 3 = Saturday), so every scenario date moves with the anchor.
 */
export function marketDay(days: number, hhmmss = '14:00:00'): Date {
  const d = new Date(MARKET_OPEN_UTC.getTime() + days * 86_400_000);
  return new Date(`${d.toISOString().slice(0, 10)}T${hhmmss}Z`);
}

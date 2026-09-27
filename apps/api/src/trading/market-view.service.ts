import { Inject, Injectable } from '@nestjs/common';
import {
  dec,
  depthChannel,
  quoteChannel,
  sessionState,
  STATUS_CHANNEL,
  type Decimal,
  type DepthSnapshot,
  type FeedStatus,
  type MarketDataState,
  type Quote,
  type SessionState,
} from '@kora/domain';

import { ChannelHub } from '../market-data/channel-hub';
import { TRADING_CONFIG, type TradingConfig } from './trading-config';
import type { TradableInstrument } from './trading-registry.service';

export interface MarketSnapshot {
  symbol: string;
  quote: Quote | null;
  depth: DepthSnapshot | null;
  status: FeedStatus | null;
  session: SessionState;
  /** Fill safety verdict (goal 02 "Fill safety"). */
  safety: MarketDataState;
  safetyReason: string | null;
  bid: Decimal | null;
  ask: Decimal | null;
  mid: Decimal | null;
  /**
   * |mid − previous quote's mid| (volatility term). IRTC R2-10: it belongs to the quote that moved;
   * the next quote with an unchanged mid resets it to zero, and a move across a pause counts as zero.
   */
  lastMidMove: Decimal;
  at: number;
}

/**
 * Point-in-time market view for the engine: last quote, depth and feed status from the goal 02
 * Redis last-value cache, the venue session, and the fill-safety verdict. Never fills on a missing
 * or stale quote, a feed that is not `up` for the quote's source, or a stale/old status.
 */
@Injectable()
export class MarketViewService {
  /** Last quote seen per symbol: its sequence, mid, receive time and the move it carried. */
  private readonly lastQuote = new Map<
    string,
    { seq: number; mid: Decimal; move: Decimal; receivedTs: number }
  >();

  constructor(
    private readonly hub: ChannelHub,
    @Inject(TRADING_CONFIG) private readonly cfg: TradingConfig,
  ) {}

  async snapshot(inst: TradableInstrument, now = Date.now()): Promise<MarketSnapshot> {
    const sym = inst.spec.symbol;
    const [q, d, s] = await this.hub.getLast([
      quoteChannel(sym),
      depthChannel(sym),
      STATUS_CHANNEL,
    ]);
    const quote = q ? (JSON.parse(q) as Quote) : null;
    const depth = d ? (JSON.parse(d) as DepthSnapshot) : null;
    const status = s ? (JSON.parse(s) as FeedStatus) : null;
    const tz = inst.spec.tradingSessions?.timezone ?? inst.venue.timezone;
    const session = this.cfg.sessionOverride.has(sym)
      ? 'open'
      : sessionState(inst.spec.tradingSessions ?? inst.venue.calendar, tz, now);
    const { safety, reason } = this.safety(quote, status, inst.staleAfterMs, now);
    const bid = quote ? dec(quote.bid) : null;
    const ask = quote ? dec(quote.ask) : null;
    const mid = bid && ask ? bid.add(ask).div(2) : null;
    let lastMidMove = dec(0);
    if (mid && quote) {
      // A pure function of consecutive quotes: previews and other callers cannot change it, and a
      // move is never carried beyond the quote that made it.
      const prev = this.lastQuote.get(sym);
      if (prev && prev.seq === quote.seq) {
        lastMidMove = prev.move;
      } else {
        const paused = !prev || quote.receivedTs - prev.receivedTs > inst.staleAfterMs;
        lastMidMove = paused ? dec(0) : mid.sub(prev.mid).abs();
        this.lastQuote.set(sym, { seq: quote.seq, mid, move: lastMidMove, receivedTs: quote.receivedTs });
      }
    }
    // Depth must belong to the same instant's book side; ignore a depth older than the quote's stale window.
    const freshDepth = depth && now - depth.receivedTs <= inst.staleAfterMs ? depth : null;
    return {
      symbol: sym,
      quote,
      depth: freshDepth,
      status,
      session,
      safety,
      safetyReason: reason,
      bid,
      ask,
      mid,
      lastMidMove,
      at: now,
    };
  }

  safety(
    quote: Quote | null,
    status: FeedStatus | null,
    staleAfterMs: number,
    now: number,
  ): { safety: MarketDataState; reason: string | null } {
    if (!quote) return { safety: 'no_quote', reason: 'no quote' };
    if (quote.stale) return { safety: 'stale', reason: 'quote flagged stale by the feed' };
    if (now - quote.receivedTs > staleAfterMs)
      return { safety: 'stale', reason: `quote older than ${staleAfterMs} ms` };
    if (!status) return { safety: 'feed_not_ok', reason: 'no feed status' };
    if (now - status.ts > this.cfg.statusMaxAgeMs)
      return { safety: 'feed_not_ok', reason: 'feed status heartbeat is old' };
    if (status.state === 'down')
      return { safety: 'feed_not_ok', reason: `feed down (${status.reason ?? 'unknown'})` };
    const feed = status.feeds.find((f) => f.source === quote.source);
    if (!feed || feed.state !== 'up')
      return {
        safety: 'feed_not_ok',
        reason: `feed ${quote.source} is ${feed?.state ?? 'unknown'}`,
      };
    if (status.staleSymbols.includes(quote.symbol))
      return { safety: 'stale', reason: 'symbol listed stale in feed status' };
    return { safety: 'ok', reason: null };
  }

  /** Last-value quotes for valuation (stale allowed; flagged). */
  async quotes(symbols: string[]): Promise<Map<string, Quote>> {
    const raw = await this.hub.getLast(symbols.map(quoteChannel));
    const out = new Map<string, Quote>();
    raw.forEach((r, i) => {
      if (r) out.set(symbols[i]!, JSON.parse(r) as Quote);
    });
    return out;
  }
}

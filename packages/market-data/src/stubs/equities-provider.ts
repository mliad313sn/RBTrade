import type { Candle, DepthSnapshot, Quote, Timeframe, Trade } from '@kora/domain';

import { formatPrice, formatSize } from '../precision.js';
import { asRecord, StubAdapterBase, vendorDecimal, type StubCapabilities } from './base.js';

/**
 * Equities data provider stub (source "equities-provider"). Generic event-array WebSocket format
 * with short keys (`ev:"Q"` quotes, `ev:"T"` trades), JSON numbers for prices and a per-symbol
 * sequence `q`; REST aggregates for candles. Level 1 only (no depth). Hand-modelled on common
 * equities feed patterns, not copied from any vendor. Prices arrive as JSON numbers, which is why
 * every value goes through the registry rounding before it enters KORA.
 */

const AGG: Partial<Record<Timeframe, string>> = { '1m': '1/minute', '5m': '5/minute', '15m': '15/minute', '1h': '1/hour', '4h': '4/hour', '1D': '1/day' };

export class EquitiesProviderStubAdapter extends StubAdapterBase {
  readonly source = 'equities-provider';
  readonly capabilities: StubCapabilities = {
    quotes: true,
    trades: true,
    depth: false,
    candles: true,
    contiguousSeq: { quotes: true, trades: true },
  };

  encodeSubscription(symbols: string[]): unknown {
    return { action: 'subscribe', params: symbols.flatMap((s) => [`Q.${this.vendorSymbol(s)}`, `T.${this.vendorSymbol(s)}`]).join(',') };
  }

  decode(frame: unknown): Array<Quote | Trade> {
    if (!Array.isArray(frame)) throw new TypeError('frame: expected event array');
    const out: Array<Quote | Trade> = [];
    const received = this.clock();
    for (const raw of frame) {
      const e = asRecord(raw, 'event');
      if (e.ev === 'status') continue;
      const spec = this.spec(String(e.sym));
      const ts = Number(e.t);
      const seq = Number(e.q);
      if (!Number.isSafeInteger(ts) || !Number.isSafeInteger(seq)) throw new TypeError('t/q: expected integers');
      if (e.ev === 'Q') {
        out.push({
          type: 'quote',
          symbol: spec.symbol,
          bid: formatPrice(vendorDecimal(e.bp, 'bp'), spec),
          ask: formatPrice(vendorDecimal(e.ap, 'ap'), spec),
          bidSize: formatSize(vendorDecimal(e.bs, 'bs'), spec),
          askSize: formatSize(vendorDecimal(e.as, 'as'), spec),
          stale: false,
          source: this.source,
          exchangeTs: ts,
          receivedTs: received,
          seq,
        });
      } else if (e.ev === 'T') {
        out.push({
          type: 'trade',
          symbol: spec.symbol,
          tradeId: String(e.i),
          price: formatPrice(vendorDecimal(e.p, 'p'), spec),
          qty: formatSize(vendorDecimal(e.s, 's'), spec),
          side: e.side === 'sell' ? 'sell' : 'buy',
          source: this.source,
          exchangeTs: ts,
          receivedTs: received,
          seq,
        });
      } else {
        throw new TypeError(`unknown ev ${String(e.ev)}`);
      }
    }
    return out;
  }

  protected candlesPath(vendorSymbol: string, tf: Timeframe): string {
    const a = AGG[tf];
    if (!a) throw new TypeError(`timeframe ${tf} not offered`);
    return `/aggs/${vendorSymbol}/${a}`;
  }

  protected decodeCandles(symbol: string, tf: Timeframe, body: unknown): Candle[] {
    const spec = this.spec(symbol);
    const results = asRecord(body, 'aggs').results;
    if (!Array.isArray(results)) throw new TypeError('results: expected array');
    return results.map((raw, i) => {
      const r = asRecord(raw, 'agg');
      const t = Number(r.t);
      return {
        type: 'candle' as const,
        symbol: spec.symbol,
        tf,
        bucket: t,
        open: formatPrice(vendorDecimal(r.o, 'o'), spec),
        high: formatPrice(vendorDecimal(r.h, 'h'), spec),
        low: formatPrice(vendorDecimal(r.l, 'l'), spec),
        close: formatPrice(vendorDecimal(r.c, 'c'), spec),
        volume: formatSize(vendorDecimal(r.v, 'v'), spec),
        trades: Number(r.n ?? 0),
        closed: true,
        source: this.source,
        exchangeTs: t,
        receivedTs: this.clock(),
        seq: i + 1,
      };
    });
  }

  protected snapshotPath(vendorSymbol: string): string {
    return `/last/quote/${vendorSymbol}`;
  }

  protected decodeSnapshot(symbol: string, body: unknown): { quote: Quote | null; depth: DepthSnapshot | null } {
    const r = asRecord(body, 'last').results;
    const [quote] = this.decode([{ ...asRecord(r, 'results'), ev: 'Q', sym: this.vendorSymbol(symbol) }]);
    return { quote: (quote as Quote | undefined) ?? null, depth: null };
  }
}

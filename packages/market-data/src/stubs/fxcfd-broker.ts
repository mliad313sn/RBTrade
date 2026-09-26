import type { Candle, DepthSnapshot, Quote, Timeframe } from '@kora/domain';

import { formatPrice, formatSize } from '../precision.js';
import { asRecord, StubAdapterBase, vendorDecimal, type StubCapabilities } from './base.js';

/**
 * FX/CFD broker stub (source "broker-fxcfd"). Generic newline-delimited JSON pricing stream:
 * `{type:"PRICE", instrument:"EUR_USD", time, bids:[{price, liquidity}], asks:[…]}` plus
 * `{type:"HEARTBEAT"}`. The format is hand-modelled on common retail-broker streaming APIs; it is
 * not a copy of any vendor's contract. The stream has no sequence numbers, so the stub assigns a
 * local per-instrument counter and gap detection does not apply (contiguousSeq.quotes = false).
 */

const GRANULARITY: Partial<Record<Timeframe, string>> = { '1m': 'M1', '5m': 'M5', '15m': 'M15', '1h': 'H1', '4h': 'H4', '1D': 'D' };

export class FxCfdBrokerStubAdapter extends StubAdapterBase {
  readonly source = 'broker-fxcfd';
  readonly capabilities: StubCapabilities = {
    quotes: true,
    trades: false,
    depth: false,
    candles: true,
    contiguousSeq: { quotes: false, trades: false },
  };
  private readonly counters = new Map<string, number>();

  encodeSubscription(symbols: string[]): unknown {
    return { instruments: symbols.map((s) => this.vendorSymbol(s)).join(',') };
  }

  decode(frame: unknown): Quote[] {
    const f = asRecord(frame, 'frame');
    if (f.type === 'HEARTBEAT') return [];
    if (f.type !== 'PRICE') throw new TypeError(`unknown frame type ${String(f.type)}`);
    const spec = this.spec(String(f.instrument));
    const top = (side: unknown, what: string): { price: string; size: string } => {
      if (!Array.isArray(side) || side.length === 0) throw new TypeError(`${what}: empty`);
      const lvl = asRecord(side[0], what);
      return { price: formatPrice(vendorDecimal(lvl.price, what), spec), size: formatSize(vendorDecimal(lvl.liquidity, what), spec) };
    };
    const bid = top(f.bids, 'bids');
    const ask = top(f.asks, 'asks');
    const seq = (this.counters.get(spec.symbol) ?? 0) + 1;
    this.counters.set(spec.symbol, seq);
    return [
      {
        type: 'quote',
        symbol: spec.symbol,
        bid: bid.price,
        ask: ask.price,
        bidSize: bid.size,
        askSize: ask.size,
        stale: f.tradeable === false,
        source: this.source,
        exchangeTs: Date.parse(String(f.time)),
        receivedTs: this.clock(),
        seq,
      },
    ];
  }

  protected candlesPath(vendorSymbol: string, tf: Timeframe): string {
    const g = GRANULARITY[tf];
    if (!g) throw new TypeError(`timeframe ${tf} not offered`);
    return `/instruments/${vendorSymbol}/candles?granularity=${g}`;
  }

  protected decodeCandles(symbol: string, tf: Timeframe, body: unknown): Candle[] {
    const spec = this.spec(symbol);
    const list = asRecord(body, 'candles').candles;
    if (!Array.isArray(list)) throw new TypeError('candles: expected array');
    return list.map((raw, i) => {
      const c = asRecord(raw, 'candle');
      const mid = asRecord(c.mid, 'mid');
      const t = Date.parse(String(c.time));
      return {
        type: 'candle' as const,
        symbol: spec.symbol,
        tf,
        bucket: t,
        open: formatPrice(vendorDecimal(mid.o, 'o'), spec),
        high: formatPrice(vendorDecimal(mid.h, 'h'), spec),
        low: formatPrice(vendorDecimal(mid.l, 'l'), spec),
        close: formatPrice(vendorDecimal(mid.c, 'c'), spec),
        volume: formatSize(vendorDecimal(c.volume, 'volume'), spec),
        trades: 0,
        closed: c.complete === true,
        source: this.source,
        exchangeTs: t,
        receivedTs: this.clock(),
        seq: i + 1,
      };
    });
  }

  protected snapshotPath(vendorSymbol: string): string {
    return `/pricing?instruments=${vendorSymbol}`;
  }

  protected decodeSnapshot(symbol: string, body: unknown): { quote: Quote | null; depth: DepthSnapshot | null } {
    const prices = asRecord(body, 'pricing').prices;
    if (!Array.isArray(prices) || prices.length === 0) return { quote: null, depth: null };
    const [quote] = this.decode({ ...asRecord(prices[0], 'price'), type: 'PRICE' });
    return { quote: quote && quote.symbol === symbol ? quote : null, depth: null };
  }
}

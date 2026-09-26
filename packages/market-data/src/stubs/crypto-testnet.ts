import type { Candle, DepthDelta, DepthLevel, DepthSnapshot, InstrumentSpec, Quote, Timeframe, Trade } from '@kora/domain';

import { formatPrice, formatSize } from '../precision.js';
import { asRecord, StubAdapterBase, vendorDecimal, type StubCapabilities } from './base.js';

/**
 * Crypto exchange testnet stub (source "crypto-testnet"). Generic diff-depth WebSocket format:
 * `depthUpdate` with first/last update ids (U/u), `trade` with a per-symbol trade id, `bookTicker`
 * for the touch; REST depth snapshot with `lastUpdateId` and klines as arrays. Hand-modelled on
 * the common public diff-depth pattern, not copied from any vendor. Depth deltas carry
 * prevSeq = U − 1 so the order book accepts overlapping ranges and detects real gaps.
 */

const INTERVAL: Partial<Record<Timeframe, string>> = { '1m': '1m', '5m': '5m', '15m': '15m', '1h': '1h', '4h': '4h', '1D': '1d' };

export class CryptoTestnetStubAdapter extends StubAdapterBase {
  readonly source = 'crypto-testnet';
  readonly capabilities: StubCapabilities = {
    quotes: true,
    trades: true,
    depth: true,
    candles: true,
    contiguousSeq: { quotes: false, trades: true },
  };

  encodeSubscription(symbols: string[]): unknown {
    const streams = symbols.flatMap((s) => {
      const v = this.vendorSymbol(s).toLowerCase();
      return [`${v}@depth`, `${v}@trade`, `${v}@bookTicker`];
    });
    return { method: 'SUBSCRIBE', params: streams, id: 1 };
  }

  decode(frame: unknown): Array<Quote | Trade | DepthDelta> {
    const f = asRecord(frame, 'frame');
    const spec = this.spec(String(f.s));
    const received = this.clock();
    switch (f.e) {
      case 'depthUpdate':
        return [
          {
            type: 'depth_delta',
            symbol: spec.symbol,
            bids: levels(f.b, spec, 'b'),
            asks: levels(f.a, spec, 'a'),
            prevSeq: int(f.U, 'U') - 1,
            seq: int(f.u, 'u'),
            source: this.source,
            exchangeTs: int(f.E, 'E'),
            receivedTs: received,
          },
        ];
      case 'trade':
        return [
          {
            type: 'trade',
            symbol: spec.symbol,
            tradeId: String(int(f.t, 't')),
            price: formatPrice(vendorDecimal(f.p, 'p'), spec),
            qty: formatSize(vendorDecimal(f.q, 'q'), spec),
            // m = buyer is the maker, so the aggressor sold.
            side: f.m === true ? 'sell' : 'buy',
            source: this.source,
            exchangeTs: int(f.E, 'E'),
            receivedTs: received,
            seq: int(f.t, 't'),
          },
        ];
      case 'bookTicker':
        return [
          {
            type: 'quote',
            symbol: spec.symbol,
            bid: formatPrice(vendorDecimal(f.b, 'b'), spec),
            ask: formatPrice(vendorDecimal(f.a, 'a'), spec),
            bidSize: formatSize(vendorDecimal(f.B, 'B'), spec),
            askSize: formatSize(vendorDecimal(f.A, 'A'), spec),
            stale: false,
            source: this.source,
            exchangeTs: int(f.E, 'E'),
            receivedTs: received,
            seq: int(f.u, 'u'),
          },
        ];
      default:
        throw new TypeError(`unknown event ${String(f.e)}`);
    }
  }

  protected candlesPath(vendorSymbol: string, tf: Timeframe): string {
    const i = INTERVAL[tf];
    if (!i) throw new TypeError(`timeframe ${tf} not offered`);
    return `/klines?symbol=${vendorSymbol}&interval=${i}`;
  }

  protected decodeCandles(symbol: string, tf: Timeframe, body: unknown): Candle[] {
    const spec = this.spec(symbol);
    if (!Array.isArray(body)) throw new TypeError('klines: expected array');
    return body.map((row: unknown, i) => {
      if (!Array.isArray(row) || row.length < 9) throw new TypeError('kline row');
      const t = int(row[0], 'openTime');
      return {
        type: 'candle' as const,
        symbol: spec.symbol,
        tf,
        bucket: t,
        open: formatPrice(vendorDecimal(row[1], 'o'), spec),
        high: formatPrice(vendorDecimal(row[2], 'h'), spec),
        low: formatPrice(vendorDecimal(row[3], 'l'), spec),
        close: formatPrice(vendorDecimal(row[4], 'c'), spec),
        volume: formatSize(vendorDecimal(row[5], 'v'), spec),
        trades: int(row[8], 'n'),
        closed: true,
        source: this.source,
        exchangeTs: t,
        receivedTs: this.clock(),
        seq: i + 1,
      };
    });
  }

  protected snapshotPath(vendorSymbol: string, levels: number): string {
    return `/depth?symbol=${vendorSymbol}&limit=${levels}`;
  }

  protected decodeSnapshot(symbol: string, body: unknown): { quote: Quote | null; depth: DepthSnapshot | null } {
    const spec = this.spec(symbol);
    const b = asRecord(body, 'depth');
    const seq = int(b.lastUpdateId, 'lastUpdateId');
    const now = this.clock();
    const depth: DepthSnapshot = {
      type: 'depth_snapshot',
      symbol: spec.symbol,
      bids: levels(b.bids, spec, 'bids'),
      asks: levels(b.asks, spec, 'asks'),
      source: this.source,
      exchangeTs: now,
      receivedTs: now,
      seq,
    };
    const [bb] = depth.bids;
    const [ba] = depth.asks;
    const quote: Quote | null =
      bb && ba
        ? { type: 'quote', symbol: spec.symbol, bid: bb[0], ask: ba[0], bidSize: bb[1], askSize: ba[1], stale: false, source: this.source, exchangeTs: now, receivedTs: now, seq }
        : null;
    return { quote, depth };
  }
}

function int(v: unknown, what: string): number {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return v;
  throw new TypeError(`${what}: expected non-negative integer`);
}

function levels(v: unknown, spec: InstrumentSpec, what: string): DepthLevel[] {
  if (!Array.isArray(v)) throw new TypeError(`${what}: expected array`);
  return v.map((l: unknown) => {
    if (!Array.isArray(l) || l.length < 2) throw new TypeError(`${what}: level`);
    return [formatPrice(vendorDecimal(l[0], what), spec), formatSize(vendorDecimal(l[1], what), spec)] as DepthLevel;
  });
}

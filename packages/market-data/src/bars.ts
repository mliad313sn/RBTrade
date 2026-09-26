import { bucketStart, type Decimal, dec, TIMEFRAMES, type Candle, type Timeframe, type Trade } from '@kora/domain';

/**
 * OHLCV aggregation shared by the live bar builder, the history generator and tests. The SQL
 * rollup (`md_refresh_candles`) implements the same rules: open = first, close = last, high = max,
 * low = min, volume and trade count summed, buckets aligned to UTC.
 */

export interface OhlcvBar {
  /** Bucket start, epoch ms UTC. */
  bucket: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  trades: number;
}

const maxS = (a: string, b: string): string => (dec(b).gt(dec(a)) ? b : a);
const minS = (a: string, b: string): string => (dec(b).lt(dec(a)) ? b : a);
const addS = (a: string, b: string, places?: number): string => {
  const s = dec(a).add(dec(b));
  return places === undefined ? s.toFixed() : s.toFixed(places);
};

/** Merge two bars of the same bucket where `a` precedes `b` in time. */
export function mergeBars(a: OhlcvBar, b: OhlcvBar, volumePlaces?: number): OhlcvBar {
  return {
    bucket: a.bucket,
    open: a.open,
    high: maxS(a.high, b.high),
    low: minS(a.low, b.low),
    close: b.close,
    volume: addS(a.volume, b.volume, volumePlaces),
    trades: a.trades + b.trades,
  };
}

/** Aggregate time-ordered finer bars into `tf` buckets. Input bars must each fit inside one bucket. */
export function aggregateBars(bars: readonly OhlcvBar[], tf: Timeframe, volumePlaces?: number): OhlcvBar[] {
  const out: OhlcvBar[] = [];
  let cur: OhlcvBar | null = null;
  let prevBucket = -Infinity;
  for (const b of bars) {
    if (b.bucket < prevBucket) throw new RangeError('bars must be time-ordered');
    prevBucket = b.bucket;
    const bucket = bucketStart(b.bucket, tf);
    const bb = { ...b, bucket };
    if (cur && cur.bucket === bucket) cur = mergeBars(cur, bb, volumePlaces);
    else {
      if (cur) out.push(cur);
      cur = volumePlaces === undefined ? bb : { ...bb, volume: dec(bb.volume).toFixed(volumePlaces) };
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Builds 1-second bars from trades (per symbol) and reports completed seconds. */
export class BarBuilder {
  private readonly current = new Map<string, OhlcvBar>();

  constructor(private readonly volumePlaces: (symbol: string) => number) {}

  onTrade(t: Pick<Trade, 'symbol' | 'price' | 'qty' | 'exchangeTs'>): OhlcvBar[] {
    const bucket = bucketStart(t.exchangeTs, '1s');
    const cur = this.current.get(t.symbol);
    const bar: OhlcvBar = { bucket, open: t.price, high: t.price, low: t.price, close: t.price, volume: t.qty, trades: 1 };
    if (!cur) {
      this.current.set(t.symbol, bar);
      return [];
    }
    if (bucket === cur.bucket) {
      this.current.set(t.symbol, mergeBars(cur, bar, this.volumePlaces(t.symbol)));
      return [];
    }
    if (bucket < cur.bucket) return []; // late trade for a closed second: ignored (logged by caller)
    this.current.set(t.symbol, bar);
    return [cur];
  }

  /** Bars whose second ended before `now` (flushes quiet symbols). */
  flush(now: number): Array<{ symbol: string; bar: OhlcvBar }> {
    const done: Array<{ symbol: string; bar: OhlcvBar }> = [];
    const cutoff = bucketStart(now, '1s');
    for (const [symbol, bar] of this.current) {
      if (bar.bucket < cutoff) {
        done.push({ symbol, bar });
        this.current.delete(symbol);
      }
    }
    return done;
  }

  peek(symbol: string): OhlcvBar | undefined {
    return this.current.get(symbol);
  }
}

/** In-progress candles for every timeframe, fed with completed 1 s bars. */
export class CandleTracker {
  private readonly state = new Map<string, OhlcvBar>();

  constructor(
    private readonly source: string,
    private readonly timeframes: readonly Timeframe[] = TIMEFRAMES.filter((t) => t !== '1s'),
  ) {}

  /** Returns the updated candle per timeframe (closed=false) and any candle that just closed. */
  update(symbol: string, bar: OhlcvBar, seq: number, volumePlaces: number): Candle[] {
    const out: Candle[] = [];
    for (const tf of this.timeframes) {
      const key = `${symbol}|${tf}`;
      const bucket = bucketStart(bar.bucket, tf);
      const prev = this.state.get(key);
      let next: OhlcvBar;
      if (prev && prev.bucket === bucket) next = mergeBars(prev, { ...bar, bucket }, volumePlaces);
      else {
        if (prev && prev.bucket < bucket) out.push(this.toCandle(symbol, tf, prev, true, seq, bar.bucket));
        next = { ...bar, bucket };
      }
      this.state.set(key, next);
      out.push(this.toCandle(symbol, tf, next, false, seq, bar.bucket));
    }
    return out;
  }

  current(symbol: string, tf: Timeframe): OhlcvBar | undefined {
    return this.state.get(`${symbol}|${tf}`);
  }

  private toCandle(symbol: string, tf: Timeframe, b: OhlcvBar, closed: boolean, seq: number, ts: number): Candle {
    return {
      type: 'candle',
      symbol,
      tf,
      bucket: b.bucket,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: b.volume,
      trades: b.trades,
      closed,
      source: this.source,
      exchangeTs: ts,
      receivedTs: ts,
      seq,
    };
  }
}

/** Invariants every OHLCV bar must satisfy (used by tests and ingestion guards). */
export function isValidBar(b: OhlcvBar): boolean {
  const [o, h, l, c, v] = [b.open, b.high, b.low, b.close, b.volume].map((x) => dec(x)) as [Decimal, Decimal, Decimal, Decimal, Decimal];
  return h.gte(o) && h.gte(c) && h.gte(l) && l.lte(o) && l.lte(c) && v.gte(0) && b.trades >= 0;
}

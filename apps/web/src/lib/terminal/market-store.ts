import type { Candle, DepthSnapshot, FeedStatus, Quote, Timeframe, TradesBatch } from '@kora/domain';
import { MarketDataSocket, type ChannelHandler, type SocketState, type WebSocketCtor } from '@kora/sdk';

/**
 * One market data socket per terminal, with reference-counted subscriptions and a frame-batched
 * hot path (goal 04, ADR 0004 §2).
 *
 * Quotes, depth and prints are queued as they arrive and delivered to listeners once per animation
 * frame (latest value wins per symbol). Listeners write to the DOM directly, so a tick never
 * re-renders a React list. Tick-to-paint is recorded per delivered update: WS frame received →
 * the frame after the DOM write (i.e. painted), in `window.__koraPerf.ticks` (ms).
 */

export type Listener<T> = (value: T) => void;
type Schedule = (cb: () => void) => void;

export interface MarketStoreOptions {
  url: string;
  WebSocket?: WebSocketCtor;
  schedule?: Schedule;
  now?: () => number;
}

interface Channel<T> {
  listeners: Set<Listener<T>>;
  unsub: () => void;
  last: T | null;
}

export interface PerfSink {
  ticks: number[];
  frames: number;
}

const MAX_SAMPLES = 2000;

function defaultSchedule(cb: () => void): void {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => cb());
  else setTimeout(cb, 16);
}

export class MarketStore {
  private socket: MarketDataSocket | null = null;
  private readonly quoteCh = new Map<string, Channel<Quote>>();
  private readonly depthCh = new Map<string, Channel<DepthSnapshot>>();
  private readonly tradeCh = new Map<string, Channel<TradesBatch>>();
  private readonly pending = new Map<string, { kind: 'q' | 'd' | 't'; symbol: string; value: unknown; at: number }>();
  private scheduled = false;
  private statusValue: FeedStatus | null = null;
  private readonly statusListeners = new Set<Listener<FeedStatus>>();
  private readonly stateListeners = new Set<Listener<SocketState>>();
  private statusUnsub: (() => void) | null = null;
  readonly perf: PerfSink = { ticks: [], frames: 0 };
  private readonly schedule: Schedule;
  private readonly now: () => number;

  constructor(private readonly opts: MarketStoreOptions) {
    this.schedule = opts.schedule ?? defaultSchedule;
    this.now = opts.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    if (typeof window !== 'undefined') (window as unknown as { __koraPerf?: PerfSink }).__koraPerf = this.perf;
  }

  get state(): SocketState {
    return this.socket?.state ?? 'idle';
  }

  get status(): FeedStatus | null {
    return this.statusValue;
  }

  lastQuote(symbol: string): Quote | null {
    return this.quoteCh.get(symbol)?.last ?? null;
  }

  lastDepth(symbol: string): DepthSnapshot | null {
    return this.depthCh.get(symbol)?.last ?? null;
  }

  private ensure(): MarketDataSocket {
    if (this.socket) return this.socket;
    const s = new MarketDataSocket({ url: this.opts.url, ...(this.opts.WebSocket ? { WebSocket: this.opts.WebSocket } : {}) });
    s.onState((st) => this.stateListeners.forEach((l) => l(st)));
    this.statusUnsub = s.status((st) => {
      this.statusValue = st;
      this.statusListeners.forEach((l) => l(st));
    });
    this.socket = s;
    s.connect();
    return s;
  }

  private queue(kind: 'q' | 'd' | 't', symbol: string, value: unknown): void {
    const key = `${kind}:${symbol}`;
    const prev = this.pending.get(key);
    if (kind === 't' && prev) {
      // Prints accumulate; quotes and depth are latest-wins.
      const a = prev.value as TradesBatch;
      const b = value as TradesBatch;
      this.pending.set(key, { ...prev, value: { ...b, trades: [...a.trades, ...b.trades] } });
    } else {
      this.pending.set(key, { kind, symbol, value, at: prev?.at ?? this.now() });
    }
    if (!this.scheduled) {
      this.scheduled = true;
      this.schedule(() => this.flush());
    }
  }

  /** Delivers queued updates (one animation frame). Public for tests. */
  flush(): void {
    this.scheduled = false;
    if (this.pending.size === 0) return;
    const batch = [...this.pending.values()];
    this.pending.clear();
    for (const u of batch) {
      if (u.kind === 'q') this.deliver(this.quoteCh.get(u.symbol), u.value as Quote);
      else if (u.kind === 'd') this.deliver(this.depthCh.get(u.symbol), u.value as DepthSnapshot);
      else this.deliver(this.tradeCh.get(u.symbol), u.value as TradesBatch);
    }
    this.perf.frames += 1;
    const arrivals = batch.map((u) => u.at);
    // The DOM writes above are painted at the end of this frame; the next frame starts after it.
    this.schedule(() => {
      const t = this.now();
      for (const at of arrivals) this.perf.ticks.push(t - at);
      if (this.perf.ticks.length > MAX_SAMPLES) this.perf.ticks.splice(0, this.perf.ticks.length - MAX_SAMPLES);
    });
  }

  private deliver<T>(ch: Channel<T> | undefined, v: T): void {
    if (!ch) return;
    ch.last = v;
    for (const l of ch.listeners) l(v);
  }

  private add<T>(map: Map<string, Channel<T>>, symbol: string, listener: Listener<T>, open: () => () => void): () => void {
    let ch = map.get(symbol);
    if (!ch) {
      ch = { listeners: new Set(), unsub: () => undefined, last: null };
      map.set(symbol, ch);
      ch.unsub = open();
    } else if (ch.last) {
      listener(ch.last);
    }
    ch.listeners.add(listener);
    return () => {
      const c = map.get(symbol);
      if (!c) return;
      c.listeners.delete(listener);
      if (c.listeners.size === 0) {
        c.unsub();
        map.delete(symbol);
      }
    };
  }

  onQuote(symbol: string, listener: Listener<Quote>): () => void {
    return this.add(this.quoteCh, symbol, listener, () => this.ensure().quotes(symbol, (q) => this.queue('q', symbol, q)));
  }

  onDepth(symbol: string, listener: Listener<DepthSnapshot>): () => void {
    return this.add(this.depthCh, symbol, listener, () => this.ensure().depth(symbol, (d) => this.queue('d', symbol, d)));
  }

  onTrades(symbol: string, listener: Listener<TradesBatch>): () => void {
    return this.add(this.tradeCh, symbol, listener, () => this.ensure().trades(symbol, (t) => this.queue('t', symbol, t)));
  }

  /** Candles are low frequency (closed bars + the forming bar); delivered as they arrive. */
  onCandle(symbol: string, tf: Timeframe, listener: ChannelHandler<Candle>): () => void {
    return this.ensure().candles(symbol, tf, listener);
  }

  /** Private trading channels and anything else: passthrough, never batched (order events are a stream). */
  subscribe<T>(channel: string, handler: ChannelHandler<T>): () => void {
    return this.ensure().subscribe(channel, handler);
  }

  onStatus(listener: Listener<FeedStatus>): () => void {
    this.ensure();
    this.statusListeners.add(listener);
    if (this.statusValue) listener(this.statusValue);
    return () => this.statusListeners.delete(listener);
  }

  onState(listener: Listener<SocketState>): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  close(): void {
    this.statusUnsub?.();
    this.socket?.close();
    this.socket = null;
    this.quoteCh.clear();
    this.depthCh.clear();
    this.tradeCh.clear();
    this.pending.clear();
  }
}

/** p-quantile of samples (ms), for the perf readout and e2e. */
export function percentile(samples: readonly number[], p: number): number | null {
  if (!samples.length) return null;
  const s = [...samples].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]!;
}

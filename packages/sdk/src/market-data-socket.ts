import {
  accountChannel,
  candleChannel,
  depthChannel,
  ordersChannel,
  positionsChannel,
  quoteChannel,
  STATUS_CHANNEL,
  tradesChannel,
  type OrderDto,
  type PositionDto,
  type TradesBatch,
  type Candle,
  type DepthSnapshot,
  type FeedStatus,
  type Quote,
  type Timeframe,
} from '@kora/domain';

/**
 * Typed market data WebSocket client (goal 02). Auto-reconnects with exponential backoff and
 * jitter, re-authenticates and resubscribes every channel after a reconnect, and detects dead
 * connections with an application-level ping. Browsers authenticate with the session cookie;
 * other clients pass `token` (string or provider).
 */

export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}
export type WebSocketCtor = new (url: string) => WebSocketLike;

export interface SocketTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(h: unknown): void;
}

export interface MarketDataSocketOptions {
  url: string;
  token?: string | (() => string | Promise<string>);
  WebSocket?: WebSocketCtor;
  backoff?: { initialMs?: number; maxMs?: number; factor?: number; jitter?: number };
  /** Ping interval; the connection is recycled if nothing arrives for 2.5× this. */
  heartbeatMs?: number;
  random?: () => number;
  timers?: SocketTimers;
  now?: () => number;
}

export type SocketState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';
export interface ChannelMeta {
  channel: string;
  snapshot: boolean;
}
export type ChannelHandler<T = unknown> = (data: T, meta: ChannelMeta) => void;
export interface ServerError {
  type: 'error';
  code: string;
  message: string;
}

const OPEN = 1;
const AUTH_CLOSE_CODES = new Set([4401, 4403]);
const MAX_CHANNELS_PER_OP = 100;

const defaultTimers: SocketTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

function cryptoRandom(): number {
  const a = new Uint32Array(1);
  globalThis.crypto.getRandomValues(a);
  return a[0]! / 4294967296;
}

export class MarketDataSocket {
  private ws: WebSocketLike | null = null;
  private readonly subs = new Map<string, Set<ChannelHandler>>();
  private readonly stateListeners = new Set<(s: SocketState) => void>();
  private readonly errorListeners = new Set<(e: ServerError) => void>();
  private readonly timers: SocketTimers;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly Ws: WebSocketCtor;
  private stateValue: SocketState = 'idle';
  private attempt = 0;
  private reconnectTimer: unknown = null;
  private heartbeatTimer: unknown = null;
  private lastMessageAt = 0;
  private stopped = false;
  reconnects = 0;

  constructor(private readonly opts: MarketDataSocketOptions) {
    this.timers = opts.timers ?? defaultTimers;
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? cryptoRandom;
    const ctor = opts.WebSocket ?? (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;
    if (!ctor) throw new Error('No WebSocket implementation available; pass options.WebSocket');
    this.Ws = ctor;
  }

  get state(): SocketState {
    return this.stateValue;
  }

  connect(): this {
    this.stopped = false;
    if (this.stateValue === 'idle' || this.stateValue === 'closed') this.open();
    return this;
  }

  /** Permanently closes; no reconnect. */
  close(): void {
    this.stopped = true;
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    ws?.close(1000, 'client closed');
    this.setState('closed');
  }

  subscribe<T = unknown>(channel: string, handler: ChannelHandler<T>): () => void {
    let set = this.subs.get(channel);
    const first = !set;
    if (!set) {
      set = new Set();
      this.subs.set(channel, set);
    }
    set.add(handler as ChannelHandler);
    if (first) this.sendOp({ op: 'subscribe', channels: [channel] });
    return () => {
      const s = this.subs.get(channel);
      if (!s?.delete(handler as ChannelHandler) || s.size > 0) return;
      this.subs.delete(channel);
      this.sendOp({ op: 'unsubscribe', channels: [channel] });
    };
  }

  quotes(symbol: string, handler: ChannelHandler<Quote>): () => void {
    return this.subscribe(quoteChannel(symbol), handler);
  }

  depth(symbol: string, handler: ChannelHandler<DepthSnapshot>): () => void {
    return this.subscribe(depthChannel(symbol), handler);
  }

  candles(symbol: string, tf: Timeframe, handler: ChannelHandler<Candle>): () => void {
    return this.subscribe(candleChannel(symbol, tf), handler);
  }

  /** Time and sales (B-210): batches of prints. */
  trades(symbol: string, handler: ChannelHandler<TradesBatch>): () => void {
    return this.subscribe(tradesChannel(symbol), handler);
  }

  /** Private (owner-only) order events: every committed transaction, never conflated. */
  orders(accountId: string, handler: ChannelHandler<{ type: 'orders'; accountId: string; orders: OrderDto[] }>): () => void {
    return this.subscribe(ordersChannel(accountId), handler);
  }

  positions(accountId: string, handler: ChannelHandler<{ type: 'positions'; positions: PositionDto[] }>): () => void {
    return this.subscribe(positionsChannel(accountId), handler);
  }

  /** Account snapshots (coalesced 50 ms); the payload is the same view as GET /accounts/me. */
  account<T = unknown>(accountId: string, handler: ChannelHandler<{ type: 'account'; account: T }>): () => void {
    return this.subscribe(accountChannel(accountId), handler);
  }

  status(handler: ChannelHandler<FeedStatus>): () => void {
    return this.subscribe(STATUS_CHANNEL, handler);
  }

  onState(listener: (s: SocketState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  onError(listener: (e: ServerError) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  channels(): string[] {
    return [...this.subs.keys()];
  }

  /** Delay before reconnect attempt `n` (0-based): min(max, initial·factor^n) reduced by up to `jitter`. */
  backoffDelay(n: number): number {
    const { initialMs = 500, maxMs = 30_000, factor = 2, jitter = 0.3 } = this.opts.backoff ?? {};
    const base = Math.min(maxMs, initialMs * factor ** n);
    return Math.round(base * (1 - jitter * this.random()));
  }

  private open(): void {
    this.setState(this.attempt === 0 ? 'connecting' : 'reconnecting');
    const ws = new this.Ws(this.opts.url);
    this.ws = ws;
    ws.onopen = () => void this.onOpen(ws);
    ws.onmessage = (ev) => this.onMessage(ev.data);
    ws.onerror = () => undefined; // onclose follows
    ws.onclose = (ev) => this.onClose(ws, ev.code);
  }

  private async onOpen(ws: WebSocketLike): Promise<void> {
    if (ws !== this.ws) return;
    const t = this.opts.token;
    if (t) {
      const token = typeof t === 'function' ? await t() : t;
      if (ws !== this.ws) return;
      ws.send(JSON.stringify({ op: 'auth', token }));
    }
    const all = [...this.subs.keys()];
    for (let i = 0; i < all.length; i += MAX_CHANNELS_PER_OP) {
      ws.send(JSON.stringify({ op: 'subscribe', channels: all.slice(i, i + MAX_CHANNELS_PER_OP) }));
    }
    this.attempt = 0;
    this.lastMessageAt = this.now();
    this.startHeartbeat();
    this.setState('open');
  }

  private onMessage(raw: unknown): void {
    this.lastMessageAt = this.now();
    let msg: { ch?: string; data?: unknown; snapshot?: boolean; type?: string; code?: string; message?: string };
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : String(raw)) as typeof msg;
    } catch {
      return;
    }
    if (msg.ch) {
      const set = this.subs.get(msg.ch);
      if (!set) return;
      const meta = { channel: msg.ch, snapshot: msg.snapshot === true };
      for (const h of set) h(msg.data, meta);
    } else if (msg.type === 'error') {
      for (const l of this.errorListeners) l({ type: 'error', code: msg.code ?? 'error', message: msg.message ?? '' });
    }
  }

  private onClose(ws: WebSocketLike, code: number): void {
    if (ws !== this.ws) return;
    this.ws = null;
    this.clearTimers();
    if (this.stopped) return this.setState('closed');
    if (AUTH_CLOSE_CODES.has(code) && typeof this.opts.token !== 'function') {
      for (const l of this.errorListeners) l({ type: 'error', code: `close_${code}`, message: 'Authentication rejected' });
      return this.setState('closed');
    }
    const delay = this.backoffDelay(this.attempt);
    this.attempt += 1;
    this.reconnects += 1;
    this.setState('reconnecting');
    this.reconnectTimer = this.timers.setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) this.open();
    }, delay);
  }

  private startHeartbeat(): void {
    const every = this.opts.heartbeatMs ?? 15_000;
    this.heartbeatTimer = this.timers.setInterval(() => {
      const ws = this.ws;
      if (!ws) return;
      if (this.now() - this.lastMessageAt > every * 2.5) {
        ws.close(4000, 'heartbeat timeout');
        this.onClose(ws, 4000);
        return;
      }
      if (ws.readyState === OPEN) ws.send(JSON.stringify({ op: 'ping' }));
    }, every);
  }

  private sendOp(op: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === OPEN && this.stateValue === 'open') this.ws.send(JSON.stringify(op));
  }

  private clearTimers(): void {
    if (this.reconnectTimer !== null) this.timers.clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer !== null) this.timers.clearInterval(this.heartbeatTimer);
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
  }

  private setState(s: SocketState): void {
    if (s === this.stateValue) return;
    this.stateValue = s;
    for (const l of this.stateListeners) l(s);
  }
}

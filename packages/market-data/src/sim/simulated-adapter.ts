import {
  sessionState,
  type Candle,
  type DepthDelta,
  type DepthSnapshot,
  type Quote,
  type Timeframe,
  type Trade,
  type Venue,
} from '@kora/domain';

import {
  AdapterNotConfiguredError,
  Listeners,
  type AdapterHealth,
  type AdapterState,
  type MarketDataAdapter,
  type Unsubscribe,
} from '../adapter.js';
import { aggregateBars, type OhlcvBar } from '../bars.js';
import { diffDepth } from '../order-book.js';
import { formatSize } from '../precision.js';
import { eventsToShocks, type EconomicCalendarProvider } from './calendar.js';
import { generateHistory1m } from './history.js';
import { SimulatedMarket, type EventShock, type SimInstrument, type SimStep } from './simulated-market.js';

export interface Timers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const systemTimers: Timers = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

export interface SimulatedAdapterOptions {
  seed: string | number;
  instruments: SimInstrument[];
  venues?: Venue[];
  stepMs?: number;
  depthLevels?: number;
  clock?: () => number;
  timers?: Timers;
  shocks?: EventShock[];
  calendar?: EconomicCalendarProvider;
  /** Pause emission for symbols whose venue session is closed. Default false (feed runs 24/7). */
  respectSessions?: boolean;
  /** Minutes of 1m history available before the live start (default 30 days). */
  historyMinutes?: number;
  /** Steps delivered per timer tick before silently fast-forwarding (default 100 = 10 s). */
  maxCatchUpSteps?: number;
}

interface Sub<T> {
  symbols: Set<string>;
  cb: (m: T) => void;
}

/**
 * SimulatedAdapter: runs a `SimulatedMarket` against a clock. While disconnected the market keeps
 * its virtual time; on reconnect the missed steps are skipped (never delivered), so consumers see
 * a sequence gap and must resync, exactly like a real venue outage.
 */
export class SimulatedAdapter implements MarketDataAdapter {
  readonly source: string;
  readonly market: SimulatedMarket;
  private readonly clock: () => number;
  private readonly timers: Timers;
  private readonly stepMs: number;
  private readonly instruments = new Map<string, SimInstrument>();
  private readonly venues = new Map<string, Venue>();
  private readonly quoteSubs = new Set<Sub<Quote>>();
  private readonly tradeSubs = new Set<Sub<Trade>>();
  private readonly depthSubs = new Set<Sub<DepthSnapshot | DepthDelta>>();
  private readonly lastDelivered = new Map<string, DepthSnapshot>();
  private readonly historyCache = new Map<string, OhlcvBar[]>();
  private readonly listeners = new Listeners<AdapterHealth>();
  private timer: unknown = null;
  private state: AdapterState = 'disconnected';
  private lastMessageTs: number | null = null;
  private detail: string | null = null;

  constructor(private readonly opts: SimulatedAdapterOptions) {
    this.source = 'simulated';
    this.clock = opts.clock ?? Date.now;
    this.timers = opts.timers ?? systemTimers;
    this.stepMs = opts.stepMs ?? 100;
    for (const i of opts.instruments) this.instruments.set(i.spec.symbol, i);
    for (const v of opts.venues ?? []) this.venues.set(v.mic, v);
    const startTs = Math.floor(this.clock() / this.stepMs) * this.stepMs;
    this.market = new SimulatedMarket({
      seed: opts.seed,
      startTs,
      stepMs: this.stepMs,
      depthLevels: opts.depthLevels,
      source: this.source,
      instruments: opts.instruments,
      shocks: opts.shocks,
    });
  }

  async connect(): Promise<void> {
    if (this.state === 'connected') return;
    this.setState('connecting', null);
    if (this.opts.calendar) {
      const from = this.market.now - 3_600_000;
      this.market.addShocks(eventsToShocks(await this.opts.calendar.getEvents(from, from + 15 * 86_400_000)));
    }
    this.fastForward(this.targetStep());
    this.timer = this.timers.setInterval(() => this.tick(), Math.max(10, Math.floor(this.stepMs / 2)));
    this.setState('connected', null);
  }

  async disconnect(): Promise<void> {
    if (this.timer !== null) this.timers.clearInterval(this.timer);
    this.timer = null;
    this.setState('disconnected', 'stopped');
  }

  subscribeQuotes(symbols: string[], onQuote: (q: Quote) => void): Unsubscribe {
    return this.addSub(this.quoteSubs, symbols, onQuote);
  }

  subscribeTrades(symbols: string[], onTrade: (t: Trade) => void): Unsubscribe {
    return this.addSub(this.tradeSubs, symbols, onTrade);
  }

  subscribeDepth(symbols: string[], _levels: number, onDepth: (d: DepthSnapshot | DepthDelta) => void): Unsubscribe {
    const un = this.addSub(this.depthSubs, symbols, onDepth);
    for (const s of symbols) {
      const d = this.lastDelivered.get(s);
      if (d) onDepth({ ...d, receivedTs: this.clock() });
    }
    return un;
  }

  async getCandles(symbol: string, tf: Timeframe, from: number, to: number): Promise<Candle[]> {
    const inst = this.requireInstrument(symbol);
    if (tf === '1s') return [];
    const key = `${symbol}|${tf}`;
    let bars = this.historyCache.get(key);
    if (!bars) {
      let base = this.historyCache.get(`${symbol}|1m`);
      if (!base) {
        base = generateHistory1m({
          spec: inst.spec,
          profile: inst.profile,
          seed: this.opts.seed,
          endTs: this.market.startTs,
          endPrice: inst.startPrice ?? inst.profile.refPrice,
          minutes: this.opts.historyMinutes ?? 30 * 1440,
        });
        this.historyCache.set(`${symbol}|1m`, base);
      }
      bars = tf === '1m' ? base : aggregateBars(base, tf, inst.spec.qtyPrecision);
      this.historyCache.set(key, bars);
    }
    return bars
      .filter((b) => b.bucket >= from && b.bucket < to)
      .map((b, i) => ({
        type: 'candle' as const,
        symbol,
        tf,
        ...b,
        closed: true,
        source: `${this.source}-history`,
        exchangeTs: b.bucket,
        receivedTs: b.bucket,
        seq: i + 1,
      }));
  }

  async snapshot(symbol: string): Promise<{ quote: Quote | null; depth: DepthSnapshot | null }> {
    this.requireInstrument(symbol);
    const now = this.clock();
    const q = this.market.lastQuote(symbol);
    const d = this.market.lastDepth(symbol);
    if (d) this.lastDelivered.set(symbol, d);
    return { quote: q && { ...q, receivedTs: now }, depth: d && { ...d, receivedTs: now } };
  }

  health(): AdapterHealth {
    return { source: this.source, state: this.state, lastMessageTs: this.lastMessageTs, detail: this.detail };
  }

  onStateChange(listener: (h: AdapterHealth) => void): Unsubscribe {
    return this.listeners.add(listener);
  }

  isActive(symbol: string, now: number): boolean {
    if (!this.opts.respectSessions) return true;
    const inst = this.instruments.get(symbol);
    if (!inst) return false;
    const override = inst.spec.tradingSessions;
    if (override) return sessionState(override, override.timezone, now) === 'open';
    const venue = this.venues.get(inst.spec.venue);
    return venue ? sessionState(venue.calendar, venue.timezone, now) === 'open' : true;
  }

  /** Advance to the current clock and deliver (called by the timer; public for tests). */
  tick(): void {
    const target = this.targetStep();
    const max = this.opts.maxCatchUpSteps ?? 100;
    if (target - this.market.steps > max) this.fastForward(target - max);
    while (this.market.steps < target) {
      const s = this.market.step();
      if (this.state === 'connected') this.deliver(s);
    }
  }

  private targetStep(): number {
    return Math.floor((this.clock() - this.market.startTs) / this.stepMs);
  }

  private fastForward(target: number): void {
    while (this.market.steps < target) this.market.step();
  }

  private deliver(s: SimStep): void {
    const now = this.clock();
    for (const o of s.outputs) {
      if (!this.isActive(o.symbol, s.ts)) continue;
      if (o.quote) this.fan(this.quoteSubs, o.symbol, { ...o.quote, receivedTs: now });
      for (const t of o.trades) this.fan(this.tradeSubs, o.symbol, { ...t, receivedTs: now });
      if (o.depth) {
        const next = { ...o.depth, receivedTs: now };
        const prev = this.lastDelivered.get(o.symbol);
        const spec = this.instruments.get(o.symbol)!.spec;
        this.fan(this.depthSubs, o.symbol, prev ? diffDepth(prev, next, formatSize('0', spec)) : next);
        this.lastDelivered.set(o.symbol, next);
      }
      this.lastMessageTs = now;
    }
  }

  private fan<T>(subs: Set<Sub<T>>, symbol: string, msg: T): void {
    for (const s of subs) if (s.symbols.has(symbol)) s.cb(msg);
  }

  private addSub<T>(set: Set<Sub<T>>, symbols: string[], cb: (m: T) => void): Unsubscribe {
    for (const s of symbols) this.requireInstrument(s);
    const sub = { symbols: new Set(symbols), cb };
    set.add(sub);
    return () => set.delete(sub);
  }

  private requireInstrument(symbol: string): SimInstrument {
    const i = this.instruments.get(symbol);
    if (!i) throw new AdapterNotConfiguredError(this.source, `unknown symbol ${symbol}`);
    return i;
  }

  private setState(state: AdapterState, detail: string | null): void {
    this.state = state;
    this.detail = detail;
    this.listeners.emit(this.health());
  }
}

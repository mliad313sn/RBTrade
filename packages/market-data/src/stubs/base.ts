import { Decimal, type Candle, type DepthDelta, type DepthSnapshot, type InstrumentSpec, type Quote, type Timeframe, type Trade } from '@kora/domain';

import {
  AdapterNotConfiguredError,
  Listeners,
  type AdapterHealth,
  type AdapterState,
  type MarketDataAdapter,
  type Unsubscribe,
} from '../adapter.js';

/**
 * Stub adapters (goal 02): real decoders and subscription logic for three venue families, with the
 * network transport stubbed. No keys, no live endpoints. `RecordedTransport` replays hand-crafted
 * fixtures for contract tests; `UnconfiguredLiveTransport` refuses to connect. Each stub is off
 * unless its feature flag is set, and even then the live transport is not implemented (OQ-B1/B2).
 */

export interface StubTransport {
  open(): Promise<void>;
  close(): Promise<void>;
  onFrame(cb: (frame: unknown) => void): void;
  request(path: string): Promise<unknown>;
}

export class RecordedTransport implements StubTransport {
  private cb: ((frame: unknown) => void) | null = null;
  opened = false;

  constructor(
    private readonly frames: unknown[],
    private readonly responses: Record<string, unknown> = {},
  ) {}

  async open(): Promise<void> {
    this.opened = true;
  }

  async close(): Promise<void> {
    this.opened = false;
  }

  onFrame(cb: (frame: unknown) => void): void {
    this.cb = cb;
  }

  /** Delivers every recorded frame synchronously, in order. */
  play(): void {
    if (!this.opened || !this.cb) throw new Error('transport not open');
    for (const f of this.frames) this.cb(f);
  }

  async request(path: string): Promise<unknown> {
    if (!(path in this.responses)) throw new Error(`no recorded response for ${path}`);
    return this.responses[path];
  }
}

export class UnconfiguredLiveTransport implements StubTransport {
  constructor(private readonly source: string) {}

  async open(): Promise<void> {
    throw new AdapterNotConfiguredError(this.source, 'live transport not implemented: needs a sponsor-approved provider contract and credentials (OQ-B1, OQ-B2)');
  }

  async close(): Promise<void> {}

  onFrame(): void {}

  async request(): Promise<unknown> {
    throw new AdapterNotConfiguredError(this.source, 'live transport not implemented');
  }
}

export interface StubCapabilities {
  quotes: boolean;
  trades: boolean;
  depth: boolean;
  candles: boolean;
  /** Streams whose seq is contiguous per symbol (gap detection applies). */
  contiguousSeq: { quotes: boolean; trades: boolean };
}

export interface StubAdapterOptions {
  /** Internal registry rows the stub may serve (precision/tick source). */
  instruments: InstrumentSpec[];
  /** Vendor symbol → internal symbol (from `instrument_aliases`). */
  symbolMap: Record<string, string>;
  transport: StubTransport;
  clock?: () => number;
}

type Msg = Quote | Trade | DepthSnapshot | DepthDelta;

export abstract class StubAdapterBase implements MarketDataAdapter {
  abstract readonly source: string;
  abstract readonly capabilities: StubCapabilities;
  get contiguousSeq(): { quotes: boolean; trades: boolean } {
    return this.capabilities.contiguousSeq;
  }
  protected readonly registry = new Map<string, InstrumentSpec>();
  protected readonly toVendor = new Map<string, string>();
  protected readonly clock: () => number;
  private readonly subs = new Set<{ kind: Msg['type'] | 'depth'; symbols: Set<string>; cb: (m: never) => void }>();
  private readonly listeners = new Listeners<AdapterHealth>();
  private state: AdapterState = 'disconnected';
  private detail: string | null = null;
  private lastMessageTs: number | null = null;
  decodeErrors = 0;

  constructor(protected readonly opts: StubAdapterOptions) {
    for (const i of opts.instruments) this.registry.set(i.symbol, i);
    for (const [vendor, internal] of Object.entries(opts.symbolMap)) this.toVendor.set(internal, vendor);
    this.clock = opts.clock ?? Date.now;
  }

  /** Vendor frame → normalised messages (throws on malformed input). */
  abstract decode(frame: unknown): Msg[];
  protected abstract candlesPath(vendorSymbol: string, tf: Timeframe): string;
  protected abstract decodeCandles(symbol: string, tf: Timeframe, body: unknown): Candle[];
  protected abstract snapshotPath(vendorSymbol: string, levels: number): string;
  protected abstract decodeSnapshot(symbol: string, body: unknown): { quote: Quote | null; depth: DepthSnapshot | null };

  async connect(): Promise<void> {
    this.setState('connecting', null);
    try {
      await this.opts.transport.open();
    } catch (e) {
      this.setState('error', (e as Error).message);
      throw e;
    }
    this.opts.transport.onFrame((f) => this.handle(f));
    this.setState('connected', null);
  }

  async disconnect(): Promise<void> {
    await this.opts.transport.close();
    this.setState('disconnected', 'stopped');
  }

  subscribeQuotes(symbols: string[], onQuote: (q: Quote) => void): Unsubscribe {
    return this.addSub('quote', symbols, onQuote);
  }

  subscribeTrades(symbols: string[], onTrade: (t: Trade) => void): Unsubscribe {
    if (!this.capabilities.trades) throw new AdapterNotConfiguredError(this.source, 'trades not offered');
    return this.addSub('trade', symbols, onTrade);
  }

  subscribeDepth(symbols: string[], _levels: number, onDepth: (d: DepthSnapshot | DepthDelta) => void): Unsubscribe {
    if (!this.capabilities.depth) throw new AdapterNotConfiguredError(this.source, 'depth not offered');
    return this.addSub('depth', symbols, onDepth);
  }

  async getCandles(symbol: string, tf: Timeframe, from: number, to: number): Promise<Candle[]> {
    const body = await this.opts.transport.request(this.candlesPath(this.vendorSymbol(symbol), tf));
    return this.decodeCandles(symbol, tf, body).filter((c) => c.bucket >= from && c.bucket < to);
  }

  async snapshot(symbol: string, levels: number): Promise<{ quote: Quote | null; depth: DepthSnapshot | null }> {
    return this.decodeSnapshot(symbol, await this.opts.transport.request(this.snapshotPath(this.vendorSymbol(symbol), levels)));
  }

  health(): AdapterHealth {
    return { source: this.source, state: this.state, lastMessageTs: this.lastMessageTs, detail: this.detail };
  }

  onStateChange(listener: (h: AdapterHealth) => void): Unsubscribe {
    return this.listeners.add(listener);
  }

  /** Subscription payload the live transport would send (tested against fixtures). */
  abstract encodeSubscription(symbols: string[]): unknown;

  protected spec(vendorOrInternal: string): InstrumentSpec {
    const internal = this.opts.symbolMap[vendorOrInternal] ?? vendorOrInternal;
    const s = this.registry.get(internal);
    if (!s) throw new AdapterNotConfiguredError(this.source, `no registry mapping for ${vendorOrInternal}`);
    return s;
  }

  protected vendorSymbol(symbol: string): string {
    this.spec(symbol);
    return this.toVendor.get(symbol) ?? symbol;
  }

  private handle(frame: unknown): void {
    let msgs: Msg[];
    try {
      msgs = this.decode(frame);
    } catch {
      this.decodeErrors += 1;
      return;
    }
    for (const m of msgs) {
      this.lastMessageTs = m.receivedTs;
      const kind = m.type === 'depth_snapshot' || m.type === 'depth_delta' ? 'depth' : m.type;
      for (const s of this.subs) if (s.kind === kind && s.symbols.has(m.symbol)) (s.cb as (x: Msg) => void)(m);
    }
  }

  private addSub<T>(kind: 'quote' | 'trade' | 'depth', symbols: string[], cb: (m: T) => void): Unsubscribe {
    for (const s of symbols) this.spec(s);
    const sub = { kind, symbols: new Set(symbols), cb: cb as (m: never) => void };
    this.subs.add(sub);
    return () => this.subs.delete(sub);
  }

  private setState(state: AdapterState, detail: string | null): void {
    this.state = state;
    this.detail = detail;
    this.listeners.emit(this.health());
  }
}

export function asRecord(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new TypeError(`${what}: expected object`);
  return v as Record<string, unknown>;
}

/** Vendor numeric or string price → canonical decimal string input (JSON numbers keep their shortest repr). */
export function vendorDecimal(v: unknown, what: string): string {
  if (typeof v === 'string' && v.trim() !== '') return new Decimal(v.trim()).toFixed();
  if (typeof v === 'number' && Number.isFinite(v)) return new Decimal(String(v)).toFixed();
  throw new TypeError(`${what}: expected decimal`);
}

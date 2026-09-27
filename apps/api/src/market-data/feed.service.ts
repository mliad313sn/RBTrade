import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import {
  candleChannel,
  depthChannel,
  quoteChannel,
  tradesChannel,
  type TradesBatch,
  STATUS_CHANNEL,
  TIMEFRAMES,
  type Candle,
  type DepthDelta,
  type DepthSnapshot,
  type FeedHealth,
  type FeedStatus,
  type InstrumentSpec,
  type Quote,
  type Trade,
} from '@kora/domain';
import {
  aggregateBars,
  BarBuilder,
  generateHistory1m,
  CandleTracker,
  createStubAdapter,
  isStubEnabled,
  OrderBook,
  SeqGapDetector,
  SimulatedAdapter,
  SimulatedCalendarProvider,
  simProfileFor,
  STUB_SOURCES,
  type MarketDataAdapter,
  type OhlcvBar,
} from '@kora/market-data';
import { Redis } from 'ioredis';

import { APP_CONFIG, type AppConfig } from '../config/config';
import { DbService } from '../db/db.service';
import { InstrumentsRepository, type Registry } from './instruments.repository';
import { busChannel, lastKey, MD_CONFIG, type MdConfig } from './md-config';

interface FeedStats {
  gaps: number;
  resyncs: number;
  lastResync: FeedHealth['lastResync'];
}

const HISTORY_TFS = TIMEFRAMES.filter((t) => t !== '1s');
const DAY_MS = 86_400_000;
const TAPE_FLUSH_MS = 250;
const TAPE_MAX_BATCH = 50;

/**
 * Market data feed (goal 02): runs the adapters, checks sequence numbers, resyncs on gaps, keeps
 * L2 books, builds 1 s bars and in-progress candles, persists trades/bars, refreshes the candle
 * rollup, flags stale quotes and publishes everything on Redis for the WebSocket gateway.
 */
@Injectable()
export class FeedService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('MarketDataFeed');
  private pub: Redis | null = null;
  private registry: Registry | null = null;
  private readonly adapters = new Map<string, MarketDataAdapter>();
  private readonly stats = new Map<string, FeedStats>();
  private readonly gaps = new SeqGapDetector();
  private readonly books = new Map<string, OrderBook>();
  private readonly symbolSource = new Map<string, string>();
  private readonly lastSeen = new Map<string, number>();
  private readonly lastQuote = new Map<string, Quote>();
  private readonly stale = new Set<string>();
  private readonly resyncing = new Set<string>();
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly bars = new BarBuilder((s) => this.spec(s)?.qtyPrecision ?? 0);
  private readonly candles = new CandleTracker('simulated');
  private tradeBuf: Trade[] = [];
  /** Prints waiting for the next `trades:{symbol}` batch (B-210). */
  private tapeBuf = new Map<string, Trade[]>();
  private barBuf: Array<{ symbol: string; bar: OhlcvBar }> = [];
  private refreshFrom: number | null = null;
  private readonly startPrices = new Map<string, string>();
  private lastRollup = 0;
  private pumping = false;
  private statusDirty = false;
  private started = false;
  backfill: Promise<number> | null = null;

  constructor(
    @Inject(MD_CONFIG) private readonly cfg: MdConfig,
    @Inject(APP_CONFIG) private readonly app: AppConfig,
    private readonly db: DbService,
    private readonly repo: InstrumentsRepository,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.cfg.feed === 'inprocess') await this.startWithRetry();
  }

  /** A feed that cannot reach its registry (e.g. migrations pending) retries instead of crashing the api. */
  private async startWithRetry(attempt = 0): Promise<void> {
    try {
      await this.start();
    } catch (e) {
      this.started = false;
      for (const t of this.timers.splice(0)) clearInterval(t);
      this.pub?.disconnect();
      this.pub = null;
      this.adapters.clear();
      const delay = Math.min(10_000, 500 * 2 ** attempt);
      this.log.warn(`feed start failed (${(e as Error).message}); retrying in ${delay} ms`);
      const t = setTimeout(() => void this.startWithRetry(attempt + 1), delay);
      t.unref();
      this.timers.push(t as unknown as NodeJS.Timeout);
    }
  }

  get isRunning(): boolean {
    return this.started;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.registry = await this.repo.load(0);
    this.pub = new Redis(this.app.redisUrl, {
      enableAutoPipelining: true,
      maxRetriesPerRequest: 2,
    });
    this.pub.on('error', (e) => this.log.warn(`redis publisher: ${e.message}`));

    const specs = [...this.registry.instruments.values()].filter(
      (s) =>
        s.status === 'active' &&
        (this.cfg.symbols.length === 0 || this.cfg.symbols.includes(s.symbol)),
    );
    const closes = await this.repo.lastCloses();
    for (const spec of specs)
      this.startPrices.set(spec.symbol, closes.get(spec.symbol) ?? simProfileFor(spec).refPrice);
    const sim = new SimulatedAdapter({
      seed: this.cfg.seed,
      stepMs: this.cfg.stepMs,
      depthLevels: this.cfg.depthLevels,
      respectSessions: this.cfg.respectSessions,
      venues: [...this.registry.venues.values()],
      calendar: new SimulatedCalendarProvider(this.cfg.seed),
      historyMinutes: this.cfg.historyDays * 1440,
      instruments: specs.map((spec) => {
        const venue = this.registry!.venues.get(spec.venue);
        return {
          spec,
          profile: simProfileFor(spec),
          startPrice: this.startPrices.get(spec.symbol),
          countries: venue && venue.region !== 'global' ? [venue.country] : [],
        };
      }),
    });
    await this.attach(
      sim,
      specs.map((s) => s.symbol),
    );

    // Flagged stubs: reported in status; their live transport refuses to connect (OQ-B1/B2).
    for (const source of STUB_SOURCES) {
      if (!isStubEnabled(source, process.env)) continue;
      const stub = createStubAdapter(source, {
        env: process.env,
        instruments: specs,
        symbolMap: Object.fromEntries(
          this.registry.aliases
            .filter((a) => a.source === source)
            .map((a) => [a.vendorSymbol, a.symbol]),
        ),
      });
      await this.attach(stub, []).catch((e: Error) => this.log.warn(`${source}: ${e.message}`));
    }

    this.every(this.cfg.staleCheckMs, () => this.checkStaleness());
    this.every(this.cfg.heartbeatMs, () => this.publishStatus());
    this.every(1000, () => void this.pump());
    this.every(TAPE_FLUSH_MS, () => this.flushTape());
    this.every(
      3_600_000,
      () =>
        void this.db
          .query('SELECT md_apply_retention()')
          .catch((e: Error) => this.log.warn(`retention: ${e.message}`)),
    );
    this.publishStatus();
    this.log.log(`feed started: ${specs.length} SIMULATED instruments, seed=${this.cfg.seed}`);
    if (this.cfg.backfill) {
      this.backfill = this.runBackfill(sim, specs).catch((e: Error) => {
        this.log.warn(`backfill failed: ${e.message}`);
        return 0;
      });
    }
  }

  async onModuleDestroy(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    for (const a of this.adapters.values()) await a.disconnect().catch(() => undefined);
    await this.backfill?.catch(() => undefined);
    this.pub?.disconnect();
  }

  // ---- control (admin endpoint, tests) --------------------------------------------------

  async stopAdapter(source: string): Promise<void> {
    await this.adapter(source).disconnect();
  }

  async startAdapter(source: string): Promise<void> {
    await this.adapter(source).connect();
  }

  /** The simulated adapter (chaos drills and tests). */
  simulated(): SimulatedAdapter | null {
    const a = this.adapters.get('simulated');
    return a instanceof SimulatedAdapter ? a : null;
  }

  status(): FeedStatus {
    const now = Date.now();
    const feeds: FeedHealth[] = [...this.adapters.values()].map((a) => {
      const h = a.health();
      const st = this.stats.get(a.source)!;
      const busy = [...this.resyncing].some((k) => k.startsWith(`${a.source}|`));
      return {
        source: a.source,
        state: h.state === 'connected' ? (busy ? 'resyncing' : 'up') : 'down',
        lastMessageTs: h.lastMessageTs,
        gaps: st.gaps,
        resyncs: st.resyncs,
        lastResync: st.lastResync,
      };
    });
    for (const source of STUB_SOURCES) {
      if (!this.adapters.has(source))
        feeds.push({
          source,
          state: 'disabled',
          lastMessageTs: null,
          gaps: 0,
          resyncs: 0,
          lastResync: null,
        });
    }
    const live = feeds.filter((f) => f.state !== 'disabled');
    const down = live.filter((f) => f.state === 'down');
    const staleSymbols = [...this.stale].sort();
    // 'down' is reserved for the gateway losing this process's heartbeat; adapter outages while the
    // feed process is alive are 'degraded' (quotes go stale, REST and history keep working).
    let state: FeedStatus['state'] = 'ok';
    let reason: string | null = null;
    if (down.length > 0) {
      state = 'degraded';
      reason = `${down.length === live.length ? 'all feeds down' : 'feed down'}: ${down.map((f) => f.source).join(', ')}`;
    } else if (staleSymbols.length > 0 || live.some((f) => f.state === 'resyncing')) {
      state = 'degraded';
      reason = staleSymbols.length
        ? `${staleSymbols.length} stale symbol(s)`
        : 'resync in progress';
    }
    return { type: 'status', state, ts: now, feeds, staleSymbols, reason };
  }

  // ---- adapter wiring -------------------------------------------------------------------

  private async attach(adapter: MarketDataAdapter, symbols: string[]): Promise<void> {
    this.adapters.set(adapter.source, adapter);
    this.stats.set(adapter.source, { gaps: 0, resyncs: 0, lastResync: null });
    adapter.onStateChange((h) => {
      if (h.state !== 'connected' && h.state !== 'connecting') {
        for (const [sym, src] of this.symbolSource) if (src === adapter.source) this.markStale(sym);
      }
      this.statusDirty = true;
      this.publishStatus();
    });
    if (symbols.length) {
      for (const s of symbols) this.symbolSource.set(s, adapter.source);
      adapter.subscribeQuotes(symbols, (q) => this.onQuote(adapter, q));
      adapter.subscribeTrades(symbols, (t) => this.onTrade(adapter, t));
      adapter.subscribeDepth(symbols, this.cfg.depthLevels, (d) => this.onDepth(adapter, d));
    }
    await adapter.connect();
  }

  private onQuote(adapter: MarketDataAdapter, q: Quote): void {
    if (adapter.contiguousSeq?.quotes ?? true) {
      const r = this.gaps.check(`${adapter.source}|${q.symbol}|q`, q.seq);
      if (r.status === 'duplicate') return;
      if (r.status === 'gap') {
        this.recordGap(adapter.source, q.symbol, 'quotes', r.expected, r.got);
        void this.resync(adapter, q.symbol);
      }
    }
    this.acceptQuote(q);
  }

  private acceptQuote(q: Quote): void {
    this.lastSeen.set(q.symbol, q.receivedTs);
    this.lastQuote.set(q.symbol, q);
    if (this.stale.delete(q.symbol)) this.statusDirty = true;
    this.publish(quoteChannel(q.symbol), q.stale ? q : { ...q, stale: false });
  }

  private onTrade(adapter: MarketDataAdapter, t: Trade): void {
    if (adapter.contiguousSeq?.trades ?? true) {
      const r = this.gaps.check(`${adapter.source}|${t.symbol}|t`, t.seq);
      if (r.status === 'duplicate') return;
      if (r.status === 'gap') this.recordGap(adapter.source, t.symbol, 'trades', r.expected, r.got);
    }
    this.tradeBuf.push(t);
    const tape = this.tapeBuf.get(t.symbol);
    if (tape) tape.push(t);
    else this.tapeBuf.set(t.symbol, [t]);
    for (const bar of this.bars.onTrade(t)) this.onBar(t.symbol, bar, t.seq);
  }

  private onDepth(adapter: MarketDataAdapter, d: DepthSnapshot | DepthDelta): void {
    const key = `${adapter.source}|${d.symbol}`;
    let book = this.books.get(key);
    if (!book) {
      book = new OrderBook(d.symbol);
      this.books.set(key, book);
    }
    if (d.type === 'depth_snapshot') book.applySnapshot(d);
    else {
      const r = book.applyDelta(d);
      if (r === 'stale') return;
      if (r !== 'ok') {
        if (r === 'gap')
          this.recordGap(
            adapter.source,
            d.symbol,
            'depth',
            (book.seq ?? 0) + 1,
            (d.prevSeq ?? d.seq - 1) + 1,
          );
        void this.resync(adapter, d.symbol);
        return;
      }
    }
    const snap = book.snapshot(this.cfg.depthLevels, d.receivedTs);
    if (snap) this.publish(depthChannel(d.symbol), snap);
  }

  private async resync(adapter: MarketDataAdapter, symbol: string): Promise<void> {
    const key = `${adapter.source}|${symbol}`;
    if (this.resyncing.has(key)) return;
    this.resyncing.add(key);
    this.statusDirty = true;
    try {
      const snap = await adapter.snapshot(symbol, this.cfg.depthLevels);
      if (snap.depth) this.onDepth(adapter, snap.depth);
      if (snap.quote) {
        const k = `${adapter.source}|${symbol}|q`;
        if ((this.gaps.lastSeq(k) ?? -1) < snap.quote.seq) this.gaps.reset(k, snap.quote.seq);
        this.acceptQuote(snap.quote);
      }
      this.stats.get(adapter.source)!.resyncs += 1;
      this.log.warn(`resynced ${key} from snapshot`);
    } catch (e) {
      this.log.warn(`resync ${key} failed: ${(e as Error).message}`);
    } finally {
      this.resyncing.delete(key);
      this.statusDirty = true;
    }
  }

  private recordGap(
    source: string,
    symbol: string,
    stream: string,
    expected: number,
    got: number,
  ): void {
    const st = this.stats.get(source)!;
    st.gaps += 1;
    st.lastResync = { symbol, stream, expected, got, ts: Date.now() };
    this.statusDirty = true;
    this.log.warn(`seq gap ${source} ${symbol} ${stream}: expected ${expected}, got ${got}`);
  }

  private onBar(symbol: string, bar: OhlcvBar, seq: number): void {
    const spec = this.spec(symbol);
    if (!spec) return;
    this.barBuf.push({ symbol, bar });
    this.refreshFrom =
      this.refreshFrom === null ? bar.bucket : Math.min(this.refreshFrom, bar.bucket);
    const oneSec: Candle = {
      type: 'candle',
      symbol,
      tf: '1s',
      ...bar,
      closed: true,
      source: 'simulated',
      exchangeTs: bar.bucket,
      receivedTs: Date.now(),
      seq,
    };
    this.publish(candleChannel(symbol, '1s'), oneSec);
    for (const c of this.candles.update(symbol, bar, seq, spec.qtyPrecision))
      this.publish(candleChannel(symbol, c.tf), c);
  }

  // ---- staleness & status ------------------------------------------------------------------

  private markStale(symbol: string): void {
    if (this.stale.has(symbol)) return;
    this.stale.add(symbol);
    this.statusDirty = true;
    const q = this.lastQuote.get(symbol);
    if (q) this.publish(quoteChannel(symbol), { ...q, stale: true });
  }

  private checkStaleness(): void {
    const now = Date.now();
    for (const [symbol, source] of this.symbolSource) {
      const adapter = this.adapters.get(source)!;
      if (adapter.health().state !== 'connected') {
        this.markStale(symbol);
        continue;
      }
      if (adapter.isActive && !adapter.isActive(symbol, now)) continue;
      const seen = this.lastSeen.get(symbol);
      const spec = this.spec(symbol);
      const limit = (spec && this.registry?.staleAfterMs.get(spec.assetClass)) ?? 5000;
      if (seen !== undefined && now - seen > limit) this.markStale(symbol);
    }
    if (this.statusDirty) this.publishStatus();
  }

  private publishStatus(): void {
    this.statusDirty = false;
    this.publish(STATUS_CHANNEL, this.status());
  }

  // ---- persistence -------------------------------------------------------------------------

  /** Flush closed 1 s bars, write trades/bars, refresh the candle rollup. Public for tests. */
  async pump(now = Date.now()): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (const { symbol, bar } of this.bars.flush(now)) this.onBar(symbol, bar, 0);
      const trades = this.tradeBuf;
      const bars = this.barBuf;
      this.tradeBuf = [];
      this.barBuf = [];
      if (trades.length) await this.writeTrades(trades);
      if (bars.length) await this.writeBars(bars);
      if (this.refreshFrom !== null && now - this.lastRollup >= this.cfg.rollupMs) {
        const from = this.refreshFrom;
        this.refreshFrom = null;
        this.lastRollup = now;
        await this.db.query('SELECT md_refresh_candles($1)', [new Date(from).toISOString()]);
      }
    } catch (e) {
      this.log.warn(`persist failed: ${(e as Error).message}`);
    } finally {
      this.pumping = false;
    }
  }

  private async writeTrades(t: Trade[]): Promise<void> {
    await this.db.query(
      `INSERT INTO md_trades (symbol, ts, source, trade_id, seq, price, qty, side, received_at)
       SELECT * FROM unnest($1::text[], $2::timestamptz[], $3::text[], $4::text[], $5::bigint[], $6::numeric[], $7::numeric[], $8::text[], $9::timestamptz[])
       ON CONFLICT DO NOTHING`,
      [
        t.map((x) => x.symbol),
        t.map((x) => new Date(x.exchangeTs).toISOString()),
        t.map((x) => x.source),
        t.map((x) => x.tradeId),
        t.map((x) => x.seq),
        t.map((x) => x.price),
        t.map((x) => x.qty),
        t.map((x) => x.side),
        t.map((x) => new Date(x.receivedTs).toISOString()),
      ],
    );
  }

  private async writeBars(b: Array<{ symbol: string; bar: OhlcvBar }>): Promise<void> {
    await this.db.query(
      `INSERT INTO md_bars_1s (symbol, ts, open, high, low, close, volume, trades)
       SELECT * FROM unnest($1::text[], $2::timestamptz[], $3::numeric[], $4::numeric[], $5::numeric[], $6::numeric[], $7::numeric[], $8::int[])
       ON CONFLICT DO NOTHING`,
      [
        b.map((x) => x.symbol),
        b.map((x) => new Date(x.bar.bucket).toISOString()),
        b.map((x) => x.bar.open),
        b.map((x) => x.bar.high),
        b.map((x) => x.bar.low),
        b.map((x) => x.bar.close),
        b.map((x) => x.bar.volume),
        b.map((x) => x.bar.trades),
      ],
    );
  }

  /**
   * SIMULATED history before the first live bar for symbols without history. Anchored to the
   * earliest stored 1 s bar when live data already exists (e.g. an interrupted backfill), else to
   * the simulator start, so history always ends exactly where live data begins.
   */
  private async runBackfill(sim: SimulatedAdapter, specs: InstrumentSpec[]): Promise<number> {
    const t0 = Date.now();
    const have = new Set(
      (
        await this.db.query<{ symbol: string }>('SELECT DISTINCT symbol FROM md_candles_history')
      ).map((r) => r.symbol),
    );
    const firstLive = new Map(
      (
        await this.db.query<{ symbol: string; ts: Date; open: string }>(
          'SELECT DISTINCT ON (symbol) symbol, ts, open FROM md_bars_1s ORDER BY symbol, ts',
        )
      ).map((r) => [r.symbol, { ts: r.ts.getTime(), open: r.open }]),
    );
    let rows = 0;
    for (const spec of specs) {
      if (have.has(spec.symbol) || !this.started) continue;
      const live = firstLive.get(spec.symbol);
      const end = live?.ts ?? sim.market.startTs;
      const base = generateHistory1m({
        spec,
        profile: simProfileFor(spec),
        seed: this.cfg.seed,
        endTs: end,
        endPrice: live?.open ?? this.startPrices.get(spec.symbol)!,
        minutes: this.cfg.historyDays * 1440,
      });
      for (const tf of HISTORY_TFS) {
        const days = tf === '1m' ? Math.min(2, this.cfg.historyDays) : this.cfg.historyDays;
        const from = Math.floor(end / 60_000) * 60_000 - days * DAY_MS;
        const bars = (tf === '1m' ? base : aggregateBars(base, tf, spec.qtyPrecision)).filter(
          (b) => b.bucket >= from,
        );
        for (let i = 0; i < bars.length; i += 5000) {
          const c = bars.slice(i, i + 5000);
          await this.db.query(
            `INSERT INTO md_candles_history (symbol, tf, bucket, open, high, low, close, volume, trades, source)
             SELECT $1, $2, *, 'simulated-history' FROM unnest($3::timestamptz[], $4::numeric[], $5::numeric[], $6::numeric[], $7::numeric[], $8::numeric[], $9::int[])
             ON CONFLICT DO NOTHING`,
            [
              spec.symbol,
              tf,
              c.map((x) => new Date(x.bucket).toISOString()),
              c.map((x) => x.open),
              c.map((x) => x.high),
              c.map((x) => x.low),
              c.map((x) => x.close),
              c.map((x) => x.volume),
              c.map((x) => x.trades),
            ],
          );
          rows += c.length;
        }
      }
      await new Promise((r) => setImmediate(r));
    }
    if (rows) this.log.log(`backfilled ${rows} SIMULATED history candles in ${Date.now() - t0} ms`);
    return rows;
  }

  // ---- helpers --------------------------------------------------------------------------------

  /** Publishes buffered prints per symbol as one `trades:{symbol}` batch (time and sales, B-210). */
  flushTape(): void {
    if (this.tapeBuf.size === 0) return;
    const buf = this.tapeBuf;
    this.tapeBuf = new Map();
    for (const [symbol, prints] of buf) {
      const batch: TradesBatch = {
        type: 'trades',
        symbol,
        trades: prints.slice(-TAPE_MAX_BATCH).map((p) => ({
          tradeId: p.tradeId,
          price: p.price,
          qty: p.qty,
          side: p.side,
          exchangeTs: p.exchangeTs,
          seq: p.seq,
        })),
      };
      this.publish(tradesChannel(symbol), batch);
    }
  }

  private publish(channel: string, msg: unknown): void {
    if (!this.pub) return;
    const json = JSON.stringify(msg);
    this.pub.publish(busChannel(this.cfg, channel), json).catch(() => undefined);
    this.pub.set(lastKey(this.cfg, channel), json, 'EX', 86_400).catch(() => undefined);
  }

  private spec(symbol: string): InstrumentSpec | undefined {
    return this.registry?.instruments.get(symbol);
  }

  private adapter(source: string): MarketDataAdapter {
    const a = this.adapters.get(source);
    if (!a) throw new NotFoundException({ error: 'unknown_feed', message: `No feed ${source}` });
    return a;
  }

  private every(ms: number, fn: () => void): void {
    const t = setInterval(fn, ms);
    t.unref();
    this.timers.push(t);
  }
}

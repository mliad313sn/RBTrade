import { readFileSync } from 'node:fs';

import {
  CandleSchema,
  DepthDeltaSchema,
  DepthSnapshotSchema,
  QuoteSchema,
  TradeSchema,
  type DepthDelta,
  type Quote,
  type Trade,
} from '@kora/domain';
import { describe, expect, it } from 'vitest';

import { AdapterNotConfiguredError, type MarketDataAdapter } from '../adapter.js';
import { SeqGapDetector } from '../gap-detector.js';
import { OrderBook } from '../order-book.js';
import { isOnTick } from '../precision.js';
import { aliasMap } from '../seed/aliases.js';
import { SEED_INSTRUMENTS } from '../seed/instruments.js';
import { RecordedTransport, type StubAdapterBase } from './base.js';
import { createStubAdapter, STUB_FLAGS, type StubSource } from './factory.js';

interface Fixture {
  _label: string;
  frames: unknown[];
  responses: Record<string, unknown>;
}
const load = (name: string): Fixture =>
  JSON.parse(
    readFileSync(new URL(`../../fixtures/${name}.json`, import.meta.url), 'utf8'),
  ) as Fixture;
const spec = (s: string) => SEED_INSTRUMENTS.find((i) => i.symbol === s)!;
const ENABLED = Object.fromEntries(Object.values(STUB_FLAGS).map((f) => [f, 'true']));

function make(source: StubSource, fixture: Fixture) {
  const transport = new RecordedTransport(fixture.frames, fixture.responses);
  const adapter = createStubAdapter(source, {
    env: ENABLED,
    instruments: SEED_INSTRUMENTS,
    symbolMap: aliasMap(source),
    transport,
    clock: () => 1_790_330_401_000,
  });
  return { adapter, transport };
}

/** Shared contract every adapter must meet on its recorded fixtures. */
function contract(source: StubSource, symbol: string) {
  describe(`${source} contract`, () => {
    const fixture = load(source);

    it('fixture is labelled hand-crafted and holds no secrets', () => {
      expect(fixture._label).toMatch(/^HAND-CRAFTED FIXTURE/);
      expect(JSON.stringify(fixture)).not.toMatch(/(api[_-]?key|secret|token|password|bearer)/i);
    });

    it('connects, emits schema-valid registry-precision messages, disconnects', async () => {
      const { adapter, transport } = make(source, fixture);
      const quotes: Quote[] = [];
      const other: unknown[] = [];
      adapter.subscribeQuotes([symbol], (q) => quotes.push(q));
      if (adapter.capabilities.trades) adapter.subscribeTrades([symbol], (t) => other.push(t));
      if (adapter.capabilities.depth) adapter.subscribeDepth([symbol], 10, (d) => other.push(d));
      await adapter.connect();
      expect(adapter.health().state).toBe('connected');
      transport.play();
      expect(quotes.length).toBeGreaterThan(0);
      const s = spec(symbol);
      for (const q of quotes) {
        expect(QuoteSchema.parse(q)).toEqual(q);
        expect(q.source).toBe(source);
        expect(isOnTick(q.bid, s) && isOnTick(q.ask, s)).toBe(true);
        expect(q.receivedTs).toBe(1_790_330_401_000);
      }
      for (const m of other) {
        const t = (m as { type: string }).type;
        const schema = t === 'trade' ? TradeSchema : DepthDeltaSchema;
        expect(schema.safeParse(m).success).toBe(true);
      }
      expect(adapter.decodeErrors).toBe(1); // each fixture contains exactly one malformed frame
      await adapter.disconnect();
      expect(adapter.health().state).toBe('disconnected');
    });

    it('serves schema-valid candles filtered to [from, to)', async () => {
      const { adapter } = make(source, fixture);
      const all = await adapter.getCandles(symbol, '15m', 0, Number.MAX_SAFE_INTEGER);
      expect(all.length).toBeGreaterThan(0);
      for (const c of all) expect(CandleSchema.safeParse(c).success).toBe(true);
      const none = await adapter.getCandles(symbol, '15m', 0, 1);
      expect(none).toEqual([]);
      await expect(adapter.getCandles(symbol, '1s', 0, 1)).rejects.toThrow(/not offered/);
    });

    it('returns a snapshot for resync', async () => {
      const { adapter } = make(source, fixture);
      const snap = await adapter.snapshot(symbol, 10);
      expect(QuoteSchema.safeParse(snap.quote).success).toBe(true);
      if (snap.depth) expect(DepthSnapshotSchema.safeParse(snap.depth).success).toBe(true);
    });

    it('refuses unknown symbols and the live transport', async () => {
      const { adapter } = make(source, fixture);
      expect(() => adapter.subscribeQuotes(['NOPE'], () => undefined)).toThrow(
        AdapterNotConfiguredError,
      );
      const live = createStubAdapter(source, {
        env: ENABLED,
        instruments: SEED_INSTRUMENTS,
        symbolMap: aliasMap(source),
      });
      await expect(live.connect()).rejects.toThrow(/live transport not implemented/);
      expect(live.health().state).toBe('error');
      await expect(live.getCandles(symbol, '15m', 0, 1)).rejects.toBeInstanceOf(
        AdapterNotConfiguredError,
      );
    });
  });
}

contract('broker-fxcfd', 'EURUSD');
contract('crypto-testnet', 'BTCUSD');
contract('equities-provider', 'AAPL');

describe('feature flags', () => {
  it('every stub is off unless its flag is exactly "true"', () => {
    for (const source of ['broker-fxcfd', 'crypto-testnet', 'equities-provider'] as const) {
      for (const env of [{}, { [STUB_FLAGS[source]]: '1' }, { [STUB_FLAGS[source]]: 'TRUE' }]) {
        expect(() =>
          createStubAdapter(source, { env, instruments: SEED_INSTRUMENTS, symbolMap: {} }),
        ).toThrow(/disabled by feature flag/);
      }
    }
  });
});

describe('venue-specific decoding', () => {
  it('broker-fxcfd: rounds to the registry tick, maps tradeable=false to stale, counts local seq', async () => {
    const { adapter, transport } = make('broker-fxcfd', load('broker-fxcfd'));
    const q: Quote[] = [];
    adapter.subscribeQuotes(['EURUSD', 'USDJPY', 'XAUUSD'], (x) => q.push(x));
    await adapter.connect();
    transport.play();
    expect(q.map((x) => [x.symbol, x.bid, x.ask, x.stale, x.seq])).toEqual([
      ['EURUSD', '1.08419', '1.08421', false, 1],
      ['USDJPY', '148.214', '148.216', false, 1],
      ['EURUSD', '1.08418', '1.08422', true, 2],
      ['XAUUSD', '2395.30', '2395.50', false, 1],
    ]);
    expect(q[0]!.exchangeTs).toBe(Date.parse('2026-09-25T10:00:00.125Z'));
    expect((adapter as StubAdapterBase).contiguousSeq).toEqual({ quotes: false, trades: false });
    expect(adapter.encodeSubscription(['EURUSD', 'XAUUSD'])).toEqual({
      instruments: 'EUR_USD,XAU_USD',
    });
    expect(() => adapter.subscribeTrades(['EURUSD'], () => undefined)).toThrow(
      /trades not offered/,
    );
    expect(() => adapter.subscribeDepth(['EURUSD'], 5, () => undefined)).toThrow(
      /depth not offered/,
    );
    const candles = await adapter.getCandles('EURUSD', '15m', 0, Number.MAX_SAFE_INTEGER);
    expect(candles.map((c) => [c.open, c.close, c.closed])).toEqual([
      ['1.08390', '1.08410', true],
      ['1.08410', '1.08419', true],
      ['1.08419', '1.08420', false],
    ]);
  });

  it('crypto-testnet: ranged depth ids build a book, the trade id gap and the depth gap are detected', async () => {
    const { adapter, transport } = make('crypto-testnet', load('crypto-testnet'));
    const book = new OrderBook('BTCUSD');
    const results: string[] = [];
    const trades = new SeqGapDetector();
    const tradeResults: string[] = [];
    adapter.subscribeDepth(['BTCUSD'], 10, (d) => results.push(book.applyDelta(d as DepthDelta)));
    adapter.subscribeTrades(['BTCUSD'], (t: Trade) =>
      tradeResults.push(trades.check('BTCUSD', t.seq).status),
    );
    const snap = await adapter.snapshot('BTCUSD', 10);
    book.applySnapshot(snap.depth!);
    await adapter.connect();
    transport.play();
    expect(results).toEqual(['ok', 'ok', 'gap']);
    expect(tradeResults).toEqual(['first', 'ok', 'gap']);
    expect(book.top(2).bids).toEqual([
      ['64812.4', '1.3000'],
      ['64811.5', '2.0000'],
    ]);
    expect(snap.quote).toMatchObject({ bid: '64812.4', ask: '64812.5', seq: 1002 });
    expect(adapter.encodeSubscription(['BTCUSD'])).toEqual({
      method: 'SUBSCRIBE',
      params: ['btcusdt@depth', 'btcusdt@trade', 'btcusdt@bookTicker'],
      id: 1,
    });
    const k = await adapter.getCandles('BTCUSD', '15m', 0, Number.MAX_SAFE_INTEGER);
    expect(k.map((c) => [c.bucket, c.close, c.trades])).toEqual([
      [1790328600000, '64801.2', 542],
      [1790329500000, '64812.5', 431],
    ]);
  });

  it('equities-provider: JSON-number prices go through registry rounding; quote seq gap detected', async () => {
    const { adapter, transport } = make('equities-provider', load('equities-provider'));
    const q: Quote[] = [];
    const gaps = new SeqGapDetector();
    const status: string[] = [];
    adapter.subscribeQuotes(['AAPL', 'NVDA'], (x) => {
      q.push(x);
      status.push(gaps.check(x.symbol, x.seq).status);
    });
    const t: Trade[] = [];
    adapter.subscribeTrades(['AAPL'], (x) => t.push(x));
    await adapter.connect();
    transport.play();
    expect(q.map((x) => [x.symbol, x.bid, x.ask])).toEqual([
      ['AAPL', '221.36', '221.38'],
      ['NVDA', '118.92', '118.94'],
      ['AAPL', '221.37', '221.39'],
      ['AAPL', '221.35', '221.40'],
    ]);
    expect(status).toEqual(['first', 'first', 'ok', 'gap']);
    expect(t).toMatchObject([{ price: '221.37', qty: '100', tradeId: 't-1', side: 'buy' }]);
    expect(adapter.encodeSubscription(['AAPL'])).toEqual({
      action: 'subscribe',
      params: 'Q.AAPL,T.AAPL',
    });
    expect(() => adapter.subscribeDepth(['AAPL'], 5, () => undefined)).toThrow(/depth not offered/);
  });

  it('adapters satisfy the MarketDataAdapter interface', () => {
    const a: MarketDataAdapter = make('equities-provider', load('equities-provider')).adapter;
    expect(typeof a.onStateChange(() => undefined)).toBe('function');
    expect(() => new RecordedTransport([]).play()).toThrow(/not open/);
  });
});

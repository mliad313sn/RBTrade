import {
  CandleSchema,
  type DepthDelta,
  type DepthSnapshot,
  type Quote,
  type Trade,
} from '@kora/domain';
import { describe, expect, it } from 'vitest';

import { AdapterNotConfiguredError } from '../adapter.js';
import { SeqGapDetector } from '../gap-detector.js';
import { OrderBook } from '../order-book.js';
import { SEED_INSTRUMENTS } from '../seed/instruments.js';
import { simProfileFor } from '../seed/sim-profiles.js';
import { SEED_VENUES } from '../seed/venues.js';
import { SimulatedCalendarProvider } from './calendar.js';
import { SimulatedAdapter, type Timers } from './simulated-adapter.js';

class ManualTimers implements Timers {
  fns = new Map<number, () => void>();
  private id = 0;
  setInterval(fn: () => void) {
    this.id += 1;
    this.fns.set(this.id, fn);
    return this.id;
  }
  clearInterval(h: unknown) {
    this.fns.delete(h as number);
  }
  fire() {
    for (const f of this.fns.values()) f();
  }
}

const inst = (s: string) => {
  const spec = SEED_INSTRUMENTS.find((i) => i.symbol === s)!;
  return { spec, profile: simProfileFor(spec) };
};

function setup(opts: { respectSessions?: boolean; start?: number } = {}) {
  let now = opts.start ?? Date.parse('2026-09-24T14:00:00Z'); // Thursday, all sample venues trading or not per tz
  const timers = new ManualTimers();
  const adapter = new SimulatedAdapter({
    seed: 11,
    instruments: [inst('EURUSD'), inst('BTCUSD'), inst('AAPL')],
    venues: SEED_VENUES,
    clock: () => now,
    timers,
    respectSessions: opts.respectSessions,
    calendar: new SimulatedCalendarProvider(11),
    historyMinutes: 3 * 1440,
  });
  return { adapter, timers, advance: (ms: number) => ((now += ms), timers.fire()), now: () => now };
}

describe('SimulatedAdapter', () => {
  it('streams quotes, trades and depth deltas at 10 steps/s while connected', async () => {
    const { adapter, advance } = setup();
    const quotes: Quote[] = [];
    const trades: Trade[] = [];
    const depth: Array<DepthSnapshot | DepthDelta> = [];
    adapter.subscribeQuotes(['EURUSD'], (q) => quotes.push(q));
    adapter.subscribeTrades(['BTCUSD'], (t) => trades.push(t));
    adapter.subscribeDepth(['EURUSD'], 10, (d) => depth.push(d));
    await adapter.connect();
    expect(adapter.health().state).toBe('connected');
    advance(1000);
    expect(quotes).toHaveLength(10);
    expect(trades.length).toBeGreaterThan(0);
    expect(depth[0]!.type).toBe('depth_snapshot');
    expect(depth.slice(1).every((d) => d.type === 'depth_delta')).toBe(true);
    const book = new OrderBook('EURUSD');
    book.applySnapshot(depth[0] as DepthSnapshot);
    for (const d of depth.slice(1)) expect(book.applyDelta(d as DepthDelta)).toBe('ok');
    expect(book.top(1).bids[0]![0]).toBe(quotes.at(-1)!.bid);
    expect(adapter.health().lastMessageTs).not.toBeNull();
  });

  it('an outage skips the missed steps, so the consumer sees a gap and resyncs from snapshot()', async () => {
    const { adapter, advance } = setup();
    const gaps = new SeqGapDetector();
    const results: string[] = [];
    const states: string[] = [];
    adapter.onStateChange((h) => states.push(h.state));
    adapter.subscribeQuotes(['EURUSD'], (q) => results.push(gaps.check('EURUSD', q.seq).status));
    await adapter.connect();
    advance(500);
    await adapter.disconnect();
    advance(3000); // no timer, nothing delivered
    expect(results).toEqual(['first', 'ok', 'ok', 'ok', 'ok']);
    await adapter.connect();
    advance(200);
    expect(results.slice(5)).toEqual(['gap', 'ok']);
    const snap = await adapter.snapshot('EURUSD');
    expect(snap.quote!.seq).toBe(gaps.lastSeq('EURUSD'));
    expect(states).toEqual(['connecting', 'connected', 'disconnected', 'connecting', 'connected']);
  });

  it('serves deterministic SIMULATED history that joins the live start price', async () => {
    const { adapter, now } = setup();
    const to = now();
    const c15 = await adapter.getCandles('EURUSD', '15m', to - 86_400_000, to);
    expect(c15.length).toBeGreaterThanOrEqual(95);
    expect(c15.every((c) => CandleSchema.safeParse(c).success)).toBe(true);
    expect(c15.every((c, i) => i === 0 || c.bucket > c15[i - 1]!.bucket)).toBe(true);
    const m1 = await adapter.getCandles('EURUSD', '1m', to - 120_000, to);
    expect(m1.at(-1)!.close).toBe('1.08420');
    expect(m1[0]!.source).toBe('simulated-history');
    expect(await adapter.getCandles('EURUSD', '1s', 0, to)).toEqual([]);
    expect(await adapter.getCandles('EURUSD', '15m', to - 86_400_000, to)).toEqual(c15);
    await expect(adapter.getCandles('NOPE', '1m', 0, 1)).rejects.toBeInstanceOf(
      AdapterNotConfiguredError,
    );
    expect(() => adapter.subscribeQuotes(['NOPE'], () => undefined)).toThrow(
      AdapterNotConfiguredError,
    );
  });

  it('respectSessions pauses closed venues (AAPL on a Saturday) but not crypto', async () => {
    const { adapter, advance } = setup({
      respectSessions: true,
      start: Date.parse('2026-09-26T15:00:00Z'),
    });
    const seen = new Set<string>();
    adapter.subscribeQuotes(['EURUSD', 'BTCUSD', 'AAPL'], (q) => seen.add(q.symbol));
    await adapter.connect();
    advance(500);
    expect([...seen]).toEqual(['BTCUSD']);
    expect(adapter.isActive('AAPL', Date.parse('2026-09-28T15:00:00Z'))).toBe(true);
    expect(adapter.isActive('NOPE', 0)).toBe(false);
  });

  it('freeze() stalls delivery silently while staying connected', async () => {
    const { adapter, advance } = setup();
    const seqs: number[] = [];
    adapter.subscribeQuotes(['EURUSD'], (q) => seqs.push(q.seq));
    await adapter.connect();
    advance(200);
    adapter.freeze();
    advance(500);
    expect(adapter.health().state).toBe('connected');
    expect(seqs).toEqual([1, 2]);
    adapter.unfreeze();
    advance(100);
    expect(seqs).toEqual([1, 2, 8]);
  });

  it('long stalls fast-forward instead of flooding subscribers', async () => {
    const { adapter, advance } = setup();
    let n = 0;
    adapter.subscribeQuotes(['EURUSD'], () => (n += 1));
    await adapter.connect();
    advance(60_000);
    expect(n).toBe(100);
    await adapter.connect(); // idempotent
  });
});

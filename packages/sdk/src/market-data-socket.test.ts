import { describe, expect, it } from 'vitest';

import { KoraClient } from './client.js';
import { MarketDataSocket, type SocketTimers, type WebSocketLike } from './market-data-socket.js';

class FakeWs implements WebSocketLike {
  static all: FakeWs[] = [];
  readyState = 0;
  sent: unknown[] = [];
  closed: Array<[number | undefined, string | undefined]> = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(readonly url: string) {
    FakeWs.all.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code?: number, reason?: string) {
    this.closed.push([code, reason]);
    this.readyState = 3;
  }
  // server side helpers
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  push(msg: unknown) {
    this.onmessage?.({ data: typeof msg === 'string' ? msg : JSON.stringify(msg) });
  }
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code, reason: '' });
  }
}

class Clock implements SocketTimers {
  t = 0;
  private q: Array<{ at: number; fn: () => void; id: number; every?: number }> = [];
  private id = 0;
  setTimeout(fn: () => void, ms: number) {
    this.q.push({ at: this.t + ms, fn, id: ++this.id });
    return this.id;
  }
  setInterval(fn: () => void, ms: number) {
    this.q.push({ at: this.t + ms, fn, id: ++this.id, every: ms });
    return this.id;
  }
  clearTimeout(h: unknown) {
    this.q = this.q.filter((x) => x.id !== h);
  }
  clearInterval(h: unknown) {
    this.clearTimeout(h);
  }
  advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      this.q.sort((a, b) => a.at - b.at);
      const n = this.q[0];
      if (!n || n.at > end) break;
      this.t = n.at;
      if (n.every) n.at += n.every;
      else this.q.shift();
      n.fn();
    }
    this.t = end;
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function make(opts: Partial<ConstructorParameters<typeof MarketDataSocket>[0]> = {}) {
  FakeWs.all = [];
  const clock = new Clock();
  const s = new MarketDataSocket({
    url: 'ws://api/ws',
    WebSocket: FakeWs,
    timers: clock,
    now: () => clock.t,
    random: () => 0.5,
    backoff: { initialMs: 100, maxMs: 1000, factor: 2, jitter: 0.2 },
    heartbeatMs: 1000,
    ...opts,
  });
  return { s, clock, ws: () => FakeWs.all.at(-1)! };
}

describe('MarketDataSocket', () => {
  it('authenticates, subscribes, dispatches typed channel data with snapshot meta', async () => {
    const { s, ws } = make({ token: 't0ken-abcdef' });
    const states: string[] = [];
    s.onState((x) => states.push(x));
    const got: Array<[string, boolean]> = [];
    s.quotes('EURUSD', (q, m) => got.push([q.bid, m.snapshot]));
    s.connect();
    ws().open();
    await flush();
    expect(ws().sent).toEqual([{ op: 'auth', token: 't0ken-abcdef' }, { op: 'subscribe', channels: ['quotes:EURUSD'] }]);
    ws().push({ ch: 'quotes:EURUSD', snapshot: true, data: { bid: '1.08419' } });
    ws().push({ ch: 'quotes:EURUSD', data: { bid: '1.08420' } });
    ws().push({ ch: 'quotes:GBPUSD', data: { bid: 'x' } });
    ws().push('not json');
    expect(got).toEqual([['1.08419', true], ['1.08420', false]]);
    expect(states).toEqual(['connecting', 'open']);
    expect(s.state).toBe('open');
  });

  it('reference-counts channels client-side', async () => {
    const { s, ws } = make();
    s.connect();
    ws().open();
    await flush();
    const a = s.depth('BTCUSD', () => undefined);
    const b = s.depth('BTCUSD', () => undefined);
    const c = s.candles('BTCUSD', '15m', () => undefined);
    s.status(() => undefined);
    a();
    expect(s.channels()).toEqual(['depth:BTCUSD', 'candles:BTCUSD:15m', 'status']);
    b();
    b();
    c();
    expect(ws().sent).toEqual([
      { op: 'subscribe', channels: ['depth:BTCUSD'] },
      { op: 'subscribe', channels: ['candles:BTCUSD:15m'] },
      { op: 'subscribe', channels: ['status'] },
      { op: 'unsubscribe', channels: ['depth:BTCUSD'] },
      { op: 'unsubscribe', channels: ['candles:BTCUSD:15m'] },
    ]);
  });

  it('reconnects with capped exponential backoff and resubscribes everything', async () => {
    const { s, clock, ws } = make({ token: async () => 'fresh-token-123' });
    s.quotes('EURUSD', () => undefined);
    s.status(() => undefined);
    s.connect();
    ws().open();
    await flush();
    expect(s.backoffDelay(0)).toBe(90);
    expect(s.backoffDelay(1)).toBe(180);
    expect(s.backoffDelay(10)).toBe(900);
    ws().drop();
    expect(s.state).toBe('reconnecting');
    clock.advance(89);
    expect(FakeWs.all).toHaveLength(1);
    clock.advance(1);
    expect(FakeWs.all).toHaveLength(2);
    ws().drop(); // fails again before opening: next delay doubles
    clock.advance(179);
    expect(FakeWs.all).toHaveLength(2);
    clock.advance(1);
    expect(FakeWs.all).toHaveLength(3);
    ws().open();
    await flush();
    expect(ws().sent).toEqual([{ op: 'auth', token: 'fresh-token-123' }, { op: 'subscribe', channels: ['quotes:EURUSD', 'status'] }]);
    expect(s.state).toBe('open');
    expect(s.reconnects).toBe(2);
    ws().drop();
    clock.advance(90); // attempt counter reset after a successful open
    expect(FakeWs.all).toHaveLength(4);
  });

  it('pings and recycles a silent connection', async () => {
    const { s, clock, ws } = make();
    s.connect();
    ws().open();
    await flush();
    clock.advance(1000);
    expect(ws().sent).toEqual([{ op: 'ping' }]);
    ws().push({ type: 'pong' });
    clock.advance(2000);
    expect(FakeWs.all).toHaveLength(1);
    clock.advance(1000); // 3 s silence > 2.5 × heartbeat
    expect(ws().closed[0]).toEqual([4000, 'heartbeat timeout']);
    clock.advance(90);
    expect(FakeWs.all).toHaveLength(2);
  });

  it('stops on auth rejection without a token provider, surfaces server errors, close() is final', async () => {
    const { s, clock, ws } = make({ token: 'static-token-1' });
    const errors: string[] = [];
    s.onError((e) => errors.push(e.code));
    s.connect();
    ws().open();
    await flush();
    ws().push({ type: 'error', code: 'unknown_symbol', message: 'x' });
    ws().drop(4401);
    expect(s.state).toBe('closed');
    expect(errors).toEqual(['unknown_symbol', 'close_4401']);
    clock.advance(10_000);
    expect(FakeWs.all).toHaveLength(1);

    const m = make();
    m.s.connect();
    m.ws().open();
    await flush();
    m.s.close();
    expect(m.ws().closed[0]).toEqual([1000, 'client closed']);
    m.clock.advance(10_000);
    expect(FakeWs.all).toHaveLength(1);
    expect(m.s.state).toBe('closed');
    expect(() => new MarketDataSocket({ url: 'x', WebSocket: undefined as never })).not.toThrow(); // Node 22 has a global WebSocket
  });

  it('REST client covers the market data endpoints', async () => {
    const calls: string[] = [];
    const f = (async (url: string) => {
      calls.push(url);
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const c = new KoraClient({ baseUrl: '/api', fetch: f });
    await c.instruments({ assetClass: 'fx' });
    await c.instrument('7203.XTKS');
    await c.candles({ symbol: 'EURUSD', tf: '15m', limit: 500 });
    await c.quotes(['EURUSD', 'GBPUSD']);
    await c.depth('BTCUSD');
    await c.marketStatus();
    await c.calendar();
    expect(calls).toEqual([
      '/api/instruments?assetClass=fx',
      '/api/instruments/7203.XTKS',
      '/api/candles?symbol=EURUSD&tf=15m&limit=500',
      '/api/quotes?symbols=EURUSD%2CGBPUSD',
      '/api/depth/BTCUSD',
      '/api/market-data/status',
      '/api/calendar',
    ]);
  });

  it('typed helpers for time and sales and the private trading channels (goal 04)', async () => {
    const { s, ws } = make();
    s.connect();
    ws().open();
    await flush();
    const id = '0b3c9a4e-1f2d-4c5b-9a8e-7d6c5b4a3f21';
    const got: string[] = [];
    s.trades('BTCUSD', (b) => got.push(`t${b.trades.length}`));
    s.orders(id, (m) => got.push(`o${m.orders.length}`));
    s.positions(id, (m) => got.push(`p${m.positions.length}`));
    s.account(id, () => got.push('a'));
    expect(s.channels()).toEqual(['trades:BTCUSD', `orders:${id}`, `positions:${id}`, `account:${id}`]);
    ws().push({ ch: 'trades:BTCUSD', data: { type: 'trades', symbol: 'BTCUSD', trades: [{}, {}] } });
    ws().push({ ch: `orders:${id}`, data: { type: 'orders', accountId: id, orders: [{}] } });
    ws().push({ ch: `positions:${id}`, data: { type: 'positions', positions: [] } });
    ws().push({ ch: `account:${id}`, data: { type: 'account', account: {} } });
    expect(got).toEqual(['t2', 'o1', 'p0', 'a']);
  });

  it('REST client covers the terminal endpoints (goal 04)', async () => {
    const calls: string[] = [];
    const f = (async (url: string, init: RequestInit) => {
      calls.push(`${init.method} ${url}`);
      return new Response(init.method === 'DELETE' && url.includes('layouts') ? '' : '{}', { status: 200 });
    }) as unknown as typeof fetch;
    const c = new KoraClient({ baseUrl: '/api', fetch: f });
    await c.layouts();
    await c.saveLayout('My desk', { a: 1 });
    await c.deleteLayout('My desk');
    await c.watchlists();
    await c.createWatchlist('Asia', ['USDJPY']);
    await c.updateWatchlist('w1', { symbols: [] });
    await c.deleteWatchlist('w1');
    await c.priceAlerts({ status: 'active' });
    await c.createPriceAlert({ symbol: 'EURUSD', condition: 'price_above', threshold: '1.1' });
    await c.cancelPriceAlert('a1');
    await c.riskSummary();
    await c.cancelAllOrders('EURUSD');
    await c.cancelAllOrders();
    expect(calls).toEqual([
      'GET /api/me/layouts',
      'PUT /api/me/layouts/My%20desk',
      'DELETE /api/me/layouts/My%20desk',
      'GET /api/me/watchlists',
      'POST /api/me/watchlists',
      'PUT /api/me/watchlists/w1',
      'DELETE /api/me/watchlists/w1',
      'GET /api/price-alerts?status=active',
      'POST /api/price-alerts',
      'DELETE /api/price-alerts/a1',
      'GET /api/risk/summary',
      'DELETE /api/orders?symbol=EURUSD',
      'DELETE /api/orders',
    ]);
  });
});

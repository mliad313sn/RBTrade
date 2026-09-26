import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AlertsService } from '../src/terminal/alerts.service';
import { bearer, createUser, ownerQuery, startApp, type TestUser } from './helpers';
import { MARKET_OPEN_UTC, MarketFixture } from './market-fixture';
import { listen, TestWs } from './ws-helpers';

let n = 0;
const cid = () => `t4-${process.pid}-${++n}`;

describe('Pro terminal API (goal 04): layouts, watchlists, alerts, cancel-all, risk summary', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let u: TestUser;
  const md = new MarketFixture();
  const saved = { ...process.env };

  beforeAll(async () => {
    process.env.KORA_ENGINE_ENABLED = 'false';
    process.env.KORA_RECONCILIATION_INTERVAL_MS = '0';
    process.env.KORA_ALERTS_ENABLED = 'false'; // the test drives evaluation
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    vi.setSystemTime(MARKET_OPEN_UTC);
    app = await startApp();
    http = app.getHttpServer();
    u = await createUser(app, 'trader');
  });
  beforeEach(async () => {
    await md.standard();
  });
  afterAll(async () => {
    await md.close();
    await app.close();
    vi.useRealTimers();
    process.env = saved;
  });

  it('layouts: save, list, replace, delete; name and size validated; 20 per user', async () => {
    const layout = { grid: { root: { type: 'branch', data: [] } }, panels: {} };
    const put = await request(http)
      .put('/me/layouts/My%20desk')
      .set(bearer(u.token))
      .send({ layout })
      .expect(200);
    expect(put.body).toMatchObject({ name: 'My desk', layout });
    await request(http)
      .put('/me/layouts/My%20desk')
      .set(bearer(u.token))
      .send({ layout: { ...layout, v: 2 } })
      .expect(200);
    const list = await request(http).get('/me/layouts').set(bearer(u.token)).expect(200);
    expect(list.body.layouts).toHaveLength(1);
    expect(list.body.layouts[0].layout.v).toBe(2);
    await request(http)
      .put('/me/layouts/%3Cscript%3E')
      .set(bearer(u.token))
      .send({ layout })
      .expect(400);
    const big = { blob: 'x'.repeat(70_000) };
    expect(
      (await request(http).put('/me/layouts/big').set(bearer(u.token)).send({ layout: big })).body
        .error,
    ).toBe('layout_too_large');
    for (let i = 0; i < 19; i++)
      await request(http)
        .put(`/me/layouts/l${i}`)
        .set(bearer(u.token))
        .send({ layout })
        .expect(200);
    expect(
      (await request(http).put('/me/layouts/one-too-many').set(bearer(u.token)).send({ layout }))
        .body.error,
    ).toBe('too_many_layouts');
    await request(http).delete('/me/layouts/My%20desk').set(bearer(u.token)).expect(204);
    await request(http).delete('/me/layouts/My%20desk').set(bearer(u.token)).expect(404);
    // Another user cannot see them.
    const other = await createUser(app, 'trader');
    expect(
      (await request(http).get('/me/layouts').set(bearer(other.token)).expect(200)).body.layouts,
    ).toEqual([]);
  });

  it('watchlists: Majors + Global defaults covering every venue, CRUD, registry validation, 500 cap', async () => {
    const first = await request(http).get('/me/watchlists').set(bearer(u.token)).expect(200);
    const [majors, global] = first.body.watchlists;
    expect(majors).toMatchObject({ name: 'Majors', position: 0 });
    expect(majors.symbols.slice(0, 3)).toEqual(['EURUSD', 'GBPUSD', 'USDJPY']);
    const venues = await ownerQuery<{ mic: string }>(
      "SELECT DISTINCT venue AS mic FROM instruments WHERE status = 'active'",
    );
    expect(global.name).toBe('Global');
    expect(global.symbols).toHaveLength(venues.length);
    // Idempotent: a second read does not duplicate the defaults.
    expect(
      (await request(http).get('/me/watchlists').set(bearer(u.token)).expect(200)).body.watchlists,
    ).toHaveLength(2);

    const created = await request(http)
      .post('/me/watchlists')
      .set(bearer(u.token))
      .send({ name: 'Asia', symbols: ['USDJPY'] })
      .expect(201);
    expect(created.body.position).toBe(2);
    await request(http)
      .post('/me/watchlists')
      .set(bearer(u.token))
      .send({ name: 'Asia' })
      .expect(409);
    const reordered = await request(http)
      .put(`/me/watchlists/${created.body.id}`)
      .set(bearer(u.token))
      .send({ symbols: ['XAUUSD', 'USDJPY'] })
      .expect(200);
    expect(reordered.body.symbols).toEqual(['XAUUSD', 'USDJPY']);
    expect(
      (
        await request(http)
          .put(`/me/watchlists/${created.body.id}`)
          .set(bearer(u.token))
          .send({ symbols: ['NOPE'] })
      ).body.error,
    ).toBe('unknown_symbol');
    await request(http)
      .put(`/me/watchlists/${created.body.id}`)
      .set(bearer(u.token))
      .send({ symbols: Array.from({ length: 501 }, (_, i) => `S${i}`) })
      .expect(400);
    const other = await createUser(app, 'trader');
    await request(http)
      .put(`/me/watchlists/${created.body.id}`)
      .set(bearer(other.token))
      .send({ name: 'mine' })
      .expect(404);
    await request(http)
      .delete(`/me/watchlists/${created.body.id}`)
      .set(bearer(u.token))
      .expect(204);
  });

  it('alerts: create (audited), server evaluation triggers once on price and RSI, cancel', async () => {
    const evaluator = app.get(AlertsService);
    const above = await request(http)
      .post('/price-alerts')
      .set(bearer(u.token))
      .send({ symbol: 'EURUSD', condition: 'price_above', threshold: '1.08500' })
      .expect(201);
    const below = await request(http)
      .post('/price-alerts')
      .set(bearer(u.token))
      .send({ symbol: 'EURUSD', condition: 'price_below', threshold: '1.08000', note: 'dip' })
      .expect(201);
    expect(above.body).toMatchObject({ status: 'active', threshold: '1.085', timeframe: null });
    await request(http)
      .post('/price-alerts')
      .set(bearer(u.token))
      .send({ symbol: 'NOPE', condition: 'price_above', threshold: '1' })
      .expect(400);
    await request(http)
      .post('/price-alerts')
      .set(bearer(u.token))
      .send({ symbol: 'EURUSD', condition: 'rsi_above', threshold: '150' })
      .expect(400);

    // Mid 1.08420: nothing triggers.
    expect(await evaluator.evaluateOnce()).toEqual([]);
    // A stale quote never triggers.
    await md.quote('EURUSD', '1.08600', '1.08602', { stale: true });
    expect(await evaluator.evaluateOnce()).toEqual([]);
    await md.quote('EURUSD', '1.08600', '1.08602');
    const fired = await evaluator.evaluateOnce();
    expect(fired.map((a) => a.id)).toEqual([above.body.id]);
    expect(fired[0]).toMatchObject({ status: 'triggered', triggeredValue: '1.08601' });
    expect(await evaluator.evaluateOnce()).toEqual([]); // once only
    const audit = await ownerQuery<{ action: string; actor_type: string }>(
      "SELECT action, actor_type FROM audit_events WHERE entity = 'price_alert' AND entity_id = $1 ORDER BY id",
      [above.body.id],
    );
    expect(audit.map((a) => `${a.actor_type}:${a.action}`)).toEqual([
      'user:alert.created',
      'system:alert.triggered',
    ]);

    // RSI(14) on 1m candles: 20 rising closes → RSI 100 ≥ 70.
    await ownerQuery(
      "DELETE FROM md_candles WHERE symbol = 'GBPUSD'; DELETE FROM md_candles_history WHERE symbol = 'GBPUSD'",
    );
    const t0 = Date.parse('2026-09-30T13:00:00Z');
    for (let i = 0; i < 20; i++) {
      const px = (1.26 + i * 0.0001).toFixed(5);
      await ownerQuery(
        "INSERT INTO md_candles_history (symbol, tf, bucket, open, high, low, close, volume, trades, source) VALUES ('GBPUSD', '1m', $1, $2, $2, $2, $2, 1, 1, 'test')",
        [new Date(t0 + i * 60_000).toISOString(), px],
      );
    }
    const rsiAlert = await request(http)
      .post('/price-alerts')
      .set(bearer(u.token))
      .send({ symbol: 'GBPUSD', condition: 'rsi_above', threshold: '70', timeframe: '1m' })
      .expect(201);
    const fired2 = await evaluator.evaluateOnce();
    expect(fired2.find((a) => a.id === rsiAlert.body.id)).toMatchObject({
      status: 'triggered',
      triggeredValue: '100',
    });

    await request(http).delete(`/price-alerts/${below.body.id}`).set(bearer(u.token)).expect(200);
    await request(http).delete(`/price-alerts/${below.body.id}`).set(bearer(u.token)).expect(409);
    const list = await request(http)
      .get('/price-alerts?status=all')
      .set(bearer(u.token))
      .expect(200);
    expect(list.body.alerts.map((a: { status: string }) => a.status).sort()).toEqual([
      'cancelled',
      'triggered',
      'triggered',
    ]);
  });

  it('cancel all (optionally per symbol) goes through the engine and audits each cancel', async () => {
    const t = await createUser(app, 'trader');
    await md.touch();
    for (const [symbol, price] of [
      ['EURUSD', '1.08000'],
      ['EURUSD', '1.07900'],
      ['GBPUSD', '1.26000'],
    ] as const) {
      await request(http)
        .post('/orders')
        .set(bearer(t.token))
        .send({
          clientOrderId: cid(),
          symbol,
          side: 'buy',
          type: 'limit',
          qty: '10000',
          limitPrice: price,
        })
        .expect(201);
    }
    const one = await request(http)
      .delete('/orders?symbol=EURUSD')
      .set(bearer(t.token))
      .expect(200);
    expect(one.body.cancelled).toBe(2);
    expect(
      (
        await request(http).get('/orders?status=open').set(bearer(t.token)).expect(200)
      ).body.orders.map((o: { symbol: string }) => o.symbol),
    ).toEqual(['GBPUSD']);
    const all = await request(http).delete('/orders').set(bearer(t.token)).expect(200);
    expect(all.body.cancelled).toBe(1);
    const ids = [...one.body.orders, ...all.body.orders].map((o: { id: string }) => o.id);
    const audit = await ownerQuery<{ n: number }>(
      "SELECT count(*)::int AS n FROM audit_events WHERE action = 'order.cancelled' AND entity_id = ANY($1)",
      [ids],
    );
    expect(audit[0]!.n).toBe(3);
    await request(http).delete('/orders?symbol=bad').set(bearer(t.token)).expect(400);
  });

  it('risk summary: exposure by currency, VaR needs 20 days, correlation, daily loss', async () => {
    const t = await createUser(app, 'trader');
    await md.touch();
    await request(http)
      .post('/orders')
      .set(bearer(t.token))
      .send({ clientOrderId: cid(), symbol: 'EURUSD', side: 'buy', type: 'market', qty: '10000' })
      .expect(201);
    await request(http)
      .post('/orders')
      .set(bearer(t.token))
      .send({ clientOrderId: cid(), symbol: 'AAPL', side: 'buy', type: 'market', qty: '10' })
      .expect(201);
    await ownerQuery(
      "DELETE FROM md_candles WHERE symbol IN ('EURUSD','AAPL') AND tf = '1D'; DELETE FROM md_candles_history WHERE symbol IN ('EURUSD','AAPL') AND tf = '1D'",
    );
    let r = await request(http).get('/risk/summary').set(bearer(t.token)).expect(200);
    expect(r.body).toMatchObject({ currency: 'USD', simulated: true, source: 'api' });
    const by = Object.fromEntries(
      r.body.exposure.map((e: { currency: string; amount: string }) => [e.currency, e.amount]),
    );
    expect(by.EUR).toBe('10000');
    expect(Number(by.USD)).toBeLessThan(0); // short USD from EUR/USD, partly offset by long AAPL
    expect(r.body.var).toMatchObject({
      method: 'historical',
      confidence: 0.95,
      horizonDays: 1,
      value: null,
      required: 20,
    });
    expect(r.body.var.note).toContain('Not enough daily history');
    expect(r.body.dailyLoss.limit).toBeTruthy();

    // 30 days of SIMULATED closes → VaR available and a correlation matrix.
    const day = 86_400_000;
    const start = Date.parse('2026-08-31T00:00:00Z');
    for (let i = 0; i < 30; i++) {
      const e = (1.08 + Math.sin(i) * 0.005).toFixed(5);
      const a = (220 + Math.sin(i) * 3).toFixed(2);
      for (const [sym, px] of [
        ['EURUSD', e],
        ['AAPL', a],
      ]) {
        await ownerQuery(
          "INSERT INTO md_candles_history (symbol, tf, bucket, open, high, low, close, volume, trades, source) VALUES ($1, '1D', $2, $3, $3, $3, $3, 1, 1, 'test')",
          [sym, new Date(start + i * day).toISOString(), px],
        );
      }
    }
    r = await request(http).get('/risk/summary').set(bearer(t.token)).expect(200);
    expect(r.body.var.observations).toBeGreaterThanOrEqual(20);
    expect(Number(r.body.var.value)).toBeGreaterThan(0);
    expect(r.body.correlation.symbols).toEqual(['AAPL', 'EURUSD']);
    expect(r.body.correlation.clusters).toEqual([['AAPL', 'EURUSD']]); // same sine shape: ρ ≈ 1
  });

  it('preferences carry terminal settings (partial updates merge, validation)', async () => {
    const res = await request(http)
      .put('/me/preferences')
      .set(bearer(u.token))
      .send({ terminal: { soundOnFills: true, perTradeRiskPct: '0.5' } })
      .expect(200);
    expect(res.body.preferences.terminal).toEqual({
      density: 'compact',
      timeDisplay: 'utc',
      soundOnFills: true,
      perTradeRiskPct: '0.5',
    });
    await request(http)
      .put('/me/preferences')
      .set(bearer(u.token))
      .send({ terminal: { density: 'comfortable' } })
      .expect(200);
    const me = await request(http).get('/me').set(bearer(u.token)).expect(200);
    expect(me.body.preferences.terminal).toMatchObject({
      density: 'comfortable',
      soundOnFills: true,
    });
    expect(me.body.preferences.hotkeys).toMatchObject({
      ticketBuy: 'B',
      submitOrder: 'Ctrl+Enter',
      focusBlotter: 'Alt+5',
    });
    await request(http)
      .put('/me/preferences')
      .set(bearer(u.token))
      .send({ terminal: { perTradeRiskPct: '0' } })
      .expect(400);
  });
});

describe('time and sales channel (B-210, in-process feed)', () => {
  let app: INestApplication;
  let url: string;
  let token: string;
  const saved = { ...process.env };

  beforeAll(async () => {
    process.env.KORA_MD_FEED = 'inprocess';
    process.env.KORA_MD_SYMBOLS = 'BTCUSD';
    process.env.KORA_MD_BACKFILL = 'false';
    app = await startApp();
    url = (await listen(app)).ws;
    token = (await createUser(app, 'trader', [], { realClock: true })).token;
  });
  afterAll(async () => {
    await app.close();
    process.env = saved;
  });

  it('streams batches of prints on trades:{symbol}', async () => {
    const c = await TestWs.authed(url, token, ['trades:BTCUSD']);
    const m = await c.waitFor((x) => x.ch === 'trades:BTCUSD' && !x.snapshot, 15_000);
    expect(m.msg.data).toMatchObject({ type: 'trades', symbol: 'BTCUSD' });
    expect(m.msg.data.trades.length).toBeGreaterThan(0);
    expect(m.msg.data.trades[0]).toEqual(
      expect.objectContaining({
        tradeId: expect.any(String),
        price: expect.stringMatching(/^\d+(\.\d+)?$/),
        side: expect.stringMatching(/^(buy|sell)$/),
      }),
    );
    c.send({ op: 'subscribe', channels: ['trades:NOPE'], id: 'bad' });
    const bad = await c.waitFor((x) => x.id === 'bad');
    expect(JSON.stringify(bad.msg)).toContain('unknown_symbol');
    c.ws.close();
  });
});

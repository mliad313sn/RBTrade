import type { INestApplication } from '@nestjs/common';
import { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ChannelHub } from '../src/market-data/channel-hub';
import { bearer, createUser, startApp } from './helpers';
import { listen, TestWs } from './ws-helpers';

/** Gateway behaviour with the feed OFF: the test publishes on the Redis bus directly. */
describe('market data WebSocket gateway', () => {
  let app: INestApplication;
  let url: string;
  let token: string;
  let redis: Redis;
  let hub: ChannelHub;
  const prefix = process.env.KORA_MD_REDIS_PREFIX!;
  const saved = { ...process.env };
  const pub = (ch: string, data: unknown) => redis.publish(`${prefix}${ch}`, JSON.stringify(data));
  const status = (state = 'ok') => ({ type: 'status', state, ts: Date.now(), feeds: [], staleSymbols: [], reason: null });
  const quote = (seq: number, bid = '1.08419') => ({
    type: 'quote', symbol: 'EURUSD', bid, ask: '1.08421', bidSize: '1000000', askSize: '1000000', stale: false,
    source: 'simulated', exchangeTs: Date.now(), receivedTs: Date.now(), seq,
  });

  beforeAll(async () => {
    process.env.KORA_MD_FEED = 'off';
    process.env.KORA_MD_FEED_TIMEOUT_MS = '800';
    process.env.KORA_MD_WS_MAX_CHANNELS = '5';
    app = await startApp();
    url = (await listen(app)).ws;
    token = (await createUser(app, 'novice', [], { realClock: true })).token;
    redis = new Redis(process.env.REDIS_URL!);
    hub = app.get(ChannelHub);
  });
  afterAll(async () => {
    redis.disconnect();
    await app.close();
    process.env = saved;
  });

  it('requires authentication: ops before auth are refused, bad tokens close with 4401', async () => {
    const a = await TestWs.open(url);
    await a.waitFor((m) => m.type === 'welcome' && m.simulated === true);
    a.send({ op: 'subscribe', channels: ['status'] });
    expect((await a.waitFor((m) => m.type === 'error')).msg.code).toBe('unauthenticated');
    a.send({ op: 'auth', token: 'not-a-real-token-xyz' });
    expect((await a.waitClose()).code).toBe(4401);
    const b = await TestWs.open(url);
    b.send('{ nope');
    expect((await b.waitFor((m) => m.type === 'error')).msg.code).toBe('bad_request');
    b.send({ op: 'subscribe', channels: ['status'], extra: 1 });
    await b.waitFor((m) => m.type === 'error' && m.code === 'bad_request', 2000, 2);
    b.close();
  });

  it('closes unauthenticated sockets after 5 s', async () => {
    const a = await TestWs.open(url);
    expect((await a.waitClose(7000)).code).toBe(4401);
  }, 10_000);

  it('accepts the session cookie from an allowed Origin and refuses foreign Origins', async () => {
    const ok = await TestWs.open(url, { origin: 'http://localhost:3000', cookie: `kora_at=${token}` });
    ok.send({ op: 'ping', id: 7 });
    expect((await ok.waitFor((m) => m.type === 'pong')).msg.id).toBe(7);
    ok.close();
    await expect(TestWs.open(url, { origin: 'https://evil.example', cookie: `kora_at=${token}` })).rejects.toThrow(/HTTP 403/);
    await expect(TestWs.open(url.replace('/ws', '/other'))).rejects.toThrow();
  });

  it('validates channels, unknown symbols and the per-connection channel cap', async () => {
    const c = await TestWs.authed(url, token);
    c.send({ op: 'subscribe', channels: ['quotes:EURUSD', 'quotes:NOPE', 'trades:EURUSD:1m', 'candles:EURUSD:2m', 'depth:7203.XTKS', 'candles:EURUSD:15m', 'status', 'quotes:GBPUSD', 'quotes:USDJPY'], id: 1 });
    const r = (await c.waitFor((m) => m.type === 'subscribed')).msg;
    expect(r.channels).toEqual(['quotes:EURUSD', 'depth:7203.XTKS', 'candles:EURUSD:15m', 'status', 'quotes:GBPUSD']);
    expect(r.rejected).toEqual([
      { channel: 'quotes:NOPE', code: 'unknown_symbol' },
      { channel: 'trades:EURUSD:1m', code: 'invalid_channel' },
      { channel: 'candles:EURUSD:2m', code: 'invalid_channel' },
      { channel: 'quotes:USDJPY', code: 'too_many_channels' },
    ]);
    c.close();
  });

  it('reference-counts Redis subscriptions and sends the last value as a snapshot', async () => {
    await pub('status', status());
    await redis.set(`${prefix}last:quotes:EURUSD`, JSON.stringify(quote(41)));
    const a = await TestWs.authed(url, token, ['quotes:EURUSD']);
    const snap = await a.waitFor((m) => m.ch === 'quotes:EURUSD');
    expect(snap.msg).toMatchObject({ snapshot: true, data: { seq: 41 } });
    const b = await TestWs.authed(url, token, ['quotes:EURUSD']);
    expect(hub.isSubscribed('quotes:EURUSD')).toBe(true);
    expect(hub.stats().subscriptions).toBeGreaterThanOrEqual(2);
    await pub('quotes:EURUSD', quote(42));
    await a.waitFor((m) => m.ch === 'quotes:EURUSD' && m.data.seq === 42 && !m.snapshot);
    await b.waitFor((m) => m.ch === 'quotes:EURUSD' && m.data.seq === 42 && !m.snapshot);
    a.send({ op: 'unsubscribe', channels: ['quotes:EURUSD'], id: 'u' });
    await a.waitFor((m) => m.type === 'unsubscribed');
    expect(hub.isSubscribed('quotes:EURUSD')).toBe(true);
    b.close();
    await b.waitClose();
    await new Promise((r) => setTimeout(r, 50));
    expect(hub.isSubscribed('quotes:EURUSD')).toBe(false);
    a.close();
  });

  it('conflates to 10 updates/s sustained (burst 2) per channel and always delivers the latest', async () => {
    await pub('status', status());
    const c = await TestWs.authed(url, token, ['quotes:EURUSD']);
    const from = c.messages.length;
    for (let i = 1; i <= 60; i++) {
      await pub('quotes:EURUSD', quote(1000 + i));
      await new Promise((r) => setTimeout(r, 10)); // ~100 msg/s in
    }
    await pub('status', status());
    await c.waitFor((m) => m.ch === 'quotes:EURUSD' && m.data.seq === 1060, 3000, from);
    const got = c.messages.slice(from).filter((m) => m.msg.ch === 'quotes:EURUSD' && !m.msg.snapshot);
    const times = got.map((m) => m.at);
    // token bucket: 13 sends need ≥ (13 − 2) × 100 ms
    for (let i = 12; i < times.length; i++) expect(times[i]! - times[i - 12]!).toBeGreaterThanOrEqual(1050);
    expect(got.length).toBeLessThan(25);
    expect(hub.stats().conflated).toBeGreaterThan(0);
    c.close();
  });

  it('marks the feed down and quotes stale when the feed heartbeat stops', async () => {
    await pub('status', status());
    await redis.set(`${prefix}last:quotes:EURUSD`, JSON.stringify(quote(7)));
    const c = await TestWs.authed(url, token, ['status', 'quotes:EURUSD']);
    await pub('quotes:EURUSD', quote(8));
    await c.waitFor((m) => m.ch === 'quotes:EURUSD' && m.data.seq === 8);
    const from = c.messages.length;
    const down = await c.waitFor((m) => m.ch === 'status' && m.data.state === 'down', 3000, from);
    expect(down.msg.data).toMatchObject({ reason: 'feed_heartbeat_lost', staleSymbols: ['EURUSD'] });
    await c.waitFor((m) => m.ch === 'quotes:EURUSD' && m.data.stale === true && m.data.seq === 8, 2000, from);
    const rest = await request(app.getHttpServer()).get('/quotes?symbols=EURUSD').set(bearer(token)).expect(200);
    expect(rest.body.quotes[0].quote.stale).toBe(true);
    await pub('status', status());
    await c.waitFor((m) => m.ch === 'status' && m.data.state === 'ok', 2000, from);
    expect(hub.stats().feedLost).toBe(false);
    const st = await request(app.getHttpServer()).get('/market-data/status').set(bearer(token)).expect(200);
    expect(st.body).toMatchObject({ feedMode: 'off', status: { state: 'ok' } });
    await request(app.getHttpServer()).post('/market-data/feeds/simulated/stop').set(bearer(token)).expect(403);
    c.close();
  });

  it('rate-limits abusive clients', async () => {
    const c = await TestWs.authed(url, token);
    for (let i = 0; i < 70; i++) c.send({ op: 'ping' });
    expect((await c.waitClose()).code).toBe(1008);
  });
});

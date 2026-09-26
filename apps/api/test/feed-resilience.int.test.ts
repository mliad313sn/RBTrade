import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FeedService } from '../src/market-data/feed.service';
import { bearer, createUser, ownerQuery, startApp } from './helpers';
import { listen, TestWs } from './ws-helpers';

/**
 * Acceptance: killing the adapter makes `status` go `degraded` within 3 s and quotes turn
 * `stale:true`; restarting it recovers with a gap resync. Real feed, real Redis, real WebSocket.
 */
describe('feed resilience (in-process feed, real gateway)', () => {
  let app: INestApplication;
  let url: string;
  let admin: string;
  let trader: string;
  const saved = { ...process.env };

  beforeAll(async () => {
    process.env.KORA_MD_FEED = 'inprocess';
    process.env.KORA_MD_SYMBOLS = 'EURUSD,BTCUSD,AAPL';
    process.env.KORA_MD_ROLLUP_MS = '1000';
    process.env.KORA_MD_BACKFILL = 'true';
    process.env.KORA_MD_HISTORY_DAYS = '1';
    await ownerQuery(
      "DELETE FROM md_bars_1s WHERE symbol IN ('EURUSD','BTCUSD','AAPL'); DELETE FROM md_candles WHERE symbol IN ('EURUSD','BTCUSD','AAPL'); DELETE FROM md_candles_history WHERE symbol IN ('EURUSD','BTCUSD','AAPL')",
    );
    app = await startApp();
    url = (await listen(app)).ws;
    admin = (await createUser(app, 'trader', ['admin'], { realClock: true })).token;
    trader = (await createUser(app, 'trader', [], { realClock: true })).token;
  });
  afterAll(async () => {
    await app.close();
    process.env = saved;
  });

  it('stop → degraded + stale within 3 s; start → gap detected, resynced, ok again', async () => {
    const http = app.getHttpServer();
    const c = await TestWs.authed(url, admin, ['status', 'quotes:EURUSD', 'quotes:BTCUSD']);
    await c.waitFor((m) => m.ch === 'status' && m.data.state === 'ok');
    const live = await c.waitFor((m) => m.ch === 'quotes:EURUSD' && !m.snapshot && m.data.stale === false);
    expect(live.msg.data).toMatchObject({ source: 'simulated', symbol: 'EURUSD' });

    await request(http).post('/market-data/feeds/simulated/stop').set(bearer(trader)).expect(403);

    const from = c.messages.length;
    const t0 = Date.now();
    const stop = await request(http).post('/market-data/feeds/simulated/stop').set(bearer(admin)).expect(202);
    const degraded = await c.waitFor((m) => m.ch === 'status' && m.data.state === 'degraded', 3000, from);
    const stale = await c.waitFor((m) => m.ch === 'quotes:EURUSD' && m.data.stale === true, 3000, from);
    const lastSeq = stale.msg.data.seq as number;
    const degradedMs = degraded.at - t0;
    const staleMs = stale.at - t0;
    console.warn(`[resilience] degraded after ${degradedMs} ms, stale after ${staleMs} ms`);
    expect(degradedMs).toBeLessThan(3000);
    expect(staleMs).toBeLessThan(3000);
    expect(degraded.msg.data.feeds.find((f: { source: string }) => f.source === 'simulated').state).toBe('down');
    expect(degraded.msg.data.staleSymbols).toEqual(expect.arrayContaining(['BTCUSD', 'EURUSD']));

    const rest = await request(http).get('/quotes?symbols=EURUSD,BTCUSD').set(bearer(trader)).expect(200);
    expect(rest.body.quotes.map((q: { quote: { stale: boolean } }) => q.quote.stale)).toEqual([true, true]);
    const audit = await request(http).get(`/audit?action=market_data.*`).set(bearer(admin)).expect(200);
    expect(audit.body.events.map((e: { id: string }) => e.id)).toContain(stop.body.auditEventId);

    await new Promise((r) => setTimeout(r, 1000)); // the simulated venue keeps moving while we are away

    const from2 = c.messages.length;
    await request(http).post('/market-data/feeds/simulated/start').set(bearer(admin)).expect(202);
    const fresh = await c.waitFor((m) => m.ch === 'quotes:EURUSD' && m.data.stale === false, 3000, from2);
    expect(fresh.msg.data.seq).toBeGreaterThan(lastSeq + 1); // missed steps were never delivered
    const ok = await c.waitFor((m) => m.ch === 'status' && m.data.state === 'ok' && m.data.feeds[0].resyncs >= 1, 5000, from2);
    const feed = ok.msg.data.feeds.find((f: { source: string }) => f.source === 'simulated');
    expect(feed.gaps).toBeGreaterThanOrEqual(1);
    expect(feed.lastResync.got).toBeGreaterThan(feed.lastResync.expected);
    expect(ok.msg.data.staleSymbols).toEqual([]);
    const status = await request(http).get('/market-data/status').set(bearer(trader)).expect(200);
    expect(status.body).toMatchObject({ feedMode: 'inprocess', status: { state: 'ok' }, gateway: { connections: 1, feedLost: false } });
    c.close();
  });

  it('a silent stall goes stale by quote age per asset class (FX 2 s before equities 5 s)', async () => {
    const c = await TestWs.authed(url, trader, ['status', 'quotes:EURUSD', 'quotes:AAPL']);
    await c.waitFor((m) => m.ch === 'quotes:AAPL' && m.data.stale === false && !m.snapshot);
    const sim = app.get(FeedService).simulated()!;
    const from = c.messages.length;
    const t0 = Date.now();
    sim.freeze();
    const fx = await c.waitFor((m) => m.ch === 'quotes:EURUSD' && m.data.stale === true, 3500, from);
    const fxMs = fx.at - t0;
    const deg = await c.waitFor((m) => m.ch === 'status' && m.data.state === 'degraded' && m.data.staleSymbols.includes('EURUSD'), 1000, from);
    expect(deg.msg.data.staleSymbols).not.toContain('AAPL');
    expect(deg.msg.data.feeds[0].state).toBe('up');
    const eq = await c.waitFor((m) => m.ch === 'quotes:AAPL' && m.data.stale === true, 7000, from);
    const eqMs = eq.at - t0;
    console.warn(`[stall] FX stale after ${fxMs} ms, equity stale after ${eqMs} ms`);
    expect(fxMs).toBeGreaterThanOrEqual(1900);
    expect(fxMs).toBeLessThan(3000);
    expect(eqMs).toBeGreaterThanOrEqual(4900);
    sim.unfreeze();
    await c.waitFor((m) => m.ch === 'status' && m.data.state === 'ok', 4000, c.messages.length);
    c.close();
  }, 20_000);

  it('backfills SIMULATED history that ends at the live start price', async () => {
    const rows = await app.get(FeedService).backfill;
    expect(rows).toBeGreaterThan(0);
    const counts = await ownerQuery<{ tf: string; n: string }>("SELECT tf, count(*) AS n FROM md_candles_history WHERE symbol = 'EURUSD' GROUP BY tf ORDER BY tf");
    expect(Object.fromEntries(counts.map((c) => [c.tf, Number(c.n)]))).toMatchObject({ '1m': 1440, '1h': expect.any(Number), '1D': expect.any(Number) });
    const [last] = await ownerQuery<{ close: string }>("SELECT close FROM md_candles_history WHERE symbol = 'EURUSD' AND tf = '1m' ORDER BY bucket DESC LIMIT 1");
    expect(last!.close).toBe('1.08420'); // no stored live data before this run → simulator reference start
    const res = await request(app.getHttpServer()).get('/candles?symbol=EURUSD&tf=15m&limit=500').set(bearer(trader)).expect(200);
    expect(res.body.candles.length).toBeGreaterThanOrEqual(96);
    expect(await app.get(FeedService).backfill).toBe(rows); // idempotent: symbols with history are skipped on restart
  });

  it('persists trades and 1 s bars and rolls them up into candles', async () => {
    const deadline = Date.now() + 8000;
    let rows: Array<{ n: string }> = [];
    while (Date.now() < deadline) {
      rows = await ownerQuery<{ n: string }>("SELECT count(*) AS n FROM md_candles WHERE symbol = 'BTCUSD' AND tf = '1m'");
      if (Number(rows[0]!.n) > 0) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(Number(rows[0]!.n)).toBeGreaterThan(0);
    const [t] = await ownerQuery<{ trades: string; bars: string }>(
      "SELECT (SELECT count(*) FROM md_trades WHERE symbol = 'BTCUSD') AS trades, (SELECT count(*) FROM md_bars_1s WHERE symbol = 'BTCUSD') AS bars",
    );
    expect(Number(t!.trades)).toBeGreaterThan(0);
    expect(Number(t!.bars)).toBeGreaterThan(0);
    const candles = await request(app.getHttpServer()).get('/candles?symbol=BTCUSD&tf=1m&limit=5').set(bearer(trader)).expect(200);
    expect(candles.body.candles.length).toBeGreaterThan(0);
    for (const k of candles.body.candles) expect(k.open).toMatch(/^\d+\.\d$/); // BTCUSD registry precision = 1
  });
});

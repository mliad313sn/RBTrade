import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { EngineLoopService } from '../src/trading/engine-loop.service';
import { acknowledgeRiskWarning, bearer, createUser, startApp, type TestUser } from './helpers';
import { MARKET_OPEN_UTC, MarketFixture } from './market-fixture';

let n = 0;
const cid = () => `r-${process.pid}-${++n}`;

/**
 * Pre-trade risk end to end (each rule's positive and negative case with messages is unit-tested
 * exhaustively in packages/domain/src/trading/risk.test.ts) and goal 02 fill safety: never fill on
 * stale quotes, a feed that is not ok, or a closed session.
 */
describe('pre-trade risk and fill safety through the API', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let trader: TestUser;
  const md = new MarketFixture();

  beforeAll(async () => {
    process.env.KORA_ENGINE_ENABLED = 'false';
    process.env.KORA_RECONCILIATION_INTERVAL_MS = '0';
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    vi.setSystemTime(MARKET_OPEN_UTC);
    app = await startApp();
    http = app.getHttpServer();
    trader = await createUser(app, 'trader');
  });
  beforeEach(async () => md.standard());
  afterAll(async () => {
    await md.close();
    await app.close();
    vi.useRealTimers();
    delete process.env.KORA_ENGINE_ENABLED;
    delete process.env.KORA_RECONCILIATION_INTERVAL_MS;
  });

  const send = async (u: TestUser, body: object) => {
    await md.status();
    return request(http).post('/orders').set(bearer(u.token)).send({ clientOrderId: cid(), ...body });
  };
  const rejected = async (u: TestUser, body: object, code: string) => {
    const res = await send(u, body);
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body).toMatchObject({ error: 'risk_rejected', code, order: { status: 'rejected', rejectCode: code } });
    expect(res.body.message.length).toBeGreaterThan(20);
    return res.body;
  };

  it('max order notional: positive and negative', async () => {
    await md.touch();
    expect((await send(trader, { symbol: 'EURUSD', side: 'buy', type: 'limit', qty: '100000', limitPrice: '1.08000' })).status).toBe(201);
    const r = await rejected(trader, { symbol: 'EURUSD', side: 'buy', type: 'limit', qty: '1000000', limitPrice: '1.08000' }, 'MAX_ORDER_NOTIONAL');
    expect(r.message).toContain('1000000.00 USD limit per order');
  });

  it('fat-finger band per asset class (FX 1%, crypto 5%)', async () => {
    await md.touch();
    await rejected(trader, { symbol: 'EURUSD', side: 'buy', type: 'limit', qty: '1000', limitPrice: '1.07000' }, 'FAT_FINGER');
    expect((await send(trader, { symbol: 'BTCUSD', side: 'buy', type: 'limit', qty: '0.001', limitPrice: '62000.0' })).status).toBe(201); // 4.3% away
    await rejected(trader, { symbol: 'BTCUSD', side: 'buy', type: 'limit', qty: '0.001', limitPrice: '60000.0' }, 'FAT_FINGER');
  });

  it('leverage, margin, position size and loss limits use the account (tightened limits)', async () => {
    const u = await createUser(app, 'trader');
    await request(http).put('/accounts/me/settings').set(bearer(u.token)).send({ riskLimits: { maxPositionNotional: '50000', maxLeverage: '0.5' } }).expect(200);
    // Loosening past the platform value is ignored.
    const loose = await request(http).put('/accounts/me/settings').set(bearer(u.token)).send({ riskLimits: { maxOrderNotional: '99999999' } }).expect(200);
    expect(loose.body.limits.maxOrderNotional).toBe('1000000');
    await md.touch();
    await rejected(u, { symbol: 'EURUSD', side: 'buy', type: 'market', qty: '60000' }, 'MAX_POSITION');
    expect((await send(u, { symbol: 'EURUSD', side: 'buy', type: 'market', qty: '40000' })).status).toBe(201);
    // Gross exposure 43.4k (EUR/USD) + 22.1k (AAPL) = 65.5k > 0.5 × 100k equity.
    await md.touch();
    const lev = await rejected(u, { symbol: 'AAPL', side: 'buy', type: 'market', qty: '100' }, 'MAX_LEVERAGE');
    expect(lev.message).toContain('0.5× limit');
  });

  it('daily loss limit blocks new exposure but still allows reducing orders', async () => {
    const u = await createUser(app, 'trader');
    await request(http).put('/accounts/me/settings').set(bearer(u.token)).send({ riskLimits: { dailyLossLimit: '50' } }).expect(200);
    await md.touch();
    expect((await send(u, { symbol: 'EURUSD', side: 'buy', type: 'market', qty: '100000' })).status).toBe(201);
    await md.quote('EURUSD', '1.08300', '1.08302'); // −121 unrealised
    await rejected(u, { symbol: 'EURUSD', side: 'buy', type: 'market', qty: '1000' }, 'DAILY_LOSS_LIMIT');
    expect((await send(u, { symbol: 'EURUSD', side: 'sell', type: 'market', qty: '100000' })).status).toBe(201);
  });

  it('orders per minute', async () => {
    const u = await createUser(app, 'trader');
    await request(http).put('/accounts/me/settings').set(bearer(u.token)).send({ riskLimits: { maxOrdersPerMinute: 3 } }).expect(200);
    await md.touch();
    for (let i = 0; i < 3; i++) expect((await send(u, { symbol: 'EURUSD', side: 'buy', type: 'limit', qty: '1000', limitPrice: '1.08000' })).status).toBe(201);
    const r = await rejected(u, { symbol: 'EURUSD', side: 'buy', type: 'limit', qty: '1000', limitPrice: '1.08000' }, 'ORDER_RATE_LIMIT');
    expect(r.message).toContain('limit is 3');
  });

  it('insufficient margin', async () => {
    const u = await createUser(app, 'trader');
    await md.touch();
    // BTC margin 50%: 1.5 BTC ≈ 97k notional → 48.6k margin; twice that exceeds equity.
    expect((await send(u, { symbol: 'BTCUSD', side: 'buy', type: 'market', qty: '1.5' })).status).toBe(201);
    await md.touch();
    await rejected(u, { symbol: 'BTCUSD', side: 'buy', type: 'market', qty: '2' }, 'INSUFFICIENT_MARGIN');
  });

  it('novice guardrails: market only, stop required, no leverage; closing needs no stop', async () => {
    const nov = await createUser(app, 'novice');
    await acknowledgeRiskWarning(app, nov.token); // B-801 gate (goal 09)
    await md.touch();
    const noStop = await rejected(nov, { symbol: 'EURUSD', side: 'buy', type: 'market', qty: '10000' }, 'NOVICE_STOP_REQUIRED');
    expect(noStop.message).toContain('stop loss');
    await rejected(nov, { symbol: 'EURUSD', side: 'buy', type: 'limit', qty: '10000', limitPrice: '1.08000', stopLossPrice: '1.07500' }, 'NOVICE_ORDER_TYPE');
    await rejected(nov, { symbol: 'EURUSD', side: 'buy', type: 'market', qty: '100000', stopLossPrice: '1.08000' }, 'NOVICE_LEVERAGE');
    const ok = await send(nov, { symbol: 'EURUSD', side: 'buy', type: 'market', qty: '10000', stopLossPrice: '1.08000' });
    expect(ok.status).toBe(201);
    expect(ok.body.order.status).toBe('filled');
    const preview = await request(http).post('/orders/preview').set(bearer(nov.token)).send({ symbol: 'EURUSD', side: 'buy', type: 'market', qty: '1000', stopLossPrice: '1.08000' }).expect(200);
    expect(preview.body).toMatchObject({ novice: true, preview: { confirmation: { required: true } } });
    await md.touch();
    const close = await request(http).post('/positions/EURUSD/close').set(bearer(nov.token)).expect(201);
    expect(close.body.order.status).toBe('filled');
    // A trader using the Novice view gets the same guardrails.
    await request(http).put('/me/preferences').set(bearer(trader.token)).send({ viewMode: 'novice' }).expect(200);
    await md.touch();
    await rejected(trader, { symbol: 'EURUSD', side: 'buy', type: 'market', qty: '1000' }, 'NOVICE_STOP_REQUIRED');
    await request(http).put('/me/preferences').set(bearer(trader.token)).send({ viewMode: 'pro' }).expect(200);
  });

  it('post-only would take; stop-loss on the wrong side', async () => {
    await md.touch();
    await rejected(trader, { symbol: 'EURUSD', side: 'buy', type: 'limit', qty: '1000', limitPrice: '1.08425', postOnly: true }, 'POST_ONLY_WOULD_TAKE');
    await rejected(trader, { symbol: 'EURUSD', side: 'buy', type: 'market', qty: '1000', stopLossPrice: '1.08500' }, 'STOP_LOSS_WRONG_SIDE');
  });

  it('fill safety: stale quote, feed not ok, lost heartbeat → market orders refused; resting orders held until safe', async () => {
    await md.touch();
    const resting = await send(trader, { symbol: 'EURUSD', side: 'buy', type: 'limit', qty: '1000', limitPrice: '1.08300' });
    expect(resting.status).toBe(201);
    const engine = app.get(EngineLoopService);

    // 1. Stale quote (older than the 2 s FX threshold).
    await md.quote('EURUSD', '1.08280', '1.08290', { receivedTs: Date.now() - 3000 });
    await rejected(trader, { symbol: 'EURUSD', side: 'buy', type: 'market', qty: '1000' }, 'MARKET_DATA_STALE');
    await engine.matchSymbol('EURUSD');
    expect((await request(http).get(`/orders/${resting.body.order.id}`).set(bearer(trader.token)).expect(200)).body.status).toBe('working');

    // 2. Quote flagged stale by the feed.
    await md.quote('EURUSD', '1.08280', '1.08290', { stale: true });
    await rejected(trader, { symbol: 'EURUSD', side: 'buy', type: 'market', qty: '1000' }, 'MARKET_DATA_STALE');

    // 3. Feed not ok for the quote's source, and a lost heartbeat.
    await md.quote('EURUSD', '1.08280', '1.08290');
    await md.status({ state: 'degraded', feed: 'down' });
    await rejected(trader, { symbol: 'EURUSD', side: 'buy', type: 'market', qty: '1000' }, 'FEED_NOT_OK');
    await engine.matchSymbol('EURUSD');
    expect((await request(http).get(`/orders/${resting.body.order.id}`).set(bearer(trader.token)).expect(200)).body.status).toBe('working');
    await md.status({ state: 'ok', feed: 'up', ts: Date.now() - 10_000 });
    await rejected(trader, { symbol: 'EURUSD', side: 'buy', type: 'market', qty: '1000' }, 'FEED_NOT_OK');

    // Healthy again: the held order fills on the next pass.
    await md.status({ state: 'ok', feed: 'up', ts: null });
    await md.quote('EURUSD', '1.08280', '1.08290');
    await engine.matchSymbol('EURUSD');
    expect((await request(http).get(`/orders/${resting.body.order.id}`).set(bearer(trader.token)).expect(200)).body.status).toBe('filled');
  });

  it('FX rate unavailable blocks orders in a foreign currency', async () => {
    const u = await createUser(app, 'trader');
    await md.touch();
    const redisKey = `${process.env.KORA_MD_REDIS_PREFIX}last:quotes:EURUSD`;
    const { Redis } = await import('ioredis');
    const r = new Redis(process.env.REDIS_URL!);
    await r.del(redisKey);
    await md.status();
    await md.quote('SAP.XETR', '202.38', '202.42');
    const res = await request(http).post('/orders').set(bearer(u.token)).send({ clientOrderId: cid(), symbol: 'SAP.XETR', side: 'buy', type: 'market', qty: '1' });
    expect(res.status).toBe(422);
    expect(res.body.violations.map((v: { code: string }) => v.code)).toContain('FX_RATE_UNAVAILABLE');
    r.disconnect();
  });
  it('fill safety: closed session (Saturday) refuses market orders and holds resting ones', async () => {
    vi.setSystemTime(new Date('2026-10-03T12:00:00Z')); // Saturday: FX and US equities closed
    const trader = await createUser(app, 'trader');
    await md.standard();
    const r = await rejected(trader, { symbol: 'AAPL', side: 'buy', type: 'market', qty: '1' }, 'SESSION_CLOSED');
    expect(r.message).toContain('closed');
    await rejected(trader, { symbol: 'EURUSD', side: 'buy', type: 'market', qty: '1000' }, 'SESSION_CLOSED');
    const rest = await send(trader, { symbol: 'AAPL', side: 'buy', type: 'limit', qty: '1', limitPrice: '221.00' });
    expect(rest.status).toBe(201);
    await md.quote('AAPL', '220.50', '220.60');
    await app.get(EngineLoopService).matchSymbol('AAPL');
    expect((await request(http).get(`/orders/${rest.body.order.id}`).set(bearer(trader.token)).expect(200)).body.status).toBe('working');
    // Crypto trades 24/7.
    expect((await send(trader, { symbol: 'BTCUSD', side: 'buy', type: 'market', qty: '0.001' })).status).toBe(201);
  });
});

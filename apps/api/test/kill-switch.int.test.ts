import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { EngineLoopService } from '../src/trading/engine-loop.service';
import { OmsService } from '../src/trading/oms.service';
import { bearer, createUser, ownerQuery, startApp, type TestUser } from './helpers';
import { MARKET_OPEN_UTC, MarketFixture } from './market-fixture';

let n = 0;
const cid = (p = 'k') => `${p}-${process.pid}-${++n}`;

/**
 * Goal 03 acceptance: "Kill switch scope 3 halts robots, cancels all working orders and flattens all
 * positions within 2 s under a load of 1,000 open orders. The audit log shows each child action."
 * Real Postgres, real API, real audit chain.
 */
describe('kill switch engine', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  const md = new MarketFixture();

  beforeAll(async () => {
    process.env.KORA_ENGINE_ENABLED = 'false';
    process.env.KORA_RECONCILIATION_INTERVAL_MS = '0';
    process.env.KORA_RISK_MAX_ORDERS_PER_MINUTE = '5000';
    process.env.KORA_ORDER_RATE_LIMIT = '5000';
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    vi.setSystemTime(MARKET_OPEN_UTC);
    app = await startApp();
    http = app.getHttpServer();
    await md.standard();
  });
  afterAll(async () => {
    await md.close();
    await app.close();
    vi.useRealTimers();
    delete process.env.KORA_ENGINE_ENABLED;
    delete process.env.KORA_RECONCILIATION_INTERVAL_MS;
    delete process.env.KORA_RISK_MAX_ORDERS_PER_MINUTE;
    delete process.env.KORA_ORDER_RATE_LIMIT;
  });

  const place = async (u: TestUser, body: object) => {
    const res = await request(http).post('/orders').set(bearer(u.token)).send({ clientOrderId: cid(), ...body });
    if (res.status !== 201) throw new Error(`${res.status} ${JSON.stringify(res.body)}`);
    return res.body.order as { id: string; status: string };
  };

  it('scope 3 with 1,000 open orders and 4 positions: halted, all cancelled, all flattened in < 2 s, every child action audited', async () => {
    const u = await createUser(app, 'trader');
    await md.touch();
    for (const [symbol, qty] of [
      ['EURUSD', '100000'],
      ['XAUUSD', '10'],
      ['BTCUSD', '0.5'],
      ['AAPL', '100'],
    ] as const) {
      expect((await place(u, { symbol, side: 'buy', type: 'market', qty })).status).toBe('filled');
    }
    // 1,000 resting limit orders (within the fat-finger band, below the market so none fill).
    const limits: Array<[string, string, string]> = [
      ['EURUSD', '1000', '1.08000'],
      ['XAUUSD', '1', '2390.00'],
      ['BTCUSD', '0.0001', '64000.0'],
      ['AAPL', '1', '220.00'],
    ];
    const batch = 10;
    for (let i = 0; i < 1000; i += batch) {
      await Promise.all(
        Array.from({ length: batch }, (_, j) => {
          const [symbol, qty, limitPrice] = limits[(i + j) % limits.length]!;
          return place(u, { symbol, side: 'buy', type: 'limit', qty, limitPrice });
        }),
      );
    }
    const open = await request(http).get('/orders?status=open&limit=2000').set(bearer(u.token)).expect(200);
    expect(open.body.orders).toHaveLength(1000);

    await md.touch();
    const t0 = performance.now();
    const res = await request(http).post('/kill-switch').set(bearer(u.token)).send({ scope: 'robots_cancel_flatten', source: 'rest_fallback', reason: 'load test' }).expect(202);
    const elapsed = performance.now() - t0;
    process.stdout.write(`[kill-switch] scope 3 with 1,000 open orders + 4 positions: ${elapsed.toFixed(0)} ms end-to-end (server ${res.body.durationMs} ms)\n`);
    expect(elapsed).toBeLessThan(2000);
    expect(res.body).toMatchObject({
      accepted: true,
      scope: 'robots_cancel_flatten',
      engine: 'paper',
      halted: true,
      alreadyHalted: false,
      robotsHalted: true,
      ordersCancelled: 1000,
      positionsFlattened: 4,
      flattenPending: [],
    });

    expect((await request(http).get('/orders?status=open').set(bearer(u.token)).expect(200)).body.orders).toHaveLength(0);
    expect((await request(http).get('/positions').set(bearer(u.token)).expect(200)).body.positions).toHaveLength(0);
    const acct = (await request(http).get('/accounts/me').set(bearer(u.token)).expect(200)).body;
    expect(acct.halt).toMatchObject({ halted: true, scope: 'robots_cancel_flatten', reason: 'load test', haltedBy: u.id });

    // Audit: the request, the robot halt, 1,000 cancellations, 4 flatten orders filled, completion.
    const ks = res.body.killSwitchId as string;
    const counts = await ownerQuery<{ action: string; n: string }>(
      `SELECT action, count(*)::text AS n FROM audit_events WHERE payload->>'killSwitchId' = $1 GROUP BY action ORDER BY action`,
      [ks],
    );
    const by = Object.fromEntries(counts.map((c) => [c.action, Number(c.n)]));
    expect(by).toMatchObject({
      'kill_switch.requested': 1,
      'kill_switch.robots_halted': 1,
      'order.cancelled': 1000,
      'order.new': 4,
      'order.accepted': 4,
      'order.working': 4,
      'kill_switch.completed': 1,
    });
    const flattenFills = await ownerQuery<{ n: string }>(
      `SELECT count(*)::text AS n FROM orders o WHERE o.account_id = $1 AND o.source = 'kill-switch' AND o.status = 'filled'`,
      [acct.id],
    );
    expect(flattenFills[0]!.n).toBe('4');
    const request0 = await ownerQuery<{ id: string }>(`SELECT id::text AS id FROM audit_events WHERE action = 'kill_switch.requested' AND payload->>'killSwitchId' = $1`, [ks]);
    expect(res.body.auditEventId).toBe(request0[0]!.id);
    const verify = await request(http).get('/audit/verify').set(bearer(u.token)).expect(200);
    expect(verify.body).toMatchObject({ valid: true, firstBrokenId: null });
    const recon = await request(http).post('/reconciliation/run').set(bearer(u.token)).expect(200);
    expect(recon.body.mismatches).toEqual([]);
  }, 180_000);

  it('is idempotent; halted accounts refuse robot orders but not manual ones; resume needs an authorised role', async () => {
    const u = await createUser(app, 'trader');
    await md.touch();
    await place(u, { symbol: 'EURUSD', side: 'buy', type: 'limit', qty: '1000', limitPrice: '1.08000' });
    const first = await request(http).post('/kill-switch').set(bearer(u.token)).send({ scope: 'robots_cancel' }).expect(202);
    expect(first.body).toMatchObject({ ordersCancelled: 1, alreadyHalted: false });
    const again = await request(http).post('/kill-switch').set(bearer(u.token)).send({ scope: 'robots_cancel' }).expect(202);
    expect(again.body).toMatchObject({ ordersCancelled: 0, alreadyHalted: true, robotsHalted: false, halted: true });
    const narrower = await request(http).post('/kill-switch').set(bearer(u.token)).send({ scope: 'robots' }).expect(202);
    expect(narrower.body.alreadyHalted).toBe(true);
    expect((await request(http).get('/kill-switch').set(bearer(u.token)).expect(200)).body).toMatchObject({ halted: true, scope: 'robots_cancel' });

    const oms = app.get(OmsService);
    const robot = { userId: u.id, roles: u.roles, actor: { type: 'robot' as const, id: '0b3c9a4e-1f2d-4c5b-9a8e-7d6c5b4a3f21' }, source: 'robot:0b3c9a4e-1f2d-4c5b-9a8e-7d6c5b4a3f21' as const };
    const body = { clientOrderId: cid('bot'), symbol: 'EURUSD', side: 'buy' as const, type: 'limit' as const, qty: '1000', limitPrice: '1.08000', tif: 'gtc' as const, reduceOnly: false, postOnly: false, source: 'manual' as const };
    await md.touch();
    await expect(oms.submit(robot, body)).rejects.toMatchObject({ response: { code: 'TRADING_HALTED' } });
    const manual = await place(u, { symbol: 'EURUSD', side: 'buy', type: 'limit', qty: '1000', limitPrice: '1.08000' });
    expect(manual.status).toBe('working');

    const novice = await createUser(app, 'novice');
    await request(http).post('/kill-switch').set(bearer(novice.token)).send({ scope: 'robots' }).expect(202);
    const denied = await request(http).post('/kill-switch/resume').set(bearer(novice.token)).send({ reason: 'I want to trade' }).expect(403);
    expect(denied.body.message).toContain('two-factor');
    await request(http).post('/kill-switch/resume').set(bearer(u.token)).send({ reason: 'ok' }).expect(400);
    const resumed = await request(http).post('/kill-switch/resume').set(bearer(u.token)).send({ reason: 'bot fixed and reviewed' }).expect(200);
    expect(resumed.body).toMatchObject({ resumed: true, previous: { scope: 'robots_cancel' } });
    await request(http).post('/kill-switch/resume').set(bearer(u.token)).send({ reason: 'bot fixed and reviewed' }).expect(409);
    await md.touch();
    const botOrder = await oms.submit(robot, { ...body, clientOrderId: cid('bot') });
    expect(botOrder.order).toMatchObject({ status: 'working', source: 'robot:0b3c9a4e-1f2d-4c5b-9a8e-7d6c5b4a3f21' });
    const resumeAudit = await ownerQuery<{ payload: { reason: string } }>(`SELECT payload FROM audit_events WHERE action = 'kill_switch.resumed' AND actor_id = $1`, [u.id]);
    expect(resumeAudit[0]!.payload.reason).toBe('bot fixed and reviewed');

    // A risk officer can resume someone else's account.
    const risk = await createUser(app, 'trader', ['risk_officer']);
    const novAcct = (await request(http).get('/accounts/me').set(bearer(novice.token)).expect(200)).body.id;
    await request(http).post(`/kill-switch/resume?accountId=${novAcct}`).set(bearer(u.token)).send({ reason: 'not mine to resume' }).expect(403);
    await request(http).post(`/kill-switch/resume?accountId=${novAcct}`).set(bearer(risk.token)).send({ reason: 'reviewed with the customer' }).expect(200);
  }, 60_000);

  it('flattening waits (held order) when the market is not safe, and completes once it is', async () => {
    const u = await createUser(app, 'trader');
    await md.touch();
    await place(u, { symbol: 'EURUSD', side: 'buy', type: 'market', qty: '10000' });
    await md.status({ state: 'down', feed: 'down' });
    const res = await request(http).post('/kill-switch').set(bearer(u.token)).send({ scope: 'robots_cancel_flatten' }).expect(202);
    expect(res.body.positionsFlattened).toBe(0);
    expect(res.body.flattenPending).toEqual([expect.objectContaining({ symbol: 'EURUSD', reason: expect.stringContaining('feed_not_ok') })]);
    await md.status({ state: 'ok', feed: 'up' });
    await md.touch();
    await app.get(EngineLoopService).matchSymbol('EURUSD');
    expect((await request(http).get('/positions').set(bearer(u.token)).expect(200)).body.positions).toHaveLength(0);
  });
});

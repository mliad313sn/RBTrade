import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { EngineLoopService } from '../src/trading/engine-loop.service';
import { bearer, createUser, ownerQuery, startApp, type TestUser } from './helpers';
import { MARKET_OPEN_UTC, MarketFixture } from './market-fixture';

let n = 0;
const cid = (p = 'o') => `${p}-${process.pid}-${++n}`;

describe('OMS and paper engine', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let engine: EngineLoopService;
  const md = new MarketFixture();

  beforeAll(async () => {
    process.env.KORA_ENGINE_ENABLED = 'false'; // tests drive matching explicitly
    process.env.KORA_RECONCILIATION_INTERVAL_MS = '0';
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    vi.setSystemTime(MARKET_OPEN_UTC);
    app = await startApp();
    http = app.getHttpServer();
    engine = app.get(EngineLoopService);
  });
  beforeEach(async () => {
    await md.standard();
    await md.clearDepth('EURUSD');
  });
  afterAll(async () => {
    await md.close();
    await app.close();
    vi.useRealTimers();
    delete process.env.KORA_ENGINE_ENABLED;
    delete process.env.KORA_RECONCILIATION_INTERVAL_MS;
  });

  // Logging in advances the faked clock (TOTP windows), so quotes are re-stamped before each order.
  const place = async (u: TestUser, body: object, status: number) => {
    await md.touch();
    const res = await request(http)
      .post('/orders')
      .set(bearer(u.token))
      .send({ clientOrderId: cid(), ...body });
    if (res.status !== status)
      throw new Error(`expected ${status}, got ${res.status}: ${JSON.stringify(res.body)}`);
    return res;
  };
  /** Engine events are recorded with the system actor, so read the order's trail as the owner. */
  const trail = async (orderId: string) =>
    ownerQuery<{ action: string; payload: Record<string, unknown> }>(
      `SELECT action, payload FROM audit_events WHERE entity = 'order' AND entity_id = $1 ORDER BY id`,
      [orderId],
    );
  const positions = async (u: TestUser) =>
    (await request(http).get('/positions').set(bearer(u.token)).expect(200)).body
      .positions as Array<{ symbol: string; qty: string; avgPrice: string }>;
  const order = async (u: TestUser, id: string) =>
    (await request(http).get(`/orders/${id}`).set(bearer(u.token)).expect(200)).body;

  it('the same client_order_id sent 50 times in parallel creates exactly one order', async () => {
    const u = await createUser(app, 'trader');
    const body = {
      clientOrderId: cid('idem'),
      symbol: 'EURUSD',
      side: 'buy',
      type: 'limit',
      qty: '10000',
      limitPrice: '1.08000',
    };
    await md.touch();
    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        request(http).post('/orders').set(bearer(u.token)).send(body),
      ),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 200)).toHaveLength(49);
    expect(new Set(results.map((r) => r.body.order.id)).size).toBe(1);
    expect(results.filter((r) => r.body.idempotentReplay === true)).toHaveLength(49);
    const rows = await ownerQuery<{ n: string }>(
      'SELECT count(*)::text AS n FROM orders WHERE client_order_id = $1',
      [body.clientOrderId],
    );
    expect(rows[0]!.n).toBe('1');
    const created = await ownerQuery<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_events WHERE action = 'order.new' AND payload->>'clientOrderId' = $1`,
      [body.clientOrderId],
    );
    expect(created[0]!.n).toBe('1');
    // Same key, different body → 409.
    const reused = await request(http)
      .post('/orders')
      .set(bearer(u.token))
      .send({ ...body, qty: '20000' })
      .expect(409);
    expect(reused.body.error).toBe('client_order_id_reused');
  });

  it('market order fills at the touch and stores quote at decision, fill price and slippage; state transitions are audited', async () => {
    const u = await createUser(app, 'trader');
    const res = await place(
      u,
      { symbol: 'EURUSD', side: 'buy', type: 'market', qty: '100000' },
      201,
    );
    expect(res.body.order).toMatchObject({
      status: 'filled',
      filledQty: '100000',
      avgFillPrice: '1.08421',
    });
    const fills = (await request(http).get('/fills').set(bearer(u.token)).expect(200)).body.fills;
    expect(fills[0]).toMatchObject({
      price: '1.08421',
      referencePrice: '1.08421',
      slippage: '0',
      commission: '2.17', // 108,421 × 0.2 bps = 2.16842, charged in cents
      quoteAtDecision: { bid: '1.08419', ask: '1.08421', source: 'simulated' },
      liquidity: 'taker',
    });
    expect((await trail(res.body.order.id)).map((e) => e.action)).toEqual([
      'order.new',
      'order.accepted',
      'order.working',
      'order.filled',
    ]);
    expect(await positions(u)).toEqual([
      expect.objectContaining({ symbol: 'EURUSD', qty: '100000', avgPrice: '1.08421' }),
    ]);
  });

  it('size above top-of-book depth fills partially across levels; remainder works on the next depth snapshot', async () => {
    const u = await createUser(app, 'trader');
    await md.depth(
      'EURUSD',
      [['1.08419', '100000']],
      [
        ['1.08421', '100000'],
        ['1.08423', '50000'],
      ],
    );
    const res = await place(
      u,
      { symbol: 'EURUSD', side: 'buy', type: 'market', qty: '200000' },
      201,
    );
    expect(res.body.order).toMatchObject({ status: 'partially_filled', filledQty: '150000' });
    const fills = (await request(http).get('/fills').set(bearer(u.token)).expect(200)).body.fills;
    expect(fills.map((f: { qty: string; price: string }) => [f.qty, f.price]).sort()).toEqual([
      ['100000', '1.08421'],
      ['50000', '1.08423'],
    ]);
    // Same snapshot again: liquidity already consumed, nothing more fills.
    await engine.matchSymbol('EURUSD');
    expect((await order(u, res.body.order.id)).filledQty).toBe('150000');
    await md.depth('EURUSD', [['1.08419', '100000']], [['1.08425', '100000']]);
    await md.touch();
    await engine.matchSymbol('EURUSD');
    const done = await order(u, res.body.order.id);
    expect(done).toMatchObject({ status: 'filled', filledQty: '200000' });
    await md.clearDepth('EURUSD');
  });

  it('IOC fills what it can and expires the rest; FOK is all-or-nothing', async () => {
    const u = await createUser(app, 'trader');
    await md.depth('EURUSD', [['1.08419', '10000']], [['1.08421', '10000']]);
    const ioc = await place(
      u,
      { symbol: 'EURUSD', side: 'buy', type: 'market', qty: '30000', tif: 'ioc' },
      201,
    );
    expect(ioc.body.order).toMatchObject({
      status: 'expired',
      filledQty: '10000',
      cancelReason: 'ioc_remainder',
    });
    const fok = await place(
      u,
      {
        symbol: 'EURUSD',
        side: 'buy',
        type: 'limit',
        qty: '30000',
        limitPrice: '1.08421',
        tif: 'fok',
      },
      422,
    );
    expect(fok.body).toMatchObject({ error: 'risk_rejected', code: 'FOK_INSUFFICIENT_DEPTH' });
    await md.clearDepth('EURUSD');
  });

  it('resting limit fills as maker at its limit when the market reaches it', async () => {
    const u = await createUser(app, 'trader');
    const res = await place(
      u,
      { symbol: 'EURUSD', side: 'buy', type: 'limit', qty: '10000', limitPrice: '1.08300' },
      201,
    );
    expect(res.body.order.status).toBe('working');
    await engine.matchSymbol('EURUSD');
    expect((await order(u, res.body.order.id)).status).toBe('working');
    await md.quote('EURUSD', '1.08280', '1.08290');
    await engine.matchSymbol('EURUSD');
    const o = await order(u, res.body.order.id);
    expect(o).toMatchObject({ status: 'filled', avgFillPrice: '1.083' });
    const f = (await request(http).get('/fills').set(bearer(u.token)).expect(200)).body.fills[0];
    expect(f).toMatchObject({ price: '1.083', liquidity: 'maker', slippage: '0' });
  });

  it('a stop gapped by a simulated shock fills worse than the stop and reports the slippage', async () => {
    const u = await createUser(app, 'trader');
    await place(u, { symbol: 'EURUSD', side: 'buy', type: 'market', qty: '100000' }, 201);
    const stop = await place(
      u,
      {
        symbol: 'EURUSD',
        side: 'sell',
        type: 'stop',
        qty: '100000',
        stopPrice: '1.08000',
        reduceOnly: true,
      },
      201,
    );
    expect(stop.body.order.status).toBe('working');
    // Shock: the market gaps from 1.0842 straight to 1.0750 (no prints in between).
    await md.quote('EURUSD', '1.07500', '1.07502');
    await engine.matchSymbol('EURUSD');
    const o = await order(u, stop.body.order.id);
    expect(o.status).toBe('filled');
    expect(o.triggeredAt).not.toBeNull();
    const fill = (await request(http).get('/fills').set(bearer(u.token)).expect(200)).body.fills[0];
    expect(Number(fill.price)).toBeLessThan(1.08); // test-only comparison of the returned string
    expect(fill.referencePrice).toBe('1.08');
    // Adverse slippage vs the stop: 1.08000 − 1.07500 = 0.005 plus the volatility term.
    expect(fill.slippage.startsWith('0.00')).toBe(true);
    expect(Number(fill.slippage)).toBeGreaterThanOrEqual(0.005);
    const audit = await trail(stop.body.order.id);
    expect(audit.map((e) => e.action)).toContain('order.triggered');
    expect(audit.find((e) => e.action === 'order.filled')!.payload).toMatchObject({
      referencePrice: '1.08',
      quoteBid: '1.07500',
    });
    expect(await positions(u)).toEqual([]);
  });

  it('stops trigger on the correct side of the book: a sell stop on the bid, a buy stop on the ask', async () => {
    const u = await createUser(app, 'trader');
    const buyStop = await place(
      u,
      { symbol: 'EURUSD', side: 'buy', type: 'stop', qty: '10000', stopPrice: '1.08500' },
      201,
    );
    // Bid reaches the buy stop but the ask does not: no trigger.
    await md.quote('EURUSD', '1.08495', '1.08499');
    await engine.matchSymbol('EURUSD');
    expect((await order(u, buyStop.body.order.id)).status).toBe('working');
    await md.quote('EURUSD', '1.08498', '1.08500');
    await engine.matchSymbol('EURUSD');
    expect((await order(u, buyStop.body.order.id)).status).toBe('filled');
  });

  it('bracket: target fill cancels the stop loss (and the other way round)', async () => {
    const u = await createUser(app, 'trader');
    const b = await place(
      u,
      {
        symbol: 'EURUSD',
        side: 'buy',
        type: 'bracket',
        qty: '50000',
        stopLossPrice: '1.08000',
        takeProfitPrice: '1.08800',
      },
      201,
    );
    expect(b.body.order.status).toBe('filled');
    const detail = await order(u, b.body.order.id);
    const sl = detail.children.find((c: { role: string }) => c.role === 'stop_loss');
    const tp = detail.children.find((c: { role: string }) => c.role === 'take_profit');
    expect(sl).toMatchObject({
      status: 'working',
      side: 'sell',
      qty: '50000',
      stopPrice: '1.08',
      reduceOnly: true,
    });
    expect(tp).toMatchObject({
      status: 'working',
      side: 'sell',
      qty: '50000',
      limitPrice: '1.088',
    });
    expect(sl.ocoGroup).toBe(tp.ocoGroup);
    await md.quote('EURUSD', '1.08810', '1.08812');
    await engine.matchSymbol('EURUSD');
    const after = await order(u, b.body.order.id);
    expect(after.children.find((c: { role: string }) => c.role === 'take_profit').status).toBe(
      'filled',
    );
    expect(after.children.find((c: { role: string }) => c.role === 'stop_loss')).toMatchObject({
      status: 'cancelled',
      cancelReason: 'oco_sibling_filled',
    });
    expect(await positions(u)).toEqual([]);

    // Stop side: a new bracket whose stop is hit cancels its target.
    await md.standard();
    const b2 = await place(
      u,
      {
        symbol: 'EURUSD',
        side: 'sell',
        type: 'bracket',
        qty: '20000',
        stopLossPrice: '1.08600',
        takeProfitPrice: '1.08000',
      },
      201,
    );
    await md.quote('EURUSD', '1.08620', '1.08622');
    await engine.matchSymbol('EURUSD');
    const d2 = await order(u, b2.body.order.id);
    expect(d2.children.find((c: { role: string }) => c.role === 'stop_loss').status).toBe('filled');
    expect(d2.children.find((c: { role: string }) => c.role === 'take_profit')).toMatchObject({
      status: 'cancelled',
    });
  });

  it('OCO: one leg filling cancels the other; the group mirrors the result', async () => {
    const u = await createUser(app, 'trader');
    const res = await place(
      u,
      {
        symbol: 'EURUSD',
        side: 'buy',
        type: 'oco',
        qty: '10000',
        legs: [
          { type: 'limit', limitPrice: '1.08200' },
          { type: 'stop', stopPrice: '1.08600' },
        ],
      },
      201,
    );
    expect(res.body.legs).toHaveLength(2);
    expect(res.body.order).toMatchObject({ execType: 'none', status: 'working' });
    await md.quote('EURUSD', '1.08610', '1.08612');
    await engine.matchSymbol('EURUSD');
    const g = await order(u, res.body.order.id);
    expect(g.status).toBe('filled');
    const [a, b] = [
      g.children.find((c: { execType: string }) => c.execType === 'limit'),
      g.children.find((c: { execType: string }) => c.execType === 'stop'),
    ];
    expect(b.status).toBe('filled');
    expect(a).toMatchObject({ status: 'cancelled', cancelReason: 'oco_sibling_filled' });

    // Cancelling the group cancels both legs.
    await md.standard();
    const g2 = await place(
      u,
      {
        symbol: 'EURUSD',
        side: 'sell',
        type: 'oco',
        qty: '10000',
        legs: [
          { type: 'limit', limitPrice: '1.08700' },
          { type: 'stop', stopPrice: '1.08100' },
        ],
      },
      201,
    );
    await request(http).delete(`/orders/${g2.body.order.id}`).set(bearer(u.token)).expect(200);
    const c2 = await order(u, g2.body.order.id);
    expect(c2.status).toBe('cancelled');
    expect(c2.children.every((c: { status: string }) => c.status === 'cancelled')).toBe(true);
  });

  it('trailing stop follows the best bid and fires on a pullback', async () => {
    const u = await createUser(app, 'trader');
    await place(u, { symbol: 'EURUSD', side: 'buy', type: 'market', qty: '10000' }, 201);
    const t = await place(
      u,
      {
        symbol: 'EURUSD',
        side: 'sell',
        type: 'trailing',
        qty: '10000',
        trailAmount: '0.00100',
        reduceOnly: true,
      },
      201,
    );
    expect((await order(u, t.body.order.id)).stopPrice).toBe('1.08319');
    await md.quote('EURUSD', '1.08600', '1.08602');
    await engine.matchSymbol('EURUSD');
    expect((await order(u, t.body.order.id)).stopPrice).toBe('1.085');
    await md.quote('EURUSD', '1.08550', '1.08552');
    await engine.matchSymbol('EURUSD');
    expect((await order(u, t.body.order.id)).status).toBe('working');
    await md.quote('EURUSD', '1.08490', '1.08492');
    await engine.matchSymbol('EURUSD');
    expect((await order(u, t.body.order.id)).status).toBe('filled');
  });

  it('amend and cancel are audited; terminal orders cannot be changed', async () => {
    const u = await createUser(app, 'trader');
    const res = await place(
      u,
      { symbol: 'EURUSD', side: 'buy', type: 'limit', qty: '10000', limitPrice: '1.08000' },
      201,
    );
    const id = res.body.order.id;
    const a = await request(http)
      .patch(`/orders/${id}`)
      .set(bearer(u.token))
      .send({ qty: '20000', limitPrice: '1.08100' })
      .expect(200);
    expect(a.body).toMatchObject({ qty: '20000', limitPrice: '1.081', status: 'working' });
    await request(http)
      .patch(`/orders/${id}`)
      .set(bearer(u.token))
      .send({ limitPrice: '1.20000' })
      .expect(422);
    await request(http)
      .patch(`/orders/${id}`)
      .set(bearer(u.token))
      .send({ stopPrice: '1.08000' })
      .expect(400);
    await request(http)
      .patch(`/orders/${id}`)
      .set(bearer(u.token))
      .send({ limitPrice: '1.080005' })
      .expect(400);
    const c = await request(http).delete(`/orders/${id}`).set(bearer(u.token)).expect(200);
    expect(c.body).toMatchObject({ status: 'cancelled', cancelReason: 'user_requested' });
    await request(http).delete(`/orders/${id}`).set(bearer(u.token)).expect(409);
    await request(http)
      .patch(`/orders/${id}`)
      .set(bearer(u.token))
      .send({ qty: '30000' })
      .expect(409);
    const actions = (
      await request(http).get(`/audit?entity=order&entityId=${id}`).set(bearer(u.token)).expect(200)
    ).body.events.map((e: { action: string }) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['order.amended', 'order.cancelled']));
    // Other users cannot see or touch it.
    const other = await createUser(app, 'trader');
    await request(http).get(`/orders/${id}`).set(bearer(other.token)).expect(404);
    await request(http).delete(`/orders/${id}`).set(bearer(other.token)).expect(404);
  });

  it('validates quantities and prices against the registry grid', async () => {
    const u = await createUser(app, 'trader');
    const q = await place(u, { symbol: 'EURUSD', side: 'buy', type: 'market', qty: '1500' }, 400);
    expect(q.body).toMatchObject({
      error: 'invalid_order',
      message: expect.stringContaining('multiple of 1000'),
    });
    const p = await place(
      u,
      { symbol: 'AAPL', side: 'buy', type: 'limit', qty: '1', limitPrice: '220.005' },
      400,
    );
    expect(p.body.message).toContain('steps of 0.01');
    await place(u, { symbol: 'NOPE', side: 'buy', type: 'market', qty: '1' }, 404);
    await place(
      u,
      {
        symbol: 'EURUSD',
        side: 'buy',
        type: 'market',
        qty: '1000',
        source: 'robot:0b3c9a4e-1f2d-4c5b-9a8e-7d6c5b4a3f21',
      },
      400,
    );
  });

  it('DAY and GTD orders expire; reduce-only never flips a position', async () => {
    const u = await createUser(app, 'trader');
    const gtd = await place(
      u,
      {
        symbol: 'EURUSD',
        side: 'buy',
        type: 'limit',
        qty: '10000',
        limitPrice: '1.08000',
        tif: 'gtd',
        expireAt: new Date(Date.now() + 60_000).toISOString(),
      },
      201,
    );
    const day = await place(
      u,
      {
        symbol: 'EURUSD',
        side: 'buy',
        type: 'limit',
        qty: '10000',
        limitPrice: '1.08000',
        tif: 'day',
      },
      201,
    );
    expect(day.body.order.expireAt).not.toBeNull();
    expect(await engine.expireDue(Date.now())).toBe(0);
    expect(await engine.expireDue(Date.now() + 61_000)).toBe(1);
    expect((await order(u, gtd.body.order.id)).status).toBe('expired');
    expect(await engine.expireDue(Date.parse(day.body.order.expireAt) + 1)).toBe(1);
    expect((await order(u, day.body.order.id)).status).toBe('expired');

    const ro = await place(
      u,
      { symbol: 'EURUSD', side: 'sell', type: 'market', qty: '10000', reduceOnly: true },
      422,
    );
    expect(ro.body.code).toBe('REDUCE_ONLY_WOULD_INCREASE');
    await place(u, { symbol: 'EURUSD', side: 'buy', type: 'market', qty: '10000' }, 201);
    const big = await place(
      u,
      {
        symbol: 'EURUSD',
        side: 'sell',
        type: 'limit',
        qty: '30000',
        limitPrice: '1.08500',
        reduceOnly: true,
      },
      201,
    );
    expect(big.body.order.qty).toBe('30000');
    await md.quote('EURUSD', '1.08510', '1.08512');
    await engine.matchSymbol('EURUSD');
    const o = await order(u, big.body.order.id);
    expect(o.filledQty).toBe('10000');
    expect(await positions(u)).toEqual([]);
  });

  it('positions, cash and the ledger agree after a round trip (trial balance zero)', async () => {
    const u = await createUser(app, 'trader');
    await place(u, { symbol: 'XAUUSD', side: 'buy', type: 'market', qty: '10' }, 201);
    await md.quote('XAUUSD', '2405.30', '2405.50');
    await request(http).post('/positions/XAUUSD/close').set(bearer(u.token)).expect(201);
    const ledger = (await request(http).get('/accounts/me/ledger').set(bearer(u.token)).expect(200))
      .body;
    expect(ledger.trialBalance).toBe('0');
    // The mid jumped 10.00, so the volatility term (vol factor 0.1) adds 1.00 against the seller:
    // exit 2405.30 − 1.00 = 2404.30. Realised (2404.30 − 2395.50) × 10 = 88.00.
    // Commissions (1 bp): 23,955.00 → 2.40 and 24,043.00 → 2.40.
    const exit = (await request(http).get('/fills').set(bearer(u.token)).expect(200)).body.fills[0];
    expect(exit).toMatchObject({ price: '2404.3', slippage: '1', referencePrice: '2405.3' });
    expect(ledger.balances.pnl).toBe('-88');
    expect(ledger.balances.fees).toBe('4.8');
    const acct = (await request(http).get('/accounts/me').set(bearer(u.token)).expect(200)).body;
    expect(acct).toMatchObject({
      cash: '100083.20',
      equity: '100083.20',
      marginUsed: '0.00',
      openPositions: 0,
      simulated: true,
      environment: 'PAPER',
    });
  });
});

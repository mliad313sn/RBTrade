import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { EngineLoopService } from '../src/trading/engine-loop.service';
import { bearer, createUser, login, ownerQuery, startApp, type TestUser } from './helpers';
import { MARKET_OPEN_UTC, MarketFixture, marketDay, SEED_EFFECTIVE_UTC } from './market-fixture';

let n = 0;
const cid = () => `r6-${process.pid}-${++n}`;

/**
 * IRTC R6 regressions (test integrity): each test here kills a mutant that survived the whole suite
 * before (R6-03 FS-2, R6-04 RISK-5, R6-05 RISK-9, R6-08 RISK-8, R6-11 FS-7).
 */
describe('IRTC R6 regressions (risk wiring and fill safety)', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  const md = new MarketFixture();

  beforeAll(async () => {
    process.env.KORA_ENGINE_ENABLED = 'false';
    process.env.KORA_RECONCILIATION_INTERVAL_MS = '0';
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    vi.setSystemTime(MARKET_OPEN_UTC);
    app = await startApp();
    http = app.getHttpServer();
  });
  beforeEach(async () => {
    vi.setSystemTime(MARKET_OPEN_UTC);
    await md.standard();
  });
  afterAll(async () => {
    await md.close();
    await app.close();
    vi.useRealTimers();
    delete process.env.KORA_ENGINE_ENABLED;
    delete process.env.KORA_RECONCILIATION_INTERVAL_MS;
  });

  const send = async (u: TestUser, body: object) => {
    await md.touch();
    return request(http)
      .post('/orders')
      .set(bearer(u.token))
      .send({ clientOrderId: cid(), ...body });
  };
  const placed = async (u: TestUser, body: object) => {
    const res = await send(u, body);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.order as { id: string; status: string };
  };
  const codes = async (u: TestUser, body: object): Promise<string[]> => {
    const res = await send(u, body);
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    return (res.body.violations as Array<{ code: string }>).map((v) => v.code);
  };
  /** Jumps the clock (days later the access token has expired, so sign in again). */
  const jump = async (u: TestUser, to: Date) => {
    vi.setSystemTime(to);
    u.token = (await login(app, u.email, u.secret)).token;
    await md.standard();
  };
  const settings = (u: TestUser, riskLimits: Record<string, unknown>) =>
    request(http)
      .put('/accounts/me/settings')
      .set(bearer(u.token))
      .send({ riskLimits })
      .expect(200);

  it('flake "density persist": concurrent partial preference saves all land (row lock, no lost update)', async () => {
    const u = await createUser(app, 'trader');
    const patches = [
      { terminal: { density: 'comfortable' } },
      { terminal: { timeDisplay: 'local' } },
      { terminal: { soundOnFills: true } },
      { terminal: { perTradeRiskPct: '0.5' } },
      { theme: 'pro-dark' },
      { colourConvention: 'green_red' },
      { hotkeys: { ticketSell: 'Alt+S' } },
    ];
    await Promise.all(
      patches.map((p) =>
        request(http).put('/me/preferences').set(bearer(u.token)).send(p).expect(200),
      ),
    );
    const prefs = (await request(http).get('/me/preferences').set(bearer(u.token)).expect(200))
      .body;
    expect(prefs).toMatchObject({
      theme: 'pro-dark',
      colourConvention: 'green_red',
      hotkeys: { ticketSell: 'Alt+S' },
      terminal: {
        density: 'comfortable',
        timeDisplay: 'local',
        soundOnFills: true,
        perTradeRiskPct: '0.5',
      },
    });
  });

  it('R6-15: the scenario anchor is a Wednesday after the seeded legal content, and derived dates follow it', async () => {
    expect(MARKET_OPEN_UTC.getUTCDay()).toBe(3);
    expect(MARKET_OPEN_UTC.getTime()).toBeGreaterThan(SEED_EFFECTIVE_UTC.getTime());
    const seeds = await ownerQuery<{ t: Date }>(
      'SELECT min(effective_from) AS t FROM disclosure_documents',
    );
    expect(seeds[0]!.t.getTime()).toBe(SEED_EFFECTIVE_UTC.getTime());
    // Scenarios that start earliest (marketDay(-2), the Monday) still fall after the seeds.
    expect(marketDay(-2).getTime()).toBeGreaterThan(SEED_EFFECTIVE_UTC.getTime());
    expect([marketDay(-2).getUTCDay(), marketDay(2).getUTCDay(), marketDay(3).getUTCDay()]).toEqual(
      [1, 5, 6],
    );
  });

  it('R6-03: a scope-3 kill switch in a closed session holds the flatten order (never fills at a stale close)', async () => {
    vi.setSystemTime(marketDay(2, '19:50:00')); // Friday 15:50 New York: AAPL open
    const u = await createUser(app, 'trader');
    await md.standard();
    expect(
      (await placed(u, { symbol: 'AAPL', side: 'buy', type: 'market', qty: '10' })).status,
    ).toBe('filled');
    vi.setSystemTime(marketDay(2, '20:10:00')); // Friday 16:10 New York: AAPL closed
    await md.standard(); // fresh quotes and a healthy feed: only the session is unsafe
    const res = await request(http)
      .post('/kill-switch')
      .set(bearer(u.token))
      .send({ scope: 'robots_cancel_flatten' })
      .expect(202);
    expect(res.body.positionsFlattened).toBe(0);
    expect(res.body.flattenPending).toEqual([
      expect.objectContaining({ symbol: 'AAPL', reason: expect.stringContaining('session') }),
    ]);
    // The invariant, stated on the data: the position is untouched and the flatten order rests unfilled.
    const pos = await request(http).get('/positions').set(bearer(u.token)).expect(200);
    expect(pos.body.positions ?? pos.body).toEqual([
      expect.objectContaining({ symbol: 'AAPL', qty: '10' }),
    ]);
    const held = await request(http)
      .get(`/orders/${res.body.flattenPending[0].orderId}`)
      .set(bearer(u.token))
      .expect(200);
    expect(held.body).toMatchObject({ status: 'working', filledQty: '0' });
    const fills = await ownerQuery('SELECT 1 FROM fills WHERE order_id = $1', [
      res.body.flattenPending[0].orderId,
    ]);
    expect(fills).toHaveLength(0);
  });

  it('R6-04: the orders-per-minute window is one minute long (an order 59 s old still counts, 61 s old does not)', async () => {
    const u = await createUser(app, 'trader');
    await settings(u, { maxOrdersPerMinute: 3 });
    const body = {
      symbol: 'EURUSD',
      side: 'buy',
      type: 'limit',
      qty: '1000',
      limitPrice: '1.08000',
    };
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await placed(u, body)).id);
    // The window is evaluated on the database clock; age the three orders instead of sleeping.
    const age = (s: number) =>
      ownerQuery(
        `UPDATE orders SET created_at = clock_timestamp() - make_interval(secs => $2) WHERE id = ANY($1::uuid[])`,
        [ids, s],
      );
    await age(59);
    expect(await codes(u, body)).toContain('ORDER_RATE_LIMIT');
    await age(61);
    await placed(u, body);
  });

  it('R6-05: the weekly loss limit sees a loss booked on an earlier day of the same week (the daily limit does not)', async () => {
    vi.setSystemTime(marketDay(-2)); // Monday of the same ISO week as MARKET_OPEN_UTC
    const u = await createUser(app, 'trader');
    await md.standard();
    await request(http).get('/accounts/me').set(bearer(u.token)).expect(200); // Monday day/week/month start equity
    await placed(u, { symbol: 'EURUSD', side: 'buy', type: 'market', qty: '100000' });
    await md.quote('EURUSD', '1.08119', '1.08121'); // about −300 USD
    await placed(u, { symbol: 'EURUSD', side: 'sell', type: 'market', qty: '100000' });

    await jump(u, MARKET_OPEN_UTC); // Wednesday
    const acct = await request(http).get('/accounts/me').set(bearer(u.token)).expect(200);
    expect(Number(acct.body.dayPnl.replace(/,/g, ''))).toBe(0);
    expect(Number(acct.body.weekPnl.replace(/,/g, ''))).toBeLessThan(-250);
    await settings(u, { dailyLossLimit: '100', weeklyLossLimit: '200' });
    const c = await codes(u, { symbol: 'EURUSD', side: 'buy', type: 'market', qty: '1000' });
    expect(c).toContain('WEEKLY_LOSS_LIMIT');
    expect(c).not.toContain('DAILY_LOSS_LIMIT');
  });

  it('R6-05: the monthly loss limit sees a loss booked in an earlier week of the same month', async () => {
    // The Monday after the anchor week, then the Wednesday two weeks after the anchor: an earlier
    // week of the same month, both after the seeded legal content (SEED_EFFECTIVE_UTC).
    vi.setSystemTime(marketDay(5));
    const u = await createUser(app, 'trader');
    await md.standard();
    await request(http).get('/accounts/me').set(bearer(u.token)).expect(200);
    await placed(u, { symbol: 'EURUSD', side: 'buy', type: 'market', qty: '100000' });
    await md.quote('EURUSD', '1.08119', '1.08121');
    await placed(u, { symbol: 'EURUSD', side: 'sell', type: 'market', qty: '100000' });

    await jump(u, marketDay(14));
    const acct = await request(http).get('/accounts/me').set(bearer(u.token)).expect(200);
    expect(Number(acct.body.weekPnl.replace(/,/g, ''))).toBe(0);
    await settings(u, { dailyLossLimit: '100', weeklyLossLimit: '100', monthlyLossLimit: '200' });
    const c = await codes(u, { symbol: 'EURUSD', side: 'buy', type: 'market', qty: '1000' });
    expect(c).toContain('MONTHLY_LOSS_LIMIT');
    expect(c).not.toContain('WEEKLY_LOSS_LIMIT');
    expect(c).not.toContain('DAILY_LOSS_LIMIT');
  });

  it('R6-08: the fat-finger band applies to stop-loss and take-profit prices, not only limit prices', async () => {
    const u = await createUser(app, 'trader');
    // 20 % away from a 1.0842 market (the FX band is 1 %).
    expect(
      await codes(u, {
        symbol: 'EURUSD',
        side: 'buy',
        type: 'market',
        qty: '1000',
        stopLossPrice: '0.86700',
      }),
    ).toContain('FAT_FINGER');
    expect(
      await codes(u, {
        symbol: 'EURUSD',
        side: 'buy',
        type: 'market',
        qty: '1000',
        takeProfitPrice: '1.30100',
      }),
    ).toContain('FAT_FINGER');
    // Inside the band both are accepted.
    await placed(u, {
      symbol: 'EURUSD',
      side: 'buy',
      type: 'market',
      qty: '1000',
      stopLossPrice: '1.08000',
      takeProfitPrice: '1.08900',
    });
  });

  it('R6-11: a symbol listed stale in the feed status is unsafe even when its quote is fresh and unflagged', async () => {
    const u = await createUser(app, 'trader');
    const resting = await placed(u, {
      symbol: 'EURUSD',
      side: 'buy',
      type: 'limit',
      qty: '1000',
      limitPrice: '1.08300',
    });
    await md.status({ staleSymbols: ['EURUSD'] });
    await md.quote('EURUSD', '1.08280', '1.08290', { stale: false });
    const res = await request(http)
      .post('/orders')
      .set(bearer(u.token))
      .send({ clientOrderId: cid(), symbol: 'EURUSD', side: 'buy', type: 'market', qty: '1000' });
    expect(res.status).toBe(422);
    expect(res.body.violations.map((v: { code: string }) => v.code)).toContain('MARKET_DATA_STALE');
    await app.get(EngineLoopService).matchSymbol('EURUSD');
    expect(
      (await request(http).get(`/orders/${resting.id}`).set(bearer(u.token)).expect(200)).body
        .status,
    ).toBe('working');
    // Cleared: the held order fills on the next pass.
    await md.status({ staleSymbols: [] });
    await md.quote('EURUSD', '1.08280', '1.08290');
    await app.get(EngineLoopService).matchSymbol('EURUSD');
    expect(
      (await request(http).get(`/orders/${resting.id}`).set(bearer(u.token)).expect(200)).body
        .status,
    ).toBe('filled');
  });
});

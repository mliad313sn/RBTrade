import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bearer, createUser, startApp, type TestUser } from './helpers';
import { MarketFixture } from './market-fixture';
import { listen, TestWs } from './ws-helpers';

let n = 0;
const cid = () => `rt-${process.pid}-${++n}`;

/**
 * Real clock, engine loop ON: the matching loop reacts to quotes on the Redis bus, and trading
 * events reach the private WebSocket channels orders/positions/account:{accountId}. BTC/USD is used
 * because crypto trades 24/7 (this test runs at any time of the week).
 */
describe('matching loop and private trading channels', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let url: string;
  let u: TestUser;
  let accountId: string;
  const md = new MarketFixture();

  beforeAll(async () => {
    process.env.KORA_ENGINE_ENABLED = 'true';
    process.env.KORA_ENGINE_SWEEP_MS = '200';
    process.env.KORA_RECONCILIATION_INTERVAL_MS = '0';
    app = await startApp();
    http = app.getHttpServer();
    url = (await listen(app)).ws;
    u = await createUser(app, 'trader', [], { realClock: true });
    await md.standard();
    accountId = (await request(http).get('/accounts/me').set(bearer(u.token)).expect(200)).body.id;
  });
  afterAll(async () => {
    await md.close();
    await app.close();
    delete process.env.KORA_ENGINE_ENABLED;
    delete process.env.KORA_ENGINE_SWEEP_MS;
    delete process.env.KORA_RECONCILIATION_INTERVAL_MS;
  });

  it('orders:{account} streams every state change (never conflated); positions and account follow', async () => {
    const ws = await TestWs.authed(url, u.token, [
      `orders:${accountId}`,
      `positions:${accountId}`,
      `account:${accountId}`,
    ]);
    await md.touch();
    const placed = await request(http)
      .post('/orders')
      .set(bearer(u.token))
      .send({
        clientOrderId: cid(),
        symbol: 'BTCUSD',
        side: 'buy',
        type: 'limit',
        qty: '0.01',
        limitPrice: '64500.0',
      })
      .expect(201);
    const id = placed.body.order.id as string;
    const working = await ws.waitFor(
      (m) =>
        m.ch === `orders:${accountId}` &&
        m.data.orders.some(
          (o: { id: string; status: string }) => o.id === id && o.status === 'working',
        ),
    );
    expect(working.msg.data).toMatchObject({ type: 'orders', accountId });

    // The loop is subscribed to BTCUSD quotes on the bus: a print through the limit fills it.
    await new Promise((r) => setTimeout(r, 400)); // let the sweep subscribe
    await md.status();
    await md.quote('BTCUSD', '64480.0', '64490.0');
    const filled = await ws.waitFor(
      (m) =>
        m.ch === `orders:${accountId}` &&
        m.data.orders.some(
          (o: { id: string; status: string }) => o.id === id && o.status === 'filled',
        ),
      5000,
    );
    expect(filled.msg.data.orders.find((o: { id: string }) => o.id === id)).toMatchObject({
      filledQty: '0.01',
      avgFillPrice: '64500',
    });
    const pos = await ws.waitFor(
      (m) => m.ch === `positions:${accountId}` && m.data.positions.length === 1,
      5000,
    );
    expect(pos.msg.data.positions[0]).toMatchObject({
      symbol: 'BTCUSD',
      qty: '0.01',
      avgPrice: '64500',
    });
    const acct = await ws.waitFor(
      (m) => m.ch === `account:${accountId}` && m.data.account.openPositions === 1,
      5000,
    );
    expect(acct.msg.data.account).toMatchObject({
      id: accountId,
      baseCurrency: 'USD',
      simulated: true,
    });
    ws.ws.close();
  });

  it("other users cannot subscribe to someone else's account channels", async () => {
    const other = await createUser(app, 'trader', [], { realClock: true });
    const ws = await TestWs.authed(url, other.token);
    ws.send({
      op: 'subscribe',
      channels: [`orders:${accountId}`, `account:${accountId}`, 'orders:not-a-uuid'],
      id: 'x',
    });
    const r = await ws.waitFor((m) => m.type === 'subscribed' && m.id === 'x');
    expect(r.msg.channels).toEqual([]);
    expect(r.msg.rejected).toEqual([
      { channel: `orders:${accountId}`, code: 'forbidden' },
      { channel: `account:${accountId}`, code: 'forbidden' },
      { channel: 'orders:not-a-uuid', code: 'invalid_channel' },
    ]);
    const risk = await createUser(app, 'trader', ['risk_officer'], { realClock: true });
    const rw = await TestWs.authed(url, risk.token);
    rw.send({ op: 'subscribe', channels: [`orders:${accountId}`], id: 'y' });
    expect((await rw.waitFor((m) => m.type === 'subscribed' && m.id === 'y')).msg.channels).toEqual(
      [`orders:${accountId}`],
    );
    ws.ws.close();
    rw.ws.close();
  });
});

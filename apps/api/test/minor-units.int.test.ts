import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { bearer, createUser, startApp, type TestUser } from './helpers';
import { MARKET_OPEN_UTC, MarketFixture } from './market-fixture';

/**
 * B-202: instruments quoted in a currency's minor unit. HSBA.XLON quotes in pence (GBX): prices and
 * ticks are pence, notional / fees / P&L are pounds (GBP), converted to the account's base currency.
 */
describe('minor-unit quotes (B-202)', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  const md = new MarketFixture();
  let trader: TestUser;

  beforeAll(async () => {
    process.env.KORA_ENGINE_ENABLED = 'false';
    process.env.KORA_RECONCILIATION_INTERVAL_MS = '0';
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    vi.setSystemTime(MARKET_OPEN_UTC);
    app = await startApp();
    http = app.getHttpServer();
    await md.standard();
    await md.quote('HSBA.XLON', '684.0', '684.2');
    trader = await createUser(app, 'trader');
  });
  afterAll(async () => {
    await md.close();
    await app.close();
    vi.useRealTimers();
    delete process.env.KORA_ENGINE_ENABLED;
    delete process.env.KORA_RECONCILIATION_INTERVAL_MS;
  });

  it('the registry exposes the unit and factor', async () => {
    const res = await request(http)
      .get('/instruments/HSBA.XLON')
      .set(bearer(trader.token))
      .expect(200);
    const hsba = res.body.instrument ?? res.body;
    expect(hsba).toMatchObject({
      quoteCcy: 'GBP',
      priceUnit: 'GBX',
      priceUnitFactor: '0.01',
      tickSize: '0.1',
      pricePrecision: 1,
    });
  });

  it('preview and fill: 1,000 shares at 684.2p are worth 6,842 GBP, not 684,200', async () => {
    await md.touch();
    const p = await request(http)
      .post('/orders/preview')
      .set(bearer(trader.token))
      .send({ symbol: 'HSBA.XLON', side: 'buy', type: 'market', qty: '1000' })
      .expect(200);
    expect(p.body.instrument).toMatchObject({
      quoteCcy: 'GBP',
      multiplier: '0.01',
      tickSize: '0.1',
    });
    expect(p.body.preview.notional).toMatchObject({ quoteCcy: 'GBP', quote: '6842.00' });
    // Converted to the USD account at the GBP/USD mid (1.26412): about 8,649 USD.
    expect(Number(p.body.preview.notional.base)).toBeGreaterThan(8600);
    expect(Number(p.body.preview.notional.base)).toBeLessThan(8700);
    expect(p.body.risk.ok).toBe(true);
    const o = await request(http)
      .post('/orders')
      .set(bearer(trader.token))
      .send({
        clientOrderId: `mu-${process.pid}`,
        symbol: 'HSBA.XLON',
        side: 'buy',
        type: 'market',
        qty: '1000',
      })
      .expect(201);
    expect(o.body.order.status).toBe('filled');
    const pos = (await request(http).get('/positions').set(bearer(trader.token)).expect(200)).body
      .positions[0];
    expect(pos).toMatchObject({ symbol: 'HSBA.XLON', avgPrice: '684.2', quoteCcy: 'GBP' });
    expect(Number(pos.notional)).toBeLessThan(8700);
  });
});

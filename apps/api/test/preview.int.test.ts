import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { bearer, createUser, startApp } from './helpers';
import { MARKET_OPEN_UTC, MarketFixture } from './market-fixture';

/**
 * Goal 03 acceptance: "The preview numbers match a hand-computed fixture for EUR/USD, XAU/USD,
 * BTC/USD and one equity." Same arithmetic as packages/domain/src/trading/preview.test.ts, here
 * end to end through POST /orders/preview with registry fee schedules and margin rates.
 */
describe('POST /orders/preview (hand-computed fixtures)', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let token: string;
  const md = new MarketFixture();

  beforeAll(async () => {
    process.env.KORA_ENGINE_ENABLED = 'false';
    process.env.KORA_RECONCILIATION_INTERVAL_MS = '0';
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    vi.setSystemTime(MARKET_OPEN_UTC);
    app = await startApp();
    http = app.getHttpServer();
    token = (await createUser(app, 'trader')).token;
  });
  beforeEach(async () => md.standard());
  afterAll(async () => {
    await md.close();
    await app.close();
    vi.useRealTimers();
    delete process.env.KORA_ENGINE_ENABLED;
    delete process.env.KORA_RECONCILIATION_INTERVAL_MS;
  });

  const preview = async (body: object) => (await request(http).post('/orders/preview').set(bearer(token)).send(body).expect(200)).body;

  it('EUR/USD buy 100,000: fees 3.17, margin 3,610.42, loss 204.33 (0.20%), 1:2.00', async () => {
    const r = await preview({ symbol: 'EURUSD', side: 'buy', type: 'market', qty: '100000', stopLossPrice: '1.08221', takeProfitPrice: '1.08821' });
    expect(r.instrument).toMatchObject({ assetClass: 'fx', quoteCcy: 'USD', multiplier: '1', feeScheduleId: 'sim-fx', feesSimulated: true });
    expect(r.preview).toMatchObject({
      estimatedPrice: '1.08421',
      currency: 'USD',
      notional: { quote: '108421.00', quoteCcy: 'USD', base: '108421.00' },
      fees: { commission: '2.17', spread: '1.00', fxConversion: '0.00', total: '3.17' },
      margin: { rate: '0.0333', required: '3610.42', usedAfter: '3610.42', freeAfter: '96386.41', equity: '100000.00' },
      lossIfStopHit: { stopPrice: '1.08221', price: '200.00', costs: '4.33', total: '204.33', pctEquity: '0.20' },
      rewardIfTargetHit: { targetPrice: '1.08821', amount: '400.00' },
      rewardRisk: '2.00',
      fx: null,
      confirmation: { required: true },
    });
    expect(r.risk).toEqual({ ok: true, violations: [] });
    expect(r.market).toMatchObject({ session: 'open', dataState: 'ok' });
    expect(r.timings.riskMs).toBeLessThan(5);
  });

  it('XAU/USD sell 10 oz', async () => {
    const r = await preview({ symbol: 'XAUUSD', side: 'sell', type: 'market', qty: '10', stopLossPrice: '2405.30', takeProfitPrice: '2375.30' });
    expect(r.preview).toMatchObject({
      notional: { base: '23953.00' },
      fees: { commission: '2.40', spread: '1.00', total: '3.40' },
      margin: { required: '1197.65', freeAfter: '98798.95' },
      lossIfStopHit: { price: '100.00', costs: '4.81', total: '104.81', pctEquity: '0.10' },
      rewardRisk: '2.00',
    });
  });

  it('BTC/USD buy 0.5', async () => {
    const r = await preview({ symbol: 'BTCUSD', side: 'buy', type: 'market', qty: '0.5', stopLossPrice: '63813.5', takeProfitPrice: '66813.5' });
    expect(r.preview).toMatchObject({
      notional: { base: '32406.75' },
      fees: { commission: '32.41', spread: '0.50', total: '32.91' },
      margin: { required: '16203.38', freeAfter: '83763.72' },
      lossIfStopHit: { price: '500.00', costs: '64.32', total: '564.32', pctEquity: '0.56' },
      rewardRisk: '2.00',
    });
  });

  it('equity AAPL buy 100 (per-share commission, 1.00 minimum)', async () => {
    const r = await preview({ symbol: 'AAPL', side: 'buy', type: 'market', qty: '100', stopLossPrice: '216.38', takeProfitPrice: '231.38' });
    expect(r.preview).toMatchObject({
      notional: { base: '22138.00' },
      fees: { commission: '1.00', spread: '1.00', total: '2.00' },
      margin: { required: '4427.60', freeAfter: '95570.40' },
      lossIfStopHit: { price: '500.00', costs: '2.00', total: '502.00', pctEquity: '0.50' },
      rewardRisk: '2.00',
    });
  });

  it('SAP (EUR) in a USD account: converted at the live EUR/USD mid with the conversion cost shown', async () => {
    const r = await preview({ symbol: 'SAP.XETR', side: 'buy', type: 'market', qty: '50' });
    expect(r.instrument).toMatchObject({ quoteCcy: 'EUR', feeScheduleId: 'sim-equity-xetr' });
    // EUR/USD mid (1.08419 + 1.08421) / 2 = 1.0842
    expect(r.preview).toMatchObject({
      notional: { quote: '10121.00', quoteCcy: 'EUR', base: '10973.19' },
      fees: { commission: '5.49', spread: '1.08', fxConversion: '0.01', total: '6.58' },
      margin: { required: '2194.64' },
      fx: { from: 'EUR', to: 'USD', rate: '1.0842', conversionBps: '25', conversionCost: '0.01' },
    });
  });

  it('a JPY account converts USD instruments through the inverse USD/JPY pair', async () => {
    const jpy = await createUser(app, 'trader');
    await request(http).put('/accounts/me/settings').set(bearer(jpy.token)).send({ baseCurrency: 'JPY' }).expect(200);
    await md.standard();
    const r = (await request(http).post('/orders/preview').set(bearer(jpy.token)).send({ symbol: 'AAPL', side: 'buy', type: 'market', qty: '100' }).expect(200)).body;
    // 22,138 USD × 148.215 (USD/JPY mid) = 3,281,183.67 → JPY has no minor unit
    expect(r.preview.notional).toEqual({ quote: '22138.00', quoteCcy: 'USD', base: '3281184' });
    expect(r.preview.fx).toMatchObject({ from: 'USD', to: 'JPY', rate: '148.215' });
  });

  it('reports risk violations without persisting anything', async () => {
    const r = await preview({ symbol: 'EURUSD', side: 'buy', type: 'limit', qty: '100000', limitPrice: '1.20000' });
    expect(r.risk.ok).toBe(false);
    expect(r.risk.violations[0]).toMatchObject({ code: 'FAT_FINGER', message: expect.stringContaining('away from the market') });
    const orders = await request(http).get('/orders?status=all').set(bearer(token)).expect(200);
    expect(orders.body.orders).toHaveLength(0);
  });
});

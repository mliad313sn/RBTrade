import type { INestApplication } from '@nestjs/common';
import { dec, noviceLossFigures } from '@kora/domain';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { bearer, createUser, startApp, type TestUser } from './helpers';
import { MARKET_OPEN_UTC, MarketFixture } from './market-fixture';

/** Seeded PRNG (mulberry32) so the 20 "random" cases are reproducible. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SYMBOLS = [
  'EURUSD',
  'XAUUSD',
  'AAPL',
  'BTCUSD',
  'SPY',
  'KGEF',
  'SAP.XETR',
  '7203.XTKS',
  'BHP.XASX',
  'NPN.XJSE',
];

/**
 * Goal 08 acceptance 2: "Most you could lose" equals the /orders/preview value, fees included, for 20
 * randomised cases. The ticket builds the order; the same order through /orders/preview must give
 * the same loss-at-stop, `total = price + costs` with costs > 0, and the web's display helper shows
 * exactly that `total`.
 */
describe('novice ticket: most you could lose = preview incl. fees (20 randomised cases)', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let nov: TestUser;
  const md = new MarketFixture();

  beforeAll(async () => {
    process.env.KORA_ENGINE_ENABLED = 'false';
    process.env.KORA_RECONCILIATION_INTERVAL_MS = '0';
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    vi.setSystemTime(MARKET_OPEN_UTC);
    app = await startApp();
    http = app.getHttpServer();
    nov = await createUser(app, 'novice');
    await md.standard();
    // The rest of the curated list (other currencies need their conversion pair).
    await md.quote('SPY', '552.10', '552.12');
    await md.quote('KGEF', '101.250', '101.260');
    await md.quote('7203.XTKS', '2985', '2986');
    await md.quote('BHP.XASX', '44.10', '44.12');
    await md.quote('AUDUSD', '0.66210', '0.66214');
    await md.quote('NPN.XJSE', '3890.00', '3891.00');
    await md.quote('USDZAR', '17.8120', '17.8140');
  });
  afterAll(async () => {
    await md.close();
    await app.close();
    vi.useRealTimers();
    delete process.env.KORA_ENGINE_ENABLED;
    delete process.env.KORA_RECONCILIATION_INTERVAL_MS;
  });

  it('matches for 20 seeded random tickets across the curated list', async () => {
    const r = rng(20260926);
    const seen = new Set<string>();
    let withCommission = 0;
    for (let i = 0; i < 20; i++) {
      const symbol = SYMBOLS[i % SYMBOLS.length]!;
      const direction = r() < 0.5 ? 'up' : 'down';
      const safetyNetPct = String(0.5 + Math.floor(r() * 20) * 0.5); // 0.5 … 10 in 0.5 steps
      await md.touch();
      // Start from the minimum amount for this instrument, then a random multiple up to ~20,000.
      const probe = await request(http)
        .post('/novice/ticket')
        .set(bearer(nov.token))
        .send({ symbol, direction, amount: '0.01', safetyNetPct })
        .expect(200);
      expect(probe.body).toMatchObject({ ok: false, reason: 'amount_too_small' });
      const min = Number(probe.body.minAmount);
      const amount = Math.max(
        min * (1 + r() * 3),
        Math.min(20_000, min * 1.05) + r() * 5_000,
      ).toFixed(2);

      const t = await request(http)
        .post('/novice/ticket')
        .set(bearer(nov.token))
        .send({ symbol, direction, amount, safetyNetPct })
        .expect(200);
      expect(t.body.ok, JSON.stringify(t.body)).toBe(true);
      const order = t.body.order as Record<string, string>;
      expect(order).toMatchObject({
        symbol,
        type: 'market',
        side: direction === 'up' ? 'buy' : 'sell',
      });
      expect(dec(t.body.amountUsed).lte(dec(amount))).toBe(true);

      const p = await request(http)
        .post('/orders/preview')
        .set(bearer(nov.token))
        .send(order)
        .expect(200);
      const direct = p.body.preview.lossIfStopHit as {
        price: string;
        costs: string;
        total: string;
      };
      const shown = t.body.preview.preview.lossIfStopHit as typeof direct;
      expect(shown, `case ${i} ${symbol}`).toEqual(direct);
      // Fees are included: total = loss from the price move + costs, and costs are real.
      // (each figure is rounded to the cent on its own, so allow one minor unit of rounding).
      const gap = dec(direct.total)
        .sub(dec(direct.price).add(dec(direct.costs)))
        .abs();
      expect(
        gap.lte(dec('0.01')),
        `case ${i}: ${direct.total} vs ${direct.price} + ${direct.costs}`,
      ).toBe(true);
      // Commission can be zero on some SIMULATED schedules (funds); the spread is always a cost and
      // sits inside the price loss (entry at the ask for a buy, exit at the stop).
      expect(dec(direct.costs).gte(0), `case ${i} costs`).toBe(true);
      expect(dec(p.body.preview.fees.total).gt(0), `case ${i} entry fees incl. spread`).toBe(true);
      if (dec(direct.costs).gt(0)) withCommission += 1;
      // What the web shows is exactly the preview's total and costs.
      const figures = noviceLossFigures(shown, t.body.currency as string)!;
      expect(figures.mostYouCouldLose).toBe(direct.total);
      expect(figures.fees).toBe(direct.costs);
      expect(t.body.scenario).toEqual({ loss: direct.total, gain: figures.gain });
      // The rest of the preview (fees block, notional, margin) is identical too.
      expect(t.body.preview.preview.fees).toEqual(p.body.preview.fees);
      expect(t.body.preview.preview.notional).toEqual(p.body.preview.notional);
      // The stop sits the chosen distance away (rounded away from the entry on the tick grid).
      const ref = dec(t.body.refPrice);
      const dist = ref.sub(dec(order.stopLossPrice!)).abs().div(ref).mul(100);
      expect(dist.gte(dec(safetyNetPct)), `case ${i} stop distance ${dist.toFixed()}`).toBe(true);
      seen.add(symbol);
    }
    expect(seen.size).toBe(SYMBOLS.length);
    expect(withCommission).toBeGreaterThanOrEqual(16);
  });

  it('refuses a safety net outside 0.5–10 % and reports the minimum amount in the account currency', async () => {
    await md.touch();
    await request(http)
      .post('/novice/ticket')
      .set(bearer(nov.token))
      .send({ symbol: 'EURUSD', direction: 'up', amount: '5000', safetyNetPct: '12' })
      .expect(400);
    const small = await request(http)
      .post('/novice/ticket')
      .set(bearer(nov.token))
      .send({ symbol: 'EURUSD', direction: 'up', amount: '500', safetyNetPct: '3' })
      .expect(200);
    expect(small.body).toEqual({ ok: false, reason: 'amount_too_small', minAmount: '1084.21' });
    const unknown = await request(http)
      .post('/novice/ticket')
      .set(bearer(nov.token))
      .send({ symbol: 'NOPE', direction: 'up', amount: '500', safetyNetPct: '3' });
    expect(unknown.status).toBe(404);
  });

  it('lists the curated registry assets with names in both languages and minimum amounts', async () => {
    await md.touch();
    const a = await request(http).get('/novice/assets').set(bearer(nov.token)).expect(200);
    expect(a.body.currency).toBe('USD');
    expect(a.body.assets.map((x: { symbol: string }) => x.symbol)).toEqual(SYMBOLS);
    const regions = new Set(
      a.body.assets.map((x: { venue: { region: string } }) => x.venue.region),
    );
    expect(regions.size).toBeGreaterThanOrEqual(4);
    for (const x of a.body.assets) {
      expect(x.name.en.length).toBeGreaterThan(0);
      expect(x.name.fr.length).toBeGreaterThan(0);
    }
    expect(a.body.assets[0]).toMatchObject({
      symbol: 'EURUSD',
      name: { en: 'Euro vs Dollar' },
      minAmount: '1084.21',
      priced: true,
    });
  });
});

import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  acknowledgeRiskWarning,
  awayFromUtcMidnight,
  bearer,
  createUser,
  login,
  startApp,
  type TestUser,
} from './helpers';
import { MARKET_OPEN_UTC, MarketFixture } from './market-fixture';
import { knowledgeFail, onboard, passKnowledgeCheck } from './novice-helpers';
import knowledgeCheckV1 from '../src/appropriateness/questionnaires/knowledge-check.v1.json';

let n = 0;
const cid = () => `ng-${process.pid}-${++n}`;
const HOUR = 3_600_000;

/**
 * Goal 08 acceptance 1: "A novice cannot" — each is an API-level test. Guardrails are enforced by the
 * goal 03 risk path for novice-only users and anyone in the Novice view.
 */
describe('novice guardrails through the API', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  const md = new MarketFixture();

  beforeAll(async () => {
    process.env.KORA_ENGINE_ENABLED = 'false';
    process.env.KORA_RECONCILIATION_INTERVAL_MS = '0';
    // Platform daily loss limit above 5 % of the practice balance, so the 5 % cooling-off rule is
    // what stops the trade (not the daily limit).
    process.env.KORA_RISK_DAILY_LOSS_LIMIT = '20000';
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    vi.setSystemTime(MARKET_OPEN_UTC);
    app = await startApp();
    http = app.getHttpServer();
  });
  beforeEach(async () => {
    // Each test starts on the same Wednesday afternoon (tests move the clock forward).
    vi.setSystemTime(MARKET_OPEN_UTC);
    await md.standard();
  });
  afterAll(async () => {
    await md.close();
    await app.close();
    vi.useRealTimers();
    delete process.env.KORA_ENGINE_ENABLED;
    delete process.env.KORA_RECONCILIATION_INTERVAL_MS;
    delete process.env.KORA_RISK_DAILY_LOSS_LIMIT;
  });

  const send = async (u: { token: string }, body: object) => {
    await md.touch();
    return request(http)
      .post('/orders')
      .set(bearer(u.token))
      .send({ clientOrderId: cid(), ...body });
  };
  const rejected = async (u: { token: string }, body: object, code: string) => {
    const res = await send(u, body);
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    const codes = (res.body.violations as Array<{ code: string }>).map((v) => v.code);
    expect(codes, JSON.stringify(res.body)).toContain(code);
    return res.body as { message: string; violations: Array<{ code: string; message: string }> };
  };
  const profile = async (u: { token: string }) =>
    (await request(http).get('/novice/profile').set(bearer(u.token)).expect(200)).body;
  /** Moves the faked clock and signs in again (access tokens live 30 min). */
  const later = async (u: TestUser, ms: number) => {
    vi.setSystemTime(Date.now() + ms);
    u.token = (await login(app, u.email, undefined, { realClock: true })).token;
    await md.standard();
  };

  it('cannot place an order without a stop (market, limit, or through the Pro endpoints)', async () => {
    const nov = await createUser(app, 'novice');
    await acknowledgeRiskWarning(app, nov.token); // B-801 gate (goal 09)
    const r = await rejected(
      nov,
      { symbol: 'EURUSD', side: 'buy', type: 'market', qty: '10000' },
      'NOVICE_STOP_REQUIRED',
    );
    expect(r.violations.find((v) => v.code === 'NOVICE_STOP_REQUIRED')!.message).toContain(
      'stop loss',
    );
    await rejected(
      nov,
      { symbol: 'EURUSD', side: 'sell', type: 'market', qty: '10000' },
      'NOVICE_STOP_REQUIRED',
    );
    // Advanced types are refused too (market + stop only), whatever the client sends.
    await rejected(
      nov,
      { symbol: 'EURUSD', side: 'buy', type: 'limit', qty: '10000', limitPrice: '1.08300' },
      'NOVICE_STOP_REQUIRED',
    );
    await rejected(
      nov,
      { symbol: 'EURUSD', side: 'buy', type: 'limit', qty: '10000', limitPrice: '1.08300' },
      'NOVICE_ORDER_TYPE',
    );
    // The preview says so before anything happens.
    const pv = await request(http)
      .post('/orders/preview')
      .set(bearer(nov.token))
      .send({ symbol: 'EURUSD', side: 'buy', type: 'market', qty: '10000' })
      .expect(200);
    expect(pv.body.risk.ok).toBe(false);
    expect(pv.body.risk.violations.map((v: { code: string }) => v.code)).toContain(
      'NOVICE_STOP_REQUIRED',
    );
    // With a stop it goes through.
    expect(
      (
        await send(nov, {
          symbol: 'EURUSD',
          side: 'buy',
          type: 'market',
          qty: '10000',
          stopLossPrice: '1.08000',
        })
      ).status,
    ).toBe(201);
  });

  it('cannot use leverage: off by default; asking needs the knowledge check; on only after 24 h, capped at 2×', async () => {
    const nov = await createUser(app, 'novice');
    await acknowledgeRiskWarning(app, nov.token); // B-801 gate (goal 09)
    // 1.5 × the 100,000 practice balance in EUR/USD (margin allows it; the novice rule does not).
    const big = {
      symbol: 'EURUSD',
      side: 'buy',
      type: 'market',
      qty: '138000',
      stopLossPrice: '1.07500',
    };
    await rejected(nov, big, 'NOVICE_LEVERAGE');
    const noCheck = await request(http)
      .put('/novice/leverage')
      .set(bearer(nov.token))
      .send({ enabled: true })
      .expect(403);
    expect(noCheck.body.error).toBe('knowledge_check_required');

    // A failed check (score below 4/5) does not unlock and starts a cool-down.
    const fail = await request(http)
      .post('/novice/knowledge-check/attempts')
      .set(bearer(nov.token))
      .send({ questionnaireId: knowledgeCheckV1.id, version: 1, answers: knowledgeFail() })
      .expect(200);
    expect(fail.body).toMatchObject({ passed: false, passMarkPct: 80 });
    expect(fail.body.cooldownUntil).toBeTruthy();
    await request(http)
      .put('/novice/leverage')
      .set(bearer(nov.token))
      .send({ enabled: true })
      .expect(403);
    await later(nov, 61 * 60_000); // after the 60 min cool-down
    await passKnowledgeCheck(app, nov.token);

    const asked = await request(http)
      .put('/novice/leverage')
      .set(bearer(nov.token))
      .send({ enabled: true })
      .expect(200);
    expect(asked.body.leverage).toMatchObject({ state: 'pending', current: '1', max: '2' });
    expect(Date.parse(asked.body.leverage.effectiveAt) - Date.now()).toBeGreaterThan(23.9 * HOUR);
    await rejected(nov, big, 'NOVICE_LEVERAGE'); // still off during the wait

    await later(nov, 24 * HOUR + 60_000);
    expect((await profile(nov)).leverage).toMatchObject({ state: 'on', current: '2' });
    expect((await send(nov, big)).status).toBe(201);
    // Above 2× in total is still refused.
    const over = await rejected(nov, { ...big, qty: '60000' }, 'NOVICE_LEVERAGE');
    expect(over.violations.find((v) => v.code === 'NOVICE_LEVERAGE')!.message).toContain('2×');
    // Turning it off is immediate.
    const off = await request(http)
      .put('/novice/leverage')
      .set(bearer(nov.token))
      .send({ enabled: false })
      .expect(200);
    expect(off.body.leverage).toMatchObject({ state: 'off', current: '1' });
  });

  it('cannot open the strategy builder or the robot / backtest API (403); templates are readable', async () => {
    const nov = await createUser(app, 'novice');
    await acknowledgeRiskWarning(app, nov.token); // B-801 gate (goal 09)
    await request(http).get('/robots/builder').set(bearer(nov.token)).expect(403);
    await request(http).get('/strategies/catalog').set(bearer(nov.token)).expect(403);
    await request(http)
      .post('/strategies/validate')
      .set(bearer(nov.token))
      .send({ definition: {} })
      .expect(403);
    await request(http)
      .post('/strategies')
      .set(bearer(nov.token))
      .send({ definition: {}, reason: 'x' })
      .expect(403);
    await request(http).post('/backtests').set(bearer(nov.token)).send({}).expect(403);
    await request(http).get('/robots').set(bearer(nov.token)).expect(403);
    await request(http).post('/robots').set(bearer(nov.token)).send({}).expect(403);
    const t = await request(http).get('/strategy-templates').set(bearer(nov.token)).expect(200);
    expect(t.body.templates.length).toBeGreaterThanOrEqual(3);
  });

  it('cannot loosen a limit without the 24 h wait; tightening is immediate (any endpoint)', async () => {
    const nov = await createUser(app, 'novice');
    await acknowledgeRiskWarning(app, nov.token); // B-801 gate (goal 09)
    await onboard(app, nov.token, { dailyLossLimit: '150', monthlyLossLimit: '600' });
    let p = await profile(nov);
    expect(p.limits.daily.limit).toBe('150');
    expect(p.limits.monthly.limit).toBe('600');

    // Loosen through the Novice endpoint and through the generic settings endpoint: both wait.
    const loose = await request(http)
      .put('/novice/limits')
      .set(bearer(nov.token))
      .send({ dailyLossLimit: '300' })
      .expect(200);
    expect(loose.body.limits.daily.limit).toBe('150');
    expect(loose.body.limits.pending).toEqual([
      expect.objectContaining({ field: 'dailyLossLimit', value: '300' }),
    ]);
    const viaSettings = await request(http)
      .put('/accounts/me/settings')
      .set(bearer(nov.token))
      .send({ riskLimits: { monthlyLossLimit: '900' } })
      .expect(200);
    expect(viaSettings.body.limits.monthlyLossLimit).toBe('600');
    expect(viaSettings.body.pendingLimits.map((x: { field: string }) => x.field).sort()).toEqual([
      'dailyLossLimit',
      'monthlyLossLimit',
    ]);

    // The old limit still applies: a 200 loss today is past 150 (not past the pending 300).
    expect(
      (
        await send(nov, {
          symbol: 'EURUSD',
          side: 'buy',
          type: 'market',
          qty: '90000',
          stopLossPrice: '1.07500',
        })
      ).status,
    ).toBe(201);
    await md.quote('EURUSD', '1.08220', '1.08222'); // about −183 unrealised (with fees)
    await rejected(
      nov,
      { symbol: 'EURUSD', side: 'buy', type: 'market', qty: '1000', stopLossPrice: '1.07500' },
      'DAILY_LOSS_LIMIT',
    );

    // Tightening applies at once and cancels the pending loosening of that field.
    const tight = await request(http)
      .put('/novice/limits')
      .set(bearer(nov.token))
      .send({ dailyLossLimit: '100' })
      .expect(200);
    expect(tight.body.limits.daily.limit).toBe('100');
    expect(tight.body.limits.pending.map((x: { field: string }) => x.field)).toEqual([
      'monthlyLossLimit',
    ]);

    // 23 h later still waiting; after 24 h the loosening applies itself.
    await later(nov, 23 * HOUR);
    expect((await profile(nov)).limits.monthly.limit).toBe('600');
    await later(nov, HOUR + 60_000);
    p = await profile(nov);
    expect(p.limits.monthly.limit).toBe('900');
    expect(p.limits.pending).toEqual([]);

    // Audit carries what applied and what waits.
    const audit = await request(http)
      .get('/audit?action=account.settings_updated&limit=10')
      .set(bearer(nov.token))
      .expect(200);
    const payloads = (audit.body.events as Array<{ payload: Record<string, unknown> }>).map(
      (e) => e.payload,
    );
    expect(
      payloads.some(
        (x) => x.guarded === true && (x.limitsPending as Record<string, unknown>).dailyLossLimit,
      ),
    ).toBe(true);
  });

  it('Pro users keep immediate loosening (the 24 h wait is a Novice guardrail)', async () => {
    const trader = await createUser(app, 'trader');
    await request(http)
      .put('/accounts/me/settings')
      .set(bearer(trader.token))
      .send({ riskLimits: { dailyLossLimit: '100' } })
      .expect(200);
    const r = await request(http)
      .put('/accounts/me/settings')
      .set(bearer(trader.token))
      .send({ riskLimits: { dailyLossLimit: '900' } })
      .expect(200);
    expect(r.body.limits.dailyLossLimit).toBe('900');
    // …but the same trader in the Novice view waits.
    await request(http)
      .put('/me/preferences')
      .set(bearer(trader.token))
      .send({ viewMode: 'novice' })
      .expect(200);
    const w = await request(http)
      .put('/accounts/me/settings')
      .set(bearer(trader.token))
      .send({ riskLimits: { dailyLossLimit: '2000' } })
      .expect(200);
    expect(w.body.limits.dailyLossLimit).toBe('900');
    await request(http)
      .put('/me/preferences')
      .set(bearer(trader.token))
      .send({ viewMode: 'pro' })
      .expect(200);
  });

  it('cooling-off after 3 losing trades in a day; closing still allowed; lifts the next day', async () => {
    // Fills are stamped by the database clock, so this test runs on the real clock (bitcoin trades
    // around the clock) and then moves the app clock past midnight UTC.
    vi.setSystemTime(vi.getRealSystemTime());
    // IRTC R6-15: the scenario takes well under two minutes; never let it straddle UTC midnight.
    await awayFromUtcMidnight(120_000);
    vi.setSystemTime(vi.getRealSystemTime());
    await md.standard();
    const nov = await createUser(app, 'novice', [], { realClock: true });
    await acknowledgeRiskWarning(app, nov.token); // B-801 gate (goal 09)
    const open = {
      symbol: 'BTCUSD',
      side: 'buy',
      type: 'market',
      qty: '0.05',
      stopLossPrice: '62000.0',
    };
    for (let i = 0; i < 3; i++) {
      expect((await send(nov, open)).status).toBe(201);
      await md.touch();
      expect(
        (await request(http).post('/positions/BTCUSD/close').set(bearer(nov.token))).status,
      ).toBe(201);
    }
    const p = await profile(nov);
    expect(p.coolingOff).toMatchObject({
      active: true,
      reason: 'losing_trades',
      losingTradesToday: 3,
    });
    const midnight = new Date(Date.now());
    midnight.setUTCHours(24, 0, 0, 0);
    expect(p.coolingOff.until).toBe(midnight.toISOString());
    const r = await rejected(nov, open, 'NOVICE_COOLING_OFF');
    expect(r.violations.find((v) => v.code === 'NOVICE_COOLING_OFF')!.message).toMatch(
      /^Time for a break/,
    );
    // A trader in the Pro view is not cooled off by the Novice rule.
    const trader = await createUser(app, 'trader', [], { realClock: true });
    for (let i = 0; i < 3; i++) {
      expect((await send(trader, open)).status).toBe(201);
      await md.touch();
      await request(http).post('/positions/BTCUSD/close').set(bearer(trader.token)).expect(201);
    }
    expect((await send(trader, open)).status).toBe(201);
    // Next UTC day: trading opens again.
    await later(nov, midnight.getTime() - Date.now() + 60_000);
    expect((await profile(nov)).coolingOff.active).toBe(false);
    expect((await send(nov, open)).status).toBe(201);
  }, 180_000);

  it('cooling-off after a 5 % daily loss (closing allowed), and the monthly loss limit', async () => {
    const nov = await createUser(app, 'novice');
    await acknowledgeRiskWarning(app, nov.token); // B-801 gate (goal 09)
    expect(
      (
        await send(nov, {
          symbol: 'BTCUSD',
          side: 'buy',
          type: 'market',
          qty: '1',
          stopLossPrice: '62000.0',
        })
      ).status,
    ).toBe(201);
    await md.quote('BTCUSD', '59600.0', '59602.0'); // about −5,200 on a 100,000 balance
    const r = await rejected(
      nov,
      { symbol: 'EURUSD', side: 'buy', type: 'market', qty: '1000', stopLossPrice: '1.07500' },
      'NOVICE_COOLING_OFF',
    );
    expect(r.violations.find((v) => v.code === 'NOVICE_COOLING_OFF')!.message).toContain(
      'large for your balance',
    );
    expect((await profile(nov)).coolingOff).toMatchObject({
      active: true,
      reason: 'daily_loss_pct',
    });
    await md.touch();
    expect(
      (await request(http).post('/positions/BTCUSD/close').set(bearer(nov.token))).status,
    ).toBe(201);

    const m = await createUser(app, 'novice');

    await acknowledgeRiskWarning(app, m.token); // B-801 gate (goal 09)
    await request(http)
      .put('/novice/limits')
      .set(bearer(m.token))
      .send({ monthlyLossLimit: '100' })
      .expect(200);
    expect(
      (
        await send(m, {
          symbol: 'EURUSD',
          side: 'buy',
          type: 'market',
          qty: '90000',
          stopLossPrice: '1.07500',
        })
      ).status,
    ).toBe(201);
    await md.quote('EURUSD', '1.08290', '1.08292'); // about −120 (with fees)
    const ml = await rejected(
      m,
      { symbol: 'EURUSD', side: 'buy', type: 'market', qty: '1000', stopLossPrice: '1.07500' },
      'MONTHLY_LOSS_LIMIT',
    );
    expect(ml.violations.find((v) => v.code === 'MONTHLY_LOSS_LIMIT')!.message).toContain(
      '100.00 USD monthly limit',
    );
  });
});

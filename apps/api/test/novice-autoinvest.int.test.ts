import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bearer, createUser, CSRF, ownerQuery, startApp, type TestUser } from './helpers';
import { MarketFixture } from './market-fixture';
import { onboard } from './novice-helpers';

const TOKEN = 'novice-autoinvest-test-service-token-0123456789';

/**
 * B-614 decision: novices paper-run ready-made robots through the guarded /novice/auto-invest path.
 * The builder API stays closed; the runner accepts a novice owner only for template robots, and their
 * orders go through the OMS with the novice guardrails. Live is always refused (audited).
 */
describe('novice auto-invest: template robots, PAPER, guarded', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let nov: TestUser;
  const md = new MarketFixture();

  beforeAll(async () => {
    process.env.KORA_ENGINE_ENABLED = 'false';
    process.env.KORA_RECONCILIATION_INTERVAL_MS = '0';
    process.env.KORA_SERVICE_TOKEN = TOKEN;
    // No bot runner here: keep the supervisor from pausing robots for missed heartbeats.
    process.env.KORA_ROBOT_HEARTBEAT_MS = '600000';
    // No quant service here: the best-effort template test fails fast and is logged.
    process.env.QUANT_URL = 'http://127.0.0.1:9';
    app = await startApp();
    http = app.getHttpServer();
    nov = await createUser(app, 'novice', [], { realClock: true });
    await md.standard();
  });
  afterAll(async () => {
    await md.close();
    await app.close();
    for (const k of ['KORA_ENGINE_ENABLED', 'KORA_RECONCILIATION_INTERVAL_MS', 'KORA_SERVICE_TOKEN', 'KORA_ROBOT_HEARTBEAT_MS', 'QUANT_URL']) delete process.env[k];
  });

  it('lists the templates with risk levels 1–5, no in-sample numbers, and amount bounds', async () => {
    const r = await request(http).get('/novice/auto-invest').set(bearer(nov.token)).expect(200);
    expect(r.body).toMatchObject({ currency: 'USD', environment: 'PAPER', liveAvailable: false, amount: { min: '1000.00', max: '25000.00' } });
    const levels = Object.fromEntries(r.body.templates.map((t: { id: string; riskLevel: number }) => [t.id, t.riskLevel]));
    expect(levels).toEqual({ 'trend-x': 2, 'meanrev-gold': 3, 'breakout-crypto': 5 });
    expect(JSON.stringify(r.body)).not.toMatch(/inSample|isSharpe/);
    for (const t of r.body.templates) expect(t.robot).toBeNull();
  });

  it('refuses before onboarding and outside the amount bounds; starts a PAPER template robot', async () => {
    const early = await request(http).post('/novice/auto-invest').set(bearer(nov.token)).send({ templateId: 'breakout-crypto', amount: '5000' }).expect(409);
    expect(early.body.error).toBe('onboarding_required');
    await onboard(app, nov.token);
    await request(http).post('/novice/auto-invest').set(bearer(nov.token)).send({ templateId: 'nope', amount: '5000' }).expect(404);
    const big = await request(http).post('/novice/auto-invest').set(bearer(nov.token)).send({ templateId: 'breakout-crypto', amount: '30000' }).expect(400);
    expect(big.body).toMatchObject({ error: 'amount_out_of_range', min: '1000.00', max: '25000.00' });

    const ok = await request(http).post('/novice/auto-invest').set(bearer(nov.token)).send({ templateId: 'breakout-crypto', amount: '5000' }).expect(201);
    const t = ok.body.templates.find((x: { id: string }) => x.id === 'breakout-crypto');
    expect(t.robot).toMatchObject({ status: 'running', mode: 'PAPER', allocation: '5000.00' });
    const [row] = await ownerQuery<{ origin: string; template_id: string; limits: Record<string, unknown>; mode: string }>(
      'SELECT origin, template_id, limits, mode FROM robots WHERE id = $1',
      [t.robot.id],
    );
    expect(row).toMatchObject({ origin: 'novice_template', template_id: 'breakout-crypto', mode: 'PAPER' });
    // 3 % of the amount, below the user's own daily limit (1,500); no leverage inside the robot.
    expect(row!.limits).toMatchObject({ dailyLoss: '150.00', weeklyLoss: '300.00', grossExposure: 1, maxDrawdownPct: 10 });
    await request(http).post('/novice/auto-invest').set(bearer(nov.token)).send({ templateId: 'breakout-crypto', amount: '5000' }).expect(409);
    // The builder API is still closed to novices.
    await request(http).get(`/robots/${t.robot.id}`).set(bearer(nov.token)).expect(403);
    const audit = await request(http).get('/audit?action=novice.autoinvest_started').set(bearer(nov.token)).expect(200);
    expect(audit.body.events[0].payload).toMatchObject({ templateId: 'breakout-crypto', riskLevel: 5, mode: 'PAPER' });
  });

  it('the runner acts for a novice template robot (orders pass the novice guardrails); pause, resume, live refused', async () => {
    const list = (await request(http).get('/novice/auto-invest').set(bearer(nov.token)).expect(200)).body;
    const robot = list.templates.find((x: { id: string }) => x.id === 'breakout-crypto').robot;
    const versionId = (await ownerQuery<{ version_id: string }>('SELECT version_id FROM robots WHERE id = $1', [robot.id]))[0]!.version_id;
    await md.touch();
    const barTs = Math.floor(Date.now() / 3_600_000) * 3_600_000;
    const signal = (qty: string, ts: number) => ({
      symbol: 'BTCUSD',
      barTs: ts,
      versionId,
      signal: { symbol: 'BTCUSD', barTs: ts, action: 'enter_long', reason: 'test', conditions: [], features: {}, params: {}, qty, stopDistance: 1500, targetDistance: null, newStop: null },
    });
    const d = await request(http).post(`/internal/robots/${robot.id}/decisions`).set('x-kora-service-token', TOKEN).set(CSRF).send(signal('0.01', barTs)).expect(200);
    expect(d.body.outcome, JSON.stringify(d.body)).toBe('submitted');
    const [order] = await ownerQuery<{ source: string; stop_loss_price: string | null; type: string }>('SELECT source, stop_loss_price::text, type FROM orders WHERE id = $1', [d.body.orderId]);
    expect(order).toMatchObject({ source: `robot:${robot.id}`, type: 'market' });
    expect(order!.stop_loss_price).not.toBeNull();
    // Above the robot's own 1× exposure: refused before it reaches the market.
    await md.touch();
    const big = await request(http).post(`/internal/robots/${robot.id}/decisions`).set('x-kora-service-token', TOKEN).set(CSRF).send(signal('0.2', barTs + 14_400_000)).expect(200);
    expect(big.body.outcome).toBe('refused');

    let r = await request(http).post(`/novice/auto-invest/${robot.id}/pause`).set(bearer(nov.token)).expect(200);
    expect(r.body.templates.find((x: { id: string }) => x.id === 'breakout-crypto').robot.status).toBe('paused');
    r = await request(http).post(`/novice/auto-invest/${robot.id}/resume`).set(bearer(nov.token)).expect(200);
    expect(r.body.templates.find((x: { id: string }) => x.id === 'breakout-crypto').robot.status).toBe('running');

    const live = await request(http).post(`/novice/auto-invest/${robot.id}/go-live`).set(bearer(nov.token)).expect(403);
    expect(live.body).toMatchObject({ error: 'live_not_available' });
    expect(live.body.checklist).toEqual([
      { id: 'knowledge_check', ok: false },
      { id: 'promotion_rules', ok: false },
      { id: 'live_trading_enabled', ok: false },
    ]);
    const audit = await request(http).get('/audit?action=novice.autoinvest_live_refused').set(bearer(nov.token)).expect(200);
    expect(audit.body.events).toHaveLength(1);
    // Someone else cannot touch it.
    const other = await createUser(app, 'novice', [], { realClock: true });
    await request(http).post(`/novice/auto-invest/${robot.id}/pause`).set(bearer(other.token)).expect(404);
  });

  it('a template robot cannot restart while its owner is cooling off', async () => {
    const list = (await request(http).get('/novice/auto-invest').set(bearer(nov.token)).expect(200)).body;
    const robot = list.templates.find((x: { id: string }) => x.id === 'breakout-crypto').robot;
    await request(http).post(`/novice/auto-invest/${robot.id}/pause`).set(bearer(nov.token)).expect(200);
    const open = { symbol: 'BTCUSD', side: 'buy', type: 'market', qty: '0.01', stopLossPrice: '62000.0' };
    for (let i = 0; i < 3; i++) {
      await md.touch();
      await request(http).post('/orders').set(bearer(nov.token)).send({ clientOrderId: `cool-${Date.now()}-${i}`, ...open }).expect(201);
      await md.touch();
      await request(http).post('/positions/BTCUSD/close').set(bearer(nov.token)).expect(201);
    }
    const r = await request(http).post(`/novice/auto-invest/${robot.id}/resume`).set(bearer(nov.token)).expect(409);
    expect(r.body.error).toBe('cooling_off');
  });
});

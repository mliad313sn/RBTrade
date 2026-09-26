import type { INestApplication } from '@nestjs/common';
import { RISK_ALERTS_CHANNEL } from '@kora/domain';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { bearer, createUser, ownerQuery, startApp, type TestUser } from './helpers';
import { MARKET_OPEN_UTC, MarketFixture } from './market-fixture';
import { listen, TestWs } from './ws-helpers';

let n = 0;
const cid = () => `rc-${process.pid}-${++n}`;

/**
 * Goal 09 acceptance: "The risk console shows real data from goals 03 and 06, and breach alerts reach
 * the console within 5 s." Real engine, real alerts table, NOTIFY relay, Redis bus and WS gateway.
 */
describe('risk officer console', () => {
  let app: INestApplication;
  let urls: { http: string; ws: string };
  const md = new MarketFixture();
  let risk: TestUser;
  let trader: TestUser;
  let auditor: TestUser;

  beforeAll(async () => {
    process.env.KORA_ENGINE_ENABLED = 'false';
    process.env.KORA_RECONCILIATION_INTERVAL_MS = '0';
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    vi.setSystemTime(MARKET_OPEN_UTC);
    app = await (async () => {
      const a = await startApp();
      return a;
    })();
    urls = await listen(app);
    await md.standard();
    risk = await createUser(app, 'novice', ['risk_officer'], { realClock: true });
    trader = await createUser(app, 'trader', [], { realClock: true });
    auditor = await createUser(app, 'novice', ['auditor'], { realClock: true });
  });
  afterAll(async () => {
    await md.close();
    await app.close();
    vi.useRealTimers();
    delete process.env.KORA_ENGINE_ENABLED;
    delete process.env.KORA_RECONCILIATION_INTERVAL_MS;
  });

  it('a limit breach reaches the console’s live channel within 5 s (and only the 2nd line may subscribe)', async () => {
    const denied = await TestWs.authed(urls.ws, trader.token);
    denied.send({ op: 'subscribe', channels: [RISK_ALERTS_CHANNEL], id: 'x' });
    const d = await denied.waitFor((m) => m.type === 'subscribed' && m.id === 'x');
    expect(d.msg.rejected).toEqual([{ channel: RISK_ALERTS_CHANNEL, code: 'forbidden' }]);
    denied.ws.close();

    const ws = await TestWs.authed(urls.ws, risk.token, [RISK_ALERTS_CHANNEL]);
    await md.touch();
    const t0 = Date.now();
    const res = await request(app.getHttpServer())
      .post('/orders')
      .set(bearer(trader.token))
      .send({ clientOrderId: cid(), symbol: 'BTCUSD', side: 'buy', type: 'market', qty: '40' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('MAX_ORDER_NOTIONAL');
    const got = await ws.waitFor((m) => m.ch === RISK_ALERTS_CHANNEL && m.data?.alert?.kind === 'risk.limit_breach' && m.data.alert.details.orderId === res.body.order.id, 5000);
    const latency = got.at - t0;
    process.stdout.write(`[risk-console] breach alert on the console channel after ${latency} ms (includes the order round trip)\n`);
    expect(latency).toBeLessThan(5000);
    expect(got.msg.data.alert).toMatchObject({ severity: 'warning', kind: 'risk.limit_breach', details: { codes: expect.arrayContaining(['MAX_ORDER_NOTIONAL']), symbol: 'BTCUSD' } });
    ws.ws.close();
  });

  it('overview shows real goal 03 / 06 data: exposure vs limits, breaches, approvals, kill-switch history, reconciliation, AI rates, novice guardrails', async () => {
    const http = app.getHttpServer();
    await md.touch();
    await request(http).post('/orders').set(bearer(trader.token)).send({ clientOrderId: cid(), symbol: 'BTCUSD', side: 'buy', type: 'market', qty: '1' }).expect(201);
    const acct = (await request(http).get('/accounts/me').set(bearer(trader.token))).body;
    await request(http).post('/reconciliation/run').set(bearer(risk.token)).expect(200);

    const o = await request(http).get('/risk-console/overview').set(bearer(risk.token)).expect(200);
    expect(o.body).toMatchObject({ environment: 'PAPER', simulated: true });
    const row = o.body.exposure.accounts.find((a: { accountId: string }) => a.accountId === acct.id);
    expect(row).toBeDefined();
    // The same numbers the engine reports to the account holder.
    const fresh = (await request(http).get('/accounts/me').set(bearer(trader.token))).body;
    expect(row).toMatchObject({ baseCurrency: fresh.baseCurrency, openPositions: 1, limits: { dailyLossLimit: fresh.limits.dailyLossLimit, maxLeverage: fresh.limits.maxLeverage } });
    expect(Number(row.grossExposure)).toBeGreaterThan(0);
    expect(row.utilisation).toHaveProperty('worstPct');
    expect(o.body.exposure.firm.find((f: { currency: string }) => f.currency === fresh.baseCurrency).accounts).toBeGreaterThanOrEqual(1);
    expect(o.body.limitBreaches.some((a: { accountId: string; kind: string }) => a.accountId === acct.id && a.kind === 'risk.limit_breach')).toBe(true);
    expect(o.body.reconciliation.lastRun).toMatchObject({ trigger: 'manual' });
    expect(o.body.ai).toMatchObject({ days: 7 });
    expect(o.body.noviceGuardrails).toHaveProperty('rejections');
    expect(o.body.robots).toHaveProperty('nearPausePct', 70);
    expect(o.body.approvals).toHaveProperty('fourEyes');

    // Roles: the console is 2nd line only (the auditor has the internal audit view instead).
    await request(http).get('/risk-console/overview').set(bearer(trader.token)).expect(403);
    await request(http).get('/risk-console/overview').set(bearer(auditor.token)).expect(403);
  });

  it('acknowledging an alert is audited; the global kill switch appears in the history and halts accounts as a firm halt', async () => {
    const http = app.getHttpServer();
    const alerts = await request(http).get('/risk-console/alerts?open=true&kind=risk.').set(bearer(risk.token)).expect(200);
    const a = alerts.body.alerts[0];
    const ack = await request(http).post(`/risk-console/alerts/${a.id}/ack`).set(bearer(risk.token)).send({ note: 'reviewed with desk' }).expect(200);
    expect(ack.body.acknowledgedBy).toBe(risk.id);
    const ev = await ownerQuery<{ n: string }>(`SELECT count(*)::text AS n FROM audit_events WHERE action = 'risk.alert_acknowledged' AND entity_id = $1`, [a.id]);
    expect(ev[0]!.n).toBe('1');

    const ws = await TestWs.authed(urls.ws, risk.token, [RISK_ALERTS_CHANNEL]);
    const g = await request(http).post('/risk-console/kill-switch').set(bearer(risk.token)).send({ scope: 'robots', reason: 'console test' }).expect(202);
    expect(g.body.failures).toEqual([]);
    const fired = await ws.waitFor((m) => m.data?.alert?.kind === 'kill_switch.fired', 5000);
    expect(fired.msg.data.alert).toMatchObject({ severity: 'critical', details: { firm: true, globalKillSwitchId: g.body.globalKillSwitchId } });
    ws.ws.close();
    const hist = await request(http).get('/risk-console/overview').set(bearer(risk.token)).expect(200);
    expect(hist.body.killSwitch.some((k: { action: string; globalKillSwitchId: string | null }) => k.action === 'risk.global_kill_switch')).toBe(true);
    await request(http).post('/risk-console/kill-switch').set(bearer(trader.token)).send({ scope: 'robots', reason: 'x' }).expect(403);
    // Leave the database clean for other suites.
    await ownerQuery(`UPDATE accounts SET trading_halted = false, halt_scope = NULL, halted_at = NULL, halted_by = NULL, halt_reason = NULL WHERE trading_halted`);
  });
});

import type { INestApplication } from '@nestjs/common';
import { TREND_X, type StrategyDefinition } from '@kora/domain';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { bearer, createUser, CSRF, login, ownerQuery, startApp, type TestUser } from './helpers';
import { MARKET_OPEN_UTC, MarketFixture } from './market-fixture';

const DEF: StrategyDefinition = { ...TREND_X, name: 'Four-eyes', universe: { symbols: ['BTCUSD'], timeframe: '1h' }, filters: [] };

/**
 * Goal 09 acceptance: "Four-eyes is enforced: the same user cannot request and approve (API tests for
 * promotion, limit loosening and kill-switch resume)." Also MFA resets (B-003) and the database
 * trigger that backs the API rule.
 */
describe('four-eyes (segregation of duties)', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  const md = new MarketFixture();
  let trader: TestUser;
  let riskA: TestUser;
  let riskB: TestUser;
  let traderRisk: TestUser; // a trader who is also a risk officer
  let adminA: TestUser;
  let adminB: TestUser;
  let novice: TestUser;
  let other: TestUser;

  const accountOf = async (u: TestUser) => (await request(http).get('/accounts/me').set(bearer(u.token)).expect(200)).body.id as string;
  const approve = (u: TestUser, id: string) => request(http).post(`/governance/approvals/${id}/approve`).set(bearer(u.token)).send({ note: 'reviewed' });

  beforeAll(async () => {
    process.env.KORA_ENGINE_ENABLED = 'false';
    process.env.KORA_RECONCILIATION_INTERVAL_MS = '0';
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    vi.setSystemTime(MARKET_OPEN_UTC);
    app = await startApp();
    http = app.getHttpServer();
    await md.standard();
    trader = await createUser(app, 'trader');
    riskA = await createUser(app, 'novice', ['risk_officer']);
    riskB = await createUser(app, 'novice', ['risk_officer']);
    traderRisk = await createUser(app, 'trader', ['risk_officer']);
    adminA = await createUser(app, 'novice', ['admin']);
    adminB = await createUser(app, 'novice', ['admin']);
    novice = await createUser(app, 'novice');
    other = await createUser(app, 'trader');
  });
  afterAll(async () => {
    await md.close();
    await app.close();
    vi.useRealTimers();
    delete process.env.KORA_ENGINE_ENABLED;
    delete process.env.KORA_RECONCILIATION_INTERVAL_MS;
  });

  describe('kill-switch resume after a firm halt', () => {
    it('a self-imposed halt still resumes with one person (goal 03 behaviour)', async () => {
      await request(http).post('/kill-switch').set(bearer(trader.token)).send({ scope: 'robots', source: 'rest_fallback' }).expect(202);
      const st = await request(http).get('/kill-switch').set(bearer(trader.token)).expect(200);
      expect(st.body).toMatchObject({ halted: true, resumeNeedsApproval: false, pendingResume: null });
      const r = await request(http).post('/kill-switch/resume').set(bearer(trader.token)).send({ reason: 'my own halt' }).expect(200);
      expect(r.body.resumed).toBe(true);
    });

    it('the requester cannot approve (API 403 and database trigger); a second risk officer can', async () => {
      await md.touch();
      const acct = await accountOf(trader);
      // A risk officer halts the trader's account (firm halt) through the global kill switch.
      const g = await request(http)
        .post('/risk-console/kill-switch')
        .set(bearer(riskA.token))
        .send({ scope: 'robots_cancel', reason: 'tabletop: firm-wide halt' })
        .expect(202);
      expect(g.body.accounts).toBeGreaterThan(0);
      const st = await request(http).get('/kill-switch').set(bearer(trader.token)).expect(200);
      expect(st.body).toMatchObject({ halted: true, haltedBy: riskA.id, resumeNeedsApproval: true });

      // The owner asks to resume: 202 with a pending four-eyes request, still halted.
      const asked = await request(http).post('/kill-switch/resume').set(bearer(trader.token)).send({ reason: 'cause understood' }).expect(202);
      expect(asked.body).toMatchObject({ resumed: false, pendingApproval: { kind: 'kill_switch_resume', status: 'pending', requestedBy: trader.id } });
      const reqId = asked.body.pendingApproval.id as string;
      // Asking again does not create a second request.
      const again = await request(http).post('/kill-switch/resume').set(bearer(trader.token)).send({ reason: 'cause understood' }).expect(409);
      expect(again.body).toMatchObject({ error: 'four_eyes_pending', requestId: reqId });
      // The owner (not an approver) cannot approve, and the database refuses requester = approver.
      await approve(trader, reqId).expect(403);
      await expect(
        ownerQuery(`UPDATE four_eyes_requests SET status = 'approved', decided_by = requested_by, decided_at = now() WHERE id = $1`, [reqId]),
      ).rejects.toThrow(/four-eyes|four_eyes/);
      await request(http).post(`/governance/approvals/${reqId}/cancel`).set(bearer(riskB.token)).send({ note: 'not mine' }).expect(403);
      await request(http).post(`/governance/approvals/${reqId}/cancel`).set(bearer(trader.token)).send({ note: 'withdrawn to re-ask' }).expect(200);

      // A risk officer requests on the customer's behalf and tries to approve their own request.
      const byRisk = await request(http).post(`/kill-switch/resume?accountId=${acct}`).set(bearer(riskA.token)).send({ reason: 'reviewed with the customer' }).expect(202);
      const id2 = byRisk.body.pendingApproval.id as string;
      const self = await approve(riskA, id2).expect(403);
      expect(self.body.error).toBe('four_eyes');
      expect((await request(http).get('/kill-switch').set(bearer(trader.token))).body.halted).toBe(true);

      // A different risk officer approves: the account resumes and the audit names both people.
      const ok = await approve(riskB, id2).expect(200);
      expect(ok.body).toMatchObject({ status: 'approved', requestedBy: riskA.id, decidedBy: riskB.id, result: { resumed: true, accountId: acct } });
      expect((await request(http).get('/kill-switch').set(bearer(trader.token))).body.halted).toBe(false);
      const ev = await ownerQuery<{ payload: Record<string, string> }>(
        `SELECT payload FROM audit_events WHERE action = 'kill_switch.resumed' AND entity_id = $1 ORDER BY id DESC LIMIT 1`,
        [acct],
      );
      expect(ev[0]!.payload).toMatchObject({ fourEyesRequestId: id2, requestedBy: riskA.id, approvedBy: riskB.id, haltedBy: riskA.id });
      await approve(riskB, id2).expect(409);
    });

    it('a risk officer cannot approve the resume of their own account', async () => {
      const acct = await accountOf(traderRisk); // opens the paper account before the firm halt
      await request(http).post('/risk-console/kill-switch').set(bearer(riskA.token)).send({ scope: 'robots', reason: 'firm halt 2' }).expect(202);
      const asked = await request(http).post(`/kill-switch/resume?accountId=${acct}`).set(bearer(riskB.token)).send({ reason: 'resume desk' }).expect(202);
      const res = await approve(traderRisk, asked.body.pendingApproval.id).expect(403);
      expect(res.body.error).toBe('four_eyes');
      await approve(riskA, asked.body.pendingApproval.id).expect(200);
      // Clean up the other halted accounts of this global halt for later tests.
      await ownerQuery(`UPDATE accounts SET trading_halted = false, halt_scope = NULL, halted_at = NULL, halted_by = NULL, halt_reason = NULL WHERE trading_halted`);
    });
  });

  describe('limit loosening above the platform default', () => {
    it('same user cannot request and approve; a second risk officer applies it', async () => {
      const acct = await accountOf(trader);
      const before = (await request(http).get('/accounts/me').set(bearer(trader.token))).body.limits;
      expect(before.maxOrderNotional).toBe('1000000');
      // Not a loosening → refused.
      await request(http)
        .post('/governance/approvals')
        .set(bearer(trader.token))
        .send({ kind: 'limit_override', accountId: acct, limits: { maxOrderNotional: '900000' }, reason: 'wrong way' })
        .expect(400);
      // Guarded (novice) accounts cannot ask.
      const nacct = await accountOf(novice);
      await request(http)
        .post('/governance/approvals')
        .set(bearer(riskA.token))
        .send({ kind: 'limit_override', accountId: nacct, limits: { maxOrderNotional: '1500000' }, reason: 'novice' })
        .expect(403);
      // Another trader cannot ask for someone else's account.
      await request(http)
        .post('/governance/approvals')
        .set(bearer(other.token))
        .send({ kind: 'limit_override', accountId: acct, limits: { maxOrderNotional: '1500000' }, reason: 'not my account' })
        .expect(403);

      const created = await request(http)
        .post('/governance/approvals')
        .set(bearer(riskA.token))
        .send({ kind: 'limit_override', accountId: acct, limits: { maxOrderNotional: '1500000', maxLeverage: '40' }, reason: 'Professional client review (SIMULATED)' })
        .expect(201);
      const id = created.body.id as string;
      expect(created.body).toMatchObject({ kind: 'limit_override', status: 'pending', requestedBy: riskA.id, subjectId: acct });
      const self = await approve(riskA, id).expect(403);
      expect(self.body.error).toBe('four_eyes');
      expect((await request(http).get('/accounts/me').set(bearer(trader.token))).body.limits.maxOrderNotional).toBe('1000000');
      // The account holder cannot approve an override on their own account either.
      await approve(trader, id).expect(403);
      const ok = await approve(riskB, id).expect(200);
      expect(ok.body.result.limitOverrides).toEqual({ maxOrderNotional: '1500000', maxLeverage: '40' });
      const after = (await request(http).get('/accounts/me').set(bearer(trader.token))).body.limits;
      expect(after).toMatchObject({ maxOrderNotional: '1500000', maxLeverage: '40' });
      const audit = await ownerQuery<{ actor_id: string; payload: Record<string, string> }>(
        `SELECT actor_id, payload FROM audit_events WHERE action = 'account.limit_override_applied' AND entity_id = $1`,
        [acct],
      );
      expect(audit[0]).toMatchObject({ actor_id: riskB.id, payload: { requestId: id, requestedBy: riskA.id, approvedBy: riskB.id } });
      // The owner still tightens freely below the override.
      await request(http).put('/accounts/me/settings').set(bearer(trader.token)).send({ riskLimits: { maxOrderNotional: '500000' } }).expect(200);
      expect((await request(http).get('/accounts/me').set(bearer(trader.token))).body.limits.maxOrderNotional).toBe('500000');
    });

    it('rejections and listings: a rejecter cannot be the requester; non-approvers only see their own requests', async () => {
      const acct = await accountOf(trader);
      const created = await request(http)
        .post('/governance/approvals')
        .set(bearer(trader.token))
        .send({ kind: 'limit_override', accountId: acct, limits: { weeklyLossLimit: '20000' }, reason: 'My own request' })
        .expect(201);
      const mine = await request(http).get('/governance/approvals?status=pending').set(bearer(trader.token)).expect(200);
      expect(mine.body.requests.every((r: { requestedBy: string }) => r.requestedBy === trader.id)).toBe(true);
      const all = await request(http).get('/governance/approvals?status=pending').set(bearer(riskA.token)).expect(200);
      expect(all.body.requests.map((r: { id: string }) => r.id)).toContain(created.body.id);
      await request(http).post(`/governance/approvals/${created.body.id}/reject`).set(bearer(trader.token)).send({ note: 'self' }).expect(403);
      const rej = await request(http).post(`/governance/approvals/${created.body.id}/reject`).set(bearer(riskA.token)).send({ note: 'not justified' }).expect(200);
      expect(rej.body).toMatchObject({ status: 'rejected', decidedBy: riskA.id });
      await expect(ownerQuery(`UPDATE four_eyes_requests SET status = 'pending', decided_at = NULL WHERE id = $1`, [created.body.id])).rejects.toThrow(
        /already rejected/,
      );
      await expect(ownerQuery(`DELETE FROM four_eyes_requests WHERE id = $1`, [created.body.id])).rejects.toThrow(/cannot be deleted/);
    });
  });

  describe('robot promotion (goal 06 sign-off) and MFA reset (B-003)', () => {
    it('the robot owner cannot sign their own limits; another risk officer can', async () => {
      const s = await request(http).post('/strategies').set(bearer(traderRisk.token)).send({ definition: DEF }).expect(201);
      const r = await request(http).post('/robots').set(bearer(traderRisk.token)).send({ name: 'Four-eyes robot', versionId: s.body.latest.id }).expect(201);
      const robot = (await request(http).get(`/robots/${r.body.id}`).set(bearer(traderRisk.token)).expect(200)).body;
      const own = await request(http).post(`/robot-reviews/${r.body.id}/signoff`).set(bearer(traderRisk.token)).send({ limitsHash: robot.limitsHash, note: 'mine' }).expect(403);
      expect(own.body.error).toBe('four_eyes');
      await request(http).post(`/robot-reviews/${r.body.id}/signoff`).set(bearer(riskB.token)).send({ limitsHash: robot.limitsHash, note: 'independent review' }).expect(201);
      const pending = await request(http).get('/risk-console/approvals').set(bearer(riskA.token)).expect(200);
      expect(pending.body).toHaveProperty('robotSignoffs');
    });

    it('an admin cannot approve the MFA reset they requested; a second admin resets it and the user must re-enrol', async () => {
      const u = await createUser(app, 'trader');
      await request(http).post('/governance/approvals').set(bearer(adminA.token)).send({ kind: 'mfa_reset', userId: adminA.id, reason: 'lost phone' }).expect(403);
      await request(http).post('/governance/approvals').set(bearer(riskA.token)).send({ kind: 'mfa_reset', userId: u.id, reason: 'lost phone' }).expect(403);
      const created = await request(http).post('/governance/approvals').set(bearer(adminA.token)).send({ kind: 'mfa_reset', userId: u.id, reason: 'Lost phone, identity checked by support ticket T-1' }).expect(201);
      expect((await approve(adminA, created.body.id).expect(403)).body.error).toBe('four_eyes');
      await approve(u, created.body.id).expect(403);
      await approve(adminB, created.body.id).expect(200);
      expect(await ownerQuery('SELECT 1 FROM user_mfa WHERE user_id = $1', [u.id])).toHaveLength(0);
      const l = await request(http).post('/auth/login').set(CSRF).send({ email: u.email, password: 'correct-horse-battery-staple' }).expect(200);
      expect(l.body.status).toBe('mfa_enrollment_required');
      await login(app, u.email);
    });
  });
});

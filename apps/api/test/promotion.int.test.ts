import type { INestApplication } from '@nestjs/common';
import { DEFAULT_ROBOT_LIMITS, TREND_X, type StrategyDefinition } from '@kora/domain';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { base32Decode, totp } from '../src/auth/totp';
import {
  bearer,
  createUser,
  login,
  nextTotpWindow,
  ownerQuery,
  startApp,
  type TestUser,
} from './helpers';

const DEF: StrategyDefinition = {
  ...TREND_X,
  name: 'Promo',
  universe: { symbols: ['BTCUSD'], timeframe: '1h' },
  filters: [],
};

/**
 * Goal 06 acceptance: "Promotion is impossible without every checklist item and a different user's
 * risk sign-off (RBAC test)." LIVE_TRADING_ENABLED=false keeps it blocked, but it is recorded.
 */
describe('promote-to-LIVE workflow (four-eyes, TOTP, LIVE flag)', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let owner: TestUser;
  let ownerRisk: TestUser; // a trader who is also a risk officer (cannot sign their own robot)
  let risk: TestUser;
  let novice: TestUser;
  let robotId: string;
  let ownRobot: string;

  const code = (u: TestUser) => {
    nextTotpWindow();
    return totp(base32Decode(u.secret!));
  };
  const promote = (u: TestUser, id: string, totpCode: string) =>
    request(http).post(`/robots/${id}/promote`).set(bearer(u.token)).send({ totpCode });

  async function robotFor(u: TestUser): Promise<string> {
    const s = await request(http)
      .post('/strategies')
      .set(bearer(u.token))
      .send({ definition: DEF })
      .expect(201);
    const r = await request(http)
      .post('/robots')
      .set(bearer(u.token))
      .send({ name: 'Promo robot', versionId: s.body.latest.id })
      .expect(201);
    return r.body.id as string;
  }

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    app = await startApp();
    http = app.getHttpServer();
    owner = await createUser(app, 'trader');
    ownerRisk = await createUser(app, 'trader', ['risk_officer']);
    risk = await createUser(app, 'novice', ['risk_officer']);
    novice = await createUser(app, 'novice');
    robotId = await robotFor(owner);
    ownRobot = await robotFor(ownerRisk);
  });
  afterAll(async () => {
    await app.close();
    vi.useRealTimers();
  });

  it('novices cannot reach robots or promotion; traders cannot sign risk limits', async () => {
    await request(http).get(`/robots/${robotId}/promotion`).set(bearer(novice.token)).expect(403);
    await request(http)
      .post(`/robots/${robotId}/promote`)
      .set(bearer(novice.token))
      .send({ totpCode: '000000' })
      .expect(403);
    const r = await request(http).get(`/robots/${robotId}`).set(bearer(owner.token)).expect(200);
    await request(http)
      .post(`/robot-reviews/${robotId}/signoff`)
      .set(bearer(owner.token))
      .send({ limitsHash: r.body.limitsHash, note: 'self' })
      .expect(403);
  });

  it('shows every checklist item failing with its evidence; a bad TOTP code is refused', async () => {
    const v = await request(http)
      .get(`/robots/${robotId}/promotion`)
      .set(bearer(owner.token))
      .expect(200);
    expect(v.body.items.map((i: { id: string; pass: boolean }) => [i.id, i.pass])).toEqual([
      ['oos_sharpe', false],
      ['oos_trades', false],
      ['oos_length', false],
      ['holdout_dsr', false],
      ['paper_tracking', false],
      ['risk_signoff', false],
    ]);
    expect(v.body.liveTradingEnabled).toBe(false);
    const bad = await promote(owner, robotId, '000000').expect(403);
    expect(bad.body.error).toBe('mfa_failed');
    const blocked = await promote(owner, robotId, code(owner)).expect(409);
    expect(blocked.body.error).toBe('checklist_incomplete');
    const rec = await ownerQuery<{ outcome: string; mfa_verified: boolean }>(
      'SELECT outcome, mfa_verified FROM robot_promotions WHERE robot_id = $1',
      [robotId],
    );
    expect(rec).toEqual([{ outcome: 'blocked_checklist', mfa_verified: true }]);
    // Another trader cannot request it.
    await promote(ownerRisk, robotId, code(ownerRisk)).expect(403);
  });

  it('four-eyes: an owner who is a risk officer cannot sign their own robot (API and database)', async () => {
    const r = await request(http)
      .get(`/robots/${ownRobot}`)
      .set(bearer(ownerRisk.token))
      .expect(200);
    const res = await request(http)
      .post(`/robot-reviews/${ownRobot}/signoff`)
      .set(bearer(ownerRisk.token))
      .send({ limitsHash: r.body.limitsHash, note: 'my own' })
      .expect(403);
    expect(res.body.error).toBe('four_eyes');
    await expect(
      ownerQuery(
        'INSERT INTO robot_risk_signoffs (robot_id, limits_hash, signed_by, note) VALUES ($1, $2, $3, $4)',
        [ownRobot, r.body.limitsHash, ownerRisk.id, 'bypass'],
      ),
    ).rejects.toThrow(/four-eyes/);
    await expect(
      ownerQuery(
        'INSERT INTO robot_risk_signoffs (robot_id, limits_hash, signed_by, note) VALUES ($1, $2, $3, $4)',
        [ownRobot, r.body.limitsHash, owner.id, 'not a risk officer'],
      ),
    ).rejects.toThrow(/only a risk officer/);
  });

  it('IRTC re-verify R1-02: a risk officer whose role the robot owner requested cannot sign that robot', async () => {
    const ownerAdmin = await createUser(app, 'trader', ['admin']);
    const adminB = await createUser(app, 'novice', ['admin']);
    const puppet = await createUser(app, 'novice');
    const g = await request(http)
      .put(`/admin/users/${puppet.id}/roles`)
      .set(bearer(ownerAdmin.token))
      .send({ roles: ['novice', 'risk_officer'], reason: 'second-line reviewer' })
      .expect(202);
    await request(http)
      .post(`/governance/approvals/${g.body.requestId}/approve`)
      .set(bearer(adminB.token))
      .send({ note: 'reviewed' })
      .expect(200);
    const p = { ...puppet, ...(await login(app, puppet.email)) };
    const adminRobot = await robotFor(ownerAdmin);
    const d = await request(http)
      .get(`/robots/${adminRobot}`)
      .set(bearer(ownerAdmin.token))
      .expect(200);
    const res = await request(http)
      .post(`/robot-reviews/${adminRobot}/signoff`)
      .set(bearer(p.token))
      .send({ limitsHash: d.body.limitsHash, note: 'looks fine to me' })
      .expect(403);
    expect(res.body.error).toBe('approver_not_independent');
    // A sign-off row written behind the API by such a signer does not satisfy the checklist either.
    await ownerQuery(
      'INSERT INTO robot_risk_signoffs (robot_id, limits_hash, signed_by, note) VALUES ($1, $2, $3, $4)',
      [adminRobot, d.body.limitsHash, puppet.id, 'behind the API'],
    );
    const v = await request(http)
      .get(`/robots/${adminRobot}/promotion`)
      .set(bearer(ownerAdmin.token))
      .expect(200);
    expect(v.body.items.find((i: { id: string }) => i.id === 'risk_signoff').pass).toBe(false);
  });

  it('with every item evidenced and a different risk officer’s sign-off, promotion is still refused while LIVE is disabled, and recorded', async () => {
    const detail = await request(http)
      .get(`/robots/${robotId}`)
      .set(bearer(owner.token))
      .expect(200);
    const stale = await request(http)
      .post(`/robot-reviews/${robotId}/signoff`)
      .set(bearer(risk.token))
      .send({ limitsHash: 'a'.repeat(64), note: 'reviewed' })
      .expect(409);
    expect(stale.body.error).toBe('limits_changed');
    await request(http)
      .post(`/robot-reviews/${robotId}/signoff`)
      .set(bearer(risk.token))
      .send({ limitsHash: detail.body.limitsHash, note: 'Limits reviewed' })
      .expect(201);
    // Evidence (inserted as the owner of the schema, as a completed backtest and 30 tracked days would).
    const r = (
      await ownerQuery<{ strategy_id: string; version_id: string }>(
        'SELECT strategy_id, version_id FROM robots WHERE id = $1',
        [robotId],
      )
    )[0]!;
    const insertRun = (summary: Record<string, unknown>, eligible: boolean) =>
      ownerQuery(
        `INSERT INTO backtest_runs (strategy_id, version_id, user_id, kind, request, summary, result, gate_eligible)
         VALUES ($1, $2, $3, 'backtest', '{}', $4, '{}', $5)`,
        [r.strategy_id, r.version_id, owner.id, JSON.stringify(summary), eligible],
      );
    const passes = async () =>
      (
        await request(http).get(`/robots/${robotId}/promotion`).set(bearer(owner.token)).expect(200)
      ).body.items.map((i: { id: string; pass: boolean }) => [i.id, i.pass]);
    // IRTC R3-02: a tuned run (custom split, zero spread, ...) is not evidence, however good it looks.
    await insertRun(
      {
        oosSharpe: 5.8,
        oosTrades: 400,
        oosPeriodSharpe: 0.5,
        oosObservations: 200,
        oosSkew: 0,
        oosKurtosis: 3,
      },
      false,
    );
    expect(Object.fromEntries(await passes())).toMatchObject({
      oos_sharpe: false,
      oos_trades: false,
      oos_length: false,
      holdout_dsr: false,
    });
    // A noise-level holdout: high point Sharpe on 50 days fails the length and the deflated test.
    await insertRun(
      {
        oosSharpe: 4.28,
        oosTrades: 150,
        oosPeriodSharpe: 4.28 / Math.sqrt(365),
        oosObservations: 50,
        oosSkew: 0,
        oosKurtosis: 3,
      },
      true,
    );
    expect(Object.fromEntries(await passes())).toMatchObject({
      oos_sharpe: true,
      oos_trades: true,
      oos_length: false,
      holdout_dsr: false,
    });
    await insertRun(
      {
        oosSharpe: 1.2,
        oosTrades: 150,
        oosPeriodSharpe: 0.3,
        oosObservations: 120,
        oosSkew: 0,
        oosKurtosis: 3,
      },
      true,
    );
    let v = await request(http)
      .get(`/robots/${robotId}/promotion`)
      .set(bearer(owner.token))
      .expect(200);
    expect(v.body.items.map((i: { pass: boolean }) => i.pass)).toEqual([
      true,
      true,
      true,
      true,
      false,
      true,
    ]);
    expect(v.body.items.find((i: { id: string }) => i.id === 'holdout_dsr').evidence).toMatchObject(
      {
        trials: 1,
        threshold: '0.95',
      },
    );
    await expect(promote(owner, robotId, code(owner)).expect(409)).resolves.toMatchObject({
      body: { error: 'checklist_incomplete' },
    });
    await ownerQuery(
      `UPDATE robots SET paper_started_at = now() - interval '31 days' WHERE id = $1`,
      [robotId],
    );
    await ownerQuery(
      `INSERT INTO robot_tracking (robot_id, day, version_id, live_return, backtest_return, tracking_error)
       SELECT $1, (current_date - g), $2, 0.001, 0.0012, 0.0002 FROM generate_series(1, 30) g`,
      [robotId, r.version_id],
    );
    v = await request(http)
      .get(`/robots/${robotId}/promotion`)
      .set(bearer(owner.token))
      .expect(200);
    expect(v.body.complete).toBe(true);
    expect(v.body.blockedReason).toMatch(/LIVE_TRADING_ENABLED=false/);
    const res = await promote(owner, robotId, code(owner)).expect(409);
    expect(res.body.error).toBe('live_trading_disabled');
    const rec = await ownerQuery<{ outcome: string }>(
      'SELECT outcome FROM robot_promotions WHERE robot_id = $1 ORDER BY created_at',
      [robotId],
    );
    expect(rec.map((x) => x.outcome)).toEqual([
      'blocked_checklist',
      'blocked_checklist',
      'blocked_live_disabled',
    ]);
    const audit = await ownerQuery<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM audit_events WHERE action = 'robot.promotion_blocked' AND entity_id = $1 ORDER BY id DESC LIMIT 1`,
      [robotId],
    );
    expect(audit[0]!.payload).toMatchObject({
      outcome: 'blocked_live_disabled',
      liveTradingEnabled: false,
      mfaVerified: true,
      failed: [],
    });
    const mode = await ownerQuery<{ mode: string }>('SELECT mode FROM robots WHERE id = $1', [
      robotId,
    ]);
    expect(mode[0]!.mode).toBe('PAPER');
    await expect(
      ownerQuery(`UPDATE robots SET mode = 'LIVE' WHERE id = $1`, [robotId]),
    ).rejects.toThrow(/PAPER only/);
  });

  it('changing the limits invalidates the sign-off', async () => {
    await request(http)
      .put(`/robots/${robotId}/limits`)
      .set(bearer(owner.token))
      .send({ limits: { ...DEFAULT_ROBOT_LIMITS, maxDrawdownPct: 8 }, reason: 'tighter' })
      .expect(200);
    const v = await request(http)
      .get(`/robots/${robotId}/promotion`)
      .set(bearer(owner.token))
      .expect(200);
    expect(v.body.items.find((i: { id: string }) => i.id === 'risk_signoff').pass).toBe(false);
    const review = await request(http)
      .get(`/robot-reviews/${robotId}`)
      .set(bearer(risk.token))
      .expect(200);
    expect(review.body.robot.limits.maxDrawdownPct).toBe(8);
  });
});

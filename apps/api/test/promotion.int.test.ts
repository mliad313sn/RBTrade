import type { INestApplication } from '@nestjs/common';
import { DEFAULT_ROBOT_LIMITS, TREND_X, type StrategyDefinition } from '@kora/domain';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { base32Decode, totp } from '../src/auth/totp';
import { bearer, createUser, nextTotpWindow, ownerQuery, startApp, type TestUser } from './helpers';

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
    await ownerQuery(
      `INSERT INTO backtest_runs (strategy_id, version_id, user_id, kind, request, summary, result) VALUES ($1, $2, $3, 'backtest', '{}', $4, '{}')`,
      [r.strategy_id, r.version_id, owner.id, JSON.stringify({ oosSharpe: 1.2, oosTrades: 150 })],
    );
    let v = await request(http)
      .get(`/robots/${robotId}/promotion`)
      .set(bearer(owner.token))
      .expect(200);
    expect(v.body.items.map((i: { pass: boolean }) => i.pass)).toEqual([true, true, false, true]);
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

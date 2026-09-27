import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { QuestionnaireService } from '../src/appropriateness/questionnaire.service';
import { base32Decode, totp } from '../src/auth/totp';
import {
  appQuery,
  bearer,
  CSRF,
  failingAnswers,
  nextTotpWindow,
  ownerQuery,
  passingAnswers,
  PASSWORD,
  riskWarningAck,
  startApp,
  uniqueEmail,
} from './helpers';

/** B-018 (Sponsor decision OQ-S2): no self-service trader; appropriateness assessment gates it. */
describe('appropriateness assessment and the questionnaire engine', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;

  beforeAll(async () => {
    process.env.KORA_ENGINE_ENABLED = 'false';
    process.env.KORA_RECONCILIATION_INTERVAL_MS = '0';
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    app = await startApp();
    http = app.getHttpServer();
  });
  afterAll(async () => {
    await app.close();
    vi.useRealTimers();
    delete process.env.KORA_ENGINE_ENABLED;
    delete process.env.KORA_RECONCILIATION_INTERVAL_MS;
    delete process.env.KORA_APPROPRIATENESS_COOLDOWN_MINUTES;
    delete process.env.KORA_APPROPRIATENESS_PASS_MARK_PCT;
  });

  async function novice() {
    const email = uniqueEmail('appr');
    await request(http)
      .post('/auth/signup')
      .set(CSRF)
      .send({ email, password: PASSWORD, displayName: 'A' })
      .expect(201);
    const l = await request(http)
      .post('/auth/login')
      .set(CSRF)
      .send({ email, password: PASSWORD })
      .expect(200);
    expect(l.body.status).toBe('ok');
    const token = l.body.accessToken as string;
    return { id: l.body.user.id as string, email, token, rw: await riskWarningAck(app, token) };
  }

  it('serves the versioned SIMULATED questionnaire without the answer key', async () => {
    const u = await novice();
    const res = await request(http)
      .get('/appropriateness/questionnaire')
      .set(bearer(u.token))
      .expect(200);
    expect(res.body.questionnaire).toMatchObject({
      id: 'appropriateness',
      version: 1,
      kind: 'appropriateness',
      simulated: true,
      reviewStatus: 'placeholder_pending_compliance_review',
      passMarkPct: 75,
      cooldownMinutes: 1440,
    });
    expect(res.body.questionnaire.questions).toHaveLength(8);
    expect(JSON.stringify(res.body)).not.toContain('"points"');
    expect(res.body.status).toEqual({
      hasTraderRole: false,
      eligible: true,
      cooldownUntil: null,
      lastAttempt: null,
    });
    const stored = await ownerQuery<{ checksum: string; simulated: boolean }>(
      `SELECT checksum, simulated FROM questionnaires WHERE id = 'appropriateness' AND version = 1`,
    );
    expect(stored[0]).toMatchObject({ simulated: true });
    await request(http).get('/appropriateness/questionnaire').expect(401);
  });

  it('a fail starts a cool-down, is audited with version and score, and never stores the answers', async () => {
    const u = await novice();
    const res = await request(http)
      .post('/appropriateness/attempts')
      .set(bearer(u.token))
      .send({
        riskWarning: u.rw,
        questionnaireId: 'appropriateness',
        version: 1,
        answers: failingAnswers(),
      })
      .expect(200);
    expect(res.body).toMatchObject({
      passed: false,
      scorePct: 0,
      passMarkPct: 75,
      cooldownUntil: expect.any(String),
      topicsToReview: expect.arrayContaining(['Leverage', 'Stop orders and gaps']),
    });
    const again = await request(http)
      .post('/appropriateness/attempts')
      .set(bearer(u.token))
      .send({
        riskWarning: u.rw,
        questionnaireId: 'appropriateness',
        version: 1,
        answers: passingAnswers(),
      })
      .expect(429);
    expect(again.body).toMatchObject({ error: 'cooldown', cooldownUntil: res.body.cooldownUntil });
    const status = await request(http)
      .get('/appropriateness/questionnaire')
      .set(bearer(u.token))
      .expect(200);
    expect(status.body.status).toMatchObject({
      eligible: false,
      cooldownUntil: res.body.cooldownUntil,
      lastAttempt: { version: 1, scorePct: 0, passed: false },
    });
    const audit = await request(http)
      .get('/audit?action=appropriateness.failed')
      .set(bearer(u.token))
      .expect(200);
    expect(audit.body.events[0].payload).toMatchObject({
      questionnaireId: 'appropriateness',
      version: 1,
      score: 0,
      maxScore: 8,
      scorePct: 0,
      passMarkPct: 75,
      simulatedQuestions: true,
    });
    expect(JSON.stringify(audit.body.events[0].payload)).not.toMatch(/answers|"a"|"b"/);
    const cols = await ownerQuery<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'questionnaire_attempts'`,
    );
    expect(cols.map((c) => c.column_name)).not.toContain('answers');
    // The runtime role cannot rewrite history.
    await expect(appQuery('UPDATE questionnaire_attempts SET passed = true')).rejects.toMatchObject(
      { code: '42501' },
    );
    // Cool-down is configurable: 0 minutes lets the user retry and pass.
    process.env.KORA_APPROPRIATENESS_COOLDOWN_MINUTES = '0';
    const pass = await request(http)
      .post('/appropriateness/attempts')
      .set(bearer(u.token))
      .send({
        riskWarning: u.rw,
        questionnaireId: 'appropriateness',
        version: 1,
        answers: passingAnswers(),
      })
      .expect(200);
    expect(pass.body.passed).toBe(true);
    delete process.env.KORA_APPROPRIATENESS_COOLDOWN_MINUTES;
  });

  it('a pass grants trader, signs the user out and forces TOTP enrolment at the next login', async () => {
    const u = await novice();
    await request(http).get('/robots/builder').set(bearer(u.token)).expect(403);
    const res = await request(http)
      .post('/appropriateness/attempts')
      .set(bearer(u.token))
      .send({
        riskWarning: u.rw,
        questionnaireId: 'appropriateness',
        version: 1,
        answers: passingAnswers(),
      })
      .expect(200);
    expect(res.body).toMatchObject({
      passed: true,
      scorePct: 100,
      roleGranted: 'trader',
      next: 'sign_in_again',
    });
    expect((res.headers['set-cookie'] as unknown as string[]).join(';')).toMatch(/kora_at=;/);
    const audit = await ownerQuery<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM audit_events WHERE action = 'appropriateness.passed' AND actor_id = $1`,
      [u.id],
    );
    expect(audit[0]!.payload).toMatchObject({
      questionnaireId: 'appropriateness',
      version: 1,
      score: 8,
      maxScore: 8,
      scorePct: 100,
      roleGranted: 'trader',
      mfaEnrolmentRequiredAtNextLogin: true,
    });

    const l = await request(http)
      .post('/auth/login')
      .set(CSRF)
      .send({ email: u.email, password: PASSWORD })
      .expect(200);
    expect(l.body.status).toBe('mfa_enrollment_required');
    const enr = await request(http)
      .post('/auth/mfa/enroll')
      .set(CSRF)
      .send({ mfaToken: l.body.mfaToken })
      .expect(200);
    nextTotpWindow();
    const v = await request(http)
      .post('/auth/mfa/verify')
      .set(CSRF)
      .send({ mfaToken: l.body.mfaToken, code: totp(base32Decode(enr.body.secret)) })
      .expect(200);
    const me = await request(http).get('/me').set(bearer(v.body.accessToken)).expect(200);
    expect(me.body).toMatchObject({
      roles: ['novice', 'trader'],
      mfa: true,
      preferences: { viewMode: 'pro' },
      capabilities: { robotBuilder: true },
    });
    await request(http).get('/robots/builder').set(bearer(v.body.accessToken)).expect(200);
    // Already a trader: no second attempt.
    await request(http)
      .post('/appropriateness/attempts')
      .set(bearer(v.body.accessToken))
      .send({
        riskWarning: u.rw,
        questionnaireId: 'appropriateness',
        version: 1,
        answers: passingAnswers(),
      })
      .expect(409);
  });

  it('validates attempts: every question answered, current version only, pass mark configurable', async () => {
    const u = await novice();
    const partial = passingAnswers();
    delete partial.leverage;
    const inc = await request(http)
      .post('/appropriateness/attempts')
      .set(bearer(u.token))
      .send({ riskWarning: u.rw, questionnaireId: 'appropriateness', version: 1, answers: partial })
      .expect(400);
    expect(inc.body).toMatchObject({ error: 'incomplete', missing: ['leverage'] });
    await request(http)
      .post('/appropriateness/attempts')
      .set(bearer(u.token))
      .send({
        riskWarning: u.rw,
        questionnaireId: 'appropriateness',
        version: 2,
        answers: passingAnswers(),
      })
      .expect(409);
    await request(http)
      .post('/appropriateness/attempts')
      .set(bearer(u.token))
      .send({
        riskWarning: u.rw,
        questionnaireId: 'appropriateness',
        version: 1,
        answers: passingAnswers(),
        score: 100,
      })
      .expect(400);
    // 7 of 8 = 87% passes at 75, fails at 90.
    const seven = { ...passingAnswers(), leverage: 'a' };
    process.env.KORA_APPROPRIATENESS_PASS_MARK_PCT = '90';
    const failed = await request(http)
      .post('/appropriateness/attempts')
      .set(bearer(u.token))
      .send({ riskWarning: u.rw, questionnaireId: 'appropriateness', version: 1, answers: seven })
      .expect(200);
    expect(failed.body).toMatchObject({
      passed: false,
      scorePct: 87,
      passMarkPct: 90,
      topicsToReview: ['Leverage'],
    });
    delete process.env.KORA_APPROPRIATENESS_PASS_MARK_PCT;
    // No attempt rows were written for the invalid submissions.
    const rows = await ownerQuery<{ n: string }>(
      'SELECT count(*)::text AS n FROM questionnaire_attempts WHERE user_id = $1',
      [u.id],
    );
    expect(rows[0]!.n).toBe('1');
  });

  it('published questionnaire versions are immutable (content change fails the sync)', async () => {
    await expect(
      ownerQuery(`UPDATE questionnaires SET title = 'x' WHERE id = 'appropriateness'`),
    ).rejects.toThrow(/immutable/);
    const svc = app.get(QuestionnaireService);
    await ownerQuery(`ALTER TABLE questionnaires DISABLE TRIGGER questionnaires_no_update`);
    try {
      await ownerQuery(
        `UPDATE questionnaires SET checksum = repeat('0', 64) WHERE id = 'appropriateness' AND version = 1`,
      );
      await expect(svc.sync()).rejects.toThrow(/changed after publication/);
    } finally {
      const def = svc.get('appropriateness')!;
      await ownerQuery(
        `UPDATE questionnaires SET checksum = $1 WHERE id = 'appropriateness' AND version = 1`,
        [QuestionnaireService.checksum(def)],
      );
      await ownerQuery(`ALTER TABLE questionnaires ENABLE TRIGGER questionnaires_no_update`);
    }
    await expect(svc.sync()).resolves.toBeUndefined();
  });
});

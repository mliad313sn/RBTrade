import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  bearer,
  CSRF,
  failingAnswers,
  ownerQuery,
  passingAnswers,
  PASSWORD,
  riskWarningAck,
  startApp,
  uniqueEmail,
} from './helpers';

describe('appropriateness: segregation of duties and sybil limits (IRTC R1-09, R1-11)', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  const saved = {
    signup: process.env.KORA_SIGNUP_RATE_LIMIT_PER_HOUR,
    attempts: process.env.KORA_APPROPRIATENESS_IP_LIMIT_PER_DAY,
  };
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
    for (const [k, v] of [
      ['KORA_SIGNUP_RATE_LIMIT_PER_HOUR', saved.signup],
      ['KORA_APPROPRIATENESS_IP_LIMIT_PER_DAY', saved.attempts],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  async function novice(ip: string) {
    const email = uniqueEmail('abuse');
    await request(http)
      .post('/auth/signup')
      .set(CSRF)
      .set('X-Forwarded-For', ip)
      .send({ email, password: PASSWORD, displayName: 'A' })
      .expect(201);
    const l = await request(http)
      .post('/auth/login')
      .set(CSRF)
      .set('X-Forwarded-For', ip)
      .send({ email, password: PASSWORD })
      .expect(200);
    return { id: l.body.user.id as string, token: l.body.accessToken as string };
  }
  const questionnaire = async (token: string) =>
    (await request(http).get('/appropriateness/questionnaire').set(bearer(token)).expect(200)).body;

  it('R1-09: an auditor passing the assessment gets a clean, audited 409 and keeps their roles', async () => {
    const u = await novice('192.0.2.140');
    await ownerQuery(`INSERT INTO user_roles (user_id, role) VALUES ($1, 'auditor')`, [u.id]);
    const q = await questionnaire(u.token);
    expect(q.status.eligible).toBe(false);
    const res = await request(http).post('/appropriateness/attempts').set(bearer(u.token)).send({
      questionnaireId: q.questionnaire.id,
      version: q.questionnaire.version,
      answers: passingAnswers(),
    });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: 'segregation_of_duties' });
    expect(res.body.message).toMatch(/auditor/);
    const roles = await ownerQuery<{ role: string }>(
      'SELECT role FROM user_roles WHERE user_id = $1 ORDER BY role',
      [u.id],
    );
    expect(roles.map((r) => r.role)).toEqual(['auditor', 'novice']);
    const attempts = await ownerQuery('SELECT 1 FROM questionnaire_attempts WHERE user_id = $1', [
      u.id,
    ]);
    expect(attempts).toHaveLength(0);
    const events = await ownerQuery<{ action: string }>(
      "SELECT action FROM audit_events WHERE actor_id = $1 AND action LIKE 'appropriateness.%'",
      [u.id],
    );
    expect(events.map((e) => e.action)).toEqual(['appropriateness.refused']);
  });

  it('R1-11: sign-up is limited per IP (10 per hour by default)', async () => {
    delete process.env.KORA_SIGNUP_RATE_LIMIT_PER_HOUR;
    try {
      const codes: number[] = [];
      for (let i = 0; i < 11; i++)
        codes.push(
          (
            await request(http)
              .post('/auth/signup')
              .set(CSRF)
              .set('X-Forwarded-For', '198.51.100.150')
              .send({ email: uniqueEmail('sybil'), password: PASSWORD, displayName: 'S' })
          ).status,
        );
      expect(codes.slice(0, 10).every((c) => c === 201)).toBe(true);
      expect(codes[10]).toBe(429);
    } finally {
      process.env.KORA_SIGNUP_RATE_LIMIT_PER_HOUR = saved.signup ?? '100000';
    }
  });

  it('R1-11: assessment attempts are limited per IP across accounts (10 per day by default), so a sybil cannot walk the answer key', async () => {
    const ip = '198.51.100.160';
    const users = [];
    for (let i = 0; i < 11; i++) users.push(await novice(`192.0.2.${150 + i}`));
    const q = await questionnaire(users[0]!.token);
    const riskWarning = await riskWarningAck(app, users[0]!.token); // IRTC R4-09: every attempt confirms the warning in force
    const attempt = (token: string, extra: Record<string, unknown>) =>
      request(http)
        .post('/appropriateness/attempts')
        .set(bearer(token))
        .set('X-Forwarded-For', ip)
        .send({
          questionnaireId: q.questionnaire.id,
          version: q.questionnaire.version,
          answers: failingAnswers(),
          ...extra,
        });
    delete process.env.KORA_APPROPRIATENESS_IP_LIMIT_PER_DAY;
    try {
      // The per-IP ceiling is a guard: it runs before body validation, so an invalid probe (here the
      // risk warning left out) still spends one of the 10 attempts and cannot be used to probe for free.
      const probe = await attempt(users[0]!.token, {});
      expect(probe.status).toBe(400);
      expect(probe.body).toMatchObject({ error: 'risk_warning_required' });
      const codes: number[] = [];
      for (const u of users.slice(1)) codes.push((await attempt(u.token, { riskWarning })).status);
      expect(codes.slice(0, 9).every((c) => c === 200)).toBe(true);
      expect(codes[9]).toBe(429); // 11th request from the IP: the invalid probe counted
      // Once over the ceiling, even a malformed body is refused with 429 before it is validated.
      expect((await attempt(users[10]!.token, { answers: 'nope' })).status).toBe(429);
      expect((await attempt(users[10]!.token, {})).status).toBe(429);
    } finally {
      process.env.KORA_APPROPRIATENESS_IP_LIMIT_PER_DAY = saved.attempts ?? '100000';
    }
  });
});

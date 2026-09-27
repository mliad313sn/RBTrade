// Goal 10 (S9): session and MFA hardening, security headers, CSRF, rate limits, fail-closed metrics.
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { base32Decode, totp } from '../src/auth/totp';
import { CSRF, PASSWORD, bearer, createUser, nextTotpWindow, ownerQuery, startApp } from './helpers';
import { listen, TestWs } from './ws-helpers';

describe('security hardening (goal 10)', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;

  beforeAll(async () => {
    app = await startApp();
    http = app.getHttpServer();
  });
  afterAll(async () => {
    await app?.close();
  });

  describe('server-side sessions', () => {
    it('logout revokes the bearer token server side', async () => {
      const u = await createUser(app, 'novice');
      await request(http).get('/me').set(bearer(u.token)).expect(200);
      await request(http).post('/auth/logout').set(bearer(u.token)).expect(200);
      const after = await request(http).get('/me').set(bearer(u.token)).expect(401);
      expect(after.body.error).toBe('session_revoked');
      const audit = await ownerQuery<{ n: number }>(`SELECT count(*)::int AS n FROM revoked_tokens WHERE user_id = $1 AND reason = 'logout'`, [u.id]);
      expect(audit[0]!.n).toBe(1);
    });

    it('a revoked session cannot open a WebSocket either', async () => {
      const urls = await listen(app);
      const u = await createUser(app, 'novice');
      const ok = await TestWs.authed(urls.ws, u.token);
      ok.ws.close();
      await request(http).post('/auth/logout').set(bearer(u.token)).expect(200);
      const s = await TestWs.open(urls.ws);
      s.send({ op: 'auth', token: u.token });
      expect(await s.waitClose()).toMatchObject({ code: 4401, reason: 'session revoked' });
    });

    it('an admin role change ends the target user’s older sessions', async () => {
      const admin = await createUser(app, 'novice', ['admin']);
      const t = await createUser(app, 'novice', ['quant']);
      await request(http).get('/strategies').set(bearer(t.token)).expect(200);
      await request(http).put(`/admin/users/${t.id}/roles`).set(bearer(admin.token)).send({ roles: ['novice'] }).expect(200);
      expect((await request(http).get('/strategies').set(bearer(t.token)).expect(401)).body.error).toBe('session_revoked');
    });

    it('a disabled user’s token is refused', async () => {
      const u = await createUser(app, 'trader');
      await ownerQuery(`UPDATE users SET status = 'disabled' WHERE id = $1`, [u.id]);
      expect((await request(http).get('/me').set(bearer(u.token)).expect(401)).body.error).toBe('session_revoked');
    });

    it('the session cookie is HttpOnly and SameSite=Strict', async () => {
      const u = await createUser(app, 'novice');
      const res = await request(http).post('/auth/login').set(CSRF).send({ email: u.email, password: PASSWORD }).expect(200);
      expect(String(res.headers['set-cookie'])).toMatch(/kora_at=.*HttpOnly.*SameSite=Strict/i);
    });
  });

  describe('MFA recovery codes (B-902)', () => {
    it('enrolment returns 10 one-time codes; a code signs in once; regeneration needs TOTP and voids old codes', async () => {
      const u = await createUser(app, 'novice');
      // opt in to TOTP (B-017) to reach enrolment with recovery codes
      const opt = await request(http).post('/auth/mfa/opt-in').set(bearer(u.token));
      expect(opt.status, JSON.stringify(opt.body)).toBeLessThan(300);
      const mfaToken = opt.body.mfaToken as string;
      const secret = opt.body.secret as string;
      nextTotpWindow();
      const v = await request(http).post('/auth/mfa/verify').set(CSRF).send({ mfaToken, code: totp(base32Decode(secret)) }).expect(200);
      const codes = v.body.recoveryCodes as string[];
      expect(codes).toHaveLength(10);
      expect(new Set(codes).size).toBe(10);
      const stored = await ownerQuery<{ code_hash: string }>('SELECT code_hash FROM mfa_recovery_codes WHERE user_id = $1', [u.id]);
      expect(stored).toHaveLength(10);
      expect(stored.map((s) => s.code_hash)).not.toContain(codes[0]); // never in clear

      const signIn = async () => (await request(http).post('/auth/login').set(CSRF).send({ email: u.email, password: PASSWORD }).expect(200)).body.mfaToken as string;
      const t1 = await signIn(); // supertest re-listens per request: never nest two
      const r = await request(http).post('/auth/mfa/recovery').set(CSRF).send({ mfaToken: t1, recoveryCode: codes[0]!.toLowerCase() }).expect(200);
      expect(r.body.remaining).toBe(9);
      await request(http).get('/me').set(bearer(r.body.accessToken)).expect(200);
      // one-time
      const t2 = await signIn(); // supertest re-listens per request: never nest two
      const again = await request(http).post('/auth/mfa/recovery').set(CSRF).send({ mfaToken: t2, recoveryCode: codes[0] }).expect(401);
      expect(again.body.error).toBe('invalid_code');
      expect((await request(http).get('/auth/mfa/recovery-codes').set(bearer(r.body.accessToken)).expect(200)).body.remaining).toBe(9);

      // regeneration: wrong TOTP refused, right TOTP issues a fresh batch and voids the old one
      await request(http).post('/auth/mfa/recovery-codes').set(bearer(r.body.accessToken)).send({ code: '000000' }).expect(401);
      nextTotpWindow();
      const regen = await request(http).post('/auth/mfa/recovery-codes').set(bearer(r.body.accessToken)).send({ code: totp(base32Decode(secret)) }).expect(200);
      expect(regen.body.recoveryCodes).toHaveLength(10);
      const t3 = await signIn(); // supertest re-listens per request: never nest two
      await request(http).post('/auth/mfa/recovery').set(CSRF).send({ mfaToken: t3, recoveryCode: codes[1] }).expect(401);
      const t4 = await signIn(); // supertest re-listens per request: never nest two
      await request(http).post('/auth/mfa/recovery').set(CSRF).send({ mfaToken: t4, recoveryCode: regen.body.recoveryCodes[0] }).expect(200);
      const actions = await ownerQuery<{ action: string }>(
        `SELECT action FROM audit_events WHERE actor_id = $1 AND action LIKE 'auth.recovery%' OR (actor_id = $1 AND action = 'auth.mfa_recovery_used') ORDER BY id`,
        [u.id],
      );
      expect(actions.map((a) => a.action)).toEqual(['auth.recovery_codes_issued', 'auth.mfa_recovery_used', 'auth.recovery_codes_issued', 'auth.mfa_recovery_used']);
      const payloads = await ownerQuery<{ payload: string }>(`SELECT payload::text FROM audit_events WHERE actor_id = $1`, [u.id]);
      for (const c of [...codes, ...(regen.body.recoveryCodes as string[])]) expect(payloads.some((p) => p.payload.includes(c))).toBe(false);
    });

    it('a recovery code cannot replace the password step and malformed codes are refused', async () => {
      await request(http).post('/auth/mfa/recovery').set(CSRF).send({ mfaToken: 'x'.repeat(20), recoveryCode: 'ABCDE-23456' }).expect(401);
      await request(http).post('/auth/mfa/recovery').set(CSRF).send({ mfaToken: 'x'.repeat(20), recoveryCode: 'not a code' }).expect(400);
    });
  });

  describe('headers, CSRF, rate limits', () => {
    it('API responses carry the security headers and no x-powered-by', async () => {
      const res = await request(http).get('/health');
      expect(res.headers['content-security-policy']).toContain("default-src 'none'");
      expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['strict-transport-security']).toMatch(/max-age=\d+/);
      expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['x-powered-by']).toBeUndefined();
    });

    it('CSRF: a cookie-authenticated unsafe request needs x-kora-csrf; a bearer request does not', async () => {
      const u = await createUser(app, 'trader');
      const cookie = `kora_at=${u.token}`;
      const refused = await request(http).post('/kill-switch').set('Cookie', cookie).send({ scope: 'robots', source: 'rest_fallback' }).expect(403);
      expect(refused.body.error).toBe('csrf');
      await request(http).post('/kill-switch').set('Cookie', cookie).set(CSRF).send({ scope: 'robots', source: 'rest_fallback' }).expect(202);
      await request(http).post('/kill-switch/resume').set(bearer(u.token)).send({ reason: 'csrf test done' }).expect(200);
    });

    it('rate limits: sign-in and order endpoints answer 429 over the limit', async () => {
      const before = { auth: process.env.KORA_AUTH_RATE_LIMIT, order: process.env.KORA_ORDER_RATE_LIMIT };
      const u = await createUser(app, 'novice');
      try {
        process.env.KORA_AUTH_RATE_LIMIT = '3';
        const codes: number[] = [];
        for (let i = 0; i < 5; i++) codes.push((await request(http).post('/auth/login').set(CSRF).set('X-Forwarded-For', '198.51.100.9').send({ email: 'nobody@test.kora.local', password: 'wrong-password-xyz' })).status);
        expect(codes.slice(0, 3).every((c) => c === 401)).toBe(true);
        expect(codes.slice(3)).toEqual([429, 429]);
        process.env.KORA_ORDER_RATE_LIMIT = '2';
        const orderCodes: number[] = [];
        for (let i = 0; i < 4; i++) orderCodes.push((await request(http).post('/orders/preview').set(bearer(u.token)).set('X-Forwarded-For', '198.51.100.10').send({})).status);
        expect(orderCodes.slice(2)).toEqual([429, 429]);
      } finally {
        process.env.KORA_AUTH_RATE_LIMIT = before.auth;
        process.env.KORA_ORDER_RATE_LIMIT = before.order;
      }
    });

    it('metrics fail closed outside dev/test when no token is configured', async () => {
      const env = process.env.KORA_ENV;
      const token = process.env.KORA_METRICS_TOKEN;
      try {
        delete process.env.KORA_METRICS_TOKEN;
        process.env.KORA_ENV = 'staging';
        await request(http).get('/metrics').expect(401);
        process.env.KORA_METRICS_TOKEN = 'metrics-test-token-0123456789';
        await request(http).get('/metrics').expect(401);
        await request(http).get('/metrics').set('Authorization', 'Bearer metrics-test-token-0123456789').expect(200);
      } finally {
        process.env.KORA_ENV = env;
        if (token === undefined) delete process.env.KORA_METRICS_TOKEN;
        else process.env.KORA_METRICS_TOKEN = token;
      }
    });
  });
});

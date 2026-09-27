import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { base32Decode, totp } from '../src/auth/totp';
import { bearer, createUser, CSRF, nextTotpWindow, ownerQuery, PASSWORD, startApp, uniqueEmail } from './helpers';

/**
 * IRTC R1-01, R1-04, R1-07: brute-force protection of the password step and the second factor.
 * Policy (docs/open-questions.md OQ-R1-1, decided by the Product Owner under delegated Sponsor authority):
 * - second factor: 5 consecutive failures (TOTP, recovery code or step-up) lock it; only a
 *   successful second factor resets the count, never a correct password;
 * - password: progressive back-off per (e-mail, IP) and per e-mail, identical for existing and
 *   unknown accounts (no enumeration), never a hard lock that refuses the owner on a known device.
 */
const wrong = (secret: string): string => {
  const key = base32Decode(secret);
  const valid = new Set([-1, 0, 1].map((o) => totp(key, Date.now() + o * 30_000)));
  for (let c = 0; ; c++) {
    const s = String((Number(totp(key)) + 500_000 + c) % 1_000_000).padStart(6, '0');
    if (!valid.has(s)) return s;
  }
};

describe('brute-force protection (IRTC R1-01, R1-04, R1-07)', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    app = await startApp();
    http = app.getHttpServer();
  });
  afterAll(async () => {
    await app.close();
    vi.useRealTimers();
  });

  const passwordStep = async (email: string, ip = '192.0.2.10', password = PASSWORD) =>
    request(http).post('/auth/login').set(CSRF).set('X-Forwarded-For', ip).send({ email, password });

  describe('R1-01: second-factor lockout', () => {
    it('27 wrong TOTP codes over 3 password cycles lock the second factor; the right code is then refused', async () => {
      const u = await createUser(app, 'trader');
      const statuses: number[] = [];
      for (let cycle = 0; cycle < 3; cycle++) {
        const pw = await passwordStep(u.email);
        expect(pw.status).toBe(200);
        expect(pw.body.status).toBe('mfa_required');
        for (let i = 0; i < 9; i++) {
          const r = await request(http).post('/auth/mfa/verify').set(CSRF).send({ mfaToken: pw.body.mfaToken, code: wrong(u.secret!) });
          statuses.push(r.status);
        }
      }
      // the first four are plain failures, the fifth locks, every later attempt is refused as locked
      expect(statuses.slice(0, 4)).toEqual([401, 401, 401, 401]);
      expect(statuses.slice(5).every((s) => s === 403)).toBe(true);
      const [row] = await ownerQuery<{ mfa_failed_count: number; locked: boolean }>(
        'SELECT mfa_failed_count, locked_until > $2 AS locked FROM users WHERE id = $1',
        [u.id, new Date()],
      );
      expect(row!.locked).toBe(true);
      expect(row!.mfa_failed_count).toBeGreaterThanOrEqual(5);

      nextTotpWindow();
      const pw = await passwordStep(u.email);
      const good = await request(http).post('/auth/mfa/verify').set(CSRF).send({ mfaToken: pw.body.mfaToken, code: totp(base32Decode(u.secret!)) });
      expect(good.status).toBe(403);
      expect(good.body.error).toBe('mfa_locked');
      // the recovery-code path is locked too
      const rec = await request(http).post('/auth/mfa/recovery').set(CSRF).send({ mfaToken: pw.body.mfaToken, recoveryCode: 'ABCDE-FGHJK' });
      expect(rec.status).toBe(403);
    });

    it('a correct password never resets the second-factor failure count', async () => {
      const u = await createUser(app, 'trader');
      let pw = await passwordStep(u.email);
      for (let i = 0; i < 4; i++) await request(http).post('/auth/mfa/verify').set(CSRF).send({ mfaToken: pw.body.mfaToken, code: wrong(u.secret!) }).expect(401);
      pw = await passwordStep(u.email); // correct password
      expect(pw.status).toBe(200);
      const fifth = await request(http).post('/auth/mfa/verify').set(CSRF).send({ mfaToken: pw.body.mfaToken, code: wrong(u.secret!) });
      expect(fifth.status).toBe(403);
      expect(fifth.body.error).toBe('mfa_locked');
    });

    it('a successful second factor resets the count; the lock expires and doubles on renewal', async () => {
      const u = await createUser(app, 'trader');
      let pw = await passwordStep(u.email);
      for (let i = 0; i < 4; i++) await request(http).post('/auth/mfa/verify').set(CSRF).send({ mfaToken: pw.body.mfaToken, code: wrong(u.secret!) }).expect(401);
      nextTotpWindow();
      await request(http).post('/auth/mfa/verify').set(CSRF).send({ mfaToken: pw.body.mfaToken, code: totp(base32Decode(u.secret!)) }).expect(200);
      pw = await passwordStep(u.email);
      for (let i = 0; i < 4; i++) await request(http).post('/auth/mfa/verify').set(CSRF).send({ mfaToken: pw.body.mfaToken, code: wrong(u.secret!) }).expect(401);
      await request(http).post('/auth/mfa/verify').set(CSRF).send({ mfaToken: pw.body.mfaToken, code: wrong(u.secret!) }).expect(403); // locked (1st lock: 15 min)
      vi.setSystemTime(Date.now() + 16 * 60_000);
      pw = await passwordStep(u.email);
      for (let i = 0; i < 5; i++) await request(http).post('/auth/mfa/verify').set(CSRF).send({ mfaToken: pw.body.mfaToken, code: wrong(u.secret!) });
      vi.setSystemTime(Date.now() + 16 * 60_000); // the 2nd lock lasts 30 min
      pw = await passwordStep(u.email);
      nextTotpWindow();
      const stillLocked = await request(http).post('/auth/mfa/verify').set(CSRF).send({ mfaToken: pw.body.mfaToken, code: totp(base32Decode(u.secret!)) });
      expect(stillLocked.status).toBe(403);
      vi.setSystemTime(Date.now() + 15 * 60_000);
      pw = await passwordStep(u.email);
      nextTotpWindow();
      await request(http).post('/auth/mfa/verify').set(CSRF).send({ mfaToken: pw.body.mfaToken, code: totp(base32Decode(u.secret!)) }).expect(200);
    });
  });

  describe('R1-07: step-up codes count towards the same lock', () => {
    it('5 wrong step-up codes lock the second factor and end every session of the user', async () => {
      const u = await createUser(app, 'trader');
      const codes: number[] = [];
      for (let i = 0; i < 5; i++) codes.push((await request(http).post('/auth/mfa/recovery-codes').set(bearer(u.token)).send({ code: wrong(u.secret!) })).status);
      expect(codes).toEqual([401, 401, 401, 401, 401]);
      // the (possibly stolen) session is gone
      await request(http).get('/me').set(bearer(u.token)).expect(401);
      // and a correct step-up code from a fresh session is refused while locked
      nextTotpWindow();
      const pw = await passwordStep(u.email);
      const v = await request(http).post('/auth/mfa/verify').set(CSRF).send({ mfaToken: pw.body.mfaToken, code: totp(base32Decode(u.secret!)) });
      expect(v.status).toBe(403);
      expect(v.body.error).toBe('mfa_locked');
    });
  });

  describe('R1-04: password back-off without enumeration or permanent lock-out', () => {
    const attempts = async (email: string, ip: string, n: number) => {
      const out: Array<{ status: number; body: unknown }> = [];
      for (let i = 0; i < n; i++) {
        const r = await passwordStep(email, ip, 'wrong-password-123');
        out.push({ status: r.status, body: r.body });
      }
      return out;
    };

    it('existing and unknown accounts get identical answers, including when backed off', async () => {
      const existing = uniqueEmail('enum');
      await request(http).post('/auth/signup').set(CSRF).send({ email: existing, password: PASSWORD, displayName: 'E' }).expect(201);
      const unknown = uniqueEmail('nobody');
      const a = await attempts(existing, '198.51.100.21', 12);
      const b = await attempts(unknown, '198.51.100.22', 12);
      expect(a).toEqual(b);
      expect(a.slice(0, 5).every((x) => x.status === 401)).toBe(true);
      expect(a.slice(5).every((x) => x.status === 429)).toBe(true);
      expect(a.some((x) => (x.body as { error?: string }).error === 'locked')).toBe(false);
    });

    it('an attacker backing off one IP cannot lock the owner out from another IP', async () => {
      const u = await createUser(app, 'novice');
      await attempts(u.email, '203.0.113.50', 15);
      // the attacker's own IP is backed off, even with the right password
      expect((await passwordStep(u.email, '203.0.113.50')).status).toBe(429);
      // the owner, from their own address, signs in
      const ok = await passwordStep(u.email, '192.0.2.77');
      expect(ok.status).toBe(200);
      expect(ok.body.status).toBe('ok');
    });

    it('a distributed attack backs off unknown IPs account-wide, but the owner on a known IP still signs in; back-off is capped', async () => {
      const u = await createUser(app, 'novice');
      // the owner signed in once from their usual address
      expect((await passwordStep(u.email, '192.0.2.88')).body.status).toBe('ok');
      for (let k = 0; k < 6; k++) await attempts(u.email, `203.0.113.${100 + k}`, 5);
      // a brand-new address is backed off account-wide, the same as for an unknown account
      const fresh = await passwordStep(u.email, '203.0.113.200');
      expect(fresh.status).toBe(429);
      // the owner's known address is not
      const owner = await passwordStep(u.email, '192.0.2.88');
      expect(owner.status).toBe(200);
      // back-off is capped at 15 minutes: after that the right password works from anywhere
      for (let k = 0; k < 6; k++) await attempts(u.email, `203.0.113.${110 + k}`, 5);
      vi.setSystemTime(Date.now() + 16 * 60_000);
      expect((await passwordStep(u.email, '203.0.113.201')).status).toBe(200);
    });
  });
});

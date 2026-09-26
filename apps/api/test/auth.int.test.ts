import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { TokenService } from '../src/auth/token.service';
import { base32Decode, totp } from '../src/auth/totp';
import { bearer, createUser, CSRF, login, nextTotpWindow, ownerQuery, passAppropriateness, PASSWORD, startApp, uniqueEmail } from './helpers';

describe('identity: sign-up, MFA, login, RBAC', () => {
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

  it('novice: sign-up → login without MFA, cookie session, novice view by default', async () => {
    const email = uniqueEmail('nov');
    await request(http).post('/auth/signup').set(CSRF).send({ email, password: PASSWORD, displayName: 'N', accountType: 'novice' }).expect(201);
    const res = await request(http).post('/auth/login').set(CSRF).send({ email, password: PASSWORD }).expect(200);
    expect(res.body.status).toBe('ok');
    const cookie = res.headers['set-cookie'] as unknown as string[];
    expect(cookie.join(';')).toMatch(/kora_at=.*HttpOnly.*SameSite=Strict/i);
    const me = await request(http).get('/me').set('Cookie', cookie).expect(200);
    expect(me.body).toMatchObject({ roles: ['novice'], mfa: false, preferences: { viewMode: 'novice' }, capabilities: { orderTypes: ['market'], robotBuilder: false } });
  });

  it('no self-service trader (B-018): sign-up is novice only; trader comes from the assessment, then forced MFA enrolment; replay and bad codes rejected', async () => {
    const email = uniqueEmail('trd');
    const refused = await request(http).post('/auth/signup').set(CSRF).send({ email, password: PASSWORD, displayName: 'T', accountType: 'trader' }).expect(400);
    expect(JSON.stringify(refused.body)).toContain('appropriateness');
    const s = await request(http).post('/auth/signup').set(CSRF).send({ email, password: PASSWORD, displayName: 'T' }).expect(201);
    expect(s.body).toEqual({ accepted: true, mfaRequired: false, next: 'sign_in' });
    const l0 = await request(http).post('/auth/login').set(CSRF).send({ email, password: PASSWORD }).expect(200);
    expect(l0.body.status).toBe('ok');
    await passAppropriateness(app, l0.body.accessToken);

    const l1 = await request(http).post('/auth/login').set(CSRF).send({ email, password: PASSWORD }).expect(200);
    expect(l1.body.status).toBe('mfa_enrollment_required');
    expect(l1.body.accessToken).toBeUndefined();
    // the MFA token is not a session
    await request(http).get('/me').set(bearer(l1.body.mfaToken)).expect(401);

    const enr = await request(http).post('/auth/mfa/enroll').set(CSRF).send({ mfaToken: l1.body.mfaToken }).expect(200);
    expect(enr.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\/KORA/);
    const secret = base32Decode(enr.body.secret);

    await request(http).post('/auth/mfa/verify').set(CSRF).send({ mfaToken: l1.body.mfaToken, code: '000000' === totp(secret) ? '111111' : '000000' }).expect(401);
    nextTotpWindow();
    const code = totp(secret);
    const v = await request(http).post('/auth/mfa/verify').set(CSRF).send({ mfaToken: l1.body.mfaToken, code }).expect(200);
    expect(v.body.enrolled).toBe(true);
    const me = await request(http).get('/me').set(bearer(v.body.accessToken)).expect(200);
    expect(me.body).toMatchObject({ roles: ['novice', 'trader'], mfa: true, preferences: { viewMode: 'pro' } });

    // enrolment cannot be restarted once active
    const l2 = await request(http).post('/auth/login').set(CSRF).send({ email, password: PASSWORD }).expect(200);
    expect(l2.body.status).toBe('mfa_required');
    await request(http).post('/auth/mfa/enroll').set(CSRF).send({ mfaToken: l2.body.mfaToken }).expect(409);
    // replay of the same code (same step) is rejected
    await request(http).post('/auth/mfa/verify').set(CSRF).send({ mfaToken: l2.body.mfaToken, code }).expect(401);
    nextTotpWindow();
    await request(http).post('/auth/mfa/verify').set(CSRF).send({ mfaToken: l2.body.mfaToken, code: totp(secret) }).expect(200);
  });

  it('rejects a non-novice token without amr=otp (global MFA rule)', async () => {
    const tokens = app.get(TokenService);
    const t = await tokens.issueAccessToken({ sub: '00000000-0000-4000-8000-000000000001', email: 'x@y.z', roles: ['trader'], amr: ['pwd'] });
    const res = await request(http).get('/me').set(bearer(t)).expect(403);
    expect(res.body.error).toBe('mfa_required');
  });

  it('rejects garbage and unauthenticated requests', async () => {
    await request(http).get('/me').expect(401);
    await request(http).get('/me').set(bearer('not.a.jwt')).expect(401);
  });

  it('validates sign-up input and refuses self-assigned privileged roles', async () => {
    await request(http).post('/auth/signup').set(CSRF).send({ email: uniqueEmail('x'), password: 'short', displayName: 'X' }).expect(400);
    await request(http).post('/auth/signup').set(CSRF).send({ email: uniqueEmail('x'), password: PASSWORD, displayName: 'X', accountType: 'admin' }).expect(400);
    const email = uniqueEmail('dup');
    const first = await request(http).post('/auth/signup').set(CSRF).send({ email, password: PASSWORD, displayName: 'X' }).expect(201);
    // B-014: an existing e-mail gets the same answer (no account enumeration); the duplicate is audited.
    const dup = await request(http).post('/auth/signup').set(CSRF).send({ email: email.toUpperCase(), password: 'another-password-123', displayName: 'Y' }).expect(201);
    expect(dup.body).toEqual(first.body);
    expect(dup.body).toEqual({ accepted: true, mfaRequired: false, next: 'sign_in' });
    const audited = await ownerQuery<{ n: string }>(`SELECT count(*)::text AS n FROM audit_events WHERE action = 'auth.signup_duplicate' AND ts > now() - interval '1 minute'`);
    expect(Number(audited[0]!.n)).toBeGreaterThanOrEqual(1);
    // The original password still works and the second password does not.
    await request(http).post('/auth/login').set(CSRF).send({ email, password: PASSWORD }).expect(200);
    await request(http).post('/auth/login').set(CSRF).send({ email, password: 'another-password-123' }).expect(401);
  });

  it('wrong password → 401 with a generic message; unknown user is indistinguishable', async () => {
    const u = await createUser(app, 'novice');
    const a = await request(http).post('/auth/login').set(CSRF).send({ email: u.email, password: 'wrong-password-xyz' }).expect(401);
    const b = await request(http).post('/auth/login').set(CSRF).send({ email: uniqueEmail('ghost'), password: 'wrong-password-xyz' }).expect(401);
    expect(a.body.message).toBe(b.body.message);
  });

  it('RBAC: novice gets 403 on /robots/*, trader gets 200, admin routes need admin', async () => {
    const novice = await createUser(app, 'novice');
    const trader = await createUser(app, 'trader');
    const r = await request(http).get('/robots/builder').set(bearer(novice.token)).expect(403);
    expect(r.body).toMatchObject({ error: 'forbidden', requiredRoles: ['trader', 'quant', 'admin'] });
    await request(http).get('/robots/builder').set(bearer(trader.token)).expect(200);
    await request(http).get('/admin/users').set(bearer(trader.token)).expect(403);
  });

  it('admin grants a role; the user must enrol MFA at next login', async () => {
    const admin = await createUser(app, 'trader', ['admin']);
    const novice = await createUser(app, 'novice');
    await request(http).put(`/admin/users/${novice.id}/roles`).set(bearer(admin.token)).send({ roles: ['novice', 'quant'] }).expect(200);
    const l = await request(http).post('/auth/login').set(CSRF).send({ email: novice.email, password: PASSWORD }).expect(200);
    expect(l.body.status).toBe('mfa_enrollment_required');
    const again = await login(app, novice.email);
    const me = await request(http).get('/me').set(bearer(again.token)).expect(200);
    expect(me.body.roles).toEqual(['novice', 'quant']);
    await request(http).put(`/admin/users/${admin.id}/roles`).set(bearer(admin.token)).send({ roles: ['trader'] }).expect(400);
    const audit = await ownerQuery<{ n: string }>("SELECT count(*)::text AS n FROM audit_events WHERE action = 'admin.roles_changed' AND entity_id = $1", [novice.id]);
    expect(audit[0]!.n).toBe('1');
  });

  it('CSRF: cookie-authenticated mutations need the x-kora-csrf header', async () => {
    const email = uniqueEmail('csrf');
    await request(http).post('/auth/signup').set(CSRF).send({ email, password: PASSWORD, displayName: 'C' }).expect(201);
    const res = await request(http).post('/auth/login').set(CSRF).send({ email, password: PASSWORD }).expect(200);
    const cookie = res.headers['set-cookie'] as unknown as string[];
    await request(http).put('/me/preferences').set('Cookie', cookie).send({ viewMode: 'pro' }).expect(403);
    await request(http).put('/me/preferences').set('Cookie', cookie).set(CSRF).send({ viewMode: 'pro' }).expect(200);
    await request(http).post('/auth/login').send({ email, password: PASSWORD }).expect(403);
  });
});

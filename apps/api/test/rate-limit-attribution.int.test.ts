import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CSRF, startApp, uniqueEmail } from './helpers';

/**
 * IRTC R1-05: sign-in rate limits are keyed per client IP *and* account, so one client exhausting
 * its budget against one account cannot block other people's sign-in, even when they share an
 * address (NAT, or a proxy that collapses addresses). A per-IP ceiling above it still bounds
 * spraying many accounts from one address. Runs at the shipped defaults: the limit env vars that
 * setup-env raises for the rest of the suite are unset here.
 */
describe('sign-in rate limits per IP + account at default limits (IRTC R1-05)', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  const saved = { auth: process.env.KORA_AUTH_RATE_LIMIT, ip: process.env.KORA_AUTH_IP_RATE_LIMIT };
  beforeAll(async () => {
    delete process.env.KORA_AUTH_RATE_LIMIT;
    delete process.env.KORA_AUTH_IP_RATE_LIMIT;
    app = await startApp();
    http = app.getHttpServer();
  });
  afterAll(async () => {
    process.env.KORA_AUTH_RATE_LIMIT = saved.auth;
    if (saved.ip === undefined) delete process.env.KORA_AUTH_IP_RATE_LIMIT;
    else process.env.KORA_AUTH_IP_RATE_LIMIT = saved.ip;
    await app.close();
  });

  const login = (email: string, ip: string) =>
    request(http).post('/auth/login').set(CSRF).set('X-Forwarded-For', ip).send({ email, password: 'junk-password-123' });
  const throttled = (r: request.Response) => r.status === 429 && r.body.error !== 'too_many_attempts';

  it('20 junk sign-ins against one account from one IP do not block a different account from that IP', async () => {
    const victimOfJunk = uniqueEmail('target');
    const ip = '198.51.100.7';
    const first20 = [];
    for (let i = 0; i < 20; i++) first20.push(await login(victimOfJunk, ip));
    expect(first20.some(throttled)).toBe(false);
    expect(throttled(await login(victimOfJunk, ip))).toBe(true); // the 21st for that account is throttled
    // someone else behind the same address signs in normally (401 = password checked, not 429)
    const other = await login(uniqueEmail('other'), ip);
    expect(other.status).toBe(401);
    // and a different address is unaffected
    expect((await login(uniqueEmail('elsewhere'), '203.0.113.9')).status).toBe(401);
  });

  it('one IP spraying many accounts still hits a per-IP ceiling (5 x the per-account limit)', async () => {
    const ip = '198.51.100.8';
    const codes: boolean[] = [];
    for (let i = 0; i < 101; i++) codes.push(throttled(await login(uniqueEmail(`spray${i}`), ip)));
    expect(codes.slice(0, 100).some(Boolean)).toBe(false);
    expect(codes[100]).toBe(true);
  });
});

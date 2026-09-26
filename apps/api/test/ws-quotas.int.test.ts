import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createUser, startApp, type TestUser } from './helpers';
import { listen, TestWs } from './ws-helpers';

/** B-203: per-user and per-IP WebSocket quotas; token refresh over an open socket. */
describe('WebSocket quotas and token refresh (B-203)', () => {
  let app: INestApplication;
  let urls: { http: string; ws: string };
  let a: TestUser;
  let b: TestUser;

  beforeAll(async () => {
    process.env.KORA_MD_WS_MAX_CONN_PER_USER = '2';
    process.env.KORA_MD_WS_MAX_CONN_PER_IP = '4';
    app = await startApp();
    urls = await listen(app);
    a = await createUser(app, 'novice', [], { realClock: true });
    b = await createUser(app, 'novice', [], { realClock: true });
  });
  afterAll(async () => {
    await app.close();
    delete process.env.KORA_MD_WS_MAX_CONN_PER_USER;
    delete process.env.KORA_MD_WS_MAX_CONN_PER_IP;
  });

  it('a third socket for the same user is closed with 4429; other users are unaffected', async () => {
    const s1 = await TestWs.authed(urls.ws, a.token);
    const s2 = await TestWs.authed(urls.ws, a.token);
    const s3 = await TestWs.open(urls.ws);
    s3.send({ op: 'auth', token: a.token });
    expect(await s3.waitClose(3000)).toMatchObject({ code: 4429, reason: 'too many connections' });
    const other = await TestWs.authed(urls.ws, b.token);
    expect(other.closed).toBeNull();
    // Per-IP: 3 open from this address, a 4th is allowed, a 5th is refused at the upgrade (429).
    const s4 = await TestWs.open(urls.ws);
    await expect(TestWs.open(urls.ws)).rejects.toThrow(/429/);
    for (const s of [s1, s2, other, s4]) s.ws.close();
    await new Promise((r) => setTimeout(r, 200));
  });

  it('a fresh token for the same user refreshes the open socket; another user’s token closes it', async () => {
    const s = await TestWs.authed(urls.ws, a.token, ['status']);
    s.send({ op: 'auth', token: a.token });
    const r = await s.waitFor((m) => m.type === 'authenticated' && m.refreshed === true);
    expect(r.msg).toMatchObject({ sub: a.id, refreshed: true });
    expect(typeof r.msg.exp).toBe('number');
    expect(s.closed).toBeNull();
    s.send({ op: 'auth', token: b.token });
    expect(await s.waitClose(3000)).toMatchObject({ code: 4403, reason: 'subject mismatch' });
  });
});

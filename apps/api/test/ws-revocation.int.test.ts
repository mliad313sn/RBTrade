import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { bearer, createUser, ownerQuery, startApp } from './helpers';
import { listen, TestWs } from './ws-helpers';

/**
 * IRTC R1-03: an open WebSocket must not outlive the session that authenticated it. Logout, a role
 * change (demotion) and disabling the user end every affected socket promptly, and no later
 * subscribe is granted on the strength of cached roles.
 */
describe('WebSocket session revalidation (IRTC R1-03)', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let ws: string;
  const savedSweep = process.env.KORA_WS_SESSION_SWEEP_MS;
  beforeAll(async () => {
    process.env.KORA_WS_SESSION_SWEEP_MS = '1000';
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    app = await startApp();
    http = app.getHttpServer();
    ws = (await listen(app)).ws;
  });
  afterAll(async () => {
    if (savedSweep === undefined) delete process.env.KORA_WS_SESSION_SWEEP_MS;
    else process.env.KORA_WS_SESSION_SWEEP_MS = savedSweep;
    await app.close();
    vi.useRealTimers();
  });

  it('logout mid-socket closes the open socket (4401)', async () => {
    const t = await createUser(app, 'trader');
    const accountId = (await request(http).get('/accounts/me').set(bearer(t.token)).expect(200))
      .body.id as string;
    const sock = await TestWs.authed(ws, t.token, [`orders:${accountId}`]);
    await request(http).post('/auth/logout').set(bearer(t.token)).expect(200);
    expect(await sock.waitClose(3000)).toMatchObject({ code: 4401 });
  });

  it('a demoted risk officer loses the socket and cannot subscribe to other accounts or risk alerts', async () => {
    const victim = await createUser(app, 'trader');
    const victimAccount = (
      await request(http).get('/accounts/me').set(bearer(victim.token)).expect(200)
    ).body.id as string;
    const risk = await createUser(app, 'trader', ['risk_officer']);
    const admin = await createUser(app, 'novice', ['admin']);
    const sock = await TestWs.authed(ws, risk.token, ['risk:alerts', `orders:${victimAccount}`]);
    await request(http)
      .put(`/admin/users/${risk.id}/roles`)
      .set(bearer(admin.token))
      .send({ roles: ['novice', 'trader'] })
      .expect(200);
    // either the socket is closed at once, or at the latest the next subscribe is refused by closing it
    const closed = await sock.waitClose(3000).catch(() => null);
    if (!closed) {
      sock.send({ op: 'subscribe', channels: [`positions:${victimAccount}`], id: 'after' });
      expect(await sock.waitClose(3000)).toMatchObject({ code: 4401 });
    } else {
      expect(closed.code).toBe(4401);
    }
    expect(sock.messages.some((m) => m.msg.type === 'subscribed' && m.msg.id === 'after')).toBe(
      false,
    );
  });

  it('a subscribe after the session was revoked out of band (disabled in the DB) closes the socket', async () => {
    const u = await createUser(app, 'trader');
    const accountId = (await request(http).get('/accounts/me').set(bearer(u.token)).expect(200))
      .body.id as string;
    const sock = await TestWs.authed(ws, u.token);
    await ownerQuery(`UPDATE users SET status = 'disabled' WHERE id = $1`, [u.id]);
    sock.send({ op: 'subscribe', channels: [`orders:${accountId}`], id: 'late' });
    expect(await sock.waitClose(3000)).toMatchObject({ code: 4401 });
    expect(sock.messages.some((m) => m.msg.type === 'subscribed' && m.msg.id === 'late')).toBe(
      false,
    );
  });

  it('a logout on one api replica closes the socket held by another replica (Redis relay, not the sweep)', async () => {
    process.env.KORA_WS_SESSION_SWEEP_MS = '300000'; // replica 2 never sweeps during the test
    const app2 = await startApp();
    process.env.KORA_WS_SESSION_SWEEP_MS = '1000';
    try {
      const ws2 = (await listen(app2)).ws;
      const u = await createUser(app, 'novice');
      const sock = await TestWs.authed(ws2, u.token, ['status']);
      await request(http).post('/auth/logout').set(bearer(u.token)).expect(200);
      expect(await sock.waitClose(3000)).toMatchObject({ code: 4401 });
    } finally {
      await app2.close();
    }
  });

  it('the periodic sweep closes an idle socket whose user was disabled out of band', async () => {
    const u = await createUser(app, 'novice');
    const sock = await TestWs.authed(ws, u.token, ['status']);
    await ownerQuery(`UPDATE users SET status = 'disabled' WHERE id = $1`, [u.id]);
    expect(await sock.waitClose(5000)).toMatchObject({ code: 4401 });
  });
});

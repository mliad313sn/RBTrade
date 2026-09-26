import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { bearer, createUser, startApp } from './helpers';

describe('preferences and kill switch', () => {
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

  it('persists the Pro/Novice toggle per user and hides advanced order types in novice', async () => {
    const t = await createUser(app, 'trader');
    const before = await request(http).get('/me').set(bearer(t.token)).expect(200);
    expect(before.body.capabilities.orderTypes).toEqual(expect.arrayContaining(['bracket', 'oco', 'trailing', 'stop_limit']));

    const put = await request(http).put('/me/preferences').set(bearer(t.token)).send({ viewMode: 'novice' }).expect(200);
    expect(put.body.capabilities.orderTypes).toEqual(['market']);
    const after = await request(http).get('/me').set(bearer(t.token)).expect(200);
    expect(after.body.preferences.viewMode).toBe('novice');

    // other users are unaffected
    const other = await createUser(app, 'trader');
    expect((await request(http).get('/me/preferences').set(bearer(other.token))).body.viewMode).toBe('pro');

    const audit = await request(http).get('/audit?action=preferences.updated').set(bearer(t.token)).expect(200);
    expect(audit.body.events[0]).toMatchObject({ actorId: t.id, payload: { changed: { viewMode: 'novice' }, previous: { viewMode: 'pro' } } });
  });

  it('validates preferences', async () => {
    const n = await createUser(app, 'novice');
    await request(http).put('/me/preferences').set(bearer(n.token)).send({ viewMode: 'expert' }).expect(400);
    await request(http).put('/me/preferences').set(bearer(n.token)).send({ role: 'admin' }).expect(400);
    const ok = await request(http).put('/me/preferences').set(bearer(n.token)).send({ colourConvention: 'green_red', hotkeys: { killSwitch: 'Ctrl+Alt+K' } }).expect(200);
    expect(ok.body.preferences).toMatchObject({ colourConvention: 'green_red', hotkeys: { killSwitch: 'Ctrl+Alt+K', commandPalette: 'Mod+K' } });
  });

  it.each(['robots', 'robots_cancel', 'robots_cancel_flatten'] as const)('kill switch scope %s keeps the goal 01 contract and writes an audit event', async (scope) => {
    const u = await createUser(app, 'novice');
    const res = await request(http).post('/kill-switch').set(bearer(u.token)).send({ scope, source: 'hotkey' }).expect(202);
    expect(res.body).toMatchObject({ accepted: true, scope, engine: 'paper', halted: true, auditEventId: expect.stringMatching(/^\d+$/) });
    const audit = await request(http).get('/audit?action=kill_switch.requested').set(bearer(u.token)).expect(200);
    expect(audit.body.events).toHaveLength(1);
    expect(audit.body.events[0]).toMatchObject({
      id: res.body.auditEventId,
      actorId: u.id,
      actorType: 'user',
      action: 'kill_switch.requested',
      entity: 'kill_switch',
      entityId: scope,
      payload: { scope, source: 'hotkey', environment: 'PAPER', engine: 'paper' },
    });
  });

  it('rejects an unknown kill switch scope', async () => {
    const u = await createUser(app, 'novice');
    await request(http).post('/kill-switch').set(bearer(u.token)).send({ scope: 'all' }).expect(400);
  });
});

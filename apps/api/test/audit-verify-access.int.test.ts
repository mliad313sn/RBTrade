import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AuditService } from '../src/audit/audit.service';
import { bearer, createUser, ownerQuery, startApp } from './helpers';

/**
 * IRTC R1-08: re-hashing the whole chain (O(N)) and disclosing the platform-wide event count and head
 * hash is reserved to auditors, risk officers and admins. Everyone else keeps a self-scoped check:
 * their own events are recomputed and linked to their predecessors, with no platform totals. The
 * endpoint has its own low per-client limit.
 */
describe('GET /audit/verify access (IRTC R1-08)', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let audit: AuditService;
  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    app = await startApp();
    http = app.getHttpServer();
    audit = app.get(AuditService);
  });
  afterAll(async () => {
    await app.close();
    vi.useRealTimers();
  });

  const verify = (token: string, ip: string) =>
    request(http).get('/audit/verify').set(bearer(token)).set('X-Forwarded-For', ip);

  it('a novice or trader gets a self-scoped result without the platform count or head hash', async () => {
    const t = await createUser(app, 'trader');
    await request(http)
      .post('/kill-switch')
      .set(bearer(t.token))
      .send({ scope: 'robots' })
      .expect(202);
    // other people's activity after the user's last event
    for (let i = 0; i < 30; i++)
      await audit.record({
        actorId: 'system',
        actorType: 'system',
        action: 'test.noise',
        entity: 'test',
        entityId: String(i),
      });
    const { n, head } = (
      await ownerQuery<{ n: number; head: string }>(
        'SELECT count(*)::int AS n, (SELECT hash FROM audit_events ORDER BY id DESC LIMIT 1) AS head FROM audit_events',
      )
    )[0]!;
    const { own } = (
      await ownerQuery<{ own: number }>(
        'SELECT count(*)::int AS own FROM audit_events WHERE actor_id = $1',
        [t.id],
      )
    )[0]!;
    const res = await verify(t.token, '198.51.100.31').expect(200);
    expect(res.body).toMatchObject({ valid: true, scope: 'own', firstBrokenId: null });
    expect(res.body.count).toBeGreaterThanOrEqual(own);
    expect(res.body.count).toBeLessThan(n);
    expect(res.body.headHash).not.toBe(head);
  });

  it('auditors, risk officers and admins verify the whole chain', async () => {
    const auditor = await createUser(app, 'novice', ['auditor']);
    const risk = await createUser(app, 'trader', ['risk_officer']);
    const { n } = (
      await ownerQuery<{ n: number }>('SELECT count(*)::int AS n FROM audit_events')
    )[0]!;
    for (const [u, ip] of [
      [auditor, '198.51.100.32'],
      [risk, '198.51.100.33'],
    ] as const) {
      const res = await verify(u.token, ip).expect(200);
      expect(res.body).toMatchObject({ valid: true, scope: 'chain' });
      expect(res.body.count).toBeGreaterThanOrEqual(n);
    }
  });

  it('the self-scoped check still detects a tampered own event', async () => {
    const u = await createUser(app, 'novice');
    await request(http)
      .post('/kill-switch')
      .set(bearer(u.token))
      .send({ scope: 'robots' })
      .expect(202);
    const [target] = await ownerQuery<{ id: string; payload: unknown }>(
      "SELECT id::text AS id, payload FROM audit_events WHERE action = 'kill_switch.requested' AND actor_id = $1",
      [u.id],
    );
    const tamper = async (payload: unknown) =>
      ownerQuery(`BEGIN;
        ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update_delete;
        UPDATE audit_events SET payload = '${JSON.stringify(payload)}'::jsonb WHERE id = ${target!.id};
        ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_update_delete;
        COMMIT;`);
    await tamper({ scope: 'robots_cancel_flatten' });
    try {
      const res = await verify(u.token, '198.51.100.34').expect(200);
      expect(res.body).toMatchObject({
        valid: false,
        scope: 'own',
        firstBrokenId: target!.id,
        reason: 'hash_mismatch',
      });
    } finally {
      await tamper(target!.payload);
    }
    expect((await verify(u.token, '198.51.100.34').expect(200)).body.valid).toBe(true);
  });

  it('has its own low per-client rate limit (10 per minute)', async () => {
    const u = await createUser(app, 'novice');
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) codes.push((await verify(u.token, '198.51.100.35')).status);
    expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true);
    expect(codes[10]).toBe(429);
  });
});

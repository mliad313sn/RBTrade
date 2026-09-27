import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AuditService } from '../src/audit/audit.service';
import { appQuery, bearer, createUser, ownerQuery, startApp } from './helpers';

describe('audit log', () => {
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

  it('keeps a contiguous, valid chain under 50 concurrent writers', async () => {
    const events = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        audit.record({ actorId: 'system', actorType: 'system', action: 'test.concurrent', entity: 'test', entityId: String(i), payload: { i, amount: '1.10' } }),
      ),
    );
    const ids = events.map((e) => BigInt(e.id)).sort((a, b) => (a < b ? -1 : 1));
    for (let i = 1; i < ids.length; i++) expect(ids[i]! - ids[i - 1]!).toBe(1n);
    // IRTC R1-08: whole-chain verification is for auditors, risk officers and admins.
    const u = await createUser(app, 'novice', ['auditor']);
    const v = await request(http).get('/audit/verify').set(bearer(u.token)).expect(200);
    expect(v.body).toMatchObject({ valid: true, firstBrokenId: null, scope: 'chain' });
    expect(v.body.count).toBeGreaterThanOrEqual(50);
  });

  it('the one-round-trip chain head (0102) keeps the chain valid for batched writers too', async () => {
    const batches = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        audit.recordMany(
          Array.from({ length: 3 }, (_, k) => ({ actorId: 'system', actorType: 'system' as const, action: 'test.batch', entity: 'test', entityId: `${i}.${k}` })),
        ),
      ),
    );
    const ids = batches.flat().map((e) => BigInt(e.id)).sort((a, b) => (a < b ? -1 : 1));
    for (let i = 1; i < ids.length; i++) expect(ids[i]! - ids[i - 1]!).toBe(1n);
    const u = await createUser(app, 'novice');
    expect((await request(http).get('/audit/verify').set(bearer(u.token)).expect(200)).body).toMatchObject({ valid: true });
  });

  it('refuses to append inside a REPEATABLE READ transaction (a stale head would fork the chain)', async () => {
    const pool = (audit as unknown as { db: { pool: import('pg').Pool } }).db.pool;
    const c = await pool.connect();
    try {
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await expect(audit.record({ actorId: 'system', actorType: 'system', action: 'test.rr', entity: 'test' }, c)).rejects.toThrow(/READ COMMITTED/);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });

  it('stores microsecond UTC timestamps and rejects float payloads', async () => {
    const e = await audit.record({ actorId: 'system', actorType: 'system', action: 'test.ts', entity: 'test' });
    expect(e.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    await expect(audit.record({ actorId: 'system', actorType: 'system', action: 'test.float', entity: 'test', payload: { price: 1.08 } })).rejects.toThrow(/decimals as strings/);
  });

  it('rolled-back business transactions leave no gap in the chain', async () => {
    const db = (audit as unknown as { db: { tx: <T>(fn: (c: never) => Promise<T>) => Promise<T> } }).db;
    await expect(
      db.tx(async (c) => {
        await audit.record({ actorId: 'system', actorType: 'system', action: 'test.rollback', entity: 'test' }, c);
        throw new Error('business failure');
      }),
    ).rejects.toThrow('business failure');
    await audit.record({ actorId: 'system', actorType: 'system', action: 'test.after_rollback', entity: 'test' });
    expect((await audit.verify()).valid).toBe(true);
  });

  it('filters by actor, entity, action and time; non-privileged users only see their own events', async () => {
    const a = await createUser(app, 'novice');
    const b = await createUser(app, 'novice');
    await request(http).post('/kill-switch').set(bearer(a.token)).send({ scope: 'robots' }).expect(202);
    const own = await request(http).get('/audit').set(bearer(a.token)).expect(200);
    expect(own.body.events.length).toBeGreaterThan(0);
    expect(own.body.events.every((e: { actorId: string }) => e.actorId === a.id)).toBe(true);
    await request(http).get(`/audit?actorId=${b.id}`).set(bearer(a.token)).expect(403);

    const risk = await createUser(app, 'trader', ['risk_officer']);
    const all = await request(http).get(`/audit?entity=kill_switch&action=kill_switch.requested&actorId=${a.id}`).set(bearer(risk.token)).expect(200);
    expect(all.body.events).toHaveLength(1);
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const none = await request(http).get(`/audit?from=${encodeURIComponent(future)}`).set(bearer(risk.token)).expect(200);
    expect(none.body.events).toHaveLength(0);
    const page = await request(http).get('/audit?limit=2').set(bearer(risk.token)).expect(200);
    expect(page.body.events).toHaveLength(2);
    expect(page.body.nextBeforeId).toBe(page.body.events[1].id);
    const next = await request(http).get(`/audit?limit=2&beforeId=${page.body.nextBeforeId}`).set(bearer(risk.token)).expect(200);
    expect(BigInt(next.body.events[0].id)).toBeLessThan(BigInt(page.body.nextBeforeId));
    await request(http).get('/audit?action=DROP TABLE').set(bearer(risk.token)).expect(400);
  });

  it('runtime role kora_app cannot UPDATE, DELETE or TRUNCATE audit_events (privileges revoked)', async () => {
    await expect(appQuery("UPDATE audit_events SET action = 'x' WHERE id = 1")).rejects.toMatchObject({ code: '42501' });
    await expect(appQuery('DELETE FROM audit_events WHERE id = 1')).rejects.toMatchObject({ code: '42501' });
    await expect(appQuery('TRUNCATE audit_events')).rejects.toMatchObject({ code: '42501' });
    const grants = await ownerQuery<{ privilege_type: string }>(
      "SELECT privilege_type FROM information_schema.role_table_grants WHERE table_name = 'audit_events' AND grantee = 'kora_app' ORDER BY 1",
    );
    expect(grants.map((g) => g.privilege_type)).toEqual(['INSERT', 'SELECT']);
  });

  it('even the table owner is blocked by the append-only trigger', async () => {
    await expect(ownerQuery("UPDATE audit_events SET action = 'x' WHERE id = 1")).rejects.toThrow(/append-only/);
    await expect(ownerQuery('DELETE FROM audit_events WHERE id = 1')).rejects.toThrow(/append-only/);
  });

  it('a manual tamper of one row makes /audit/verify return valid:false with the first broken id', async () => {
    const u = await createUser(app, 'novice');
    await request(http).post('/kill-switch').set(bearer(u.token)).send({ scope: 'robots_cancel' }).expect(202);
    const target = (await ownerQuery<{ id: string; payload: unknown }>(
      "SELECT id::text AS id, payload FROM audit_events WHERE action = 'kill_switch.requested' AND actor_id = $1",
      [u.id],
    ))[0]!;
    await audit.record({ actorId: 'system', actorType: 'system', action: 'test.after_target', entity: 'test' });

    const tamper = async (payload: unknown) =>
      ownerQuery(`BEGIN;
        ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update_delete;
        UPDATE audit_events SET payload = '${JSON.stringify(payload)}'::jsonb WHERE id = ${target.id};
        ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_update_delete;
        COMMIT;`);

    await tamper({ scope: 'robots', source: 'ui_button', environment: 'PAPER', engine: 'not_wired_goal_03' });
    const broken = await request(http).get('/audit/verify').set(bearer(u.token)).expect(200);
    expect(broken.body).toMatchObject({ valid: false, firstBrokenId: target.id, reason: 'hash_mismatch' });

    // restore the original row: the chain verifies again (proves the check is content-based)
    await tamper(target.payload);
    const ok = await request(http).get('/audit/verify').set(bearer(u.token)).expect(200);
    expect(ok.body.valid).toBe(true);
  });
  // IRTC R6-01: every hashed column (and the link) is protected, not only the payload. Each tamper is
  // made as the owner with the trigger disabled, must break /audit/verify at that row, and restoring
  // the original value must make the chain verify again.
  const TAMPERS: Array<[string, string]> = [
    ['actor_id', "'forged-actor'"],
    ['actor_type', "'ai'"],
    ['ts', "ts + interval '1 hour'"],
    ['action', "'test.r6_forged'"],
    ['entity', "'forged'"],
    ['entity_id', "'forged'"],
    ['payload', `'{"a":"2"}'::jsonb`],
    ['prev_hash', `'${'a'.repeat(64)}'`],
  ];
  for (const [col, forged] of TAMPERS) {
    it(`tampering ${col} breaks the chain at that row (IRTC R6-01)`, async () => {
      const e = await audit.record({ actorId: 'system', actorType: 'system', action: 'test.r6', entity: 'test', entityId: 'x', payload: { a: '1' } });
      await audit.record({ actorId: 'system', actorType: 'system', action: 'test.r6_after', entity: 'test' });
      const asOwner = (sql: string, params: unknown[] = []) =>
        ownerQuery(`BEGIN; ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update_delete; ${sql}; ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_update_delete; COMMIT;`, params);
      const orig = (await ownerQuery<{ v: string }>(`SELECT ${col}::text AS v FROM audit_events WHERE id = $1`, [e.id]))[0]!.v;
      await asOwner(`UPDATE audit_events SET ${col} = ${forged} WHERE id = ${e.id}`);
      const broken = await audit.verify();
      // An untyped literal is coerced to the column type (timestamptz, jsonb, enum, text).
      await asOwner(`UPDATE audit_events SET ${col} = '${orig.replace(/'/g, "''")}' WHERE id = ${e.id}`);
      expect(broken).toMatchObject({ valid: false, firstBrokenId: e.id });
      expect(broken.reason).toBe(col === 'prev_hash' ? 'prev_hash_mismatch' : 'hash_mismatch');
      expect((await audit.verify()).valid).toBe(true);
    });
  }
});

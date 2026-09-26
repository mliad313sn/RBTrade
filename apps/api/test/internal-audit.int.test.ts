import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { bearer, createUser, ownerQuery, startApp, type TestUser } from './helpers';
import { MARKET_OPEN_UTC, MarketFixture } from './market-fixture';

let n = 0;
const cid = () => `ia-${process.pid}-${++n}`;

/**
 * Goal 09 §3: the internal audit view (3rd line) — read-only audit log with hash-chain verification,
 * signed anchors (B-007), reproducible sampling per control, export; auditor independence (SoD);
 * B-303 owners see system events about their own account.
 */
describe('internal audit (3rd line)', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  const md = new MarketFixture();
  let auditor: TestUser;
  let admin: TestUser;
  let trader: TestUser;
  let other: TestUser;

  beforeAll(async () => {
    process.env.KORA_ENGINE_ENABLED = 'false';
    process.env.KORA_RECONCILIATION_INTERVAL_MS = '0';
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    vi.setSystemTime(MARKET_OPEN_UTC);
    app = await startApp();
    http = app.getHttpServer();
    await md.standard();
    auditor = await createUser(app, 'novice', ['auditor']);
    admin = await createUser(app, 'novice', ['admin']);
    trader = await createUser(app, 'trader');
    other = await createUser(app, 'trader');
    await md.touch();
    await request(http).post('/orders').set(bearer(trader.token)).send({ clientOrderId: cid(), symbol: 'BTCUSD', side: 'buy', type: 'limit', qty: '0.01', limitPrice: '64000.0' }).expect(201);
  });
  afterAll(async () => {
    await md.close();
    await app.close();
    vi.useRealTimers();
    delete process.env.KORA_ENGINE_ENABLED;
    delete process.env.KORA_RECONCILIATION_INTERVAL_MS;
  });

  it('the auditor reads every event and verifies the chain, but cannot change anything', async () => {
    const all = await request(http).get('/internal-audit/events?limit=50').set(bearer(auditor.token)).expect(200);
    expect(all.body.events.length).toBe(50);
    const viaAudit = await request(http).get(`/audit?actorId=${trader.id}`).set(bearer(auditor.token)).expect(200);
    expect(viaAudit.body.events.length).toBeGreaterThan(0);
    const v = await request(http).get('/internal-audit/verify').set(bearer(auditor.token)).expect(200);
    expect(v.body.chain).toMatchObject({ valid: true, firstBrokenId: null });
    const csv = await request(http).get('/internal-audit/events/export?action=order.*').set(bearer(auditor.token)).expect(200);
    expect(csv.text.split('\r\n')[0]).toBe('id,ts,actor_id,actor_type,action,entity,entity_id,payload,prev_hash,hash');

    // Read-only: no trading-control, approval, anchor, incident or console write.
    await request(http).post('/internal-audit/anchors').set(bearer(auditor.token)).expect(403);
    await request(http).post('/risk-console/kill-switch').set(bearer(auditor.token)).send({ scope: 'robots', reason: 'no' }).expect(403);
    await request(http).post('/governance/incidents').set(bearer(auditor.token)).send({ title: 'x x x', description: 'y y y', category: 'other' }).expect(403);
    const acct = (await request(http).get('/accounts/me').set(bearer(trader.token))).body.id;
    await request(http).post(`/kill-switch/resume?accountId=${acct}`).set(bearer(auditor.token)).send({ reason: 'not allowed' }).expect(403);
    await request(http)
      .post('/governance/approvals')
      .set(bearer(auditor.token))
      .send({ kind: 'limit_override', accountId: acct, limits: { maxOrderNotional: '2000000' }, reason: 'auditor cannot' })
      .expect(403);
    await request(http).get(`/accounts/${acct}`).set(bearer(auditor.token)).expect((r) => expect([403, 404]).toContain(r.status));
  });

  it('signed anchors: created by an admin, verified by the auditor; a rewritten head no longer matches', async () => {
    const a = await request(http).post('/internal-audit/anchors').set(bearer(admin.token)).expect(201);
    expect(a.body, JSON.stringify(a.body)).toMatchObject({ signatureValid: true, matchesChain: true });
    const list = await request(http).get('/internal-audit/anchors').set(bearer(auditor.token)).expect(200);
    expect(list.body.anchors[0]).toMatchObject({ id: a.body.id, signatureValid: true, matchesChain: true });
    // A forged anchor (hash not in the chain, bad signature) is flagged.
    await ownerQuery(
      `INSERT INTO audit_anchors (head_id, head_hash, event_count, algorithm, key_id, public_jwk, signature, created_by)
       SELECT head_id, repeat('a', 64), event_count, algorithm, key_id, public_jwk, signature, 'forger' FROM audit_anchors WHERE id = $1`,
      [a.body.id],
    );
    const v = await request(http).get('/internal-audit/verify').set(bearer(auditor.token)).expect(200);
    expect(v.body.anchors.invalidSignatures + v.body.anchors.notMatchingChain).toBeGreaterThanOrEqual(1);
    await expect(ownerQuery(`UPDATE audit_anchors SET created_by = 'x' WHERE id = $1`, [a.body.id])).rejects.toThrow(/append-only/);
  });

  it('sampling per control is reproducible with the seed, recorded, and exportable as CSV', async () => {
    // Audit rows carry the database clock (the test fakes Date for market hours).
    const db = (await ownerQuery<{ t: Date }>('SELECT clock_timestamp() AS t'))[0]!.t.getTime();
    const q = { controlId: 'KC-15', n: '3', seed: 'audit-2026-Q3', from: new Date(db - 3_600_000).toISOString(), to: new Date(db + 60_000).toISOString() };
    // KC-15 samples order.rejected events: create a few.
    for (let i = 0; i < 4; i++)
      await request(http).post('/orders').set(bearer(other.token)).send({ clientOrderId: cid(), symbol: 'BTCUSD', side: 'buy', type: 'market', qty: '50' }).expect(422);
    const s1 = await request(http).get('/internal-audit/sample').query(q).set(bearer(auditor.token)).expect(200);
    const s2 = await request(http).get('/internal-audit/sample').query(q).set(bearer(auditor.token)).expect(200);
    expect(s1.body, JSON.stringify(s1.body).slice(0, 500)).toMatchObject({ controlId: 'KC-15', seed: 'audit-2026-Q3', kind: 'audit_events', drawn: 3 });
    expect(s1.body.population).toBeGreaterThanOrEqual(4);
    expect(s1.body.events.map((e: { id: string }) => e.id)).toEqual(s2.body.events.map((e: { id: string }) => e.id));
    expect(s1.body.events.every((e: { action: string }) => e.action === 'order.rejected')).toBe(true);
    const rec = await ownerQuery<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM audit_events WHERE action = 'internal_audit.sample_drawn' AND actor_id = $1 ORDER BY id DESC LIMIT 1`,
      [auditor.id],
    );
    expect(rec[0]!.payload).toMatchObject({ controlId: 'KC-15', seed: 'audit-2026-Q3', drawn: 3 });
    const csv = await request(http).get('/internal-audit/sample').query({ ...q, format: 'csv' }).set(bearer(auditor.token)).expect(200);
    expect(csv.headers['x-kora-sample-seed']).toBe('audit-2026-Q3');
    expect(csv.text.trim().split('\r\n')).toHaveLength(4);
    // A control without audit actions samples its evidence rows.
    const rows = await request(http).get('/internal-audit/sample').query({ controlId: 'KC-23', n: '2', seed: '7' }).set(bearer(auditor.token)).expect(200);
    expect(rows.body).toMatchObject({ kind: 'evidence_rows', drawn: 2 });
    await request(http).get('/internal-audit/sample').query(q).set(bearer(trader.token)).expect(403);
  });

  it('segregation of duties: an auditor cannot also hold an operating role (API and database)', async () => {
    const res = await request(http).put(`/admin/users/${auditor.id}/roles`).set(bearer(admin.token)).send({ roles: ['novice', 'auditor', 'trader'] }).expect(400);
    expect(res.body.error).toBe('segregation_of_duties');
    await expect(ownerQuery(`INSERT INTO user_roles (user_id, role) VALUES ($1, 'risk_officer')`, [auditor.id])).rejects.toThrow(/segregation of duties/);
    await expect(ownerQuery(`INSERT INTO user_roles (user_id, role) VALUES ($1, 'auditor')`, [trader.id])).rejects.toThrow(/segregation of duties/);
  });

  it('B-303: an owner sees system events about their own account, not other accounts', async () => {
    const mine = await request(http).get('/audit?actorType=system&limit=200').set(bearer(trader.token)).expect(200);
    const acct = (await request(http).get('/accounts/me').set(bearer(trader.token))).body.id;
    expect(mine.body.events.length).toBeGreaterThan(0);
    expect(mine.body.events.every((e: { payload: { accountId?: string } }) => e.payload.accountId === acct)).toBe(true);
    expect(mine.body.events.some((e: { actorId: string; action: string }) => e.actorId === 'paper-engine' && e.action === 'order.working')).toBe(true);
    await request(http).get(`/audit?actorId=${other.id}`).set(bearer(trader.token)).expect(403);
  });
});

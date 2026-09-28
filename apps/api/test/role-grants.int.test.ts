import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bearer, createUser, login, ownerQuery, startApp, type TestUser } from './helpers';

/**
 * IRTC R4-02 and R4-10 (docs/review/IRTC-R4-fixes.md): one admin cannot defeat four-eyes with a
 * self-made approver, and `trader` is not granted outside the appropriateness path without a
 * second person and a reason.
 */
describe('privileged role grants (IRTC R4-02, R4-10)', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let adminA: TestUser;
  let adminB: TestUser;
  let risk: TestUser;
  let auditor: TestUser;
  let sock: TestUser;
  let victim: TestUser;
  let plain: TestUser;

  const setRoles = (u: TestUser, id: string, body: Record<string, unknown>) =>
    request(http).put(`/admin/users/${id}/roles`).set(bearer(u.token)).send(body);
  const approve = (u: TestUser, id: string) =>
    request(http)
      .post(`/governance/approvals/${id}/approve`)
      .set(bearer(u.token))
      .send({ note: 'reviewed' });
  const rolesOf = async (id: string) =>
    (
      await ownerQuery<{ role: string }>(
        'SELECT role FROM user_roles WHERE user_id = $1 ORDER BY role',
        [id],
      )
    ).map((r) => r.role);

  beforeAll(async () => {
    process.env.KORA_ENGINE_ENABLED = 'false';
    process.env.KORA_RECONCILIATION_INTERVAL_MS = '0';
    app = await startApp();
    http = app.getHttpServer();
    adminA = await createUser(app, 'novice', ['admin'], { realClock: true });
    adminB = await createUser(app, 'novice', ['admin'], { realClock: true });
    risk = await createUser(app, 'novice', ['risk_officer'], { realClock: true });
    auditor = await createUser(app, 'novice', ['auditor'], { realClock: true });
    sock = await createUser(app, 'novice', [], { realClock: true });
    victim = await createUser(app, 'trader', [], { realClock: true });
    plain = await createUser(app, 'novice', [], { realClock: true });
  });
  afterAll(async () => {
    await app.close();
    delete process.env.KORA_ENGINE_ENABLED;
    delete process.env.KORA_RECONCILIATION_INTERVAL_MS;
  });

  it('granting an approval-conferring role opens a four-eyes request; nothing changes until a second admin approves', async () => {
    const r = await setRoles(adminA, sock.id, {
      roles: ['novice', 'risk_officer'],
      reason: 'new 2nd-line analyst',
    }).expect(202);
    expect(r.body).toMatchObject({ status: 'pending', kind: 'role_grant' });
    expect(await rolesOf(sock.id)).toEqual(['novice']);
    // The requester cannot approve; a risk officer cannot approve a role grant (admins only).
    await approve(adminA, r.body.requestId).expect(403);
    const ro = await approve(risk, r.body.requestId).expect(403);
    expect(ro.body.error).toBe('forbidden');
    await approve(adminB, r.body.requestId).expect(200);
    expect(await rolesOf(sock.id)).toEqual(['novice', 'risk_officer']);
    const [g] = await ownerQuery<{
      granted_by: string;
      approved_by: string;
      four_eyes_request_id: string;
    }>(
      "SELECT granted_by, approved_by, four_eyes_request_id FROM user_roles WHERE user_id = $1 AND role = 'risk_officer'",
      [sock.id],
    );
    expect(g).toEqual({
      granted_by: adminA.id,
      approved_by: adminB.id,
      four_eyes_request_id: r.body.requestId,
    });
  });

  it('an approver whose approval role was granted by the requester cannot approve that requester (the sock-puppet attack)', async () => {
    // sock re-signs in to pick up the new role (in the next second: sessions before the grant end).
    await new Promise((r) => setTimeout(r, 1100));
    const s = await login(app, sock.email, undefined, { realClock: true });
    sock = { ...sock, ...s };
    const req = await request(http)
      .post('/governance/approvals')
      .set(bearer(adminA.token))
      .send({ kind: 'mfa_reset', userId: victim.id, reason: 'lost phone (ticket 42)' })
      .expect(201);
    const denied = await approve(sock, req.body.id).expect(403);
    expect(denied.body.error).toBe('approver_not_independent');
    expect(await ownerQuery('SELECT 1 FROM user_mfa WHERE user_id = $1', [victim.id])).toHaveLength(
      1,
    );
    // An independent admin can still decide it.
    await request(http)
      .post(`/governance/approvals/${req.body.id}/reject`)
      .set(bearer(adminB.token))
      .send({ note: 'not verified' })
      .expect(200);
  });

  it('IRTC re-verify R1-02/R4-02: the admin who requested a puppet admin role cannot decide the puppet requests (reverse direction)', async () => {
    // A requests admin for a second identity it controls; B (honest) approves once.
    const puppet = await createUser(app, 'novice', [], { realClock: true });
    const g = await setRoles(adminA, puppet.id, {
      roles: ['novice', 'admin'],
      reason: 'new operations admin',
    }).expect(202);
    await approve(adminB, g.body.requestId).expect(200);
    await new Promise((r) => setTimeout(r, 1100));
    const p = { ...puppet, ...(await login(app, puppet.email, undefined, { realClock: true })) };
    // The puppet requests an MFA reset of the victim; A approves it. That is one person on both sides.
    const req = await request(http)
      .post('/governance/approvals')
      .set(bearer(p.token))
      .send({ kind: 'mfa_reset', userId: victim.id, reason: 'lost phone (ticket 77)' })
      .expect(201);
    const denied = await approve(adminA, req.body.id).expect(403);
    expect(denied.body.error).toBe('approver_not_independent');
    // B approved the puppet's role, so B is not independent of it either.
    const deniedB = await approve(adminB, req.body.id).expect(403);
    expect(deniedB.body.error).toBe('approver_not_independent');
    expect(await ownerQuery('SELECT 1 FROM user_mfa WHERE user_id = $1', [victim.id])).toHaveLength(
      1,
    );
    // Nor can A approve a role grant the puppet requests for a third identity.
    const third = await createUser(app, 'novice', [], { realClock: true });
    const g3 = await setRoles(p, third.id, {
      roles: ['novice', 'risk_officer'],
      reason: 'more operations staff',
    }).expect(202);
    const denied3 = await approve(adminA, g3.body.requestId).expect(403);
    expect(denied3.body.error).toBe('approver_not_independent');
    expect(await rolesOf(third.id)).toEqual(['novice']);
  });

  it('self-grants are refused, including adding a role to yourself', async () => {
    const r = await setRoles(adminA, adminA.id, {
      roles: ['novice', 'admin', 'risk_officer'],
      reason: 'more power',
    }).expect(403);
    expect(r.body.error).toBe('self_grant');
    expect(await rolesOf(adminA.id)).toEqual(['admin', 'novice']);
  });

  it('trader outside the appropriateness path needs a reason and a second admin, and is flagged as an override (R4-10)', async () => {
    const noReason = await setRoles(adminA, plain.id, { roles: ['novice', 'trader'] }).expect(400);
    expect(noReason.body.error).toBe('reason_required');
    const r = await setRoles(adminA, plain.id, {
      roles: ['novice', 'trader'],
      reason: 'assessed offline by Compliance (case 7)',
    }).expect(202);
    const [row] = await ownerQuery<{ payload: Record<string, unknown> }>(
      'SELECT payload FROM four_eyes_requests WHERE id = $1',
      [r.body.requestId],
    );
    expect(row!.payload).toMatchObject({
      appropriatenessPassed: false,
      appropriatenessOverride: true,
      added: ['trader'],
    });
    expect(await rolesOf(plain.id)).toEqual(['novice']);
    await approve(adminB, r.body.requestId).expect(200);
    expect(await rolesOf(plain.id)).toEqual(['novice', 'trader']);
    const [ev] = await ownerQuery<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM audit_events WHERE action = 'admin.roles_changed' AND entity_id = $1 ORDER BY id DESC LIMIT 1",
      [plain.id],
    );
    expect(ev!.payload).toMatchObject({
      requestId: r.body.requestId,
      requestedBy: adminA.id,
      approvedBy: adminB.id,
      appropriatenessOverride: true,
    });
  });

  it('non-privileged changes (quant, removals) still apply directly', async () => {
    const q = await createUser(app, 'novice', [], { realClock: true });
    await setRoles(adminA, q.id, { roles: ['novice', 'quant'] }).expect(200);
    expect(await rolesOf(q.id)).toEqual(['novice', 'quant']);
    await setRoles(adminA, q.id, { roles: ['novice'] }).expect(200);
    expect(await rolesOf(q.id)).toEqual(['novice']);
  });

  it('control evidence detects an approval by someone whose approval role the requester granted (KC-08) and grants without four-eyes (KC-02)', async () => {
    // Legacy state from before the rule: risk's role was granted by adminA, and risk approved adminA.
    await ownerQuery(
      "UPDATE user_roles SET granted_by = $2 WHERE user_id = $1 AND role = 'risk_officer'",
      [risk.id, adminA.id],
    );
    const [fe] = await ownerQuery<{ id: string }>(
      `INSERT INTO four_eyes_requests (kind, subject_type, subject_id, payload, reason, requested_by, expires_at)
       VALUES ('mfa_reset', 'user', $1, jsonb_build_object('userId', $1::text), 'legacy row', $2, now() + interval '1 hour') RETURNING id`,
      [plain.id, adminA.id],
    );
    await ownerQuery(
      "UPDATE four_eyes_requests SET status = 'approved', decided_by = $2, decided_at = clock_timestamp(), decision_note = 'legacy' WHERE id = $1",
      [fe!.id, risk.id],
    );
    const range = {
      from: new Date(Date.now() - 3_600_000).toISOString(),
      to: new Date(Date.now() + 3_600_000).toISOString(),
      format: 'json',
    };
    const kc08 = await request(http)
      .get('/governance/controls/KC-08/evidence')
      .query(range)
      .set(bearer(auditor.token))
      .expect(200);
    expect(kc08.body.evidence.summary.approver_role_granted_by_requester).toBeGreaterThanOrEqual(1);
    const kc02 = await request(http)
      .get('/governance/controls/KC-02/evidence')
      .query(range)
      .set(bearer(auditor.token))
      .expect(200);
    expect(kc02.body.evidence.summary).toMatchObject({ privileged_grants_without_four_eyes: 0 });
    expect(kc02.body.evidence.summary.privileged_grants_with_four_eyes).toBeGreaterThanOrEqual(2);
  });
});

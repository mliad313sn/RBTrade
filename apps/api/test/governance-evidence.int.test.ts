import { createHash } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { CONTROLS } from '../src/governance/controls/catalogue';
import { acknowledgeRiskWarning, bearer, createUser, ownerQuery, startApp, type TestUser } from './helpers';
import { MARKET_OPEN_UTC, MarketFixture } from './market-fixture';

let n = 0;
const cid = () => `ev-${process.pid}-${++n}`;
const dbNow = async () => (await ownerQuery<{ t: Date }>('SELECT clock_timestamp() AS t'))[0]!.t;

/** Supertest parser that keeps binary bodies (PDF) as a Buffer. */
const binary = (res: request.Response, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

/**
 * Goal 09 acceptance: "Every control in the matrix names a working automated evidence source, and the
 * export produces it for a chosen date range (test for 5 sample controls)."
 */
describe('control evidence export', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  const md = new MarketFixture();
  let risk: TestUser;
  let risk2: TestUser;
  let auditor: TestUser;
  let trader: TestUser;
  let novice: TestUser;
  let t0: string;

  beforeAll(async () => {
    process.env.KORA_ENGINE_ENABLED = 'false';
    process.env.KORA_RECONCILIATION_INTERVAL_MS = '0';
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    vi.setSystemTime(MARKET_OPEN_UTC);
    app = await startApp();
    http = app.getHttpServer();
    await md.standard();
    risk = await createUser(app, 'novice', ['risk_officer']);
    risk2 = await createUser(app, 'novice', ['risk_officer']);
    auditor = await createUser(app, 'novice', ['auditor']);
    trader = await createUser(app, 'trader');
    novice = await createUser(app, 'novice');
    // Periods use the database clock (the test fakes Date for market hours; rows carry DB time).
    t0 = new Date((await dbNow()).getTime() - 1000).toISOString();

    // Activity the sample controls evidence: a fill, a limit rejection, a four-eyes approval,
    // a reconciliation run and a disclosure acknowledgement.
    await md.touch();
    await request(http).post('/orders').set(bearer(trader.token)).send({ clientOrderId: cid(), symbol: 'BTCUSD', side: 'buy', type: 'market', qty: '0.1' }).expect(201);
    const rej = await request(http).post('/orders').set(bearer(trader.token)).send({ clientOrderId: cid(), symbol: 'BTCUSD', side: 'buy', type: 'market', qty: '50' });
    expect(rej.status).toBe(422);
    expect(rej.body.code).toBe('MAX_ORDER_NOTIONAL');
    const acct = (await request(http).get('/accounts/me').set(bearer(trader.token))).body.id as string;
    const fe = await request(http)
      .post('/governance/approvals')
      .set(bearer(risk.token))
      .send({ kind: 'limit_override', accountId: acct, limits: { dailyLossLimit: '7500' }, reason: 'Evidence test (SIMULATED)' })
      .expect(201);
    await request(http).post(`/governance/approvals/${fe.body.id}/approve`).set(bearer(risk2.token)).send({ note: 'approved' }).expect(200);
    await request(http).post('/reconciliation/run').set(bearer(risk.token)).expect(200);
    await acknowledgeRiskWarning(app, novice.token);
  });
  afterAll(async () => {
    await md.close();
    await app.close();
    vi.useRealTimers();
    delete process.env.KORA_ENGINE_ENABLED;
    delete process.env.KORA_RECONCILIATION_INTERVAL_MS;
  });

  const evidence = (u: TestUser, id: string, q: Record<string, string>) =>
    request(http).get(`/governance/controls/${id}/evidence`).query(q).set(bearer(u.token));

  it('the catalogue covers every required area, and every control has COBIT refs, an owner line, a frequency, a test procedure and an implemented evidence query', async () => {
    const res = await request(http).get('/governance/controls').set(bearer(auditor.token)).expect(200);
    const controls = res.body.controls as Array<{ id: string; area: string; cobit: string[]; ownerLine: number; frequency: string; testProcedure: string[]; evidenceImplemented: boolean }>;
    expect(controls).toHaveLength(CONTROLS.length);
    for (const c of controls) {
      expect(c.cobit.length, c.id).toBeGreaterThan(0);
      expect([1, 2, 3]).toContain(c.ownerLine);
      expect(c.frequency).toBeTruthy();
      expect(c.testProcedure.length).toBeGreaterThan(0);
      expect(c.evidenceImplemented, c.id).toBe(true);
    }
    const areas = new Set(controls.map((c) => c.area));
    for (const a of ['access_mfa', 'segregation_of_duties', 'change_management', 'audit_log_integrity', 'pre_trade_risk', 'reconciliation', 'ai_oversight', 'data_retention', 'incident_management', 'backup_restore'])
      expect(areas.has(a), a).toBe(true);
    expect(new Set(controls.map((c) => c.ownerLine))).toEqual(new Set([1, 2, 3]));
  });

  it('every control’s evidence source runs and returns a table for a period (JSON)', async () => {
    const q = { from: t0, to: new Date((await dbNow()).getTime() + 60_000).toISOString() };
    for (const c of CONTROLS) {
      const res = await evidence(risk, c.id, q);
      expect(res.status, `${c.id}: ${JSON.stringify(res.body).slice(0, 300)}`).toBe(200);
      expect(res.body.control.id).toBe(c.id);
      expect(Array.isArray(res.body.evidence.columns)).toBe(true);
      expect(res.body.evidence.columns.length).toBeGreaterThan(0);
      for (const row of res.body.evidence.rows) expect(row).toHaveLength(res.body.evidence.columns.length);
      expect(res.body.range).toEqual({ from: new Date(q.from).toISOString(), to: new Date(q.to).toISOString() });
    }
  });

  it('5 sample controls: CSV and PDF for a chosen period contain the period’s evidence and nothing outside it', async () => {
    const inRange = { from: t0, to: new Date((await dbNow()).getTime() + 60_000).toISOString() };
    const before = { from: new Date(Date.parse(t0) - 3 * 86_400_000).toISOString(), to: new Date(Date.parse(t0) - 2 * 86_400_000).toISOString() };

    // KC-06 four-eyes limit loosening: the approved request is in the period, requester ≠ approver.
    const kc06 = await evidence(auditor, 'KC-06', { ...inRange, format: 'json' }).expect(200);
    expect(kc06.body.evidence.summary).toMatchObject({ approved: expect.any(Number), requester_equals_approver: 0 });
    expect(kc06.body.evidence.summary.approved).toBeGreaterThanOrEqual(1);
    const kc06csv = await evidence(auditor, 'KC-06', { ...inRange, format: 'csv' }).expect(200);
    expect(kc06csv.headers['content-type']).toMatch(/text\/csv/);
    expect(kc06csv.text.split('\r\n')[0]).toBe('id,kind,subject_type,subject_id,requested_by,requested_at,status,decided_by,decided_at,reason,decision_note');
    expect(kc06csv.text).toContain(risk.id);
    expect(kc06csv.text).toContain(risk2.id);
    const kc06old = await evidence(auditor, 'KC-06', { ...before, format: 'csv' }).expect(200);
    expect(kc06old.text).not.toContain(risk2.id);

    // KC-12 audit-log integrity: the chain is valid and the period's events are counted.
    const kc12 = await evidence(auditor, 'KC-12', { ...inRange, format: 'csv' }).expect(200);
    const [head12, row12] = kc12.text.trim().split('\r\n');
    const cols = head12!.split(',');
    const vals = row12!.split(',');
    expect(vals[cols.indexOf('valid')]).toBe('true');
    expect(Number(vals[cols.indexOf('events_in_period')])).toBeGreaterThan(0);

    // KC-15 pre-trade limits: the MAX_ORDER_NOTIONAL rejection is in the period only.
    const kc15 = await evidence(risk, 'KC-15', { ...inRange, format: 'csv' }).expect(200);
    expect(kc15.text).toMatch(/MAX_ORDER_NOTIONAL,\d+,\d+,true/);
    const kc15old = await evidence(risk, 'KC-15', { ...before, format: 'csv' }).expect(200);
    expect(kc15old.text.trim()).toBe('code,rejections,accounts,limit_code');

    // KC-20 reconciliation: the manual run is in the period.
    // Reconciliation runs are stamped with the application clock (faked to market hours here).
    const appRange = { from: new Date(Date.now() - 3_600_000).toISOString(), to: new Date(Date.now() + 60_000).toISOString() };
    const kc20 = await evidence(risk, 'KC-20', { ...appRange, format: 'json' }).expect(200);
    expect(kc20.body.evidence.summary.runs).toBeGreaterThanOrEqual(1);
    expect(kc20.body.evidence.rows.some((r: unknown[]) => r[1] === 'manual')).toBe(true);

    // KC-27 disclosures before the first order: the acknowledgement is in the period; no violation.
    const kc27 = await evidence(risk, 'KC-27', { ...inRange, format: 'json' }).expect(200);
    expect(kc27.body.evidence.summary.acknowledgements).toBeGreaterThanOrEqual(1);
    expect(kc27.body.evidence.summary.novice_orders_before_any_acknowledgement).toBe(0);

    // PDF for each of the five: a real PDF, audited with the file's SHA-256.
    for (const id of ['KC-06', 'KC-12', 'KC-15', 'KC-20', 'KC-27']) {
      const pdf = await evidence(auditor, id, { ...inRange, format: 'pdf' }).buffer(true).parse(binary).expect(200);
      const body = pdf.body as Buffer;
      expect(pdf.headers['content-type']).toBe('application/pdf');
      expect(pdf.headers['content-disposition']).toContain(`kora-evidence_${id}_`);
      expect(body.subarray(0, 8).toString('latin1')).toBe('%PDF-1.4');
      expect(body.subarray(-6).toString('latin1')).toContain('%%EOF');
      expect(body.toString('latin1')).toContain(`KORA control evidence - ${id}`);
      const sha = createHash('sha256').update(body).digest('hex');
      expect(pdf.headers['x-kora-evidence-sha256']).toBe(sha);
      const audit = await ownerQuery<{ actor_id: string; payload: Record<string, string> }>(
        `SELECT actor_id, payload FROM audit_events WHERE action = 'governance.evidence_exported' AND payload->>'sha256' = $1`,
        [sha],
      );
      expect(audit[0]).toMatchObject({ actor_id: auditor.id, payload: { controlId: id, format: 'pdf' } });
    }
  });

  it('only the 2nd and 3rd line can export; bad periods are refused; the retention report shows placeholders', async () => {
    await evidence(trader, 'KC-01', {}).expect(403);
    await evidence(novice, 'KC-01', {}).expect(403);
    await evidence(risk, 'KC-99', {}).expect(404);
    await evidence(risk, 'KC-01', { from: '2026-09-02T00:00:00Z', to: '2026-09-01T00:00:00Z' }).expect(400);
    await evidence(risk, 'KC-01', { from: '2024-01-01T00:00:00Z', to: '2026-01-01T00:00:00Z' }).expect(400);
    const res = await request(http).get('/governance/retention').set(bearer(auditor.token)).expect(200);
    expect(res.body.policy.find((p: { id: string }) => p.id === 'audit_events')).toMatchObject({ periodDays: null, openQuestion: 'OQ-R4' });
    expect(res.body.report.find((p: { id: string }) => p.id === 'md_trades')).toMatchObject({ periodDays: 7, placeholder: false });
  });
});

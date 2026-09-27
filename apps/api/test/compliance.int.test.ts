import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import suitabilityV1 from '../src/appropriateness/questionnaires/suitability.v1.json';
import riskWarningV1 from '../src/disclosures/risk-warning.v1.json';
import { acknowledgeRiskWarning, bearer, createUser, ownerQuery, passingAnswers, startApp, type TestUser } from './helpers';
import { MARKET_OPEN_UTC, MarketFixture } from './market-fixture';

let n = 0;
const cid = () => `co-${process.pid}-${++n}`;

/**
 * Goal 09 compliance hooks. Acceptance: "The disclosure version in force at the time of each
 * acknowledgement can be retrieved for any user." Plus the first-order gate (B-801), the registry
 * (versions, jurisdictions, effective dates, placeholders, four-eyes publication), suitability,
 * the KYC stub, best-execution data, subject access and retention.
 */
describe('compliance hooks', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  const md = new MarketFixture();
  let riskA: TestUser;
  let riskB: TestUser;
  let auditor: TestUser;
  let novice: TestUser;
  let trader: TestUser;

  const approve = (u: TestUser, id: string) => request(http).post(`/governance/approvals/${id}/approve`).set(bearer(u.token)).send({ note: 'reviewed' });
  const setRetailLoss = async (value: string | null) => {
    const r = await request(http)
      .post('/governance/approvals')
      .set(bearer(riskA.token))
      .send({ kind: 'disclosure_publish', jurisdiction: 'GLOBAL', value: { key: 'retailLossPct', value }, reason: 'Compliance figure update (test)' })
      .expect(201);
    expect((await approve(riskA, r.body.id).expect(403)).body.error).toBe('four_eyes');
    await approve(riskB, r.body.id).expect(200);
  };
  const novOrder = (u: TestUser) =>
    request(http).post('/orders').set(bearer(u.token)).send({ clientOrderId: cid(), symbol: 'BTCUSD', side: 'buy', type: 'market', qty: '0.01', stopLossPrice: '63000.0' });

  beforeAll(async () => {
    process.env.KORA_ENGINE_ENABLED = 'false';
    process.env.KORA_RECONCILIATION_INTERVAL_MS = '0';
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    vi.setSystemTime(MARKET_OPEN_UTC);
    app = await startApp();
    http = app.getHttpServer();
    await md.standard();
    riskA = await createUser(app, 'novice', ['risk_officer']);
    riskB = await createUser(app, 'novice', ['risk_officer']);
    auditor = await createUser(app, 'novice', ['auditor']);
    novice = await createUser(app, 'novice');
    trader = await createUser(app, 'trader');
  });
  afterAll(async () => {
    await md.close();
    await app.close();
    vi.useRealTimers();
    delete process.env.KORA_ENGINE_ENABLED;
    delete process.env.KORA_RECONCILIATION_INTERVAL_MS;
  });

  it('B-801: a novice cannot add exposure before acknowledging the risk warning in force; a trader is not gated', async () => {
    await md.touch();
    const blocked = await novOrder(novice).expect(422);
    expect(blocked.body.code).toBe('DISCLOSURE_NOT_ACKNOWLEDGED');
    const prev = await request(http).post('/orders/preview').set(bearer(novice.token)).send({ symbol: 'BTCUSD', side: 'buy', type: 'market', qty: '0.01', stopLossPrice: '63000.0' }).expect(200);
    expect(prev.body.risk.violations.map((v: { code: string }) => v.code)).toContain('DISCLOSURE_NOT_ACKNOWLEDGED');
    await request(http).post('/orders').set(bearer(trader.token)).send({ clientOrderId: cid(), symbol: 'BTCUSD', side: 'buy', type: 'market', qty: '0.01' }).expect(201);
    await acknowledgeRiskWarning(app, novice.token);
    const ok = await novOrder(novice);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
  });

  it('the registry is versioned per jurisdiction with effective dates; values stay placeholders with an owner until published through four-eyes', async () => {
    const d = await request(http).get('/disclosures/risk-warning?locale=en').set(bearer(novice.token)).expect(200);
    expect(d.body.document).toMatchObject({ id: 'risk-warning', version: '1', jurisdiction: 'GLOBAL', placeholder: true, values: { retailLossPct: '[XX]' } });
    expect(d.body.document.effectiveFrom).toBe('2026-09-26T00:00:00.000Z');
    expect(d.body.acknowledged).toBe(true);
    const ph = await request(http).get('/governance/placeholders').set(bearer(auditor.token)).expect(200);
    expect(ph.body.placeholders).toContainEqual({ key: 'retailLossPct', jurisdiction: 'GLOBAL', owner: 'Sponsor / Compliance', openQuestion: 'OQ-R1' });
    const versions = await request(http).get('/compliance/disclosures/risk-warning/versions').set(bearer(auditor.token)).expect(200);
    expect(versions.body.published).toContainEqual(expect.objectContaining({ version: '1', jurisdiction: 'GLOBAL' }));

    // A new text version, drafted by A and scheduled for the future through four-eyes (B approves).
    const v2 = {
      ...riskWarningV1,
      version: '2',
      locales: {
        en: { ...riskWarningV1.locales.en, title: 'Trading can lose you money (v2 test)' },
        fr: { ...riskWarningV1.locales.fr, title: 'Le trading peut vous faire perdre de l’argent (v2 test)' },
      },
    };
    await request(http).post('/compliance/disclosures/drafts').set(bearer(riskA.token)).send({ jurisdiction: 'GLOBAL', definition: v2 }).expect(201);
    await request(http).post('/compliance/disclosures/drafts').set(bearer(riskA.token)).send({ jurisdiction: 'GLOBAL', definition: v2 }).expect(409);
    await request(http).post('/compliance/disclosures/drafts').set(bearer(auditor.token)).send({ jurisdiction: 'GLOBAL', definition: v2 }).expect(403);
    const pub = await request(http)
      .post('/governance/approvals')
      .set(bearer(riskB.token))
      .send({ kind: 'disclosure_publish', jurisdiction: 'GLOBAL', effectiveFrom: '2030-01-01T00:00:00Z', document: { disclosureId: 'risk-warning', version: '2' }, reason: 'Annual review (test)' })
      .expect(201);
    // The requester cannot approve; the drafter cannot approve either (independent approver).
    await approve(riskB, pub.body.id).expect(403);
    expect((await approve(riskA, pub.body.id).expect(403)).body.error).toBe('four_eyes');
    const third = await createUser(app, 'novice', ['risk_officer']);
    await approve(third, pub.body.id).expect(200);
    const now = await request(http).get('/compliance/disclosures/risk-warning/at').set(bearer(auditor.token)).expect(200);
    expect(now.body.document.version).toBe('1');
    const future = await request(http).get('/compliance/disclosures/risk-warning/at?at=2030-06-01T00:00:00Z&locale=fr').set(bearer(auditor.token)).expect(200);
    expect(future.body.document).toMatchObject({ version: '2', locale: 'fr', effectiveFrom: '2030-01-01T00:00:00.000Z' });
    expect(future.body.document.title).toContain('(v2 test)');
    await expect(ownerQuery(`UPDATE disclosure_documents SET review_status = 'x' WHERE id = 'risk-warning' AND version = '2'`)).rejects.toThrow(/immutable/);
    await expect(ownerQuery(`UPDATE disclosure_values SET value = '1'`)).rejects.toThrow(/append-only/);
  });

  it('acceptance: the disclosure version in force at each acknowledgement is retrievable for any user, and verified', async () => {
    const u = await createUser(app, 'novice');
    await acknowledgeRiskWarning(app, u.token); // v1 with the [XX] placeholder
    await setRetailLoss('74'); // Compliance sets the figure (SIMULATED value for the test only)
    try {
      const d = await request(http).get('/disclosures/risk-warning?locale=en').set(bearer(u.token)).expect(200);
      expect(d.body.document).toMatchObject({ placeholder: false, values: { retailLossPct: '74' } });
      expect(d.body.document.banner).toContain('74% of retail accounts lose money');
      expect(d.body.acknowledged).toBe(false);
      // A new figure means acknowledging again before the next order (B-801).
      await md.touch();
      expect((await novOrder(u).expect(422)).body.code).toBe('DISCLOSURE_NOT_ACKNOWLEDGED');
      await request(http)
        .post('/disclosures/risk-warning/acknowledgements')
        .set(bearer(u.token))
        .send({ version: d.body.document.version, contentHash: d.body.document.contentHash, locale: 'en', context: 'reconfirm' })
        .expect(201);
      await novOrder(u).expect(201);

      const hist = await request(http).get(`/compliance/acknowledgements?userId=${u.id}`).set(bearer(auditor.token)).expect(200);
      const acks = hist.body.acknowledgements as Array<{ values: Record<string, string>; verified: boolean; inForceNow: boolean; document: { banner: string; version: string; jurisdiction: string } }>;
      expect(acks).toHaveLength(2);
      expect(acks.every((a) => a.verified)).toBe(true);
      const [latest, first] = acks;
      expect(first!.document.banner).toContain('[XX]% of retail accounts');
      expect(first!).toMatchObject({ values: { retailLossPct: '[XX]' }, inForceNow: false, document: { version: '1', jurisdiction: 'GLOBAL' } });
      expect(latest!.document.banner).toContain('74% of retail accounts');
      expect(latest!.inForceNow).toBe(true);
      const mine = await request(http).get('/me/acknowledgements').set(bearer(u.token)).expect(200);
      expect(mine.body.acknowledgements).toHaveLength(2);
      await request(http).get(`/compliance/acknowledgements?userId=${u.id}`).set(bearer(trader.token)).expect(403);
    } finally {
      await setRetailLoss(null); // back to the placeholder (OQ-R1) for the other suites
    }
    const back = await request(http).get('/disclosures/risk-warning?locale=en').set(bearer(u.token)).expect(200);
    expect(back.body.document.values.retailLossPct).toBe('[XX]');
  });

  it('suitability on the questionnaire engine (fed by appropriateness and the knowledge check); profile, not advice', async () => {
    const q = await request(http).get('/suitability/questionnaire').set(bearer(novice.token)).expect(200);
    expect(q.body.questionnaire).toMatchObject({ id: 'suitability', kind: 'suitability', simulated: true });
    expect(JSON.stringify(q.body)).not.toContain('"points"');
    const r = await request(http)
      .post('/suitability/attempts')
      .set(bearer(trader.token))
      .send({ questionnaireId: 'suitability', version: 1, answers: passingAnswers(suitabilityV1) })
      .expect(200);
    expect(r.body).toMatchObject({ scorePct: 100, band: 'adventurous', simulated: true });
    const p = await request(http).get('/me/suitability').set(bearer(trader.token)).expect(200);
    expect(p.body).toMatchObject({ complete: true, suitability: { band: 'adventurous' }, appropriateness: { everPassed: { version: 1 } } });
    expect(p.body.notAdvice).toMatch(/not a recommendation/);
    const byRisk = await request(http).get(`/compliance/suitability/${trader.id}`).set(bearer(riskA.token)).expect(200);
    expect(byRisk.body.suitability.band).toBe('adventurous');
    await request(http).get(`/compliance/suitability/${trader.id}`).set(bearer(novice.token)).expect(403);
    const stored = await ownerQuery<{ score_pct: number }>(`SELECT score_pct FROM questionnaire_attempts WHERE user_id = $1 AND questionnaire_id = 'suitability'`, [trader.id]);
    expect(stored).toEqual([{ score_pct: 100 }]);
  });

  it('KYC is a stub: providers listed as flagged/unlicensed, status not configured, start refused', async () => {
    const p = await request(http).get('/compliance/kyc/providers').set(bearer(riskA.token)).expect(200);
    expect(p.body.providers).toEqual([expect.objectContaining({ id: 'kyc-stub', flagged: true, licensed: false })]);
    expect((await request(http).get('/me/kyc').set(bearer(novice.token)).expect(200)).body.status).toBe('not_configured');
    expect((await request(http).post('/me/kyc').set(bearer(novice.token)).expect(503)).body.error).toBe('kyc_not_configured');
  });

  it('best-execution data: slippage by instrument and by hour from real fills', async () => {
    const byInst = await request(http).get('/compliance/best-execution').set(bearer(auditor.token)).expect(200);
    const btc = byInst.body.rows.find((r: { group: string }) => r.group === 'BTCUSD');
    expect(btc.fills).toBeGreaterThanOrEqual(1);
    expect(btc).toHaveProperty('p95_slippage_bps');
    const byHour = await request(http).get('/compliance/best-execution?groupBy=hour').set(bearer(auditor.token)).expect(200);
    expect(byHour.body.rows[0].group).toMatch(/^\d{2}:00 UTC$/);
    await request(http).get('/compliance/best-execution').set(bearer(trader.token)).expect(403);
  });

  it('subject access: a user exports their data (no secrets), a risk officer can on their behalf; both audited', async () => {
    const mine = await request(http).get('/me/data-export').set(bearer(trader.token)).expect(200);
    expect(mine.body).toMatchObject({ subjectId: trader.id, mode: 'self_service' });
    expect(mine.body.data.profile[0]).toMatchObject({ id: trader.id, email: trader.email });
    expect(mine.body.data.orders.length).toBeGreaterThan(0);
    expect(mine.body.data.mfa[0]).toMatchObject({ enrolled: true });
    const text = JSON.stringify(mine.body);
    expect(text).not.toContain('password_hash');
    expect(text).not.toContain('totp_secret');
    expect(text).not.toMatch(/scrypt\$/);
    // IRTC R4-13: every table about the subject, and audit events other actors recorded about them.
    for (const section of ['strategy_versions', 'backtest_runs', 'robot_signals', 'robot_promotions', 'intel_alert_events', 'revoked_tokens', 'equity_snapshots', 'audit_events_about_you'])
      expect(mine.body.data, section).toHaveProperty(section);
    const onBehalf = await request(http).get(`/compliance/subject-access/${trader.id}`).set(bearer(riskA.token)).expect(200);
    expect(onBehalf.body.mode).toBe('on_behalf');
    // The risk officer's earlier export is an event about the trader recorded by someone else.
    const again = await request(http).get('/me/data-export').set(bearer(trader.token)).expect(200);
    const about = again.body.data.audit_events_about_you as Array<{ action: string; actor_id: string }>;
    expect(about.some((e) => e.action === 'privacy.subject_access_exported' && e.actor_id === riskA.id)).toBe(true);
    await request(http).get(`/compliance/subject-access/${trader.id}`).set(bearer(auditor.token)).expect(403);
    const audit = await ownerQuery<{ actor_id: string; payload: { mode: string } }>(
      `SELECT actor_id, payload FROM audit_events WHERE action = 'privacy.subject_access_exported' AND entity_id = $1 ORDER BY id`,
      [trader.id],
    );
    expect(audit.map((a) => [a.actor_id, a.payload.mode])).toEqual([
      [trader.id, 'self_service'],
      [riskA.id, 'on_behalf'],
      [trader.id, 'self_service'],
    ]);
  });
});

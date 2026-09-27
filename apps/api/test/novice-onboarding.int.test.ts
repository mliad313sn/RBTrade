import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { base32Decode, totp } from '../src/auth/totp';
import { acknowledgeRiskWarning, bearer, CSRF, createUser, PASSWORD, startApp } from './helpers';
import { MarketFixture } from './market-fixture';

/**
 * Goal 08 onboarding: disclosure with the Compliance figure (placeholder until OQ-R1), versioned
 * acknowledgement, loss limits with suggested defaults, completion rules; home summary; optional
 * TOTP for novices (B-017); saved simulator scenarios (B-505). Real clock (bitcoin trades 24/7).
 */
describe('novice onboarding, disclosure, summary, MFA opt-in and saved scenarios', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  const md = new MarketFixture();

  beforeAll(async () => {
    process.env.KORA_ENGINE_ENABLED = 'false';
    process.env.KORA_RECONCILIATION_INTERVAL_MS = '0';
    app = await startApp();
    http = app.getHttpServer();
    await md.standard();
  });
  afterAll(async () => {
    await md.close();
    await app.close();
    delete process.env.KORA_ENGINE_ENABLED;
    delete process.env.KORA_RECONCILIATION_INTERVAL_MS;
  });

  it('shows the risk warning with the [XX]% placeholder in EN and FR and stores a versioned acknowledgement', async () => {
    const u = await createUser(app, 'novice', [], { realClock: true });
    const en = await request(http)
      .get('/disclosures/risk-warning?locale=en')
      .set(bearer(u.token))
      .expect(200);
    expect(en.body.acknowledged).toBe(false);
    expect(en.body.document).toMatchObject({
      id: 'risk-warning',
      version: '1',
      locale: 'en',
      placeholder: true,
      values: { retailLossPct: '[XX]' },
    });
    expect(en.body.document.banner).toContain('[XX]% of retail accounts lose money');
    const fr = await request(http)
      .get('/disclosures/risk-warning?locale=fr')
      .set(bearer(u.token))
      .expect(200);
    expect(fr.body.document.banner).toContain('[XX] % des comptes');
    expect(fr.body.document.contentHash).not.toBe(en.body.document.contentHash);
    await request(http).get('/disclosures/risk-warning?locale=de').set(bearer(u.token)).expect(400);
    await request(http).get('/disclosures/nope').set(bearer(u.token)).expect(404);

    const doc = fr.body.document;
    const stale = await request(http)
      .post('/disclosures/risk-warning/acknowledgements')
      .set(bearer(u.token))
      .send({ version: '0', contentHash: doc.contentHash, locale: 'fr' })
      .expect(409);
    expect(stale.body.error).toBe('disclosure_changed');
    await request(http)
      .post('/disclosures/risk-warning/acknowledgements')
      .set(bearer(u.token))
      .send({ version: '1', contentHash: en.body.document.contentHash, locale: 'fr' })
      .expect(409);
    const ok = await request(http)
      .post('/disclosures/risk-warning/acknowledgements')
      .set(bearer(u.token))
      .send({ version: '1', contentHash: doc.contentHash, locale: 'fr' })
      .expect(201);
    expect(ok.body.acknowledgement).toMatchObject({
      disclosureId: 'risk-warning',
      version: '1',
      locale: 'fr',
      values: { retailLossPct: '[XX]' },
      context: 'onboarding',
    });
    const again = await request(http)
      .get('/disclosures/risk-warning?locale=en')
      .set(bearer(u.token))
      .expect(200);
    expect(again.body.acknowledged).toBe(true);
    const audit = await request(http)
      .get('/audit?action=disclosure.acknowledged')
      .set(bearer(u.token))
      .expect(200);
    expect(audit.body.events[0].payload).toMatchObject({
      disclosureId: 'risk-warning',
      version: '1',
      contentHash: doc.contentHash,
      placeholder: true,
    });
  });

  it('onboarding needs the acknowledgement and both limits; suggests limits from the balance; is audited', async () => {
    const u = await createUser(app, 'novice', [], { realClock: true });
    let p = (await request(http).get('/novice/profile').set(bearer(u.token)).expect(200)).body;
    expect(p).toMatchObject({
      guarded: true,
      currency: 'USD',
      onboarding: { completed: false, disclosureAcknowledged: false, limitsSet: false },
      suggestedLimits: {
        daily: '1500',
        monthly: '6000',
        dailyPct: '1.5',
        monthlyPct: '6',
        simulated: true,
      },
      leverage: { state: 'off', current: '1', requiresKnowledgeCheck: true },
      knowledgeCheck: { passed: false, eligible: true },
      coolingOff: { active: false },
    });
    const first = await request(http)
      .post('/novice/onboarding/complete')
      .set(bearer(u.token))
      .expect(409);
    expect(first.body.missing).toEqual(['disclosure', 'limits']);
    const d = (await request(http).get('/disclosures/risk-warning').set(bearer(u.token))).body
      .document;
    await request(http)
      .post('/disclosures/risk-warning/acknowledgements')
      .set(bearer(u.token))
      .send({ version: d.version, contentHash: d.contentHash, locale: 'en' })
      .expect(201);
    expect(
      (await request(http).post('/novice/onboarding/complete').set(bearer(u.token)).expect(409))
        .body.missing,
    ).toEqual(['limits']);
    await request(http).put('/novice/limits').set(bearer(u.token)).send({}).expect(400);
    await request(http)
      .put('/novice/limits')
      .set(bearer(u.token))
      .send({ dailyLossLimit: '-5' })
      .expect(400);
    await request(http)
      .put('/novice/limits')
      .set(bearer(u.token))
      .send({ dailyLossLimit: '1500', monthlyLossLimit: '6000' })
      .expect(200);
    p = (await request(http).post('/novice/onboarding/complete').set(bearer(u.token)).expect(200))
      .body;
    expect(p.onboarding).toMatchObject({
      completed: true,
      disclosureAcknowledged: true,
      limitsSet: true,
    });
    expect(p.limits).toMatchObject({
      daily: { limit: '1500', used: '0.00' },
      monthly: { limit: '6000', used: '0.00' },
      pending: [],
      loosenDelayHours: 24,
    });
    const audit = await request(http)
      .get('/audit?action=novice.*')
      .set(bearer(u.token))
      .expect(200);
    expect(audit.body.events[0]).toMatchObject({
      action: 'novice.onboarding_completed',
      payload: { dailyLossLimit: '1500', monthlyLossLimit: '6000' },
    });
    // Idempotent.
    await request(http).post('/novice/onboarding/complete').set(bearer(u.token)).expect(200);
  });

  it('home summary: balance, change since start, series, worst dip, holdings in words', async () => {
    const u = await createUser(app, 'novice', [], { realClock: true });
    await acknowledgeRiskWarning(app, u.token); // B-801 gate (goal 09)
    let s = (await request(http).get('/novice/summary').set(bearer(u.token)).expect(200)).body;
    expect(s).toMatchObject({
      currency: 'USD',
      startingBalance: '100000.00',
      balance: '100000.00',
      changeSinceStart: { amount: '0.00', pct: '0.00' },
      worstDip: { amount: '0.00' },
      holdings: [],
    });
    expect(s.series.length).toBeGreaterThanOrEqual(2);
    await md.touch();
    await request(http)
      .post('/orders')
      .set(bearer(u.token))
      .send({
        clientOrderId: `sum-${Date.now()}`,
        symbol: 'BTCUSD',
        side: 'sell',
        type: 'market',
        qty: '0.01',
        stopLossPrice: '66000.0',
      })
      .expect(201);
    s = (await request(http).get('/novice/summary').set(bearer(u.token)).expect(200)).body;
    expect(s.holdings).toEqual([
      expect.objectContaining({
        symbol: 'BTCUSD',
        name: { en: 'Bitcoin', fr: 'Bitcoin' },
        gainsIf: 'down',
        assetClass: 'crypto',
      }),
    ]);
    expect(Number(s.changeSinceStart.amount)).toBeLessThan(0); // fees and spread
    expect(Number(s.worstDip.amount)).toBeGreaterThan(0);
  });

  it('B-017: a novice can opt in to two-step sign-in; later logins ask for a code', async () => {
    const u = await createUser(app, 'novice', [], { realClock: true });
    const opt = await request(http).post('/auth/mfa/opt-in').set(bearer(u.token)).expect(200);
    expect(opt.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    const code = totp(base32Decode(opt.body.secret as string));
    const v = await request(http)
      .post('/auth/mfa/verify')
      .set(CSRF)
      .send({ mfaToken: opt.body.mfaToken, code })
      .expect(200);
    expect(v.body.enrolled).toBe(true);
    const next = await request(http)
      .post('/auth/login')
      .set(CSRF)
      .send({ email: u.email, password: PASSWORD })
      .expect(200);
    expect(next.body.status).toBe('mfa_required');
    await request(http)
      .post('/auth/mfa/opt-in')
      .set(bearer(v.body.accessToken as string))
      .expect(409);
  });

  it('B-505: saves, lists, overwrites and deletes named scenarios (owner only)', async () => {
    const u = await createUser(app, 'novice', [], { realClock: true });
    const other = await createUser(app, 'novice', [], { realClock: true });
    const input = { amount: '5000', often: 'weekly', careful: 'careful' };
    const saved = await request(http)
      .post('/sim/scenarios')
      .set(bearer(u.token))
      .send({ kind: 'practice', name: 'My plan', input })
      .expect(201);
    await request(http)
      .post('/sim/scenarios')
      .set(bearer(u.token))
      .send({ kind: 'practice', name: 'My plan', input })
      .expect(409);
    const over = await request(http)
      .post('/sim/scenarios')
      .set(bearer(u.token))
      .send({
        kind: 'practice',
        name: 'My plan',
        input: { ...input, amount: '6000' },
        overwrite: true,
      })
      .expect(201);
    expect(over.body).toMatchObject({ id: saved.body.id, input: { amount: '6000' } });
    await request(http)
      .post('/sim/scenarios')
      .set(bearer(u.token))
      .send({ kind: 'pro', name: 'A', input: { riskPct: 1 } })
      .expect(201);
    expect(
      (await request(http).get('/sim/scenarios?kind=practice').set(bearer(u.token)).expect(200))
        .body.scenarios,
    ).toHaveLength(1);
    expect(
      (await request(http).get('/sim/scenarios').set(bearer(u.token)).expect(200)).body.scenarios,
    ).toHaveLength(2);
    expect(
      (await request(http).get('/sim/scenarios').set(bearer(other.token)).expect(200)).body
        .scenarios,
    ).toHaveLength(0);
    await request(http)
      .delete(`/sim/scenarios/${saved.body.id}`)
      .set(bearer(other.token))
      .expect(404);
    await request(http).delete(`/sim/scenarios/${saved.body.id}`).set(bearer(u.token)).expect(200);
    await request(http)
      .post('/sim/scenarios')
      .set(bearer(u.token))
      .send({ kind: 'practice', name: '', input })
      .expect(400);
  });
});

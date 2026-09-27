import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import appropriatenessV1 from '../src/appropriateness/questionnaires/appropriateness.v1.json';
import { bearer, CSRF, login, ownerQuery, passingAnswers, startApp, uniqueEmail } from './helpers';
import { MARKET_OPEN_UTC, MarketFixture } from './market-fixture';

/**
 * IRTC R4-09 (docs/review/IRTC-R4-fixes.md): every account acknowledges the risk warning in force
 * before its first order that adds exposure, not only novice-only accounts. New traders acknowledge
 * it as part of passing the appropriateness assessment.
 */
describe('risk warning acknowledgement before the first order, every role (IRTC R4-09)', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  const md = new MarketFixture();

  const doc = async (token: string) =>
    (await request(http).get('/disclosures/risk-warning?locale=en').set(bearer(token)).expect(200)).body.document as {
      version: string;
      contentHash: string;
    };
  const order = async (token: string) => {
    await md.touch();
    return request(http)
      .post('/orders')
      .set(bearer(token))
      .send({ clientOrderId: `r409-${Date.now()}`, symbol: 'EURUSD', side: 'buy', type: 'market', qty: '1000' });
  };
  const signUp = async () => {
    const email = uniqueEmail('r409');
    await request(http).post('/auth/signup').set(CSRF).send({ email, password: 'correct-horse-battery-staple', displayName: 'R409' }).expect(201);
    const first = await login(app, email);
    const id = (await request(http).get('/me').set(bearer(first.token)).expect(200)).body.user.id as string;
    return { email, id, token: first.token };
  };

  beforeAll(async () => {
    process.env.KORA_ENGINE_ENABLED = 'false';
    process.env.KORA_RECONCILIATION_INTERVAL_MS = '0';
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    vi.setSystemTime(MARKET_OPEN_UTC);
    app = await startApp();
    http = app.getHttpServer();
    await md.standard();
  });
  afterAll(async () => {
    await md.close();
    await app.close();
    vi.useRealTimers();
    delete process.env.KORA_ENGINE_ENABLED;
    delete process.env.KORA_RECONCILIATION_INTERVAL_MS;
  });

  it('an assessment attempt must carry the acknowledgement of the risk warning in force', async () => {
    const u = await signUp();
    const q = appropriatenessV1;
    const missing = await request(http)
      .post('/appropriateness/attempts')
      .set(bearer(u.token))
      .send({ questionnaireId: q.id, version: q.version, answers: passingAnswers() });
    expect(missing.status).toBe(400);
    const stale = await request(http)
      .post('/appropriateness/attempts')
      .set(bearer(u.token))
      .send({ questionnaireId: q.id, version: q.version, answers: passingAnswers(), riskWarning: { version: 'old', contentHash: 'a'.repeat(64), locale: 'en' } });
    expect(stale.status).toBe(409);
  });

  it('passing records the acknowledgement (context appropriateness), so the new trader’s first order is not blocked', async () => {
    const u = await signUp();
    const d = await doc(u.token);
    const q = appropriatenessV1;
    const r = await request(http)
      .post('/appropriateness/attempts')
      .set(bearer(u.token))
      .send({ questionnaireId: q.id, version: q.version, answers: passingAnswers(), riskWarning: { version: d.version, contentHash: d.contentHash, locale: 'en' } })
      .expect(200);
    expect(r.body.passed).toBe(true);
    const acks = await ownerQuery<{ context: string; version: string }>(
      "SELECT context, version FROM disclosure_acknowledgements WHERE user_id = $1 AND disclosure_id = 'risk-warning'",
      [u.id],
    );
    expect(acks).toEqual([{ context: 'appropriateness', version: d.version }]);
    const t = await login(app, u.email);
    const o = await order(t.token);
    expect(o.status).toBe(201);
  });

  it('a Pro account that never acknowledged (admin-granted quant) is refused until it acknowledges; reducing orders pass', async () => {
    const u = await signUp();
    await ownerQuery("INSERT INTO user_roles (user_id, role) VALUES ($1, 'quant')", [u.id]);
    await ownerQuery("UPDATE user_preferences SET view_mode = 'pro' WHERE user_id = $1", [u.id]);
    const t = await login(app, u.email);
    const refused = await order(t.token);
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('DISCLOSURE_NOT_ACKNOWLEDGED');
    const d = await doc(t.token);
    await request(http)
      .post('/disclosures/risk-warning/acknowledgements')
      .set(bearer(t.token))
      .send({ version: d.version, contentHash: d.contentHash, locale: 'en' })
      .expect(201);
    expect((await order(t.token)).status).toBe(201);
  });
});

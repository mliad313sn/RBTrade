// Goal 10 (S10): OpenAPI-driven contract tests (web/SDK ↔ api). Every operation in the contract
// registry is called for real and its response is validated against the OpenAPI document the api
// publishes (ajv, JSON Schema 2020-12). A contract without a call here fails the test, so the
// registry and the test cannot drift apart.
import type { INestApplication } from '@nestjs/common';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { CONTRACTS } from '../src/contracts/registry';
import { buildOpenApi } from '../src/create-app';
import { EngineLoopService } from '../src/trading/engine-loop.service';
import { CSRF, PASSWORD, bearer, createUser, startApp, type TestUser } from './helpers';
import { MARKET_OPEN_UTC, MarketFixture } from './market-fixture';

type Doc = ReturnType<typeof buildOpenApi>;

describe('API response contracts (OpenAPI)', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let doc: Doc;
  let trader: TestUser;
  let admin: TestUser;
  const md = new MarketFixture();
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  const exercised = new Set<string>();

  beforeAll(async () => {
    process.env.KORA_ENGINE_ENABLED = 'false';
    process.env.KORA_RECONCILIATION_INTERVAL_MS = '0';
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    vi.setSystemTime(MARKET_OPEN_UTC);
    app = await startApp();
    http = app.getHttpServer();
    doc = buildOpenApi(app);
    await md.standard();
    trader = await createUser(app, 'trader');
    admin = await createUser(app, 'novice', ['admin']);
  }, 120_000);

  afterAll(async () => {
    await md.close();
    await app?.close();
    vi.useRealTimers();
    delete process.env.KORA_ENGINE_ENABLED;
    delete process.env.KORA_RECONCILIATION_INTERVAL_MS;
  });

  /** Validates a response against the document's schema for `METHOD /path` and its status. */
  function check(key: string, res: request.Response): void {
    const c = CONTRACTS[key];
    expect(c, `no contract for ${key}`).toBeDefined();
    expect(res.status, `${key}: ${JSON.stringify(res.body).slice(0, 400)}`).toBe(c!.status);
    const [method, path] = key.split(' ') as [string, string];
    const op = (
      doc.paths[path] as Record<
        string,
        { responses: Record<string, { content?: Record<string, { schema: object }> }> }
      >
    )[method.toLowerCase()]!;
    const schema = op.responses[String(c!.status)]?.content?.['application/json']?.schema;
    expect(schema, `${key} has a response schema in OpenAPI`).toBeDefined();
    const validate = ajv.compile(schema!);
    const ok = validate(res.body);
    expect(ok, `${key} violates its contract: ${ajv.errorsText(validate.errors)}`).toBe(true);
    exercised.add(key);
  }

  it('every contract is published in the OpenAPI document', () => {
    for (const [key, c] of Object.entries(CONTRACTS)) {
      const [method, path] = key.split(' ') as [string, string];
      const op = (
        doc.paths[path] as Record<string, { responses: Record<string, unknown> }> | undefined
      )?.[method.toLowerCase()];
      expect(op?.responses[String(c.status)], key).toBeDefined();
    }
  });

  it('platform, identity, audit and market data responses match their contracts', async () => {
    const t = bearer(trader.token);
    check('GET /health', await request(http).get('/health'));
    // a novice login answers `ok` with the token (the other branch is covered by the trader login above)
    const n = await createUser(app, 'novice');
    check(
      'POST /auth/login',
      await request(http)
        .post('/auth/login')
        .set(CSRF)
        .send({ email: n.email, password: PASSWORD }),
    );
    check('GET /me', await request(http).get('/me').set(t));
    check('GET /audit', await request(http).get('/audit?limit=5').set(t));
    check('GET /audit/verify', await request(http).get('/audit/verify').set(bearer(admin.token)));
    check('GET /instruments', await request(http).get('/instruments').set(t));
    check('GET /instruments/{symbol}', await request(http).get('/instruments/EURUSD').set(t));
    check('GET /venues', await request(http).get('/venues').set(t));
    check('GET /candles', await request(http).get('/candles?symbol=EURUSD&tf=1m&limit=10').set(t));
    check('GET /quotes', await request(http).get('/quotes?symbols=EURUSD,BTCUSD').set(t));
    check('GET /market-data/status', await request(http).get('/market-data/status').set(t));
    check(
      'GET /disclosures/{id}',
      await request(http).get('/disclosures/risk-warning?locale=en').set(t),
    );
    check('GET /ai/status', await request(http).get('/ai/status').set(t));
    check(
      'GET /appropriateness/questionnaire',
      await request(http).get('/appropriateness/questionnaire').set(bearer(n.token)),
    );
  });

  it('trading lifecycle responses match their contracts (preview → place → fill → amend/cancel → kill switch)', async () => {
    const t = bearer(trader.token);
    await md.touch();
    check(
      'POST /orders/preview',
      await request(http).post('/orders/preview').set(t).send({
        symbol: 'EURUSD',
        side: 'buy',
        type: 'market',
        qty: '10000',
        stopLossPrice: '1.08000',
      }),
    );
    await md.touch();
    const placed = await request(http)
      .post('/orders')
      .set(t)
      .send({
        clientOrderId: `contract-${process.pid}-1`,
        symbol: 'EURUSD',
        side: 'buy',
        type: 'market',
        qty: '10000',
      });
    check('POST /orders', placed);
    await app.get(EngineLoopService).matchSymbol('EURUSD');
    await md.touch();
    const limit = await request(http)
      .post('/orders')
      .set(t)
      .send({
        clientOrderId: `contract-${process.pid}-2`,
        symbol: 'EURUSD',
        side: 'buy',
        type: 'limit',
        qty: '10000',
        limitPrice: '1.08000',
      });
    expect(limit.status, JSON.stringify(limit.body)).toBe(201);
    const id = limit.body.order.id as string;
    check('GET /orders', await request(http).get('/orders?status=all').set(t));
    check('GET /orders/{id}', await request(http).get(`/orders/${id}`).set(t));
    await md.touch();
    check(
      'PATCH /orders/{id}',
      await request(http).patch(`/orders/${id}`).set(t).send({ limitPrice: '1.08010' }),
    );
    check('DELETE /orders/{id}', await request(http).delete(`/orders/${id}`).set(t));
    check('GET /positions', await request(http).get('/positions').set(t));
    check('GET /fills', await request(http).get('/fills').set(t));
    check('GET /accounts/me', await request(http).get('/accounts/me').set(t));
    check('GET /alerts', await request(http).get('/alerts').set(t));
    check(
      'POST /kill-switch',
      await request(http)
        .post('/kill-switch')
        .set(t)
        .send({ scope: 'robots_cancel', source: 'rest_fallback', reason: 'contract test' }),
    );
    check('GET /kill-switch', await request(http).get('/kill-switch').set(t));
    check(
      'POST /kill-switch/resume',
      await request(http).post('/kill-switch/resume').set(t).send({ reason: 'contract test done' }),
    );
  });

  it('strategy and robot responses match their contracts', async () => {
    const t = bearer(trader.token);
    const templates = await request(http).get('/strategy-templates').set(t);
    check('GET /strategy-templates', templates);
    check(
      'POST /strategies/validate',
      await request(http)
        .post('/strategies/validate')
        .set(t)
        .send({ definition: templates.body.templates[0].definition }),
    );
    check('GET /strategies', await request(http).get('/strategies').set(t));
    check('GET /robots', await request(http).get('/robots').set(t));
  });

  it('every registered contract was exercised', () => {
    expect(Object.keys(CONTRACTS).filter((k) => !exercised.has(k))).toEqual([]);
  });
});

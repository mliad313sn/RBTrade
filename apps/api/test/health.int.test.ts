import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startApp } from './helpers';

describe('GET /health', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await startApp();
  });
  afterAll(async () => app.close());

  it('reports db, redis and keycloak status and PAPER env', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(res.body).toMatchObject({
      status: 'ok',
      environment: 'PAPER',
      liveTradingEnabled: false,
      checks: { db: { status: 'up' }, redis: { status: 'up' }, keycloak: { status: 'skipped' } },
    });
  });

  it('serves the OpenAPI document', async () => {
    const res = await request(app.getHttpServer()).get('/openapi.json').expect(200);
    expect(Object.keys(res.body.paths)).toEqual(
      expect.arrayContaining(['/health', '/auth/signup', '/audit', '/audit/verify', '/kill-switch', '/me/preferences', '/instruments', '/candles', '/quotes', '/calendar', '/market-data/status']),
    );
  });
});

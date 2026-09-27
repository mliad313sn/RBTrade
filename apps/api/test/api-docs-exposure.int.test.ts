import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startApp } from './helpers';

/**
 * IRTC R1-11: Swagger UI and /openapi.json were disabled only in production, so staging exposed the
 * whole API surface. They are now served in dev and test only.
 */
describe('API docs exposure (IRTC R1-11)', () => {
  let app: INestApplication;
  const keys = [
    'KORA_ENV',
    'AUTH_PROVIDER',
    'KORA_ALLOW_DEV_IDP',
    'KORA_ALLOW_INSECURE_TRANSPORT',
    'REDIS_URL',
    'KORA_METRICS_TOKEN',
    'KORA_AUDIT_ANCHOR_JWK',
  ] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  beforeAll(async () => {
    const redis = new URL(process.env.REDIS_URL ?? 'redis://127.0.0.1:56379');
    if (!redis.password) redis.password = 'staging-test-password'; // staging requires Redis auth (a no-auth dev Redis tolerates it)
    Object.assign(process.env, {
      KORA_ENV: 'staging',
      AUTH_PROVIDER: 'dev',
      KORA_ALLOW_DEV_IDP: 'true',
      KORA_ALLOW_INSECURE_TRANSPORT: 'true',
      REDIS_URL: redis.toString(),
      KORA_METRICS_TOKEN: 'staging-metrics-token-0123456789abcdef',
      // any persistent ES256 key will do for the audit anchors (required outside dev/test)
      KORA_AUDIT_ANCHOR_JWK: process.env.KORA_DEV_IDP_PRIVATE_JWK ?? '',
    });
    app = await startApp();
  });
  afterAll(async () => {
    await app?.close();
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('staging serves neither /docs nor /openapi.json', async () => {
    const http = app.getHttpServer();
    expect((await request(http).get('/openapi.json')).status).toBe(404);
    expect((await request(http).get('/docs')).status).toBe(404);
    expect((await request(http).get('/health')).status).toBe(200);
  });
});

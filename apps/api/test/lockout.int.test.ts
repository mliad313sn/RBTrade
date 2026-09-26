import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CSRF, PASSWORD, startApp, uniqueEmail } from './helpers';

describe('account lockout', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await startApp();
  });
  afterAll(async () => app.close());

  it('locks the account after 10 failed passwords, even with the right password', async () => {
    const http = app.getHttpServer();
    const email = uniqueEmail('lock');
    await request(http).post('/auth/signup').set(CSRF).send({ email, password: PASSWORD, displayName: 'L' }).expect(201);
    for (let i = 0; i < 10; i++) {
      await request(http).post('/auth/login').set(CSRF).send({ email, password: 'nope-nope-nope' }).expect(401);
    }
    const res = await request(http).post('/auth/login').set(CSRF).send({ email, password: PASSWORD }).expect(403);
    expect(res.body.error).toBe('locked');
  });
});

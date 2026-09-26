import type { INestApplication } from '@nestjs/common';
import type { Role } from '@kora/domain';
import { Client } from 'pg';
import request from 'supertest';
import { vi } from 'vitest';

import { base32Decode, totp } from '../src/auth/totp';
import { createApp } from '../src/create-app';

export const PASSWORD = 'correct-horse-battery-staple';
export const CSRF = { 'x-kora-csrf': '1' };

export async function startApp(): Promise<INestApplication> {
  const app = await createApp({ logger: false });
  app.useLogger(process.env.KORA_TEST_LOGS === '1' ? ['error', 'warn'] : false);
  await app.init();
  return app;
}

let seq = 0;
export function uniqueEmail(prefix: string): string {
  seq += 1;
  return `${prefix}.${process.pid}.${Date.now()}.${seq}@test.kora.local`;
}

/** Moves the (faked) wall clock forward so each TOTP code lands in a fresh 30 s step. */
export function nextTotpWindow(): void {
  vi.setSystemTime(Date.now() + 31_000);
}

export async function ownerQuery<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
  const c = new Client({ connectionString: process.env.DATABASE_URL_MIGRATE_TEST });
  await c.connect();
  try {
    return (await c.query(sql, params)).rows as T[];
  } finally {
    await c.end();
  }
}

export async function appQuery(sql: string, params: unknown[] = []): Promise<unknown[]> {
  const c = new Client({ connectionString: process.env.DATABASE_URL_TEST });
  await c.connect();
  try {
    return (await c.query(sql, params)).rows;
  } finally {
    await c.end();
  }
}

export interface TestUser {
  id: string;
  email: string;
  token: string;
  secret?: string;
  roles: Role[];
}

/** Real flow: sign-up → login → (MFA enrolment + verify when required). */
export async function createUser(app: INestApplication, accountType: 'novice' | 'trader', extraRoles: Role[] = []): Promise<TestUser> {
  const http = app.getHttpServer();
  const email = uniqueEmail(accountType);
  const signup = await request(http)
    .post('/auth/signup')
    .set(CSRF)
    .send({ email, password: PASSWORD, displayName: `Test ${accountType}`, accountType })
    .expect(201);
  const id = signup.body.user.id as string;
  let roles: Role[] = [accountType];
  if (extraRoles.length) {
    roles = [...new Set([...roles, ...extraRoles])];
    await ownerQuery('INSERT INTO user_roles (user_id, role) SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING', [id, roles]);
  }
  return { id, email, roles, ...(await login(app, email)) };
}

export async function login(app: INestApplication, email: string, secret?: string): Promise<{ token: string; secret?: string }> {
  const http = app.getHttpServer();
  const res = await request(http).post('/auth/login').set(CSRF).send({ email, password: PASSWORD }).expect(200);
  if (res.body.status === 'ok') return { token: res.body.accessToken };
  let s = secret;
  if (res.body.status === 'mfa_enrollment_required') {
    const enr = await request(http).post('/auth/mfa/enroll').set(CSRF).send({ mfaToken: res.body.mfaToken }).expect(200);
    s = enr.body.secret as string;
  }
  if (!s) throw new Error('MFA secret needed');
  nextTotpWindow();
  const code = totp(base32Decode(s));
  const v = await request(http).post('/auth/mfa/verify').set(CSRF).send({ mfaToken: res.body.mfaToken, code }).expect(200);
  return { token: v.body.accessToken, secret: s };
}

export const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

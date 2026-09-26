import type { INestApplication } from '@nestjs/common';
import type { Role } from '@kora/domain';
import { Client } from 'pg';
import request from 'supertest';
import { vi } from 'vitest';

import appropriatenessV1 from '../src/appropriateness/questionnaires/appropriateness.v1.json';
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

/**
 * The appropriateness answer key, derived from the reviewed questionnaire data (best-scoring option
 * per question). Tests submit it through the real API; nothing bypasses the assessment.
 */
export function passingAnswers(def: { questions: Array<{ id: string; options: Array<{ id: string; points: number }> }> } = appropriatenessV1): Record<string, string> {
  return Object.fromEntries(def.questions.map((q) => [q.id, [...q.options].sort((a, b) => b.points - a.points)[0]!.id]));
}

export function failingAnswers(def: { questions: Array<{ id: string; options: Array<{ id: string; points: number }> }> } = appropriatenessV1): Record<string, string> {
  return Object.fromEntries(def.questions.map((q) => [q.id, [...q.options].sort((a, b) => a.points - b.points)[0]!.id]));
}

/** Passes the appropriateness assessment through the API with a novice session token. */
export async function passAppropriateness(app: INestApplication, token: string): Promise<void> {
  const http = app.getHttpServer();
  const q = await request(http).get('/appropriateness/questionnaire').set(bearer(token)).expect(200);
  const { id, version } = q.body.questionnaire as { id: string; version: number };
  const res = await request(http).post('/appropriateness/attempts').set(bearer(token)).send({ questionnaireId: id, version, answers: passingAnswers() }).expect(200);
  if (!res.body.passed) throw new Error(`appropriateness not passed: ${JSON.stringify(res.body)}`);
}

/**
 * Real flow: sign-up (always novice, B-018) → login. For `trader`: pass the appropriateness
 * assessment through the API, then log in again, which forces TOTP enrolment + verify.
 * `extraRoles` (quant, risk_officer, admin) are admin-granted roles, inserted as the owner.
 * `realClock: true` skips the faked clock advance (fresh users have no TOTP replay history), for
 * tests that need a moving Date.now (e.g. the market data feed).
 */
export async function createUser(
  app: INestApplication,
  accountType: 'novice' | 'trader',
  extraRoles: Role[] = [],
  opts: { realClock?: boolean } = {},
): Promise<TestUser> {
  const http = app.getHttpServer();
  const email = uniqueEmail(accountType);
  const signup = await request(http)
    .post('/auth/signup')
    .set(CSRF)
    .send({ email, password: PASSWORD, displayName: `Test ${accountType}` })
    .expect(201);
  const id = signup.body.user.id as string;
  let roles: Role[] = ['novice'];
  if (accountType === 'trader') {
    const first = await login(app, email, undefined, opts);
    await passAppropriateness(app, first.token);
    roles = ['novice', 'trader'];
  }
  const admin = extraRoles.filter((r) => r !== 'trader' && r !== 'novice');
  if (admin.length) {
    roles = [...new Set([...roles, ...admin])];
    await ownerQuery('INSERT INTO user_roles (user_id, role) SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING', [id, admin]);
  }
  if (extraRoles.includes('trader') && accountType !== 'trader') throw new Error('Use accountType "trader" (passes the assessment)');
  return { id, email, roles, ...(await login(app, email, undefined, opts)) };
}

export async function login(
  app: INestApplication,
  email: string,
  secret?: string,
  opts: { realClock?: boolean } = {},
): Promise<{ token: string; secret?: string }> {
  const http = app.getHttpServer();
  const res = await request(http).post('/auth/login').set(CSRF).send({ email, password: PASSWORD }).expect(200);
  if (res.body.status === 'ok') return { token: res.body.accessToken };
  let s = secret;
  if (res.body.status === 'mfa_enrollment_required') {
    const enr = await request(http).post('/auth/mfa/enroll').set(CSRF).send({ mfaToken: res.body.mfaToken }).expect(200);
    s = enr.body.secret as string;
  }
  if (!s) throw new Error('MFA secret needed');
  if (!opts.realClock) nextTotpWindow();
  const code = totp(base32Decode(s));
  const v = await request(http).post('/auth/mfa/verify').set(CSRF).send({ mfaToken: res.body.mfaToken, code }).expect(200);
  return { token: v.body.accessToken, secret: s };
}

export const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

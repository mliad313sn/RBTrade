import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { expect, type APIRequestContext, type Page } from '@playwright/test';

// nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_password -- test-only password for throwaway local accounts, reviewed goal 10
export const PASSWORD = 'correct-horse-battery-staple';
let n = 0;
export const uniqueEmail = (p: string) => `${p}.${Date.now()}.${++n}@e2e.kora.local`;

function base32Decode(s: string): Buffer {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s.replace(/=+$/, '').toUpperCase()) {
    value = (value << 5) | A.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** RFC 6238 TOTP. `stepOffset` lets a second login in the same 30 s use the next step (replay-safe). */
export function totp(secretB32: string, stepOffset = 0): string {
  const counter = BigInt(Math.floor(Date.now() / 30000) + stepOffset);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(counter);
  const mac = createHmac('sha1', base32Decode(secretB32)).update(msg).digest();
  const o = mac[mac.length - 1]! & 15;
  const bin = ((mac[o]! & 127) << 24) | (mac[o + 1]! << 16) | (mac[o + 2]! << 8) | mac[o + 3]!;
  return String(bin % 1_000_000).padStart(6, '0');
}

const CSRF = { 'x-kora-csrf': '1' };

interface QuestionnaireData {
  id: string;
  version: number;
  questions: Array<{ id: string; options: Array<{ id: string; points: number }> }>;
}

/** The reviewed questionnaire data (apps/api); tests answer through the real API and web page. */
export const QUESTIONNAIRE: QuestionnaireData = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../api/src/appropriateness/questionnaires/appropriateness.v1.json', import.meta.url)), 'utf8'),
) as QuestionnaireData;

export function answerKey(best = true): Record<string, string> {
  return Object.fromEntries(
    QUESTIONNAIRE.questions.map((q) => [q.id, [...q.options].sort((a, b) => (best ? b.points - a.points : a.points - b.points))[0]!.id]),
  );
}

/** Option labels are shown in the page; map the key to the option index for clicking radios. */
export function answerIndex(best = true): Record<string, number> {
  const key = answerKey(best);
  return Object.fromEntries(QUESTIONNAIRE.questions.map((q) => [q.id, q.options.findIndex((o) => o.id === key[q.id])]));
}

/**
 * Goal 08 onboarding through the API: acknowledge the current risk warning, set the loss limits
 * (suggested defaults unless given), complete. The UI path is covered by novice.spec.ts.
 */
export async function apiOnboard(req: APIRequestContext, limits?: { dailyLossLimit: string; monthlyLossLimit: string }): Promise<void> {
  const doc = (await (await req.get('/api/disclosures/risk-warning?locale=en')).json()).document as { version: string; contentHash: string };
  expect((await req.post('/api/disclosures/risk-warning/acknowledgements', { headers: CSRF, data: { version: doc.version, contentHash: doc.contentHash, locale: 'en' } })).status()).toBe(201);
  const profile = await (await req.get('/api/novice/profile')).json();
  const l = limits ?? { dailyLossLimit: profile.suggestedLimits.daily, monthlyLossLimit: profile.suggestedLimits.monthly };
  expect((await req.put('/api/novice/limits', { headers: CSRF, data: l })).status()).toBe(200);
  expect((await req.post('/api/novice/onboarding/complete', { headers: CSRF })).status()).toBe(200);
}

/**
 * Creates and signs in a user through the API (cookies land in the page context). Everyone signs up
 * as novice (B-018); a `trader` passes the appropriateness assessment through the API, then logs in
 * again, which forces TOTP enrolment.
 */
export async function apiSignIn(
  page: Page,
  accountType: 'novice' | 'trader',
  opts: { onboarded?: boolean } = {},
): Promise<{ email: string; secret?: string }> {
  const req: APIRequestContext = page.request;
  const email = uniqueEmail(accountType);
  expect((await req.post('/api/auth/signup', { headers: CSRF, data: { email, password: PASSWORD, displayName: `E2E ${accountType}` } })).status()).toBe(201);
  const first = await (await req.post('/api/auth/login', { headers: CSRF, data: { email, password: PASSWORD } })).json();
  expect(first.status).toBe('ok');
  if (accountType === 'novice') {
    // Goal 08: novice-only users land on onboarding until it is done; most specs start after it.
    if (opts.onboarded !== false) await apiOnboard(req);
    return { email };
  }
  // IRTC R4-09: the attempt confirms the risk warning in force.
  const warning = (await (await req.get('/api/disclosures/risk-warning?locale=en')).json()).document as { version: string; contentHash: string };
  const attempt = await req.post('/api/appropriateness/attempts', {
    headers: CSRF,
    data: {
      questionnaireId: QUESTIONNAIRE.id,
      version: QUESTIONNAIRE.version,
      answers: answerKey(),
      riskWarning: { version: warning.version, contentHash: warning.contentHash, locale: 'en' },
    },
  });
  expect(attempt.status()).toBe(200);
  expect((await attempt.json()).passed).toBe(true);
  const login = await (await req.post('/api/auth/login', { headers: CSRF, data: { email, password: PASSWORD } })).json();
  expect(login.status).toBe('mfa_enrollment_required');
  const enr = await (await req.post('/api/auth/mfa/enroll', { headers: CSRF, data: { mfaToken: login.mfaToken } })).json();
  const v = await req.post('/api/auth/mfa/verify', { headers: CSRF, data: { mfaToken: login.mfaToken, code: totp(enr.secret) } });
  expect(v.status()).toBe(200);
  return { email, secret: enr.secret };
}

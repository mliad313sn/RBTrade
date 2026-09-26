import { createHmac } from 'node:crypto';

import { expect, type APIRequestContext, type Page } from '@playwright/test';

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

/** Creates and signs in a user through the API (cookies land in the page context). */
export async function apiSignIn(page: Page, accountType: 'novice' | 'trader'): Promise<{ email: string; secret?: string }> {
  const req: APIRequestContext = page.request;
  const email = uniqueEmail(accountType);
  expect((await req.post('/api/auth/signup', { headers: CSRF, data: { email, password: PASSWORD, displayName: `E2E ${accountType}`, accountType } })).status()).toBe(201);
  const login = await (await req.post('/api/auth/login', { headers: CSRF, data: { email, password: PASSWORD } })).json();
  if (login.status === 'ok') return { email };
  const enr = await (await req.post('/api/auth/mfa/enroll', { headers: CSRF, data: { mfaToken: login.mfaToken } })).json();
  const v = await req.post('/api/auth/mfa/verify', { headers: CSRF, data: { mfaToken: login.mfaToken, code: totp(enr.secret) } });
  expect(v.status()).toBe(200);
  return { email, secret: enr.secret };
}

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** RFC 4648 base32 (no padding on output). */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error('Invalid base32 character');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export interface TotpOptions {
  digits?: number;
  period?: number;
  algorithm?: 'sha1' | 'sha256' | 'sha512';
}

/** HOTP (RFC 4226) with dynamic truncation. */
export function hotp(secret: Buffer, counter: bigint, digits = 6, algorithm: TotpOptions['algorithm'] = 'sha1'): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(counter);
  const mac = createHmac(algorithm ?? 'sha1', secret).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin =
    ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export function timeStep(nowMs: number, period = 30): bigint {
  return BigInt(Math.floor(nowMs / 1000 / period));
}

/** TOTP (RFC 6238). */
export function totp(secret: Buffer, nowMs = Date.now(), opts: TotpOptions = {}): string {
  return hotp(secret, timeStep(nowMs, opts.period ?? 30), opts.digits ?? 6, opts.algorithm);
}

/**
 * Verifies a code within ±window steps. Returns the matched step so callers can reject replays
 * (a step <= last used step), or null.
 */
export function verifyTotp(
  secret: Buffer,
  code: string,
  nowMs = Date.now(),
  window = 1,
  opts: TotpOptions = {},
): bigint | null {
  const digits = opts.digits ?? 6;
  if (!new RegExp(`^\\d{${digits}}$`).test(code)) return null;
  const current = timeStep(nowMs, opts.period ?? 30);
  for (let d = -window; d <= window; d++) {
    const step = current + BigInt(d);
    if (step < 0n) continue;
    const expected = hotp(secret, step, digits, opts.algorithm);
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(code))) return step;
  }
  return null;
}

export function generateTotpSecret(bytes = 20): string {
  return base32Encode(randomBytes(bytes));
}

export function otpauthUrl(secretB32: string, account: string, issuer = 'KORA'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret: secretB32, issuer, algorithm: 'SHA1', digits: '6', period: '30' });
  return `otpauth://totp/${label}?${params.toString()}`;
}

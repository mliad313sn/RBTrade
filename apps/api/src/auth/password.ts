import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

function scrypt(password: string, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

const KEYLEN = 32;
export const MIN_PASSWORD_LENGTH = 12;

/** scrypt$N$r$p$salt$hash (base64url). */
export async function hashPassword(password: string, N = 131072, r = 8, p = 1): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, KEYLEN, { N, r, p, maxmem: 256 * N * r });
  return ['scrypt', N, r, p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts as [string, string, string, string, string, string];
  const N = Number(n);
  const R = Number(r);
  const P = Number(p);
  if (![N, R, P].every(Number.isSafeInteger)) return false;
  const expected = Buffer.from(hashB64, 'base64url');
  const key = await scrypt(password.normalize('NFKC'), Buffer.from(saltB64, 'base64url'), expected.length, {
    N,
    r: R,
    p: P,
    maxmem: 256 * N * R,
  });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** A precomputed hash so unknown-user logins cost the same time as real ones. */
let dummyHash: Promise<string> | null = null;
export function dummyPasswordHash(N: number): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(16).toString('hex'), N);
  return dummyHash;
}

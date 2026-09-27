import { request as httpRequest } from 'node:http';

import { expect, test } from '@playwright/test';

import { uniqueEmail } from './helpers';

/**
 * IRTC R1-05: through the real Next.js `/api` proxy (no trusted ingress, the default), each client
 * lands in its own per-IP rate-limit bucket at the API, and a client-chosen X-Forwarded-For cannot
 * move it to another one. Loopback aliases 127.0.0.2 / 127.0.0.3 stand in for two clients. Before
 * the fix every caller was reported as 127.0.0.1, so both shared one bucket.
 */
function login(
  baseURL: string,
  localAddress: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; remaining: number }> {
  const u = new URL('/api/auth/login', baseURL);
  const body = JSON.stringify({ email: uniqueEmail('attrib'), password: 'junk-password-123' });
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: u.hostname,
        port: u.port,
        path: u.pathname,
        method: 'POST',
        localAddress,
        headers: {
          'content-type': 'application/json',
          'x-kora-csrf': '1',
          'content-length': String(Buffer.byteLength(body)),
          ...headers,
        },
      },
      (res) => {
        res.resume();
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            remaining: Number(res.headers['x-ratelimit-remaining']),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

test('the /api proxy gives each client its own address; a spoofed X-Forwarded-For does not escape it (IRTC R1-05)', async ({
  baseURL,
}) => {
  const a1 = await login(baseURL!, '127.0.0.2');
  const a2 = await login(baseURL!, '127.0.0.2', { 'x-forwarded-for': '203.0.113.5' });
  const b1 = await login(baseURL!, '127.0.0.3');
  expect(a1.status).toBe(401);
  expect(Number.isFinite(a1.remaining)).toBe(true);
  expect(a2.remaining).toBe(a1.remaining - 1); // same client, same bucket, whatever it claims
  expect(b1.remaining).toBe(a1.remaining); // another client starts a fresh bucket
});

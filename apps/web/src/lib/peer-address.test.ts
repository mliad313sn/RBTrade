import { createServer, request, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { clientAddress } from './forwarded';

// The preload the web server runs with (node --require ./peer-address.cjs).
createRequire(import.meta.url)('../../peer-address.cjs');

/**
 * IRTC R1-05: with no trusted ingress (KORA_TRUSTED_PROXY_HOPS=0, the shipped default) every web
 * user used to be reported to the API as 127.0.0.1, so one client could exhaust the sign-in rate
 * limit for the whole platform. The proxy must forward the real TCP peer and never a client-chosen
 * X-Forwarded-For. Loopback aliases (127.0.0.2, 127.0.0.3) stand in for two different clients.
 */
describe('client address behind the web proxy (IRTC R1-05)', () => {
  let port = 0;
  const server = createServer((req, res) => {
    const h = new Headers();
    for (const [k, v] of Object.entries(req.headers as IncomingHttpHeaders))
      if (typeof v === 'string') h.set(k, v);
    res.end(JSON.stringify({ hops0: clientAddress(h, 0), hops1: clientAddress(h, 1) }));
  });
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, '0.0.0.0', r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const call = (localAddress: string, headers: Record<string, string> = {}) =>
    new Promise<{ hops0: string; hops1: string }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/', localAddress, headers }, (res) => {
        let body = '';
        res.on('data', (c: Buffer) => (body += c.toString()));
        res.on('end', () => resolve(JSON.parse(body) as { hops0: string; hops1: string }));
      });
      req.on('error', reject);
      req.end();
    });

  it('two different clients get two different addresses (not one shared 127.0.0.1 bucket)', async () => {
    const a = await call('127.0.0.2');
    const b = await call('127.0.0.3');
    expect(a.hops0.replace(/^::ffff:/, '')).toBe('127.0.0.2');
    expect(b.hops0.replace(/^::ffff:/, '')).toBe('127.0.0.3');
  });

  it('a client-chosen X-Forwarded-For or x-kora-peer-addr is never trusted without a configured hop', async () => {
    const a = await call('127.0.0.2', {
      'x-forwarded-for': '203.0.113.5',
      'x-kora-peer-addr': '198.51.100.99',
    });
    expect(a.hops0.replace(/^::ffff:/, '')).toBe('127.0.0.2');
  });

  it('with one trusted ingress, the entry that ingress appended is used', async () => {
    const a = await call('127.0.0.2', { 'x-forwarded-for': '6.6.6.6, 203.0.113.7' });
    expect(a.hops1).toBe('203.0.113.7');
  });
});

describe('clientAddress without the preload stamp', () => {
  it('falls back to loopback (fail safe) rather than trusting request headers', () => {
    const g = globalThis as Record<symbol, unknown>;
    const flag = Symbol.for('kora.peerAddressStamp');
    const saved = g[flag];
    g[flag] = undefined;
    try {
      const h = new Headers({
        'x-kora-peer-addr': '198.51.100.99',
        'x-forwarded-for': '203.0.113.5',
      });
      expect(clientAddress(h, 0)).toBe('127.0.0.1');
    } finally {
      g[flag] = saved;
    }
  });
});

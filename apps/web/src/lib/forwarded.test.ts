import { describe, expect, it } from 'vitest';

import { forwardedClient } from './forwarded';

describe('forwardedClient (B-015)', () => {
  it('ignores a client-supplied X-Forwarded-For when no proxy is trusted', () => {
    expect(forwardedClient('6.6.6.6', 0)).toBe('127.0.0.1');
    expect(forwardedClient(null, 0)).toBe('127.0.0.1');
  });
  it('takes the entry appended by the trusted proxy, not the client-chosen prefix', () => {
    // client sent "6.6.6.6", the ingress appended the real peer 203.0.113.7
    expect(forwardedClient('6.6.6.6, 203.0.113.7', 1)).toBe('203.0.113.7');
    expect(forwardedClient('6.6.6.6, 203.0.113.7, 10.0.0.2', 2)).toBe('203.0.113.7');
    expect(forwardedClient('2001:db8::1', 1)).toBe('2001:db8::1');
  });
  it('falls back to loopback on a short chain or garbage', () => {
    expect(forwardedClient('203.0.113.7', 2)).toBe('127.0.0.1');
    expect(forwardedClient('<script>', 1)).toBe('127.0.0.1');
    expect(forwardedClient('1.2.3.4', -1)).toBe('127.0.0.1');
  });
});

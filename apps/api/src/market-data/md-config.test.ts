import { describe, expect, it } from 'vitest';

import { frame, wsTextFrame } from './channel-hub';
import { parseCookie } from './gateway';
import { busChannel, lastKey, loadMdConfig } from './md-config';

describe('market data config and helpers', () => {
  it('defaults: in-process feed, 10 Hz conflation, web origin allowed', () => {
    const c = loadMdConfig({}, 'http://localhost:3000');
    expect(c).toMatchObject({ feed: 'inprocess', stepMs: 100, conflatePerSec: 10, backfill: true, respectSessions: false, prefix: 'kora:md:', symbols: [] });
    expect(c.wsOrigins).toEqual(['http://localhost:3000']);
    // B-208: the simulator follows venue sessions by default outside dev/test.
    expect(loadMdConfig({ KORA_ENV: 'staging' }).respectSessions).toBe(true);
    expect(loadMdConfig({ KORA_ENV: 'production', KORA_MD_RESPECT_SESSIONS: 'false' }).respectSessions).toBe(false);
    expect(loadMdConfig({ KORA_ENV: 'test', KORA_MD_RESPECT_SESSIONS: '1' }).respectSessions).toBe(true);
  });

  it('parses overrides and rejects bad values', () => {
    const c = loadMdConfig({ KORA_MD_FEED: 'off', KORA_MD_SYMBOLS: 'eurusd, BTCUSD,,', KORA_MD_BACKFILL: '0', KORA_MD_WS_ORIGINS: 'https://a.example, https://b.example', KORA_MD_REDIS_PREFIX: 'kora:test:md:' });
    expect(c).toMatchObject({ feed: 'off', symbols: ['EURUSD', 'BTCUSD'], backfill: false, prefix: 'kora:test:md:' });
    expect(c.wsOrigins).toEqual(['http://localhost:3000', 'https://a.example', 'https://b.example']);
    expect(() => loadMdConfig({ KORA_MD_FEED: 'maybe' })).toThrow();
    expect(() => loadMdConfig({ KORA_MD_STEP_MS: '1' })).toThrow();
    expect(() => loadMdConfig({ KORA_MD_REDIS_PREFIX: 'no-colon' })).toThrow();
    expect(busChannel(c, 'quotes:EURUSD')).toBe('kora:test:md:quotes:EURUSD');
    expect(lastKey(c, 'status')).toBe('kora:test:md:last:status');
  });

  it('parses the session cookie and builds frames once', () => {
    expect(parseCookie('a=1; kora_at=abc%3D; b=2', 'kora_at')).toBe('abc=');
    expect(parseCookie(undefined, 'kora_at')).toBeNull();
    expect(parseCookie('x=1', 'kora_at')).toBeNull();
    const f = frame('status', '{"a":1}', false);
    expect([f[0], f[1]]).toEqual([0x81, 30]);
    expect(f.subarray(2).toString()).toBe('{"ch":"status","data":{"a":1}}');
    expect(JSON.parse(frame('quotes:EURUSD', '{"bid":"1"}', true).subarray(2).toString())).toEqual({ ch: 'quotes:EURUSD', snapshot: true, data: { bid: '1' } });
    const mid = wsTextFrame(Buffer.alloc(300, 97));
    expect([mid[0], mid[1], mid.readUInt16BE(2), mid.length]).toEqual([0x81, 126, 300, 304]);
    const big = wsTextFrame(Buffer.alloc(70_000, 97));
    expect([big[1], Number(big.readBigUInt64BE(2)), big.length]).toEqual([127, 70_000, 70_010]);
  });
});

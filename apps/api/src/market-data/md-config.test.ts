import { describe, expect, it } from 'vitest';

import { frame } from './channel-hub';
import { parseCookie } from './gateway';
import { busChannel, lastKey, loadMdConfig } from './md-config';

describe('market data config and helpers', () => {
  it('defaults: in-process feed, 10 Hz conflation, web origin allowed', () => {
    const c = loadMdConfig({}, 'http://localhost:3000');
    expect(c).toMatchObject({ feed: 'inprocess', stepMs: 100, conflatePerSec: 10, backfill: true, respectSessions: false, prefix: 'kora:md:', symbols: [] });
    expect(c.wsOrigins).toEqual(['http://localhost:3000']);
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
    expect(frame('status', '{"a":1}', false).toString()).toBe('{"ch":"status","data":{"a":1}}');
    expect(JSON.parse(frame('quotes:EURUSD', '{"bid":"1"}', true).toString())).toEqual({ ch: 'quotes:EURUSD', snapshot: true, data: { bid: '1' } });
  });
});

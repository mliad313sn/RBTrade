import { describe, expect, it } from 'vitest';

import { apiWsPort, MAJORS, watchlistRow } from './market-ws';

describe('watchlist helpers', () => {
  it('derives the api WebSocket port from env', () => {
    expect(apiWsPort({})).toBe('4000');
    expect(apiWsPort({ API_INTERNAL_URL: 'http://127.0.0.1:4010' })).toBe('4010');
    expect(apiWsPort({ API_INTERNAL_URL: 'https://api.example' })).toBe('443');
    expect(apiWsPort({ API_PUBLIC_WS_PORT: '9000', API_INTERNAL_URL: 'http://x:1' })).toBe('9000');
    expect(apiWsPort({ API_INTERNAL_URL: 'not a url' })).toBe('4000');
    expect(MAJORS).toHaveLength(11);
  });

  it('computes mid and day change with registry precision, never floats', () => {
    expect(watchlistRow({ bid: '1.08419', ask: '1.08421', stale: false }, '1.08225', 5)).toEqual({
      mid: '1.08420',
      change: '0.001802',
      stale: false,
    });
    expect(watchlistRow({ bid: '64812.4', ask: '64812.5', stale: true }, null, 1)).toEqual({
      mid: '64812.4',
      change: null,
      stale: true,
    });
    expect(watchlistRow(null, '1', 2)).toEqual({ mid: null, change: null, stale: false });
    expect(watchlistRow({ bid: '1', ask: '1', stale: false }, '0', 2).change).toBeNull();
  });
});

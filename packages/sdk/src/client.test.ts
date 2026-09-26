import { describe, expect, it, vi } from 'vitest';

import { KoraApiError, KoraClient } from './client.js';

function mockFetch(status: number, body: unknown) {
  return vi.fn(async (_url: string, _init?: RequestInit) => new Response(body === undefined ? '' : JSON.stringify(body), { status }));
}

describe('KoraClient', () => {
  it('sends csrf header, bearer token and JSON body', async () => {
    const f = mockFetch(202, { accepted: true });
    const c = new KoraClient({ baseUrl: 'http://api/', token: 't0k', fetch: f as unknown as typeof fetch });
    await c.killSwitch('robots_cancel', 'hotkey');
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('http://api/kill-switch');
    expect(init?.method).toBe('POST');
    const h = init?.headers as Record<string, string>;
    expect(h['x-kora-csrf']).toBe('1');
    expect(h.authorization).toBe('Bearer t0k');
    expect(JSON.parse(String(init?.body))).toEqual({ scope: 'robots_cancel', source: 'hotkey' });
  });

  it('builds audit query strings and omits empties', async () => {
    const f = mockFetch(200, { events: [], nextBeforeId: null });
    const c = new KoraClient({ baseUrl: '/api', fetch: f as unknown as typeof fetch });
    await c.audit({ action: 'kill_switch.*', limit: 5, entity: '' });
    expect(f.mock.calls[0]![0]).toBe('/api/audit?action=kill_switch.*&limit=5');
    await c.audit();
    expect(f.mock.calls[1]![0]).toBe('/api/audit');
  });

  it('maps API errors to KoraApiError', async () => {
    const c = new KoraClient({ baseUrl: '/api', fetch: mockFetch(403, { error: 'forbidden', message: 'nope' }) as unknown as typeof fetch });
    await expect(c.me()).rejects.toMatchObject({ status: 403, code: 'forbidden', message: 'nope' });
    const c2 = new KoraClient({ baseUrl: '/api', fetch: mockFetch(500, undefined) as unknown as typeof fetch });
    await expect(c2.health()).rejects.toBeInstanceOf(KoraApiError);
    const c3 = new KoraClient({ baseUrl: '/api', fetch: mockFetch(400, { message: ['a', 'b'] }) as unknown as typeof fetch });
    await expect(c3.logout()).rejects.toMatchObject({ code: 'http_400', message: 'a, b' });
  });

  it('covers every endpoint path', async () => {
    const f = mockFetch(200, {});
    const c = new KoraClient({ baseUrl: '/api', fetch: f as unknown as typeof fetch }).withToken('x');
    await c.health();
    await c.signup({ email: 'a@b.c', password: 'p', displayName: 'd' });
    await c.login('a@b.c', 'p');
    await c.mfaEnroll('m');
    await c.mfaVerify('m', '123456');
    await c.me();
    await c.preferences();
    await c.updatePreferences({ viewMode: 'novice' });
    await c.verifyAudit();
    expect(f.mock.calls.map((x) => x[0])).toEqual([
      '/api/health', '/api/auth/signup', '/api/auth/login', '/api/auth/mfa/enroll', '/api/auth/mfa/verify',
      '/api/me', '/api/me/preferences', '/api/me/preferences', '/api/audit/verify',
    ]);
  });

  it('covers the trading, kill switch and appropriateness endpoints (goal 03)', async () => {
    const f = mockFetch(200, {});
    const c = new KoraClient({ baseUrl: '/api', fetch: f as unknown as typeof fetch });
    await c.account();
    await c.updateAccountSettings({ confirmMode: 'always' });
    await c.previewOrder({ symbol: 'EURUSD', side: 'buy', type: 'market', qty: '1000' });
    await c.placeOrder({ clientOrderId: 'c1', symbol: 'EURUSD', side: 'buy', type: 'market', qty: '1000' });
    await c.orders({ status: 'all' });
    await c.order('o 1');
    await c.amendOrder('o1', { qty: '2000' });
    await c.cancelOrder('o1');
    await c.positions();
    await c.closePosition('EURUSD');
    await c.fills({ limit: 5 });
    await c.killSwitch('robots', 'hotkey', 'why');
    await c.killSwitchState();
    await c.resumeTrading('checked', 'a1');
    await c.appropriateness();
    await c.submitAppropriateness('appropriateness', 1, { q: 'a' });
    const calls = f.mock.calls.map((x) => [x[1]?.method, x[0]]);
    expect(calls).toEqual([
      ['GET', '/api/accounts/me'],
      ['PUT', '/api/accounts/me/settings'],
      ['POST', '/api/orders/preview'],
      ['POST', '/api/orders'],
      ['GET', '/api/orders?status=all'],
      ['GET', '/api/orders/o%201'],
      ['PATCH', '/api/orders/o1'],
      ['DELETE', '/api/orders/o1'],
      ['GET', '/api/positions'],
      ['POST', '/api/positions/EURUSD/close'],
      ['GET', '/api/fills?limit=5'],
      ['POST', '/api/kill-switch'],
      ['GET', '/api/kill-switch'],
      ['POST', '/api/kill-switch/resume?accountId=a1'],
      ['GET', '/api/appropriateness/questionnaire'],
      ['POST', '/api/appropriateness/attempts'],
    ]);
    expect(JSON.parse(String(f.mock.calls[11]![1]!.body))).toEqual({ scope: 'robots', source: 'hotkey', reason: 'why' });
  });
});

import { describe, expect, it, vi } from 'vitest';

import { KoraApiError, KoraClient } from './client.js';

function mockFetch(status: number, body: unknown) {
  return vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Response(body === undefined ? '' : JSON.stringify(body), { status }),
  );
}

describe('KoraClient', () => {
  it('sends csrf header, bearer token and JSON body', async () => {
    const f = mockFetch(202, { accepted: true });
    const c = new KoraClient({
      baseUrl: 'http://api/',
      token: 't0k',
      fetch: f as unknown as typeof fetch,
    });
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
    const c = new KoraClient({
      baseUrl: '/api',
      fetch: mockFetch(403, { error: 'forbidden', message: 'nope' }) as unknown as typeof fetch,
    });
    await expect(c.me()).rejects.toMatchObject({ status: 403, code: 'forbidden', message: 'nope' });
    const c2 = new KoraClient({
      baseUrl: '/api',
      fetch: mockFetch(500, undefined) as unknown as typeof fetch,
    });
    await expect(c2.health()).rejects.toBeInstanceOf(KoraApiError);
    const c3 = new KoraClient({
      baseUrl: '/api',
      fetch: mockFetch(400, { message: ['a', 'b'] }) as unknown as typeof fetch,
    });
    await expect(c3.logout()).rejects.toMatchObject({ code: 'http_400', message: 'a, b' });
  });

  it('covers every endpoint path', async () => {
    const f = mockFetch(200, {});
    const c = new KoraClient({ baseUrl: '/api', fetch: f as unknown as typeof fetch }).withToken(
      'x',
    );
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
      '/api/health',
      '/api/auth/signup',
      '/api/auth/login',
      '/api/auth/mfa/enroll',
      '/api/auth/mfa/verify',
      '/api/me',
      '/api/me/preferences',
      '/api/me/preferences',
      '/api/audit/verify',
    ]);
  });

  it('covers the trading, kill switch and appropriateness endpoints (goal 03)', async () => {
    const f = mockFetch(200, {});
    const c = new KoraClient({ baseUrl: '/api', fetch: f as unknown as typeof fetch });
    await c.account();
    await c.updateAccountSettings({ confirmMode: 'always' });
    await c.previewOrder({ symbol: 'EURUSD', side: 'buy', type: 'market', qty: '1000' });
    await c.placeOrder({
      clientOrderId: 'c1',
      symbol: 'EURUSD',
      side: 'buy',
      type: 'market',
      qty: '1000',
    });
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
    await c.submitAppropriateness(
      'appropriateness',
      1,
      { q: 'a' },
      { version: 'v1', contentHash: 'a'.repeat(64), locale: 'en' },
    );
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
    expect(JSON.parse(String(f.mock.calls[11]![1]!.body))).toEqual({
      scope: 'robots',
      source: 'hotkey',
      reason: 'why',
    });
  });

  it('goal 08: typed sim (B-506), scenarios (B-505), novice, disclosure and MFA opt-in routes', async () => {
    const f = mockFetch(200, {});
    const c = new KoraClient({ baseUrl: '/api', fetch: f as unknown as typeof fetch });
    await c.simProject({} as never);
    await c.simFromTrades({ trades: [1] });
    await c.simPaperAnalytics();
    await c.simPaperProject({
      tradesPerPeriod: 1,
      horizonPeriods: 1,
      ruinFloorPct: 50,
      seed: 1,
      paths: 100,
    });
    await c.simScenarios('practice');
    await c.saveSimScenario({ kind: 'practice', name: 'A', input: {} });
    await c.deleteSimScenario('id/1');
    await c.noviceProfile();
    await c.completeOnboarding();
    await c.setNoviceLimits({ dailyLossLimit: '150' });
    await c.setNoviceLeverage(false);
    await c.noviceSummary();
    await c.noviceAssets();
    await c.noviceTicket({ symbol: 'EURUSD', direction: 'up', amount: '500', safetyNetPct: '3' });
    await c.knowledgeCheck();
    await c.submitKnowledgeCheck('knowledge-check', 1, { a: 'b' });
    await c.autoInvest();
    await c.startAutoInvest('trend-x', '1000');
    await c.pauseAutoInvest('r1');
    await c.resumeAutoInvest('r1');
    await c.disclosure('risk-warning', 'fr');
    await c.acknowledgeDisclosure('risk-warning', { version: '1', contentHash: 'h', locale: 'fr' });
    await c.mfaOptIn();
    expect(f.mock.calls.map(([u, i]) => [i?.method, u])).toEqual([
      ['POST', '/api/sim/project'],
      ['POST', '/api/sim/from-trades'],
      ['GET', '/api/sim/paper/analytics'],
      ['POST', '/api/sim/paper/project'],
      ['GET', '/api/sim/scenarios?kind=practice'],
      ['POST', '/api/sim/scenarios'],
      ['DELETE', '/api/sim/scenarios/id%2F1'],
      ['GET', '/api/novice/profile'],
      ['POST', '/api/novice/onboarding/complete'],
      ['PUT', '/api/novice/limits'],
      ['PUT', '/api/novice/leverage'],
      ['GET', '/api/novice/summary'],
      ['GET', '/api/novice/assets'],
      ['POST', '/api/novice/ticket'],
      ['GET', '/api/novice/knowledge-check'],
      ['POST', '/api/novice/knowledge-check/attempts'],
      ['GET', '/api/novice/auto-invest'],
      ['POST', '/api/novice/auto-invest'],
      ['POST', '/api/novice/auto-invest/r1/pause'],
      ['POST', '/api/novice/auto-invest/r1/resume'],
      ['GET', '/api/disclosures/risk-warning?locale=fr'],
      ['POST', '/api/disclosures/risk-warning/acknowledgements'],
      ['POST', '/api/auth/mfa/opt-in'],
    ]);
    expect(JSON.parse(String(f.mock.calls[10]![1]!.body))).toEqual({ enabled: false });
  });
});

// Goal 10 golden paths that no earlier spec covered end to end (the others are mapped in
// docs/qa/e2e-golden-paths.md):
// - robot build → backtest → paper-run → kill switch (the running robot is stopped by the halt);
// - the master definition of done: every user action lands in the audit log and the chain verifies.
import { expect, test, type Page } from '@playwright/test';

import { apiSignIn } from './helpers';
import { seedHistory } from './seed-history';

const CSRF = { 'x-kora-csrf': '1' };

/** SIMULATED BTC 1-hour SMA cross (fixed size, 4 % stop inside the crypto fat-finger band). */
const STRATEGY = {
  schema: 'kora.strategy',
  schemaVersion: 1,
  name: 'Golden path SMA',
  universe: { symbols: ['BTCUSD'], timeframe: '1h' },
  params: { fast: { value: 3, integer: true }, slow: { value: 8, integer: true } },
  entry: {
    side: 'long',
    conditions: [
      {
        type: 'cross',
        left: { kind: 'indicator', name: 'sma', period: { param: 'fast' } },
        direction: 'above',
        right: { kind: 'indicator', name: 'sma', period: { param: 'slow' } },
      },
    ],
  },
  filters: [],
  exit: { stop: { kind: 'percent', pct: 4 }, conditions: [] },
  size: { kind: 'fixed', qty: '0.01', maxOpenPositions: 1 },
};

async function holdKillSwitch(page: Page, scope: 'robots' | 'robots_cancel' | 'robots_cancel_flatten') {
  const btn = page.getByTestId('kill-switch');
  const box = (await btn.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(1650);
  await page.mouse.up();
  await page.getByTestId(`kill-scope-${scope}`).click();
}

test.beforeAll(async () => {
  await seedHistory(); // SIMULATED BTC 1h history for the backtest window (shared with robots.spec.ts)
});

test('robot build → backtest → paper-run → kill switch halts the running robot and the runner', async ({ page }) => {
  test.setTimeout(120_000);
  await apiSignIn(page, 'trader');
  const req = page.request;
  // Build (the drag-and-drop builder is covered by robots.spec.ts) and backtest through the API.
  const s = await req.post('/api/strategies', { headers: CSRF, data: { definition: STRATEGY } });
  expect(s.status()).toBe(201);
  const versionId = (await s.json()).latest.id as string;
  const bt = await req.post('/api/backtests', { headers: CSRF, data: { versionId } });
  expect(bt.status(), await bt.text()).toBeLessThan(300);
  const r = await req.post('/api/robots', { headers: CSRF, data: { name: 'Golden', versionId } });
  expect(r.status()).toBe(201);
  const robotId = (await r.json()).id as string;
  expect((await req.post(`/api/robots/${robotId}/start`, { headers: CSRF })).status()).toBe(200);

  // Paper-run: the monitor shows the robot running with a live runner heartbeat.
  await page.goto(`/robots?robot=${robotId}`);
  await expect(page.getByTestId('robot-state')).toContainText('RUNNING');
  await expect(page.getByTestId('heartbeat')).toContainText('●', { timeout: 20_000 });

  // Kill switch from the top bar (scope 1: robots).
  await holdKillSwitch(page, 'robots');
  await expect(page.getByTestId('halt-banner')).toContainText('Trading halted');
  await page.reload();
  await expect(page.getByTestId('robot-state')).toContainText('account halted by the kill switch');

  // The robot cannot restart while halted; the audit trail shows the halt.
  const restart = await req.post(`/api/robots/${robotId}/start`, { headers: CSRF });
  expect([409, 422]).toContain(restart.status());
  const events = (await (await req.get('/api/audit?action=kill_switch.completed')).json()).events as Array<{ payload: { scope: string } }>;
  expect(events[0]!.payload.scope).toBe('robots');
  const robot = (await (await req.get(`/api/robots/${robotId}`)).json()) as { accountHalted: boolean };
  expect(robot.accountHalted).toBe(true);
});

test('definition of done: every action of a new user is in the audit log and the chain verifies', async ({ page }) => {
  test.setTimeout(90_000);
  await apiSignIn(page, 'trader');
  const req = page.request;
  // place, amend, cancel a paper order
  const quote = (await (await req.get('/api/quotes?symbols=BTCUSD')).json()).quotes[0].quote as { bid: string };
  const limit = (Math.floor(Number(quote.bid) * 0.99 * 10) / 10).toFixed(1); // test-side arithmetic for a resting price
  const o = await req.post('/api/orders', { headers: CSRF, data: { clientOrderId: `dod-${Date.now()}`, symbol: 'BTCUSD', side: 'buy', type: 'limit', qty: '0.01', limitPrice: limit } });
  expect(o.status()).toBe(201);
  const orderId = (await o.json()).order.id as string;
  const amended = (Math.floor(Number(limit) * 0.999 * 10) / 10).toFixed(1);
  expect((await req.patch(`/api/orders/${orderId}`, { headers: CSRF, data: { limitPrice: amended } })).status()).toBe(200);
  expect((await req.delete(`/api/orders/${orderId}`, { headers: CSRF })).status()).toBe(200);
  // run a Monte Carlo projection
  expect((await req.post('/api/sim/project', { headers: CSRF, data: { paths: 1000 } })).status()).toBe(200);
  // ask the copilot (scripted provider in e2e)
  expect((await req.post('/api/ai/explain', { headers: CSRF, data: { topic: 'stop loss', screenText: 'Stop 1.08000' } })).status()).toBeLessThan(300);
  // hit the kill switch through the REST fallback
  expect((await req.post('/api/kill-switch', { headers: CSRF, data: { scope: 'robots', source: 'rest_fallback' } })).status()).toBe(202);

  const actions = new Set(((await (await req.get('/api/audit?limit=200')).json()).events as Array<{ action: string }>).map((e) => e.action));
  for (const a of ['auth.signup', 'auth.mfa_enrolled', 'appropriateness.passed', 'order.new', 'order.amended', 'order.cancelled', 'sim.projection_run', 'ai.request', 'kill_switch.completed']) {
    expect(actions, `audit has ${a}`).toContain(a);
  }
  await page.goto('/audit');
  await expect(page.getByRole('cell', { name: 'kill_switch.completed' }).first()).toBeVisible();
  await page.getByTestId('verify-chain').click();
  await expect(page.getByTestId('verify-result')).toContainText('Chain valid.');
});

import { expect, test } from '@playwright/test';

import { apiSignIn } from './helpers';

const CSRF = { 'x-kora-csrf': '1' };

/**
 * Goal 04 kill-switch acceptance in the Pro terminal: 1.5 s hold → scope 3 (halt + cancel +
 * flatten) → halted banner; the blotter's Orders and Positions empty out; the audit entries are
 * visible in the audit log page. BTC/USD trades 24/7, so this runs on any day.
 */
test('kill switch: hold 1.5 s → scope 3 → banner, orders cancelled, positions flat, audit entries visible', async ({
  page,
}) => {
  await apiSignIn(page, 'trader');
  const req = page.request;
  expect(
    (
      await req.post('/api/orders', {
        headers: CSRF,
        data: {
          clientOrderId: `ks4-${Date.now()}-1`,
          symbol: 'BTCUSD',
          side: 'buy',
          type: 'market',
          qty: '0.01',
        },
      })
    ).status(),
  ).toBe(201);
  const bid = (await (await req.get('/api/quotes?symbols=BTCUSD')).json()).quotes[0].quote
    .bid as string;
  const limit = (Math.floor(Number(bid) * 0.98 * 10) / 10).toFixed(1); // test-side arithmetic for a resting price
  expect(
    (
      await req.post('/api/orders', {
        headers: CSRF,
        data: {
          clientOrderId: `ks4-${Date.now()}-2`,
          symbol: 'BTCUSD',
          side: 'buy',
          type: 'limit',
          qty: '0.01',
          limitPrice: limit,
        },
      })
    ).status(),
  ).toBe(201);

  await page.goto('/terminal?symbol=BTCUSD');
  await expect(page.getByRole('tab', { name: 'Positions (1)' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Orders (1)' })).toBeVisible();
  await expect(page.getByTestId('blotter-positions').getByTestId('pos-BTCUSD')).toBeVisible();

  const btn = page.getByTestId('kill-switch');
  const box = (await btn.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(1650);
  await page.mouse.up();
  await page.getByTestId('kill-scope-robots_cancel_flatten').click();
  await expect(
    page.getByText(/1 order cancelled\. 1 position closed\. Audit event #\d+/),
  ).toBeVisible();
  await expect(page.getByTestId('halt-banner')).toContainText(
    'Trading halted: Halt, cancel + flatten',
  );

  // The streamed blotter empties out.
  await expect(page.getByRole('tab', { name: 'Positions (0)' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('tab', { name: 'Orders (0)' })).toBeVisible();
  await expect(page.getByTestId('blotter-positions')).toHaveCount(0);
  await page.getByRole('tab', { name: 'Orders (0)' }).click();
  await expect(page.getByTestId('blotter-orders')).toHaveCount(0);
  // The halt persists (server state): the banner is back after a reload.
  await page.reload();
  await expect(page.getByTestId('halt-banner')).toContainText('Trading halted');

  // Audit entries in the audit log page.
  await page.goto('/audit');
  await expect(page.getByRole('cell', { name: 'kill_switch.requested' }).first()).toBeVisible();
  await expect(page.getByRole('cell', { name: 'kill_switch.completed' }).first()).toBeVisible();
  const events = (await (await req.get('/api/audit?action=kill_switch.completed')).json()).events;
  expect(events[0].payload).toMatchObject({ scope: 'robots_cancel_flatten' });
});

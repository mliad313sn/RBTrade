import { expect, test } from '@playwright/test';

import { apiSignIn } from './helpers';

const CSRF = { 'x-kora-csrf': '1' };

/**
 * Goal 03 web flows on the live SIMULATED feed. BTC/USD trades 24/7, so these run on any day.
 */
test.beforeEach(async ({ page }) => {
  await apiSignIn(page, 'trader');
});

test('order ticket: server preview (notional, fees, margin, loss at stop) → place → blotter and top bar update', async ({ page }) => {
  await page.goto('/terminal?symbol=BTCUSD');
  await expect(page.getByTestId('account-equity')).toContainText('100,000.00 USD');
  const ticket = page.getByTestId('order-ticket');
  await ticket.getByRole('radio', { name: 'Market' }).click();
  await page.getByTestId('ticket-qty').fill('0.0100');
  await page.getByTestId('ticket-qty').blur();
  await expect(page.getByTestId('preview-notional')).toContainText('USD');
  await expect(page.getByTestId('preview-fees')).toContainText('USD');
  await expect(page.getByTestId('preview-margin')).toContainText('USD');
  await expect(page.getByTestId('preview-loss')).toContainText('No stop');
  await page.getByTestId('place-order').click();
  // Confirmation is required when there is no stop loss; a market order above the threshold needs a 600 ms hold (goal 04).
  const hold = page.getByTestId('confirm-hold');
  const box = (await hold.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(750);
  await page.mouse.up();
  await expect(page.getByTestId('ticket-result')).toContainText('Order filled: buy 0.01 BTCUSD');
  await page.getByRole('tab', { name: /Positions/ }).click();
  await expect(page.getByTestId('blotter-positions')).toContainText('BTC/USD');
  await expect(page.getByTestId('account-margin')).not.toContainText('0.00 USD ·');
  // Close from the blotter.
  await page.getByTestId('close-BTCUSD').click();
  await expect(page.getByTestId('blotter-positions')).toHaveCount(0);
  await page.getByRole('tab', { name: 'Fills' }).click();
  await expect(page.getByTestId('blotter-fills').getByRole('row')).toHaveCount(3);
});

test('kill switch scope 3 cancels and flattens through the engine; halted banner; resume with a reason', async ({ page }) => {
  const req = page.request;
  const buy = await req.post('/api/orders', { headers: CSRF, data: { clientOrderId: `e2e-${Date.now()}-1`, symbol: 'BTCUSD', side: 'buy', type: 'market', qty: '0.01' } });
  expect(buy.status()).toBe(201);
  const quote = await (await req.get('/api/quotes?symbols=BTCUSD')).json();
  const bid = quote.quotes[0].quote.bid as string;
  const limit = (Math.floor(Number(bid) * 0.98 * 10) / 10).toFixed(1); // test-side arithmetic for a resting price
  const rest = await req.post('/api/orders', { headers: CSRF, data: { clientOrderId: `e2e-${Date.now()}-2`, symbol: 'BTCUSD', side: 'buy', type: 'limit', qty: '0.01', limitPrice: limit } });
  expect(rest.status()).toBe(201);

  await page.goto('/terminal');
  await page.getByTestId('kill-switch').focus();
  await page.keyboard.down(' ');
  await page.waitForTimeout(1650);
  await page.keyboard.up(' ');
  await page.getByTestId('kill-scope-robots_cancel_flatten').click();
  await expect(page.getByText(/1 order cancelled\. 1 position closed\. Audit event #\d+/)).toBeVisible();
  const banner = page.getByTestId('halt-banner');
  await expect(banner).toContainText('Trading halted: Halt, cancel + flatten');
  expect((await (await req.get('/api/positions')).json()).positions).toHaveLength(0);
  expect((await (await req.get('/api/orders?status=open')).json()).orders).toHaveLength(0);

  await page.getByTestId('resume-trading').click();
  await expect(page.getByTestId('confirm-resume')).toBeDisabled();
  await page.getByLabel('Reason').fill('E2E: checked positions, safe to resume');
  await page.getByTestId('confirm-resume').click();
  await expect(page.getByText('Trading resumed.')).toBeVisible();
  await expect(banner).toHaveCount(0);
  const audit = await (await req.get('/api/audit?action=kill_switch.resumed')).json();
  expect(audit.events[0].payload.reason).toBe('E2E: checked positions, safe to resume');
});

import { expect, test } from '@playwright/test';

import { apiSignIn } from './helpers';

const ADVANCED = ['Stop-limit', 'Trailing', 'Bracket', 'OCO'];

test('Pro/Novice toggle persists per user, survives reload, and Novice hides advanced order types', async ({ page }) => {
  await apiSignIn(page, 'trader');
  await page.goto('/terminal?symbol=XAUUSD');
  const types = page.getByTestId('order-types');
  for (const t of ADVANCED) await expect(types.getByRole('radio', { name: t })).toBeVisible();

  await page.getByTestId('mode-toggle').getByRole('radio', { name: 'Novice' }).click();
  await expect(page).toHaveURL(/\/home\?symbol=XAUUSD&switched=novice/);
  await expect(page.getByTestId('what-changed')).toContainText('same account and instrument');
  await expect(page.getByTestId('novice-trade').getByRole('button', { name: 'Gold', pressed: true })).toBeVisible();
  await expect(page.getByTestId('order-types')).toHaveCount(0);
  for (const t of ADVANCED) await expect(page.getByText(t, { exact: true })).toHaveCount(0);

  await page.reload();
  await expect(page.getByTestId('novice-topbar')).toBeVisible();
  await page.goto('/');
  await expect(page).toHaveURL(/\/home$/);
  const me = await (await page.request.get('/api/me')).json();
  expect(me.preferences.viewMode).toBe('novice');
  expect(me.capabilities.orderTypes).toEqual(['market']);

  await page.getByTestId('mode-toggle').getByRole('radio', { name: 'Pro' }).click();
  await expect(page).toHaveURL(/\/terminal\?switched=pro/);
  await page.reload();
  await expect(page.getByTestId('pro-topbar')).toBeVisible();
  for (const t of ADVANCED) await expect(page.getByTestId('order-types').getByRole('radio', { name: t })).toBeVisible();
});

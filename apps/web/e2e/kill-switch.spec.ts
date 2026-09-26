import { expect, test, type Page } from '@playwright/test';

import { apiSignIn } from './helpers';

async function killEvents(page: Page) {
  const r = await page.request.get('/api/audit?action=kill_switch.*');
  return (await r.json()).events as Array<{ entityId: string; payload: { scope: string; source: string } }>;
}

test.beforeEach(async ({ page }) => {
  await apiSignIn(page, 'trader');
  await page.goto('/terminal');
});

test('a short press does not open the menu; a 1.5 s mouse hold does, and a scope writes an audit event', async ({ page }) => {
  const btn = page.getByTestId('kill-switch');
  const box = (await btn.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(700);
  await page.mouse.up();
  await page.waitForTimeout(1200);
  await expect(page.getByTestId('kill-switch-menu')).toHaveCount(0);

  await page.mouse.down();
  await page.waitForTimeout(1650);
  await page.mouse.up();
  const menu = page.getByTestId('kill-switch-menu');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('button')).toHaveCount(4); // 3 scopes + cancel
  await menu.getByTestId('kill-scope-robots_cancel_flatten').click();
  await expect(page.getByText(/Kill switch recorded: Halt, cancel \+ flatten\. Audit event #\d+/)).toBeVisible();
  const events = await killEvents(page);
  expect(events[0]).toMatchObject({ entityId: 'robots_cancel_flatten', payload: { scope: 'robots_cancel_flatten', source: 'ui_button' } });
});

test('keyboard Space-hold opens the menu', async ({ page }) => {
  await page.getByTestId('kill-switch').focus();
  await page.keyboard.down(' ');
  await page.waitForTimeout(1650);
  await page.keyboard.up(' ');
  await expect(page.getByTestId('kill-switch-menu')).toBeVisible();
  await page.getByTestId('kill-scope-robots').click();
  await expect.poll(async () => (await killEvents(page))[0]?.entityId).toBe('robots');
});

test('touch hold opens the menu', async ({ page }) => {
  const btn = page.getByTestId('kill-switch');
  await btn.dispatchEvent('pointerdown', { pointerType: 'touch', button: 0, isPrimary: true, pointerId: 7 });
  await page.waitForTimeout(1650);
  await btn.dispatchEvent('pointerup', { pointerType: 'touch', button: 0, isPrimary: true, pointerId: 7 });
  await expect(page.getByTestId('kill-switch-menu')).toBeVisible();
  await page.getByTestId('kill-scope-robots_cancel').click();
  await expect.poll(async () => (await killEvents(page))[0]?.entityId).toBe('robots_cancel');
});

test('Ctrl+Shift+K held for 1.5 s opens the menu (source: hotkey)', async ({ page }) => {
  await page.locator('main').click({ position: { x: 5, y: 5 } });
  await page.keyboard.down('Control');
  await page.keyboard.down('Shift');
  await page.keyboard.down('K');
  await page.waitForTimeout(1650);
  await page.keyboard.up('K');
  await page.keyboard.up('Shift');
  await page.keyboard.up('Control');
  await expect(page.getByTestId('kill-switch-menu')).toBeVisible();
  await page.getByTestId('kill-scope-robots').click();
  await expect.poll(async () => (await killEvents(page))[0]?.payload.source).toBe('hotkey');
});

test('the audit page verifies the chain', async ({ page }) => {
  await page.goto('/audit');
  await page.getByTestId('verify-chain').click();
  await expect(page.getByTestId('verify-result')).toContainText('Chain valid.');
});

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

import { apiSignIn } from './helpers';

async function scan(page: Page, name: string) {
  const res = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const serious = res.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  const report = serious.map(
    (v) => `${name}: ${v.id} (${v.impact}) ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`,
  );
  expect(report, report.join('\n')).toEqual([]);
  expect(
    res.violations.filter((v) => v.id === 'color-contrast'),
    'text contrast',
  ).toEqual([]);
}

test('login and sign-up pages have no serious axe violations (incl. colour contrast)', async ({
  page,
}) => {
  await page.goto('/login');
  await scan(page, '/login');
  await page.goto('/signup');
  await scan(page, '/signup');
});

test('pro shell and novice shell pass axe in Chromium', async ({ page }) => {
  await apiSignIn(page, 'trader');
  await page.goto('/terminal');
  await expect(page.getByTestId('status-bar')).toContainText('Connected');
  await scan(page, '/terminal (pro-dark)');
  await page.goto('/settings');
  await scan(page, '/settings (pro-dark)');
  await page.getByTestId('mode-toggle').getByRole('radio', { name: 'Novice' }).click();
  await expect(page.getByTestId('novice-topbar')).toBeVisible();
  await page.goto('/home');
  await scan(page, '/home (novice-light)');
});

test('appropriateness assessment and the halted banner pass axe', async ({ page }) => {
  await apiSignIn(page, 'novice');
  await page.goto('/appropriateness');
  await expect(page.getByTestId('appropriateness')).toBeVisible();
  await scan(page, '/appropriateness (novice-light)');
  await page.request.post('/api/kill-switch', {
    headers: { 'x-kora-csrf': '1' },
    data: { scope: 'robots', source: 'rest_fallback' },
  });
  await page.goto('/home');
  await expect(page.getByTestId('halt-banner')).toBeVisible();
  await scan(page, '/home halted (novice-light)');
});

test('forbidden page passes axe', async ({ page }) => {
  await apiSignIn(page, 'novice');
  await page.goto('/robots/builder');
  await scan(page, '/forbidden');
});

test('novice mobile layout shows the bottom tab bar', async ({ browser }) => {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  const page = await ctx.newPage();
  await apiSignIn(page, 'novice');
  await page.goto('/home');
  const bar = page.getByTestId('mobile-tabbar');
  await expect(bar).toBeVisible();
  await expect(bar.getByRole('link')).toHaveText(['Home', 'Practice', 'Auto-invest', 'Learn']);
  await expect(page.getByTestId('kill-switch')).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await scan(page, '/home (mobile)');
  await ctx.close();
});

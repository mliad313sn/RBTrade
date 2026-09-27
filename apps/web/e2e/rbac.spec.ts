import { expect, test } from '@playwright/test';

import { apiSignIn } from './helpers';

test('a novice cannot reach /robots/* builder routes: 403 + friendly page', async ({ page }) => {
  await apiSignIn(page, 'novice');
  for (const path of ['/robots/builder', '/robots']) {
    const res = await page.goto(path);
    expect(res?.status()).toBe(403);
    await expect(
      page.getByRole('heading', { name: /Robot builder isn.t part of your account/ }),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Back to my home' })).toBeVisible();
  }
  const api = await page.request.get('/api/robots/builder');
  expect(api.status()).toBe(403);
});

test('a trader can open the robot builder', async ({ page }) => {
  await apiSignIn(page, 'trader');
  const res = await page.goto('/robots/builder');
  expect(res?.status()).toBe(200);
  await expect(page.getByText('Robot builder', { exact: true }).first()).toBeVisible();
});

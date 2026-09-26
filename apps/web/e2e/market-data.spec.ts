import { expect, test } from '@playwright/test';

import { apiSignIn } from './helpers';

test.describe('market data', () => {
  test('pro terminal watchlist streams SIMULATED quotes over the WebSocket with registry precision', async ({ page }) => {
    await apiSignIn(page, 'trader');
    await page.goto('/terminal');
    const wl = page.getByTestId('watchlist');
    await expect(wl).toContainText('Simulated feed · not market data');
    await expect(page.getByTestId('feed-status')).toHaveText('feed ok', { timeout: 15_000 });
    const eur = page.getByTestId('wl-EURUSD-mid');
    await expect(eur).toHaveText(/^\d\.\d{5}$/, { timeout: 15_000 }); // EURUSD precision 5 from the registry
    await expect(page.getByTestId('wl-USDJPY-mid')).toHaveText(/^\d{3}\.\d{3}$/);
    await expect(page.getByTestId('wl-BTCUSD-mid')).toHaveText(/^\d{2},\d{3}\.\d$/);
    await expect(page.getByTestId('wl-US500')).toContainText('Index CFD');
    const first = await eur.textContent();
    await expect.poll(async () => page.getByTestId('wl-BTCUSD-mid').textContent(), { timeout: 10_000 }).not.toBe(await page.getByTestId('wl-BTCUSD-mid').textContent());
    expect(first).toBeTruthy();
    await expect(page.locator('[data-stale="true"]')).toHaveCount(0);
  });
});

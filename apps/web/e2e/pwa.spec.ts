import { expect, test } from '@playwright/test';

import { apiSignIn } from './helpers';

/** Goal 08 §8: installable PWA, offline shell with a clear "prices paused" state, no push. */
test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

test('web app manifest and icons are served and complete', async ({ request }) => {
  const m = await request.get('/manifest.webmanifest');
  expect(m.status()).toBe(200);
  const manifest = await m.json();
  expect(manifest).toMatchObject({ short_name: 'Kora', start_url: '/home', scope: '/', display: 'standalone' });
  const sizes = manifest.icons.map((i: { sizes: string; purpose: string }) => `${i.sizes}:${i.purpose}`);
  expect(sizes).toEqual(expect.arrayContaining(['192x192:any', '512x512:any', '512x512:maskable']));
  for (const icon of manifest.icons) {
    const r = await request.get(icon.src);
    expect(r.status()).toBe(200);
    expect(r.headers()['content-type']).toContain('image/png');
  }
  const sw = await request.get('/sw.js');
  expect(sw.status()).toBe(200);
  expect(await sw.text()).not.toMatch(/addEventListener\(\s*['"]push['"]/);
});

test('Chromium reports the app installable; offline shows "Prices paused"; no notification prompt', async ({ page, context }) => {
  test.setTimeout(60_000);
  // Count notification-permission and push-subscription requests (there must be none).
  await page.addInitScript(() => {
    const w = window as unknown as { __koraNudges: number };
    w.__koraNudges = 0;
    const N = window.Notification as unknown as { requestPermission?: () => Promise<string> };
    if (N) N.requestPermission = () => ((w.__koraNudges += 1), Promise.resolve('denied'));
    const proto = (window as unknown as { PushManager?: { prototype: { subscribe: () => Promise<unknown> } } }).PushManager?.prototype;
    if (proto) proto.subscribe = () => ((w.__koraNudges += 1), Promise.reject(new Error('blocked')));
  });
  await apiSignIn(page, 'novice');
  await page.goto('/home');
  await expect(page.getByTestId('novice-topbar')).toBeVisible();
  // The service worker registers and takes control (production build).
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);

  const cdp = await context.newCDPSession(page);
  const { installabilityErrors } = (await cdp.send('Page.getInstallabilityErrors')) as { installabilityErrors: Array<{ errorId: string }> };
  expect(installabilityErrors.map((e) => e.errorId)).toEqual([]);
  expect(await page.evaluate(() => (window as unknown as { __koraNudges: number }).__koraNudges)).toBe(0);

  // Going offline inside the app: a calm banner, nothing looks live.
  await context.setOffline(true);
  await expect(page.getByTestId('prices-paused')).toBeVisible();
  await expect(page.getByTestId('prices-paused')).toContainText('Prices paused.');
  // The offline shell ("Prices paused") is in the service worker cache, ready for a failed
  // navigation (the fallback itself is driven in src/lib/novice/sw.test.ts: Playwright's offline
  // switch does not reach a service worker's own fetches).
  const cached = await page.evaluate(async () => {
    const r = await caches.match('/offline');
    return r ? await r.text() : null;
  });
  expect(cached).toContain('data-testid="offline-shell"');
  expect(cached).toContain('Prices paused');
  await context.setOffline(false);
  await page.goto('/home');
  await expect(page.getByTestId('prices-paused')).toHaveCount(0);
});

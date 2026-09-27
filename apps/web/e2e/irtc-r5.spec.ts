import { expect, test, type Page } from '@playwright/test';

import { apiSignIn } from './helpers';

/**
 * IRTC R5 regression suite (frontend, UX and accessibility review, docs/review/IRTC-R5-fixes.md).
 * Each test failed on the reviewed build and passes after the fix.
 */

const usd = (x: string | number) => `${Number(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD`;

async function marketTicket(page: Page, symbol: string, qty: string) {
  await page.goto(`/terminal?symbol=${symbol}`);
  const ticket = page.getByTestId('order-ticket');
  await expect(ticket.getByTestId('ticket-side-buy')).toContainText(/\d/);
  await ticket.getByRole('radio', { name: 'Market', exact: true }).click();
  await ticket.getByTestId('ticket-qty').fill(qty);
  await ticket.getByTestId('ticket-qty').blur();
  await expect(page.getByTestId('preview-notional')).toContainText('USD');
  return ticket;
}

async function hold(page: Page, testId: string, ms: number) {
  const box = (await page.getByTestId(testId).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(ms);
  await page.mouse.up();
}

test.describe('Pro terminal (trader)', () => {
  test.beforeEach(async ({ page }) => {
    await apiSignIn(page, 'trader');
  });

  test('R5-01: the confirm dialog shows the preview of the order being placed, even when the quantity changed just before Review', async ({ page }) => {
    const previews = new Map<string, Array<{ notional: string; margin: string }>>();
    page.on('response', async (r) => {
      if (!r.url().endsWith('/api/orders/preview') || r.request().method() !== 'POST') return;
      const qty = (r.request().postDataJSON() as { qty: string }).qty;
      const j = (await r.json().catch(() => null)) as { preview?: { notional: { base: string }; margin: { required: string } } } | null;
      if (j?.preview) previews.set(qty, [...(previews.get(qty) ?? []), { notional: j.preview.notional.base, margin: j.preview.margin.required }]);
    });
    const ticket = await marketTicket(page, 'BTCUSD', '0.0100');
    await expect.poll(() => previews.has('0.01')).toBe(true);

    // Real-world latency on the preview endpoint; the user changes the size and reviews at once.
    await page.route('**/api/orders/preview', async (route) => {
      await new Promise((r) => setTimeout(r, 1500));
      await route.continue();
    });
    await ticket.getByTestId('ticket-qty').fill('0.5000');
    await ticket.getByTestId('ticket-qty').press('Control+Enter');
    const dialog = page.getByTestId('confirm-order');
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => previews.has('0.5')).toBe(true);
    await expect(dialog).toContainText('Confirm buy 0.5 BTC/USD');
    // The figures are those of a preview computed for 0.5 BTC (never the 0.01 one still on screen).
    const text = (await dialog.innerText()).replace(/\s+/g, ' ');
    const match = previews.get('0.5')!.find((f) => text.includes(`Notional ${usd(f.notional)}`) && text.includes(`margin ${usd(f.margin)}`));
    expect(match, text).toBeTruthy();
    for (const old of previews.get('0.01')!) expect(text).not.toContain(`Notional ${usd(old.notional)}`);
    await page.unroute('**/api/orders/preview');

    const placed = page.waitForRequest((r) => r.url().endsWith('/api/orders') && r.method() === 'POST');
    await hold(page, 'confirm-hold', 750);
    expect(((await placed).postDataJSON() as { qty: string }).qty).toBe('0.5');
    // R5-07: the fill price is shown at the instrument precision (BTC/USD: 1 decimal), not 40 decimals.
    await expect(page.getByTestId('ticket-result')).toHaveText(/^Order filled: buy 0\.5 BTCUSD at [\d,]+\.\d\.$/);
  });

  test('R5-05: the ticket does not flood screen readers when the stop is in pips (at most one announcement per edit)', async ({ page }) => {
    const ticket = await marketTicket(page, 'BTCUSD', '1');
    await ticket.getByTestId('ticket-sl').fill('200');
    await expect(page.getByTestId('preview-loss')).toContainText('USD');
    await page.waitForTimeout(2500); // the edit settles and is announced once
    const changes = await page.evaluate(async () => {
      const root = document.querySelector('[data-testid=order-ticket]')!;
      const regions = [...root.querySelectorAll('[aria-live]')].filter((e) => e.getAttribute('aria-live') !== 'off');
      const last = new Map(regions.map((r) => [r, (r as HTMLElement).innerText]));
      let n = 0;
      const mo = new MutationObserver(() => {
        for (const r of regions) {
          const t = (r as HTMLElement).innerText;
          if (t !== last.get(r)) {
            n++;
            last.set(r, t);
          }
        }
      });
      regions.forEach((r) => mo.observe(r, { subtree: true, childList: true, characterData: true }));
      await new Promise((r) => setTimeout(r, 8000));
      mo.disconnect();
      return n;
    });
    expect(changes).toBeLessThanOrEqual(1);
    await expect(page.getByTestId('ticket-preview')).not.toHaveAttribute('aria-live', /.+/);
  });

  test('R5-04: a single activation (screen reader, voice control, tap) opens the kill-switch scope menu', async ({ page }) => {
    await page.goto('/terminal');
    const ks = page.getByTestId('kill-switch');
    await expect(ks).toHaveAttribute('data-ready', 'true');
    // Screen readers and voice control dispatch a click with no pointer hold (detail 0).
    await ks.evaluate((e) => (e as HTMLButtonElement).click());
    const menu = page.getByTestId('kill-switch-menu');
    await expect(menu).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    // A quick mouse click or tap gives visible feedback: the same menu (the scope choice is the confirmation).
    await ks.click();
    await expect(menu).toBeVisible();
    await page.keyboard.press('Escape');
  });
});

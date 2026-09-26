import { expect, test, type Page } from '@playwright/test';

import { apiSignIn } from './helpers';

/**
 * Goal 04 acceptance flow on EUR/USD. FX is closed at weekends; the e2e api runs with
 * KORA_TRADING_SESSION_OVERRIDE=EURUSD (test-only, refused outside dev/test, ADR 0004), so this is
 * deterministic on any weekday. Everything else about fill safety (fresh quote, feed up) applies.
 */

/** "108,420.69 USD" / "−200.00 USD · 0.08% eq." / "1 : 2.00" → the first decimal number. */
function firstNumber(text: string | null): number {
  const m = (text ?? '').replace(/,/g, '').replace('−', '-').match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : NaN;
}

async function quote(page: Page, symbol: string): Promise<{ bid: string; ask: string }> {
  const r = await (await page.request.get(`/api/quotes?symbols=${symbol}`)).json();
  return r.quotes[0].quote;
}

test('search EUR/USD → limit buy with SL/TP → preview matches the API → confirm → Orders → drag the line to amend → fill → Positions and Fills (slippage) → close', async ({ page }) => {
  test.setTimeout(90_000);
  await apiSignIn(page, 'trader');
  await page.goto('/terminal?symbol=BTCUSD');
  await expect(page.getByTestId('chart-symbol')).toHaveText('BTC/USD');

  // 1. Search EUR/USD in the ⌘K palette.
  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('palette')).toBeVisible();
  await page.getByTestId('palette-input').fill('EUR/USD');
  await expect(page.getByTestId('palette-EURUSD')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('palette')).toHaveCount(0);
  await expect(page.getByTestId('chart-symbol')).toHaveText('EUR/USD');
  await expect(page).toHaveURL(/symbol=EURUSD/);

  // 2. Limit buy 100,000 at 10 pips under the bid, SL 20 pips, TP 40 pips.
  const ticket = page.getByTestId('order-ticket');
  await expect(ticket.getByTestId('ticket-side-buy')).toContainText(/1\.\d{5}/);
  await ticket.getByTestId('ticket-side-buy').click();
  await ticket.getByRole('radio', { name: 'Limit', exact: true }).click();
  const q = await quote(page, 'EURUSD');
  const limit = (Math.round((Number(q.bid) - 0.001) * 1e5) / 1e5).toFixed(5); // test-side arithmetic for a resting price
  let lastPreview: { body: Record<string, unknown>; res: { preview: Record<string, any> } } | null = null;
  page.on('response', async (r) => {
    if (!r.url().endsWith('/api/orders/preview') || r.request().method() !== 'POST') return;
    const body = r.request().postDataJSON() as Record<string, unknown>;
    if (body.limitPrice === limit && body.stopLossPrice && body.takeProfitPrice && body.qty === '100000') lastPreview = { body, res: await r.json() };
  });
  await ticket.getByTestId('ticket-qty').fill('100000');
  await ticket.getByTestId('ticket-limit').fill(limit);
  await ticket.getByTestId('ticket-sl').fill('20');
  await ticket.getByTestId('ticket-tp').fill('40');
  await ticket.getByTestId('ticket-tp').blur();

  // 3. The previewed values on screen equal the API response.
  await expect.poll(() => lastPreview !== null, { timeout: 10_000 }).toBe(true);
  const sent = lastPreview!.body;
  expect(sent).toMatchObject({ symbol: 'EURUSD', side: 'buy', type: 'limit', qty: '100000', limitPrice: limit });
  expect(Number(sent.stopLossPrice)).toBeCloseTo(Number(limit) - 0.002, 6); // 20 pips of 0.0001 (registry pip size)
  expect(Number(sent.takeProfitPrice)).toBeCloseTo(Number(limit) + 0.004, 6);
  await expect
    .poll(async () => {
      const p = lastPreview!.res.preview;
      const shown = {
        notional: firstNumber(await page.getByTestId('preview-notional').textContent()),
        fees: firstNumber(await page.getByTestId('preview-fees').textContent()),
        margin: firstNumber(await page.getByTestId('preview-margin').textContent()),
        loss: firstNumber(await page.getByTestId('preview-loss').textContent()),
        rr: Number((await page.getByTestId('preview-rr').textContent())?.split(':')[1]),
      };
      return (
        shown.notional === Number(p.notional.base) &&
        shown.fees === Number(p.fees.total) &&
        shown.margin === Number(p.margin.required) &&
        shown.loss === -Number(p.lossIfStopHit.total) &&
        shown.rr === Number(p.rewardRisk)
      );
    }, { timeout: 10_000 })
    .toBe(true);
  await expect(page.getByTestId('preview-loss')).toContainText(`${lastPreview!.res.preview.lossIfStopHit.pctEquity}% eq.`);

  // 4. Review → confirmation (notional above the 50,000 threshold) → place.
  await ticket.getByTestId('place-order').click();
  const confirm = page.getByTestId('confirm-order');
  await expect(confirm).toBeVisible();
  await confirm.getByTestId('confirm-place').click();
  await expect(ticket.getByTestId('ticket-result')).toContainText('Order working: buy 100,000 EURUSD');

  // 5. It appears in Orders (streamed).
  await page.getByRole('tab', { name: /^Orders \(\d+\)/ }).click();
  const orders = page.getByTestId('blotter-orders');
  const open = (await (await page.request.get('/api/orders?status=open')).json()).orders as Array<{ id: string; role: string; limitPrice: string }>;
  const primary = open.find((o) => o.role === 'primary')!;
  await expect(orders.getByTestId(`order-row-${primary.id}`)).toContainText(limit.replace(/(\d)(?=(\d{3})+\.)/g, '$1,'));

  // 6. Drag the working order's price line above the ask, confirm the amendment.
  const handle = page.getByTestId(`order-line-${primary.id}`);
  await expect(handle).toBeVisible();
  await expect(handle).toContainText(`BUY LMT ${limit}`);
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  let y = box.y + box.height / 2;
  const target = Number((await quote(page, 'EURUSD')).ask) + 0.0002;
  for (let i = 0; i < 120; i++) {
    y -= 4;
    await page.mouse.move(box.x + box.width / 2, y, { steps: 2 });
    const price = firstNumber(await handle.textContent());
    if (price >= target) break;
  }
  const draggedTo = firstNumber(await handle.textContent());
  expect(draggedTo).toBeGreaterThanOrEqual(target);
  await page.mouse.up();
  const amend = page.getByTestId('confirm-amend');
  await expect(amend).toBeVisible();
  await expect(amend).toContainText(`→ ${draggedTo.toFixed(5)}`);
  const patch = page.waitForResponse((r) => r.url().includes(`/api/orders/${primary.id}`) && r.request().method() === 'PATCH');
  await amend.getByTestId('confirm-amend-ok').click();
  expect((await patch).status()).toBe(200);

  // 7. It fills in the simulated market → Positions and Fills (with slippage).
  await expect.poll(async () => (await (await page.request.get('/api/positions')).json()).positions.length, { timeout: 15_000 }).toBe(1);
  await page.getByRole('tab', { name: /^Positions/ }).click();
  const pos = page.getByTestId('blotter-positions');
  await expect(pos.getByTestId('pos-EURUSD')).toContainText('▲ Long');
  await expect(pos.getByTestId('pos-EURUSD')).toContainText('100,000');
  // Stop and target children of the entry are working and shown against the position.
  await expect(pos.getByTestId('pos-EURUSD')).toContainText(String(sent.stopLossPrice));
  await page.getByRole('tab', { name: 'Fills' }).click();
  const fills = page.getByTestId('blotter-fills');
  await expect(fills.getByRole('row')).toHaveCount(2); // header + the entry fill
  await expect(fills.getByTestId('fill-slippage').first()).toHaveText(/^(0|[+−]\d\.\d{5})$/);

  // 8. Close the position from Positions.
  await page.getByRole('tab', { name: /^Positions/ }).click();
  await pos.getByTestId('close-EURUSD').click();
  await expect.poll(async () => (await (await page.request.get('/api/positions')).json()).positions.length, { timeout: 15_000 }).toBe(0);
  await expect(page.getByTestId('blotter-positions')).toHaveCount(0);
  await page.getByRole('tab', { name: 'Fills' }).click();
  await expect(page.getByTestId('blotter-fills').getByRole('row')).toHaveCount(3);
  // Closing the position cancelled its protective stop and target.
  expect((await (await page.request.get('/api/orders?status=open')).json()).orders).toHaveLength(0);
});

test('layouts: dock a panel elsewhere, save it by name, reset to default, load it back', async ({ page }) => {
  await apiSignIn(page, 'trader');
  await page.goto('/terminal');
  await expect(page.getByTestId('chart-panel')).toBeVisible();
  // Dock the Risk tab into the chart group (drag its tab onto the chart's content).
  await page.getByRole('tab', { name: 'Risk' }).dragTo(page.getByTestId('chart-canvas'));
  const chartGroupTabs = page.getByRole('tablist').filter({ has: page.getByRole('tab', { name: 'Chart' }) });
  await expect(chartGroupTabs.getByRole('tab', { name: 'Risk' })).toBeVisible();
  await page.getByTestId('layout-menu').click();
  await page.getByTestId('layout-name').fill('Risk desk');
  await page.getByTestId('layout-save').click();
  await expect(page.getByTestId('layout-load-Risk desk')).toBeVisible();
  expect((await (await page.request.get('/api/me/layouts')).json()).layouts.map((l: { name: string }) => l.name)).toContain('Risk desk');
  await page.getByTestId('layout-reset').click();
  await expect(chartGroupTabs.getByRole('tab', { name: 'Risk' })).toHaveCount(0);
  await page.getByTestId('layout-menu').click();
  await page.getByTestId('layout-load-Risk desk').click();
  await expect(page.getByTestId('layout-dialog')).toHaveCount(0);
  await expect(chartGroupTabs.getByRole('tab', { name: 'Risk' })).toBeVisible();
  // Reload keeps the working layout (localStorage).
  await page.reload();
  const tabs = page.getByRole('tablist').filter({ has: page.getByRole('tab', { name: 'Chart' }) });
  await expect(tabs.getByRole('tab', { name: 'Risk' })).toBeVisible();
  await tabs.getByRole('tab', { name: 'Chart' }).click();
  await expect(page.getByTestId('chart-panel')).toBeVisible();
});

test('watchlists: global list covers every venue with session badges; add via ⌘K; keyboard reorder persists', async ({ page }) => {
  await apiSignIn(page, 'trader');
  await page.goto('/terminal');
  const wl = page.getByTestId('watchlist');
  await expect(wl.getByTestId('wl-EURUSD')).toBeVisible();
  const lists = (await (await page.request.get('/api/me/watchlists')).json()).watchlists as Array<{ id: string; name: string; symbols: string[] }>;
  const global = lists.find((l) => l.name === 'Global')!;
  await page.getByTestId('watchlist-select').selectOption(global.id);
  await expect(page.getByTestId('watchlist-rows')).toHaveAttribute('data-total', String(global.symbols.length));
  // One instrument for every venue that lists an active instrument (all five continents + global).
  const instruments = (await (await page.request.get('/api/instruments')).json()).instruments as Array<{ venue: string; status: string }>;
  const venues = new Set(instruments.filter((i) => i.status === 'active').map((i) => i.venue));
  expect(global.symbols.length).toBe(venues.size);
  expect(venues.size).toBeGreaterThanOrEqual(15);
  // Session badge text: every visible row names its venue MIC.
  const first = wl.getByTestId(`wl-${global.symbols[0]}`);
  await expect(first).toContainText(/[A-Z0-9]{4}/);

  // Back to Majors, add a Tokyo equity from the palette (add mode) and move it up with Alt+↑.
  const majors = lists.find((l) => l.name === 'Majors')!;
  await page.getByTestId('watchlist-select').selectOption(majors.id);
  await page.getByTestId('watchlist-add').click();
  await page.getByTestId('palette-input').fill('XTKS');
  const hit = page.locator('[data-testid^="palette-"][role="option"]').first();
  const sym = (await hit.getAttribute('data-testid'))!.replace('palette-', '');
  await page.keyboard.press('Enter');
  await expect(wl.getByTestId(`wl-${sym}`)).toBeVisible();
  await wl.getByTestId(`wl-${sym}`).click();
  await page.keyboard.press('Alt+ArrowUp');
  await expect.poll(async () => {
    const r = (await (await page.request.get('/api/me/watchlists')).json()).watchlists.find((l: { id: string }) => l.id === majors.id);
    return r.symbols.slice(-2);
  }).toEqual([sym, 'WTI']);
});

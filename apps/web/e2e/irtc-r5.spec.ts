import { TREND_X } from '@kora/domain';
import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';

import { apiSignIn, PASSWORD, totp } from './helpers';

async function db<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL_MIGRATE_E2E });
  await c.connect();
  try {
    return (await c.query(sql, params)).rows as T[];
  } finally {
    await c.end();
  }
}

const CSRF = { 'x-kora-csrf': '1' };

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

/** WCAG relative-luminance contrast of two CSS rgb() colours (test-side arithmetic). */
function contrast(a: string, b: string): number {
  const lum = (c: string) => {
    const [r, g, bl] = (c.match(/\d+(\.\d+)?/g) ?? ['0', '0', '0'])
      .slice(0, 3)
      .map((x) => Number(x) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
  };
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x! + 0.05) / (y! + 0.05);
}

async function setPrefs(page: Page, patch: Record<string, unknown>) {
  expect((await page.request.put('/api/me/preferences', { headers: CSRF, data: patch })).status()).toBe(200);
}

async function setFrench(page: Page) {
  await page.context().addCookies([{ name: 'kora_locale', value: 'fr', domain: '127.0.0.1', path: '/' }]);
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

test.describe('Pro views (trader), numbers and state', () => {
  test.beforeEach(async ({ page }) => {
    await apiSignIn(page, 'trader');
  });

  test('R5-02: blotter Mark and Unrealized P&L follow the live quotes and agree with the blotter summary', async ({ page }) => {
    const buy = await page.request.post('/api/orders', { headers: CSRF, data: { clientOrderId: `e2e-r5-02-${Date.now()}`, symbol: 'BTCUSD', side: 'buy', type: 'market', qty: '1' } });
    expect(buy.status()).toBe(201);
    await page.goto('/terminal?symbol=BTCUSD');
    await page.getByRole('tab', { name: /Positions/ }).click();
    const row = page.getByTestId('pos-BTCUSD');
    await expect(row).toBeVisible();
    const marks = new Set<string>();
    for (let i = 0; i < 16; i++) {
      // Read the row and the summary in the same frame.
      const { cells, summary } = await page.evaluate(() => ({
        cells: [...document.querySelectorAll('[data-testid=pos-BTCUSD] td')].map((td) => (td as HTMLElement).innerText),
        summary: (document.querySelector('[data-testid=blotter-summary]') as HTMLElement).innerText.replace(/\s+/g, ' '),
      }));
      marks.add(cells[4]!.trim());
      // One source of truth: the summary's unrealized equals the only position's P&L (same render).
      const pnl = cells[7]!.replace(/Stale/g, '').trim();
      expect(summary).toContain(`Unrealized ${pnl}`);
      await page.waitForTimeout(500);
    }
    // The SIMULATED feed ticks several times in 8 s; a frozen mark shows one value until the 20 s reconcile.
    expect(marks.size).toBeGreaterThan(1);
  });

  test('R5-06: the top bar marks the account figures as stale when the account endpoint fails', async ({ page }) => {
    await page.goto('/simulator');
    await expect(page.getByTestId('account-equity')).toContainText('USD');
    await expect(page.getByTestId('account-stale')).toHaveCount(0);
    await page.route('**/api/accounts/me', (r) => r.fulfill({ status: 503, body: '{}' }));
    await expect(page.getByTestId('account-stale')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('account-stale')).toContainText(/as of \d\d:\d\d:\d\d/);
    await page.unroute('**/api/accounts/me');
    await expect(page.getByTestId('account-stale')).toHaveCount(0, { timeout: 15_000 });
  });

  test('R5-03: the status bar robots count comes from the robots API (running / paused)', async ({ page }) => {
    await page.goto('/simulator');
    await expect(page.getByTestId('status-robots')).toHaveText('Robots: none');
    const s = await page.request.post('/api/strategies', { headers: CSRF, data: { definition: { ...TREND_X, name: 'R5-Trend' } } });
    expect(s.status()).toBe(201);
    const version = ((await s.json()) as { latest: { id: string } }).latest.id;
    const ids: string[] = [];
    for (const name of ['R5-A', 'R5-B']) {
      const r = await page.request.post('/api/robots', { headers: CSRF, data: { name, versionId: version } });
      expect(r.status()).toBe(201);
      ids.push(((await r.json()) as { id: string }).id);
    }
    for (const id of ids) expect((await page.request.post(`/api/robots/${id}/start`, { headers: CSRF })).status()).toBe(200);
    await page.reload();
    await expect(page.getByTestId('status-robots')).toHaveText('Robots: 2 running', { timeout: 20_000 });
    expect((await page.request.post(`/api/robots/${ids[1]}/pause`, { headers: CSRF, data: { reason: 'IRTC R5-03 check' } })).status()).toBe(200);
    await expect(page.getByTestId('status-robots')).toHaveText('Robots: 1 running · 1 paused', { timeout: 20_000 });
  });

  test('R5-11: Portfolio shows the real positions, equity and fills (no placeholder)', async ({ page }) => {
    const buy = await page.request.post('/api/orders', { headers: CSRF, data: { clientOrderId: `e2e-r5-11-${Date.now()}`, symbol: 'BTCUSD', side: 'buy', type: 'market', qty: '0.01' } });
    expect(buy.status()).toBe(201);
    await page.goto('/portfolio');
    await expect(page.locator('main')).not.toContainText('Arrives with');
    await expect(page.getByTestId('portfolio-equity')).toContainText('USD');
    await expect(page.getByTestId('portfolio-positions')).toContainText('BTC/USD');
    await expect(page.getByTestId('portfolio-fills')).toContainText('BTCUSD');
  });

  test('R5-13: the light theme keeps the Pro density and tabular mono numbers', async ({ page }) => {
    await setPrefs(page, { theme: 'novice-light' });
    await page.goto('/terminal?symbol=BTCUSD');
    const ks = page.getByTestId('kill-switch');
    await expect(ks).toBeVisible();
    expect((await ks.boundingBox())!.height).toBeLessThan(40);
    const font = await page.getByTestId('account-equity').evaluate((e) => getComputedStyle(e).fontFamily);
    expect(font).toMatch(/Plex Mono/);
  });

  test('R5-14: <summary> controls show the focus ring on the Pro dark theme', async ({ page }) => {
    await page.goto('/terminal?symbol=BTCUSD');
    const summary = page.locator('summary').first();
    await expect(summary).toBeVisible();
    await page.keyboard.press('Shift');
    await summary.focus();
    const ring = await summary.evaluate((e) => ({ style: getComputedStyle(e).outlineStyle, width: getComputedStyle(e).outlineWidth, color: getComputedStyle(e).outlineColor }));
    expect(ring).toEqual({ style: 'solid', width: '2px', color: 'rgb(242, 201, 76)' });
  });

  test('R5-15: the colour convention also recolours depth and flash surfaces; status colours stay independent', async ({ page }) => {
    await page.goto('/terminal?symbol=BTCUSD');
    await expect(page.getByTestId('status-bar')).toContainText('Connected');
    const read = () =>
      page.evaluate(() => {
        const root = document.querySelector('.k-root')!;
        const cs = getComputedStyle(root);
        const dot = document.querySelector('[data-testid=status-bar] [aria-hidden=true]')!;
        return { upSurface: cs.getPropertyValue('--k-up-surface').trim(), downSurface: cs.getPropertyValue('--k-down-surface').trim(), dot: getComputedStyle(dot).color };
      });
    const blue = await read();
    await setPrefs(page, { colourConvention: 'red_up_asia' });
    await page.reload();
    await expect(page.getByTestId('status-bar')).toContainText('Connected');
    const asia = await read();
    expect(asia.upSurface).not.toBe(blue.upSurface);
    expect(asia.downSurface).not.toBe(blue.downSurface);
    // "Connected" is a status, not a price direction: it must not turn red in the red-up convention.
    expect(asia.dot).toBe(blue.dot);
  });

  test('R5-09: Pro non-terminal pages reflow at 320 px (no horizontal scroll)', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 700 });
    for (const path of ['/settings', '/audit', '/portfolio']) {
      await page.goto(path);
      await expect(page.getByTestId('pro-topbar')).toBeVisible();
      await page.waitForTimeout(300);
      const w = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(w, path).toBeLessThanOrEqual(320);
    }
  });
});

test.describe('Novice view', () => {
  test('R5-10: Pro URLs in the simple view explain instead of rendering blank; a novice-only user in Pro is told the simple-view rules still apply', async ({ page }) => {
    await apiSignIn(page, 'novice');
    await page.goto('/terminal');
    await expect(page.getByTestId('pro-route-in-simple-view')).toBeVisible();
    await expect(page.locator('main')).not.toContainText('Order ticket');
    await page.goto('/home');
    await page.getByTestId('mode-toggle').getByRole('radio', { name: 'Pro' }).click();
    await expect(page).toHaveURL(/\/terminal\?.*switched=pro/);
    const note = page.getByTestId('what-changed');
    await expect(note).not.toContainText('Full order types, depth and robots are available');
    await expect(page.getByTestId('pro-safeguards')).toContainText('every new trade needs a stop loss');
    await page.getByTestId('pro-safeguards').getByRole('link').click();
    await expect(page).toHaveURL(/\/appropriateness\?from=pro/);
    await expect(page.getByTestId('pro-needs-assessment')).toBeVisible();
  });

  test('R5-08: amounts accept thousands separators per language and refuse ambiguous input', async ({ page }) => {
    await apiSignIn(page, 'novice');
    await page.goto('/home');
    const amount = page.getByTestId('trade-amount');
    await amount.fill('2,500');
    await amount.blur();
    await expect(amount).toHaveValue(/^2,?500\.00$/);
    await expect(page.getByTestId('amount-min')).toHaveCount(0);
    await amount.fill('2,50');
    await amount.blur();
    await expect(page.getByText(/Use a comma only between thousands/)).toBeVisible();
    await setFrench(page);
    await page.reload();
    await amount.fill('2 500,5');
    await amount.blur();
    await expect(amount).toHaveValue('2500,50');
  });

  test('R5-09: French novice pages reflow at 320 px', async ({ page }) => {
    await apiSignIn(page, 'novice');
    await setFrench(page);
    await page.setViewportSize({ width: 320, height: 700 });
    for (const path of ['/home', '/practice', '/settings']) {
      await page.goto(path);
      await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
      await page.waitForTimeout(500);
      const w = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(w, path).toBeLessThanOrEqual(320);
    }
  });

  test('R5-12: French novice: the assessment and page titles are in French; answer rows are 44 px targets', async ({ page }) => {
    await apiSignIn(page, 'novice');
    await setFrench(page);
    await page.goto('/home');
    await expect(page).toHaveTitle(/^Accueil/);
    await page.goto('/appropriateness');
    const form = page.getByTestId('appropriateness');
    await expect(form.getByRole('heading', { level: 1 })).not.toHaveText('Pro trading appropriateness assessment');
    await expect(form).toContainText('effet de levier');
    await expect(form).not.toContainText('Submit answers');
    const row = page.getByTestId('question-leverage').locator('label').first();
    expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  });

  test('R5-14/R5-16: the novice disclosure shows a marker; risk bars show the level in text with 3:1 segment contrast', async ({ page }) => {
    await apiSignIn(page, 'novice');
    await page.goto('/home');
    const card = page.getByTestId('auto-invest-card');
    await expect(card.getByText(/Risk level \d of 5/).first()).toBeVisible();
    const seg = await card.locator('[role=img] > span').last().evaluate((e) => {
      const cs = getComputedStyle(e);
      const panel = getComputedStyle(e.closest('.k-panel')!).backgroundColor;
      return { border: cs.borderTopColor, borderWidth: cs.borderTopWidth, bg: cs.backgroundColor, panel };
    });
    const edge = seg.borderWidth !== '0px' ? seg.border : seg.bg;
    expect(contrast(edge, seg.panel)).toBeGreaterThanOrEqual(3);
    await page.goto('/auto-invest');
    await expect(page.locator('summary').first()).toContainText('▸');
  });

  test('R5-15: novice loss and risk colours do not follow the up/down convention (a loss never turns green)', async ({ page }) => {
    await apiSignIn(page, 'novice');
    await page.goto('/home');
    const risk = () => page.getByTestId('auto-invest-card').locator('[role=img] > span').first().evaluate((e) => getComputedStyle(e).backgroundColor);
    const blue = await risk();
    await setPrefs(page, { colourConvention: 'red_up_asia' });
    await page.reload();
    expect(await risk()).toBe(blue);
    expect(blue).not.toBe('rgb(26, 127, 55)');
  });
});

test.describe('Low findings', () => {
  test('R5-18: the chart draws even when the browser reports an invalid language tag', async ({ page }) => {
    await apiSignIn(page, 'trader');
    await page.addInitScript(() => Object.defineProperty(navigator, 'language', { get: () => 'en-US@posix' }));
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/terminal?symbol=BTCUSD');
    await expect(page.locator('.ch-canvas canvas').first()).toBeVisible();
    await page.waitForTimeout(3000);
    expect(errors.filter((m) => /Invalid language tag/.test(m))).toEqual([]);
  });

  test('R5-21: ticket and chart toolbar targets are at least 24 px', async ({ page }) => {
    await apiSignIn(page, 'trader');
    await page.goto('/terminal?symbol=BTCUSD');
    const ticket = page.getByTestId('order-ticket');
    await expect(ticket.getByRole('radio', { name: 'Market', exact: true })).toBeVisible();
    const heights = await page.evaluate(() =>
      [...document.querySelectorAll('.tk-type, .ch-tf, .tk-check label, .ch-menu > summary, .wl-tool')].map((e) => [e.className || e.tagName, Math.round(e.getBoundingClientRect().height)] as const),
    );
    expect(heights.length).toBeGreaterThan(5);
    expect(heights.filter(([, h]) => h > 0 && h < 24)).toEqual([]);
  });

  test('R5-22: Market Radar never shows dangling "Movers:" labels', async ({ page }) => {
    await apiSignIn(page, 'trader');
    await page.goto('/radar');
    await expect(page.getByTestId('market-radar')).toBeVisible();
    await page.waitForTimeout(1500);
    const movers = page.getByTestId('radar-movers');
    if ((await movers.count()) > 0) expect(await movers.getByRole('button').count()).toBeGreaterThan(0);
    else if ((await page.getByTestId('radar-trend').count()) === 0) await expect(page.getByTestId('radar-empty')).toContainText(/next around \d\d:\d\d UTC/);
  });

  test('R5-25: a risk officer who prefers the simple view still gets the risk console in the Pro shell', async ({ page }) => {
    const { email, secret } = await apiSignIn(page, 'trader');
    await db(`INSERT INTO user_roles (user_id, role) SELECT id, 'risk_officer' FROM users WHERE email = $1 ON CONFLICT DO NOTHING`, [email]);
    const login = await (await page.request.post('/api/auth/login', { headers: CSRF, data: { email, password: PASSWORD } })).json();
    expect((await page.request.post('/api/auth/mfa/verify', { headers: CSRF, data: { mfaToken: login.mfaToken, code: totp(secret!, 1) } })).status()).toBe(200);
    await setPrefs(page, { viewMode: 'novice' });
    await page.goto('/risk');
    await expect(page.getByTestId('pro-topbar')).toBeVisible();
    await expect(page.getByTestId('novice-topbar')).toHaveCount(0);
  });

  test('R5-26: phones keep the practice-money chip; the light theme is on <html> from the server render', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await apiSignIn(page, 'novice');
    await page.goto('/home');
    await expect(page.getByTestId('env-chip')).toBeVisible();
    await expect(page.getByTestId('env-chip')).toContainText('Practice');
    // The next server render already carries the light theme on <html> (no dark paint before hydration).
    const html = await (await page.request.get('/home')).text();
    expect(html).toMatch(/<html[^>]*data-theme="novice-light"/);
  });
});

// Goal 10 (S1): WCAG 2.2 AA axe pass on every route for the role(s) that can open it, a
// keyboard-only walkthrough of the shell, and the colour-convention setting. Results feed
// docs/qa/a11y.md. Deeper per-screen scans stay in the module specs (terminal, novice, robots…).
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import pg from 'pg';

import { apiOnboard, apiSignIn, PASSWORD, totp } from './helpers';

const CSRF = { 'x-kora-csrf': '1' };
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function scan(page: Page, name: string): Promise<void> {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  const res = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const serious = res.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  const report = serious.map(
    (v) => `${name}: ${v.id} (${v.impact}) ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`,
  );
  expect(report, report.join('\n')).toEqual([]);
  expect(
    res.violations
      .filter((v) => v.id === 'color-contrast')
      .map((v) => `${name}: ${v.nodes.length} contrast`),
  ).toEqual([]);
}

async function visit(
  page: Page,
  path: string,
  ready: (p: Page) => Promise<void> = async () => undefined,
): Promise<void> {
  const res = await page.goto(path);
  expect(res?.status() ?? 200, `${path} answers`).toBeLessThan(500);
  await ready(page);
  await scan(page, path);
}

async function grant(req: APIRequestContext, email: string, role: string): Promise<void> {
  const url = process.env.DATABASE_URL_MIGRATE_E2E;
  if (!url) throw new Error('DATABASE_URL_MIGRATE_E2E is not set');
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query(
      `INSERT INTO user_roles (user_id, role) SELECT id, $2 FROM users WHERE email = $1 ON CONFLICT DO NOTHING`,
      [email, role],
    );
  } finally {
    await c.end();
  }
  const login = await (
    await req.post('/api/auth/login', { headers: CSRF, data: { email, password: PASSWORD } })
  ).json();
  const enr = await (
    await req.post('/api/auth/mfa/enroll', { headers: CSRF, data: { mfaToken: login.mfaToken } })
  ).json();
  expect(
    (
      await req.post('/api/auth/mfa/verify', {
        headers: CSRF,
        data: { mfaToken: login.mfaToken, code: totp(enr.secret) },
      })
    ).status(),
  ).toBe(200);
}

test('public routes pass axe: login, sign-up, reliability, offline', async ({ page }) => {
  for (const path of ['/login', '/signup', '/reliability', '/offline']) await visit(page, path);
});

test('every novice route passes axe (novice-light): onboarding, home, practice, learn, lesson, check, auto-invest, portfolio, settings, appropriateness, forbidden', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await apiSignIn(page, 'novice', { onboarded: false });
  await visit(page, '/onboarding');
  await apiOnboard(page.request);
  for (const path of [
    '/home',
    '/practice',
    '/learn',
    '/learn/trading',
    '/learn/check',
    '/auto-invest',
    '/portfolio',
    '/settings',
    '/appropriateness',
  ])
    await visit(page, path);
  await visit(page, '/robots/builder'); // friendly 403 page
});

test('every Pro route passes axe (pro-dark): terminal, robots, builder, simulator, radar, audit, portfolio, settings', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await apiSignIn(page, 'trader');
  await visit(page, '/terminal', async (p) =>
    expect(p.getByTestId('status-bar')).toContainText('Connected'),
  );
  for (const path of [
    '/robots',
    '/robots/builder',
    '/simulator',
    '/radar',
    '/audit',
    '/portfolio',
    '/settings',
  ])
    await visit(page, path);
});

test('second- and third-line routes pass axe: risk console (risk officer) and internal audit (auditor)', async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const ro = await apiSignIn(page, 'novice');
  await grant(page.request, ro.email, 'risk_officer');
  await visit(page, '/risk', async (p) => expect(p.getByTestId('risk-console')).toBeVisible());
  const ctx = await browser.newContext();
  const p2 = await ctx.newPage();
  const au = await apiSignIn(p2, 'novice');
  await grant(p2.request, au.email, 'auditor');
  await visit(p2, '/internal-audit');
  await ctx.close();
});

test('keyboard-only walkthrough: skip link, visible focus, kill switch and palette open and close from the keyboard with focus returned', async ({
  page,
}) => {
  await apiSignIn(page, 'trader');
  await page.goto('/terminal');
  await expect(page.getByTestId('status-bar')).toContainText('Connected');
  // 1. the first Tab stop is the skip link, and it moves focus to <main>
  await page.keyboard.press('Tab');
  const first = page.locator(':focus');
  await expect(first).toHaveText('Skip to content');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#main$/);
  // 2. every focusable control in the top bar shows a visible focus indicator
  const tops = page.getByTestId('pro-topbar').locator('button, a, [tabindex="0"]');
  const count = await tops.count();
  expect(count).toBeGreaterThan(3);
  for (let i = 0; i < count; i++) {
    const el = tops.nth(i);
    if (!(await el.isVisible())) continue;
    await el.focus();
    const ring = await el.evaluate((e) => {
      const s = getComputedStyle(e);
      return (s.outlineStyle !== 'none' && s.outlineWidth !== '0px') || s.boxShadow !== 'none';
    });
    expect(
      ring,
      `focus ring on ${(await el.getAttribute('data-testid')) ?? (await el.textContent())}`,
    ).toBe(true);
  }
  // 3. the kill switch opens with a 1.5 s Space hold and Escape closes it, focus back on the button
  const ks = page.getByTestId('kill-switch');
  await ks.focus();
  await page.keyboard.down(' ');
  await page.waitForTimeout(1650);
  await page.keyboard.up(' ');
  await expect(page.getByTestId('kill-switch-menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('kill-switch-menu')).toBeHidden();
  await expect(ks).toBeFocused();
  // 4. the ⌘K palette opens from the keyboard and Escape closes it
  await page.locator('main').focus();
  await page.keyboard.press('Control+k');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(':focus')).toHaveCount(1); // focus moved into the dialog
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('colour convention: blue/orange by default, the setting switches the tokens, and ▲▼ always accompany direction', async ({
  page,
}) => {
  await apiSignIn(page, 'trader');
  await page.goto('/terminal');
  await expect(page.getByTestId('status-bar')).toContainText('Connected');
  const up = () =>
    page.evaluate(() =>
      getComputedStyle(document.querySelector('[data-colors]')!)
        .getPropertyValue('--k-up')
        .trim()
        .toUpperCase(),
    );
  const down = () =>
    page.evaluate(() =>
      getComputedStyle(document.querySelector('[data-colors]')!)
        .getPropertyValue('--k-down')
        .trim()
        .toUpperCase(),
    );
  expect(await up()).toBe('#4DA3FF');
  expect(await down()).toBe('#FF9F40');
  // direction is never colour alone: the watchlist change column carries ▲ or ▼
  await expect(page.getByTestId('watchlist').getByText(/[▲▼]/).first()).toBeVisible({
    timeout: 15_000,
  });
  for (const [conv, u, d] of [
    ['green_red', '#3FB950', '#FF6B6B'],
    ['red_up_asia', '#FF6B6B', '#3FB950'],
    ['blue_orange', '#4DA3FF', '#FF9F40'],
  ] as const) {
    expect(
      (
        await page.request.put('/api/me/preferences', {
          headers: CSRF,
          data: { colourConvention: conv },
        })
      ).status(),
    ).toBe(200);
    await page.reload();
    await expect(page.locator(`[data-colors="${conv}"]`).first()).toBeAttached();
    expect(await up()).toBe(u);
    expect(await down()).toBe(d);
  }
});

test('screen-reader spot checks: landmarks, names and live regions on the terminal and the novice home', async ({
  page,
  browser,
}) => {
  // What a screen reader announces comes from the accessibility tree: check it, not pixels.
  await apiSignIn(page, 'trader');
  await page.goto('/terminal');
  await expect(page.getByTestId('status-bar')).toContainText('Connected');
  await expect(page.getByRole('main')).toHaveCount(1);
  await expect(page.getByRole('banner').first()).toBeVisible();
  // the kill switch is a named button, never an icon-only control
  await expect(page.getByTestId('kill-switch')).toHaveAccessibleName(/kill switch/i);
  // connection state is announced politely; the ticket preview is summarised in its own polite status,
  // once per settled edit (IRTC R5-05: the figures themselves are not a live region, they change every tick)
  await expect(
    page.getByTestId('status-bar').locator('[role="status"][aria-live="polite"]'),
  ).toHaveCount(1);
  await expect(page.getByTestId('ticket-announce')).toHaveAttribute('aria-live', 'polite');
  await expect(page.getByTestId('ticket-preview')).not.toHaveAttribute('aria-live', /.+/);
  // every button in the top bar has an accessible name
  const unnamed = await page
    .getByTestId('pro-topbar')
    .getByRole('button')
    .evaluateAll(
      (els) =>
        els.filter(
          (e) =>
            !(
              e.getAttribute('aria-label') ||
              e.textContent?.trim() ||
              e.getAttribute('aria-labelledby')
            ),
        ).length,
    );
  expect(unnamed).toBe(0);

  const ctx = await browser.newContext();
  const novice = await ctx.newPage();
  await apiSignIn(novice, 'novice');
  await novice.goto('/home');
  await expect(novice.getByRole('main')).toHaveCount(1);
  await expect(novice.getByRole('navigation').first()).toBeVisible();
  // the practice-money chip is announced as a status, not only shown as colour
  await expect(novice.getByTestId('env-chip')).toHaveAttribute('role', 'status');
  const h1 = await novice.getByRole('heading', { level: 1 }).count();
  expect(h1).toBeGreaterThanOrEqual(1);
  await ctx.close();
});

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';

import { apiSignIn, PASSWORD, totp } from './helpers';

/**
 * Goal 07B Market Radar flow through the real web + api + quant (scripted provider, SIMULATED data):
 * filter by region → open a trend → drivers and cited news → Draft to ticket → the ticket is
 * pre-filled and placing still needs the preview + confirmation. Plus the public reliability page.
 */
const CSRF = { 'x-kora-csrf': '1' };
const H = 3_600_000;
const N = 700;

async function db<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
  const url = process.env.DATABASE_URL_MIGRATE_E2E;
  if (!url) throw new Error('DATABASE_URL_MIGRATE_E2E is not set');
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query(sql, params)).rows as T[];
  } finally {
    await c.end();
  }
}

/** Deterministic SIMULATED 1h history (xorshift random walk), with an optional steady rise at the end. */
async function seed1h(
  symbol: string,
  start: number,
  vol: number,
  rise: number,
  seed: number,
  decimals: number,
): Promise<void> {
  const t0 = Math.floor(Date.now() / H) * H - N * H;
  let x = seed;
  const rnd = () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return ((x >>> 0) % 1_000_000) / 1_000_000;
  };
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-9)) * Math.cos(2 * Math.PI * rnd());
  const rows: Array<[number, string, string, string, string]> = [];
  let c = start;
  for (let i = 0; i < N; i++) {
    const o = c;
    const up = i >= N - rise;
    c = o * Math.exp((up ? vol * 0.9 : 0) + vol * (up ? 0.2 : 1) * gauss());
    rows.push([
      t0 + i * H,
      o.toFixed(decimals),
      (Math.max(o, c) * (1 + vol * 0.3 * rnd())).toFixed(decimals),
      (Math.min(o, c) * (1 - vol * 0.3 * rnd())).toFixed(decimals),
      c.toFixed(decimals),
    ]);
  }
  await db("DELETE FROM md_candles_history WHERE symbol = $1 AND tf = '1h'", [symbol]);
  await db(
    `INSERT INTO md_candles_history (symbol, tf, bucket, open, high, low, close, volume, trades, source)
     SELECT $1, '1h', to_timestamp(b / 1000.0), o, h, l, c, 1, 1, 'e2e-simulated'
     FROM unnest($2::bigint[], $3::numeric[], $4::numeric[], $5::numeric[], $6::numeric[]) AS x(b, o, h, l, c)
     ON CONFLICT (symbol, tf, bucket) DO UPDATE SET open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low, close = EXCLUDED.close`,
    [
      symbol,
      rows.map((r) => r[0]),
      rows.map((r) => r[1]),
      rows.map((r) => r[2]),
      rows.map((r) => r[3]),
      rows.map((r) => r[4]),
    ],
  );
}

/** Grants an extra role in the database, then logs in again (the new token carries it). */
async function grantAndRelogin(
  page: Page,
  email: string,
  secret: string,
  role: string,
): Promise<void> {
  await db(
    `INSERT INTO user_roles (user_id, role) SELECT id, $2 FROM users WHERE email = $1 ON CONFLICT DO NOTHING`,
    [email, role],
  );
  const login = await (
    await page.request.post('/api/auth/login', {
      headers: CSRF,
      data: { email, password: PASSWORD },
    })
  ).json();
  expect(login.status).toBe('mfa_required');
  const v = await page.request.post('/api/auth/mfa/verify', {
    headers: CSRF,
    data: { mfaToken: login.mfaToken, code: totp(secret, 1) },
  });
  expect(v.status()).toBe(200);
}

test('Market Radar: filter by region → open a trend → drivers and news → Draft to ticket → preview and confirmation still required', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { email, secret } = await apiSignIn(page, 'trader');
  await grantAndRelogin(page, email, secret!, 'quant');

  // A small SIMULATED global universe with 700 one-hour bars each (planted rises on two of them).
  await seed1h('7203.XTKS', 2800, 0.004, 60, 11, 1);
  await seed1h('0700.XHKG', 380, 0.005, 0, 23, 1);
  await seed1h('SAP.XETR', 190, 0.004, 0, 37, 2);
  await seed1h('BHP.XASX', 45, 0.005, 0, 41, 2);
  // ETH/USD trades 24/7 in the SIMULATED feed (the robot specs own the BTCUSD history).
  const q = (
    (await (await page.request.get('/api/quotes?symbols=ETHUSD')).json()) as {
      quotes: Array<{ quote: { bid: string; ask: string } | null }>;
    }
  ).quotes[0]!.quote;
  const eth = q ? (Number(q.bid) + Number(q.ask)) / 2 : 3000;
  await seed1h('ETHUSD', eth * 0.9, 0.003, 60, 53, 2);

  const scan = await page.request.post('/api/intel/scan', { headers: CSRF, timeout: 120_000 });
  expect(scan.status()).toBe(200);
  expect((await scan.json()).guard.passed).toBe(true);
  const news = await page.request.post('/api/intel/news/ingest', {
    headers: CSRF,
    data: { adapter: 'simulated' },
  });
  expect(news.status()).toBe(200);
  expect(
    (
      await page.request.put('/api/accounts/me/settings', {
        headers: CSRF,
        data: { confirmMode: 'always' },
      })
    ).status(),
  ).toBe(200);

  await page.goto('/radar');
  const radar = page.getByTestId('market-radar');
  await expect(radar.getByRole('heading', { name: 'Market Radar' })).toBeVisible({
    timeout: 20_000,
  });
  await expect(radar.getByTestId('heat-cell').first()).toBeVisible();

  // 1. Filter by region → open a trend → drivers and cited news.
  await radar.getByTestId('radar-region').selectOption('asia');
  const toyota = radar.locator('[data-testid="radar-trend"][data-symbol="7203.XTKS"]');
  await expect(toyota).toBeVisible({ timeout: 15_000 });
  await expect(radar.getByTestId('radar-trend')).not.toContainText(['SAP.XETR']);
  await toyota.click();
  const card = page.getByTestId('trend-card');
  await expect(card.getByRole('heading', { name: /Toyota Motor Corporation/ })).toBeVisible({
    timeout: 15_000,
  });
  await expect(card.getByTestId('trend-no-signal')).toHaveText('No reliable signal');
  await expect(card.getByTestId('driver-row').first()).toBeVisible();
  await expect(card.getByTestId('trend-news-item').first()).toContainText(/SIMULATED/);
  await expect(card.getByTestId('trend-invalidation')).toContainText('would invalidate this view');
  await expect(card).toContainText('Not investment advice.');
  await card.getByTestId('trend-explain').click();
  await expect(card.getByTestId('trend-summary')).toContainText(/\[news:[0-9a-f-]{36}\]/, {
    timeout: 15_000,
  });
  if (process.env.E2E_SHOTS)
    await page.screenshot({ path: 'test-results/market-radar.png', fullPage: true });

  const axe = await new AxeBuilder({ page })
    .include('[data-testid="market-radar"]')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  const serious = axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(
    serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
  ).toEqual([]);

  // 2. A tradable instrument (24/7 SIMULATED crypto): Draft to ticket.
  await radar.getByTestId('radar-region').selectOption('global');
  const ethRow = radar.locator('[data-testid="radar-trend"][data-symbol="ETHUSD"]');
  await expect(ethRow).toBeVisible({ timeout: 15_000 });
  await ethRow.click();
  await expect(card.getByRole('heading', { name: /ETHUSD/ })).toBeVisible({ timeout: 15_000 });
  const before = (await (await page.request.get('/api/orders?status=all')).json()) as {
    orders: unknown[];
  };
  expect(before.orders).toHaveLength(0);
  await card.getByTestId('trend-draft').click();

  await expect(page).toHaveURL(/\/terminal\?symbol=ETHUSD&aiDraft=[0-9a-f-]{36}/, {
    timeout: 20_000,
  });
  const ticket = page.getByTestId('order-ticket');
  await expect(ticket).toBeVisible({ timeout: 20_000 });
  await expect(ticket.getByTestId('ticket-note')).toContainText('AI draft', { timeout: 15_000 });
  await expect(ticket.getByTestId('ticket-note')).toContainText('Market Radar');
  await expect(ticket.getByTestId('ticket-qty')).not.toHaveValue('');
  expect(
    ((await (await page.request.get('/api/orders?status=all')).json()) as { orders: unknown[] })
      .orders,
  ).toHaveLength(0);

  // Placing still goes through the normal review → confirmation dialog.
  await ticket.getByTestId('place-order').click();
  const confirm = page.getByTestId('confirm-order');
  await expect(confirm).toBeVisible();
  const hold = confirm.getByTestId('confirm-hold');
  if (await hold.count()) {
    await hold.focus();
    await page.keyboard.down('Space');
    await page.waitForTimeout(800);
    await page.keyboard.up('Space');
  } else {
    await confirm.getByTestId('confirm-place').click();
  }
  await expect(ticket.getByTestId('ticket-result')).toContainText(
    /Order (filled|working|accepted|rejected|pending)/i,
    { timeout: 15_000 },
  );
  const after = (await (await page.request.get('/api/orders?status=all')).json()) as {
    orders: Array<{ source: string }>;
  };
  expect(after.orders.length).toBeGreaterThan(0);
  expect(after.orders.every((o) => o.source === 'ai-draft-accepted')).toBe(true);
  const drafts = await db<{ surface: string }>(
    `SELECT d.surface FROM ai_order_drafts d JOIN users u ON u.id = d.user_id WHERE u.email = $1`,
    [email],
  );
  expect(drafts.map((d) => d.surface)).toEqual(['radar']);
});

test('the reliability page is public and shows the track record per model and region', async ({
  browser,
}) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto('/reliability');
  await expect(page.getByRole('heading', { name: 'Forecast reliability' })).toBeVisible();
  await expect(page.getByTestId('reliability-page')).toContainText('SIMULATED');
  await expect(page.getByTestId('reliability-model').first()).toBeVisible();
  await expect(page.getByTestId('reliability-page')).toContainText('Not investment advice.');
  await ctx.close();
});

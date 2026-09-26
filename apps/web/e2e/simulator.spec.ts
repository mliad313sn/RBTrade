import { readFile } from 'node:fs/promises';

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';

import { apiSignIn } from './helpers';

/** Sets a native range input the way a user drag would (input + change events). */
async function setRange(slider: Locator, value: number) {
  await slider.evaluate((el, v) => {
    const input = el as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      input,
      String(v),
    );
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

const kpi = async (page: Page, id: string) =>
  Number(await page.getByTestId(id).getAttribute('data-value'));

test.beforeEach(async ({ page }) => {
  await apiSignIn(page, 'trader');
  await page.goto('/simulator');
  await expect(page.getByRole('heading', { name: 'Gain Simulator' })).toBeVisible();
  await expect(page.getByTestId('simulated-chip')).toHaveText('SIMULATED');
});

test('assumptions → project → stress lowers the median → import paper (fixture) → compare A/B → export CSV', async ({
  page,
}) => {
  // 1. Set assumptions
  const capital = page.getByTestId('starting-capital');
  await capital.fill('25000');
  await setRange(page.getByTestId('win-rate'), 50);
  await setRange(page.getByTestId('avg-win'), 1.6);
  await setRange(page.getByTestId('costs'), 0.1);
  await setRange(page.getByTestId('horizon'), 12);
  await page.getByTestId('trades-per-month').focus();
  await page.keyboard.press('ArrowLeft'); // 20 → 19 by keyboard, like a user
  await expect(page.getByTestId('trades-per-month')).toHaveValue('19');

  // 2. Project
  const run = page.waitForResponse(
    (r) => r.url().endsWith('/api/sim/project') && r.request().method() === 'POST',
  );
  await page.getByTestId('run-projection').click();
  const body = await (await run).json();
  expect(body).toMatchObject({
    simulated: true,
    paths: 10_000,
    tradesPerPath: 19 * 12,
    startingCapital: 25_000,
  });
  await expect(page.getByTestId('fan-chart')).toBeVisible();
  await expect(page.getByTestId('simulated-watermark')).toHaveText('SIMULATED');
  await expect(page.getByTestId('fan-chart').locator('[data-series="sample"]')).toHaveCount(3);
  await expect(page.getByTestId('fan-chart').locator('[data-series="ruin"]')).toHaveCount(1);
  await expect(page.getByTestId('kpi-tiles').locator('[data-testid^="kpi-"]')).toHaveCount(5);
  await expect(page.getByTestId('drawdown-histogram')).toBeVisible();
  await expect(page.getByTestId('risk-table')).toContainText('Kelly fraction');
  // expectancy after costs: 0.5·1.6 − 0.5·(1 + 0.03·2) − 0.10 = 0.17 R (fat tails on by default)
  expect(await kpi(page, 'kpi-expectancy')).toBeCloseTo(0.17, 6);
  const median = await kpi(page, 'kpi-median');
  expect(median).toBe(body.finalEquity.p50);

  // 3. Pin as A, then the stress toggle re-runs and the median must drop
  await page.getByTestId('pin-a').click();
  await page.getByTestId('toggle-stress').check();
  await expect.poll(() => kpi(page, 'kpi-median')).toBeLessThan(median);
  const stressedMedian = await kpi(page, 'kpi-median');
  await expect(page.getByTestId('compare-table')).toBeVisible();
  await expect(page.getByTestId('fan-chart').locator('[data-series="compare"]')).toHaveCount(1);

  // 4. Import from paper account (SIMULATED fixture until goal 03)
  await page.getByTestId('import-paper').click();
  await expect(page.getByTestId('paper-card')).toBeVisible();
  await expect(page.getByTestId('paper-source')).toContainText('SIMULATED');
  await expect(page.getByTestId('paper-card')).toContainText('Profit factor');
  await expect(
    page.getByRole('heading', { name: /Paper results · block bootstrap/ }),
  ).toBeVisible();
  await expect(page.locator('[data-code="small_sample"]')).toBeVisible();

  // 5. Compare scenarios: A (assumptions) vs B (paper)
  const table = page.getByTestId('compare-table');
  await expect(table).toContainText('A · assumptions');
  await expect(table).toContainText('B · paper');
  await expect(table.getByRole('row')).toHaveCount(8);
  expect(await kpi(page, 'kpi-median')).not.toBe(stressedMedian);

  // 6. Export CSV
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('export-csv').click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^kora-simulation-[0-9a-f]{8}\.csv$/);
  const csv = await readFile((await download.path())!, 'utf8');
  expect(csv).toContain('SIMULATED');
  expect(csv).toContain('section,metric,A,B');
  expect(csv).toContain('assumption,origin,assumptions,paper');
  expect(csv).toContain('assumption,stress_edge_cut_pct,0,'); // A was pinned before the stress toggle; B (paper) has none
  expect(csv).toMatch(/kpi,final_equity_p50,[\d.]+,[\d.]+/);
  expect(csv).toContain('period,A_p5,A_p25,A_p50,A_p75,A_p95,B_p5');

  // Every run is in the audit log
  const audit = await (await page.request.get('/api/audit?action=sim.*')).json();
  const actions = (audit.events as { action: string }[]).map((e) => e.action);
  expect(actions.filter((a) => a === 'sim.projection_run').length).toBeGreaterThanOrEqual(2);
  expect(actions).toContain('sim.paper_projection_run');
});

test('PNG export carries the chart and its SIMULATED watermark', async ({ page }) => {
  await page.getByTestId('run-projection').click();
  await expect(page.getByTestId('fan-chart')).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('export-png').click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.png$/);
  const png = await readFile((await download.path())!);
  expect(png.subarray(1, 4).toString('ascii')).toBe('PNG');
  expect(png.length).toBeGreaterThan(10_000);
});

test('import from backtest names goal 06; reality checks flag an implausible, oversized edge', async ({
  page,
}) => {
  const backtest = page.getByTestId('import-backtest');
  await expect(backtest).toHaveAttribute('aria-disabled', 'true'); // announced as unavailable
  await backtest.click({ force: true }); // still explains why when pressed
  await expect(page.getByTestId('sim-note')).toContainText('goal 06');
  await setRange(page.getByTestId('win-rate'), 65);
  await setRange(page.getByTestId('avg-win'), 2.5);
  await setRange(page.getByTestId('risk-pct'), 3);
  await page.getByTestId('run-projection').click();
  await expect(page.locator('[data-code="implausible_edge"]')).toHaveAttribute(
    'data-severity',
    'critical',
  );
  await expect(page.locator('[data-code="risk_above_2pct"]')).toBeVisible();
  await setRange(page.getByTestId('win-rate'), 40);
  await expect(page.getByTestId('stale-note')).toBeVisible();
});

test('the simulator passes axe (pro-dark) with results on screen', async ({ page }) => {
  await page.getByTestId('run-projection').click();
  await expect(page.getByTestId('kpi-median')).toBeVisible();
  const res = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const serious = res.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(
    serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
  ).toEqual([]);
});

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

import { apiSignIn } from './helpers';
import { seedHistory } from './seed-history';

async function drop(page: Page, block: string, row: string) {
  await page.getByTestId(`block-${block}`).dragTo(page.getByTestId(`row-${row}`));
}

test.beforeAll(async () => {
  await seedHistory();
});

test('builds Trend-X from blocks → backtests → heatmap → walk-forward → Monte Carlo → paper-run → pause → edit params (new hash) → audit trail', async ({
  page,
}) => {
  test.setTimeout(150_000);
  await apiSignIn(page, 'trader');
  await page.goto('/robots/builder');
  await expect(page.getByTestId('validation-state')).toContainText('error'); // a blank strategy has no entry yet

  // Build Trend-X (prototype chips) by dragging blocks onto the rows.
  await page.getByTestId('strategy-name-input').fill('Trend-X');
  await drop(page, 'ema_cross_up', 'entry');
  await drop(page, 'adx_above', 'entry');
  await drop(page, 'ai_regime', 'entry');
  await drop(page, 'no_event', 'filter');
  await drop(page, 'target_atr', 'exit');
  await drop(page, 'trail_after_r', 'exit');
  await drop(page, 'risk_pct', 'size');
  await page.getByTestId('max-open').fill('3');
  const chips = page.getByTestId('block-chips');
  await expect(chips).toContainText('EMA 20 crosses above EMA 50');
  await expect(chips).toContainText('ADX 14 > 22');
  await expect(chips).toContainText('AI regime = trending (p > 0.6)');
  await expect(chips).toContainText('No high-impact event within 60 min');
  await expect(chips).toContainText('Stop 1.5 × ATR(14)');
  await expect(chips).toContainText('Target 3 × ATR');
  await expect(chips).toContainText('Trail after 1R');
  await expect(chips).toContainText('Risk 0.75% equity / trade · max 3 open');
  // Inline parameter editing, then the JSON view for quants.
  await page.getByTestId('chip-entry-0').click();
  await page.getByTestId('param-fast').fill('10');
  await page.getByTestId('param-slow').fill('30');
  await expect(chips).toContainText('EMA 10 crosses above EMA 30');
  await expect(page.getByTestId('validation-state')).toContainText('Valid');
  await expect(page.getByTestId('validation')).toContainText('goal 07'); // AI regime is "not available" until goal 07
  await page.getByRole('tab', { name: 'View as JSON' }).click();
  await expect(page.getByTestId('json-editor')).toHaveValue(/"schema": "kora.strategy"/);
  await page.getByRole('tab', { name: 'Blocks' }).click();
  await page.getByTestId('save-strategy').click();

  // Monitor: backtest with IS/OOS, overfitting checks.
  await expect(page).toHaveURL(/\/robots\?strategy=/);
  await expect(page.getByTestId('strategy-name')).toHaveText('Trend-X');
  const v1 = (await page.getByTestId('version-hash').textContent())!;
  expect(v1).toMatch(/v1 · params #[0-9a-f]{6}/);
  await page.getByTestId('run-backtest').click();
  await expect(page.getByTestId('equity-chart')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('kpi-table')).toContainText('Sharpe');
  await expect(page.getByTestId('trials')).toHaveText('1');
  await expect(page.getByTestId('bt-warnings')).toContainText('out-of-sample trades');

  // Sensitivity heatmap over two parameters.
  await page.getByTestId('heat-y').selectOption('slow');
  await page.getByTestId('heat-x').selectOption('fast');
  await page.getByTestId('run-heatmap').click();
  await expect(page.getByTestId('heatmap')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('trials')).not.toHaveText('1');

  // Walk-forward.
  await page.getByTestId('run-wf').click();
  await expect(page.getByTestId('wf-folds')).toBeVisible({ timeout: 30_000 });

  // Send the OOS trades to Monte Carlo (goal 05 /sim/from-trades).
  await page.getByTestId('send-mc').click();
  await expect(page.getByTestId('mc-result')).toContainText('P5 / P50 / P95', { timeout: 30_000 });

  // Paper-run through the bot runner (heartbeat), then pause.
  await page.getByTestId('paper-run').click();
  await expect(page).toHaveURL(/\/robots\?robot=/);
  await expect(page.getByTestId('robot-state')).toContainText('RUNNING');
  await expect(page.getByTestId('heartbeat')).toContainText('●', { timeout: 20_000 });
  await expect(page.getByTestId('promotion')).toContainText('Out-of-sample Sharpe');
  await page.getByTestId('pause-robot').click();
  await expect(page.getByTestId('robot-state')).toContainText('PAUSED');

  // Edit params in the builder → a new immutable version with a new hash.
  await page.getByTestId('edit-builder').click();
  await expect(page).toHaveURL(/\/robots\/builder\?strategy=/);
  await expect(page.getByTestId('block-chips')).toContainText('Stop 1.5 × ATR(14)');
  await page.getByTestId('chip-stop-0').click();
  await page.getByTestId('param-stop_atr').fill('1.4');
  await expect(page.getByTestId('block-chips')).toContainText('Stop 1.4 × ATR(14)');
  await page.getByTestId('version-reason').fill('ATR stop 1.5 → 1.4');
  await page.getByTestId('save-strategy').click();
  await expect(page).toHaveURL(/\/robots\?robot=/);
  await expect(page.getByTestId('new-version-banner')).toContainText('v2');
  await page.getByTestId('switch-version').click();
  await expect(page.getByTestId('version-hash')).toContainText('v2 · params #');
  const v2 = (await page.getByTestId('version-hash').textContent())!;
  expect(v2.slice(-6)).not.toBe(v1.slice(-6));

  // The audit trail shows the parameter change, the version switch, the paper run and the pause.
  const feed = page.getByTestId('audit-feed');
  await expect(feed).toContainText('v2 #');
  await expect(feed).toContainText('stop_atr 1.5 → 1.4');
  await expect(feed).toContainText('Started (PAPER)');
  await expect(feed).toContainText('Paused');
  await expect(feed).toContainText('robot.version_changed');
});

test('the simulator imports the latest backtest (B-502)', async ({ page }) => {
  await apiSignIn(page, 'trader');
  // Build and backtest through the API (the UI flow is covered above).
  const tmpl = await (await page.request.get('/api/strategy-templates')).json();
  const def = {
    ...tmpl.templates[0].definition,
    universe: { symbols: ['BTCUSD'], timeframe: '1h' },
    filters: [],
  };
  const s = await page.request.post('/api/strategies', {
    headers: { 'x-kora-csrf': '1' },
    data: { definition: def },
  });
  expect(s.status()).toBe(201);
  const bt = await page.request.post('/api/backtests', {
    headers: { 'x-kora-csrf': '1' },
    data: { versionId: (await s.json()).latest.id },
  });
  expect(bt.status()).toBe(201);
  await page.goto('/simulator');
  await page.getByTestId('import-backtest').click();
  await expect(page.getByTestId('sim-note')).toContainText('out-of-sample backtest trades');
});

test('the robot builder and monitor pass axe (pro-dark, contrast included)', async ({ page }) => {
  await apiSignIn(page, 'trader');
  const tmpl = await (await page.request.get('/api/strategy-templates')).json();
  const def = {
    ...tmpl.templates[0].definition,
    universe: { symbols: ['BTCUSD'], timeframe: '1h' },
    filters: [],
  };
  const s = await (
    await page.request.post('/api/strategies', {
      headers: { 'x-kora-csrf': '1' },
      data: { definition: def },
    })
  ).json();
  await page.request.post('/api/backtests', {
    headers: { 'x-kora-csrf': '1' },
    data: { versionId: s.latest.id },
  });
  for (const path of ['/robots/builder?template=trend-x', `/robots?strategy=${s.id}`]) {
    await page.goto(path);
    await expect(
      page.getByTestId(path.startsWith('/robots/builder') ? 'validation-state' : 'equity-chart'),
    ).toBeVisible({ timeout: 20_000 });
    const res = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    const serious = res.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    expect(
      serious.map((v) => `${path}: ${v.id} ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
    ).toEqual([]);
  }
});

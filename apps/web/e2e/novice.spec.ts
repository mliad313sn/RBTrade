import { expect, test, type Page } from '@playwright/test';

import { fmtMoney } from '../src/lib/i18n/format';
import { apiSignIn } from './helpers';

const CSRF = { 'x-kora-csrf': '1' };

async function onboardThroughUi(page: Page, limits: { daily: string; monthly: string }) {
  await page.goto('/home');
  await expect(page).toHaveURL(/\/onboarding$/);
  await expect(page.getByTestId('practice-account-ready')).toContainText('practice money');
  // Five short screens.
  for (const title of ['What trading is', 'Spread and fees', 'Your safety net', 'Borrowing', 'Losses are normal']) {
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
    await page.getByTestId('onboarding-next').click();
  }
  // The regulatory warning with the Compliance placeholder, acknowledged against its version.
  const step = page.getByTestId('disclosure-step');
  await expect(step.getByTestId('disclosure-body')).toContainText('[XX]% of retail accounts lose money');
  await expect(page.getByTestId('disclosure-confirm')).toBeDisabled();
  await page.getByTestId('disclosure-ack').check();
  const ack = page.waitForResponse((r) => r.url().includes('/api/disclosures/risk-warning/acknowledgements'));
  await page.getByTestId('disclosure-confirm').click();
  expect((await ack).status()).toBe(201);
  // Loss limits with suggested defaults (1.5 % / 6 % of 100,000).
  await expect(page.getByTestId('limits-step')).toContainText('We suggest 1.5% of your balance a day and 6% a month');
  await expect(page.getByTestId('onboarding-daily')).toHaveValue('1500');
  await expect(page.getByTestId('onboarding-monthly')).toHaveValue('6000');
  await page.getByTestId('onboarding-daily').fill(limits.daily);
  await page.getByTestId('onboarding-monthly').fill(limits.monthly);
  await page.getByTestId('onboarding-finish').click();
  await expect(page).toHaveURL(/\/home$/);
}

test('onboards → sets limits → trades → reaches the limit → cooling-off → Pro and back with state kept', async ({ page }) => {
  test.setTimeout(90_000);
  await apiSignIn(page, 'novice', { onboarded: false });
  // A tiny daily limit so the fees of one trade reach it (deterministic in PAPER).
  await onboardThroughUi(page, { daily: '1', monthly: '50' });

  const limits = page.getByTestId('limits');
  await expect(limits.getByTestId('limit-today')).toContainText('of $1');
  await expect(limits.getByTestId('limit-month')).toContainText('of $50');
  await expect(page.getByTestId('practice-balance')).toHaveText('$100,000.00');
  await expect(page.getByTestId('borrowing-line')).toContainText('Borrowed money (leverage): Off');

  // Make a trade: Bitcoin trades around the clock. Record every ticket the page fetches.
  const tickets: Array<{ ok: boolean; order: Record<string, unknown>; preview: { preview: { lossIfStopHit: { total: string; costs: string } } } }> = [];
  page.on('response', (r) => {
    if (r.url().endsWith('/api/novice/ticket') && r.ok()) void r.json().then((j) => tickets.push(j));
  });
  const trade = page.getByTestId('novice-trade');
  await trade.getByRole('button', { name: /Bitcoin/ }).click();
  await page.getByTestId('direction-up').click();
  await page.getByTestId('trade-amount').fill('5000');
  await page.getByTestId('safety-slider').fill('3');
  await expect(page.getByTestId('most-you-could-lose')).not.toHaveText('—');
  await expect(page.getByTestId('ticket-note')).toContainText('in fees');
  await page.waitForTimeout(1000); // let the debounced ticket settle
  const shown = await page.getByTestId('most-you-could-lose').textContent();
  const last = tickets.at(-1)!;
  expect(last.ok).toBe(true);
  // The figure on screen is the preview's loss at the stop, fees included, for that exact order.
  expect(shown).toBe(fmtMoney(last.preview.preview.lossIfStopHit.total, 'USD', 'en'));
  expect(Number(last.preview.preview.lossIfStopHit.costs)).toBeGreaterThan(0);
  const direct = await (await page.request.post('/api/orders/preview', { headers: CSRF, data: last.order })).json();
  expect(direct.preview.lossIfStopHit).toMatchObject({ stopPrice: expect.any(String), total: expect.any(String) });

  // Review sheet: gain/loss scenario and the required "I understand" tick.
  await page.getByTestId('review-trade').click();
  const sheet = page.getByTestId('review-sheet');
  await expect(sheet.getByTestId('review-loss')).toContainText('If the safety net is hit, you lose about');
  await expect(sheet.getByTestId('review-gain')).toContainText('you gain about');
  await expect(sheet.getByTestId('confirm-trade')).toBeDisabled();
  const loss = await page.getByTestId('most-you-could-lose').textContent();
  await expect(sheet.getByText(`I understand I could lose up to ${loss}.`)).toBeVisible();
  await sheet.getByTestId('understand').check();
  const placed = page.waitForResponse((r) => r.url().endsWith('/api/orders') && r.request().method() === 'POST');
  await sheet.getByTestId('confirm-trade').click();
  const order = await (await placed).json();
  expect(order.order).toMatchObject({ symbol: 'BTCUSD', type: 'market', status: 'filled' });
  expect(order.order.stopLossPrice).toBeTruthy();
  await expect(page.getByText('Done. Your trade is open.')).toBeVisible();
  await expect(page.getByTestId('holding-BTCUSD')).toContainText('You gain if it goes up');

  // The fees alone reach the $1 daily limit → cooling-off, and new trades are refused.
  const cooling = page.getByTestId('cooling-off');
  await expect(cooling).toBeVisible({ timeout: 15_000 });
  await expect(cooling).toContainText('Time for a break');
  await expect(cooling).toContainText('You can still close trades');
  await expect(page.getByTestId('review-trade')).toBeDisabled();
  const refused = await page.request.post('/api/orders', {
    headers: CSRF,
    data: { ...last.order, clientOrderId: `e2e-cool-${Date.now()}` },
  });
  expect(refused.status()).toBe(422);
  expect((await refused.json()).violations.map((v: { code: string }) => v.code)).toEqual(expect.arrayContaining(['NOVICE_COOLING_OFF', 'DAILY_LOSS_LIMIT']));

  // Switch to Pro: same account, the position is in the blotter.
  await page.getByTestId('mode-toggle').getByRole('radio', { name: 'Pro' }).click();
  await expect(page).toHaveURL(/\/terminal\?.*switched=pro/);
  await expect(page.getByTestId('pro-topbar')).toBeVisible();
  await page.getByRole('tab', { name: /Positions/ }).click();
  await expect(page.getByTestId('blotter-positions')).toContainText('BTC/USD');

  // And back: position, limits and cooling-off are all still there.
  await page.getByTestId('mode-toggle').getByRole('radio', { name: 'Novice' }).click();
  await expect(page).toHaveURL(/\/home\?.*switched=novice/);
  await expect(page.getByTestId('holding-BTCUSD')).toBeVisible();
  await expect(page.getByTestId('cooling-off')).toBeVisible();
  await expect(page.getByTestId('limit-today')).toContainText('of $1');
  await expect(page.getByTestId('limit-month')).toContainText('of $50');

  // Loosening waits 24 h (server rule), tightening is immediate.
  await page.getByTestId('edit-limits').click();
  await page.getByTestId('limit-daily-input').fill('20');
  await page.getByTestId('save-limits').click();
  await expect(page.getByTestId('pending-limits')).toContainText('Your daily limit goes up to $20');
  await expect(page.getByTestId('limit-today')).toContainText('of $1');
});

test('the simple view speaks French: navigation, banner with [XX] %, trade card, limits', async ({ page }) => {
  await apiSignIn(page, 'novice');
  await page.goto('/home');
  await page.getByTestId('language-switch').getByRole('button', { name: 'Français' }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
  await expect(page.getByRole('navigation', { name: 'Principal' })).toContainText('Accueil');
  await expect(page.getByTestId('risk-banner')).toContainText('[XX] % des comptes de particuliers perdent de l’argent');
  await expect(page.getByTestId('novice-trade')).toContainText('Faire un trade');
  await expect(page.getByTestId('limits')).toContainText('Vos limites');
  await expect(page.getByTestId('practice-balance')).toHaveText('100 000,00 $');
  await page.goto('/learn');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Apprendre');
  await page.getByTestId('language-switch').getByRole('button', { name: 'English' }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Learn');
});

test('auto-invest: ready-made robots only, risk 1–5, past results line; start with practice money; live refused', async ({ page }) => {
  await apiSignIn(page, 'novice');
  await page.goto('/auto-invest');
  await expect(page.getByTestId('past-results-note')).toHaveText('Past results are not a promise of future results.');
  const trend = page.getByTestId('template-trend-x');
  await expect(trend).toContainText('Steady Trend');
  await expect(trend.getByRole('img', { name: 'Risk level 2 of 5' })).toBeVisible();
  await expect(page.getByTestId('template-meanrev-gold').getByRole('img', { name: 'Risk level 3 of 5' })).toBeVisible();
  await expect(page.getByTestId('template-breakout-crypto').getByRole('img', { name: 'Risk level 5 of 5' })).toBeVisible();
  await expect(page.getByTestId('oos-trend-x')).toContainText('Test on past prices it did not learn from');
  await page.getByTestId('start-breakout-crypto').click();
  await page.getByTestId('robot-amount').fill('2000');
  await page.getByTestId('confirm-robot').click();
  await expect(page.getByTestId('robot-breakout-crypto')).toContainText('Running with practice money');
  await page.getByTestId('live-breakout-crypto').click();
  await expect(page.getByTestId('live-dialog')).toContainText('Real money is not available yet');
  // The builder stays closed to novices (403 page and API).
  const res = await page.goto('/robots/builder');
  expect(res?.status()).toBe(403);
});

test('learn: lessons, glossary entries for every inline link, and the 5-question check', async ({ page }) => {
  await apiSignIn(page, 'novice');
  await page.goto('/learn');
  await expect(page.getByTestId('lessons').getByRole('link')).toHaveCount(5);
  await expect(page.locator('#risks')).toContainText('[XX]% of retail accounts lose money');
  await page.getByTestId('lesson-safety-net').click();
  await expect(page.getByTestId('lesson')).toContainText('2-minute read');
  const link = page.getByTestId('lesson').locator('a[data-glossary="safety-net"]');
  await link.click();
  await expect(page).toHaveURL(/\/learn#glossary-safety-net$/);
  await expect(page.locator('#glossary-safety-net')).toContainText('Safety net (stop)');
  await page.goto('/learn/check');
  const check = page.getByTestId('knowledge-check');
  await expect(check).toContainText('Get 4 right');
  // Best answers are option b except the last question (a) (reviewed data file).
  for (const [q, o] of [['borrowing', 1], ['safety_net', 1], ['fees', 1], ['robot_results', 1], ['losing_streak', 0]] as const)
    await page.getByTestId(`kc-${q}`).getByRole('radio').nth(o).check();
  await page.getByTestId('kc-submit').click();
  await expect(check).toContainText('You passed with 100%');
  await page.goto('/home');
  await page.getByTestId('edit-limits').click();
  await expect(page.getByTestId('ask-borrowing')).toBeVisible();
});

test('goals 07 and 07B in the simple view: "Explain this to me" (novice copilot) and "What’s moving", in English and French', async ({ page }) => {
  await apiSignIn(page, 'novice');
  await page.goto('/learn/safety-net');
  const slot = page.getByTestId('explain-lesson');
  await slot.getByRole('button', { name: 'Explain this to me' }).click();
  const answer = slot.getByTestId('explain-this-text');
  await expect(answer).toContainText('Not investment advice.');
  await expect(answer).not.toContainText('The explainer is not available');

  await page.goto('/home');
  const moving = page.getByTestId('whats-moving');
  await expect(moving).toContainText('What’s moving and why');
  await expect(moving).toContainText('This shows what moved, not what to do. Not investment advice.');
  await page.getByTestId('language-switch').getByRole('button', { name: 'Français' }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
  await expect(moving).toContainText('Ce qui bouge et pourquoi');
  await expect(moving).toContainText('Ceci n’est pas un conseil en investissement.');
});

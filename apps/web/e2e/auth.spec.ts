import { expect, test } from '@playwright/test';

import { answerIndex, apiSignIn, PASSWORD, totp, uniqueEmail } from './helpers';

test('health reports db, redis and keycloak through the web proxy', async ({ request }) => {
  const res = await request.get('/api/health');
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body).toMatchObject({ environment: 'PAPER', liveTradingEnabled: false, checks: { db: { status: 'up' }, redis: { status: 'up' } } });
  expect(body.checks.keycloak.status).toBe('skipped');
});

test('anonymous users are sent to /login', async ({ page }) => {
  await page.goto('/terminal');
  await expect(page).toHaveURL(/\/login\?next=%2Fterminal/);
});

test('no self-service trader (B-018): sign up as novice → appropriateness assessment → sign in again → MFA enrolment → Pro terminal → TOTP login', async ({ page }) => {
  const email = uniqueEmail('ui-trader');
  await page.goto('/signup');
  await expect(page.getByLabel(/Pro trader/)).toHaveCount(0);
  await expect(page.getByTestId('signup-appropriateness-note')).toContainText('appropriateness assessment');
  await page.getByLabel('Your name').fill('Ada Trader');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/home/);

  await page.getByTestId('user-menu').click();
  await page.getByTestId('unlock-pro').click();
  await expect(page).toHaveURL(/\/appropriateness/);
  await expect(page.getByTestId('appropriateness-simulated')).toContainText('SIMULATED');
  const idx = answerIndex(true);
  for (const [qid, i] of Object.entries(idx)) await page.getByTestId(`question-${qid}`).getByRole('radio').nth(i).check();
  await page.getByTestId('submit-appropriateness').click();
  await expect(page.getByTestId('appropriateness-result')).toContainText('Passed with 100%');
  await expect(page).toHaveURL(/\/login\?next=%2Fterminal/, { timeout: 10_000 });

  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Set up two-factor authentication' })).toBeVisible();
  await expect(page.getByAltText('QR code for your authenticator app')).toBeVisible();
  const secret = (await page.getByTestId('mfa-secret').textContent())!.trim();
  await page.getByLabel('6-digit code').fill(totp(secret));
  await page.getByRole('button', { name: /Turn on two-factor/ }).click();

  await expect(page).toHaveURL(/\/terminal/);
  await expect(page.getByTestId('pro-topbar')).toBeVisible();
  await expect(page.getByTestId('env-chip')).toHaveText('PAPER');

  await page.getByTestId('user-menu').click();
  await expect(page.getByTestId('unlock-pro')).toHaveCount(0);
  await page.getByTestId('logout').click();
  await expect(page).toHaveURL(/\/login/);

  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Enter your 6-digit code' })).toBeVisible();
  await page.getByLabel('6-digit code').fill('000000' === totp(secret, 1) ? '111111' : '000000');
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByTestId('auth-error')).toContainText('not valid');
  await page.getByLabel('6-digit code').fill(totp(secret, 1));
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page).toHaveURL(/\/terminal/);
});

test('a failed assessment shows the topics to review and starts a cool-down; the account stays novice', async ({ page }) => {
  await apiSignIn(page, 'novice');
  await page.goto('/appropriateness');
  const idx = answerIndex(false);
  for (const [qid, i] of Object.entries(idx)) await page.getByTestId(`question-${qid}`).getByRole('radio').nth(i).check();
  await page.getByTestId('submit-appropriateness').click();
  await expect(page.getByTestId('appropriateness-result')).toContainText('Not passed: 0%');
  await expect(page.getByTestId('appropriateness-result')).toContainText('Leverage');
  await page.reload();
  await expect(page.getByTestId('appropriateness-cooldown')).toBeVisible();
  await expect(page.getByTestId('submit-appropriateness')).toHaveCount(0);
  const me = await (await page.request.get('/api/me')).json();
  expect(me.roles).toEqual(['novice']);
});

test('sign-up as novice lands in the simple view without MFA', async ({ page }) => {
  await page.goto('/signup');
  await page.getByLabel('Your name').fill('Nia Novice');
  await page.getByLabel('Email').fill(uniqueEmail('ui-novice'));
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/home/);
  await expect(page.getByTestId('novice-topbar')).toBeVisible();
  await expect(page.getByText('[XX]% of retail accounts lose money')).toBeVisible();
});

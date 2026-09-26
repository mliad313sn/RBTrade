import { expect, test } from '@playwright/test';

import { PASSWORD, totp, uniqueEmail } from './helpers';

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

test('sign-up as trader → MFA enrolment → pro terminal → sign out → login with TOTP', async ({ page }) => {
  const email = uniqueEmail('ui-trader');
  await page.goto('/signup');
  await page.getByLabel('Your name').fill('Ada Trader');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByLabel(/Pro trader/).check();
  await page.getByRole('button', { name: 'Create account' }).click();

  await expect(page.getByRole('heading', { name: 'Set up two-factor authentication' })).toBeVisible();
  await expect(page.getByAltText('QR code for your authenticator app')).toBeVisible();
  const secret = (await page.getByTestId('mfa-secret').textContent())!.trim();
  await page.getByLabel('6-digit code').fill(totp(secret));
  await page.getByRole('button', { name: /Turn on two-factor/ }).click();

  await expect(page).toHaveURL(/\/terminal/);
  await expect(page.getByTestId('pro-topbar')).toBeVisible();
  await expect(page.getByTestId('env-chip')).toHaveText('PAPER');

  await page.getByTestId('user-menu').click();
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

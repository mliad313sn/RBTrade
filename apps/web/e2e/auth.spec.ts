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
  // Goal 08: a new novice lands on onboarding (inside the simple view) until it is done.
  await expect(page).toHaveURL(/\/(home|onboarding)/);

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
  // B-902 (goal 10): ten one-time recovery codes are shown once after enrolment.
  await expect(page.getByTestId('recovery-codes').getByRole('listitem')).toHaveCount(10);
  const recoveryCode = (await page.getByTestId('recovery-codes').getByRole('listitem').first().textContent())!.trim();
  await page.getByRole('button', { name: 'I have saved my codes' }).click();

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

  // Lost authenticator: a recovery code signs in once (B-902).
  await page.getByTestId('user-menu').click();
  await page.getByTestId('logout').click();
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('button', { name: /Use a recovery code/ }).click();
  await page.getByLabel('Recovery code').fill(recoveryCode);
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
  // Goal 08: a new novice lands on onboarding (inside the simple view) until it is done.
  await expect(page).toHaveURL(/\/(home|onboarding)/);
  await expect(page.getByTestId('novice-topbar')).toBeVisible();
  await expect(page.getByText('[XX]% of retail accounts lose money')).toBeVisible();
});

test('web security headers (goal 10): nonce CSP without unsafe-inline scripts, framing refused, no x-powered-by', async ({ request }) => {
  for (const path of ['/login', '/terminal']) {
    const res = await request.get(path, { maxRedirects: 0 });
    const h = res.headers();
    const csp = h['content-security-policy'] ?? '';
    expect(csp, path).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(h['x-content-type-options']).toBe('nosniff');
    expect(h['x-frame-options']).toBe('DENY');
    expect(h['x-powered-by']).toBeUndefined();
  }
  // A fresh nonce per response.
  const a = (await request.get('/login')).headers()['content-security-policy'];
  const b = (await request.get('/login')).headers()['content-security-policy'];
  expect(a).not.toBe(b);
});

// IRTC R1-06: `next=` must stay a same-origin relative path after a genuine sign-in.
for (const next of ['/%5Cevil.example/phish', '/%09/evil.example/phish', '//evil.example/phish', '/%2F%2Fevil.example/phish']) {
  test(`post-login redirect refuses an off-site next (${next})`, async ({ page, baseURL }) => {
    const email = uniqueEmail('redirect');
    const signup = await page.request.post('/api/auth/signup', { headers: { 'x-kora-csrf': '1' }, data: { email, password: PASSWORD, displayName: 'Redirect' } });
    expect(signup.status()).toBe(201);
    const offsite: string[] = [];
    await page.route(/evil\.example/, (route) => {
      offsite.push(route.request().url());
      return route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>attacker</h1>' });
    });
    await page.goto(`/login?next=${next}`);
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).not.toHaveURL(/\/login/);
    await page.waitForLoadState('networkidle');
    expect(new URL(page.url()).origin).toBe(new URL(baseURL!).origin);
    expect(offsite).toEqual([]);
  });
}

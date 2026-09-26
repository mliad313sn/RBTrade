import { readFileSync } from 'node:fs';

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import pg from 'pg';

import { apiSignIn, PASSWORD, totp, uniqueEmail } from './helpers';

/**
 * Goal 09 through the real web + api: the risk officer console shows real engine data, a limit
 * breach reaches it within 5 s, the firm-wide kill switch forces four-eyes on resume (the requester
 * cannot approve; the console approves as a second person), evidence exports as CSV; the internal
 * auditor verifies the chain and draws a reproducible sample (read-only).
 */
const CSRF = { 'x-kora-csrf': '1' };
let n = 0;
const cid = () => `gov-${Date.now()}-${++n}`;

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

/** Grants an extra role in the database, then signs in again so the token carries it. */
async function grant(req: APIRequestContext, email: string, role: string, secret?: string): Promise<string | undefined> {
  await db(`INSERT INTO user_roles (user_id, role) SELECT id, $2 FROM users WHERE email = $1 ON CONFLICT DO NOTHING`, [email, role]);
  const login = await (await req.post('/api/auth/login', { headers: CSRF, data: { email, password: PASSWORD } })).json();
  let s = secret;
  if (login.status === 'mfa_enrollment_required') s = (await (await req.post('/api/auth/mfa/enroll', { headers: CSRF, data: { mfaToken: login.mfaToken } })).json()).secret;
  const v = await req.post('/api/auth/mfa/verify', { headers: CSRF, data: { mfaToken: login.mfaToken, code: totp(s!, secret ? 1 : 0) } });
  expect(v.status()).toBe(200);
  return s;
}

async function axe(page: Page, name: string) {
  const res = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  const serious = res.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${name}: ${v.id} ${v.nodes.map((x) => x.target.join(' ')).join(' | ')}`)).toEqual([]);
}

test('risk console: real data, a breach alert within 5 s, four-eyes resume after a firm halt, evidence CSV', async ({ page, browser }) => {
  test.setTimeout(120_000);
  // The trader acts in a separate browser context (own session cookie).
  const traderCtx = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  const traderPage = await traderCtx.newPage();
  await apiSignIn(traderPage, 'trader');
  const tr = traderPage.request;
  expect((await tr.post('/api/orders', { headers: CSRF, data: { clientOrderId: cid(), symbol: 'BTCUSD', side: 'buy', type: 'market', qty: '0.01' } })).status()).toBe(201);
  const traderAcct = (await (await tr.get('/api/accounts/me')).json()).id as string;

  const { email, secret } = await apiSignIn(page, 'trader');
  await grant(page.request, email, 'risk_officer', secret);
  await page.goto('/risk');
  await expect(page.getByTestId('risk-console')).toBeVisible();
  await expect(page.getByTestId('risk-live-state')).toHaveText('Live alerts on', { timeout: 15_000 });
  // Real engine data: the trader's account is in the exposure table.
  await expect(page.getByTestId('risk-exposure')).toContainText(traderAcct.slice(0, 8), { timeout: 15_000 });
  await axe(page, 'risk console');

  // A pre-trade limit breach reaches the console within 5 s.
  const t0 = Date.now();
  const rej = await tr.post('/api/orders', { headers: CSRF, data: { clientOrderId: cid(), symbol: 'BTCUSD', side: 'buy', type: 'market', qty: '40' } });
  expect(rej.status()).toBe(422);
  const breach = page.locator('[data-testid="risk-alert"][data-kind="risk.limit_breach"]', { hasText: 'buy 40 BTCUSD' }).first();
  await expect(breach).toBeVisible({ timeout: 5000 });
  const latency = Date.now() - t0;
  console.log(`[e2e governance] breach alert visible on the console after ${latency} ms`);
  expect(latency).toBeLessThan(5000);

  // Firm-wide kill switch from the console (1.5 s hold), then the trader asks to resume: 202, pending.
  await page.getByTestId('global-ks-reason').fill('E2E tabletop: firm halt');
  const hold = page.getByTestId('global-ks-hold');
  await hold.hover();
  await page.mouse.down();
  await page.waitForTimeout(1800);
  await page.mouse.up();
  await expect(page.getByText(/Firm-wide kill switch: \d+ accounts halted/)).toBeVisible({ timeout: 15_000 });
  const asked = await tr.post('/api/kill-switch/resume', { headers: CSRF, data: { reason: 'Cause understood (E2E)' } });
  expect(asked.status()).toBe(202);
  const requestId = (await asked.json()).pendingApproval.id as string;
  // The trader cannot approve (and neither could any requester).
  expect((await tr.post(`/api/governance/approvals/${requestId}/approve`, { headers: CSRF, data: { note: 'self approve' } })).status()).toBe(403);

  // The risk officer approves in the console as the second person.
  const row = page.getByTestId('approval-row').filter({ hasText: 'Cause understood (E2E)' });
  await expect(row).toBeVisible({ timeout: 10_000 });
  await row.getByTestId('approve').click();
  await page.getByTestId('decision-note').fill('Checked with the desk (E2E)');
  await page.getByTestId('confirm-decision').click();
  await expect(page.getByText('Approved and applied')).toBeVisible();
  expect((await (await tr.get('/api/kill-switch')).json()).halted).toBe(false);

  // Evidence export: KC-07 (four-eyes on resume) as CSV for today.
  await page.getByTestId('evidence-control').selectOption('KC-07');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('evidence-csv').click()]);
  expect(download.suggestedFilename()).toMatch(/^kora-evidence_KC-07_\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.csv$/);
  const csv = readFileSync((await download.path())!, 'utf8');
  expect(csv.split('\r\n')[0]).toBe('audit_id,ts,account_id,owner_id,halted_by,resumed_by,firm_halt,four_eyes_request,requested_by,approved_by');
  expect(csv).toContain(requestId);

  // Leave other specs' accounts un-halted.
  await db(`UPDATE accounts SET trading_halted = false, halt_scope = NULL, halted_at = NULL, halted_by = NULL, halt_reason = NULL WHERE trading_halted`);
  await traderCtx.close();
});

test('internal audit: the auditor lands on the read-only view, verifies the chain and draws a reproducible sample', async ({ page }) => {
  const req = page.request;
  const email = uniqueEmail('auditor');
  expect((await req.post('/api/auth/signup', { headers: CSRF, data: { email, password: PASSWORD, displayName: 'E2E auditor' } })).status()).toBe(201);
  expect((await (await req.post('/api/auth/login', { headers: CSRF, data: { email, password: PASSWORD } })).json()).status).toBe('ok');
  await grant(req, email, 'auditor');

  await page.goto('/');
  await expect(page).toHaveURL(/\/internal-audit$/);
  await expect(page.getByTestId('internal-audit')).toBeVisible();
  await page.getByTestId('ia-verify').click();
  await expect(page.getByTestId('ia-verify-result')).toContainText('Chain valid.');
  await page.getByTestId('ia-sample-control').selectOption('KC-01');
  await page.getByTestId('ia-sample-n').fill('5');
  await page.getByTestId('ia-sample-seed').fill('e2e-seed-1');
  await page.getByTestId('ia-sample-draw').click();
  await expect(page.getByTestId('ia-sample-result')).toContainText('seed e2e-seed-1');
  await axe(page, 'internal audit');
  // Read-only: the console and the firm kill switch are refused.
  expect((await req.get('/api/risk-console/overview')).status()).toBe(403);
  expect((await req.post('/api/risk-console/kill-switch', { headers: CSRF, data: { scope: 'robots', reason: 'not allowed' } })).status()).toBe(403);
  const denied = await page.goto('/risk');
  expect(denied?.status()).toBe(403);
});

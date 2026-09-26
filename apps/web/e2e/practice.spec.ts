import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { findJargon } from '../src/lib/sim/glossary';
import { apiSignIn } from './helpers';

test('novice Practice: three plain questions → good / typical / bad year, no promise, no unlinked jargon', async ({
  page,
}) => {
  await apiSignIn(page, 'novice');
  await page.goto('/practice');
  await expect(page.getByTestId('novice-topbar')).toBeVisible();
  await expect(page.getByTestId('not-a-promise')).toHaveText(
    'This is a simulation, not a promise.',
  );

  await page.getByTestId('practice-amount').fill('5000');
  await page.getByRole('radio', { name: /Most days/ }).check();
  await page.getByRole('radio', { name: /Very careful/ }).check();
  const run = page.waitForResponse((r) => r.url().endsWith('/api/sim/project'));
  await page.getByTestId('practice-run').click();
  const body = await (await run).json();
  expect(body).toMatchObject({ startingCapital: 5000, tradesPerPath: 20 * 12 });

  const value = async (k: string) =>
    Number(await page.getByTestId(`year-${k}`).getAttribute('data-value'));
  for (const k of ['good', 'typical', 'bad'])
    await expect(page.getByTestId(`year-${k}`)).toContainText('$');
  const [good, typical, bad] = [await value('good'), await value('typical'), await value('bad')];
  expect(good).toBeGreaterThan(typical);
  expect(typical).toBeGreaterThan(bad);
  expect(good).toBe(body.finalEquity.p95);
  expect(bad).toBe(body.finalEquity.p5);
  await expect(page.getByTestId('fan-chart')).toBeVisible();
  await expect(page.getByTestId('simulated-watermark')).toBeAttached();

  // Plain-language review (automated part): jargon is absent unless it sits inside a glossary link.
  const text = await page.locator('main').evaluate((el) => {
    const copy = el.cloneNode(true) as HTMLElement;
    copy.querySelectorAll('a[data-glossary]').forEach((a) => a.remove());
    return copy.textContent ?? '';
  });
  expect(findJargon(text)).toEqual([]);

  // Every glossary link resolves to an entry on the page.
  const links = page.locator('a[data-glossary]');
  const ids = await links.evaluateAll((as) => as.map((a) => a.getAttribute('href')));
  expect(ids.length).toBeGreaterThanOrEqual(4);
  for (const href of ids) await expect(page.locator(href!)).toHaveCount(1);
  await links.first().click();
  await expect(page).toHaveURL(/#glossary-simulation$/);

  const res = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const serious = res.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(
    serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
  ).toEqual([]);
});

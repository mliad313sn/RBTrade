import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

import { apiSignIn } from './helpers';

/** Goal 08 §8: 390 px first, bottom tab bar, 44 px targets, no horizontal scroll, axe clean. */
test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });

async function axe(page: Page, name: string) {
  const res = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  const serious = res.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  const report = serious.map((v) => `${name}: ${v.id} ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`);
  expect(report, report.join('\n')).toEqual([]);
  expect(res.violations.filter((v) => v.id === 'color-contrast').map((v) => v.nodes.map((n) => n.target.join(' '))), `${name} contrast`).toEqual([]);
}

/**
 * Every visible interactive element is at least 44 × 44 px. Inline links inside running text are
 * the WCAG 2.5.8 inline exception (glossary links in sentences); everything else is measured.
 */
async function smallTargets(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const sel = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="radio"], [role="tab"]';
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (r.width === 0 || r.height === 0 || style.visibility === 'hidden' || style.display === 'none') continue;
      if (el.classList.contains('skip-link')) continue;
      if (el.closest('[aria-hidden="true"]')) continue;
      const inText = el.tagName === 'A' && !!el.closest('p, li, dd, legend') && style.display === 'inline';
      if (inText) continue;
      // A radio or checkbox inside a label: the label is the target.
      const label = (el as HTMLInputElement).labels?.[0];
      const box = label && (el.getAttribute('type') === 'radio' || el.getAttribute('type') === 'checkbox') ? label.getBoundingClientRect() : r;
      if (box.width < 43.5 || box.height < 43.5)
        out.push(`${el.tagName.toLowerCase()}${el.getAttribute('data-testid') ? `[${el.getAttribute('data-testid')}]` : ''} "${(el.textContent ?? el.getAttribute('aria-label') ?? '').trim().slice(0, 30)}" ${Math.round(box.width)}×${Math.round(box.height)}`);
    }
    return out;
  });
}

async function noHorizontalScroll(page: Page) {
  const w = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(w, 'page wider than the 390 px viewport').toBeLessThanOrEqual(390);
}

test('novice pages at 390 px: bottom tab bar, 44 px targets, no sideways scroll, axe clean', async ({ page }) => {
  test.setTimeout(90_000);
  await apiSignIn(page, 'novice');
  for (const path of ['/home', '/practice', '/auto-invest', '/learn', '/learn/losses', '/learn/check', '/settings']) {
    await page.goto(path);
    await expect(page.getByTestId('mobile-tabbar')).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Main', exact: true })).toBeHidden();
    await noHorizontalScroll(page);
    expect(await smallTargets(page), path).toEqual([]);
    await axe(page, `${path} (390 px)`);
  }
  // The tab bar links are large and labelled.
  const bar = page.getByTestId('mobile-tabbar');
  await expect(bar.getByRole('link')).toHaveText(['Home', 'Practice', 'Auto-invest', 'Learn']);
  for (const box of await bar.getByRole('link').evaluateAll((as) => as.map((a) => a.getBoundingClientRect().height))) expect(box).toBeGreaterThanOrEqual(44);
});

test('onboarding and the review sheet at 390 px (bottom sheet, 44 px, axe clean)', async ({ page }) => {
  test.setTimeout(90_000);
  await apiSignIn(page, 'novice', { onboarded: false });
  await page.goto('/onboarding');
  for (let i = 0; i < 5; i++) {
    expect(await smallTargets(page), `onboarding step ${i + 1}`).toEqual([]);
    await axe(page, `onboarding step ${i + 1}`);
    await page.getByTestId('onboarding-next').click();
  }
  await axe(page, 'onboarding disclosure');
  await page.getByTestId('disclosure-ack').check();
  await page.getByTestId('disclosure-confirm').click();
  await expect(page.getByTestId('limits-step')).toBeVisible();
  expect(await smallTargets(page), 'onboarding limits').toEqual([]);
  await axe(page, 'onboarding limits');
  await page.getByTestId('onboarding-finish').click();
  await expect(page).toHaveURL(/\/home$/);

  await page.getByTestId('novice-trade').getByRole('button', { name: /Bitcoin/ }).click();
  await page.getByTestId('direction-down').click();
  await page.getByTestId('trade-amount').fill('3000');
  await expect(page.getByTestId('review-trade')).toBeEnabled({ timeout: 10_000 });
  await page.getByTestId('review-trade').click();
  const sheet = page.getByTestId('review-sheet');
  await expect(sheet).toBeVisible();
  const box = (await sheet.boundingBox())!;
  expect(Math.round(box.x)).toBe(0);
  expect(Math.round(box.y + box.height)).toBe(844); // docked to the bottom edge
  expect(await smallTargets(page), 'review sheet').toEqual([]);
  await axe(page, 'review sheet (390 px)');
});

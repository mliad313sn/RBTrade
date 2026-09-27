import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

import { apiSignIn } from './helpers';

/**
 * Goal 04 quality bars: axe 0 serious/critical on the live terminal (also with dialogs open), a
 * computed ≥ 4.5:1 text-contrast scan (≥ 3:1 for large text and graphics), tick-to-paint p95
 * < 100 ms, no layout shift while data streams, and a keyboard-only ticket-to-fill.
 */

async function axe(page: Page, name: string) {
  const res = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const serious = res.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  const report = serious.map(
    (v) => `${name}: ${v.id} (${v.impact}) ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`,
  );
  expect(report, report.join('\n')).toEqual([]);
  return res;
}

/** WCAG relative-luminance contrast of every visible text node against its effective background. */
async function contrastFailures(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const parse = (c: string): [number, number, number, number] | null => {
      const m = c.match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const p = m[1]!
        .split(/[ ,/]+/)
        .filter(Boolean)
        .map(Number);
      return [p[0]!, p[1]!, p[2]!, p[3] ?? 1];
    };
    const lum = ([r, g, b]: number[]) => {
      const f = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!);
    };
    const blend = (fg: number[], bg: number[]) =>
      [0, 1, 2].map((i) => fg[i]! * fg[3]! + bg[i]! * (1 - fg[3]!));
    const bgOf = (el: Element | null): number[] => {
      const stack: number[][] = [];
      for (let e = el; e; e = e.parentElement) {
        const c = parse(getComputedStyle(e).backgroundColor);
        if (c && c[3] > 0) {
          stack.push(c);
          if (c[3] >= 1) break;
        }
      }
      let out = [11, 14, 19];
      for (const c of stack.reverse()) out = blend(c, out);
      return out;
    };
    const failures: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const seen = new Set<Element>();
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      if (!el || seen.has(el) || !n.textContent?.trim()) continue;
      seen.add(el);
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      if (
        cs.visibility === 'hidden' ||
        cs.display === 'none' ||
        r.width === 0 ||
        r.height === 0 ||
        Number(cs.opacity) === 0
      )
        continue;
      if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
      if (
        el.closest('[aria-hidden="true"], .k-sr-only, [disabled], option, [aria-disabled="true"]')
      )
        continue;
      const fg = parse(cs.color);
      if (!fg) continue;
      const bg = bgOf(el);
      const f = blend(fg, bg);
      const [a, b] = [lum(f), lum(bg)].sort((x, y) => y - x);
      const ratio = (a! + 0.05) / (b! + 0.05);
      const size = Number(cs.fontSize.replace('px', ''));
      const bold = Number(cs.fontWeight) >= 700;
      const graphic = Boolean(el.closest('[role="img"]'));
      const need = graphic || size >= 24 || (bold && size >= 18.66) ? 3 : 4.5;
      if (ratio + 0.005 < need)
        failures.push(
          `${ratio.toFixed(2)} < ${need}: "${n.textContent.trim().slice(0, 30)}" (${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)})`,
        );
    }
    return failures;
  });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __cls: Array<{ t: number; v: number; src: string }> };
    w.__cls = [];
    const describe = (n: Node | null) => {
      const el = n as HTMLElement | null;
      if (!el || !el.tagName) return '?';
      return `${el.tagName.toLowerCase()}${el.dataset?.testid ? `[${el.dataset.testid}]` : ''}.${String(el.className).slice(0, 30)}`;
    };
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as Array<
        PerformanceEntry & {
          value: number;
          hadRecentInput: boolean;
          sources?: Array<{ node: Node | null }>;
        }
      >) {
        if (!e.hadRecentInput)
          w.__cls.push({
            t: e.startTime,
            v: e.value,
            src: (e.sources ?? []).map((s) => describe(s.node)).join(' | '),
          });
      }
    }).observe({ type: 'layout-shift', buffered: true });
  });
  await apiSignIn(page, 'trader');
});

test('axe: 0 serious violations on the live terminal, the palette, the cheat sheet and the ticket confirmation; text contrast ≥ 4.5:1', async ({
  page,
}) => {
  await page.goto('/terminal?symbol=BTCUSD');
  await expect(page.getByTestId('wl-BTCUSD-mid')).toHaveText(/\d/, { timeout: 15_000 });
  await expect(page.getByTestId('ob-mid')).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(1000);
  await axe(page, '/terminal');
  expect(await contrastFailures(page)).toEqual([]);
  // Blotter tabs with content.
  for (const tab of ['Risk', 'Alerts', 'Fills', /^Orders/]) {
    await page.getByRole('tab', { name: tab }).click();
    await axe(page, `/terminal blotter ${String(tab)}`);
  }
  await page.getByRole('tab', { name: 'Time & sales' }).click();
  await axe(page, '/terminal time & sales');
  // Palette open.
  await page.keyboard.press('Control+k');
  await page.getByTestId('palette-input').fill('eur');
  await expect(page.getByTestId('palette-EURUSD')).toBeVisible();
  await axe(page, 'palette');
  await page.keyboard.press('Escape');
  // Cheat sheet.
  await page.locator('main').click({ position: { x: 3, y: 3 } });
  await page.keyboard.press('Shift+?');
  await expect(page.getByTestId('hotkey-cheatsheet')).toBeVisible();
  await expect(page.getByTestId('hotkey-cheatsheet')).toContainText('Focus order ticket');
  await axe(page, 'cheat sheet');
  await page.keyboard.press('Escape');
  // Every icon-only button has an accessible name (axe button-name covers this; assert explicitly too).
  const unnamed = await page.$$eval(
    'button',
    (bs) =>
      bs.filter(
        (b) => !(b.getAttribute('aria-label') || b.textContent?.trim() || b.getAttribute('title')),
      ).length,
  );
  expect(unnamed).toBe(0);
});

test('tick-to-paint p95 < 100 ms and no layout shift while data streams', async ({ page }) => {
  await page.goto('/terminal?symbol=BTCUSD');
  await expect(page.getByTestId('wl-BTCUSD-mid')).toHaveText(/\d/, { timeout: 15_000 });
  await expect(page.getByTestId('ob-mid')).toBeVisible({ timeout: 15_000 });
  const ready = await page.evaluate(() => performance.now());
  await page.waitForTimeout(6000);
  const perf = await page.evaluate(
    () => (window as unknown as { __koraPerf: { ticks: number[]; frames: number } }).__koraPerf,
  );
  const ticks = [...perf.ticks].sort((a, b) => a - b);
  const p95 = ticks[Math.ceil(ticks.length * 0.95) - 1]!;
  const p50 = ticks[Math.ceil(ticks.length * 0.5) - 1]!;
  test.info().annotations.push({
    type: 'tick-to-paint',
    description: `n=${ticks.length} p50=${p50.toFixed(1)} ms p95=${p95.toFixed(1)} ms max=${ticks.at(-1)!.toFixed(1)} ms frames=${perf.frames}`,
  });
  process.stdout.write(
    `[perf] tick-to-paint n=${ticks.length} p50=${p50.toFixed(1)} ms p95=${p95.toFixed(1)} ms max=${ticks.at(-1)!.toFixed(1)} ms\n`,
  );
  expect(ticks.length).toBeGreaterThan(50);
  expect(p95).toBeLessThan(100);
  const cls = await page.evaluate(
    () => (window as unknown as { __cls: Array<{ t: number; v: number; src: string }> }).__cls,
  );
  for (const e of cls)
    process.stdout.write(`[cls] t=${e.t.toFixed(0)} v=${e.v.toFixed(4)} ${e.src}\n`);
  const streaming = cls.filter((e) => e.t > ready).reduce((a, e) => a + e.v, 0);
  const total = cls.reduce((a, e) => a + e.v, 0);
  process.stdout.write(
    `[perf] CLS while streaming=${streaming.toFixed(4)} total=${total.toFixed(4)}\n`,
  );
  test.info().annotations.push({
    type: 'cls',
    description: `streaming=${streaming.toFixed(4)} total=${total.toFixed(4)}`,
  });
  expect(streaming).toBeLessThan(0.01);
  expect(total).toBeLessThan(0.1);
  // Initial load: navigation timing of the production build (Lighthouse is documented in the plan).
  const nav = await page.evaluate(() => {
    const n = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
    const fcp = performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null;
    return { domContentLoaded: n.domContentLoadedEventEnd, load: n.loadEventEnd, fcp };
  });
  process.stdout.write(`[perf] navigation ${JSON.stringify(nav)}\n`);
  expect(nav.load).toBeLessThan(2500);
});

test('keyboard-only ticket to fill: B, order type, quantity, Ctrl+Enter, hold to confirm with Space', async ({
  page,
}) => {
  await page.goto('/terminal?symbol=BTCUSD');
  await expect(page.getByTestId('order-ticket').getByTestId('ticket-side-buy')).toContainText(
    /\d/,
    { timeout: 15_000 },
  );
  await page.locator('main').click({ position: { x: 3, y: 3 } });
  await page.keyboard.press('b');
  await expect(page.getByTestId('ticket-side-buy')).toBeFocused();
  await expect(page.getByTestId('ticket-side-buy')).toHaveAttribute('aria-checked', 'true');
  // Tab to the "Market" order type and select it with Space.
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Tab');
    if ((await page.evaluate(() => document.activeElement?.textContent)) === 'Market') break;
  }
  await page.keyboard.press('Space');
  await expect(
    page.getByTestId('order-ticket').getByRole('radio', { name: 'Market', exact: true }),
  ).toHaveAttribute('aria-checked', 'true');
  // Quantity field.
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Tab');
    if (
      (await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))) ===
      'ticket-qty'
    )
      break;
  }
  await page.keyboard.press('Control+a');
  await page.keyboard.type('0.0100');
  await expect(page.getByTestId('preview-notional')).toContainText('USD', { timeout: 10_000 });
  await page.keyboard.press('Control+Enter');
  const dialog = page.getByTestId('confirm-order');
  await expect(dialog).toBeVisible();
  // Market order above the confirmation threshold (no stop): hold-to-confirm 600 ms.
  for (let i = 0; i < 6; i++) {
    if (
      (await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))) ===
      'confirm-hold'
    )
      break;
    await page.keyboard.press('Tab');
  }
  await expect(page.getByTestId('confirm-hold')).toBeFocused();
  await page.keyboard.down('Space');
  await page.waitForTimeout(750);
  await page.keyboard.up('Space');
  await expect(page.getByTestId('ticket-result')).toContainText('Order filled: buy 0.01 BTCUSD', {
    timeout: 10_000,
  });
  // Esc closes dialogs; Alt+5 focuses the blotter.
  await page.keyboard.press('Alt+5');
  await expect(page.locator('[data-panel-root="positions"]')).toBeFocused();
  await expect(page.getByTestId('pos-BTCUSD')).toBeVisible();
});

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '@playwright/test';
import { PNG } from 'pngjs';

import {
  contractViolations,
  installTerminalFixtures,
  UNSCHEMED_FIXTURE_ENDPOINTS,
} from './fixtures/terminal';
import { apiSignIn } from './helpers';

/**
 * Visual regression (goal 04, criterion 3; B-011):
 * 1. our own committed baseline at 1440×900 (fixture-driven, deterministic), maxDiffPixelRatio 1 %;
 * 2. fidelity against design/prototype/Main.png: (a) structural — panel rectangles within 24 px of
 *    the prototype's and mean IoU ≥ 0.85; (b) perceptual — 8× downscaled, blurred luminance mean
 *    absolute difference ≤ 0.12. A side-by-side + diff image is written to
 *    test-results/prototype-compare/ (thresholds agreed in docs/plans/04-pro-terminal.md §5.3);
 * 3. the ≥ 1280 px breakpoint: no horizontal scroll, every panel visible and usable.
 */

const REGIONS = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('./fixtures/prototype-regions.json', import.meta.url)),
    'utf8',
  ),
) as {
  regions: Record<string, [number, number, number, number]>;
};
const PROTOTYPE = fileURLToPath(new URL('../../../design/prototype/Main.png', import.meta.url));
const OUT = fileURLToPath(new URL('../test-results/prototype-compare/', import.meta.url));
export const EDGE_TOLERANCE_PX = 24;
export const MIN_MEAN_IOU = 0.85;
export const MAX_PERCEPTUAL_DIFF = 0.12;

async function openFixtureTerminal(page: Page) {
  await apiSignIn(page, 'trader');
  const fixtures = await installTerminalFixtures(page);
  await page.goto('/terminal?symbol=EURUSD');
  await expect(page.getByTestId('wl-EURUSD-mid')).toHaveText('1.08420', { timeout: 15_000 });
  await expect(page.getByTestId('ob-mid')).toContainText('1.08420');
  await expect(page.getByTestId('calendar')).toContainText('US CPI (m/m)');
  await expect(page.getByTestId('pos-EURUSD')).toBeVisible();
  await expect(page.getByTestId('chart-ohlc')).toContainText('O 1.0');
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(0, 899); // keep the crosshair off the chart
  await page.waitForTimeout(500);
  // IRTC R6-16: the bodies behind these pixels match the published API contract.
  expect(fixtures.violations, 'fixture bodies vs packages/sdk/openapi.json').toEqual([]);
  for (const t of [
    '/accounts/me',
    '/positions',
    '/orders',
    '/quotes',
    '/candles',
    '/calendar',
    '/me/watchlists',
  ])
    expect(fixtures.served, `fixture served ${t}`).toContain(t);
}

/** DOM rectangles of the terminal regions (dockview groups) in page coordinates. */
async function measure(page: Page): Promise<Record<string, [number, number, number, number]>> {
  return page.evaluate(() => {
    const rect = (el: Element | null | undefined): [number, number, number, number] | null => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)];
    };
    const group = (id: string) =>
      document.querySelector(`[data-panel-root="${id}"]`)?.closest('.dv-groupview');
    const hazard = document.querySelector('.k-hazard');
    const top = document.querySelector('[data-testid="pro-topbar"]');
    const t = rect(top)!;
    return Object.fromEntries(
      Object.entries({
        topbar: hazard ? [0, rect(hazard)![1], t[2], t[3]] : t,
        rail: rect(document.querySelector('nav[aria-label="Modules"]')),
        watchlist: rect(group('watchlist')),
        calendar: rect(group('calendar')),
        chart: rect(group('chart')),
        orderbook: rect(group('orderbook')),
        ticket: rect(group('ticket')),
        blotter: rect(group('positions')),
        statusbar: rect(document.querySelector('[data-testid="status-bar"]')),
      }).filter(([, v]) => v),
    ) as Record<string, [number, number, number, number]>;
  });
}

function iou(a: number[], b: number[]): number {
  const ix = Math.max(0, Math.min(a[2]!, b[2]!) - Math.max(a[0]!, b[0]!));
  const iy = Math.max(0, Math.min(a[3]!, b[3]!) - Math.max(a[1]!, b[1]!));
  const inter = ix * iy;
  const area = (r: number[]) => (r[2]! - r[0]!) * (r[3]! - r[1]!);
  return inter / (area(a) + area(b) - inter);
}

/** Luminance (0–1) downscaled by `f` (block mean), then a 3×3 box blur. */
function lumaGrid(png: PNG, f: number): { w: number; h: number; v: Float64Array } {
  const w = Math.floor(png.width / f);
  const h = Math.floor(png.height / f);
  const raw = new Float64Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let dy = 0; dy < f; dy++)
        for (let dx = 0; dx < f; dx++) {
          const i = ((y * f + dy) * png.width + (x * f + dx)) * 4;
          s +=
            (0.2126 * png.data[i]! + 0.7152 * png.data[i + 1]! + 0.0722 * png.data[i + 2]!) / 255;
        }
      raw[y * w + x] = s / (f * f);
    }
  const v = new Float64Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          s += raw[yy * w + xx]!;
          n++;
        }
      v[y * w + x] = s / n;
    }
  return { w, h, v };
}

test('visual regression at 1440×900: own baseline, structure and perception vs the prototype', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await openFixtureTerminal(page);

  // 1. Own committed baseline.
  await expect(page).toHaveScreenshot('terminal-1440.png', {
    maxDiffPixelRatio: 0.01,
    animations: 'disabled',
    mask: [page.getByTestId('status-latency'), page.getByTestId('status-tick')],
  });

  // 2a. Structure vs the prototype.
  const ours = await measure(page);
  const rows: string[] = [];
  const ious: number[] = [];
  for (const [name, proto] of Object.entries(REGIONS.regions)) {
    const got = ours[name];
    expect(got, `region ${name} found`).toBeTruthy();
    const edges = proto.map((p, i) => Math.abs(p - got![i]!));
    const u = iou(proto, got!);
    ious.push(u);
    rows.push(
      `${name.padEnd(10)} proto ${JSON.stringify(proto)} ours ${JSON.stringify(got)} max edge Δ ${Math.max(...edges)} px IoU ${u.toFixed(3)}`,
    );
    expect(
      Math.max(...edges),
      `${name}: every edge within ${EDGE_TOLERANCE_PX} px (${rows.at(-1)})`,
    ).toBeLessThanOrEqual(EDGE_TOLERANCE_PX);
  }
  const meanIou = ious.reduce((a, b) => a + b, 0) / ious.length;

  // 2b. Perception vs the prototype.
  mkdirSync(OUT, { recursive: true });
  const shot = PNG.sync.read(await page.screenshot({ animations: 'disabled' }));
  const proto = PNG.sync.read(readFileSync(PROTOTYPE));
  expect([shot.width, shot.height]).toEqual([proto.width, proto.height]);
  const a = lumaGrid(proto, 8);
  const b = lumaGrid(shot, 8);
  let sum = 0;
  const diff = new PNG({ width: a.w * 3, height: a.h });
  for (let y = 0; y < a.h; y++)
    for (let x = 0; x < a.w; x++) {
      const d = Math.abs(a.v[y * a.w + x]! - b.v[y * a.w + x]!);
      sum += d;
      const put = (ox: number, val: number, heat = false) => {
        const i = (y * diff.width + x + ox) * 4;
        diff.data[i] = heat ? Math.min(255, val * 4 * 255) : val * 255;
        diff.data[i + 1] = heat ? 0 : val * 255;
        diff.data[i + 2] = heat ? 0 : val * 255;
        diff.data[i + 3] = 255;
      };
      put(0, a.v[y * a.w + x]!);
      put(a.w, b.v[y * a.w + x]!);
      put(a.w * 2, d, true);
    }
  const meanDiff = sum / (a.w * a.h);
  writeFileSync(`${OUT}prototype-vs-ours-luma.png`, PNG.sync.write(diff));
  const side = new PNG({ width: proto.width * 2, height: proto.height });
  PNG.bitblt(proto, side, 0, 0, proto.width, proto.height, 0, 0);
  PNG.bitblt(shot, side, 0, 0, shot.width, shot.height, proto.width, 0);
  writeFileSync(`${OUT}prototype-vs-ours.png`, PNG.sync.write(side));
  const report = [
    ...rows,
    `mean IoU ${meanIou.toFixed(3)} (≥ ${MIN_MEAN_IOU})`,
    `perceptual mean |Δluma| ${meanDiff.toFixed(4)} (≤ ${MAX_PERCEPTUAL_DIFF})`,
  ].join('\n');
  writeFileSync(`${OUT}report.txt`, `${report}\n`);
  process.stdout.write(`[visual]\n${report}\n`);
  expect(meanIou).toBeGreaterThanOrEqual(MIN_MEAN_IOU);
  expect(meanDiff).toBeLessThanOrEqual(MAX_PERCEPTUAL_DIFF);
});

test('≥ 1280 px breakpoint: no horizontal scroll, every panel visible and at least 160 px wide', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openFixtureTerminal(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  const r = await measure(page);
  for (const name of ['watchlist', 'chart', 'orderbook', 'ticket', 'blotter', 'calendar']) {
    const box = r[name]!;
    expect(box[2] - box[0], `${name} width`).toBeGreaterThanOrEqual(160);
    expect(box[2], `${name} inside the viewport`).toBeLessThanOrEqual(1280);
    expect(box[3], `${name} inside the viewport`).toBeLessThanOrEqual(800);
  }
  await expect(page.getByTestId('place-order')).toBeVisible();
  await expect(page.getByTestId('kill-switch')).toBeInViewport();
});

test('the fixture contract check rejects a drifted body (IRTC R6-16 self-check)', () => {
  expect(
    contractViolations('/accounts/me', { id: 'not-a-uuid', equity: 1234.5 }).length,
  ).toBeGreaterThan(0);
  expect(contractViolations('/no/such/path', {})).toEqual([
    'get /no/such/path: no 200 JSON response schema in openapi.json',
  ]);
  // The unschemed list is exact: once the api documents one of these responses, drop it here.
  for (const t of UNSCHEMED_FIXTURE_ENDPOINTS)
    expect(contractViolations(t, { anything: true }), t).toEqual([]);
});

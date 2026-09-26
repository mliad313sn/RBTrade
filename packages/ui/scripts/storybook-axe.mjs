// Runs axe (WCAG 2.2 AA, colour contrast included) on every Storybook story in real Chromium,
// in both themes. Requires `pnpm build-storybook` first. Exit code 1 on any violation.
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import AxeBuilder from '@axe-core/playwright';
import { chromium } from 'playwright';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '../storybook-static');
const envFile = resolve(root, '../../../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);
if (!existsSync(join(root, 'index.json'))) {
  console.error('storybook-static missing: run `pnpm build-storybook` first');
  process.exit(2);
}
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff' };
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
  const file = join(root, path === '/' ? 'index.html' : path);
  if (!file.startsWith(root) || !existsSync(file)) return void res.writeHead(404).end();
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const index = JSON.parse(readFileSync(join(root, 'index.json'), 'utf8'));
const stories = Object.values(index.entries).filter((e) => e.type === 'story');

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1024, height: 768 } });
const page = await context.newPage();
let failures = 0;
let checks = 0;
for (const theme of ['pro-dark', 'novice-light']) {
  for (const s of stories) {
    await page.goto(`${base}/iframe.html?id=${s.id}&viewMode=story&globals=theme:${theme}`);
    await page.waitForSelector('#storybook-root > *', { state: 'attached', timeout: 15000 });
    await page.waitForTimeout(150);
    const applied = await page.evaluate(() => document.querySelector('#storybook-root [data-theme]')?.getAttribute('data-theme'));
    if (applied !== theme) throw new Error(`theme global not applied for ${s.id}: got ${applied}`);
    const res = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .disableRules(['region']) // stories render fragments, not full pages
      .analyze();
    checks++;
    if (res.violations.length) {
      failures++;
      for (const v of res.violations) console.error(`FAIL ${theme} ${s.id}: ${v.id} (${v.impact}) ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`);
    } else {
      console.log(`PASS ${theme.padEnd(12)} ${s.id}`);
    }
  }
}
await browser.close();
server.close();
console.log(`\n${checks - failures}/${checks} story renders have no axe violations (contrast included) in Chromium`);
process.exit(failures ? 1 : 0);

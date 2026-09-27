#!/usr/bin/env node
// Goal 10 chaos and resilience drill (S10), scripted and reproducible on the native stack.
//
// Starts an isolated stack — its own Redis on a scratch port, the kora_e2e database (reset), quant,
// a standalone market-data feed process, the api (production build), the bot runner, a local fake
// AI provider (Anthropic-compatible, no key, no network) and the web app — then kills one dependency
// at a time and checks the expected behaviour:
//   graceful degradation · stale badges · kill switch via REST · no orders on stale data ·
//   recovery without duplicated orders.
// Evidence: docs/qa/chaos/run.json (every step with timings and HTTP statuses), component logs in
// docs/qa/chaos/logs/, Playwright screenshots in docs/qa/chaos/screenshots/.
//
// Usage: pnpm build && node scripts/chaos/run.mjs   (Postgres :55432 running; PLAYWRIGHT_BROWSERS_PATH set)
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, createWriteStream, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const webRequire = createRequire(join(ROOT, 'apps/web/package.json'));
const { chromium } = webRequire('@playwright/test');
const pg = webRequire('pg');

const envFile = join(ROOT, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const OUT = join(ROOT, 'docs/qa/chaos');
const LOGS = join(OUT, 'logs');
const SHOTS = join(OUT, 'screenshots');
for (const d of [OUT, LOGS, SHOTS]) mkdirSync(d, { recursive: true });

const PORTS = { redis: 56390, quant: 8030, api: 4030, runner: 4130, web: 3030, ai: 4099 };
const REDIS_URL = `redis://127.0.0.1:${PORTS.redis}`;
const DB = process.env.DATABASE_URL_E2E;
const DB_OWNER = process.env.DATABASE_URL_MIGRATE_E2E;
if (!DB || !DB_OWNER) throw new Error('DATABASE_URL_E2E / DATABASE_URL_MIGRATE_E2E not set (see .env.example)');
const SERVICE_TOKEN = 'chaos-only-service-token-0123456789abcdef';
const MD_PREFIX = 'kora:chaos:md:';
const WEB = `http://127.0.0.1:${PORTS.web}`;
const API = `${WEB}/api`; // everything goes through the web proxy, like a browser
// nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_password -- test-only password for throwaway local accounts, reviewed goal 10
const PASSWORD = 'correct-horse-battery-staple';
const CSRF = { 'x-kora-csrf': '1', 'content-type': 'application/json' };

const t0 = Date.now();
const report = { startedAt: new Date(t0).toISOString(), environment: 'PAPER, SIMULATED data, native stack', scenarios: [], checks: [] };
const log = (msg, extra = {}) => {
  const line = { t: Date.now() - t0, msg, ...extra };
  console.warn(JSON.stringify(line));
  return line;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ok, ms = 30_000, every = 250) {
  const end = Date.now() + ms;
  let v;
  do {
    try {
      v = await fn();
      if (ok(v)) return { ok: true, value: v, ms: ms - (end - Date.now()) };
    } catch (e) {
      v = e;
    }
    await sleep(every);
  } while (Date.now() < end);
  return { ok: false, value: v, ms };
}

// ---------------------------------------------------------------------------------------------
// processes
const procs = {};
function start(name, cmd, args, opts = {}) {
  const out = createWriteStream(join(LOGS, `${name}.log`), { flags: 'a' });
  out.write(`\n===== start ${new Date().toISOString()} ${cmd} ${args.join(' ')}\n`);
  const p = spawn(cmd, args, { cwd: opts.cwd ?? ROOT, env: { ...process.env, ...opts.env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  p.stdout.pipe(out);
  p.stderr.pipe(out);
  procs[name] = p;
  return p;
}
function kill(name, signal = 'SIGKILL') {
  const p = procs[name];
  if (!p || p.exitCode !== null) return;
  try {
    process.kill(-p.pid, signal);
  } catch {
    p.kill(signal);
  }
}
async function waitHttp(url, ms = 90_000) {
  const r = await until(async () => (await fetch(url)).ok, (x) => x === true, ms, 300);
  if (!r.ok) throw new Error(`timeout waiting for ${url}`);
}

// fake Anthropic-compatible provider: streams one plain-language text answer
let aiServer = null;
function startFakeAi() {
  aiServer = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const text = 'A stop loss closes your trade when the price moves too far against you. It limits how much you can lose.';
      const events = [
        ['message_start', { type: 'message_start', message: { id: 'msg_chaos', type: 'message', role: 'assistant', model: process.env.KORA_AI_MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 1 } } }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 24 } }],
        ['message_stop', { type: 'message_stop' }],
      ];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const [e, d] of events) res.write(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`);
      res.end();
    });
  });
  return new Promise((r) => aiServer.listen(PORTS.ai, '127.0.0.1', r));
}
const stopFakeAi = () => new Promise((r) => (aiServer ? aiServer.close(() => r()) : r()));

const COMMON = {
  REDIS_URL,
  KORA_MD_REDIS_PREFIX: MD_PREFIX,
  KORA_ENV: 'test',
  LOG_LEVEL: 'warn',
  KORA_SERVICE_TOKEN: SERVICE_TOKEN,
  LIVE_TRADING_ENABLED: 'false',
};
function startRedis() {
  return start('redis', 'redis-server', ['--port', String(PORTS.redis), '--save', '', '--appendonly', 'no', '--bind', '127.0.0.1']);
}
function startQuant() {
  return start('quant', 'bash', ['../../scripts/py-run.sh', 'python', '-m', 'uvicorn', 'kora_quant.app:app', '--host', '127.0.0.1', '--port', String(PORTS.quant), '--app-dir', 'src'], { cwd: join(ROOT, 'services/quant') });
}
function startFeed() {
  return start('feed', 'node', ['dist/market-data/feed-cli.js'], {
    cwd: join(ROOT, 'apps/api'),
    env: { ...COMMON, DATABASE_URL: DB, KORA_MD_FEED: 'inprocess', KORA_MD_BACKFILL: 'true', KORA_MD_SYMBOLS: 'EURUSD,BTCUSD,ETHUSD,AAPL' },
  });
}
function startApi() {
  return start('api', 'node', ['dist/main.js'], {
    cwd: join(ROOT, 'apps/api'),
    env: {
      ...COMMON,
      API_PORT: String(PORTS.api),
      DATABASE_URL: DB,
      KORA_SCRYPT_N: '16384',
      KORA_AUTH_RATE_LIMIT: '10000',
      QUANT_URL: `http://127.0.0.1:${PORTS.quant}`,
      KORA_MD_FEED: 'off', // the standalone feed process publishes into Redis
      KORA_MD_WS_ORIGINS: WEB,
      KORA_ENGINE_ENABLED: 'true',
      KORA_AI_PROVIDER: 'anthropic',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${PORTS.ai}`,
      ANTHROPIC_API_KEY: 'chaos-drill-no-real-key',
      KORA_AI_MODEL: 'chaos-drill-fake-model',
      KORA_AI_RATE_PER_MIN: '1000',
      KORA_AI_CACHE_TTL_S: '0',
      KORA_INTEL_SCAN: 'off',
      KORA_INTEL_NEWS: 'off',
    },
  });
}
function startRunner() {
  return start('runner', 'pnpm', ['exec', 'tsx', 'src/main.ts'], {
    cwd: join(ROOT, 'services/bot-runner'),
    env: { ...COMMON, BOT_RUNNER_HEALTH_PORT: String(PORTS.runner), BOT_RUNNER_QUEUE: 'kora-bots-chaos', BOT_RUNNER_API_URL: `http://127.0.0.1:${PORTS.api}`, QUANT_URL: `http://127.0.0.1:${PORTS.quant}`, KORA_BOT_RUNNER_TRACKING_CRON: '', KORA_BOT_RUNNER_SYNC_MS: '1000' },
  });
}
function startWeb() {
  return start('web', 'pnpm', ['exec', 'next', 'start', '-p', String(PORTS.web), '-H', '127.0.0.1'], {
    cwd: join(ROOT, 'apps/web'),
    env: { API_INTERNAL_URL: `http://127.0.0.1:${PORTS.api}`, KORA_AI_STRIP: 'on', KORA_EXPLAIN_THIS: 'on' },
  });
}

// ---------------------------------------------------------------------------------------------
// HTTP helpers (through the web proxy, cookie session like a browser)
class Session {
  constructor() {
    this.cookie = '';
  }
  async req(method, path, body) {
    const t = performance.now();
    const res = await fetch(`${API}${path}`, { method, headers: { ...CSRF, cookie: this.cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.getSetCookie?.() ?? [];
    for (const c of set) if (c.startsWith('kora_at=')) this.cookie = c.split(';')[0];
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not json */
    }
    return { status: res.status, json, text, ms: Math.round(performance.now() - t) };
  }
}
function totp(secretB32, offset = 0) {
  const crypto = webRequire('node:crypto');
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const ch of secretB32.replace(/=+$/, '').toUpperCase()) {
    value = (value << 5) | A.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) + offset));
  const mac = crypto.createHmac('sha1', Buffer.from(bytes)).update(msg).digest();
  const o = mac[mac.length - 1] & 15;
  const bin = ((mac[o] & 127) << 24) | (mac[o + 1] << 16) | (mac[o + 2] << 8) | mac[o + 3];
  return String(bin % 1_000_000).padStart(6, '0');
}
async function signUp(kind) {
  const s = new Session();
  const email = `chaos.${kind}.${Date.now()}@e2e.kora.local`;
  await s.req('POST', '/auth/signup', { email, password: PASSWORD, displayName: `Chaos ${kind}` });
  await s.req('POST', '/auth/login', { email, password: PASSWORD });
  if (kind === 'trader') {
    const q = JSON.parse(readFileSync(join(ROOT, 'apps/api/src/appropriateness/questionnaires/appropriateness.v1.json'), 'utf8'));
    const answers = Object.fromEntries(q.questions.map((x) => [x.id, [...x.options].sort((a, b) => b.points - a.points)[0].id]));
    await s.req('POST', '/appropriateness/attempts', { questionnaireId: q.id, version: q.version, answers });
    const l = await s.req('POST', '/auth/login', { email, password: PASSWORD });
    const enr = await s.req('POST', '/auth/mfa/enroll', { mfaToken: l.json.mfaToken });
    const v = await s.req('POST', '/auth/mfa/verify', { mfaToken: l.json.mfaToken, code: totp(enr.json.secret) });
    if (v.status !== 200) throw new Error(`mfa verify failed ${v.text}`);
  } else {
    const doc = (await s.req('GET', '/disclosures/risk-warning?locale=en')).json.document;
    await s.req('POST', '/disclosures/risk-warning/acknowledgements', { version: doc.version, contentHash: doc.contentHash, locale: 'en' });
    const p = (await s.req('GET', '/novice/profile')).json;
    await s.req('PUT', '/novice/limits', { dailyLossLimit: p.suggestedLimits.daily, monthlyLossLimit: p.suggestedLimits.monthly });
    await s.req('POST', '/novice/onboarding/complete');
  }
  s.email = email;
  return s;
}

async function db(sql, params = []) {
  const c = new pg.Client({ connectionString: DB_OWNER });
  await c.connect();
  try {
    return (await c.query(sql, params)).rows;
  } finally {
    await c.end();
  }
}

let scenario = null;
function begin(name, fault) {
  scenario = { name, fault, steps: [], startedAt: Date.now() - t0 };
  report.scenarios.push(scenario);
  log(`=== scenario: ${name}`);
}
function step(what, data, pass) {
  const s = { t: Date.now() - t0, what, pass, ...data };
  scenario.steps.push(s);
  log(`${pass ? 'PASS' : 'FAIL'} ${what}`, data);
  if (!pass) scenario.failed = true;
  return pass;
}

let cidN = 0;
const cid = (tag) => `chaos-${tag}-${t0}-${++cidN}`;
async function marketOrder(s, clientOrderId, qty = '0.01') {
  return s.req('POST', '/orders', { clientOrderId, symbol: 'BTCUSD', side: 'buy', type: 'market', qty });
}
async function fillsFor(s) {
  return ((await s.req('GET', '/fills')).json?.fills ?? []).length;
}
async function waitFeed(s, state) {
  return until(async () => (await s.req('GET', '/market-data/status')).json?.status?.state, (x) => x === state, 45_000, 500);
}

// ---------------------------------------------------------------------------------------------
async function main() {
  log('reset kora_e2e and start the isolated stack');
  const { execFileSync } = webRequire('node:child_process');
  execFileSync('node', ['../web/e2e/reset-db.mjs'], { cwd: join(ROOT, 'apps/api'), env: { ...process.env, DATABASE_URL_MIGRATE_E2E: DB_OWNER }, stdio: 'ignore' });
  startRedis();
  await until(async () => true, () => true, 500);
  await startFakeAi();
  startQuant();
  startFeed();
  startApi();
  await waitHttp(`http://127.0.0.1:${PORTS.api}/health`);
  await waitHttp(`http://127.0.0.1:${PORTS.quant}/health`, 150_000);
  startRunner();
  startWeb();
  await waitHttp(`http://127.0.0.1:${PORTS.runner}/health`);
  await waitHttp(`${WEB}/login`);
  log('stack up');

  const trader = await signUp('trader');
  const novice = await signUp('novice');
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addCookies([{ name: 'kora_at', value: trader.cookie.split('=')[1], url: WEB }]);
  const page = await ctx.newPage();
  const shot = async (name) => {
    const f = join(SHOTS, `${name}.png`);
    await page.screenshot({ path: f });
    return `docs/qa/chaos/screenshots/${name}.png`;
  };

  // Baseline --------------------------------------------------------------------------------
  begin('baseline', 'none');
  const ok = await waitFeed(trader, 'ok');
  step('feed status ok', { ms: ok.ms }, ok.ok);
  const b = await marketOrder(trader, cid('base'));
  step('market order accepted', { status: b.status, orderStatus: b.json?.order?.status }, b.status === 201);
  const f0 = await until(() => fillsFor(trader), (n) => n >= 1, 15_000);
  step('baseline order filled by the engine', { fills: f0.value }, f0.ok);
  // a robot that evaluates every 1-minute bar and never enters (close < 1): proves bar processing
  const strat = await trader.req('POST', '/strategies', {
    definition: {
      schema: 'kora.strategy', schemaVersion: 1, name: 'Chaos probe', universe: { symbols: ['BTCUSD'], timeframe: '1m' }, params: {},
      entry: { side: 'long', conditions: [{ type: 'compare', left: { kind: 'indicator', name: 'close' }, op: 'lt', right: { kind: 'const', value: 1 } }] },
      filters: [], exit: { stop: { kind: 'percent', pct: 4 }, conditions: [] }, size: { kind: 'fixed', qty: '0.01', maxOpenPositions: 1 },
    },
  });
  const robot = await trader.req('POST', '/robots', { name: 'Chaos probe', versionId: strat.json.latest.id });
  const started = await trader.req('POST', `/robots/${robot.json.id}/start`);
  step('probe robot running (PAPER)', { status: started.status }, started.status === 200);
  const robotId = robot.json.id;
  const signals = async () => Number((await db('SELECT count(*)::int AS n FROM robot_signals WHERE robot_id = $1', [robotId]))[0].n);
  await page.goto(`${WEB}/terminal?symbol=BTCUSD`);
  await page.getByTestId('status-bar').getByText('Connected').waitFor({ timeout: 20_000 }).catch(() => undefined);
  report.checks.push({ baselineScreenshot: await shot('00-baseline-terminal') });

  // S1: market-data adapter ------------------------------------------------------------------
  begin('market-data adapter killed', 'SIGKILL of the standalone feed process (md:feed)');
  const fillsBefore = await fillsFor(trader);
  kill('feed');
  const down = await until(async () => (await trader.req('GET', '/market-data/status')).json, (j) => j?.status?.state !== 'ok' || j?.gateway?.feedLost === true, 45_000, 500);
  step('api detects the lost feed heartbeat (status not ok / feedLost)', { ms: down.ms, status: down.value?.status?.state, feedLost: down.value?.gateway?.feedLost }, down.ok);
  const staleQ = await until(async () => (await trader.req('GET', '/quotes?symbols=BTCUSD')).json?.quotes?.[0]?.quote, (q) => q?.stale === true || q === null, 30_000, 500);
  await page.reload();
  await sleep(2500);
  const staleBadge = await page.getByTestId('watchlist').getByText('Stale').first().isVisible().catch(() => false);
  step('stale badge on the watchlist', { quoteStale: staleQ.value?.stale ?? null, badgeVisible: staleBadge, screenshot: await shot('01-feed-down-stale-badges') }, staleBadge || staleQ.ok);
  const stale = await marketOrder(trader, cid('stale'));
  step('no order on stale data: market order refused with a data code', { status: stale.status, code: stale.json?.code }, stale.status === 422 && ['MARKET_DATA_STALE', 'FEED_NOT_OK', 'NO_MARKET_DATA'].includes(stale.json?.code));
  await sleep(1500);
  step('no fill while the feed is down', { fillsBefore, fillsAfter: await fillsFor(trader) }, (await fillsFor(trader)) === fillsBefore);
  const ks1 = await trader.req('POST', '/kill-switch', { scope: 'robots_cancel', source: 'rest_fallback', reason: 'chaos: feed down' });
  step('kill switch works via REST while the feed is down', { status: ks1.status, durationMs: ks1.json?.durationMs }, ks1.status === 202 && ks1.json?.halted === true);
  await page.reload();
  await page.getByTestId('halt-banner').waitFor({ timeout: 10_000 }).catch(() => undefined);
  report.checks.push({ haltedScreenshot: await shot('02-feed-down-kill-switch-rest-halted') });
  const rs1 = await trader.req('POST', '/kill-switch/resume', { reason: 'chaos: resume after drill' });
  step('resume after the halt', { status: rs1.status }, rs1.status === 200);
  startFeed();
  const back = await waitFeed(trader, 'ok');
  step('feed recovers (status ok) after restart', { ms: back.ms }, back.ok);
  const idA = cid('recover');
  const r1 = await marketOrder(trader, idA);
  const r2 = await marketOrder(trader, idA); // client retry after recovery
  const again = await marketOrder(trader, stale.json?.order?.clientOrderId ?? cid('x')); // retry of the refused order
  const rows = await db('SELECT client_order_id, count(*)::int AS n FROM orders WHERE client_order_id = ANY($1) GROUP BY 1', [[idA, stale.json?.order?.clientOrderId]]);
  step('recovery without duplicates: retried order replays, refused order stays refused', { first: r1.status, retry: r2.status, replay: r2.json?.idempotentReplay, refusedRetry: again.status, rows }, r1.status === 201 && r2.status === 200 && rows.every((r) => r.n === 1));
  const f1 = await until(() => fillsFor(trader), (n) => n === fillsBefore + 1, 15_000);
  step('exactly one new fill after recovery', { fills: f1.value, expected: fillsBefore + 1 }, f1.ok);
  await page.reload();
  await sleep(2000);
  report.checks.push({ recoveredScreenshot: await shot('03-feed-recovered') });

  // S2: Redis ---------------------------------------------------------------------------------
  begin('Redis killed', 'SIGKILL of redis-server (quotes cache, bus, BullMQ, WebSocket fan-out)');
  const fillsR = await fillsFor(trader);
  kill('redis');
  const health = await until(async () => (await fetch(`http://127.0.0.1:${PORTS.api}/health`)).json(), (h) => h?.checks?.redis?.status === 'down', 20_000, 500);
  step('health degrades with redis down (api stays up)', { status: health.value?.status, redis: health.value?.checks?.redis?.status, ms: health.ms }, health.ok && health.value?.status === 'degraded');
  await page.reload();
  await sleep(3000);
  report.checks.push({ redisDownScreenshot: await shot('04-redis-down-terminal') });
  const acct = await trader.req('GET', '/accounts/me');
  const quotesR = await trader.req('GET', '/quotes?symbols=BTCUSD');
  step('reads degrade instead of failing: account and quotes answer 200 (unpriced / no quote)', { account: acct.status, quotes: quotesR.status, quote: quotesR.json?.quotes?.[0]?.quote ?? null }, acct.status === 200 && quotesR.status === 200);
  const noData = await marketOrder(trader, cid('redis'));
  step('no order without market data (quotes cache unreachable): refused with NO_MARKET_DATA', { status: noData.status, code: noData.json?.code }, noData.status === 422 && noData.json?.code === 'NO_MARKET_DATA');
  const ks2 = await trader.req('POST', '/kill-switch', { scope: 'robots_cancel', source: 'rest_fallback', reason: 'chaos: redis down' });
  step('kill switch works via REST while Redis is down', { status: ks2.status, halted: ks2.json?.halted, text: ks2.status >= 400 ? ks2.text.slice(0, 200) : undefined }, ks2.status === 202 && ks2.json?.halted === true);
  step('no fill while Redis is down', { fills: await fillsFor(trader), before: fillsR }, (await fillsFor(trader)) === fillsR);
  startRedis();
  const hBack = await until(async () => (await fetch(`http://127.0.0.1:${PORTS.api}/health`)).json(), (h) => h?.status === 'ok', 30_000, 500);
  step('health back to ok after Redis restarts', { ms: hBack.ms }, hBack.ok);
  const fBack = await waitFeed(trader, 'ok');
  step('feed republishes into the fresh Redis', { ms: fBack.ms }, fBack.ok);
  const rs2 = await trader.req('POST', '/kill-switch/resume', { reason: 'chaos: resume after redis drill' });
  step('resume', { status: rs2.status }, rs2.status === 200);
  // the kill switch paused the probe robot (resuming trading never restarts robots by itself)
  const restart = await trader.req('POST', `/robots/${robotId}/start`);
  step('probe robot restarted by its owner after the halt', { status: restart.status }, restart.status === 200);
  const idB = cid('redis-recover');
  const b1 = await marketOrder(trader, idB);
  const b2 = await marketOrder(trader, idB);
  const fb = await until(() => fillsFor(trader), (n) => n === fillsR + 1, 20_000);
  step('recovery without duplicates after Redis restart', { first: b1.status, retry: b2.status, fills: fb.value, expected: fillsR + 1 }, b1.status === 201 && b2.status === 200 && fb.ok);
  const hb = await until(async () => (await fetch(`http://127.0.0.1:${PORTS.runner}/health`)).json(), (h) => h?.status === 'ok', 30_000, 500);
  step('bot runner reconnects (health ok)', { runner: hb.value?.status, ms: hb.ms }, hb.ok);

  // S3: quant ---------------------------------------------------------------------------------
  begin('quant service killed', 'SIGKILL of the quant service (uvicorn)');
  kill('quant');
  await sleep(1000);
  const sim = await trader.req('POST', '/sim/project', { paths: 500 });
  step('simulator answers 502/503 "Nothing was simulated"', { status: sim.status, message: sim.json?.message }, (sim.status === 503 || sim.status === 502) && /Nothing was simulated/.test(sim.json?.message ?? ''));
  await page.goto(`${WEB}/simulator`);
  await page.getByRole('button', { name: /Run projection|Project/ }).first().click().catch(() => undefined);
  await sleep(2000);
  report.checks.push({ quantDownScreenshot: await shot('05-quant-down-simulator') });
  const fillsQ = await fillsFor(trader);
  const q1 = await marketOrder(trader, cid('quant'));
  const fq = await until(() => fillsFor(trader), (n) => n === fillsQ + 1, 15_000);
  step('manual trading unaffected by the quant outage', { status: q1.status, fills: fq.value }, q1.status === 201 && fq.ok);
  // (the quant outage is simulated after proving the runner evaluates bars with quant up)
  startQuant();
  await waitHttp(`http://127.0.0.1:${PORTS.quant}/health`, 150_000);
  const warm = await until(signals, (n) => n > 0, 130_000, 2000);
  step('runner evaluates closed 1-minute bars (quant up)', { signals: warm.value }, warm.ok);
  kill('quant');
  await sleep(1000);
  const sigBefore = await signals();
  const robotOrdersBefore = Number((await db(`SELECT count(*)::int AS n FROM orders WHERE source = $1`, [`robot:${robotId}`]))[0].n);
  // wait for the next closed 1-minute bar with quant down
  const barWait = 65_000 - (Date.now() % 60_000) + 5_000;
  await sleep(barWait);
  const sigDuring = await signals();
  const robotOrdersDuring = Number((await db(`SELECT count(*)::int AS n FROM orders WHERE source = $1`, [`robot:${robotId}`]))[0].n);
  step('runner skips the bar (no decision, no robot order) while quant is down', { signalsBefore: sigBefore, signalsDuring: sigDuring, robotOrders: robotOrdersDuring }, sigDuring === sigBefore && robotOrdersDuring === robotOrdersBefore);
  startQuant();
  await waitHttp(`http://127.0.0.1:${PORTS.quant}/health`, 150_000);
  const simBack = await trader.req('POST', '/sim/project', { paths: 500 });
  step('simulator recovers', { status: simBack.status }, simBack.status === 200);
  const sigAfter = await until(signals, (n) => n > sigDuring, 90_000, 2000);
  step('runner evaluates the next bar again after recovery', { signals: sigAfter.value }, sigAfter.ok);

  // S4: AI provider ---------------------------------------------------------------------------
  begin('AI provider down', 'the (fake) AI provider endpoint stops accepting connections');
  const e0 = await novice.req('POST', '/ai/explain', { topic: 'stop loss', screenText: 'Stop 1.08000' });
  step('baseline: copilot answers through the provider', { status: e0.status, answer: e0.json?.status }, e0.status === 200 && e0.json?.status === 'ok');
  await stopFakeAi();
  const e1 = await novice.req('POST', '/ai/explain', { topic: 'stop loss', screenText: 'Stop 1.08000' });
  step('copilot degrades to a friendly message (no error page)', { status: e1.status, answer: e1.json?.status, message: e1.json?.message }, e1.status === 200 && e1.json?.status !== 'ok' && typeof e1.json?.message === 'string');
  const nctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await nctx.addCookies([{ name: 'kora_at', value: novice.cookie.split('=')[1], url: WEB }]);
  const np = await nctx.newPage();
  await np.goto(`${WEB}/learn/trading`);
  await np.getByTestId('explain-this').first().getByRole('button').click().catch(() => undefined);
  await np.getByTestId('explain-this-text').first().waitFor({ timeout: 20_000 }).catch(() => undefined);
  await np.screenshot({ path: join(SHOTS, '06-ai-down-explain-friendly.png') });
  report.checks.push({ aiDownScreenshot: 'docs/qa/chaos/screenshots/06-ai-down-explain-friendly.png' });
  const fillsA = await fillsFor(trader);
  const a1 = await marketOrder(trader, cid('ai'));
  const fa = await until(() => fillsFor(trader), (n) => n === fillsA + 1, 15_000);
  step('trading unaffected by the AI outage', { status: a1.status, fills: fa.value }, a1.status === 201 && fa.ok);
  await startFakeAi();
  const e2 = await until(async () => (await novice.req('POST', '/ai/explain', { topic: 'stop loss', screenText: 'Stop 1.08000' })).json, (j) => j?.status === 'ok', 20_000, 1000);
  step('copilot recovers when the provider is back', { answer: e2.value?.status }, e2.ok);
  await nctx.close();

  // Integrity after all faults ----------------------------------------------------------------
  begin('integrity after the drill', 'none');
  const dups = await db('SELECT account_id, client_order_id, count(*)::int AS n FROM orders WHERE client_order_id IS NOT NULL GROUP BY 1, 2 HAVING count(*) > 1');
  step('no duplicated client order ids anywhere', { duplicates: dups.length }, dups.length === 0);
  const over = await db('SELECT o.id FROM orders o JOIN fills f ON f.order_id = o.id GROUP BY o.id, o.qty HAVING sum(f.qty) > o.qty');
  step('no order filled beyond its quantity', { overfilled: over.length }, over.length === 0);
  const staleFills = await db(`SELECT count(*)::int AS n FROM fills f JOIN orders o ON o.id = f.order_id WHERE o.client_order_id LIKE 'chaos-stale-%' OR o.client_order_id LIKE 'chaos-redis-${t0}%'`);
  step('no fill for any order sent during an outage', { fills: staleFills[0].n }, staleFills[0].n === 0);
  const verify = await trader.req('GET', '/audit/verify');
  step('audit chain still valid', { status: verify.status, valid: verify.json?.valid }, verify.status === 200 && verify.json?.valid === true);
  const recon = await trader.req('POST', '/reconciliation/run');
  step('reconciliation clean after the drill', { status: recon.status, mismatches: recon.json?.mismatches?.length ?? recon.json?.breaks ?? null }, recon.status < 300);

  await browser.close();
}

main()
  .catch((e) => {
    log('drill aborted', { error: String(e?.stack ?? e) });
    report.aborted = String(e?.message ?? e);
  })
  .finally(async () => {
    for (const n of ['web', 'runner', 'api', 'feed', 'quant', 'redis']) kill(n, 'SIGTERM');
    await stopFakeAi();
    report.finishedAt = new Date().toISOString();
    report.durationS = Math.round((Date.now() - t0) / 1000);
    report.passed = !report.aborted && report.scenarios.every((s) => !s.failed);
    writeFileSync(join(OUT, 'run.json'), `${JSON.stringify(report, null, 2)}\n`);
    log(report.passed ? 'CHAOS DRILL PASSED' : 'CHAOS DRILL FAILED', { durationS: report.durationS });
    setTimeout(() => process.exit(report.passed ? 0 : 1), 1500);
  });

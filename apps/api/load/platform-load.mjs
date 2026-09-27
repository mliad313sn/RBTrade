#!/usr/bin/env node
/**
 * Goal 10 platform load test (S10, S3). k6 cannot be downloaded here (GitHub assets blocked), so the
 * load comes from an open-loop node:http generator (constant arrival rate, like k6's
 * constant-arrival-rate executor) and `ws` clients in worker threads for streaming. The
 * goal 02 fan-out harness (ws-fanout.mjs) covers "200 symbols streaming" on its own.
 *
 * Scenarios (one isolated stack: kora_e2e reset, api build with the in-process SIMULATED feed and
 * backfill, quant, bot runner):
 *   A. 500 concurrent terminal users: 500 WebSocket clients streaming quotes + 500 HTTP connections
 *      polling the terminal's REST reads (quotes, account, positions, open orders, candles).
 *   B. Order burst: 100 orders/s for 30 s (3,000 market orders over 100 accounts) through POST /orders.
 *   C. 50 bots on 1-minute bars: 50 PAPER robots on BTC/USD and ETH/USD, three bar closes.
 * Server-side: the api's /metrics histograms (order ack, HTTP) are scraped at the end.
 *
 * Usage (repo root): pnpm build && node apps/api/load/platform-load.mjs [--duration 30] [--quick]
 * Output: apps/api/load/results/platform-<iso>.json (summarised in docs/qa/load.md).
 */
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { createHmac } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '../../..');
const req = createRequire(join(ROOT, 'apps/api/package.json'));

// ---------------------------------------------------------------------------------------------
// worker: WebSocket clients (scenario A)
if (!isMainThread) {
  const WebSocket = req('ws');
  const { url, token, clients, symbols, durationMs } = workerData;
  const lat = [];
  let msgs = 0;
  let errors = 0;
  let opened = 0;
  const socks = [];
  for (let i = 0; i < clients; i++) {
    const ws = new WebSocket(url, { headers: { origin: 'http://127.0.0.1:3050' } });
    socks.push(ws);
    ws.on('open', () => {
      opened += 1;
      ws.send(JSON.stringify({ op: 'auth', token: token[i % token.length] }));
    });
    ws.on('message', (raw) => {
      msgs += 1;
      try {
        const m = JSON.parse(raw.toString());
        if (m.type === 'authenticated') ws.send(JSON.stringify({ op: 'subscribe', channels: symbols.map((s) => `quotes:${s}`) }));
        const q = m.data ?? m;
        if (q && typeof q.receivedTs === 'number' && lat.length < 200_000) lat.push(Date.now() - q.receivedTs);
      } catch {
        /* heartbeat or non-JSON */
      }
    });
    ws.on('error', () => (errors += 1));
  }
  setTimeout(() => {
    for (const s of socks) s.terminate();
    parentPort.postMessage({ lat, msgs, errors, opened });
  }, durationMs);
} else {
  await main();
}

async function main() {
  const pg = req('pg');
  const args = process.argv.slice(2);
  const opt = (k, d) => {
    const i = args.indexOf(`--${k}`);
    return i >= 0 ? Number(args[i + 1]) : d;
  };
  const QUICK = args.includes('--quick');
  const onlyIdx = args.indexOf('--only');
  const ONLY = onlyIdx >= 0 ? args[onlyIdx + 1].split(',') : ['A', 'B', 'C'];
  const otelIdx = args.indexOf('--otel');
  const OTEL = otelIdx >= 0 ? args[otelIdx + 1] : '';
  // --prof DIR: CPU profile of the api process (written when the harness stops it).
  const profIdx = args.indexOf('--prof');
  const PROF = profIdx >= 0 ? resolve(args[profIdx + 1]) : '';
  const RATE = opt('rate', 100);
  const DURATION = opt('duration', QUICK ? 10 : 30);
  const envFile = join(ROOT, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const DB = process.env.DATABASE_URL_E2E;
  const DB_OWNER = process.env.DATABASE_URL_MIGRATE_E2E;
  const PORT = 4050;
  const QPORT = 8050;
  const RPORT = 4150;
  const API = `http://127.0.0.1:${PORT}`;
  const TOKEN = 'load-only-service-token-0123456789abcdef';
  const PREFIX = `kora:load:${Date.now()}:md:`;
  // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_password -- test-only password for throwaway local accounts, reviewed goal 10
  const PASSWORD = 'correct-horse-battery-staple';
  const out = { startedAt: new Date().toISOString(), host: hostInfo(), scenarios: {} };
  const procs = [];
  const log = (m, x = {}) => console.warn(JSON.stringify({ t: new Date().toISOString(), m, ...x }));

  function start(name, cmd, a, o) {
    const p = spawn(cmd, a, { ...o, env: { ...process.env, ...o.env }, stdio: ['ignore', 'ignore', 'pipe'], detached: true });
    p.stderr.on('data', (d) => {
      const s = d.toString();
      if (/error/i.test(s) && !/ECONNRESET/.test(s)) log(`${name} stderr`, { line: s.slice(0, 300) });
    });
    procs.push(p);
    return p;
  }
  async function waitHttp(url, ms = 120_000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      try {
        if ((await fetch(url)).ok) return;
      } catch {
        /* not yet */
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error(`timeout ${url}`);
  }
  const db = async (sql, p = []) => {
    const c = new pg.Client({ connectionString: DB_OWNER });
    await c.connect();
    try {
      return (await c.query(sql, p)).rows;
    } finally {
      await c.end();
    }
  };

  try {
    log('reset kora_e2e');
    execFileSync('node', ['../web/e2e/reset-db.mjs'], { cwd: join(ROOT, 'apps/api'), env: { ...process.env }, stdio: 'ignore' });
    start('quant', 'bash', ['../../scripts/py-run.sh', 'python', '-m', 'uvicorn', 'kora_quant.app:app', '--host', '127.0.0.1', '--port', String(QPORT), '--app-dir', 'src', '--workers', '2'], { cwd: join(ROOT, 'services/quant'), env: {} });
    start('api', 'node', ['dist/main.js'], {
      cwd: join(ROOT, 'apps/api'),
      env: {
        API_PORT: String(PORT), DATABASE_URL: DB, KORA_ENV: 'test', LOG_LEVEL: 'error', KORA_SCRYPT_N: '16384',
        KORA_AUTH_RATE_LIMIT: '100000', KORA_API_RATE_LIMIT: '10000000', KORA_ORDER_RATE_LIMIT: '1000000',
        KORA_RISK_MAX_ORDERS_PER_MINUTE: '1000', KORA_MD_WS_MAX_CONN_PER_IP: '2000', KORA_MD_WS_MAX_CONN_PER_USER: '50',
        KORA_MD_FEED: 'inprocess', KORA_MD_BACKFILL: 'true', KORA_MD_SYMBOLS: 'BTCUSD,ETHUSD,EURUSD,XAUUSD,AAPL',
        KORA_MD_REDIS_PREFIX: PREFIX, KORA_MD_WS_ORIGINS: 'http://127.0.0.1:3050', KORA_ENGINE_ENABLED: 'true',
        KORA_SERVICE_TOKEN: TOKEN, QUANT_URL: `http://127.0.0.1:${QPORT}`, KORA_AI_PROVIDER: 'scripted',
        KORA_INTEL_SCAN: 'off', KORA_INTEL_NEWS: 'off', KORA_ROBOT_MAX_PER_USER: '100',
        ...(OTEL ? { KORA_OTEL_FILE: OTEL } : {}),
        ...(PROF ? { NODE_OPTIONS: `--cpu-prof --cpu-prof-dir=${PROF} --require ${join(here, 'exit-on-sigterm.cjs')}` } : {}),
        ...(process.env.KORA_DB_POOL_MAX ? { KORA_DB_POOL_MAX: process.env.KORA_DB_POOL_MAX } : {}),
      },
    });
    await waitHttp(`${API}/health`);
    await waitHttp(`http://127.0.0.1:${QPORT}/health`, 180_000);
    start('runner', 'pnpm', ['exec', 'tsx', 'src/main.ts'], {
      cwd: join(ROOT, 'services/bot-runner'),
      env: { BOT_RUNNER_HEALTH_PORT: String(RPORT), BOT_RUNNER_QUEUE: `kora-bots-load-${Date.now()}`, BOT_RUNNER_API_URL: API, QUANT_URL: `http://127.0.0.1:${QPORT}`, KORA_SERVICE_TOKEN: TOKEN, KORA_MD_REDIS_PREFIX: PREFIX, KORA_BOT_RUNNER_TRACKING_CRON: '', KORA_BOT_RUNNER_SYNC_MS: '1000', LOG_LEVEL: 'warn' },
    });
    await waitHttp(`http://127.0.0.1:${RPORT}/health`);

    // users -------------------------------------------------------------------------------
    const NUSERS = QUICK ? 20 : 100;
    log(`creating ${NUSERS} traders`);
    const q = JSON.parse(readFileSync(join(ROOT, 'apps/api/src/appropriateness/questionnaires/appropriateness.v1.json'), 'utf8'));
    const answers = Object.fromEntries(q.questions.map((x) => [x.id, [...x.options].sort((a, b) => b.points - a.points)[0].id]));
    const J = { 'content-type': 'application/json', 'x-kora-csrf': '1' };
    // Each simulated user is its own client address (the api trusts loopback proxies), so per-IP
    // protections such as the appropriateness attempt limit apply per user as in production.
    const post = async (path, body, token, ip = '10.0.0.1') =>
      (await fetch(`${API}${path}`, { method: 'POST', headers: { ...J, 'x-forwarded-for': ip, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body ?? {}) })).json();
    const users = [];
    for (let i = 0; i < NUSERS; i += 10) {
      const batch = await Promise.all(
        Array.from({ length: Math.min(10, NUSERS - i) }, async (_, k) => {
          const email = `load.${Date.now()}.${i + k}@load.kora.local`;
          const ip = `10.0.${(i + k) >> 8}.${((i + k) & 255) || 1}`;
          await post('/auth/signup', { email, password: PASSWORD, displayName: 'Load' }, undefined, ip);
          const l1 = await post('/auth/login', { email, password: PASSWORD }, undefined, ip);
          await post('/appropriateness/attempts', { questionnaireId: q.id, version: q.version, answers }, l1.accessToken, ip);
          const l2 = await post('/auth/login', { email, password: PASSWORD }, undefined, ip);
          const enr = await post('/auth/mfa/enroll', { mfaToken: l2.mfaToken }, undefined, ip);
          const v = await post('/auth/mfa/verify', { mfaToken: l2.mfaToken, code: totp(enr.secret) }, undefined, ip);
          return v.accessToken;
        }),
      );
      users.push(...batch);
    }
    if (users.some((t) => !t)) throw new Error('user creation failed');
    log('users ready');

    // A. 500 terminal users ------------------------------------------------------------------
    if (ONLY.includes('A')) {
      const WS_CLIENTS = QUICK ? 100 : 500;
      const workers = 4;
      const wsDone = Array.from({ length: workers }, (_, w) =>
        new Promise((resolveW) => {
          const worker = new Worker(fileURLToPath(import.meta.url), {
            workerData: { url: `ws://127.0.0.1:${PORT}/ws`, token: users.slice(w * 10, w * 10 + 10), clients: WS_CLIENTS / workers, symbols: ['BTCUSD', 'ETHUSD', 'EURUSD', 'XAUUSD', 'AAPL'], durationMs: (DURATION + 5) * 1000 },
          });
          worker.on('message', resolveW);
        }),
      );
      await new Promise((r) => setTimeout(r, 3000));
      const paths = ['/quotes?symbols=BTCUSD,ETHUSD,EURUSD,XAUUSD,AAPL', '/accounts/me', '/positions', '/orders?status=open', '/candles?symbol=BTCUSD&tf=1m&limit=200', '/market-data/status'];
      let n = 0;
      const rest = await openLoop({
        url: API,
        rate: QUICK ? 100 : 500, // each terminal user polls about once a second
        durationS: DURATION,
        next: () => ({ method: 'GET', tag: paths[n % paths.length].split('?')[0], path: paths[n % paths.length], headers: { authorization: `Bearer ${users[n++ % users.length]}` } }),
      });
      const ws = await Promise.all(wsDone);
      const lat = ws.flatMap((x) => x.lat).sort((a, b) => a - b);
      out.scenarios.A_terminal_users = {
        wsClients: WS_CLIENTS,
        wsOpened: ws.reduce((s, x) => s + x.opened, 0),
        wsErrors: ws.reduce((s, x) => s + x.errors, 0),
        wsMessages: ws.reduce((s, x) => s + x.msgs, 0),
        wsQuoteAgeMs: { p50: q_(lat, 0.5), p95: q_(lat, 0.95), p99: q_(lat, 0.99), n: lat.length },
        rest,
      };
      log('A done', out.scenarios.A_terminal_users);
    }

    // B. order burst 100/s ---------------------------------------------------------------------
    if (ONLY.includes('B')) {
      let k = 0;
      const tag = `burst-${Date.now()}`;
      // Open loop: one order every 1000/RATE ms whatever the server does (a closed-loop generator
      // slows down with the server and hides queueing). Latency = request written → body read.
      const burst = await openLoop({
        url: API,
        rate: RATE,
        durationS: DURATION,
        next: () => {
          const i = k++;
          const sym = i % 2 ? 'ETHUSD' : 'BTCUSD';
          const side = Math.floor(i / 200) % 2 ? 'sell' : 'buy';
          return { method: 'POST', path: '/orders', headers: { 'content-type': 'application/json', authorization: `Bearer ${users[i % users.length]}` }, body: JSON.stringify({ clientOrderId: `${tag}-${i}`, symbol: sym, side, type: 'market', qty: sym === 'BTCUSD' ? '0.001' : '0.01' }) };
        },
      });
      // Spike (informational): 100 orders sent at the same instant, three times, 2 s apart.
      const spikes = [];
      for (let sIdx = 0; sIdx < 3; sIdx++) {
        await new Promise((r) => setTimeout(r, 2000));
        spikes.push(await openLoop({ url: API, rate: 100_000, durationS: 100 / 100_000, next: () => { const i = k++; return { method: 'POST', path: '/orders', headers: { 'content-type': 'application/json', authorization: `Bearer ${users[i % users.length]}` }, body: JSON.stringify({ clientOrderId: `${tag}-${i}`, symbol: 'BTCUSD', side: i % 2 ? 'sell' : 'buy', type: 'market', qty: '0.001' }) }; } }));
      }
      const sl = spikes.flatMap((x) => [x.latencyMs.p50, x.latencyMs.p99, x.latencyMs.max]);
      const spike = { orders: 300, simultaneous: 100, worstP50Ms: Math.max(...sl.filter((_, i) => i % 3 === 0)), worstP99Ms: Math.max(...sl.filter((_, i) => i % 3 === 1)), maxMs: Math.max(...sl.filter((_, i) => i % 3 === 2)), errors: spikes.reduce((a, x) => a + x.errors, 0), statusCodes: spikes.map((x) => x.statusCodes) };
      await new Promise((r) => setTimeout(r, 3000));
      const rows = await db(`SELECT status, reject_code, count(*)::int AS n FROM orders WHERE client_order_id LIKE $1 GROUP BY 1, 2 ORDER BY 3 DESC`, [`${tag}-%`]);
      const dups = await db(`SELECT count(*)::int AS n FROM (SELECT client_order_id FROM orders WHERE client_order_id LIKE $1 GROUP BY 1 HAVING count(*) > 1) d`, [`${tag}-%`]);
      const fills = await db(`SELECT count(*)::int AS n FROM fills f JOIN orders o ON o.id = f.order_id WHERE o.client_order_id LIKE $1`, [`${tag}-%`]);
      out.scenarios.B_order_burst = { targetRatePerS: RATE, http: burst, spike, ordersByStatus: rows, duplicates: dups[0].n, fills: fills[0].n };
      log('B done', out.scenarios.B_order_burst);
    }

    // C. 50 bots on 1-minute bars ---------------------------------------------------------------
    if (ONLY.includes('C')) {
      const NBOTS = QUICK ? 10 : 50;
      const ids = [];
      for (let i = 0; i < NBOTS; i++) {
        const token = users[i % users.length];
        const sym = i % 2 ? 'ETHUSD' : 'BTCUSD';
        const enter = i % 5 === 0; // every fifth robot trades an SMA cross; the rest evaluate and hold
        const def = {
          schema: 'kora.strategy', schemaVersion: 1, name: `Load bot ${i}`, universe: { symbols: [sym], timeframe: '1m' },
          params: { fast: { value: 3, integer: true }, slow: { value: 8, integer: true } },
          entry: enter
            ? { side: 'long', conditions: [{ type: 'cross', left: { kind: 'indicator', name: 'sma', period: { param: 'fast' } }, direction: 'above', right: { kind: 'indicator', name: 'sma', period: { param: 'slow' } } }] }
            : { side: 'long', conditions: [{ type: 'compare', left: { kind: 'indicator', name: 'close' }, op: 'lt', right: { kind: 'const', value: 1 } }] },
          filters: [], exit: { stop: { kind: 'percent', pct: 4 }, conditions: [] }, size: { kind: 'fixed', qty: sym === 'BTCUSD' ? '0.001' : '0.01', maxOpenPositions: 1 },
        };
        const s = await post('/strategies', { definition: def }, token);
        const r = await post('/robots', { name: `Load ${i}`, versionId: s.latest.id }, token);
        await post(`/robots/${r.id}/start`, {}, token);
        ids.push(r.id);
      }
      const t0 = Date.now();
      const bars = QUICK ? 1 : 3;
      const until = Math.ceil(t0 / 60_000) * 60_000 + bars * 60_000 + 20_000;
      log(`C: ${NBOTS} robots running, waiting for ${bars} bar closes`);
      while (Date.now() < until) await new Promise((r) => setTimeout(r, 2000));
      const sig = await db(
        `SELECT extract(epoch FROM (created_at - (bar_ts + interval '1 minute'))) * 1000 AS ms, outcome, bar_ts FROM robot_signals WHERE robot_id = ANY($1::uuid[]) AND created_at >= to_timestamp($2 / 1000.0)`,
        [ids, t0],
      );
      const ms = sig.map((r) => Number(r.ms)).sort((a, b) => a - b);
      const perBar = {};
      for (const r of sig) perBar[new Date(r.bar_ts).toISOString()] = (perBar[new Date(r.bar_ts).toISOString()] ?? 0) + 1;
      const outcomes = {};
      for (const r of sig) outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
      // Kill switch while the robots run: 10 owners hit robots_cancel_flatten at once (goal 03: < 2 s).
      const owners = [...new Set(Array.from({ length: NBOTS }, (_, i) => users[i % users.length]))].slice(0, 10);
      const kt0 = performance.now();
      const ks = await Promise.all(
        owners.map(async (t) => {
          // nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request -- loopback api started by this harness, reviewed goal 10
          const r = await fetch(`${API}/kill-switch`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` }, body: JSON.stringify({ scope: 'robots_cancel_flatten', source: 'rest_fallback', reason: 'load test' }) });
          return { status: r.status, body: await r.json() };
        }),
      );
      const killWallMs = Math.round(performance.now() - kt0);
      await new Promise((r) => setTimeout(r, 1500));
      const ownedIds = ids.filter((_, i) => owners.includes(users[i % users.length]));
      const stillRunning = await db(`SELECT count(*)::int AS n FROM robots WHERE id = ANY($1::uuid[]) AND status = 'running'`, [ownedIds]);
      const killSwitch = { triggers: ks.length, statuses: ks.map((x) => x.status), durationMs: ks.map((x) => x.body.durationMs ?? null), wallMs: killWallMs, ownersRobots: ownedIds.length, ownersRobotsStillRunning: stillRunning[0].n };
      out.scenarios.C_bots = {
        killSwitch, robots: NBOTS, barsObserved: Object.keys(perBar).length, decisionsPerBar: perBar, outcomes, barCloseToDecisionMs: { p50: q_(ms, 0.5), p95: q_(ms, 0.95), p99: q_(ms, 0.99), max: ms[ms.length - 1] ?? null, n: ms.length } };
      log('C done', out.scenarios.C_bots);
    }

    // server-side metrics ----------------------------------------------------------------------
    // nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request -- loopback api started by this harness, reviewed goal 10
    const metrics = await (await fetch(`${API}/metrics`)).text();
    out.serverMetrics = {
      orderAck: histQuantiles(metrics, 'kora_order_submit_seconds', (l) => !l.includes('outcome="error"')),
      http: histQuantiles(metrics, 'kora_http_request_duration_seconds', () => true),
    };
    const dups = await db('SELECT count(*)::int AS n FROM (SELECT account_id, client_order_id FROM orders WHERE client_order_id IS NOT NULL GROUP BY 1, 2 HAVING count(*) > 1) d');
    // nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request -- loopback api started by this harness, reviewed goal 10
    out.integrity = { duplicateClientOrderIds: dups[0].n, auditChain: await (await fetch(`${API}/health`)).json().then((h) => h.status) };
  } finally {
    for (const p of procs) {
      try {
        process.kill(-p.pid, 'SIGTERM');
      } catch {
        /* gone */
      }
    }
    out.finishedAt = new Date().toISOString();
    mkdirSync(join(here, 'results'), { recursive: true });
    const f = join(here, 'results', `platform-${out.startedAt.replace(/[:.]/g, '-')}.json`);
    writeFileSync(f, `${JSON.stringify(out, null, 2)}\n`);
    log('written', { file: f });
    setTimeout(() => process.exit(0), 1000);
  }
}

// ---------------------------------------------------------------------------------------------
async function openLoop({ url, rate, durationS, next }) {
  const http = req('node:http');
  const agent = new http.Agent({ keepAlive: true, maxSockets: 512 });
  const u = new URL(url);
  const lat = [];
  const byTag = {};
  const codes = {};
  let errors = 0;
  let sent = 0;
  const pending = [];
  const t0 = performance.now();
  const total = Math.round(rate * durationS);
  while (sent < total) {
    const due = t0 + (sent * 1000) / rate;
    const wait = due - performance.now();
    if (wait > 1) await new Promise((r) => setTimeout(r, wait));
    const r = next();
    sent += 1;
    pending.push(
      new Promise((done) => {
        const start = performance.now();
        const rq = http.request({ agent, host: u.hostname, port: u.port, method: r.method, path: r.path, headers: { ...r.headers, 'content-length': Buffer.byteLength(r.body ?? '') } }, (res) => {
          res.resume();
          res.on('end', () => {
            const ms = performance.now() - start;
            lat.push(ms);
            if (r.tag) (byTag[r.tag] ??= []).push(ms);
            codes[res.statusCode] = (codes[res.statusCode] ?? 0) + 1;
            done();
          });
        });
        rq.setTimeout(10_000, () => rq.destroy(new Error('timeout')));
        rq.on('error', () => {
          errors += 1;
          done();
        });
        rq.end(r.body);
      }),
    );
  }
  await Promise.all(pending);
  agent.destroy();
  const wall = (performance.now() - t0) / 1000;
  lat.sort((a, b) => a - b);
  const ok = Object.entries(codes).filter(([c]) => c < 300).reduce((a, [, n]) => a + n, 0);
  return {
    generator: 'open loop (node:http)',
    requests: sent,
    achievedRatePerS: Math.round((sent / wall) * 10) / 10,
    latencyMs: { p50: q_(lat, 0.5), p95: q_(lat, 0.95), p99: q_(lat, 0.99), max: q_(lat, 1) },
    ...(Object.keys(byTag).length
      ? { perPathMs: Object.fromEntries(Object.entries(byTag).map(([t, v]) => (v.sort((a, b) => a - b), [t, { p50: q_(v, 0.5), p95: q_(v, 0.95), p99: q_(v, 0.99), n: v.length }]))) }
      : {}),
    errorRate: Math.round(((sent - ok) / sent) * 10000) / 10000,
    errors,
    statusCodes: codes,
  };
}
function q_(sorted, p) {
  if (!sorted.length) return null;
  return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] * 10) / 10;
}
function histQuantiles(text, name, keep) {
  const buckets = new Map();
  let total = 0;
  for (const line of text.split('\n')) {
    if (!line.startsWith(`${name}_bucket{`) || !keep(line)) continue;
    const le = /le="([^"]+)"/.exec(line)[1];
    const v = Number(line.split(' ').pop());
    buckets.set(le, (buckets.get(le) ?? 0) + v);
  }
  const les = [...buckets.keys()].sort((a, b) => (a === '+Inf' ? 1 : b === '+Inf' ? -1 : Number(a) - Number(b)));
  total = buckets.get('+Inf') ?? 0;
  const q = (p) => {
    const target = p * total;
    for (const le of les) if (buckets.get(le) >= target) return le === '+Inf' ? '>max bucket' : `≤ ${Number(le) * 1000} ms`;
    return null;
  };
  let sum = 0;
  for (const line of text.split('\n')) if (line.startsWith(`${name}_sum{`) && keep(line)) sum += Number(line.split(' ').pop());
  return { count: total, meanMs: total ? Math.round((sum / total) * 10000) / 10 : null, p50: q(0.5), p95: q(0.95), p99: q(0.99), buckets: Object.fromEntries(les.map((le) => [le, buckets.get(le)])) };
}
function totp(secret) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const ch of secret.replace(/=+$/, '').toUpperCase()) {
    value = (value << 5) | A.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const mac = createHmac('sha1', Buffer.from(bytes)).update(msg).digest();
  const o = mac[mac.length - 1] & 15;
  const bin = ((mac[o] & 127) << 24) | (mac[o + 1] << 16) | (mac[o + 2] << 8) | mac[o + 3];
  return String(bin % 1_000_000).padStart(6, '0');
}
function hostInfo() {
  const os = req('node:os');
  return { cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model, memGb: Math.round(os.totalmem() / 1e9), node: process.version, note: 'single shared cloud VM: generator, api, quant, runner, Postgres and Redis on the same host' };
}

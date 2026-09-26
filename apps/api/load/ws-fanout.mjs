#!/usr/bin/env node
/**
 * WebSocket fan-out load test (goal 02 acceptance): N symbols × R msg/s published on the Redis bus,
 * C WebSocket clients each subscribed to K symbols, measuring fan-out latency = client receive time −
 * publish time (same host clock, sub-millisecond via performance.timeOrigin + performance.now()).
 *
 * Why Node and not k6/artillery: the k6 binary download is blocked by this environment's egress
 * proxy (HTTP 403 on GitHub release assets), and artillery's WS engine cannot read a server-published
 * timestamp per message without a custom processor. This script uses the same `ws` client library as
 * the api tests and runs clients in worker threads so the generator does not starve itself.
 * A k6 script with the same scenario is committed next to it (ws-fanout.k6.js) for CI/Docker.
 *
 * Usage (from repo root, dev DB running, api built):
 *   pnpm --filter @kora/api build && pnpm --filter @kora/api load:ws -- --clients 500 --symbols 200 --rate 10 --per-client 20 --duration 30
 * The script starts its own api (feed OFF, isolated Redis prefix) on kora_test and seeds SIMULATED
 * LOADTEST instruments there; integration tests recreate that schema on their next run.
 */
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

const here = dirname(fileURLToPath(import.meta.url));
const now = () => performance.timeOrigin + performance.now();

// ---------------------------------------------------------------------------------------------
// Histogram: 0.05 ms buckets up to 2 s.
const BUCKET_MS = 0.05;
const BUCKETS = 40_000;
function newHist() {
  return { counts: new Uint32Array(BUCKETS + 1), n: 0, max: 0, sum: 0 };
}
function record(h, ms) {
  const v = ms < 0 ? 0 : ms;
  h.counts[Math.min(BUCKETS, Math.floor(v / BUCKET_MS))] += 1;
  h.n += 1;
  h.sum += v;
  if (v > h.max) h.max = v;
}
function merge(into, h) {
  for (let i = 0; i <= BUCKETS; i++) into.counts[i] += h.counts[i];
  into.n += h.n;
  into.sum += h.sum;
  into.max = Math.max(into.max, h.max);
}
function pct(h, q) {
  const target = Math.ceil(q * h.n);
  let acc = 0;
  for (let i = 0; i <= BUCKETS; i++) {
    acc += h.counts[i];
    if (acc >= target) return (i + 1) * BUCKET_MS;
  }
  return h.max;
}

// Deterministic symbol choice per client (no Math.random).
function* lcg(seed) {
  let s = seed >>> 0;
  for (;;) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    yield s;
  }
}

// ---------------------------------------------------------------------------------------------
if (!isMainThread && workerData.role === 'publisher') {
  const { default: Redis } = await import('ioredis');
  const { redisUrl, prefix, symbols, rate, tickMs } = workerData;
  const r = new Redis(redisUrl, { enableAutoPipelining: true });
  const perTick = (symbols.length * rate * tickMs) / 1000;
  let seq = 0;
  let cursor = 0;
  let carry = 0;
  let stop = false;
  let published = 0;
  parentPort.on('message', (m) => {
    if (m === 'stop') stop = true;
  });
  const status = setInterval(() => {
    r.publish(`${prefix}status`, JSON.stringify({ type: 'status', state: 'ok', ts: Date.now(), feeds: [], staleSymbols: [], reason: 'LOADTEST' }));
  }, 500);
  const start = now();
  let tick = 0;
  while (!stop) {
    carry += perTick;
    const n = Math.floor(carry);
    carry -= n;
    for (let i = 0; i < n; i++) {
      const sym = symbols[cursor];
      cursor = (cursor + 1) % symbols.length;
      seq += 1;
      const t = now();
      r.publish(
        `${prefix}quotes:${sym}`,
        `{"type":"quote","symbol":"${sym}","bid":"1.00000","ask":"1.00002","bidSize":"1000000","askSize":"1000000","stale":false,"source":"loadtest","exchangeTs":${Math.floor(t)},"receivedTs":${Math.floor(t)},"seq":${seq},"pubTs":${t}}`,
      );
      published += 1;
    }
    tick += 1;
    const wait = start + tick * tickMs - now();
    if (wait > 0) await new Promise((res) => setTimeout(res, wait));
  }
  clearInterval(status);
  await r.quit();
  parentPort.postMessage({ published });
}

// ---------------------------------------------------------------------------------------------
if (!isMainThread && workerData.role === 'clients') {
  const { WebSocket } = await import('ws');
  const { url, token, clients, symbols, perClient, seedBase } = workerData;
  const hist = newHist();
  let measuring = false;
  let received = 0;
  let snapshots = 0;
  let closed = 0;
  let errors = 0;
  const sockets = [];
  const connectOne = (idx) =>
    new Promise((res) => {
      const rnd = lcg(seedBase + idx);
      const chosen = new Set();
      while (chosen.size < perClient) chosen.add(symbols[rnd.next().value % symbols.length]);
      const ws = new WebSocket(url, { perMessageDeflate: false });
      sockets.push(ws);
      ws.on('open', () => {
        ws.send(JSON.stringify({ op: 'auth', token }));
        ws.send(JSON.stringify({ op: 'subscribe', channels: [...chosen].map((s) => `quotes:${s}`) }));
      });
      ws.on('message', (buf) => {
        const t = now();
        const s = buf.toString();
        if (!s.startsWith('{"ch"')) {
          if (JSON.parse(s).type === 'subscribed') res(true);
          return;
        }
        if (s.startsWith('"snapshot":true', s.indexOf(',') + 1)) {
          snapshots += 1;
          return;
        }
        if (!measuring) return;
        received += 1;
        const i = s.lastIndexOf('"pubTs":') + 8;
        record(hist, t - Number(s.slice(i, s.indexOf('}', i))));
      });
      ws.on('close', () => (closed += 1));
      ws.on('error', () => {
        errors += 1;
        res(false);
      });
    });
  for (let i = 0; i < clients; i += 25) await Promise.all(Array.from({ length: Math.min(25, clients - i) }, (_, j) => connectOne(i + j)));
  parentPort.postMessage({ type: 'ready' });
  let elu0 = null;
  parentPort.on('message', (m) => {
    if (m === 'measure') {
      measuring = true;
      elu0 = performance.eventLoopUtilization();
    }
    if (m === 'report') {
      measuring = false;
      const elu = performance.eventLoopUtilization(elu0).utilization;
      parentPort.postMessage({ type: 'report', hist: { counts: hist.counts, n: hist.n, max: hist.max, sum: hist.sum }, received, snapshots, closed, errors, elu });
      for (const s of sockets) s.terminate();
    }
  });
}

// ---------------------------------------------------------------------------------------------
if (isMainThread) {
  const args = Object.fromEntries(
    process.argv
      .slice(2)
      .filter((a) => a !== '--')
      .reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1]]] : acc), []),
  );
  const cfg = {
    clients: Number(args.clients ?? 500),
    symbols: Number(args.symbols ?? 200),
    rate: Number(args.rate ?? 10),
    perClient: Number(args['per-client'] ?? 20),
    duration: Number(args.duration ?? 30),
    warmup: Number(args.warmup ?? 5),
    workers: Number(args.workers ?? 3),
    port: Number(args.port ?? 4020),
  };
  const root = resolve(here, '../../..');
  const envFile = resolve(root, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const prefix = 'kora:load:md:';
  const symbols = Array.from({ length: cfg.symbols }, (_, i) => `LOADTEST${String(i + 1).padStart(3, '0')}`);

  // Seed SIMULATED load-test instruments into kora_test.
  const { default: pg } = await import('pg');
  const owner = new pg.Client({ connectionString: process.env.DATABASE_URL_MIGRATE_TEST });
  await owner.connect();
  await owner.query(
    `INSERT INTO instruments (symbol, display_name, venue, asset_class, base_ccy, quote_ccy, tick_size, price_precision, pip_size, contract_size, min_qty, qty_step, qty_precision, fee_schedule_id, simulated)
     SELECT s, 'LOADTEST SIMULATED ' || s, 'KSIM', 'fx', 'EUR', 'USD', 0.00001, 5, 0.0001, 100000, 1000, 1000, 0, 'sim-fx', true FROM unnest($1::text[]) s
     ON CONFLICT DO NOTHING`,
    [symbols],
  );
  await owner.end();

  const nodeArgs = args['api-node-args'] ? String(args['api-node-args']).split(' ') : [];
  const api = spawn(process.execPath, [...nodeArgs, 'dist/main.js'], {
    cwd: resolve(here, '..'),
    env: {
      ...process.env,
      API_PORT: String(cfg.port),
      DATABASE_URL: process.env.DATABASE_URL_TEST,
      KORA_ENV: 'test',
      NODE_ENV: 'test',
      LOG_LEVEL: 'warn',
      KORA_SCRYPT_N: '16384',
      KORA_AUTH_RATE_LIMIT: '10000',
      KORA_MD_FEED: 'off',
      KORA_MD_REDIS_PREFIX: prefix,
      KORA_MD_WS_MAX_CHANNELS: String(Math.max(300, cfg.perClient)),
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const base = `http://127.0.0.1:${cfg.port}`;
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${base}/health`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (i > 100) throw new Error('api did not start');
    await new Promise((r) => setTimeout(r, 200));
  }
  const email = `load.${Date.now()}@test.kora.local`;
  const password = 'correct-horse-battery-staple';
  const headers = { 'content-type': 'application/json', 'x-kora-csrf': '1' };
  await fetch(`${base}/auth/signup`, { method: 'POST', headers, body: JSON.stringify({ email, password, displayName: 'Load test', accountType: 'novice' }) });
  const login = await (await fetch(`${base}/auth/login`, { method: 'POST', headers, body: JSON.stringify({ email, password }) })).json();
  const token = login.accessToken;

  const cpuTicks = () => {
    const f = readFileSync(`/proc/${api.pid}/stat`, 'utf8').split(') ')[1].split(' ');
    return Number(f[11]) + Number(f[12]);
  };
  const rssMb = () => Number(readFileSync(`/proc/${api.pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)/)[1]) / 1024;

  const publisher = new Worker(fileURLToPath(import.meta.url), {
    workerData: { role: 'publisher', redisUrl: process.env.REDIS_URL, prefix, symbols, rate: cfg.rate, tickMs: 5 },
  });
  const per = Math.ceil(cfg.clients / cfg.workers);
  const workers = Array.from({ length: cfg.workers }, (_, w) => {
    const n = Math.max(0, Math.min(per, cfg.clients - w * per));
    return new Worker(fileURLToPath(import.meta.url), {
      workerData: { role: 'clients', url: `ws://127.0.0.1:${cfg.port}/ws`, token, clients: n, symbols, perClient: cfg.perClient, seedBase: w * 100_000 },
    });
  }).filter((_, w) => Math.min(per, cfg.clients - w * per) > 0);
  const once = (w, type) => new Promise((res) => w.on('message', (m) => m.type === type && res(m)));
  const t0 = Date.now();
  await Promise.all(workers.map((w) => once(w, 'ready')));
  const connectSec = (Date.now() - t0) / 1000;
  console.warn(`[load] ${cfg.clients} clients connected and subscribed in ${connectSec.toFixed(1)} s; warming up ${cfg.warmup} s`);
  await new Promise((r) => setTimeout(r, cfg.warmup * 1000));
  const cpu0 = cpuTicks();
  const m0 = Date.now();
  for (const w of workers) w.postMessage('measure');
  await new Promise((r) => setTimeout(r, cfg.duration * 1000));
  const status = await (await fetch(`${base}/market-data/status`, { headers: { authorization: `Bearer ${token}` } })).json();
  const reports = await Promise.all(workers.map((w) => (w.postMessage('report'), once(w, 'report'))));
  const measuredSec = (Date.now() - m0) / 1000;
  const cpuPct = ((cpuTicks() - cpu0) / 100 / measuredSec) * 100;
  const rss = rssMb();
  publisher.postMessage('stop');
  const pubDone = await new Promise((res) => publisher.on('message', res));
  api.kill('SIGTERM');

  const hist = newHist();
  let received = 0;
  let closed = 0;
  let errors = 0;
  const clientElu = reports.map((r) => +r.elu.toFixed(2));
  for (const r of reports) {
    merge(hist, { counts: r.hist.counts, n: r.hist.n, max: r.hist.max, sum: r.hist.sum });
    received += r.received;
    closed += r.closed;
    errors += r.errors;
  }
  const expected = cfg.clients * cfg.perClient * cfg.rate * measuredSec;
  const result = {
    date: new Date().toISOString(),
    host: { cpus: (await import('node:os')).cpus().length, node: process.version },
    scenario: { ...cfg, wsFlushMs: Number(process.env.KORA_MD_WS_FLUSH_MS ?? 0), conflation: '10/s token bucket, burst 2', ingressPerSec: cfg.symbols * cfg.rate, egressPerSecTarget: cfg.clients * cfg.perClient * cfg.rate },
    connectSeconds: +connectSec.toFixed(2),
    measuredSeconds: +measuredSec.toFixed(2),
    published: pubDone.published,
    received,
    deliveredRatio: +(received / expected).toFixed(4),
    egressPerSec: Math.round(received / measuredSec),
    latencyMs: { mean: +(hist.sum / hist.n).toFixed(2), p50: +pct(hist, 0.5).toFixed(2), p95: +pct(hist, 0.95).toFixed(2), p99: +pct(hist, 0.99).toFixed(2), max: +hist.max.toFixed(2) },
    gateway: { cpuPercent: +cpuPct.toFixed(1), rssMb: +rss.toFixed(0), ...status.gateway },
    loadGenerator: { clientWorkerEventLoopUtilization: clientElu, hostLoadAvg1m: +(await import('node:os')).loadavg()[0].toFixed(2) },
    clientErrors: errors,
    clientClosesDuringRun: closed,
    pass: pct(hist, 0.99) < 50,
  };
  const outDir = resolve(here, 'results');
  mkdirSync(outDir, { recursive: true });
  const out = resolve(outDir, `ws-fanout-${cfg.clients}c-${cfg.symbols}s-${cfg.perClient}k-flush${Number(process.env.KORA_MD_WS_FLUSH_MS ?? 0)}.json`);
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  console.warn(`[load] p99 fan-out latency ${result.latencyMs.p99} ms → ${result.pass ? 'PASS' : 'FAIL'} (< 50 ms). Wrote ${out}`);
  process.exit(result.pass ? 0 : 1);
}

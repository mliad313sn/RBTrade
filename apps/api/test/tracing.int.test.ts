// Goal 10 (S10): OpenTelemetry traces across services, proven end to end with the file exporter.
// Every service runs as its own process with its production bootstrap (api `dist/main.js` with
// http/express/pg/undici instrumentation, the bot runner, quant with its middleware):
// 1. an order is traced from the ticket (a client traceparent, as the web sends through its
//    proxy) through the api's HTTP span, `oms.submit`, `risk.evaluate`, Postgres, to the engine's
//    asynchronous `engine.fill`;
// 2. api → quant joins the same trace (gain simulator);
// 3. a robot's bar close is one trace: runner → api → quant → api.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import type { StrategyDefinition } from '@kora/domain';
import { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bearer, createUser, type TestUser } from './helpers';
import { robotHeartbeatKey } from '../src/robots/robot-channels';
import { MarketFixture } from './market-fixture';
import { clearCandles, freePort, seedCandles, startBotRunner, startQuant, TOKEN, wave, type Spawned } from './robot-helpers';

interface SpanLine {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  service: string | null;
  attributes: Record<string, unknown>;
}

const ROOT = resolve(__dirname, '../../..');
const M = 60_000;

function readSpans(file: string): SpanLine[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as SpanLine);
}

async function until<T>(fn: () => T | Promise<T>, ok: (v: T) => boolean, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  let v = await fn();
  while (!ok(v) && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 150));
    v = await fn();
  }
  return v;
}

const newTraceparent = () => {
  const traceId = randomBytes(16).toString('hex');
  return { traceId, header: `00-${traceId}-${randomBytes(8).toString('hex')}-01` };
};

describe('distributed traces (goal 10)', () => {
  const dir = join(tmpdir(), `kora-traces-${process.pid}-${Date.now()}`);
  const files = { api: `${dir}-api.jsonl`, quant: `${dir}-quant.jsonl`, runner: `${dir}-runner.jsonl` };
  const prefix = `kora:test:${process.pid}:trace:md:`;
  let quant: Spawned;
  let runner: Spawned;
  let api: { url: string; stop: () => Promise<void>; logs: string[]; flush: () => Promise<void> };
  let app: INestApplication;
  let trader: TestUser;
  const md = new MarketFixture();

  beforeAll(async () => {
    process.env.KORA_MD_REDIS_PREFIX = prefix; // the fixture writes where the child api reads
    const fixture = new MarketFixture();
    Object.assign(md, fixture);
    process.env.KORA_OTEL_FILE = files.quant;
    quant = await startQuant();
    delete process.env.KORA_OTEL_FILE;
    const port = await freePort();
    // The production build (decorator metadata needs tsc; CI builds before the integration stage).
    const proc = spawn('node', ['dist/main.js'], {
      cwd: resolve(ROOT, 'apps/api'),
      env: {
        ...process.env,
        API_PORT: String(port),
        KORA_OTEL_FILE: files.api,
        OTEL_SERVICE_NAME: 'kora-api',
        QUANT_URL: quant.url,
        KORA_MD_FEED: 'off',
        KORA_MD_REDIS_PREFIX: prefix,
        KORA_ENGINE_ENABLED: 'true',
        KORA_RECONCILIATION_INTERVAL_MS: '0',
        KORA_SERVICE_TOKEN: TOKEN,
        KORA_INTEL_SCAN: 'off',
        KORA_INTEL_NEWS: 'off',
        KORA_ALERTS_ENABLED: 'false',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    const logs: string[] = [];
    proc.stdout?.on('data', (d: Buffer) => logs.push(d.toString()));
    proc.stderr?.on('data', (d: Buffer) => logs.push(d.toString()));
    const url = `http://127.0.0.1:${port}`;
    const up = await until(
      async () => (await fetch(`${url}/health`).catch(() => null))?.ok ?? false,
      (x) => x,
      60_000,
    );
    if (!up) throw new Error(`api did not start: ${logs.join('').slice(-3000)}`);
    api = {
      url,
      logs,
      // IRTC R6: deterministic export. SIGUSR2 makes the api force-flush its span processor and then
      // append a line to `<file>.flush`; the spans ended before the signal are in the file after it.
      flush: async () => {
        const marks = () => (existsSync(`${files.api}.flush`) ? readFileSync(`${files.api}.flush`, 'utf8').split('\n').filter(Boolean).length : 0);
        const before = marks();
        process.kill(proc.pid!, 'SIGUSR2');
        const after = await until(marks, (n) => n > before, 10_000);
        if (after <= before) throw new Error('the api did not acknowledge the span flush');
      },
      stop: async () => {
        try {
          process.kill(-proc.pid!, 'SIGTERM');
        } catch {
          /* already gone */
        }
        await new Promise((r) => setTimeout(r, 500));
      },
    };
    // helpers accept anything with getHttpServer(); supertest takes a URL string
    app = { getHttpServer: () => url } as unknown as INestApplication;
    trader = await createUser(app, 'trader', [], { realClock: true });
    await md.status({ state: 'ok', feed: 'up', staleSymbols: [], ts: null });
    await md.quote('BTCUSD', '64811.5', '64813.5');
  }, 240_000);

  afterAll(async () => {
    await runner?.stop();
    await api?.stop();
    await quant?.stop();
    await md.close();
    for (const f of Object.values(files)) rmSync(f, { force: true });
    rmSync(`${files.api}.flush`, { force: true });
    delete process.env.KORA_MD_REDIS_PREFIX;
  });

  /** Flush the api's exporter, read, and repeat (a bounded number of times) until `ok`. */
  async function untilFlushed<T>(read: () => T, ok: (v: T) => boolean, rounds = 20): Promise<T> {
    let v = read();
    for (let i = 0; i < rounds && !ok(v); i++) {
      await api.flush();
      v = read();
    }
    return v;
  }

  it('an order is one trace from the ticket to the fill (http → oms.submit → risk → pg → engine.fill)', async () => {
    const tp = newTraceparent();
    await md.quote('BTCUSD', '64811.5', '64813.5');
    const placed = await request(api.url)
      .post('/orders')
      .set(bearer(trader.token))
      .set('traceparent', tp.header)
      .send({ clientOrderId: `trace-${process.pid}`, symbol: 'BTCUSD', side: 'buy', type: 'market', qty: '0.01' });
    expect(placed.status, JSON.stringify(placed.body)).toBe(201);
    // the engine loop fills on the next quote
    await md.quote('BTCUSD', '64812.5', '64814.5');
    const fills = await until(
      async () => (await request(api.url).get('/fills').set(bearer(trader.token))).body.fills as unknown[],
      (f) => f.length > 0,
    );
    expect(fills.length).toBeGreaterThan(0);
    // The fill is committed before its span ends: flush (deterministic) until the span is exported.
    const spans = await untilFlushed(() => readSpans(files.api).filter((s) => s.traceId === tp.traceId), (s) => s.some((x) => x.name === 'engine.fill'));
    const names = spans.map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(['oms.submit', 'risk.evaluate', 'engine.fill']));
    expect(names.some((n) => /^POST( \/orders)?$/.test(n)), names.join(', ')).toBe(true); // http server span
    expect(spans.some((s) => s.attributes['db.system'] === 'postgresql' || s.attributes['db.system.name'] === 'postgresql')).toBe(true);
    const submit = spans.find((s) => s.name === 'oms.submit')!;
    const fill = spans.find((s) => s.name === 'engine.fill')!;
    expect(fill.parentSpanId).toBe(submit.spanId); // the asynchronous fill hangs under the ticket
    expect(fill.attributes['kora.order_id']).toBe(placed.body.order.id);
  });

  it('api → quant joins the caller’s trace (gain simulator)', async () => {
    const tp = newTraceparent();
    await request(api.url).post('/sim/project').set(bearer(trader.token)).set('traceparent', tp.header).send({ paths: 500 }).expect(200);
    const q = await until(
      () => readSpans(files.quant).filter((s) => s.traceId === tp.traceId),
      (s) => s.length > 0,
    );
    expect(q.map((s) => s.name)).toContain('POST /mc/project');
    // The api batches span exports; flush it instead of waiting for the batch delay.
    const apiSpans = await untilFlushed(
      () => readSpans(files.api).filter((s) => s.traceId === tp.traceId),
      (s) => s.some((x) => x.spanId === q[0]!.parentSpanId),
    );
    // quant's server span is a child of the api's outgoing (undici) client span
    expect(apiSpans.map((s) => s.spanId)).toContain(q[0]!.parentSpanId);
  });

  it('a robot bar close is one trace: runner → api → quant → api', async () => {
    const redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: 2 });
    try {
      const t0 = Math.floor(Date.now() / M) * M - 60 * M;
      const bars = wave(60, t0, M, { base: 64000, amp: 120, period: 16, tick: 0.1 });
      await clearCandles('BTCUSD', '1m');
      await seedCandles('BTCUSD', '1m', bars, 1);
      runner = await startBotRunner({
        BOT_RUNNER_API_URL: api.url,
        QUANT_URL: quant.url,
        KORA_SERVICE_TOKEN: TOKEN,
        KORA_MD_REDIS_PREFIX: prefix,
        KORA_BOT_RUNNER_SYNC_MS: '300',
        KORA_OTEL_FILE: files.runner,
      });
      const def: StrategyDefinition = {
        schema: 'kora.strategy',
        schemaVersion: 1,
        name: 'Trace probe',
        universe: { symbols: ['BTCUSD'], timeframe: '1m' },
        params: {},
        entry: { side: 'long', conditions: [{ type: 'compare', left: { kind: 'indicator', name: 'close' }, op: 'lt', right: { kind: 'const', value: 1 } }] },
        filters: [],
        exit: { stop: { kind: 'percent', pct: 4 }, conditions: [] },
        size: { kind: 'fixed', qty: '0.01', maxOpenPositions: 1 },
      };
      const s = await request(api.url).post('/strategies').set(bearer(trader.token)).send({ definition: def }).expect(201);
      const r = await request(api.url).post('/robots').set(bearer(trader.token)).send({ name: 'Trace', versionId: s.body.latest.id }).expect(201);
      await request(api.url).post(`/robots/${r.body.id}/start`).set(bearer(trader.token)).expect(200);
      await until(async () => !!(await redis.get(robotHeartbeatKey(r.body.id))), (x) => x, 15_000);
      const last = bars[bars.length - 1]!;
      const publish = () =>
        redis.publish(
          `${prefix}candles:BTCUSD:1m`,
          JSON.stringify({ type: 'candle', symbol: 'BTCUSD', tf: '1m', bucket: last.t, open: last.o.toFixed(1), high: last.h.toFixed(1), low: last.l.toFixed(1), close: last.c.toFixed(1), volume: '1', trades: 1, closed: true, source: 'simulated', seq: 1, exchangeTs: last.t + M, receivedTs: Date.now() }),
        );
      await publish();
      const barSpan = await until(
        () => readSpans(files.runner).find((x) => x.name === 'runner.bar_close'),
        (x) => !!x,
        15_000,
      );
      expect(barSpan, runner.logs.join('').slice(-1500)).toBeDefined();
      const traceId = barSpan!.traceId;
      const apiSpans = await untilFlushed(
        () => readSpans(files.api).filter((x) => x.traceId === traceId),
        (x) => x.length >= 2,
      );
      const quantSpans = readSpans(files.quant).filter((x) => x.traceId === traceId);
      expect(quantSpans.map((x) => x.name)).toContain('POST /bt/signal');
      expect(apiSpans.length).toBeGreaterThanOrEqual(2); // context + decision requests
      const runnerSpanIds = readSpans(files.runner).filter((x) => x.traceId === traceId).map((x) => x.spanId);
      expect(runnerSpanIds).toContain(quantSpans[0]!.parentSpanId);
      // Leave no running robot behind for later files (their robot supervisor would pause it).
      await request(api.url).post(`/robots/${r.body.id}/pause`).set(bearer(trader.token)).expect(200);
    } finally {
      redis.disconnect();
    }
  });
});

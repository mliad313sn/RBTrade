import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { QueueEvents } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { heartbeatKey, ROBOT_CONTROL_CHANNEL, ROBOT_EVENTS_CHANNEL } from './bots.js';
import { loadConfig, loadEnv, type RunnerConfig } from './config.js';
import { barJobId, handleJob, RejectedJobError } from './jobs.js';
import { startRunner, type Runner } from './runner.js';

const ROBOT = '7c7d3f0a-2b1e-4f7a-9a55-0e8e6b1f2a3c';
const ACCOUNT = 'acc-test';

describe('jobs', () => {
  it('accepts heartbeats and bar closes in PAPER mode', () => {
    expect(handleJob({ type: 'heartbeat', at: new Date().toISOString() })).toEqual({
      ok: true,
      type: 'heartbeat',
      mode: 'PAPER',
    });
    expect(
      handleJob({ type: 'bar_close', robotId: ROBOT, symbol: 'BTCUSD', tf: '1m', barTs: 1 }).type,
    ).toBe('bar_close');
    expect(handleJob({ type: 'tracking' }).type).toBe('tracking');
  });
  it('rejects anything else (the runner cannot place orders directly)', () => {
    expect(() => handleJob({ type: 'place_order', symbol: 'EURUSD' })).toThrow(RejectedJobError);
    expect(() => handleJob({ type: 'heartbeat', at: 'x' })).toThrow(RejectedJobError);
    expect(() =>
      handleJob({ type: 'bar_close', robotId: 'nope', symbol: 'X', tf: '1m', barTs: 1 }),
    ).toThrow(RejectedJobError);
  });
  it('builds colon-free, deterministic job ids', () => {
    expect(barJobId({ robotId: ROBOT, symbol: 'BRK/B', barTs: 5 })).toBe(`bar__${ROBOT}__BRK-B__5`);
  });
});

describe('config', () => {
  it('IRTC R1-11: requires Redis authentication in staging and production', () => {
    expect(() => loadConfig({ KORA_ENV: 'staging', REDIS_URL: 'rediss://redis:6380' })).toThrow(/password/);
    expect(() => loadConfig({ KORA_ENV: 'production', REDIS_URL: 'redis://redis:6379' })).toThrow(/password/);
    expect(loadConfig({ KORA_ENV: 'staging', REDIS_URL: 'rediss://:pw@redis:6380' }).redisUrl).toBe('rediss://:pw@redis:6380');
    expect(loadConfig({ KORA_ENV: 'dev', REDIS_URL: 'redis://127.0.0.1:56379' }).redisUrl).toBe('redis://127.0.0.1:56379');
  });
  it('refuses LIVE, requires redis and validates the service token', () => {
    expect(() => loadConfig({ LIVE_TRADING_ENABLED: 'true', REDIS_URL: 'redis://x' })).toThrow(
      /PAPER only/,
    );
    expect(() => loadConfig({})).toThrow(/REDIS_URL/);
    expect(() => loadConfig({ REDIS_URL: 'redis://x', KORA_SERVICE_TOKEN: 'short' })).toThrow(
      /32 characters/,
    );
    expect(loadConfig({ REDIS_URL: 'redis://x', KORA_BOT_RUNNER_CONCURRENCY: '500' }).concurrency).toBe(64);
    expect(loadConfig({ REDIS_URL: 'redis://x' })).toMatchObject({
      healthPort: 4100,
      queueName: 'kora-bots',
      serviceToken: null,
      apiUrl: 'http://127.0.0.1:4000',
      quantUrl: 'http://127.0.0.1:8000',
      mdPrefix: 'kora:md:',
      concurrency: 16,
      heartbeatMs: 5000,
    });
    expect(
      loadConfig({
        REDIS_URL: 'redis://x',
        QUANT_URL: 'http://q:1/',
        API_INTERNAL_URL: 'http://a:2/',
      }),
    ).toMatchObject({ quantUrl: 'http://q:1', apiUrl: 'http://a:2' });
  });
});

loadEnv();
const redisUrl = process.env.REDIS_URL;

describe.skipIf(!redisUrl)('heartbeat-only runner (no service token)', () => {
  let runner: Runner;
  let events: QueueEvents;
  beforeAll(async () => {
    const cfg = {
      ...loadConfig({ REDIS_URL: redisUrl! }),
      healthPort: 4199,
      queueName: `kora-bots-test-${process.pid}`,
    };
    runner = await startRunner(cfg);
    events = new QueueEvents(cfg.queueName, {
      connection: new Redis(redisUrl!, { maxRetriesPerRequest: null }),
    });
    await events.waitUntilReady();
  });
  afterAll(async () => {
    await runner.queue.obliterate({ force: true });
    await events.close();
    await runner.close();
  });

  it('processes a heartbeat job and fails unknown and robot jobs', async () => {
    const ok = await runner.queue.add('hb', { type: 'heartbeat', at: new Date().toISOString() });
    expect(await ok.waitUntilFinished(events, 10_000)).toMatchObject({ ok: true, mode: 'PAPER' });
    const bad = await runner.queue.add('bad', { type: 'place_order' }, { attempts: 1 });
    await expect(bad.waitUntilFinished(events, 10_000)).rejects.toThrow(/Rejected job/);
    const bar = await runner.queue.add(
      'bar',
      { type: 'bar_close', robotId: ROBOT, symbol: 'BTCUSD', tf: '1m', barTs: 1 },
      { attempts: 1 },
    );
    await expect(bar.waitUntilFinished(events, 10_000)).rejects.toThrow(/Robots are disabled/);
  });

  it('serves /health', async () => {
    // nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request -- test double on loopback, reviewed goal 10
    const res = await fetch('http://127.0.0.1:4199/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: 'ok',
      environment: 'PAPER',
      redis: 'up',
      robots: { enabled: false },
    });
    // nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request -- test double on loopback, reviewed goal 10
    expect((await fetch('http://127.0.0.1:4199/nope')).status).toBe(404);
  });
});

function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c: Buffer) => (d += c.toString()));
    req.on('end', () => resolve(d ? (JSON.parse(d) as Record<string, unknown>) : {}));
  });
}

describe.skipIf(!redisUrl)('robot runner against stub api + quant', () => {
  let runner: Runner;
  let stub: Server;
  let redis: Redis;
  let cfg: RunnerConfig;
  const seen: Array<{
    path: string;
    headers: Record<string, unknown>;
    body: Record<string, unknown>;
  }> = [];
  let contextStatus = 200;
  let qe: QueueEvents;

  beforeAll(async () => {
    stub = createServer(async (req, res) => {
      const b = await body(req);
      seen.push({ path: req.url ?? '', headers: req.headers, body: b });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/internal/robots/running') {
        res.end(
          JSON.stringify({
            robots: [
              {
                robotId: ROBOT,
                accountId: ACCOUNT,
                versionId: 'v1',
                timeframe: '1m',
                symbols: ['BTCUSD'],
              },
            ],
          }),
        );
      } else if (req.url?.startsWith(`/internal/robots/${ROBOT}/context`)) {
        res.statusCode = contextStatus;
        res.end(
          JSON.stringify(
            contextStatus === 200
              ? { versionId: 'v1', signalRequest: { hello: 'quant' } }
              : { error: 'robot_not_running' },
          ),
        );
      } else if (req.url === '/bt/signal') {
        res.end(
          JSON.stringify({
            action: 'enter_long',
            symbol: 'BTCUSD',
            barTs: 60_000,
            reason: 'entry_signal',
          }),
        );
      } else if (req.url === `/internal/robots/${ROBOT}/decisions`) {
        res.end(JSON.stringify({ action: 'enter_long', outcome: 'submitted', orderId: 'o-1' }));
      } else if (req.url === '/internal/robots/tracking') {
        res.end(JSON.stringify({ day: '2026-01-01', robots: 0 }));
      } else {
        res.statusCode = 404;
        res.end('{}');
      }
    });
    await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
    cfg = {
      ...loadConfig({ REDIS_URL: redisUrl! }),
      healthPort: 4198,
      queueName: `kora-bots-robot-test-${process.pid}`,
      apiUrl: url,
      quantUrl: url,
      serviceToken: 'x'.repeat(40),
      mdPrefix: `kora:test:${process.pid}:runner:md:`,
      heartbeatMs: 100,
      syncMs: 60_000,
      trackingCron: '',
    };
    redis = new Redis(redisUrl!, { maxRetriesPerRequest: 2 });
    runner = await startRunner(cfg);
    qe = new QueueEvents(cfg.queueName, {
      connection: new Redis(redisUrl!, { maxRetriesPerRequest: null }),
    });
    await qe.waitUntilReady();
  });
  afterAll(async () => {
    await qe.close();
    await runner.queue.obliterate({ force: true });
    await runner.close();
    redis.disconnect();
    await new Promise<void>((r) => stub.close(() => r()));
  });

  it('heartbeats every running robot and syncs with the service token', async () => {
    await new Promise((r) => setTimeout(r, 250));
    expect(Number(await redis.get(heartbeatKey(ROBOT)))).toBeGreaterThan(Date.now() - 1000);
    const sync = seen.find((s) => s.path === '/internal/robots/running')!;
    expect(sync.headers['x-kora-service-token']).toBe('x'.repeat(40));
  });

  it('turns a closed candle into context → quant → decision, once per bar', async () => {
    const decided = new Promise<Record<string, unknown>>((r) => runner.bots!.once('decision', r));
    const candle = { type: 'candle', symbol: 'BTCUSD', tf: '1m', bucket: 60_000, closed: true };
    await redis.publish(
      `${cfg.mdPrefix}candles:BTCUSD:1m`,
      JSON.stringify({ ...candle, closed: false }),
    );
    await redis.publish(`${cfg.mdPrefix}candles:BTCUSD:1m`, JSON.stringify(candle));
    await redis.publish(`${cfg.mdPrefix}candles:BTCUSD:1m`, JSON.stringify(candle));
    expect(await decided).toMatchObject({
      type: 'decision',
      robotId: ROBOT,
      action: 'enter_long',
      outcome: 'submitted',
      orderId: 'o-1',
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(seen.filter((s) => s.path === '/bt/signal')).toHaveLength(1);
    const d = seen.find((s) => s.path.endsWith('/decisions'))!;
    expect(d.body).toMatchObject({
      symbol: 'BTCUSD',
      barTs: 60_000,
      versionId: 'v1',
      signal: { action: 'enter_long' },
    });
    expect(d.headers['x-kora-csrf']).toBe('1');
  });

  it('a 4xx from the api is not retried', async () => {
    contextStatus = 409;
    const job = await runner.queue.add(
      'bar_close',
      { type: 'bar_close', robotId: ROBOT, symbol: 'BTCUSD', tf: '1m', barTs: 120_000 },
      { attempts: 5 },
    );
    await expect(job.waitUntilFinished(qe, 15_000)).rejects.toThrow(/409/);
    expect((await runner.queue.getJob(job.id!))?.attemptsMade).toBe(1);
    contextStatus = 200;
  });

  it('runs the tracking job through the api', async () => {
    const job = await runner.queue.add('tracking', { type: 'tracking', day: '2026-01-01' });
    expect(await job.waitUntilFinished(qe, 15_000)).toMatchObject({ day: '2026-01-01' });
    expect(seen.find((s) => s.path === '/internal/robots/tracking')!.body).toEqual({
      day: '2026-01-01',
    });
  });

  it('halts the account’s robots within milliseconds of the kill-switch message and stops heartbeats', async () => {
    const listener = new Redis(redisUrl!, { maxRetriesPerRequest: null });
    await listener.subscribe(ROBOT_EVENTS_CHANNEL);
    const reported = new Promise<Record<string, unknown>>((r) =>
      listener.on('message', (_c, raw: string) => {
        const e = JSON.parse(raw) as Record<string, unknown>;
        if (e.type === 'halted' && e.accountId === ACCOUNT) r(e);
      }),
    );
    const sent = Date.now();
    await redis.publish(
      ROBOT_CONTROL_CHANNEL,
      JSON.stringify({ action: 'halt', accountId: ACCOUNT, scope: 'robots', ts: sent }),
    );
    const e = await reported;
    expect(e.robotIds).toEqual([ROBOT]);
    expect(Number(e.reactedAt) - sent).toBeLessThan(1000);
    expect(runner.bots!.isActive(ROBOT)).toBe(false);
    expect(await redis.get(heartbeatKey(ROBOT))).toBeNull();
    // Closed candles for a halted robot are ignored.
    await redis.publish(
      `${cfg.mdPrefix}candles:BTCUSD:1m`,
      JSON.stringify({ type: 'candle', symbol: 'BTCUSD', tf: '1m', bucket: 180_000, closed: true }),
    );
    await new Promise((r) => setTimeout(r, 200));
    expect(
      await runner.queue.getJob(barJobId({ robotId: ROBOT, symbol: 'BTCUSD', barTs: 180_000 })),
    ).toBeUndefined();
    // nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request -- test double on loopback, reviewed goal 10
    const res = await fetch('http://127.0.0.1:4198/health');
    expect(await res.json()).toMatchObject({
      robots: { enabled: true, running: 1, haltedAccounts: 1 },
    });
    listener.disconnect();
  });
});

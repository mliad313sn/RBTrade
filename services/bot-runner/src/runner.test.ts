import { QueueEvents } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadConfig, loadEnv } from './config.js';
import { handleJob, RejectedJobError } from './jobs.js';
import { startRunner, type Runner } from './runner.js';

describe('jobs', () => {
  it('accepts heartbeats in PAPER mode', () => {
    expect(handleJob({ type: 'heartbeat', at: new Date().toISOString() })).toEqual({ ok: true, type: 'heartbeat', mode: 'PAPER' });
  });
  it('rejects anything else (the runner cannot place orders directly)', () => {
    expect(() => handleJob({ type: 'place_order', symbol: 'EURUSD' })).toThrow(RejectedJobError);
    expect(() => handleJob({ type: 'heartbeat', at: 'x' })).toThrow(RejectedJobError);
  });
});

describe('config', () => {
  it('refuses LIVE and requires redis', () => {
    expect(() => loadConfig({ LIVE_TRADING_ENABLED: 'true', REDIS_URL: 'redis://x' })).toThrow(/PAPER only/);
    expect(() => loadConfig({})).toThrow(/REDIS_URL/);
    expect(loadConfig({ REDIS_URL: 'redis://x' })).toMatchObject({ healthPort: 4100, queueName: 'kora-bots' });
  });
});

loadEnv();
const redisUrl = process.env.REDIS_URL;

describe.skipIf(!redisUrl)('runner against Redis', () => {
  let runner: Runner;
  let events: QueueEvents;
  beforeAll(async () => {
    const cfg = { redisUrl: redisUrl!, healthPort: 4199, queueName: `kora-bots-test-${process.pid}` };
    runner = await startRunner(cfg);
    events = new QueueEvents(cfg.queueName, { connection: new Redis(redisUrl!, { maxRetriesPerRequest: null }) });
    await events.waitUntilReady();
  });
  afterAll(async () => {
    await runner.queue.obliterate({ force: true });
    await events.close();
    await runner.close();
  });

  it('processes a heartbeat job and fails an unknown job', async () => {
    const ok = await runner.queue.add('hb', { type: 'heartbeat', at: new Date().toISOString() });
    expect(await ok.waitUntilFinished(events, 10_000)).toMatchObject({ ok: true, mode: 'PAPER' });
    const bad = await runner.queue.add('bad', { type: 'place_order' }, { attempts: 1 });
    await expect(bad.waitUntilFinished(events, 10_000)).rejects.toThrow(/Rejected job/);
  });

  it('serves /health', async () => {
    const res = await fetch('http://127.0.0.1:4199/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok', environment: 'PAPER', redis: 'up' });
    expect((await fetch('http://127.0.0.1:4199/nope')).status).toBe(404);
  });
});

import { createServer, type Server } from 'node:http';

import { Queue, UnrecoverableError, Worker } from 'bullmq';
import { Redis } from 'ioredis';

import { Bots, Http, TransientError } from './bots.js';
import type { RunnerConfig } from './config.js';
import { parseJob, RejectedJobError } from './jobs.js';

export interface Runner {
  queue: Queue;
  worker: Worker;
  health: Server;
  bots: Bots | null;
  close: () => Promise<void>;
}

function log(
  level: 'info' | 'warn' | 'error',
  msg: string,
  extra: Record<string, unknown> = {},
): void {
  console.warn(
    JSON.stringify({ level, service: 'kora-bot-runner', environment: 'PAPER', msg, ...extra }),
  );
}

/**
 * BullMQ worker (goal 06): bar-close evaluation of running robots, the daily tracking-error job and
 * heartbeats. With no service token configured the runner only heartbeats (robots disabled).
 */
export async function startRunner(cfg: RunnerConfig): Promise<Runner> {
  const connection = new Redis(cfg.redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue(cfg.queueName, { connection });
  const http = new Http(cfg);
  const bots = cfg.serviceToken ? new Bots(cfg, queue, http) : null;
  const worker = new Worker(
    cfg.queueName,
    async (job) => {
      let data;
      try {
        data = parseJob(job.data);
      } catch (e) {
        if (e instanceof RejectedJobError) throw new UnrecoverableError(e.message);
        throw e;
      }
      if (data.type === 'heartbeat') return { ok: true, type: 'heartbeat', mode: 'PAPER' };
      if (!bots)
        throw new UnrecoverableError('Robots are disabled: KORA_SERVICE_TOKEN is not configured.');
      try {
        if (data.type === 'tracking')
          return await http.call(
            'api',
            'POST',
            '/internal/robots/tracking',
            data.day ? { day: data.day } : {},
          );
        return await bots.processBar(data);
      } catch (e) {
        if (e instanceof TransientError) throw e;
        // 4xx from the api (robot paused, version changed, …) will not get better on retry.
        throw new UnrecoverableError((e as Error).message);
      }
    },
    { connection, concurrency: 4 },
  );
  worker.on('failed', (job, err) =>
    log('warn', 'job failed', { jobId: job?.id, attempts: job?.attemptsMade, error: err.message }),
  );
  const probe = new Redis(cfg.redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
  probe.on('error', () => undefined);

  if (bots) {
    bots.on('error', (e: Error) => log('warn', 'robot sync failed', { error: e.message }));
    bots.on('halted', (e: Record<string, unknown>) => log('info', 'kill switch: robots halted', e));
    await bots.start();
    if (cfg.trackingCron)
      await queue.upsertJobScheduler(
        'tracking-daily',
        { pattern: cfg.trackingCron, tz: 'UTC' },
        { name: 'tracking', data: { type: 'tracking' } },
      );
  }

  const health = createServer((req, res) => {
    if (req.url !== '/health') {
      res.writeHead(404).end();
      return;
    }
    void (async () => {
      let redis = 'down';
      try {
        if (probe.status === 'wait') await probe.connect();
        redis = (await probe.ping()) === 'PONG' ? 'up' : 'down';
      } catch {
        redis = 'down';
      }
      const ok = redis === 'up' && worker.isRunning();
      res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          status: ok ? 'ok' : 'degraded',
          service: 'kora-bot-runner',
          environment: 'PAPER',
          queue: cfg.queueName,
          redis,
          robots: bots
            ? {
                enabled: true,
                running: bots.robots.size,
                haltedAccounts: bots.haltedAccounts.size,
                heartbeatMs: cfg.heartbeatMs,
              }
            : { enabled: false },
        }),
      );
    })();
  });
  await new Promise<void>((r) => health.listen(cfg.healthPort, '127.0.0.1', r));

  return {
    queue,
    worker,
    health,
    bots,
    close: async () => {
      await bots?.close();
      await worker.close();
      await queue.close();
      await new Promise<void>((r) => health.close(() => r()));
      probe.disconnect();
      connection.disconnect();
    },
  };
}

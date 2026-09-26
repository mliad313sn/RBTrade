import { createServer, type Server } from 'node:http';

import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';

import type { RunnerConfig } from './config.js';
import { handleJob } from './jobs.js';

export interface Runner {
  queue: Queue;
  worker: Worker;
  health: Server;
  close: () => Promise<void>;
}

export async function startRunner(cfg: RunnerConfig): Promise<Runner> {
  const connection = new Redis(cfg.redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue(cfg.queueName, { connection });
  const worker = new Worker(cfg.queueName, async (job) => handleJob(job.data), { connection, concurrency: 4 });
  const probe = new Redis(cfg.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false });
  probe.on('error', () => undefined);

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
      res.end(JSON.stringify({ status: ok ? 'ok' : 'degraded', service: 'kora-bot-runner', environment: 'PAPER', queue: cfg.queueName, redis }));
    })();
  });
  await new Promise<void>((r) => health.listen(cfg.healthPort, '127.0.0.1', r));

  return {
    queue,
    worker,
    health,
    close: async () => {
      await worker.close();
      await queue.close();
      await new Promise<void>((r) => health.close(() => r()));
      probe.disconnect();
      connection.disconnect();
    },
  };
}

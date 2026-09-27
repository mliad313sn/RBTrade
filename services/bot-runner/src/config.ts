import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export interface RunnerConfig {
  redisUrl: string;
  healthPort: number;
  queueName: string;
  /** Where the api's internal robot endpoints live (service-token authenticated). */
  apiUrl: string;
  quantUrl: string;
  /** Shared secret for `/internal/*` (≥ 32 chars). Without it the runner only heartbeats. */
  serviceToken: string | null;
  /** Goal 02 Redis bus prefix (candles channels). */
  mdPrefix: string;
  heartbeatMs: number;
  syncMs: number;
  /** BullMQ cron pattern for the daily tracking-error job (UTC); empty disables it. */
  trackingCron: string;
  requestTimeoutMs: number;
  /** Bar-close jobs evaluated in parallel (goal 10 load finding: 4 left 50 robots waiting ~8 s). */
  concurrency: number;
}

export function loadEnv(): void {
  const root = resolve(import.meta.dirname, '../../../.env');
  if (existsSync(root)) process.loadEnvFile(root);
}

function hasPassword(url: string): boolean {
  try {
    return new URL(url).password.length > 0;
  } catch {
    return false;
  }
}

const int = (v: string | undefined, d: number) => {
  const n = Number(v ?? '');
  return Number.isInteger(n) && n > 0 ? n : d;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  if ((env.LIVE_TRADING_ENABLED ?? 'false').toLowerCase() === 'true') {
    throw new Error('LIVE_TRADING_ENABLED=true is not supported: KORA runs in PAPER only.');
  }
  if (!env.REDIS_URL) throw new Error('REDIS_URL is required');
  // IRTC R1-11: outside dev/test the robot job queue and the WS bus need an authenticated Redis.
  const kEnv = env.KORA_ENV ?? 'dev';
  if ((kEnv === 'staging' || kEnv === 'production' || env.NODE_ENV === 'production') && !hasPassword(env.REDIS_URL))
    throw new Error('REDIS_URL must carry a password outside dev/test, e.g. rediss://:<password>@host:6380');
  const token = env.KORA_SERVICE_TOKEN?.trim() ?? '';
  if (token && token.length < 32)
    throw new Error('KORA_SERVICE_TOKEN must be at least 32 characters');
  const quantPort = env.QUANT_PORT?.trim() || '8000';
  return {
    redisUrl: env.REDIS_URL,
    healthPort: Number(env.BOT_RUNNER_HEALTH_PORT ?? 4100),
    queueName: env.BOT_RUNNER_QUEUE ?? 'kora-bots',
    apiUrl: (
      env.BOT_RUNNER_API_URL?.trim() ||
      env.API_INTERNAL_URL?.trim() ||
      `http://127.0.0.1:${env.API_PORT ?? '4000'}`
    ).replace(/\/$/, ''),
    quantUrl: (env.QUANT_URL?.trim() || `http://127.0.0.1:${quantPort}`).replace(/\/$/, ''),
    serviceToken: token || null,
    mdPrefix: env.KORA_MD_REDIS_PREFIX?.trim() || 'kora:md:',
    heartbeatMs: int(env.KORA_ROBOT_HEARTBEAT_MS, 5000),
    syncMs: int(env.KORA_BOT_RUNNER_SYNC_MS, 5000),
    trackingCron: env.KORA_BOT_RUNNER_TRACKING_CRON ?? '5 0 * * *',
    requestTimeoutMs: int(env.KORA_BOT_RUNNER_TIMEOUT_MS, 15_000),
    concurrency: Math.min(64, int(env.KORA_BOT_RUNNER_CONCURRENCY, 16)),
  };
}

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export interface RunnerConfig {
  redisUrl: string;
  healthPort: number;
  queueName: string;
}

export function loadEnv(): void {
  const root = resolve(import.meta.dirname, '../../../.env');
  if (existsSync(root)) process.loadEnvFile(root);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  if ((env.LIVE_TRADING_ENABLED ?? 'false').toLowerCase() === 'true') {
    throw new Error('LIVE_TRADING_ENABLED=true is not supported: KORA runs in PAPER only.');
  }
  if (!env.REDIS_URL) throw new Error('REDIS_URL is required');
  return {
    redisUrl: env.REDIS_URL,
    healthPort: Number(env.BOT_RUNNER_HEALTH_PORT ?? 4100),
    queueName: env.BOT_RUNNER_QUEUE ?? 'kora-bots',
  };
}

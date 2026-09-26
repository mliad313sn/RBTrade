import { loadConfig, loadEnv } from './config.js';
import { startRunner } from './runner.js';

loadEnv();
const cfg = loadConfig();
const runner = await startRunner(cfg);
console.warn(JSON.stringify({ level: 'info', service: 'kora-bot-runner', msg: 'started', queue: cfg.queueName, healthPort: cfg.healthPort, environment: 'PAPER' }));

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, () => {
    void runner.close().then(() => process.exit(0));
  });
}

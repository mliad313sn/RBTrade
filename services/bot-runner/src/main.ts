import { loadConfig, loadEnv } from './config.js';
import { startRunner } from './runner.js';
import { startTracing } from './tracing.js';

loadEnv();
startTracing();
const cfg = loadConfig();
const runner = await startRunner(cfg);
console.warn(
  JSON.stringify({
    level: 'info',
    service: 'kora-bot-runner',
    msg: 'started',
    queue: cfg.queueName,
    healthPort: cfg.healthPort,
    environment: 'PAPER',
    robots: cfg.serviceToken ? 'enabled' : 'disabled (KORA_SERVICE_TOKEN not set)',
    api: cfg.apiUrl,
    quant: cfg.quantUrl,
  }),
);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, () => {
    void runner.close().then(() => process.exit(0));
  });
}

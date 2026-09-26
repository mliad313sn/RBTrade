// Loads the repo-root .env (if present) before anything reads process.env.
// Real deployments inject env directly; values already set are never overridden.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export function loadEnvFile(): void {
  if (process.env.KORA_SKIP_ENV_FILE === '1') return;
  for (const candidate of [resolve(process.cwd(), '.env'), resolve(__dirname, '../../../.env')]) {
    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
      return;
    }
  }
}

loadEnvFile();

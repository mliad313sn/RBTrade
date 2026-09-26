import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { defineConfig, devices } from '@playwright/test';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const rootEnv = resolve(__dirname, '../../.env');
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const API_PORT = process.env.E2E_API_PORT ?? '4010';
const WEB_PORT = process.env.E2E_WEB_PORT ?? '3010';
const e2eDb = process.env.DATABASE_URL_E2E;
if (!e2eDb) throw new Error('DATABASE_URL_E2E is not set (see .env.example)');

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
  webServer: [
    {
      command: 'node dist/main.js',
      cwd: resolve(__dirname, '../api'),
      url: `http://127.0.0.1:${API_PORT}/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        ...(process.env as Record<string, string>),
        API_PORT,
        DATABASE_URL: e2eDb,
        KORA_ENV: 'test',
        KORA_SCRYPT_N: '16384',
        KORA_AUTH_RATE_LIMIT: '10000',
        LOG_LEVEL: 'warn',
      },
    },
    {
      command: `pnpm exec next start -p ${WEB_PORT} -H 127.0.0.1`,
      cwd: __dirname,
      url: `http://127.0.0.1:${WEB_PORT}/login`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { ...(process.env as Record<string, string>), API_INTERNAL_URL: `http://127.0.0.1:${API_PORT}` },
    },
  ],
});

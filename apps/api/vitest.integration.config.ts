import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['test/**/*.int.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    setupFiles: ['test/setup-env.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    // IRTC R6-06: integration coverage over the whole api source (the unit gate only measures pure
    // helpers). `pnpm test:integration` always measures it. Floors sit two to three points under the
    // level measured on 2026-09-27 (docs/qa/coverage.md), globally and for the safety modules.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/*-cli.ts', 'src/main.ts', 'src/db/seed*.ts'],
      reporter: ['text-summary', 'json-summary'],
      reportsDirectory: 'coverage-integration',
      thresholds: {
        // measured: lines 92.4, branches 82.9, functions 96.0
        lines: 90,
        statements: 90,
        branches: 80,
        functions: 94,
        // measured: 96.9 / 86.9
        'src/trading/**': { lines: 94, statements: 94, branches: 84 },
        // measured: 96.2 / 84.9
        'src/audit/**': { lines: 93, statements: 93, branches: 82 },
        // measured: 84.7 / 82.5
        'src/governance/**': { lines: 82, statements: 82, branches: 80 },
        // measured: 89.1 / 77.9 (the production LLM provider is covered by unit tests, not here)
        'src/ai/**': { lines: 86, statements: 86, branches: 75 },
      },
    },
    hookTimeout: 60_000,
  },
});

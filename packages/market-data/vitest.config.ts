import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // The determinism snapshot runs 2 000 simulator steps; leave headroom under parallel coverage runs.
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/index.ts', 'src/seed/**'],
      thresholds: { lines: 85, functions: 85, branches: 85, statements: 85 },
    },
  },
});

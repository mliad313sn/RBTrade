import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    testTimeout: 20_000,
    // tracing.ts is process bootstrap, proven end to end by apps/api/test/tracing.int.test.ts (goal 10).
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/main.ts', 'src/tracing.ts'],
      thresholds: { lines: 80 },
    },
  },
});

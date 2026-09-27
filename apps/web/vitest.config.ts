import { createRequire } from 'node:module';

import { defineConfig, type ViteUserConfig } from 'vitest/config';

// Goal 10 test-pyramid audit: coverage gate on the web app's pure logic (formatting, layout, route
// rules, novice and simulator helpers). HTTP clients, stores and server-only helpers are covered by
// the e2e suite. The v8 provider is resolved from the api workspace (same vitest version) because a
// new direct dependency cannot be added here inside the 7-day minimumReleaseAge window (B-1012).
const v8 = createRequire(new URL('../api/package.json', import.meta.url)).resolve(
  '@vitest/coverage-v8',
);

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // The custom-provider type omits the shared options (include, thresholds) that v8 reads.
    coverage: {
      provider: 'custom',
      customProviderModule: v8,
      include: [
        'src/lib/forwarded.ts',
        'src/lib/modes.ts',
        'src/lib/route-rules.ts',
        'src/lib/market-ws.ts',
        'src/lib/i18n/format.ts',
        'src/lib/i18n/readability.ts',
        'src/lib/novice/*.ts',
        'src/lib/sim/{chart,csv,format,glossary,practice}.ts',
        'src/lib/robots/format.ts',
        'src/lib/terminal/{format,hotkeys,layout,views,market-store}.ts',
      ],
      thresholds: { lines: 85, functions: 80, branches: 80, statements: 85 },
    } as NonNullable<ViteUserConfig['test']>['coverage'],
  },
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@': new URL('./src', import.meta.url).pathname } },
});

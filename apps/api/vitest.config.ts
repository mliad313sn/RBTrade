import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/auth/totp.ts', 'src/auth/password.ts', 'src/auth/crypto-box.ts', 'src/common/zod.ts', 'src/config/config.ts', 'src/market-data/md-config.ts', 'src/trading/trading-config.ts', 'src/trading/broker/broker.ts', 'src/ai/core/*.ts', 'src/intel/core/*.ts', 'src/governance/export/*.ts', 'src/governance/controls/matrix.ts', 'src/governance/controls/catalogue.ts', 'src/governance/governance-config.ts', 'src/disclosures/disclosure-render.ts', 'src/ai/providers/anthropic.provider.ts', 'src/config/env-mode.ts'],
      thresholds: { lines: 85, functions: 85, branches: 80, statements: 85 },
    },
  },
});

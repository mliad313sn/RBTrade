import nextPlugin from '@next/eslint-plugin-next';
import { koraConfig } from '@kora/config/eslint';

import { noviceNoGamification } from './eslint.novice.mjs';

export default [
  ...koraConfig({ react: true, ignores: ['playwright-report/**', 'test-results/**'] }),
  {
    plugins: { '@next/next': nextPlugin },
    rules: { ...nextPlugin.configs.recommended.rules, ...nextPlugin.configs['core-web-vitals'].rules },
  },
  // Goal 08: no confetti, streaks or leaderboards in the Novice view.
  noviceNoGamification,
];

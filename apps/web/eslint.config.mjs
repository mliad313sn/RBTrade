import nextPlugin from '@next/eslint-plugin-next';
import { koraConfig } from '@kora/config/eslint';

import { noGamificationAnywhere, noviceNoGamification } from './eslint.novice.mjs';

export default [
  ...koraConfig({ react: true, ignores: ['playwright-report/**', 'test-results/**'] }),
  {
    plugins: { '@next/next': nextPlugin },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
    },
  },
  // IRTC R4-19: no gamification or push nudges on any screen; Goal 08: stricter list in the Novice view.
  noGamificationAnywhere,
  noviceNoGamification,
];

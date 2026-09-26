import nextPlugin from '@next/eslint-plugin-next';
import { koraConfig } from '@kora/config/eslint';

export default [
  ...koraConfig({ react: true, ignores: ['playwright-report/**', 'test-results/**'] }),
  {
    plugins: { '@next/next': nextPlugin },
    rules: { ...nextPlugin.configs.recommended.rules, ...nextPlugin.configs['core-web-vitals'].rules },
  },
];

// Shared ESLint flat config for KORA TypeScript packages.
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/** Money must never go through binary floating point. */
const noFloatMoney = {
  'no-restricted-globals': [
    'error',
    { name: 'parseFloat', message: 'Use Decimal from @kora/domain for money, prices and quantities.' },
  ],
  'no-restricted-properties': [
    'error',
    { object: 'Number', property: 'parseFloat', message: 'Use Decimal from @kora/domain.' },
    { object: 'Math', property: 'random', message: 'Use a seeded RNG or crypto; Math.random is not allowed.' },
  ],
};

export function koraConfig({ react = false, nest = false, ignores = [] } = {}) {
  return tseslint.config(
    { ignores: ['dist/**', '.next/**', 'coverage/**', 'storybook-static/**', 'next-env.d.ts', ...ignores] },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
      languageOptions: {
        globals: { ...globals.node, ...(react ? globals.browser : {}) },
      },
      rules: {
        ...noFloatMoney,
        '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
        // NestJS DI reads constructor param types via emitDecoratorMetadata: type-only imports break it.
        '@typescript-eslint/consistent-type-imports': nest ? 'off' : ['error', { fixStyle: 'inline-type-imports' }],
        'no-console': ['warn', { allow: ['warn', 'error'] }],
        eqeqeq: ['error', 'always'],
      },
    },
    ...(react
      ? [
          {
            plugins: { 'react-hooks': reactHooks },
            rules: reactHooks.configs.recommended.rules,
          },
        ]
      : []),
    { files: ['scripts/**', '**/*-cli.ts', '**/*.stories.tsx'], rules: { 'no-console': 'off' } },
    prettier,
  );
}

export default koraConfig();

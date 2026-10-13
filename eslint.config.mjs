// @ts-check
import eslint from '@eslint/js';
import prettier from 'eslint-config-prettier';
import playwright from 'eslint-plugin-playwright';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['node_modules/', 'artifacts/', 'playwright-report/', 'test-results/'],
  },

  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  {
    files: ['tests/**/*.ts'],
    ...playwright.configs['flat/recommended'],
  },

  {
    // ADR-0001: the deterministic runtime never depends on the AI layer or an LLM SDK.
    files: ['tests/**/*.ts', 'apps/**/*.ts', 'framework/**/*.ts', 'playwright.config.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '(^|/)agents(/|$)',
              message: 'ADR-0001: runtime code must not import the agent layer (agents/**).',
            },
            {
              regex: '^@anthropic-ai/sdk(/|$)',
              message: 'ADR-0001: runtime code must not import an LLM SDK.',
            },
          ],
        },
      ],
    },
  },

  {
    // Agent-layer unit tests use the built-in Node test runner, whose test() and describe()
    // return promises the runner itself tracks.
    files: ['agents/**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          allowForKnownSafeCalls: [
            { from: 'package', package: 'node:test', name: ['test', 'describe', 'it', 'suite'] },
          ],
        },
      ],
    },
  },

  {
    files: ['**/*.mjs', '**/*.js'],
    ...tseslint.configs.disableTypeChecked,
  },

  prettier,
);

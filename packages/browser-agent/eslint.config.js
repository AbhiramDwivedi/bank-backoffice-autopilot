import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// ESLint v10 resolves the nearest config from each linted file's directory, so this file replaces
// the root config (../../eslint.config.js) for everything under packages/browser-agent. It mirrors
// the root's base rule set (this package has one module, so the root's per-module import-boundary
// configs do not apply here).
export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ['dist/**', '.tmp-build-*/**'],
  },
  {
    // This file and the root config (../../eslint.config.js) both call tseslint.configs.recommended,
    // which registers each config file's own directory as a candidate tsconfigRootDir (typescript-eslint
    // infers it from the call stack when it isn't set explicitly). Linting both trees in one root `eslint`
    // invocation makes both candidates live at once, so set this package's root explicitly rather than
    // relying on inference.
    languageOptions: { parserOptions: { tsconfigRootDir: import.meta.dirname } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
);

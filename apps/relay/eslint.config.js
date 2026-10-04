// Relay's lint config: the repo's rules plus Relay's own boundaries.
//   - src/shared is types only and imports nothing.
//   - src/ui talks to the server over HTTP only: no server code, no core, no Node built-ins.
//   - src/server reaches the core (@cu/*) only through src/server/core.ts, and never imports UI code or Playwright.
import root from '../../eslint.config.js';

const CORE_ESCAPE = { regex: '^(?:[.][.]/){3,}', message: 'Keep imports inside apps/relay.' };
const CORE_PACKAGE = { regex: '^@cu/', message: 'Only src/server/core.ts may import the core.' };

export default [
  ...root,
  { ignores: ['dist/**', 'test-results/**'] },
  {
    files: ['src/shared/**/*.ts'],
    rules: { 'no-restricted-imports': ['error', { patterns: [{ regex: '.', message: 'src/shared is the wire contract: types only, no imports.' }] }] },
  },
  {
    files: ['src/ui/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            CORE_ESCAPE,
            { regex: '(^|/)server/', message: 'The UI talks to the server over HTTP only.' },
            { regex: '^(node:|express$|playwright|@cu/)', message: 'The UI bundle runs in the browser and never imports the core or Node.' },
          ],
        },
      ],
    },
  },
  {
    files: ['src/server/**/*.ts'],
    ignores: ['src/server/core.ts', '**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            CORE_ESCAPE,
            CORE_PACKAGE,
            { regex: '(^|/)ui/', message: 'The server never imports UI code.' },
            { regex: '^playwright', message: 'Relay never imports Playwright.' },
          ],
        },
      ],
    },
  },
];

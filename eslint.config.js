import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// Dependency direction (docs/design/architecture.md):
//   packages/core                 @cu/core               domain + ports; imports no other workspace package
//   packages/browser-agent        @cu/browser-agent      standalone in-page agent; imports nothing (own eslint config)
//   packages/adapter-*            @cu/adapter-*          implement core's ports; import only @cu/core and @cu/browser-agent
//   apps/cu                       @cu/cli                composes core + adapters + the Relay console (@cu/relay)
//   apps/relay                    @cu/relay              human-in-the-loop console; imports only @cu/core (own eslint config)
//   apps/mock-app                 @cu/mock-app           the target app; imports only @cu/browser-agent (its monitoring tag)
//   apps/mock-desktop             @cu/mock-desktop       the desktop target app (C#, compiled at launch); its TS helpers import nothing
//   tools/*, tests/e2e                                   may import anything
// Across packages, code imports by package name (`@cu/core/replay`), never by a relative path into
// another package's folder. Test files may also import the mock app (@cu/mock-app) as a fixture.
const CORE = 'packages/core/src';
const CORE_MODULES = ['agent', 'credentials', 'evidence', 'policy', 'replay', 'optimize', 'schema', 'session', 'surface'];
const WORKSPACE_ROOTS = ['packages', 'apps', 'tools', 'tests'];

const TEST_FILES = ['**/*.test.ts', '**/test-helpers.ts'];

/**
 * Forbids importing a foreign core module's internals: any import specifier containing `/<module>/`
 * that does NOT end in `index.js` (a negative lookbehind, so it matches at any nesting depth --
 * `../surface/types.js` and `../surface/fake-scenarios/cu-core.js` are both forbidden, while
 * `../surface/index.js` is allowed). Same-module imports (e.g. `./x.js`, `../fake/match.js` from
 * within `surface`) are never matched, because the module's own name is left out of its own
 * pattern list below.
 */
function foreignModulePattern(moduleName) {
  return {
    regex: `(^|/)${moduleName}/.*(?<!index\\.js)$`,
    message: `Import '${moduleName}' through its public entry (.../${moduleName}/index.js), not one of its internal files.`,
  };
}

/** A relative specifier that climbs out of its package into another workspace package's folder. */
const CROSS_PACKAGE_RELATIVE = {
  regex: `^(\\.\\./)+(${WORKSPACE_ROOTS.join('|')}|core|adapter-[\\w-]+|cu|mock-app|video|src)/`,
  message: 'Import another workspace package by its package name (@cu/core/<module>, @cu/adapter-*, @cu/cli/<entry>, @cu/mock-app/<file>), not by a relative path across package roots.',
};

/** Any workspace package except the ones listed. */
function workspacePackagesExcept(allowed, why) {
  const allow = allowed.map((a) => a.replace('/', '\\/')).join('|');
  return {
    regex: allow ? `^@cu\\/(?!(${allow})(\\/|$))` : '^@cu\\/',
    message: why,
  };
}

const CORE_RULE = workspacePackagesExcept([], '@cu/core imports no other workspace package: it is the domain and its ports; adapters and apps depend on it, never the reverse.');
const CORE_TEST_RULE = workspacePackagesExcept(['mock-app'], '@cu/core tests may use only the mock app (@cu/mock-app) as a fixture.');
const ADAPTER_RULE = workspacePackagesExcept(['core', 'browser-agent'], 'An adapter imports only @cu/core (the port it implements) and @cu/browser-agent (the in-page agent it drives).');
const ADAPTER_TEST_RULE = workspacePackagesExcept(['core', 'browser-agent', 'mock-app', 'mock-desktop'], 'Adapter tests may use only @cu/core, @cu/browser-agent and the mock app fixtures.');
const CLI_RULE = workspacePackagesExcept(['core', 'relay', 'adapter-playwright', 'adapter-desktop', 'adapter-anthropic', 'adapter-jev', 'adapter-credentials'], 'The cu app composes @cu/core, @cu/relay and the adapters; it does not import other apps.');
const MOCK_APP_RULE = workspacePackagesExcept(['browser-agent'], 'The mock target app imports only @cu/browser-agent, which it serves as its monitoring tag.');
const MOCK_DESKTOP_RULE = workspacePackagesExcept([], 'The mock desktop app is a standalone Windows program; its helpers import no workspace package.');

/** Inside apps/cu, the composition root and the catalog are libraries the CLI wires up; they never import CLI files. */
const CLI_FILES_FORBIDDEN = {
  regex: '^\\.\\./(commands/|[^/]+\\.js$)',
  message: 'apps/cu/src/{runtime,catalog} must not import the CLI (apps/cu/src/*.ts, commands/): the CLI is the entry program that wires them up.',
};

const restrict = (...patterns) => ({ 'no-restricted-imports': ['error', { patterns }] });

const coreModuleConfigs = CORE_MODULES.map((own) => ({
  files: [`${CORE}/${own}/**/*.ts`],
  ignores: TEST_FILES,
  rules: restrict(...CORE_MODULES.filter((m) => m !== own).map(foreignModulePattern), CROSS_PACKAGE_RELATIVE, CORE_RULE),
}));

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ['**/dist/**', '**/node_modules/**', 'runs/**', 'apps/mock-app/public/**', 'tools/video/.build/**'],
  },
  {
    // Both this file and packages/browser-agent/eslint.config.js call tseslint.configs.recommended,
    // which registers each config file's own directory as a candidate tsconfigRootDir (typescript-eslint
    // infers it from the call stack when it isn't set explicitly). Linting both trees in one `eslint`
    // invocation makes both candidates live at once, so any file relying on inference (e.g. under
    // tools/, tests/) fails with "multiple candidate TSConfigRootDirs". Setting it explicitly here
    // opts every file this config governs out of that inference.
    languageOptions: { parserOptions: { tsconfigRootDir: import.meta.dirname } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  // Later entries override earlier ones for the same rule, so the general rules come first.
  { files: ['tools/**/*.ts', 'tests/**/*.ts'], rules: restrict(CROSS_PACKAGE_RELATIVE) },
  { files: [`${CORE}/**/*.ts`], rules: restrict(CROSS_PACKAGE_RELATIVE, CORE_TEST_RULE) },
  ...coreModuleConfigs,
  { files: ['packages/adapter-*/**/*.ts'], rules: restrict(CROSS_PACKAGE_RELATIVE, ADAPTER_TEST_RULE) },
  { files: ['packages/adapter-*/**/*.ts'], ignores: TEST_FILES, rules: restrict(CROSS_PACKAGE_RELATIVE, ADAPTER_RULE) },
  { files: ['apps/cu/**/*.ts'], rules: restrict(CROSS_PACKAGE_RELATIVE, CLI_RULE) },
  { files: ['apps/cu/src/runtime/**/*.ts', 'apps/cu/src/catalog/**/*.ts'], ignores: TEST_FILES, rules: restrict(CROSS_PACKAGE_RELATIVE, CLI_RULE, CLI_FILES_FORBIDDEN) },
  // Scripts live in the cu package and may import its own src by relative path (a package-internal import, not a cross-package one).
  { files: ['apps/cu/scripts/**/*.ts'], rules: restrict(CLI_RULE) },
  { files: ['apps/mock-app/**/*.ts'], rules: restrict(CROSS_PACKAGE_RELATIVE, MOCK_APP_RULE) },
  { files: ['apps/mock-desktop/**/*.ts'], rules: restrict(CROSS_PACKAGE_RELATIVE, MOCK_DESKTOP_RULE) },
);

/**
 * Hardens the "no LLM in replay" structural guarantee: packages/core/src/replay/** never imports
 * @anthropic-ai/sdk, packages/core/src/agent, or @cu/adapter-anthropic. no-llm.test.ts only scans
 * packages/core/src/replay itself and only catches static/dynamic import & require specifiers.
 * This suite:
 *
 *   1. Widens the directory scan to every module the replay path can pull secrets/config
 *      through: replay, session, policy, surface, evidence, schema (all under
 *      packages/core/src).
 *   2. Adds pattern classes the original scanner does not check: the literal string
 *      "api.anthropic.com", a `fetch(...)` call whose argument text mentions "anthropic", and
 *      any read of `process.env.ANTHROPIC_*` (including `ANTHROPIC_API_KEY` specifically).
 *   3. Builds the real transitive import graph starting from the two files that matter in
 *      production (packages/core/src/replay/index.ts, the public surface, and
 *      packages/core/src/replay/replay.ts, the orchestrator) by resolving and following relative
 *      imports on disk, and asserts no module in that closure resolves into
 *      packages/core/src/agent/ or imports the SDK.
 *   4. Scans the whole of apps/cu/src -- the composition root (runtime/), the agent-facing
 *      catalog (catalog/) and the CLI commands (commands/) all live in this one workspace package
 *      now -- for the same forbidden patterns, with one documented exception:
 *      apps/cu/src/commands/discover.ts.
 *   5. NEW (post-restructure): a repo-wide `@anthropic-ai/` import-boundary scan. Every .ts file
 *      under packages/, apps/, tools/ and tests/ (node_modules, .build and public skipped at any
 *      depth) is checked for a real import of the `@anthropic-ai/` package family; the only
 *      directory allowed to have one is packages/adapter-anthropic/. See the dedicated describe
 *      block near the bottom of this file for why this check exists alongside (1)-(4) rather than
 *      replacing them, and why it does not enumerate package names (so packages/browser-agent,
 *      apps/relay, or anything else another team adds under packages/ or apps/ is covered
 *      automatically).
 *   6. Self-tests the scanner against synthetic offending source text for every pattern class, so
 *      a change that silently narrows the regexes (making the guard vacuous) fails loudly.
 *
 *   7. Risk judge (docs/design/risk-judge.md): the same scans also forbid the second model vendor
 *      the runtime can call -- the `@cu/adapter-jev` package, the literal `api.typesafe.ai` host,
 *      a `fetch(...)` mentioning typesafe, and any read of a `TYPESAFE_*` env var. The apps/cu
 *      exceptions become exactly two files: commands/discover.ts and commands/risk-judge.ts (the
 *      judge factory). The rule for reaching those is inverted to an allowlist: only index.ts
 *      (registration), discover, audit, judge-eval and the factory may import a model-touching
 *      file; every other apps/cu/src file is forbidden from doing so, by resolved relative path
 *      or by `@cu/cli/commands/...` subpath. Any path into packages/adapter-anthropic or
 *      packages/adapter-jev is forbidden everywhere scanned, and a guarded file may load modules
 *      only by a literal specifier (a computed `import(...)`/`require(...)` is a violation). A
 *      relative-import graph walk from commands/replay.ts, commands/catalog.ts, runtime/index.ts
 *      and catalog/index.ts additionally proves none can reach a model-touching file, and that
 *      nothing in that closure has a forbidden pattern.
 *
 * What this cannot do: it is a static, grep-level scan. An env-var name or a hostname assembled
 * at runtime (`process.env['TYPE' + 'SAFE_API_KEY']`, `'api.' + host`) is invisible to it, and so
 * is anything a determined committer hides deliberately. It defends against accidental reach --
 * someone wiring a judge or model client into the replay side by mistake -- not against intent;
 * code review is the control for the latter.
 *
 * This file is additive: it does not replace no-llm.test.ts's own coverage.
 *
 * Path note (hexagonal workspace restructure): this file lives at
 * packages/core/src/replay/no-llm.redteam.test.ts, four directories below the repo root (replay
 * -> src -> core -> packages -> repo root), so REPO_ROOT below climbs four levels. Every other
 * path in this file is derived from REPLAY_DIR, CORE_PKG_ROOT or REPO_ROOT, so nothing else
 * needed to change shape -- except the CLI-side scan (item 4), which now points at a single
 * directory (apps/cu/src) instead of three, because the composition root and catalog moved
 * INSIDE the CLI's own workspace package rather than staying siblings of replay in this package.
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPLAY_DIR = path.dirname(fileURLToPath(import.meta.url));
// packages/core/src/replay -> packages/core (this package's root).
const CORE_PKG_ROOT = path.resolve(REPLAY_DIR, '..', '..');
// packages/core/src/replay -> ../../../.. -> the repo root (packages/core/src/replay is four
// directories below it: replay -> src -> core -> packages -> <repo root>).
const REPO_ROOT = path.resolve(REPLAY_DIR, '..', '..', '..', '..');
const AGENT_DIR = path.resolve(CORE_PKG_ROOT, 'src', 'agent');

// `optimize` is guarded like replay: the optimizer is a model-free search whose trials ARE replays
// (docs/design/optimize.md), so it must never reach a model either.
const GUARDED_DIR_NAMES = ['replay', 'optimize', 'session', 'policy', 'surface', 'evidence', 'schema'] as const;
const GUARDED_DIRS = GUARDED_DIR_NAMES.map((d) => path.resolve(CORE_PKG_ROOT, 'src', d));

const ENTRY_FILES = [path.join(REPLAY_DIR, 'index.ts'), path.join(REPLAY_DIR, 'replay.ts')];
const OPTIMIZE_DIR = path.resolve(CORE_PKG_ROOT, 'src', 'optimize');
const OPTIMIZE_ENTRY_FILES = [path.join(OPTIMIZE_DIR, 'index.ts'), path.join(OPTIMIZE_DIR, 'optimize.ts')];

// -------------------------------------------------------------------------------------------
// CLI-side scan scope: the whole of apps/cu/src (the @cu/cli workspace package). Post-restructure
// the composition root and the catalog are no longer siblings of replay in this package -- they
// moved into apps/cu/src/runtime and apps/cu/src/catalog, alongside apps/cu/src/commands (the CLI
// commands themselves). So one directory now covers everything item 4 used to need three
// directories for.
//
// These are the composition root, catalog and CLI commands that wire replay/catalog/policy
// together for a human operator; like the replay-side guard above, none of them should reach the
// Anthropic SDK, packages/core/src/agent, or @cu/adapter-anthropic directly -- WITH ONE EXCEPTION:
// apps/cu/src/commands/discover.ts is the CLI's discovery-agent entry point. Its whole job is to
// construct an LLM client (`createAnthropicClient` from `@cu/adapter-anthropic`), call `discover`
// (from `@cu/core/agent`), and read `process.env.ANTHROPIC_API_KEY` to fail fast (before any
// browser launches) if it's unset -- that is legitimate, not a leak, so it alone is excepted below
// (see the "exception is not vacuous" test, which fails if that file ever stops needing the
// exception).
//
// Test files (*.test.ts/*.spec.ts) are excluded from this scan entirely, via the same
// `listNonTestSourceFiles` used above -- consistent with the replay-side guard's own convention
// that a test may legitimately import whatever it needs to exercise its subject. Concretely this
// excludes two files that would otherwise need their own exceptions:
//   - apps/cu/src/commands/discover.test.ts: imports the `LlmClient` *type* from `@cu/core/agent`
//     purely to type a scripted fake client injected via `deps`, and asserts on the literal string
//     "ANTHROPIC_API_KEY" in discover's own progress/error output -- never a real
//     `process.env.ANTHROPIC_*` read from that file itself.
//   - apps/cu/src/env.test.ts: uses "ANTHROPIC_API_KEY" only as a realistic-looking key name in a
//     fixture `.env` file's contents and in assertions against the parsed result object
//     (`env.ANTHROPIC_API_KEY`) -- never the literal `process.env.ANTHROPIC_API_KEY` shape the
//     scanner's `ANTHROPIC_ENV_RE` looks for.
// Both were checked by hand; if a future non-test file in this package needs an exception, it
// should be reported rather than added here silently.
const APPS_CU_ROOT = path.resolve(REPO_ROOT, 'apps', 'cu');
const APPS_CU_SRC = path.resolve(APPS_CU_ROOT, 'src');
const CLI_SCAN_DIRS = [APPS_CU_SRC];
const DISCOVER_COMMAND_FILE = path.resolve(APPS_CU_SRC, 'commands', 'discover.ts');
// The risk-judge factory: the one apps/cu file that builds a judge adapter from the environment.
const RISK_JUDGE_FACTORY_FILE = path.resolve(APPS_CU_SRC, 'commands', 'risk-judge.ts');
// The only two apps/cu files allowed to import a model adapter / the agent / read a model key.
const CLI_EXCEPTIONS: ReadonlySet<string> = new Set([DISCOVER_COMMAND_FILE, RISK_JUDGE_FACTORY_FILE]);
// Files that may touch a model (directly or through the factory).
const MODEL_TOUCHING_CLI_FILES = [
  DISCOVER_COMMAND_FILE,
  RISK_JUDGE_FACTORY_FILE,
  path.resolve(APPS_CU_SRC, 'commands', 'audit.ts'),
  path.resolve(APPS_CU_SRC, 'commands', 'judge-eval.ts'),
];
// The inverted rule: the ONLY apps/cu/src files that may import a model-touching file. Every other
// non-test file there -- commands/replay.ts, commands/catalog.ts, runtime/, catalog/, anything
// added later -- is forbidden from reaching one, by relative path or by `@cu/cli` subpath.
// `discover-candidates.ts` is part of the discover command (it runs `runDiscover` n times for
// `--candidates`) and imports only its types; it touches no model itself.
const MODEL_REACH_ALLOWLIST: ReadonlySet<string> = new Set([
  path.resolve(APPS_CU_SRC, 'index.ts'),
  path.resolve(APPS_CU_SRC, 'commands', 'discover-candidates.ts'),
  ...MODEL_TOUCHING_CLI_FILES,
]);
// Replay-side entry points, for the graph walk (belt and braces over the per-file rule).
const REPLAY_SIDE_CLI_ENTRIES = [
  path.resolve(APPS_CU_SRC, 'commands', 'replay.ts'),
  path.resolve(APPS_CU_SRC, 'commands', 'catalog.ts'),
  path.resolve(APPS_CU_SRC, 'runtime', 'index.ts'),
  path.resolve(APPS_CU_SRC, 'catalog', 'index.ts'),
];

// -------------------------------------------------------------------------------------------
// File discovery
// -------------------------------------------------------------------------------------------

const SOURCE_EXT_RE = /\.(ts|mts|cts|js|mjs)$/;
const TEST_FILE_RE = /\.(test|spec)\.(ts|mts|cts|js|mjs)$/;

function listNonTestSourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return listNonTestSourceFiles(full);
    if (!SOURCE_EXT_RE.test(name)) return [];
    if (TEST_FILE_RE.test(name)) return [];
    return [full];
  });
}

// Directory names skipped at any depth by the repo-wide `@anthropic-ai/` scan below: dependency
// trees, build output, and static public assets never need scanning and can be huge.
const SKIP_DIR_NAMES = new Set(['node_modules', '.build', 'public']);

/** Every `.ts`/`.mts`/`.cts` file under `dir` (recursively), test files included, skipping
 *  node_modules/.build/public at any depth. Used only by the repo-wide `@anthropic-ai/` scan
 *  below (item 5) -- unlike `listNonTestSourceFiles`, this one is deliberately NOT restricted to
 *  non-test files, so it also catches a stray real import inside a test. */
function listAllTsFilesRepoWide(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    if (SKIP_DIR_NAMES.has(name)) return [];
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return listAllTsFilesRepoWide(full);
    return /\.(ts|mts|cts)$/.test(name) ? [full] : [];
  });
}

// -------------------------------------------------------------------------------------------
// Pattern extraction (specifiers + literal red flags)
// -------------------------------------------------------------------------------------------

/** Every module specifier in static imports/exports, dynamic import() and require(). */
function specifiers(source: string): string[] {
  const out: string[] = [];
  const patterns = [
    /\b(?:import|export)\s[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g,
    /\brequire\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g,
  ];
  for (const re of patterns) for (const m of source.matchAll(re)) out.push(m[1]!);
  return out;
}

// The bare specifiers a DIFFERENT workspace package (e.g. apps/cu) uses to reach the agent module
// or the Anthropic adapter today: the `@cu/core/agent` export (or its test-only
// `@cu/core/agent/test-helpers` subpath), and the `@cu/adapter-anthropic` package itself. Before
// the restructure the only consumer of agent/llm.ts lived in the same package and could only
// reach it by a relative disk path (handled separately below); this constant extends the same
// guarantee to the new cross-package import shapes.
const CORE_AGENT_SPECIFIER = '@cu/core/agent';
const ADAPTER_ANTHROPIC_SPECIFIER = '@cu/adapter-anthropic';
// The Jev-backed risk judge (a second model vendor) -- same treatment as the Anthropic adapter.
const ADAPTER_JEV_SPECIFIER = '@cu/adapter-jev';

// A specifier that names a model adapter's folder by path in any form (relative climb, absolute
// path, file: URL) -- the cross-package-relative shape lint also rejects, caught here regardless.
const ADAPTER_PATH_RE = /(^|[\\/])adapter-(anthropic|jev)([\\/]|$)/;

function isForbiddenSpecifier(spec: string, fromFile: string): boolean {
  if (spec === '@anthropic-ai/sdk' || spec.startsWith('@anthropic-ai/')) return true;
  if (ADAPTER_PATH_RE.test(spec)) return true;
  if (spec.startsWith('.')) {
    const resolved = path.resolve(path.dirname(fromFile), spec);
    return resolved === AGENT_DIR || resolved.startsWith(AGENT_DIR + path.sep);
  }
  if (spec === CORE_AGENT_SPECIFIER || spec.startsWith(`${CORE_AGENT_SPECIFIER}/`)) return true;
  if (spec === ADAPTER_ANTHROPIC_SPECIFIER || spec.startsWith(`${ADAPTER_ANTHROPIC_SPECIFIER}/`)) return true;
  if (spec === ADAPTER_JEV_SPECIFIER || spec.startsWith(`${ADAPTER_JEV_SPECIFIER}/`)) return true;
  // Non-relative specifier that names the agent package/module some other way.
  return /(^|\/)src\/agent(\/|$)/.test(spec);
}

export interface Violation {
  file: string;
  kind: 'specifier' | 'api-host' | 'fetch-anthropic' | 'fetch-typesafe' | 'env-read' | 'dynamic-import' | 'model-file';
  detail: string;
}

/** Every `fetch(...)` call's argument text (up to the matching close-paren on the same or next
 *  ~200 chars — good enough for a static grep-style guard, not a full parser). */
function fetchCallArgs(source: string): string[] {
  const out: string[] = [];
  const re = /\bfetch\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    out.push(source.slice(m.index, m.index + 300));
  }
  return out;
}

const ANTHROPIC_ENV_RE = /process\.env\.(ANTHROPIC_[A-Z0-9_]*)/g;
// Any env read of a TYPESAFE_* variable: `process.env.X`, `env.X`, `env['X']` / `env["X"]`, or the
// name as a standalone string literal (`const KEY = 'TYPESAFE_API_KEY'; env[KEY]` would otherwise
// slip past). A mention inside longer prose (a help string naming the variable) is not flagged.
const TYPESAFE_ENV_RE = /\benv(?:\.|\[\s*['"`])(TYPESAFE_[A-Z0-9_]*)|(['"`])TYPESAFE_[A-Z0-9_]*\2/g;

/** Scans one source file's text for every forbidden pattern class. `fromFile` is used only to
 *  resolve relative specifiers against (need not exist on disk for the self-test). */
function scanSource(source: string, fromFile: string): Violation[] {
  const violations: Violation[] = [];

  for (const spec of specifiers(source)) {
    if (isForbiddenSpecifier(spec, fromFile)) {
      violations.push({ file: fromFile, kind: 'specifier', detail: spec });
    }
  }

  if (/api\.anthropic\.com/i.test(source)) {
    violations.push({ file: fromFile, kind: 'api-host', detail: 'api.anthropic.com' });
  }

  for (const call of fetchCallArgs(source)) {
    if (/anthropic/i.test(call)) {
      violations.push({ file: fromFile, kind: 'fetch-anthropic', detail: call.slice(0, 80) });
    }
  }

  for (const m of source.matchAll(ANTHROPIC_ENV_RE)) {
    violations.push({ file: fromFile, kind: 'env-read', detail: m[0] });
  }

  if (/api\.typesafe\.ai/i.test(source)) {
    violations.push({ file: fromFile, kind: 'api-host', detail: 'api.typesafe.ai' });
  }

  for (const call of fetchCallArgs(source)) {
    if (/typesafe/i.test(call)) {
      violations.push({ file: fromFile, kind: 'fetch-typesafe', detail: call.slice(0, 80) });
    }
  }

  for (const m of source.matchAll(TYPESAFE_ENV_RE)) {
    violations.push({ file: fromFile, kind: 'env-read', detail: m[0] });
  }

  // A module loaded by a computed name cannot be checked by any rule above, so a guarded file may
  // only ever load modules by a literal specifier.
  for (const m of source.matchAll(NON_LITERAL_LOAD_RE)) {
    violations.push({ file: fromFile, kind: 'dynamic-import', detail: source.slice(m.index, m.index + 80) });
  }

  return violations;
}

/** `import(` / `require(` whose argument is not one plain string literal (a template literal
 *  without `${` counts as plain). `import('node:fs').Dirent` in a type position is literal. */
const NON_LITERAL_LOAD_RE = /\b(?:import|require)\s*\(\s*(?!(['"])[^'"`\n]*\1\s*\)|`[^`$\n]*`\s*\))/g;

/** Strips a JS extension so a specifier and a `.ts` source path compare equal. */
function withoutJsExtension(p: string): string {
  return p.replace(/\.(m?js|cjs|m?ts|cts)$/, '');
}

/** The bare `@cu/cli` subpaths that would reach a model-touching CLI file by package name. */
const MODEL_TOUCHING_CLI_SPECIFIER_RE = /^@cu\/cli\/commands\/(discover|audit|judge-eval|risk-judge)(\.js|\.ts)?$/;

/**
 * `scanSource` plus the apps/cu-only rule: unless `fromFile` is on `MODEL_REACH_ALLOWLIST`, it may
 * not import (by a relative path or by the `@cu/cli/commands/...` subpath) any file that touches a
 * model -- discover, audit, the eval script, or the risk-judge factory.
 */
function scanCliSource(source: string, fromFile: string): Violation[] {
  const violations = scanSource(source, fromFile);
  if (MODEL_REACH_ALLOWLIST.has(path.resolve(fromFile))) return violations;
  const modelFiles = new Set(MODEL_TOUCHING_CLI_FILES.map(withoutJsExtension));
  for (const spec of specifiers(source)) {
    const relativeHit = spec.startsWith('.') && modelFiles.has(withoutJsExtension(path.resolve(path.dirname(fromFile), spec)));
    if (relativeHit || MODEL_TOUCHING_CLI_SPECIFIER_RE.test(spec)) {
      violations.push({ file: fromFile, kind: 'model-file', detail: spec });
    }
  }
  return violations;
}

// -------------------------------------------------------------------------------------------
// Transitive import graph from the two replay entry points
// -------------------------------------------------------------------------------------------

/** Resolves a relative specifier (as written, e.g. './replay.js' or '../schema/index.js') to a
 *  real .ts/.mts/.cts source file on disk, following the project's "import with .js extension,
 *  source is .ts" convention. Returns undefined for anything that doesn't resolve to a readable
 *  source file (e.g. a .json import, or a bare package that is out of scope to follow). */
function resolveRelativeSpecifier(fromFile: string, spec: string): string | undefined {
  if (!spec.startsWith('.')) return undefined;
  const withoutExt = spec.replace(/\.(m?js|cjs)$/, '');
  const basePath = path.resolve(path.dirname(fromFile), withoutExt);
  const candidates = [
    `${basePath}.ts`,
    `${basePath}.mts`,
    `${basePath}.cts`,
    path.join(basePath, 'index.ts'),
    path.join(basePath, 'index.mts'),
  ];
  return candidates.find((c) => existsSync(c) && statSync(c).isFile());
}

interface ClosureResult {
  files: Set<string>;
  violations: Violation[];
}

/** BFS over the relative-import graph rooted at `entryFiles`, scanning every visited file for
 *  forbidden patterns and recording (but not following into) any non-relative specifier. */
function buildClosure(entryFiles: string[]): ClosureResult {
  const visited = new Set<string>();
  const violations: Violation[] = [];
  const queue = [...entryFiles];

  while (queue.length > 0) {
    const file = queue.shift()!;
    const resolved = path.resolve(file);
    if (visited.has(resolved)) continue;
    if (!existsSync(resolved)) continue;
    visited.add(resolved);

    const source = readFileSync(resolved, 'utf8');
    violations.push(...scanSource(source, resolved));

    for (const spec of specifiers(source)) {
      const next = resolveRelativeSpecifier(resolved, spec);
      if (next !== undefined && !visited.has(next)) queue.push(next);
    }
  }

  return { files: visited, violations };
}

// -------------------------------------------------------------------------------------------
// Tests
// -------------------------------------------------------------------------------------------

describe('no-llm: guarded directories are not vacuous', () => {
  it('finds a non-trivial number of source files in every guarded directory', () => {
    for (const dir of GUARDED_DIRS) {
      const files = listNonTestSourceFiles(dir);
      expect.soft(files.length, `expected source files under ${dir}`).toBeGreaterThan(0);
    }
  });
});

describe('no-llm: self-test — the scanner detects synthetic offenders', () => {
  const probe = path.join(REPLAY_DIR, 'zzz-probe.ts');

  it('catches a forbidden specifier (SDK + relative + non-relative agent import)', () => {
    // Built by concatenation, not written as literal `import ... from '...'` text: this file
    // lives under packages/core/src/replay, and no-llm.test.ts's own scanner greps every file in
    // this directory for that literal shape — including inside string literals, in this very
    // file. Assembling the probe at runtime keeps this file's raw source free of anything that
    // looks like a real forbidden import, while still exercising `scanSource` against the
    // fully-formed text below (identical to what a real offending file would contain).
    const kw = { imp: ['im', 'port'].join(''), frm: ['fr', 'om'].join(''), req: ['requi', 're'].join('') };
    const sdkSpec = ['@anthropic-ai', '/sdk'].join('');
    const agentLlm = ['../agent/llm', '.js'].join('');
    const agentIndex = ['../agent/index', '.js'].join('');
    const src = [
      `${kw.imp} Anthropic ${kw.frm} '${sdkSpec}';`,
      `${kw.imp} { createAnthropicClient } ${kw.frm} '${agentLlm}';`,
      `const m = await ${kw.imp}('${agentIndex}');`,
      `const r = ${kw.req}('${agentLlm}');`,
      `export { x } ${kw.frm} '../schema/index.js';`, // must NOT be flagged
    ].join('\n');
    const kinds = scanSource(src, probe).map((v) => `${v.kind}:${v.detail}`);
    expect(kinds).toContain(`specifier:${sdkSpec}`);
    expect(kinds).toContain(`specifier:${agentLlm}`);
    expect(kinds).toContain(`specifier:${agentIndex}`);
    expect(kinds.some((k) => k.includes('schema/index.js'))).toBe(false);
  });

  it('catches the literal api.anthropic.com host string', () => {
    const src = "const ENDPOINT = 'https://api.anthropic.com/v1/messages';";
    const violations = scanSource(src, probe);
    expect(violations.some((v) => v.kind === 'api-host')).toBe(true);
  });

  it('catches a fetch(...) call whose argument mentions anthropic', () => {
    const src = "await fetch(`https://api.anthropic.com/v1/messages`, { method: 'POST' });";
    const violations = scanSource(src, probe);
    expect(violations.some((v) => v.kind === 'fetch-anthropic')).toBe(true);
  });

  it('does NOT flag an unrelated fetch(...) call', () => {
    const src = "await fetch('http://localhost:4173/members/12345');";
    const violations = scanSource(src, probe);
    expect(violations.some((v) => v.kind === 'fetch-anthropic')).toBe(false);
  });

  it('catches process.env.ANTHROPIC_API_KEY and other ANTHROPIC_ env reads', () => {
    const src = [
      "const key = process.env.ANTHROPIC_API_KEY;",
      "const model = process.env.ANTHROPIC_MODEL ?? 'x';",
    ].join('\n');
    const violations = scanSource(src, probe).filter((v) => v.kind === 'env-read');
    expect(violations.map((v) => v.detail)).toEqual(
      expect.arrayContaining(['process.env.ANTHROPIC_API_KEY', 'process.env.ANTHROPIC_MODEL']),
    );
  });

  it('catches the @cu/core/agent and @cu/adapter-anthropic bare specifiers (the cross-package shapes apps/cu now uses)', () => {
    // Concatenated for the same reason as sdkSpec/agentLlm/agentIndex above: written as literal
    // quoted text these would themselves be a real forbidden import as far as no-llm.test.ts's
    // own scan of this directory is concerned.
    const kw = { imp: ['im', 'port'].join(''), frm: ['fr', 'om'].join('') };
    const agentPkgSpec = ['@cu/core', '/agent'].join('');
    const agentPkgTestHelpers = `${agentPkgSpec}/test-helpers`;
    const adapterPkgSpec = ['@cu/adapter', '-anthropic'].join('');
    const src = [
      `${kw.imp} { createAnthropicClient } ${kw.frm} '${adapterPkgSpec}';`,
      `${kw.imp} { discover } ${kw.frm} '${agentPkgSpec}';`,
      `${kw.imp} { findRef } ${kw.frm} '${agentPkgTestHelpers}';`,
      `${kw.imp} { validateCapability } ${kw.frm} '@cu/core/schema';`, // must NOT be flagged
    ].join('\n');
    const kinds = scanSource(src, probe).map((v) => `${v.kind}:${v.detail}`);
    expect(kinds).toContain(`specifier:${adapterPkgSpec}`);
    expect(kinds).toContain(`specifier:${agentPkgSpec}`);
    expect(kinds).toContain(`specifier:${agentPkgTestHelpers}`);
    expect(kinds.some((k) => k.includes('@cu/core/schema'))).toBe(false);
  });

  it('catches the risk-judge vendor: @cu/adapter-jev, api.typesafe.ai, a typesafe fetch, and TYPESAFE_* env reads', () => {
    // Concatenated so this file's own text holds no real-looking import of the adapter.
    const kw = { imp: ['im', 'port'].join(''), frm: ['fr', 'om'].join('') };
    const jevSpec = ['@cu/adapter', '-jev'].join('');
    const keyName = ['TYPESAFE', '_API_KEY'].join('');
    const src = [
      `${kw.imp} { createJevJudge } ${kw.frm} '${jevSpec}';`,
      `const m = await ${kw.imp}('${jevSpec}/judge');`,
      "const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';",
      "await fetch(`https://typesafe.example/v1`, { method: 'POST' });",
      `const a = process.env.${keyName};`,
      `const b = env['${keyName}'];`,
      `const NAME = '${keyName}';`,
    ].join('\n');
    const kinds = scanSource(src, probe).map((v) => `${v.kind}:${v.detail}`);
    expect(kinds).toContain(`specifier:${jevSpec}`);
    expect(kinds).toContain(`specifier:${jevSpec}/judge`);
    expect(kinds).toContain('api-host:api.typesafe.ai');
    expect(kinds.some((k) => k.startsWith('fetch-typesafe:'))).toBe(true);
    expect(kinds.filter((k) => k.startsWith('env-read:'))).toHaveLength(3);
  });

  it('(a) catches a non-allowlisted apps/cu file importing the judge factory (or discover/audit/eval) by relative path or @cu/cli subpath', () => {
    const kw = { imp: ['im', 'port'].join(''), frm: ['fr', 'om'].join('') };
    const catalogCmd = path.resolve(APPS_CU_SRC, 'commands', 'catalog.ts');
    const runtimeFile = path.resolve(APPS_CU_SRC, 'runtime', 'run-replay.ts');
    const auditCmd = path.resolve(APPS_CU_SRC, 'commands', 'audit.ts');
    const factoryImport = `${kw.imp} { resolveRiskJudge } ${kw.frm} './risk-judge.js';`;
    expect(scanCliSource(factoryImport, catalogCmd).map((v) => `${v.kind}:${v.detail}`)).toEqual(['model-file:./risk-judge.js']);
    expect(scanCliSource(`${kw.imp} { runAudit } ${kw.frm} '../commands/audit.js';`, runtimeFile).map((v) => v.kind)).toEqual(['model-file']);
    expect(scanCliSource(`${kw.imp} { runDiscover } ${kw.frm} '@cu/cli/commands/discover';`, runtimeFile).map((v) => v.kind)).toEqual(['model-file']);
    // ...while an allowlisted file may, and an unrelated relative import is fine.
    expect(scanCliSource(factoryImport, auditCmd)).toEqual([]);
    expect(scanCliSource(`${kw.imp} { globalsOf } ${kw.frm} '../globals.js';`, catalogCmd)).toEqual([]);
  });

  it('(b) catches a computed dynamic import or require (the name cannot be checked)', () => {
    const replayCmd = path.resolve(APPS_CU_SRC, 'commands', 'replay.ts');
    const imp = ['im', 'port'].join('');
    for (const src of [
      `const m = await ${imp}(['./risk', '-judge.js'].join(''));`,
      `const m = await ${imp}(name);`,
      'const m = await ' + imp + '(`./${which}.js`);',
      `const m = require(prefix + 'judge');`,
    ]) {
      expect(scanCliSource(src, replayCmd).map((v) => v.kind), src).toContain('dynamic-import');
    }
    // Literal forms (including a type-position import) are not flagged.
    expect(scanCliSource(`let e: ${imp}('node:fs').Dirent; const r = await ${imp}('@cu/relay/build');`, replayCmd)).toEqual([]);
  });

  it('(c) catches a relative or absolute path into a model adapter package', () => {
    const kw = { imp: ['im', 'port'].join(''), frm: ['fr', 'om'].join('') };
    const runtimeFile = path.resolve(APPS_CU_SRC, 'runtime', 'run-replay.ts');
    const jevPath = ['../../../../packages/adapter', '-jev/src/index.js'].join('');
    const anthropicPath = ['C:/repo/packages/adapter', '-anthropic/src/judge.ts'].join('');
    expect(scanCliSource(`${kw.imp} { createJevJudge } ${kw.frm} '${jevPath}';`, runtimeFile).map((v) => `${v.kind}:${v.detail}`)).toEqual([`specifier:${jevPath}`]);
    expect(scanSource(`${kw.imp} x ${kw.frm} '${anthropicPath}';`, probe).map((v) => v.kind)).toEqual(['specifier']);
  });

  it('does NOT flag a help string that merely names the TYPESAFE_ variable', () => {
    const keyName = ['TYPESAFE', '_API_KEY'].join('');
    const src = `program.option('--risk-judge <j>', 'auto (jev when ${keyName} is set, else anthropic)');`;
    expect(scanSource(src, probe)).toEqual([]);
  });

  it('is clean on ordinary replay-shaped source (no false positives)', () => {
    const src = [
      "import type { Policy } from '../schema/index.js';",
      "import { createSafeLogger } from './safe-logger.js';",
      "export function replayCapability() { return fetch('http://localhost:4173/x'); }",
    ].join('\n');
    expect(scanSource(src, probe)).toEqual([]);
  });
});

describe('no-llm: directory scan over replay/optimize/session/policy/surface/evidence/schema', () => {
  it('has zero violations across every guarded non-test source file', () => {
    const offenders: string[] = [];
    for (const dir of GUARDED_DIRS) {
      for (const file of listNonTestSourceFiles(dir)) {
        const source = readFileSync(file, 'utf8');
        for (const v of scanSource(source, file)) {
          offenders.push(`${path.relative(REPO_ROOT, file)} [${v.kind}] ${v.detail}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('no-llm: transitive import graph from the replay entry points', () => {
  it('finds the two entry files', () => {
    for (const f of ENTRY_FILES) expect(existsSync(f), f).toBe(true);
  });

  it('the closure is non-trivial (the graph walk actually follows imports)', () => {
    const { files } = buildClosure(ENTRY_FILES);
    // replay.ts alone pulls in steps.ts, classify.ts, escalate.ts, bind.ts, safe-logger.ts,
    // schema/*, surface/types.ts, session/types.ts, etc. A closure of 1-2 files would mean the
    // resolver silently failed to follow imports (vacuous graph).
    expect(files.size).toBeGreaterThan(5);
  });

  it('no module in the closure resolves into packages/core/src/agent, and no closure file has a forbidden pattern', () => {
    const { files, violations } = buildClosure(ENTRY_FILES);

    const agentFiles = [...files].filter((f) => f === AGENT_DIR || f.startsWith(AGENT_DIR + path.sep));
    expect(agentFiles).toEqual([]);

    const offenders = violations.map((v) => `${path.relative(REPO_ROOT, v.file)} [${v.kind}] ${v.detail}`);
    expect(offenders).toEqual([]);
  });
});

describe('no-llm: transitive import graph from the optimizer entry points', () => {
  it('finds the optimizer entry files, and the closure reaches replay (the walk is real)', () => {
    for (const f of OPTIMIZE_ENTRY_FILES) expect(existsSync(f), f).toBe(true);
    const { files } = buildClosure(OPTIMIZE_ENTRY_FILES);
    expect([...files].some((f) => f.startsWith(REPLAY_DIR + path.sep))).toBe(true);
  });

  it('no module reachable from the optimizer resolves into packages/core/src/agent or has a forbidden pattern', () => {
    const { files, violations } = buildClosure(OPTIMIZE_ENTRY_FILES);
    expect([...files].filter((f) => f === AGENT_DIR || f.startsWith(AGENT_DIR + path.sep))).toEqual([]);
    expect(violations.map((v) => `${path.relative(REPO_ROOT, v.file)} [${v.kind}] ${v.detail}`)).toEqual([]);
  });
});

describe('no-llm: apps/cu (runtime, catalog, CLI commands) never imports the LLM/agent or a judge adapter, except discover and the risk-judge factory', () => {
  it('finds a non-trivial number of source files in every scanned CLI-side directory', () => {
    for (const dir of CLI_SCAN_DIRS) {
      const files = listNonTestSourceFiles(dir);
      expect.soft(files.length, `expected source files under ${dir}`).toBeGreaterThan(0);
    }
  });

  it('finds the discover command file the exception refers to', () => {
    expect(existsSync(DISCOVER_COMMAND_FILE), DISCOVER_COMMAND_FILE).toBe(true);
  });

  it('the discover.ts exception is not vacuous: it really does import both @cu/core/agent and @cu/adapter-anthropic (so the carve-out is real, not a stale no-op)', () => {
    const source = readFileSync(DISCOVER_COMMAND_FILE, 'utf8');
    const specs = scanSource(source, DISCOVER_COMMAND_FILE)
      .filter((v) => v.kind === 'specifier')
      .map((v) => v.detail);
    expect(specs.some((s) => s === CORE_AGENT_SPECIFIER || s.startsWith(`${CORE_AGENT_SPECIFIER}/`))).toBe(true);
    expect(
      specs.some((s) => s === ADAPTER_ANTHROPIC_SPECIFIER || s.startsWith(`${ADAPTER_ANTHROPIC_SPECIFIER}/`)),
    ).toBe(true);
  });

  it('the risk-judge factory exception is not vacuous: it imports both judge adapters and reads the TYPESAFE_ key', () => {
    expect(existsSync(RISK_JUDGE_FACTORY_FILE), RISK_JUDGE_FACTORY_FILE).toBe(true);
    const violations = scanSource(readFileSync(RISK_JUDGE_FACTORY_FILE, 'utf8'), RISK_JUDGE_FACTORY_FILE);
    const specs = violations.filter((v) => v.kind === 'specifier').map((v) => v.detail);
    expect(specs).toContain(ADAPTER_JEV_SPECIFIER);
    expect(specs).toContain(ADAPTER_ANTHROPIC_SPECIFIER);
    expect(violations.some((v) => v.kind === 'env-read' && v.detail.includes('TYPESAFE_'))).toBe(true);
  });

  it('no replay-side entry point (commands/replay.ts, commands/catalog.ts, runtime/, catalog/) can reach discover, audit, the eval script or the judge factory, and nothing in its closure has a forbidden pattern', () => {
    const { files, violations } = buildClosure(REPLAY_SIDE_CLI_ENTRIES);
    for (const entry of REPLAY_SIDE_CLI_ENTRIES) expect(files.has(entry), entry).toBe(true);
    // runtime/index.ts alone re-exports compose/lifecycle/operators/relay-ui/run-replay.
    expect(files.size).toBeGreaterThan(5);
    const reached = MODEL_TOUCHING_CLI_FILES.filter((f) => files.has(f)).map((f) => path.relative(REPO_ROOT, f));
    expect(reached).toEqual([]);
    expect(violations.map((v) => `${path.relative(REPO_ROOT, v.file)} [${v.kind}] ${v.detail}`)).toEqual([]);
  });

  it('has zero violations across every non-test source file in apps/cu/src: only discover.ts and the factory may touch a model, and only the allowlist may import a model-touching file', () => {
    const offenders: string[] = [];
    for (const dir of CLI_SCAN_DIRS) {
      for (const file of listNonTestSourceFiles(dir)) {
        if (CLI_EXCEPTIONS.has(path.resolve(file))) continue;
        const source = readFileSync(file, 'utf8');
        for (const v of scanCliSource(source, file)) {
          offenders.push(`${path.relative(REPO_ROOT, file)} [${v.kind}] ${v.detail}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

// -------------------------------------------------------------------------------------------
// NEW: repo-wide `@anthropic-ai/` boundary scan (packages/, apps/, tools/, tests/)
//
// Why this exists ALONGSIDE the hand-picked directory scans above rather than replacing them: the
// directory scans above are more thorough per file (four pattern classes: specifier, literal API
// host, fetch() argument, ANTHROPIC_ env read) but only look at a curated list of subdirectories
// inside packages/core and apps/cu, so they say nothing about, say, a stray SDK import dropped
// into tools/video or apps/mock-app. This check is the opposite trade-off: only one pattern class
// (a real `@anthropic-ai/` import), but it walks EVERY .ts file (tests included) under all four
// workspace roots -- packages/, apps/, tools/, tests/ -- with no per-package directory list to
// maintain. That matters here specifically: other teams may add packages/browser-agent and
// apps/relay concurrently with this restructure, and this scan covers them the moment they exist,
// with zero changes to this file, because it walks the top-level workspace roots generically
// rather than enumerating package names.
//
// A subtlety this check has to get right: a test file can legitimately contain the text
// "@anthropic-ai/" inside a plain string literal (as part of building a synthetic "offending
// import" for a self-test, exactly like the probes above) without that file actually importing
// the package. `specifiers()` only reports a hit when the text is shaped like a real static
// import/export-from, bare `import('...')`, dynamic `import(...)`, or `require(...)` -- so a
// mention inside a comment or an ordinary string assignment is never reported. It is NOT immune
// to a fake, fully-formed import STATEMENT sitting in the file as literal text (the regex cannot
// tell that apart from a real one), which is exactly why every synthetic SDK-shaped specifier in
// this file's own self-tests is assembled by concatenation instead of written out as a single
// quoted literal -- see the comments at each call site.
// -------------------------------------------------------------------------------------------

const WORKSPACE_ROOT_NAMES = ['packages', 'apps', 'tools', 'tests'] as const;
const WORKSPACE_ROOTS = WORKSPACE_ROOT_NAMES.map((d) => path.resolve(REPO_ROOT, d));

const ADAPTER_ANTHROPIC_ROOT = path.resolve(REPO_ROOT, 'packages', 'adapter-anthropic');
const ADAPTER_ANTHROPIC_LLM_FILE = path.resolve(ADAPTER_ANTHROPIC_ROOT, 'src', 'llm.ts');

const ANTHROPIC_PACKAGE_PREFIX = '@anthropic-ai/';

/** True when `spec` (as extracted by `specifiers()`) names the `@anthropic-ai` npm scope by
 *  package specifier -- the real SDK package, or any subpath/future sibling package under the
 *  same scope. Never true for a relative disk path (those come back from `specifiers()` starting
 *  with `.`, e.g. `./sdk.js`). */
function isAnthropicPackageSpecifier(spec: string): boolean {
  return spec === `${ANTHROPIC_PACKAGE_PREFIX}sdk` || spec.startsWith(ANTHROPIC_PACKAGE_PREFIX);
}

function isUnderAdapterAnthropic(file: string): boolean {
  const resolved = path.resolve(file);
  return resolved === ADAPTER_ANTHROPIC_ROOT || resolved.startsWith(ADAPTER_ANTHROPIC_ROOT + path.sep);
}

function allWorkspaceTsFiles(): string[] {
  return WORKSPACE_ROOTS.flatMap((root) => listAllTsFilesRepoWide(root));
}

describe('no-llm: @anthropic-ai/ import boundary — repo-wide scan (packages/, apps/, tools/, tests/)', () => {
  it('finds .ts files under each workspace root (sanity: no root is silently empty)', () => {
    for (const root of WORKSPACE_ROOTS) {
      expect.soft(listAllTsFilesRepoWide(root).length, `expected .ts files under ${root}`).toBeGreaterThan(0);
    }
  });

  it('scans more than 150 files across packages/, apps/, tools/, tests/ (sanity: the walk is really looking at something, not a near-empty tree)', () => {
    expect(allWorkspaceTsFiles().length).toBeGreaterThan(150);
  });

  it('packages/adapter-anthropic/src/llm.ts really does import @anthropic-ai/ (the exclusion below is not vacuous)', () => {
    expect(existsSync(ADAPTER_ANTHROPIC_LLM_FILE), ADAPTER_ANTHROPIC_LLM_FILE).toBe(true);
    const source = readFileSync(ADAPTER_ANTHROPIC_LLM_FILE, 'utf8');
    const hits = specifiers(source).filter(isAnthropicPackageSpecifier);
    expect(hits.length).toBeGreaterThan(0);
  });

  it('no .ts file under packages/, apps/, tools/ or tests/, outside packages/adapter-anthropic/, imports @anthropic-ai/', () => {
    const offenders: string[] = [];
    for (const file of allWorkspaceTsFiles()) {
      if (isUnderAdapterAnthropic(file)) continue;
      const source = readFileSync(file, 'utf8');
      for (const spec of specifiers(source)) {
        if (isAnthropicPackageSpecifier(spec)) offenders.push(`${path.relative(REPO_ROOT, file)} -> ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

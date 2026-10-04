/**
 * Structural guarantee: replay is the production path and must run WITHOUT an LLM. No file in
 * packages/core/src/replay may import the Anthropic SDK, anything under packages/core/src/agent
 * (where discovery lives -- via a relative path or the '@cu/core/agent' package specifier), or
 * the '@cu/adapter-anthropic' package (the Anthropic-backed LlmClient implementation) -- directly
 * or via a dynamic import / require.
 *
 * Path note (hexagonal workspace restructure): this file lives at packages/core/src/replay, a
 * sibling of packages/core/src/agent, the same shape it had before the restructure at packages/core/src/replay
 * next to packages/core/src/agent. Every path below (REPLAY_DIR, the sibling agentDir lookup) is derived from
 * import.meta.url, so it needed no change on that account. What IS new post-restructure: a file
 * can now also reach the agent module or the LLM adapter by package name instead of only a
 * relative path (cross-package imports use package names, e.g. '@cu/core/agent'), so `isForbidden`
 * gained two bare-specifier checks alongside the original relative-path and SDK checks.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPLAY_DIR = path.dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = path.resolve(REPLAY_DIR, '..', 'agent');

// Bare package specifiers a file anywhere in the workspace could use to reach the agent module or
// the Anthropic adapter by name rather than by relative path.
const CORE_AGENT_SPECIFIER = '@cu/core/agent';
const ADAPTER_ANTHROPIC_SPECIFIER = '@cu/adapter-anthropic';

function listTsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return listTsFiles(full);
    return /\.(ts|mts|cts|js|mjs)$/.test(name) ? [full] : [];
  });
}

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

function isForbidden(spec: string, fromFile: string): boolean {
  if (spec === '@anthropic-ai/sdk' || spec.startsWith('@anthropic-ai/')) return true;
  if (spec === CORE_AGENT_SPECIFIER || spec.startsWith(`${CORE_AGENT_SPECIFIER}/`)) return true;
  if (spec === ADAPTER_ANTHROPIC_SPECIFIER || spec.startsWith(`${ADAPTER_ANTHROPIC_SPECIFIER}/`)) return true;
  if (spec.startsWith('.')) {
    const resolved = path.resolve(path.dirname(fromFile), spec);
    return resolved === AGENT_DIR || resolved.startsWith(AGENT_DIR + path.sep);
  }
  return /(^|\/)src\/agent(\/|$)/.test(spec);
}

describe('replay has no LLM dependency', () => {
  const files = listTsFiles(REPLAY_DIR).filter((f) => path.resolve(f) !== fileURLToPath(import.meta.url));

  it('finds the replay sources', () => {
    expect(files.some((f) => f.endsWith(`${path.sep}replay.ts`))).toBe(true);
  });

  it('no file in packages/core/src/replay imports @anthropic-ai/*, @cu/core/agent, or @cu/adapter-anthropic', () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const spec of specifiers(readFileSync(file, 'utf8'))) {
        if (isForbidden(spec, file)) offenders.push(`${path.relative(REPLAY_DIR, file)} -> ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the guard itself catches forbidden specifiers', () => {
    const probe = path.join(REPLAY_DIR, 'probe.ts');
    // The SDK specifier below is assembled from two string pieces at runtime, not written out as
    // one quoted literal: this file lives under packages/, which the repo-wide '@anthropic-ai/'
    // boundary scan (no-llm.redteam.test.ts, in this same directory) walks INCLUDING test files,
    // using the same real-import-syntax specifier extraction as `isForbidden` below. That scanner
    // reads raw file text, not evaluated JS, so it cannot tell a real import from an equally-
    // shaped fake one sitting fully assembled in a string constant -- only from one built out of
    // pieces the way `sdkSpec` is here. Assembling it at runtime keeps this file's raw source free
    // of anything that looks like a real forbidden import, while still exercising `isForbidden`
    // against the fully-formed text below (identical to what a real offending file would contain).
    const sdkSpec = ['@anthropic-ai', '/sdk'].join('');
    const src = [
      `import Anthropic from '${sdkSpec}';`,
      "import { runDiscovery } from '../agent/loop.js';",
      "const m = await import('../agent/index.js');",
      "import { discover } from '@cu/core/agent';",
      "import { createAnthropicClient } from '@cu/adapter-anthropic';",
      "export { x } from '../schema/index.js';",
    ].join('\n');
    const bad = specifiers(src).filter((s) => isForbidden(s, probe));
    // Order note: `specifiers()` groups matches by regex pattern (all `... from '...'` hits,
    // then bare `import '...'`, then dynamic `import(...)`, then `require(...)`), not by their
    // position in the source text -- so the dynamic import below sorts after both bare-specifier
    // `from` imports, even though it appears earlier on the page.
    expect(bad).toEqual([
      sdkSpec,
      '../agent/loop.js',
      '@cu/core/agent',
      '@cu/adapter-anthropic',
      '../agent/index.js',
    ]);
  });
});

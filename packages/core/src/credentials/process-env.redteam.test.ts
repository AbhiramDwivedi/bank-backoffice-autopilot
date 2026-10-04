/**
 * Redteam: credentials are read from the process environment in exactly one place, the env
 * CredentialProvider. A static scan of every non-test source file under `packages/core/src` and
 * `apps/cu/src` fails on any `process.env` access (dot, bracket, destructuring, or `env` imported
 * from `node:process`) outside an explicit allowlist, each entry limited to what it may read:
 *
 * - `packages/core/src/credentials/env.ts`: the env provider itself (the default `process.env`).
 * - `apps/cu/src/env.ts`: the `.env` loader, which writes into the environment.
 * - `apps/cu/src/commands/discover.ts`: `ANTHROPIC_*` only, the model key (no-llm.redteam's
 *   documented exception).
 * - `apps/cu/src/commands/risk-judge.ts`: the risk judge's model configuration (which judge,
 *   its key and model), read from the environment in that one file.
 *
 * Comments are stripped before scanning, so prose about `process.env` is not a finding. The
 * scanner has its own self-test below, so a regex that silently matches nothing fails too.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOTS = ['packages/core/src', 'apps/cu/src'];

/** File (repo-relative, forward slashes) -> names it may read: `'*'` any, a RegExp, or `''` for bare `process.env`. */
const ALLOW: Record<string, { names: '*' | RegExp; why: string }> = {
  'packages/core/src/credentials/env.ts': { names: /^$/, why: 'the env CredentialProvider (default parameter)' },
  'apps/cu/src/env.ts': { names: /^$/, why: 'the .env loader writes into the environment' },
  'apps/cu/src/commands/discover.ts': { names: /^ANTHROPIC_/, why: 'the model API key (no-llm exception)' },
  'apps/cu/src/commands/risk-judge.ts': { names: '*', why: 'risk-judge model configuration' },
};

/** Removes block and line comments (naively: a `//` inside a string literal also ends the scan of that line). */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

/** Every environment read in `src`: the variable name, or '' for a bare/destructured/imported `env`. */
function envReads(src: string): string[] {
  const code = stripComments(src);
  const out: string[] = [];
  for (const m of code.matchAll(/\bprocess\s*(?:\.\s*env|\[\s*['"`]env['"`]\s*\])(?:\s*\.\s*([A-Za-z_$][\w$]*)|\s*\[\s*['"`]([^'"`]+)['"`]\s*\])?/g)) {
    out.push(m[1] ?? m[2] ?? '');
  }
  const destructured = [...code.matchAll(/\{[^}]*\benv\b[^}]*\}\s*=\s*process\b/g)].length;
  const imported = [...code.matchAll(/import\s*\{[^}]*\benv\b[^}]*\}\s*from\s*['"](?:node:)?process['"]/g)].length;
  for (let i = 0; i < destructured + imported; i++) out.push('');
  return out;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(p));
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') && e.name !== 'test-helpers.ts') out.push(p);
  }
  return out;
}

describe('the scanner itself', () => {
  it('finds every form of environment read, and none in comments', () => {
    expect(envReads('const a = process.env.MOCK_PASSWORD;')).toEqual(['MOCK_PASSWORD']);
    expect(envReads("const a = process.env['API_TOKEN'];")).toEqual(['API_TOKEN']);
    expect(envReads('const a = process["env"].X;')).toEqual(['X']);
    expect(envReads('function f(e = process.env) {}')).toEqual(['']);
    expect(envReads('const { env } = process;')).toEqual(['']);
    expect(envReads("import { env } from 'node:process';")).toEqual(['']);
    expect(envReads('// process.env.MOCK_PASSWORD\n/* process.env.X */ const url = "http://x";')).toEqual([]);
  });
});

describe('credentials are read from process.env only by the env provider', () => {
  it('no non-test source file outside the allowlist reads process.env, and allowlisted files read only what they may', () => {
    const findings: string[] = [];
    for (const root of ROOTS) {
      for (const file of sourceFiles(root)) {
        const rel = file.split(path.sep).join('/');
        const allowed = ALLOW[rel];
        for (const name of envReads(fs.readFileSync(file, 'utf8'))) {
          if (allowed === undefined) findings.push(`${rel}: process.env${name ? `.${name}` : ''}`);
          else if (allowed.names !== '*' && !allowed.names.test(name)) findings.push(`${rel}: process.env${name ? `.${name}` : ''} (allowed: ${allowed.why})`);
        }
      }
    }
    expect(findings).toEqual([]);
  });

  it('the allowlisted env provider really is a reader (the allowlist is not stale)', () => {
    expect(envReads(fs.readFileSync('packages/core/src/credentials/env.ts', 'utf8'))).toEqual(['']);
  });
});

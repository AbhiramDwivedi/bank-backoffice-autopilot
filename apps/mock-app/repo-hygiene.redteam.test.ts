/**
 * Repo secrets hygiene. Fast, working-tree-only assertions over `git ls-files` (the set of files
 * git would actually publish or push) and `.gitignore`. It does not walk full git history
 * (`git log -p --all`); that is slow to run on every `vitest run`, so this suite instead catches
 * regressions cheaply on every run over the current working tree.
 *
 * See also packages/core/src/replay/no-llm.redteam.test.ts for a related, code-shaped structural
 * guarantee.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// This file used to live at mock-app/repo-hygiene.redteam.test.ts, one directory below the repo
// root, so '..' reached it. It now lives at apps/mock-app/repo-hygiene.redteam.test.ts, two
// directories below the repo root.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function trackedFiles(): string[] {
  return git(['ls-files']).split('\n').filter(Boolean);
}

describe('repo hygiene: tracked file list', () => {
  const files = trackedFiles();

  it('is not empty (sanity: the scan is actually looking at something)', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  // `.env.example` is the one allowed name: a template of variable names with empty or demo values.
  it('tracks no .env file anywhere (except .env.example)', () => {
    const offenders = files.filter((f) => /(^|\/)\.env(\..*)?$/.test(f) && !/(^|\/)\.env\.example$/.test(f));
    expect(offenders).toEqual([]);
  });

  it('tracks no runs/ directory (evidence output must never be committed)', () => {
    const offenders = files.filter((f) => f === 'runs' || f.startsWith('runs/'));
    expect(offenders).toEqual([]);
  });

  it('tracks no .pdf files', () => {
    const offenders = files.filter((f) => f.toLowerCase().endsWith('.pdf'));
    expect(offenders).toEqual([]);
  });

  it('tracks no APPROACH.md', () => {
    const offenders = files.filter((f) => path.basename(f) === 'APPROACH.md');
    expect(offenders).toEqual([]);
  });
});

describe('repo hygiene: no Anthropic API key material in tracked content', () => {
  // Built at runtime so this file never contains the prefix it scans for.
  const keyPrefix = ['sk', 'ant', ''].join('-');

  it('git grep finds no Anthropic key prefix in any tracked file', () => {
    let output: string;
    try {
      // git grep exits 1 when there are no matches -- that's the success case here.
      output = git(['grep', '-n', '-I', '-e', keyPrefix]);
    } catch (err) {
      const e = err as { status?: number; stdout?: string };
      if (e.status === 1) {
        output = '';
      } else {
        throw err;
      }
    }
    expect(output).toBe('');
  });

  // A real key starts with the prefix above and has a long body. Obvious fixtures such as `sk-test-123` (used by
  // apps/cu/src/env.test.ts to test .env parsing) are allowed; anything key-shaped (20+ chars) is not.
  it('git grep finds no key-shaped ANTHROPIC_API_KEY=<value> assignment in tracked content', () => {
    let output: string;
    try {
      output = git(['grep', '-n', '-I', '-P', '-e', "ANTHROPIC_API_KEY\\s*[=:]\\s*['\"]?sk-[A-Za-z0-9_-]{20,}"]);
    } catch (err) {
      const e = err as { status?: number };
      if (e.status === 1) output = '';
      else throw err;
    }
    expect(output).toBe('');
  });
});

describe('repo hygiene: .gitignore covers the sensitive paths', () => {
  const gitignore = git(['show', 'HEAD:.gitignore']);

  it.each(['.env', 'runs/', '*.pdf', 'APPROACH.md'])('contains an entry for %s', (entry) => {
    expect(gitignore.split('\n').map((l) => l.trim())).toContain(entry);
  });
});

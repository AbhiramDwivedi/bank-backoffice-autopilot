/**
 * `file:<path>` credential provider: a JSON object or a dotenv-style file kept outside the
 * repository.
 *
 * Non-obvious decisions:
 * - A credentials file inside a git work tree is refused unless git itself confirms it is ignored.
 *   The point is that a commit can never pick it up by accident. "Inside a work tree" is decided by
 *   walking up from the file's directory looking for a `.git` entry (a directory, or a file for
 *   worktrees and submodules), so it works without git installed. Confirming "ignored" needs git
 *   (`git check-ignore`); when git is missing or errors, the provider fails closed (`refused`).
 * - Failure messages never quote the file. `JSON.parse` errors in V8 quote a slice of the input,
 *   so they are replaced with a fixed message; a non-string value is reported by key only.
 * - Only the requested names are kept, so the run holds no more secret material than it needs.
 * - A leading UTF-8 byte-order mark is stripped first (Windows PowerShell 5.1 writes one).
 * - Format detection: trimmed content starting with `{` is JSON (an object of string values),
 *   anything else is dotenv-style, the same dialect as the CLI's `.env` loader, precisely:
 *   one `KEY=VALUE` per line (KEY is `[A-Za-z_][A-Za-z0-9_]*`, whitespace around `=` and at the
 *   line ends trimmed); an optional leading `export `; `#` starts a comment only as the first
 *   non-blank character of a line (no inline comments: `A=b # c` is the value `b # c`); one pair
 *   of matching surrounding quotes (`"..."` or `'...'`) is stripped; no escape processing (`\n` stays
 *   two characters); no multi-line values; no variable expansion. Lines that match none of this
 *   are ignored. A later duplicate key wins.
 * - A relative path resolves against the process's current working directory (or `opts.cwd`) at
 *   load time, not when the provider is built.
 * - A path whose directory does not exist is `unavailable`, checked before git is asked anything.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { credentialFailure, credentialSet, type CredentialLoadResult, type CredentialProvider } from '@cu/core/credentials';

/** Whether git considers a path ignored. `unknown`: git is missing or failed, so it cannot say. */
export type GitIgnoreAnswer = 'ignored' | 'not_ignored' | 'unknown';

/** Asks git whether a file is ignored. Injectable so tests need not depend on a real git. */
export interface GitProbe {
  isIgnored(absPath: string): GitIgnoreAnswer;
}

/** Options for {@link fileCredentialProvider}. */
export interface FileCredentialProviderOptions {
  /** Base for a relative `path`. Default `process.cwd()`. */
  cwd?: string;
  /** Default {@link realGitProbe}. */
  git?: GitProbe;
}

/** The real probe: `git check-ignore -q -- <path>` from the file's directory, no shell. Exit 0 is
 *  ignored, exit 1 is not ignored, anything else (git missing, not a repo, error) is unknown. */
export const realGitProbe: GitProbe = {
  isIgnored(absPath) {
    const r = spawnSync('git', ['check-ignore', '-q', '--', absPath], {
      cwd: path.dirname(absPath),
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
      timeout: 10_000,
    });
    if (r.error !== undefined) return 'unknown';
    if (r.status === 0) return 'ignored';
    if (r.status === 1) return 'not_ignored';
    return 'unknown';
  },
};

/** True when `dir` or one of its ancestors holds a `.git` entry (directory or file). */
export function isInsideGitWorkTree(dir: string): boolean {
  let current = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(current, '.git'))) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/** Parses dotenv-style lines into a name -> value map (same rules as apps/cu/src/env.ts). */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trimStart().startsWith('#')) continue;
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(raw);
    if (!m) continue;
    out[m[1]!] = m[2]!.replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

type ParseResult = { ok: true; entries: Record<string, string> } | { ok: false; message: string; names: string[] };

/** Parses the file's text. JSON errors never echo the content; a non-string requested value is
 *  reported by key. Unrequested keys are never inspected or kept. */
function parseContent(raw: string, names: readonly string[]): ParseResult {
  // A leading UTF-8 BOM (Windows PowerShell 5.1 `Set-Content -Encoding utf8` writes one) is not
  // content: left in, it would make JSON unparseable and glue itself to the first dotenv key.
  const text = raw.startsWith('﻿') ? raw.slice(1) : raw;
  if (!text.trim().startsWith('{')) {
    const all = parseDotenv(text);
    const entries: Record<string, string> = {};
    for (const n of names) if (Object.prototype.hasOwnProperty.call(all, n)) entries[n] = all[n]!;
    return { ok: true, entries };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, message: 'the file starts with "{" but is not valid JSON', names: [] };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, message: 'the file is not a JSON object of name -> string', names: [] };
  }
  const obj = parsed as Record<string, unknown>;
  const entries: Record<string, string> = {};
  const bad: string[] = [];
  for (const n of names) {
    if (!Object.prototype.hasOwnProperty.call(obj, n)) continue;
    const v = obj[n];
    if (typeof v === 'string') entries[n] = v;
    else bad.push(n);
  }
  if (bad.length > 0) return { ok: false, message: `value is not a string for: ${bad.join(', ')}`, names: bad };
  return { ok: true, entries };
}

/**
 * A provider reading credentials from the file at `filePath` (relative paths resolve against
 * `opts.cwd`). The file is read on each `load`. The provider id is `file:<filePath as given>`.
 */
export function fileCredentialProvider(filePath: string, opts: FileCredentialProviderOptions = {}): CredentialProvider {
  const id = `file:${filePath}`;
  const git = opts.git ?? realGitProbe;
  return {
    id,
    load(names): Promise<CredentialLoadResult> {
      const abs = path.resolve(opts.cwd ?? process.cwd(), filePath);
      // Checked first: git cannot run from a directory that does not exist, and "git could not
      // confirm" would misdescribe a plain typo in the path.
      if (!fs.existsSync(path.dirname(abs))) {
        return Promise.resolve(credentialFailure('unavailable', id, names, "the credentials file's directory does not exist"));
      }
      if (isInsideGitWorkTree(path.dirname(abs))) {
        const answer = git.isIgnored(abs);
        if (answer === 'not_ignored') {
          return Promise.resolve(
            credentialFailure(
              'refused',
              id,
              names,
              'the credentials file is inside a git work tree and is not git-ignored, so a commit could pick it up; move it outside the repository or add it to .gitignore',
            ),
          );
        }
        if (answer === 'unknown') {
          return Promise.resolve(
            credentialFailure(
              'refused',
              id,
              names,
              'the credentials file is inside a git work tree and git could not confirm it is ignored (git failed to run, or is not installed); move it outside the repository',
            ),
          );
        }
      }
      let text: string;
      try {
        text = fs.readFileSync(abs, 'utf8');
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? 'error';
        return Promise.resolve(credentialFailure('unavailable', id, names, `cannot read the credentials file (${code})`));
      }
      const parsed = parseContent(text, names);
      if (!parsed.ok) return Promise.resolve(credentialFailure('malformed', id, parsed.names.length > 0 ? parsed.names : names, parsed.message));
      return Promise.resolve({ ok: true, set: credentialSet(parsed.entries) });
    },
  };
}

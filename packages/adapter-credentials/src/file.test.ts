/**
 * The file: credential provider: JSON and dotenv formats, the git-work-tree refusal (with an
 * injected git probe; the real-git cases live in credentials.redteam.test.ts), and failure kinds.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadCredentials } from '@cu/core/credentials';
import { fileCredentialProvider, isInsideGitWorkTree, parseDotenv, type GitProbe } from './file.js';
import { spawnSync } from 'node:child_process';
import { gitAvailable, tempDir } from './test-helpers.js';

const tmp = tempDir('cu-cred-file-');
afterAll(() => tmp.cleanup());

const neverAsked: GitProbe = {
  isIgnored: () => {
    throw new Error('git probe must not be consulted outside a work tree');
  },
};

function write(name: string, content: string): string {
  const p = path.join(tmp.dir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

describe('parseDotenv', () => {
  it('handles comments, export, quotes and whitespace like the CLI .env loader', () => {
    expect(parseDotenv('# c\nexport A=1\nB = "two words"\nC=\'x\'\n  # D=no\nnot a line\nE=a=b\r\n')).toEqual({ A: '1', B: 'two words', C: 'x', E: 'a=b' });
  });
});

describe('fileCredentialProvider', () => {
  it('reads a JSON object and keeps only the requested names', async () => {
    const p = write('creds.json', JSON.stringify({ APP_USER: 'u1', APP_PASSWORD: 'p1', OTHER: 'o1' }));
    const r = await fileCredentialProvider(p, { git: neverAsked }).load(['APP_USER', 'APP_PASSWORD']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.set.get('APP_USER')).toBe('u1');
    expect(r.set.get('APP_PASSWORD')).toBe('p1');
    expect(r.set.get('OTHER')).toBeUndefined();
    expect(r.set.values().sort()).toEqual(['p1', 'u1']);
  });

  it('reads a dotenv-style file', async () => {
    const p = write('creds.env', 'APP_USER=u2\nexport APP_PASSWORD="p 2"\n');
    const r = await fileCredentialProvider(p, { git: neverAsked }).load(['APP_USER', 'APP_PASSWORD']);
    expect(r.ok && r.set.get('APP_PASSWORD')).toBe('p 2');
  });

  it('resolves a relative path against opts.cwd and keeps the path as given in the id', async () => {
    write('rel/creds.json', JSON.stringify({ A: 'a' }));
    const p = fileCredentialProvider('rel/creds.json', { cwd: tmp.dir, git: neverAsked });
    expect(p.id).toBe('file:rel/creds.json');
    const r = await p.load(['A']);
    expect(r.ok && r.set.get('A')).toBe('a');
  });

  it('a missing name surfaces as `missing` through loadCredentials', async () => {
    const p = write('partial.json', JSON.stringify({ A: 'a' }));
    const r = await loadCredentials(fileCredentialProvider(p, { git: neverAsked }), ['A', 'B']);
    expect(r.ok ? undefined : r.error).toMatchObject({ code: 'missing', names: ['B'] });
  });

  it('a missing file is `unavailable`', async () => {
    const r = await fileCredentialProvider(path.join(tmp.dir, 'nope.json'), { git: neverAsked }).load(['A']);
    expect(r.ok ? undefined : r.error.code).toBe('unavailable');
  });

  it('invalid JSON, a JSON array, and a non-string value are `malformed`', async () => {
    const bad = await fileCredentialProvider(write('bad.json', '{ "A": '), { git: neverAsked }).load(['A']);
    expect(bad.ok ? undefined : bad.error.code).toBe('malformed');
    // Starts with "{" so it is parsed as JSON, but is not an object of strings at the top level.
    const notObject = await fileCredentialProvider(write('notobj.json', '{"A": "a"} trailing'), { git: neverAsked }).load(['A']);
    expect(notObject.ok ? undefined : notObject.error.code).toBe('malformed');
    // An object without A is not malformed; `missing` is loadCredentials' call.
    const without = await fileCredentialProvider(write('without.json', '{"x":"1"}'), { git: neverAsked }).load(['A']);
    expect(without.ok).toBe(true);
    const num = await fileCredentialProvider(write('num.json', '{"A": 5, "B": "b"}'), { git: neverAsked }).load(['A', 'B']);
    expect(num.ok ? undefined : num.error).toMatchObject({ code: 'malformed', names: ['A'] });
  });

  it('inside a git work tree: refused unless the probe says ignored; unknown fails closed', async () => {
    const repo = path.join(tmp.dir, 'repo');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    const p = write('repo/sub/creds.json', JSON.stringify({ A: 'a' }));
    expect(isInsideGitWorkTree(path.dirname(p))).toBe(true);
    const asked: string[] = [];
    const probe = (answer: 'ignored' | 'not_ignored' | 'unknown'): GitProbe => ({
      isIgnored: (abs) => {
        asked.push(abs);
        return answer;
      },
    });
    const refused = await fileCredentialProvider(p, { git: probe('not_ignored') }).load(['A']);
    expect(refused.ok ? undefined : refused.error.code).toBe('refused');
    expect(refused.ok ? '' : refused.error.message).toContain('.gitignore');
    const unknown = await fileCredentialProvider(p, { git: probe('unknown') }).load(['A']);
    expect(unknown.ok ? undefined : unknown.error.code).toBe('refused');
    const ok = await fileCredentialProvider(p, { git: probe('ignored') }).load(['A']);
    expect(ok.ok && ok.set.get('A')).toBe('a');
    expect(asked.every((a) => a === path.resolve(p))).toBe(true);
  });

  it('strips a leading UTF-8 BOM, for JSON and for dotenv (what PowerShell 5.1 Set-Content -Encoding utf8 writes)', async () => {
    const json = await fileCredentialProvider(write('bom.json', '﻿{"A": "a-json"}'), { git: neverAsked }).load(['A']);
    expect(json.ok ? json.set.get('A') : json.error.code).toBe('a-json');
    const env = await fileCredentialProvider(write('bom.env', '﻿A=a-env\nB=b-env\n'), { git: neverAsked }).load(['A', 'B']);
    expect(env.ok ? [env.set.get('A'), env.set.get('B')] : env.error.code).toEqual(['a-env', 'b-env']);
  });

  it('a file whose directory does not exist is `unavailable` and git is never asked, even inside a work tree', async () => {
    const repo = path.join(tmp.dir, 'repo-missing-dir');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    const p = path.join(repo, 'no-such-dir', 'creds.json');
    const r = await fileCredentialProvider(p, { git: neverAsked }).load(['A']);
    expect(r.ok ? undefined : r.error).toMatchObject({ code: 'unavailable', message: "the credentials file's directory does not exist" });
  });

  it.skipIf(!gitAvailable())('with real git: a missing directory inside a real work tree is `unavailable`, not a git refusal', async () => {
    const repo = path.join(tmp.dir, 'real-repo-missing-dir');
    fs.mkdirSync(repo, { recursive: true });
    const init = spawnSync('git', ['init', '-q'], { cwd: repo, windowsHide: true, stdio: 'ignore' });
    expect(init.status).toBe(0);
    const r = await fileCredentialProvider(path.join(repo, 'typo', 'creds.json')).load(['A']);
    expect(r.ok ? undefined : r.error.code).toBe('unavailable');
    expect(r.ok ? '' : r.error.message).not.toContain('git');
  });

  it('documents the dotenv dialect: no inline comments, no escape processing', () => {
    expect(parseDotenv('A=b # c\nB="x\\ny"\n')).toEqual({ A: 'b # c', B: 'x\\ny' });
  });

  it('a .git FILE (worktree / submodule) also marks a work tree', () => {
    const wt = path.join(tmp.dir, 'wt');
    fs.mkdirSync(wt, { recursive: true });
    fs.writeFileSync(path.join(wt, '.git'), 'gitdir: /elsewhere\n');
    expect(isInsideGitWorkTree(wt)).toBe(true);
    expect(isInsideGitWorkTree(tmp.dir)).toBe(false);
  });
});

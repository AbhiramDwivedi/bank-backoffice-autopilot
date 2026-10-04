/** `.env` loader (apps/cu/src/env.ts). Uses an isolated `cwd` (temp dir) and a plain `env` object per
 *  test, never `process.env` itself. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadEnv } from './env.js';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-env-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('loadEnv', () => {
  it('sets the mock demo defaults when no .env file exists', () => {
    const env: NodeJS.ProcessEnv = {};
    const set = loadEnv(tempDir(), env);
    expect(set).toEqual([]);
    expect(env.MOCK_USER).toBe('operator1');
    expect(env.MOCK_PASSWORD).toBe('demo-pass-123');
  });

  it('reads KEY=VALUE lines from <cwd>/.env, unquoting a quoted value', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, '.env'), ['ANTHROPIC_API_KEY=sk-test-123', 'FOO="bar baz"', "SINGLE='q u o t e d'"].join('\n'));
    const env: NodeJS.ProcessEnv = {};
    const set = loadEnv(dir, env);
    expect(set.sort()).toEqual(['ANTHROPIC_API_KEY', 'FOO', 'SINGLE']);
    expect(env.ANTHROPIC_API_KEY).toBe('sk-test-123');
    expect(env.FOO).toBe('bar baz');
    expect(env.SINGLE).toBe('q u o t e d');
  });

  it('never overwrites a variable already present in env', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, '.env'), 'MOCK_PASSWORD=from-dotenv\n');
    const env: NodeJS.ProcessEnv = { MOCK_PASSWORD: 'already-set' };
    const set = loadEnv(dir, env);
    expect(set).toEqual([]);
    expect(env.MOCK_PASSWORD).toBe('already-set');
  });

  it('ignores comment lines and blank lines, and supports "export KEY=VALUE"', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, '.env'), ['# a comment', '', 'export EXPORTED=yes', '   # indented comment'].join('\n'));
    const env: NodeJS.ProcessEnv = {};
    loadEnv(dir, env);
    expect(env.EXPORTED).toBe('yes');
  });

  it('applies the mock demo login only to names that are unset: an explicit empty value stays empty', () => {
    const env: NodeJS.ProcessEnv = { MOCK_USER: 'someone-else', MOCK_PASSWORD: '' };
    loadEnv(tempDir(), env);
    expect(env.MOCK_USER).toBe('someone-else');
    expect(env.MOCK_PASSWORD).toBe('');
  });

  it('the returned NAMES never include a value', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, '.env'), 'SECRET_TOKEN=super-secret-value\n');
    const env: NodeJS.ProcessEnv = {};
    const set = loadEnv(dir, env);
    expect(set).toEqual(['SECRET_TOKEN']);
    expect(JSON.stringify(set)).not.toContain('super-secret-value');
  });
});

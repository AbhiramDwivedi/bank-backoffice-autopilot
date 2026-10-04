/**
 * Red team: no failure of the file: or exec: provider carries a credential value. Each case plants
 * a known secret where a careless implementation would echo it (a helper's stdout before a
 * non-zero exit, truncated JSON that V8's parse error would quote, an invalid credentials file),
 * and asserts neither the failure message nor the serialized result contains it. Also pins the
 * git-work-tree refusal against a real `git init` repository.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { loadCredentials, type CredentialLoadResult } from '@cu/core/credentials';
import { execCredentialProvider } from './exec.js';
import { fileCredentialProvider } from './file.js';
import { gitAvailable, helperCommand, tempDir } from './test-helpers.js';

const SECRET = 's3cret-value-9f2c';
const tmp = tempDir('cu-cred-redteam-');
afterAll(() => tmp.cleanup());
const quiet = { stderr: 'ignore' as const };

function expectNoSecret(r: CredentialLoadResult): void {
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.error.message).not.toContain(SECRET);
  expect(JSON.stringify(r)).not.toContain(SECRET);
}

describe('exec: failures never carry a value', () => {
  it('a helper that prints the secret then exits 1', async () => {
    const cmd = helperCommand(tmp.dir, 'leak-exit', `process.stdout.write(JSON.stringify({ A: ${JSON.stringify(SECRET)} })); process.exit(1);`);
    expectNoSecret(await execCredentialProvider(cmd, quiet).load(['A']));
  });

  it('truncated JSON containing the secret (V8 would quote it in the parse error)', async () => {
    const cmd = helperCommand(tmp.dir, 'leak-trunc', `process.stdout.write('{"A": "${SECRET}", ');`);
    expectNoSecret(await execCredentialProvider(cmd, quiet).load(['A']));
  });

  it('plain text containing the secret', async () => {
    const cmd = helperCommand(tmp.dir, 'leak-text', `process.stdout.write('token=${SECRET}');`);
    expectNoSecret(await execCredentialProvider(cmd, quiet).load(['A']));
  });

  it('a non-string value next to the secret', async () => {
    const cmd = helperCommand(tmp.dir, 'leak-nonstring', `process.stdout.write(JSON.stringify({ A: { nested: ${JSON.stringify(SECRET)} } }));`);
    expectNoSecret(await execCredentialProvider(cmd, quiet).load(['A']));
  });

  it('oversized output that starts with the secret', async () => {
    const cmd = helperCommand(tmp.dir, 'leak-flood', `process.stdout.write('${SECRET}' + 'x'.repeat(100000));`);
    expectNoSecret(await execCredentialProvider(cmd, { ...quiet, maxOutputBytes: 64 }).load(['A']));
  });

  it('a timeout after printing the secret', async () => {
    const cmd = helperCommand(tmp.dir, 'leak-sleep', `process.stdout.write('${SECRET}'); setTimeout(() => {}, 60000);`);
    expectNoSecret(await execCredentialProvider(cmd, { ...quiet, timeoutMs: 400 }).load(['A']));
  });

  it('a missing program whose argument is a token: neither id nor message carries it', async () => {
    const r = await execCredentialProvider(`cu-no-such-helper-xyz --token ${SECRET}`, quiet).load(['A']);
    expectNoSecret(r);
  });

  it('a partial answer reported as missing names the absent name, never the present value', async () => {
    const cmd = helperCommand(tmp.dir, 'partial', `process.stdout.write(JSON.stringify({ A: ${JSON.stringify(SECRET)} }));`);
    expectNoSecret(await loadCredentials(execCredentialProvider(cmd, quiet), ['A', 'B']));
  });
});

describe('file: failures never carry a value', () => {
  it('a credentials file with invalid JSON containing the secret', async () => {
    const p = path.join(tmp.dir, 'invalid.json');
    fs.writeFileSync(p, `{"A": "${SECRET}", oops`);
    expectNoSecret(await fileCredentialProvider(p).load(['A']));
  });

  it('a non-string JSON value holding the secret', async () => {
    const p = path.join(tmp.dir, 'nonstring.json');
    fs.writeFileSync(p, JSON.stringify({ A: [SECRET] }));
    expectNoSecret(await fileCredentialProvider(p).load(['A']));
  });

  it('a partial file reported as missing', async () => {
    const p = path.join(tmp.dir, 'partial.json');
    fs.writeFileSync(p, JSON.stringify({ A: SECRET }));
    expectNoSecret(await loadCredentials(fileCredentialProvider(p), ['A', 'B']));
  });
});

describe.skipIf(!gitAvailable())('file: inside a real git work tree', () => {
  const repo = path.join(tmp.dir, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const init = spawnSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore', windowsHide: true });

  it('git init worked', () => {
    expect(init.status).toBe(0);
  });

  it('a credentials file that is not git-ignored is refused, without reading or echoing it', async () => {
    const p = path.join(repo, 'creds.json');
    fs.writeFileSync(p, JSON.stringify({ A: SECRET }));
    const r = await fileCredentialProvider(p).load(['A']);
    expectNoSecret(r);
    expect(r.ok ? undefined : r.error.code).toBe('refused');
  });

  it('the same file is allowed once .gitignore covers it', async () => {
    const p = path.join(repo, 'local', 'creds.json');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ A: SECRET }));
    fs.writeFileSync(path.join(repo, '.gitignore'), 'local/\n');
    const r = await fileCredentialProvider(p).load(['A']);
    expect(r.ok && r.set.get('A')).toBe(SECRET);
  });
});

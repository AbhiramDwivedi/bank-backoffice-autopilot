/**
 * The exec: credential provider: argv parsing, the stdin/stdout JSON protocol, and every failure
 * kind. Helpers are tiny Node scripts run with this process's own Node binary.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { loadCredentials } from '@cu/core/credentials';
import { execCredentialProvider, parseCommandLine } from './exec.js';
import { helperCommand, tempDir } from './test-helpers.js';

const tmp = tempDir('cu-cred-exec-');
afterAll(() => tmp.cleanup());

const echoAll = `
let input = '';
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  const { names } = JSON.parse(input);
  const out = { EXTRA_KEY: 'extra-value' };
  for (const n of names) if (n !== 'ABSENT') out[n] = 'value-of-' + n;
  process.stdout.write(JSON.stringify(out));
});
`;

const quiet = { stderr: 'ignore' as const };

/** Windows: the pids of running PING.EXE processes. */
function pingPids(): number[] {
  const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq PING.EXE', '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
  return (r.stdout ?? '')
    .split(/\r?\n/)
    .map((line) => /^"PING\.EXE","(\d+)"/i.exec(line)?.[1])
    .filter((p): p is string => p !== undefined)
    .map(Number);
}

/** True once `pid` no longer exists (polled up to `withinMs`). */
async function processGone(pid: number, withinMs: number): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') return true;
    }
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('parseCommandLine', () => {
  it('splits on unquoted whitespace', () => {
    expect(parseCommandLine('  op-helper  --vault  Ops ')).toEqual({ ok: true, argv: ['op-helper', '--vault', 'Ops'] });
  });
  it('groups double quotes and honours \\" and \\\\ inside them only', () => {
    expect(parseCommandLine('"C:\\Program Files\\h.exe" "a \\"b\\" \\\\c \\d"')).toEqual({
      ok: true,
      argv: ['C:\\Program Files\\h.exe', 'a "b" \\c \\d'],
    });
  });
  it('groups single quotes literally', () => {
    expect(parseCommandLine("helper 'a \\\" b'")).toEqual({ ok: true, argv: ['helper', 'a \\" b'] });
  });
  it('keeps backslashes literal outside quotes (Windows paths work unquoted)', () => {
    expect(parseCommandLine('C:\\tools\\helper.exe --x')).toEqual({ ok: true, argv: ['C:\\tools\\helper.exe', '--x'] });
  });
  it('joins adjacent quoted and unquoted parts into one argument, and keeps an empty quoted argument', () => {
    expect(parseCommandLine('h --name="a b" ""')).toEqual({ ok: true, argv: ['h', '--name=a b', ''] });
  });
  it('rejects an unterminated quote and an empty command', () => {
    expect(parseCommandLine('helper "oops').ok).toBe(false);
    expect(parseCommandLine("helper 'oops").ok).toBe(false);
    expect(parseCommandLine('   ').ok).toBe(false);
    expect(parseCommandLine('""').ok).toBe(false);
  });
});

describe('execCredentialProvider', () => {
  it('passes the requested names as JSON on stdin and returns only those names', async () => {
    const cmd = helperCommand(tmp.dir, 'echo-all', echoAll);
    const r = await execCredentialProvider(cmd, quiet).load(['APP_USER', 'APP_PASSWORD']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.set.get('APP_USER')).toBe('value-of-APP_USER');
    expect(r.set.get('APP_PASSWORD')).toBe('value-of-APP_PASSWORD');
    expect(r.set.get('EXTRA_KEY')).toBeUndefined();
    expect(r.set.values()).not.toContain('extra-value');
    expect(r.set.names()).toEqual(['APP_PASSWORD', 'APP_USER']);
  });

  it('receives exactly {"names":[...]} on stdin', async () => {
    const cmd = helperCommand(
      tmp.dir,
      'stdin-echo',
      `let s=''; process.stdin.on('data',c=>s+=c); process.stdin.on('end',()=>process.stdout.write(JSON.stringify({ RAW: s })));`,
    );
    const r = await execCredentialProvider(cmd, quiet).load(['RAW']);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.set.get('RAW')).toBe('{"names":["RAW"]}\n');
  });

  it('a name the helper does not return surfaces as `missing` through loadCredentials', async () => {
    const cmd = helperCommand(tmp.dir, 'echo-all-2', echoAll);
    const r = await loadCredentials(execCredentialProvider(cmd, quiet), ['APP_USER', 'ABSENT']);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('missing');
    expect(r.error.names).toEqual(['ABSENT']);
    expect(r.error.providerId).toBe(`exec:${process.execPath}`);
  });

  it('non-zero exit is `failed` with the exit code', async () => {
    const cmd = helperCommand(tmp.dir, 'exit3', `process.stdout.write('{}'); process.exit(3);`);
    const r = await execCredentialProvider(cmd, quiet).load(['A']);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('failed');
    expect(r.error.message).toContain('code 3');
  });

  it('unparseable stdout is `malformed`', async () => {
    const cmd = helperCommand(tmp.dir, 'garbage', `process.stdout.write('not json');`);
    const r = await execCredentialProvider(cmd, quiet).load(['A']);
    expect(r.ok ? undefined : r.error.code).toBe('malformed');
  });

  it('a JSON array is `malformed`', async () => {
    const cmd = helperCommand(tmp.dir, 'array', `process.stdout.write('["A"]');`);
    const r = await execCredentialProvider(cmd, quiet).load(['A']);
    expect(r.ok ? undefined : r.error.code).toBe('malformed');
  });

  it('a non-string value for a requested name is `malformed` naming the key', async () => {
    const cmd = helperCommand(tmp.dir, 'nonstring', `process.stdout.write(JSON.stringify({ A: 42, B: 'ok', C: { x: 1 } }));`);
    const r = await execCredentialProvider(cmd, quiet).load(['A', 'B']);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('malformed');
    expect(r.error.names).toEqual(['A']);
    expect(r.error.message).toContain('A');
  });

  it('a helper that never answers is killed and reported as `timeout`', async () => {
    const cmd = helperCommand(tmp.dir, 'sleep', `setTimeout(() => process.stdout.write('{}'), 60_000);`);
    const started = Date.now();
    const r = await execCredentialProvider(cmd, { ...quiet, timeoutMs: 500 }).load(['A']);
    expect(r.ok ? undefined : r.error.code).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  // Windows: libuv puts a Node process's children in a job object, so a Node grandchild dies with
  // its Node parent anyway. The real leak is a non-Node tree: `cmd.exe` running `ping`, which holds
  // stdout. Before the tree kill, `ping` outlived the timeout by its full duration.
  it.runIf(process.platform === 'win32')('Windows: a timeout kills the whole tree (cmd.exe -> ping holding stdout) and settles promptly', async () => {
    const before = new Set(pingPids());
    const started = Date.now();
    const load = execCredentialProvider('cmd.exe /d /c "ping -n 30 127.0.0.1"', { ...quiet, timeoutMs: 2_000 }).load(['A']);
    // While it runs, the helper's grandchild exists (so the check below is not vacuous).
    let ours: number[] = [];
    for (let i = 0; i < 30 && ours.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 100));
      ours = pingPids().filter((p) => !before.has(p));
    }
    expect(ours.length, 'ping never started').toBeGreaterThan(0);
    const r = await load;
    expect(r.ok ? undefined : r.error.code).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(6_000);
    for (const pid of ours) expect(await processGone(pid, 5_000), `ping ${pid} still running`).toBe(true);
  }, 30_000);

  it.skipIf(process.platform === 'win32')('POSIX: a timeout kills the whole process group: a grandchild holding stdout is gone and the call settles promptly', async () => {
    const pidFile = path.join(tmp.dir, 'grandchild-timeout.pid');
    const cmd = helperCommand(
      tmp.dir,
      'tree-hang',
      `import { spawn } from 'node:child_process';
       import fs from 'node:fs';
       const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'inherit' });
       fs.writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));
       setTimeout(() => {}, 30000);`,
    );
    const started = Date.now();
    const r = await execCredentialProvider(cmd, { ...quiet, timeoutMs: 1500 }).load(['A']);
    expect(r.ok ? undefined : r.error.code).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(5_000);
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    expect(await processGone(pid, 5_000), `grandchild ${pid} still running`).toBe(true);
  }, 20_000);

  it('a helper that answers and exits while a grandchild still holds stdout settles promptly', async () => {
    const pidFile = path.join(tmp.dir, 'grandchild-ok.pid');
    const cmd = helperCommand(
      tmp.dir,
      'tree-answer',
      `import { spawn } from 'node:child_process';
       import fs from 'node:fs';
       const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'inherit' });
       fs.writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));
       g.unref();
       process.stdin.resume();
       process.stdin.on('end', () => { process.stdout.write(JSON.stringify({ A: 'a-val' }), () => process.exit(0)); });`,
    );
    try {
      const started = Date.now();
      const r = await execCredentialProvider(cmd, { ...quiet, timeoutMs: 15_000 }).load(['A']);
      expect(r.ok ? r.set.get('A') : r.error.code).toBe('a-val');
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      const pid = Number(fs.readFileSync(pidFile, 'utf8'));
      try {
        process.kill(pid);
      } catch {
        /* already gone */
      }
    }
  }, 20_000);

  it('a program that does not exist is `unavailable`, naming the program only', async () => {
    const r = await execCredentialProvider('cu-no-such-helper-xyz --token abc123', quiet).load(['A']);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('unavailable');
    expect(r.error.providerId).toBe('exec:cu-no-such-helper-xyz');
    expect(r.error.message).not.toContain('abc123');
  });

  it('stdout over the cap kills the helper and is `malformed`', async () => {
    const cmd = helperCommand(tmp.dir, 'flood', `process.stdout.write('{"A":"' + 'x'.repeat(200000) + '"}');`);
    const r = await execCredentialProvider(cmd, { ...quiet, maxOutputBytes: 1000 }).load(['A']);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('malformed');
    expect(r.error.message).toContain('1000 bytes');
  });

  it('an unparseable command yields a provider whose load fails `unavailable`', async () => {
    const p = execCredentialProvider('"unterminated');
    const r = await p.load(['A']);
    expect(r.ok ? undefined : r.error.code).toBe('unavailable');
  });
});

/**
 * Test helpers: temp directories under the OS temp dir (never inside the repository) and a way to
 * turn a small Node script into an `exec:` command line with a quoted interpreter path.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/** A fresh temp directory, removed by the returned cleanup. */
export function tempDir(prefix = 'cu-cred-'): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** Writes `source` as a .mjs helper in `dir` and returns an exec command line running it with this
 *  Node binary, both paths double-quoted (exercises the quoting rules). */
export function helperCommand(dir: string, name: string, source: string): string {
  const file = path.join(dir, `${name}.mjs`);
  fs.writeFileSync(file, source, 'utf8');
  return `"${process.execPath}" "${file}"`;
}

/** True when a `git` binary runs. */
export function gitAvailable(): boolean {
  const r = spawnSync('git', ['--version'], { stdio: 'ignore', windowsHide: true });
  return r.error === undefined && r.status === 0;
}

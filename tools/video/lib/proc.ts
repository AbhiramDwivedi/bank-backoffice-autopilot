/**
 * Spawns real child processes (the `cu` CLI, vitest) and captures their stdout/stderr, so
 * term:* segments can show REAL captured output rather than fabricated text. Spawned directly
 * (node + the tsx/vitest entry file), not through npm or a shell.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { REPO_ROOT } from './script.js';

export interface ProcResult {
  /** The argv this was invoked with (node + entry + args), for display in the rendered command line. */
  argv: string[];
  stdout: string;
  stderr: string;
  /** stdout and stderr chunks in the order they arrived, concatenated (what a terminal would show). */
  combined: string;
  code: number;
}

function runNode(entry: string, args: readonly string[], opts: { env?: NodeJS.ProcessEnv } = {}): Promise<ProcResult> {
  return new Promise((resolve, reject) => {
    const argv = [entry, ...args];
    const child = spawn(process.execPath, argv, {
      cwd: REPO_ROOT,
      env: { ...process.env, ...opts.env },
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let combined = '';
    child.stdout.on('data', (d: Buffer) => {
      const s = d.toString('utf8');
      stdout += s;
      combined += s;
    });
    child.stderr.on('data', (d: Buffer) => {
      const s = d.toString('utf8');
      stderr += s;
      combined += s;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ argv: [process.execPath, ...argv], stdout, stderr, combined, code: code ?? -1 }));
  });
}

/** Runs `node node_modules/tsx/dist/cli.mjs apps/cu/src/index.ts <args>` from the repo root. */
export function runCli(args: readonly string[], opts: { env?: NodeJS.ProcessEnv } = {}): Promise<ProcResult> {
  const tsxCli = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const cliEntry = path.join(REPO_ROOT, 'apps', 'cu', 'src', 'index.ts');
  return runNode(tsxCli, [cliEntry, ...args], opts);
}

/** Runs `node node_modules/vitest/vitest.mjs <args>` from the repo root. */
export function runVitest(args: readonly string[]): Promise<ProcResult> {
  const vitestEntry = path.join(REPO_ROOT, 'node_modules', 'vitest', 'vitest.mjs');
  return runNode(vitestEntry, args);
}

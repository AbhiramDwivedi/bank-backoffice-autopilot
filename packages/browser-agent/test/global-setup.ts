/** Rebuilds dist/cu-agent.js once before any test file runs. */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export default function setup(): void {
  execFileSync(process.execPath, [fileURLToPath(new URL('../build.mjs', import.meta.url))], { stdio: 'inherit' });
}

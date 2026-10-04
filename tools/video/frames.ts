/**
 * Tiny wrapper around frames.ps1: `npx tsx tools/video/frames.ts -Mp4 <path> -OutDir <dir> -EveryS 10`
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const psScript = path.join(path.dirname(fileURLToPath(import.meta.url)), 'frames.ps1');
const res = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psScript, ...args], {
  stdio: 'inherit',
});
process.exit(res.status ?? 1);

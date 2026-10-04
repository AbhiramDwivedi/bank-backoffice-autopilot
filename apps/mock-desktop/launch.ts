/**
 * Test and CLI helpers for Teller Workstation: build the exe (teller.ps1 -BuildOnly), the command
 * that launches it the way tests do, and the fault control file.
 *
 * Tests launch the exe directly rather than through teller.ps1 so the launched process is the app
 * itself; the CLI path (`--app-command "powershell ... teller.ps1"`) exercises the
 * launcher-then-app process tree instead. Every launch made here sets MOCK_DESKTOP_QUIET (no
 * taskbar button) and MOCK_DESKTOP_WATCH_PID (the app exits when this process does).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The launcher script. */
export const TELLER_SCRIPT = path.join(HERE, 'teller.ps1');
/** The bundled member data. */
export const TELLER_DATA = path.join(HERE, 'data', 'members.json');
/** The process name Teller Workstation runs as: the host of its desktop:// locations. */
export const TELLER_PROCESS = 'tellerworkstation';
/** Demo credentials, the same as the web mock app's. */
export const TELLER_USER = 'operator1';
export const TELLER_PASSWORD = 'demo-pass-123';

let built: string | undefined;

/**
 * Compiles TellerWorkstation.exe if this source version has not been built yet; returns its path.
 * Windows only. `cacheRoot` (an explicit option, never an environment variable) overrides the
 * per-user build cache.
 */
export function buildTeller(opts: { cacheRoot?: string } = {}): string {
  if (opts.cacheRoot === undefined && built && fs.existsSync(built)) return built;
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', TELLER_SCRIPT, '-BuildOnly'];
  if (opts.cacheRoot !== undefined) args.push('-CacheRoot', opts.cacheRoot);
  const out = execFileSync('powershell.exe', args, { encoding: 'utf8', windowsHide: true, timeout: 180_000 });
  const exe = out.trim().split(/\r?\n/).pop()!.trim();
  if (!fs.existsSync(exe)) throw new Error(`teller.ps1 -BuildOnly did not produce an exe (got ${JSON.stringify(out)})`);
  if (opts.cacheRoot === undefined) built = exe;
  return exe;
}

/** Fault switches, as the app reads them from MOCK_DESKTOP_FAULTS or the control file. */
export interface TellerFaults {
  failLookup?: boolean;
  /** One-shot per control-file write: the next action lands on sign-on with the expiry banner. */
  expireSession?: boolean;
  slowMs?: number;
}

/** A fault control file for one app instance. */
export interface FaultFile {
  path: string;
  set(faults: TellerFaults): void;
  clear(): void;
}

/** Creates an empty fault control file in a fresh temp directory. */
export function createFaultFile(): FaultFile {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teller-faults-'));
  const file = path.join(dir, 'faults.json');
  fs.writeFileSync(file, '{}');
  return {
    path: file,
    set(faults) {
      // Write to a sibling and rename, so the app never reads a half-written file.
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(faults));
      fs.renameSync(tmp, file);
    },
    clear() {
      this.set({});
    },
  };
}

/** The variables Teller Workstation reads: the desktop surface passes a launched app only what is allowed. */
export const TELLER_ENV: readonly string[] = [
  'MOCK_USER',
  'MOCK_PASSWORD',
  'MOCK_DESKTOP_DATA',
  'MOCK_DESKTOP_FAULTS',
  'MOCK_DESKTOP_FAULT_FILE',
  'MOCK_DESKTOP_WATCH_PID',
  'MOCK_DESKTOP_QUIET',
];

/**
 * How tests launch the app: the exe, its data file, and the quiet, self-terminating environment,
 * with the app's own variables allowed through the surface's environment allowlist.
 */
export function tellerLaunch(opts: { faultFile?: FaultFile; env?: NodeJS.ProcessEnv } = {}): {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  allowEnv: string[];
} {
  return {
    command: buildTeller(),
    args: [TELLER_DATA],
    allowEnv: [...TELLER_ENV],
    env: {
      ...process.env,
      MOCK_USER: TELLER_USER,
      MOCK_PASSWORD: TELLER_PASSWORD,
      MOCK_DESKTOP_QUIET: '1',
      MOCK_DESKTOP_WATCH_PID: String(process.pid),
      ...(opts.faultFile ? { MOCK_DESKTOP_FAULT_FILE: opts.faultFile.path } : {}),
      ...opts.env,
    },
  };
}

/**
 * Starting and stopping the target application.
 *
 * The surface launches the app itself (so it owns the process tree it may touch) or attaches to a
 * process id it is given; it never "finds" an app by window title, which on a shared desktop
 * could be anyone's window. A launched app is ended with its whole process tree on close (and, via
 * the bridge's job object, when the runtime dies); an attached one is left running.
 *
 * Two hazards shape this file:
 *  - PID reuse. Once a launched process has exited and been reaped, its pid can name a stranger.
 *    Every kill is therefore gated on the launched `ChildProcess` handle still being alive (Node
 *    holds the process handle until it has seen the exit, so the pid cannot be reused before
 *    then), never on "some process with that pid exists".
 *  - The runtime's environment. A third-party app must not inherit the model API key, the run's
 *    credentials or anything else secret, so it gets an allowlisted environment (see
 *    {@link appEnvironment}).
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';

/** How to start the target app. */
export interface AppLaunch {
  command: string;
  args: readonly string[];
  cwd?: string;
  /** The environment to start from (default `process.env`); scrubbed either way. */
  env?: NodeJS.ProcessEnv;
  /** Variable names withheld from the app even if allowed (the run's credential names, say). */
  dropEnv?: readonly string[];
  /** Variables the app needs beyond the minimal Windows base (see `appEnvironment`). */
  allowEnv?: readonly string[];
}

/**
 * Splits a Windows command line into a program and its arguments: whitespace separates,
 * double quotes group (`""` inside quotes is a literal quote), backslashes are literal. Enough for
 * `"C:\Program Files\App\app.exe" --flag "a b"`; no shell expansion of any kind.
 */
export function parseCommandLine(line: string): AppLaunch {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  let started = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else inQuotes = !inQuotes;
      started = true;
    } else if (!inQuotes && /\s/.test(ch)) {
      if (started) out.push(cur);
      cur = '';
      started = false;
    } else {
      cur += ch;
      started = true;
    }
  }
  if (inQuotes) throw new Error(`unterminated quote in command line: ${line}`);
  if (started) out.push(cur);
  if (out.length === 0) throw new Error('empty command line');
  return { command: out[0]!, args: out.slice(1) };
}

/** Prefixes the runtime's own configuration lives under; never passed to the app, even if allowed. */
const RUNTIME_PREFIXES = ['ANTHROPIC_', 'TYPESAFE_', 'CU_'];

/**
 * The minimal environment a Windows GUI program (and `powershell.exe`, for a script launcher)
 * needs: the system locations, the user's profile folders, the path to find programs, and the
 * processor description. Verified by running Teller Workstation both directly and through
 * `teller.ps1` with exactly this environment. Matched case-insensitively.
 */
const BASE_NAMES: ReadonlySet<string> = new Set(
  [
    'SystemRoot', 'windir', 'SystemDrive', 'ComSpec', 'PATH', 'PATHEXT', 'TEMP', 'TMP',
    'USERPROFILE', 'USERNAME', 'USERDOMAIN', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
    'ProgramData', 'PUBLIC', 'ALLUSERSPROFILE', 'COMPUTERNAME', 'OS', 'NUMBER_OF_PROCESSORS', 'PSModulePath',
    // libuv adds this one to every child's environment on Windows whatever it is given.
    'LOGONSERVER',
  ].map((n) => n.toUpperCase()),
);
/** Name families in the base: `ProgramFiles`, `ProgramFiles(x86)`, `ProgramW6432`, `CommonProgramFiles*`, `PROCESSOR_*`. */
const BASE_PREFIXES = ['PROGRAMFILES', 'PROGRAMW6432', 'COMMONPROGRAMFILES', 'COMMONPROGRAMW6432', 'PROCESSOR_'];

function inBase(upper: string): boolean {
  return BASE_NAMES.has(upper) || BASE_PREFIXES.some((p) => upper.startsWith(p));
}

/**
 * The environment a launched app gets: an allowlist, not a denylist. Only the minimal base (see
 * `BASE_NAMES`) and the names in `allow` are passed; then the names in `drop` and the runtime's own
 * prefixes (`ANTHROPIC_*`, `TYPESAFE_*`, `CU_*`) are removed, and those win over `allow`. A variable
 * not named anywhere (an API key, a database URL with a password, a session token, by whatever name)
 * never reaches the app. Names are compared case-insensitively, as Windows does.
 */
export function appEnvironment(base: NodeJS.ProcessEnv, opts: { drop?: readonly string[]; allow?: readonly string[] } = {}): NodeJS.ProcessEnv {
  const drop = new Set((opts.drop ?? []).map((n) => n.toUpperCase()));
  const allow = new Set((opts.allow ?? []).map((n) => n.toUpperCase()));
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) continue;
    const upper = name.toUpperCase();
    if (RUNTIME_PREFIXES.some((p) => upper.startsWith(p))) continue;
    if (drop.has(upper)) continue;
    if (!inBase(upper) && !allow.has(upper)) continue;
    out[name] = value;
  }
  return out;
}

/** A launched app process. */
export interface LaunchedApp {
  pid: number;
  child: ChildProcess;
  /** Epoch ms taken just before the spawn: the bridge refuses to own a process started earlier. */
  launchedAt: number;
  /** Resolves when the root process exits. */
  exited: Promise<number | null>;
}

/**
 * Starts the app with a scrubbed environment. stdio is ignored and the process is not detached,
 * so it never outlives this process by accident (the bridge's job object is the stronger
 * guarantee). A console-subsystem launcher (a .cmd or .ps1 wrapper) runs with its console hidden;
 * a GUI app's windows are its own.
 */
export async function launchApp(launch: AppLaunch): Promise<LaunchedApp> {
  const launchedAt = Date.now();
  const child = spawn(launch.command, [...launch.args], {
    stdio: 'ignore',
    windowsHide: true,
    env: appEnvironment(launch.env ?? process.env, {
      ...(launch.dropEnv !== undefined ? { drop: launch.dropEnv } : {}),
      ...(launch.allowEnv !== undefined ? { allow: launch.allowEnv } : {}),
    }),
    ...(launch.cwd !== undefined ? { cwd: launch.cwd } : {}),
  });
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', () => resolve());
    child.once('error', (err) => reject(new Error(`could not start ${launch.command}: ${err.message}`, { cause: err })));
  });
  if (child.pid === undefined) throw new Error(`could not start ${launch.command}`);
  return { pid: child.pid, child, launchedAt, exited };
}

/** True while the launched process has not exited (by its own handle, never by pid lookup). */
export function launchedAlive(app: Pick<LaunchedApp, 'child'>): boolean {
  return app.child.exitCode === null && app.child.signalCode === null;
}

/**
 * Ends a launched app and all of its descendants (Windows `taskkill /T /F`), but only while its
 * own process handle says it is still running: a pid whose process has exited may already name
 * someone else's process. Never throws.
 */
export function killLaunched(app: Pick<LaunchedApp, 'child' | 'pid'>, kill: (pid: number) => void = killProcessTree): boolean {
  if (!launchedAlive(app)) return false;
  kill(app.pid);
  return true;
}

/**
 * `taskkill /PID <pid> /T /F`. Callers must know the pid is theirs (see {@link killLaunched});
 * not exported from the package for that reason.
 */
function killProcessTree(pid: number): void {
  try {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 10_000 });
  } catch {
    /* already gone */
  }
}

/** True while a process with this id exists. For assertions only: never decide a kill with it. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * `exec:<command>` credential provider: the credential-helper pattern (as in `git credential` or
 * `docker-credential-*`). One seam covers 1Password CLI, HashiCorp Vault, cloud secret CLIs and
 * SSO token helpers through a small wrapper script, with no vendor SDK in this repository.
 *
 * Protocol:
 * - The command is split into argv by {@link parseCommandLine} and spawned WITHOUT a shell.
 * - stdin receives one line: `{"names":["NAME_A","NAME_B"]}`, then is closed.
 * - stdout must be one JSON object `{"NAME_A": "value", ...}`. Requested names must map to strings;
 *   extra keys are ignored and never kept. A missing name is reported as `missing` by core's
 *   `loadCredentials`.
 * - Exit 0 is success. Non-zero exit is `failed`; no answer within the timeout (default 10 s) kills
 *   the helper and is `timeout`; stdout over the cap (default 1 MiB) kills it and is `malformed`.
 * - "Kills" means the whole process tree (`taskkill /T /F` on Windows; on POSIX the helper leads
 *   its own process group, which gets SIGTERM then SIGKILL), and on every outcome the helper's
 *   stdio is destroyed and the child unref'd, so a grandchild still holding stdout can neither
 *   delay the result nor keep this process alive.
 * - stderr is inherited by default, so a helper's diagnostics ("not signed in") reach the
 *   terminal directly. It is never captured, so it can never end up in a failure message,
 *   evidence or a log this runtime writes.
 *
 * No failure message ever includes stdout, a parse error's text (V8 quotes the input) or an
 * argument: arguments may carry tokens, so the provider id is `exec:<program>` only.
 *
 * Quoting rules ({@link parseCommandLine}), deliberately small and shell-free:
 * - unquoted whitespace separates arguments;
 * - "double quotes" group, and inside them `\"` is a literal quote and `\\` a literal backslash
 *   (any other backslash is kept as is);
 * - 'single quotes' group literally, with no escapes;
 * - outside quotes a backslash is literal, so `C:\tools\helper.exe` works unquoted;
 * - no variable expansion, globbing, pipes or redirection: write a wrapper script for those.
 *
 * Windows: Node refuses to spawn `.cmd`/`.bat` files without a shell (since the 2024 command
 * injection fix), so point the spec at an `.exe`, or run a script through its interpreter:
 * `exec:node helper.mjs`, `exec:powershell -NoProfile -File helper.ps1`.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { credentialFailure, credentialSet, type CredentialLoadResult, type CredentialProvider } from '@cu/core/credentials';

/** Options for {@link execCredentialProvider}. */
export interface ExecCredentialProviderOptions {
  /** Kill the helper and fail with `timeout` after this long. Default 10000. */
  timeoutMs?: number;
  /** Kill the helper and fail with `malformed` once stdout exceeds this. Default 1 MiB. */
  maxOutputBytes?: number;
  /** Where the helper's stderr goes. Default `inherit` (the terminal); it is never captured. */
  stderr?: 'inherit' | 'ignore';
  /** Working directory for the helper. Default the current one. */
  cwd?: string;
  /** Environment for the helper. Default the current one. */
  env?: NodeJS.ProcessEnv;
}

/** Result of {@link parseCommandLine}. */
export type ParseCommandLineResult = { ok: true; argv: string[] } | { ok: false; message: string };

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

/** Splits `command` into argv using the quoting rules in this module's header. Pure. */
export function parseCommandLine(command: string): ParseCommandLineResult {
  const argv: string[] = [];
  let current = '';
  let inArg = false;
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote === "'") {
      if (c === "'") quote = undefined;
      else current += c;
      continue;
    }
    if (quote === '"') {
      if (c === '"') {
        quote = undefined;
      } else if (c === '\\' && (command[i + 1] === '"' || command[i + 1] === '\\')) {
        current += command[i + 1];
        i++;
      } else {
        current += c;
      }
      continue;
    }
    if (/\s/.test(c)) {
      if (inArg) {
        argv.push(current);
        current = '';
        inArg = false;
      }
      continue;
    }
    inArg = true;
    if (c === '"' || c === "'") quote = c;
    else current += c;
  }
  if (quote !== undefined) return { ok: false, message: `unterminated ${quote === '"' ? 'double' : 'single'} quote in the credential helper command` };
  if (inArg) argv.push(current);
  if (argv.length === 0 || argv[0] === '') return { ok: false, message: 'the credential helper command is empty' };
  return { ok: true, argv };
}

/**
 * A provider that runs `command` as a credential helper (see this module's header for the
 * protocol). The command is parsed once, here; an unparseable command still yields a provider,
 * whose `load` fails with `unavailable`.
 */
export function execCredentialProvider(command: string, opts: ExecCredentialProviderOptions = {}): CredentialProvider {
  const parsed = parseCommandLine(command);
  const program = parsed.ok ? parsed.argv[0]! : '(invalid command)';
  const id = `exec:${program}`;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  return {
    id,
    load(names): Promise<CredentialLoadResult> {
      if (!parsed.ok) return Promise.resolve(credentialFailure('unavailable', id, names, parsed.message));
      return runHelper(parsed.argv, names, { id, program, timeoutMs, maxOutputBytes, opts });
    },
  };
}

interface RunContext {
  id: string;
  program: string;
  timeoutMs: number;
  maxOutputBytes: number;
  opts: ExecCredentialProviderOptions;
}

const IS_WINDOWS = process.platform === 'win32';
/** POSIX: how long after SIGTERM to the process group before escalating to SIGKILL. */
const SIGKILL_GRACE_MS = 500;
/** After the helper exits, how long to wait for stdout to drain before settling without `close`. */
const EXIT_DRAIN_MS = 250;

/**
 * Terminates the helper and every process it started. Killing only the direct child is not enough:
 * a grandchild that inherited stdout keeps it open (and this process's event loop alive) long after
 * the helper itself is gone.
 * - Windows: `taskkill /T /F /PID <pid>` (the whole tree), spawned without a shell and not awaited.
 * - POSIX: the helper was spawned `detached`, so it leads its own process group; SIGTERM the group,
 *   then SIGKILL it after a short grace period. Falls back to killing the child alone.
 */
function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (IS_WINDOWS) {
    try {
      const killer = spawn('taskkill', ['/T', '/F', '/PID', String(pid)], { shell: false, windowsHide: true, stdio: 'ignore' });
      killer.on('error', () => child.kill());
      killer.unref();
    } catch {
      child.kill();
    }
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
  const escalate = setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* group already gone */
    }
  }, SIGKILL_GRACE_MS);
  escalate.unref();
}

/** Lets go of the helper so nothing it (or a grandchild) still holds can keep the event loop alive. */
function release(child: ChildProcess): void {
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.unref();
}

function runHelper(argv: string[], names: readonly string[], ctx: RunContext): Promise<CredentialLoadResult> {
  return new Promise((resolve) => {
    let settled = false;
    let child: ChildProcess | undefined;
    const finish = (r: CredentialLoadResult, kill = false): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child !== undefined) {
        if (kill) killTree(child);
        release(child);
      }
      resolve(r);
    };

    try {
      child = spawn(argv[0]!, argv.slice(1), {
        shell: false,
        windowsHide: true,
        // POSIX: its own process group, so a timeout can kill the helper's whole tree.
        detached: !IS_WINDOWS,
        stdio: ['pipe', 'pipe', ctx.opts.stderr ?? 'inherit'],
        ...(ctx.opts.cwd !== undefined ? { cwd: ctx.opts.cwd } : {}),
        ...(ctx.opts.env !== undefined ? { env: ctx.opts.env } : {}),
      });
    } catch (err) {
      // Synchronous spawn failures (e.g. EINVAL for a .cmd on Windows): name the program and code only.
      const code = (err as NodeJS.ErrnoException).code ?? 'error';
      resolve(credentialFailure('unavailable', ctx.id, names, `cannot start the credential helper ${ctx.program} (${code})`));
      return;
    }

    const timer = setTimeout(() => {
      finish(credentialFailure('timeout', ctx.id, names, `the credential helper did not answer within ${ctx.timeoutMs} ms`), true);
    }, ctx.timeoutMs);

    const proc = child;
    const chunks: Buffer[] = [];
    let size = 0;
    proc.stdout!.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > ctx.maxOutputBytes) {
        finish(credentialFailure('malformed', ctx.id, names, `the credential helper wrote more than ${ctx.maxOutputBytes} bytes to stdout`), true);
        return;
      }
      chunks.push(chunk);
    });

    proc.on('error', (err: NodeJS.ErrnoException) => {
      const code = err.code ?? 'error';
      finish(credentialFailure('unavailable', ctx.id, names, `cannot start the credential helper ${ctx.program} (${code})`));
    });

    const done = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      if (code !== 0) {
        const how = code === null ? `was killed (${signal ?? 'signal'})` : `exited with code ${code}`;
        // A helper that failed may have left children behind: take them down too.
        finish(credentialFailure('failed', ctx.id, names, `the credential helper ${how}`), true);
        return;
      }
      finish(parseOutput(Buffer.concat(chunks).toString('utf8'), names, ctx.id));
    };
    // `close` fires once stdout is drained, which is the normal path. A grandchild that inherited
    // stdout can hold it open after the helper itself has exited, so `exit` also settles, after a
    // short drain window for output still in flight.
    proc.on('close', done);
    proc.on('exit', (code, signal) => {
      setTimeout(() => done(code, signal), EXIT_DRAIN_MS);
    });

    // A helper that exits without reading stdin makes this write fail with EPIPE; the exit code
    // decides the result, so the stream error is swallowed.
    proc.stdin!.on('error', () => undefined);
    proc.stdin!.end(`${JSON.stringify({ names })}\n`);
  });
}

/** Parses the helper's stdout. Never echoes it: parse errors get a fixed message, bad values are
 *  named by key, unrequested keys are dropped unread. */
function parseOutput(stdout: string, names: readonly string[], id: string): CredentialLoadResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return credentialFailure('malformed', id, names, 'the credential helper did not write a JSON object to stdout');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return credentialFailure('malformed', id, names, 'the credential helper did not write a JSON object to stdout');
  }
  const obj = parsed as Record<string, unknown>;
  const entries: Record<string, string> = {};
  const bad: string[] = [];
  for (const n of names) {
    if (!Object.prototype.hasOwnProperty.call(obj, n)) continue;
    const v = obj[n];
    if (typeof v === 'string') entries[n] = v;
    else bad.push(n);
  }
  if (bad.length > 0) return credentialFailure('malformed', id, bad, `the credential helper returned a non-string value for: ${bad.join(', ')}`);
  return { ok: true, set: credentialSet(entries) };
}

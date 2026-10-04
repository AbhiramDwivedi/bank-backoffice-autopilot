/**
 * The Node side of the UIA bridge: a typed JSON-lines RPC client over a pair of streams, and the
 * helper that starts the real bridge process (`powershell.exe ... bridge/uia-bridge.ps1`).
 *
 * The client is transport-agnostic on purpose: `fake-bridge.ts` answers the same protocol
 * in-process over a pair of PassThrough streams, so everything above this file is tested on any
 * OS. Every call has a timeout (a hung app must not hang the runtime); a late answer to a call
 * that already timed out is dropped. A bridge that exits or closes its stdout fails every pending
 * call with `closed`.
 *
 * Orphans: `BridgeProcess.close()` asks the bridge to shut down, closes its stdin (the bridge also
 * exits on EOF), and kills it if it is still alive after a grace period. The bridge holds the
 * launched app in a kill-on-close job object (see UiaBridge.cs `TieToBridge`), so ending the
 * bridge ends the app too, even when this process dies without calling close().
 */
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { WireErrorCode, WireEvent, WireRequest, WireResults } from './protocol.js';

/** Why a bridge call failed: the bridge's own error code, or `timeout` / `closed`. */
export class BridgeCallError extends Error {
  constructor(
    readonly code: WireErrorCode | 'timeout' | 'closed',
    message: string,
  ) {
    super(message);
    this.name = 'BridgeCallError';
  }
}

/** Options for {@link BridgeClient}. */
export interface BridgeClientOptions {
  /** Per-call timeout when the call does not pass its own. Default 20000. */
  defaultTimeoutMs?: number;
  /** Diagnostic sink (unparseable lines, late answers). Never receives values. */
  log?: (msg: string) => void;
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

/** Typed request/response client over the bridge's stdout (`input`) and stdin (`output`). */
export class BridgeClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(e: WireEvent) => void>();
  private readonly readyPromise: Promise<WireResults['hello']>;
  private resolveReady!: (v: WireResults['hello']) => void;
  private rejectReady!: (e: Error) => void;
  private closedFlag = false;
  private readonly defaultTimeoutMs: number;
  private readonly log: (msg: string) => void;

  constructor(
    input: Readable,
    private readonly output: Writable,
    opts: BridgeClientOptions = {},
  ) {
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 20_000;
    this.log = opts.log ?? (() => undefined);
    this.readyPromise = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.readyPromise.catch(() => undefined);
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    lines.on('line', (line) => this.onLine(line));
    lines.on('close', () => this.fail('the bridge closed its output'));
    output.on('error', (err: Error) => this.fail(`writing to the bridge failed: ${err.message}`));
  }

  /** True once the bridge went away or close() was called. */
  get closed(): boolean {
    return this.closedFlag;
  }

  /** Resolves with the bridge's hello once it reports ready. */
  ready(): Promise<WireResults['hello']> {
    return this.readyPromise;
  }

  /** Subscribes to pushed events (human-action facts, fatal errors). Returns the unsubscribe. */
  onEvent(listener: (e: WireEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Sends one request and resolves with its typed result, or rejects with {@link BridgeCallError}. */
  call<R extends WireRequest>(request: R, timeoutMs = this.defaultTimeoutMs): Promise<WireResults[R['op']]> {
    if (this.closedFlag) return Promise.reject(new BridgeCallError('closed', 'the bridge is closed'));
    const id = this.nextId++;
    return new Promise<WireResults[R['op']]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeCallError('timeout', `bridge ${request.op} did not answer within ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        this.output.write(`${JSON.stringify({ id, ...request })}\n`);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new BridgeCallError('closed', `writing to the bridge failed: ${err instanceof Error ? err.message : String(err)}`));
      }
    });
  }

  /** Asks the bridge to shut down and fails anything still pending. Idempotent. */
  async close(): Promise<void> {
    if (this.closedFlag) return;
    try {
      await this.call({ op: 'shutdown' }, 1500);
    } catch {
      /* already gone, or too slow: the caller kills the process */
    }
    try {
      this.output.end();
    } catch {
      /* ignore */
    }
    this.fail('the bridge was closed');
  }

  private fail(reason: string): void {
    if (this.closedFlag) return;
    this.closedFlag = true;
    this.rejectReady(new BridgeCallError('closed', reason));
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new BridgeCallError('closed', reason));
      this.pending.delete(id);
    }
  }

  private onLine(line: string): void {
    if (line.trim() === '') return;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      this.log(`bridge: ignoring a line that is not JSON (${line.length} chars)`);
      return;
    }
    if (typeof msg !== 'object' || msg === null) return;
    const m = msg as Record<string, unknown>;
    if (typeof m.event === 'string') {
      const event = m as unknown as WireEvent;
      if (event.event === 'ready') this.resolveReady(event.data);
      if (event.event === 'fatal') this.fail(`the bridge failed: ${String(event.data)}`);
      for (const l of [...this.listeners]) {
        try {
          l(event);
        } catch {
          /* a listener's failure must not break the channel */
        }
      }
      return;
    }
    if (typeof m.id !== 'number') return;
    const p = this.pending.get(m.id);
    if (!p) {
      this.log(`bridge: late answer to request ${m.id} dropped`);
      return;
    }
    this.pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.ok === true) p.resolve(m.result);
    else {
      const e = (m.error ?? {}) as { code?: string; message?: string };
      p.reject(new BridgeCallError((e.code as WireErrorCode | undefined) ?? 'failed', e.message ?? 'bridge error'));
    }
  }
}

/** Absolute path of bridge/uia-bridge.ps1. */
export const UIA_BRIDGE_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bridge', 'uia-bridge.ps1');

/** Minimal child-process surface {@link BridgeProcess} needs; injectable for tests. */
export interface BridgeChild {
  readonly pid?: number | undefined;
  readonly stdin: Writable | null;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
}

/** Options for {@link startUiaBridge}. */
export interface StartBridgeOptions {
  /** Default `powershell.exe` (Windows PowerShell 5.1, which ships with Windows). */
  powershell?: string;
  /** Default {@link UIA_BRIDGE_SCRIPT}. */
  script?: string;
  /** How long to wait for the bridge's ready event. Default 60000 (the first run compiles). */
  startTimeoutMs?: number;
  /** Injected spawn, for tests. */
  spawnChild?: (command: string, args: string[]) => BridgeChild;
  /**
   * Interop cache root (default `%LOCALAPPDATA%\cu-uia-bridge`). Only this explicit option moves it:
   * the bridge ignores the environment, which a `.env` file in the working directory can set.
   */
  cacheRoot?: string;
  log?: (msg: string) => void;
}

/** A running bridge process and its client. */
export class BridgeProcess {
  private stderrTail = '';
  private exited: Promise<void>;

  constructor(
    readonly child: BridgeChild,
    readonly client: BridgeClient,
  ) {
    child.stderr?.on('data', (d: Buffer) => {
      this.stderrTail = (this.stderrTail + d.toString()).slice(-4000);
    });
    this.exited = new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once('exit', () => resolve());
    });
  }

  /** The last few kilobytes the bridge wrote to stderr (compile errors, PowerShell failures). */
  get stderr(): string {
    return this.stderrTail;
  }

  /** True once the bridge process has exited. */
  get hasExited(): boolean {
    return this.child.exitCode !== null || this.child.signalCode !== null;
  }

  /** Shuts the bridge down and makes sure the process is gone. Idempotent. */
  async close(graceMs = 3000): Promise<void> {
    await this.client.close();
    if (this.hasExited) return;
    const graceful = await Promise.race([this.exited.then(() => true), sleep(graceMs).then(() => false)]);
    if (!graceful) {
      this.child.kill();
      await Promise.race([this.exited, sleep(2000)]);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => {
    const t = setTimeout(r, ms);
    t.unref?.();
  });
}

/**
 * Starts the real bridge and waits for it to report ready. Windows only: the bridge is Windows
 * PowerShell hosting .NET Framework and the native UI Automation COM API.
 */
export async function startUiaBridge(opts: StartBridgeOptions = {}): Promise<BridgeProcess> {
  const log = opts.log ?? (() => undefined);
  const command = opts.powershell ?? 'powershell.exe';
  const args = ['-NoProfile', '-NonInteractive', '-MTA', '-ExecutionPolicy', 'Bypass', '-File', opts.script ?? UIA_BRIDGE_SCRIPT];
  if (opts.cacheRoot !== undefined) args.push('-CacheRoot', opts.cacheRoot);
  const child: BridgeChild =
    opts.spawnChild?.(command, args) ??
    (spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }) as ChildProcess as BridgeChild);
  if (!child.stdout || !child.stdin) throw new Error('bridge: the child process has no stdio pipes');
  const client = new BridgeClient(child.stdout, child.stdin, { log });
  const bridge = new BridgeProcess(child, client);
  const timeoutMs = opts.startTimeoutMs ?? 60_000;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      client.ready(),
      new Promise((_r, reject) => {
        timer = setTimeout(() => reject(new BridgeCallError('timeout', `the UIA bridge did not start within ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } catch (err) {
    await bridge.close(500).catch(() => undefined);
    const detail = bridge.stderr.trim();
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`could not start the UIA bridge: ${message}${detail ? `\n${detail}` : ''}`, { cause: err });
  } finally {
    if (timer) clearTimeout(timer);
  }
  return bridge;
}

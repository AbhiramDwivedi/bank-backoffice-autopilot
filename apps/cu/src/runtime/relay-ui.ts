/**
 * Builds and mounts the Relay console (`@cu/relay`) for the CLI: `ensureRelayBuilt` builds the
 * Relay UI bundle on demand (esbuild loads lazily, only when a build is actually needed), and
 * `startRelayConsole` wraps `startRelayServer` with that on-demand build.
 *
 * Relay's UI is a static bundle (`apps/relay/dist`), not source the CLI ships pre-built: the first
 * console started in a fresh checkout builds it once, and every later start reuses it unless
 * `apps/relay/src/ui` or `apps/relay/src/shared` changed more recently than the last build.
 */
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { SessionBroker } from '@cu/core/session';
import { startRelayServer, type RelayServerHandle, type StartRelayServerOptions } from '@cu/relay';

export type { RelayServerHandle } from '@cu/relay';

/** Options for {@link ensureRelayBuilt}. */
export interface EnsureRelayBuiltOptions {
  /** Default: `<relay root>/dist` (the same directory `startRelayServer` serves by default). */
  outdir?: string;
  /** One line, only when a build actually runs. Default: swallowed. */
  log?: (line: string) => void;
}

/** Result of {@link ensureRelayBuilt}. */
export interface EnsureRelayBuiltResult {
  outdir: string;
  /** True only when this call actually (re)built the UI; false when it was already fresh. */
  built: boolean;
}

interface RelayBuildModule {
  buildUi(opts: { outdir?: string; minify?: boolean }): Promise<{ outdir: string; stop(): Promise<void> }>;
}

const noop = (_line: string): void => {
  /* swallowed by default */
};

let cachedRelayRoot: string | undefined;

/** Resolves `@cu/relay/build` (apps/relay/scripts/build.ts) to locate Relay's root directory
 *  (that file's directory's parent), without ever importing it (require.resolve only locates). */
function relayRoot(): string {
  if (cachedRelayRoot !== undefined) return cachedRelayRoot;
  const buildEntry = createRequire(import.meta.url).resolve('@cu/relay/build');
  cachedRelayRoot = path.dirname(path.dirname(buildEntry));
  return cachedRelayRoot;
}

function defaultOutdir(): string {
  return path.join(relayRoot(), 'dist');
}

/** Newest mtime (ms) of any file recursively under `dir`, or `-Infinity` if `dir` does not exist. */
async function newestMtimeUnder(dir: string): Promise<number> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return -Infinity;
  }
  let newest = -Infinity;
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = await newestMtimeUnder(full);
      if (sub > newest) newest = sub;
    } else if (entry.isFile()) {
      const stat = await fs.stat(full);
      if (stat.mtimeMs > newest) newest = stat.mtimeMs;
    }
  }
  return newest;
}

/** True when `outdir` is missing its built output, or is older than the UI/shared source it was
 *  built from. Staleness is judged by `assets/app.js`'s mtime, not `index.html`'s: esbuild writes
 *  `assets/app.js` fresh on every build, so its mtime is always the real build time, whereas
 *  `index.html` is `fs.copyFile`d from `src/ui/index.html` and Windows' `CopyFile` preserves the
 *  *source* file's mtime on the copy -- comparing against that would compare the source
 *  `index.html`'s own last-edit time to its sibling sources, which is unrelated to when this
 *  outdir was last built and would make the check spuriously "stale" whenever some other UI file
 *  was edited more recently than `index.html` itself (index.html's existence is still required). */
async function needsBuild(outdir: string): Promise<boolean> {
  try {
    await fs.stat(path.join(outdir, 'index.html'));
  } catch {
    return true;
  }
  let appJsStat: { mtimeMs: number };
  try {
    appJsStat = await fs.stat(path.join(outdir, 'assets', 'app.js'));
  } catch {
    return true;
  }
  const root = relayRoot();
  const sourceNewest = Math.max(await newestMtimeUnder(path.join(root, 'src', 'ui')), await newestMtimeUnder(path.join(root, 'src', 'shared')));
  return sourceNewest > appJsStat.mtimeMs;
}

/** Dedupes truly-concurrent callers for the same outdir onto one build; cleared once that build
 *  settles so a later call always re-checks freshness rather than trusting a stale cache. */
const inFlight = new Map<string, Promise<EnsureRelayBuiltResult>>();

/**
 * Builds Relay's UI into `opts.outdir` (default `<relay root>/dist`) if it is missing or stale,
 * otherwise does nothing. Concurrent callers for the same outdir share one build. Safe to call on
 * every console start: the common case (already built and fresh) costs one `stat` per file.
 */
export async function ensureRelayBuilt(opts: EnsureRelayBuiltOptions = {}): Promise<EnsureRelayBuiltResult> {
  const outdir = opts.outdir !== undefined ? path.resolve(opts.outdir) : defaultOutdir();
  const log = opts.log ?? noop;

  const existing = inFlight.get(outdir);
  if (existing) return existing;

  const task = (async (): Promise<EnsureRelayBuiltResult> => {
    if (!(await needsBuild(outdir))) return { outdir, built: false };
    const mod = (await import('@cu/relay/build')) as RelayBuildModule;
    const result = await mod.buildUi({ outdir, minify: true });
    await result.stop();
    log(`relay: built UI into ${outdir}`);
    return { outdir, built: true };
  })();

  inFlight.set(outdir, task);
  try {
    return await task;
  } finally {
    if (inFlight.get(outdir) === task) inFlight.delete(outdir);
  }
}

/** Options for {@link startRelayConsole}. */
export interface StartRelayConsoleOptions {
  /** 0 = OS-assigned ephemeral port. */
  port: number;
  brokers?: SessionBroker[];
  /** Passed to the broker adapter so the lease countdown matches the core's. */
  leaseMs?: number;
  /** One-line progress/warning messages. Default: swallowed. */
  log?: (line: string) => void;
  /** Serve a pre-built UI from here instead of building one; skips `ensureRelayBuilt` entirely. */
  staticDir?: string;
  /**
   * Operator authentication middleware for the console, run before every route (page, assets,
   * API, SSE stream). No CLI flag sets it: an embedding deployment passes it here. Omitted: the
   * console has no operator authentication (loopback-only, see docs/design/relay.md).
   */
  authenticate?: StartRelayServerOptions['authenticate'];
}

/**
 * Builds the Relay UI on demand (unless `staticDir` is given) and starts the console. A build
 * failure is logged as a warning and swallowed -- the console's HTTP API still works without a
 * built UI, `GET /` just answers 503 until `npm run build:relay` is run. A busy port
 * (`EADDRINUSE`) is never swallowed: it propagates so each caller picks its own fallback before a
 * browser is launched (run-replay, for one, moves to an OS-assigned port). A broker registered
 * later should bring its run's redactor (`register(broker, { redact })`), as compose() does.
 */
export async function startRelayConsole(opts: StartRelayConsoleOptions): Promise<RelayServerHandle> {
  const log = opts.log ?? noop;
  let staticDir = opts.staticDir;
  if (staticDir === undefined) {
    try {
      staticDir = (await ensureRelayBuilt({ log })).outdir;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`warning: could not build the Relay UI (${message}); the console API still works, run \`npm run build:relay\``);
    }
  }
  return startRelayServer({
    port: opts.port,
    host: '127.0.0.1',
    ...(opts.brokers !== undefined ? { brokers: opts.brokers } : {}),
    ...(opts.leaseMs !== undefined ? { leaseMs: opts.leaseMs } : {}),
    ...(staticDir !== undefined ? { staticDir } : {}),
    ...(opts.authenticate !== undefined ? { authenticate: opts.authenticate } : {}),
  });
}

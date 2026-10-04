/**
 * Surface selection for a desktop run: a `desktop://<process>` base URL composes the Windows UI
 * Automation surface (`@cu/adapter-desktop`) instead of Chromium.
 *
 * How the app is started is run configuration, not policy: `--app-command "<command line>"`
 * (the surface launches it and owns its process tree) or `--attach-pid <pid>` (the surface drives
 * a running instance and leaves it running). A policy file is a guardrail reviewed as such; letting
 * it carry a command line would make it a way to run programs. The policy still decides which
 * process may be acted on: the run's policy is narrowed to the base URL's `desktop://<process>`
 * origin, and the surface only ever reports locations of the process tree it launched, so an
 * `--app-command` that starts some other program gets nothing done (its windows are never the
 * main window, and any location outside the allowed process quarantines the run).
 */
import { createDesktopSurface, parseCommandLine, type AppLaunch, type BridgeConnection, type DesktopScreenMask } from '@cu/adapter-desktop';
import { parseDesktopUrl, type Surface } from '@cu/core/surface';

/** How a desktop run gets its app, and what its screenshots hide. */
export interface DesktopRunOptions {
  /** A command line (`--app-command`) or a structured launch (tests). */
  launch?: string | AppLaunch;
  /** A running process to attach to (`--attach-pid`). */
  attachPid?: number;
  /**
   * Label/text masking rules. `compose` builds them from the policy's `redaction.screen` block
   * (`desktopScreenMaskFromPolicy`) when this is absent; passwords and fields the run typed into
   * are masked regardless.
   */
  mask?: DesktopScreenMask;
  /** Variable names the launched app must not inherit (the run's credential names). */
  dropEnv?: readonly string[];
  /** How long to wait for the app's first window. */
  startTimeoutMs?: number;
  /** An already-started bridge (tests: the fake bridge). */
  bridge?: BridgeConnection;
}

/** True when the run's options ask for a desktop app to be started or attached. */
export function wantsDesktopApp(opts: DesktopRunOptions | undefined): boolean {
  return opts !== undefined && (opts.launch !== undefined || opts.attachPid !== undefined);
}

/** Starts (or attaches to) the app named by a desktop base URL and returns its raw surface. */
export async function createDesktopRunSurface(baseUrl: string, opts: DesktopRunOptions | undefined, log?: (msg: string) => void): Promise<Surface> {
  const loc = parseDesktopUrl(baseUrl);
  if (!loc) throw new Error(`--base-url "${baseUrl}" is not a desktop://<process-name> location`);
  if (opts?.launch !== undefined && opts.attachPid !== undefined) throw new Error('pass either --app-command or --attach-pid, not both');
  if (!wantsDesktopApp(opts)) {
    throw new Error(`a desktop base URL (${baseUrl}) needs --app-command "<command line>" to start the app, or --attach-pid <pid> to drive a running one`);
  }
  const launch = typeof opts!.launch === 'string' ? parseCommandLine(opts!.launch) : opts!.launch;
  return createDesktopSurface({
    processName: loc.processName,
    ...(launch !== undefined ? { launch } : { attachPid: opts!.attachPid! }),
    ...(opts!.mask !== undefined ? { mask: opts!.mask } : {}),
    ...(opts!.dropEnv !== undefined ? { dropEnv: opts!.dropEnv } : {}),
    ...(opts!.bridge !== undefined ? { bridge: opts!.bridge } : {}),
    ...(opts!.startTimeoutMs !== undefined ? { startTimeoutMs: opts!.startTimeoutMs } : {}),
    ...(log !== undefined ? { log } : {}),
  });
}

/**
 * Composition root: the one way the system is wired together. Used by every CLI command
 * (discover, replay, catalog invoke) and by the e2e tests.
 *
 *   Relay console (optional)          @cu/relay; started first when compose owns it, so a busy port
 *                                     fails before any browser is launched
 *   raw Surface (Playwright for http(s), the UIA desktop surface for desktop://<process>, or injected)
 *     -> withPolicy(guard)            every act() checked against the run's policy; decisions -> `policy` events
 *     -> createSessionBroker          control token; broker.surface is the guarded surface automation gets
 *     -> registered with the console  the human-in-the-loop control plane
 *
 *   policy:   the loaded policy with `allowedOrigins` narrowed to the run's own base-URL origin, so
 *             a run for one tenant can never act on another tenant's origin.
 *   redactor: one per run (policy patterns plus the run's credential values, from the
 *             CredentialSet the caller loaded, and its sensitive input values),
 *             shared by the logger, the broker (its events and intervention store) and the Relay
 *             console's payloads for this run.
 *
 * Nothing here knows about replay or discovery; commands take `c.surface`, `c.guard`, `c.escalate`,
 * `c.logger` and pass them on.
 */
import path from 'node:path';
import type { Browser } from 'playwright';
import type { Policy, RunKind } from '@cu/core/schema';
import { allowlistOrigin, createPolicyGuard, loadPolicy, withPolicy, type PolicyGuard } from '@cu/core/policy';
import { createRunLogger, createRunRedactor, newRunId, redactionPatternsFromPolicy, type Redactor, type RunLogger } from '@cu/core/evidence';
import { createSessionBroker, type SessionBroker, type EscalationHandler } from '@cu/core/session';
import { desktopUrlProblem, isDesktopUrl, screenMaskOptionsFromPolicy, type Surface } from '@cu/core/surface';
import { EMPTY_CREDENTIALS, type CredentialSet } from '@cu/core/credentials';
import { createPlaywrightSurface } from '@cu/adapter-playwright';
import { startRelayConsole, type RelayServerHandle } from './relay-ui.js';
import { desktopScreenMaskFromPolicy } from '@cu/adapter-desktop';
import { createDesktopRunSurface, wantsDesktopApp, type DesktopRunOptions } from './desktop.js';

export const DEFAULT_BASE_URL = 'http://localhost:4173';
export const DEFAULT_POLICY_FILE = 'policies/default.yaml';
export const DEFAULT_RUNS_DIR = 'runs';
export const DEFAULT_OPERATOR_PORT = 4300;

/**
 * Mock-app tenant aliases. `a`/`b` are the mock app's tenant ids; the capability's
 * `overrides[].tenant` key for tenant B is the institution slug `riverbend-fcu`. Any other value is
 * passed through unchanged as the override key.
 */
export const TENANTS: Record<string, { overrideKey?: string; baseUrl: string }> = {
  a: { baseUrl: 'http://localhost:4173' },
  b: { overrideKey: 'riverbend-fcu', baseUrl: 'http://localhost:4174' },
};

/** `tenant` flag -> {override key for replay, default base URL}. */
export function resolveTenant(tenant: string | undefined): { overrideKey?: string; baseUrl?: string } {
  if (tenant === undefined) return {};
  const known = TENANTS[tenant];
  if (known) return { ...(known.overrideKey !== undefined ? { overrideKey: known.overrideKey } : {}), baseUrl: known.baseUrl };
  return { overrideKey: tenant };
}

/** Options for {@link compose}. */
export interface ComposeOptions {
  runKind: RunKind;
  /** Already-loaded policy wins over `policyPath`. */
  policy?: Policy;
  policyPath?: string;
  runsDir?: string;
  /** Default {@link DEFAULT_BASE_URL}. Its origin must be one of the policy's `allowedOrigins`, and is the only origin this run may act on. */
  baseUrl?: string;
  headless?: boolean;
  /** Inject a raw surface (tests: FakeSurface, or a Playwright surface on a page the test holds). Not closed by close() unless `ownSurface`. */
  surface?: Surface;
  ownSurface?: boolean;
  /** Launch the Playwright surface on this browser (tests share one browser per file). */
  browser?: Browser;
  /** Start a Relay console on this port (0 = ephemeral), or register with an existing one. Omit for none. */
  operator?: { port: number } | { server: RelayServerHandle };
  runId?: string;
  sessionLabel?: string;
  /** The run's loaded credentials (see runtime/credentials.ts). Their values are scrubbed from evidence, intervention records, recorded human actions and Relay payloads. Default: none. */
  credentials?: CredentialSet;
  /** Plaintext values of the run's sensitive inputs; scrubbed from the same places as the secrets. */
  sensitiveValues?: readonly string[];
  /** A `desktop://<process>` base URL's app: how to start or attach to it (see ./desktop.ts). */
  desktop?: DesktopRunOptions;
}

/** Everything `compose()` wires together for one run: policy guard, session broker, logger, and
 * the surface automation should use. */
export interface Composition {
  runId: string;
  runKind: RunKind;
  /** The run's policy: the loaded one with `allowedOrigins` narrowed to the base URL's origin. */
  policy: Policy;
  guard: PolicyGuard;
  logger: RunLogger;
  /** The run's redactor: policy patterns plus the run's secret and sensitive input values. */
  redactor: Redactor;
  broker: SessionBroker;
  /** What automation gets: broker.surface (control-token guarded, policy enforced underneath). */
  surface: Surface;
  /** broker.escalate plus the resume step the caller owes the broker (see resumingEscalation). */
  escalate: EscalationHandler;
  operator?: RelayServerHandle;
  /** Idempotent: unregister/stop the Relay console, close the raw surface (browser) if owned. */
  close(): Promise<void>;
}

/**
 * The broker stays in `resuming` after a hand-back until the caller calls `resumed()`. Neither
 * replay nor discovery calls it directly: both re-verify by acting (replay re-runs the step or
 * waits on its postcondition; discovery re-observes and re-plans), and acting is refused while
 * `resuming`. So this returns the token to `automation` as soon as the human hands back;
 * replay's own re-verification then runs as automation, and if it fails replay escalates again
 * (a new intervention, bounded by maxEscalations). `reverifyFailed` is therefore unused by this
 * wiring.
 */
export function resumingEscalation(broker: SessionBroker): EscalationHandler {
  return async (req) => {
    const resolution = await broker.escalate(req);
    if (resolution.resumeFrom !== 'abort' && !broker.terminated && broker.token.state === 'resuming') {
      broker.resumed(resolution.interventionId, 'automation');
    }
    return resolution;
  };
}

/**
 * The policy one run enforces: `policy` with `allowedOrigins` narrowed to `baseUrl`'s origin, so
 * a run reaches its own tenant and nothing else the policy happens to list. Throws when that
 * origin is not in the policy at all (the CLI commands check this before calling compose, with a
 * friendlier message) or `baseUrl` is not a URL.
 */
export function runPolicy(policy: Policy, baseUrl: string): Policy {
  // allowlistOrigin, not URL.origin: a desktop://<process> base URL's URL.origin is "null".
  const origin = allowlistOrigin(baseUrl);
  if (origin === undefined) {
    const detail = isDesktopUrl(baseUrl) ? `: ${desktopUrlProblem(baseUrl) ?? 'malformed'}` : '';
    throw new Error(`compose: base URL ${baseUrl} is neither an http(s) URL nor a desktop://<process> location${detail}`);
  }
  if (!policy.allowedOrigins.some((o) => allowlistOrigin(o) === origin)) {
    throw new Error(`compose: origin ${origin} is not in policy ${policy.name} allowedOrigins`);
  }
  return { ...policy, allowedOrigins: [origin] };
}

/**
 * Wires a raw Surface, policy enforcement, the session broker and (optionally) a Relay console
 * into one {@link Composition}. If a step fails part-way, whatever compose already started (its
 * own console, its own surface, the broker) is closed before the error propagates.
 */
export async function compose(opts: ComposeOptions): Promise<Composition> {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const policy = runPolicy(opts.policy ?? loadPolicy(path.resolve(opts.policyPath ?? DEFAULT_POLICY_FILE)), baseUrl);
  const guard = createPolicyGuard(policy);
  const runId = opts.runId ?? newRunId();
  const credentials = opts.credentials ?? EMPTY_CREDENTIALS;
  const sensitiveValues = [...(opts.sensitiveValues ?? [])];
  // The credentials were loaded once, before compose(); their values are the secret half of the list.
  const runValues = (): string[] => [...credentials.values(), ...sensitiveValues];
  const redactor = createRunRedactor({ patterns: redactionPatternsFromPolicy(policy.redaction.patterns), values: runValues });
  const logger = createRunLogger({
    runId,
    runKind: opts.runKind,
    rootDir: path.resolve(opts.runsDir ?? DEFAULT_RUNS_DIR),
    redactor,
  });

  const ownSurface = opts.surface === undefined || opts.ownSurface === true;
  let raw: Surface | undefined = opts.surface;
  let operator: RelayServerHandle | undefined;
  let ownOperator = false;
  let broker: SessionBroker | undefined;
  try {
    // The console compose owns starts before the browser, so a busy port fails with no browser to close.
    if (opts.operator && 'server' in opts.operator) {
      operator = opts.operator.server;
    } else if (opts.operator) {
      operator = await startRelayConsole({ port: opts.operator.port });
      ownOperator = true;
    }
    // The base URL's scheme selects the surface: desktop://<process> drives a Windows app.
    if (raw === undefined && isDesktopUrl(baseUrl)) {
      // The launched app never inherits the run's credentials; bridge diagnostics go to the run log.
      const desktopLog = (message: string): void => {
        try {
          logger.event({ kind: 'observation', data: { source: 'desktop-surface', message } });
        } catch {
          /* logger finished */
        }
      };
      // Screen masking from the same policy block as the web surface (maskInputs, whole-label
      // maskLabels, the redaction patterns and the run's values); explicit desktop.mask options win.
      const mask = opts.desktop?.mask ?? desktopScreenMaskFromPolicy(screenMaskOptionsFromPolicy(policy, runValues));
      raw = await createDesktopRunSurface(baseUrl, { ...opts.desktop, mask, dropEnv: [...(opts.desktop?.dropEnv ?? []), ...credentials.names()] }, desktopLog);
    }
    if (raw === undefined && wantsDesktopApp(opts.desktop)) throw new Error('--app-command / --attach-pid apply only to a desktop://<process> --base-url');
    raw ??= await createPlaywrightSurface({
      headless: opts.headless ?? true,
      baseUrl,
      ...(opts.browser ? { browser: opts.browser } : {}),
      // Screen masking at the surface: the policy's redaction.screen block plus the run's values,
      // read per capture (docs/design/screen-masking.md). An injected surface brings its own.
      screenMask: screenMaskOptionsFromPolicy(policy, runValues),
      // Evidence records whether the browser agent was app-included (the target's own tag) or injected.
      onAgentDetected: (detail) => {
        try {
          logger.event({ kind: 'observation', data: { ...detail } });
        } catch {
          /* logger finished */
        }
      },
    });
    broker = createBroker(raw);
    operator?.register(broker, { redact: redactor });
  } catch (err) {
    broker?.dispose();
    if (operator !== undefined && ownOperator) await operator.close().catch(() => undefined);
    if (raw !== undefined && ownSurface) await raw.close().catch(() => undefined);
    throw err;
  }
  return assemble(raw, broker);

  function createBroker(surface: Surface): SessionBroker {
    const policySurface = withPolicy(surface, guard, {
      runKind: opts.runKind,
      onDecision: (e) => {
        try {
          logger.event({ kind: 'policy', data: { source: 'enforcing-surface', ...e } });
        } catch {
          // logger already finished (a late decision during shutdown): nothing left to record into.
        }
      },
    });
    return createSessionBroker({
      surface: policySurface,
      logger,
      runId,
      runKind: opts.runKind,
      // withPolicy forwards humanCapture; pass it explicitly so the broker never silently loses capture.
      capture: policySurface.humanCapture ?? surface.humanCapture ?? null,
      ...(opts.sessionLabel !== undefined ? { sessionLabel: opts.sessionLabel } : {}),
      secretValues: runValues,
      redactor,
    });
  }

  function assemble(surface: Surface, runBroker: SessionBroker): Composition {
    let closed = false;
    async function close(): Promise<void> {
      if (closed) return;
      closed = true;
      // Stops the intervention-lease checker; the run is over, so nothing is left to lease.
      runBroker.dispose();
      if (operator) {
        try {
          if (ownOperator) await operator.close();
          else operator.unregister(runId);
        } catch {
          /* best effort */
        }
      }
      if (ownSurface) {
        try {
          await surface.close();
        } catch {
          /* best effort */
        }
      }
    }

    return {
      runId,
      runKind: opts.runKind,
      policy,
      guard,
      logger,
      redactor,
      broker: runBroker,
      surface: runBroker.surface,
      escalate: resumingEscalation(runBroker),
      ...(operator ? { operator } : {}),
      close,
    };
  }
}

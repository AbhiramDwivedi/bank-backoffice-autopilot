/**
 * Shared replay wiring: compose() -> attachAutoOperator() -> replayCapability() -> close(), inside
 * runWithShutdown so the browser and any Relay console this call owns are always cleaned up.
 * Used by both `commands/replay.ts` and `apps/cu/src/catalog/index.ts` (`Catalog.invoke`) so there is
 * exactly one path from "a capability + inputs" to a `ReplayResult`.
 *
 * Operator-port safety: when the caller passes a bare `{port}`, this module starts the
 * Relay console itself, before calling `compose()`, and passes the already-started
 * `{server}` into it. A busy port (EADDRINUSE) falls back to an OS-assigned port, logged with the
 * console's actual URL, so the run still has a console; any other start failure propagates before
 * `compose()` ever launches a browser. `compose()` is only ever given `operator: {server}` by this
 * module, never `operator: {port}`.
 *
 * Every `sensitive: true` input's value is handed to `compose()`, which scrubs it (with the
 * capability's credential values) from evidence, intervention records and the console.
 *
 * Credentials: the names of every `{kind:'secret'}` binding in the artifact are loaded from
 * `opts.credentials` (default: the environment) FIRST, before a console or a browser starts; a
 * missing one throws `CredentialsUnavailableError` naming it and the provider. The loaded set binds
 * the secrets (replay's `secret` resolver), feeds the redactor (compose) and the relogin operator.
 */
import type { Browser } from 'playwright';
import type { Policy, ReplayResult } from '@cu/core/schema';
import type { Surface } from '@cu/core/surface';
import { compose, type ComposeOptions } from './compose.js';
import { attachAutoOperator, type AutoOperatorMode } from './operators.js';
import { runWithShutdown } from './lifecycle.js';
import { applyTenantOverride, replayCapability, type ReplayOptions } from '@cu/core/replay';
import { validateCapability, type Capability } from '@cu/core/schema';
import { envCredentialProvider, type CredentialProvider } from '@cu/core/credentials';
import { loadRunCredentials } from './credentials.js';
import { startRelayConsole, type RelayServerHandle, type StartRelayConsoleOptions } from './relay-ui.js';

/** Options for {@link runReplay}. */
export interface RunReplayOptions {
  /** Raw artifact JSON; validated inside replayCapability. */
  capability: unknown;
  inputs: Record<string, unknown>;
  /** Already-loaded policy wins over policyPath (mirrors ComposeOptions). */
  policy?: Policy;
  policyPath?: string;
  runsDir: string;
  baseUrl: string;
  headless: boolean;
  /** capability.overrides[].tenant override key (NOT the mock tenant id a/b). */
  tenant?: string;
  autoOperator: AutoOperatorMode;
  /** Start (or reuse) a Relay console. Omit for none. */
  operator?: { port: number } | { server: RelayServerHandle };
  /** For a desktop://<process> base URL: how to start or attach to the app. */
  desktop?: ComposeOptions['desktop'];
  /** Inject a surface/browser (tests, or a page a caller already holds). */
  browser?: Browser;
  surface?: Surface;
  /** One-line progress/warning messages. Default: swallowed (library callers get silence). */
  log?: (line: string) => void;
  /** Starts the Relay console for a bare `operator: {port}`. Default {@link startRelayConsole}; tests inject a fake. */
  startConsole?: (opts: StartRelayConsoleOptions) => Promise<RelayServerHandle>;
  /** Where the artifact's `{kind:'secret'}` credentials come from. Default: the environment. */
  credentials?: CredentialProvider;
  /**
   * The caller's assertion that replaying the capability changes nothing in the target app, for
   * this run (`replay --read-only`): it lets replay retry a transient app error by restarting its
   * steps. Not verified; replay refuses it on a capability with anything irreversible.
   */
  readOnly?: boolean;
  /**
   * The wait before app-error retry n is n times this, in milliseconds (replay's
   * `appErrorRetryBackoffMs`; default one second). Tests pass 0 so a retry does not sleep in real time.
   */
  appErrorRetryBackoffMs?: number;
  /**
   * Extra replay options for this one run (the optimizer's trials, runtime/run-optimize.ts): an
   * observational `beforeStep` hook, a step timeout, `requireApproved`, which forces the
   * approval gate on whatever the policy's `replayRequiresApproved` says, and an app-error retry
   * budget that wins over the policy's `limits.maxAppErrorRetries`.
   */
  replayExtras?: Pick<ReplayOptions, 'beforeStep' | 'stepTimeoutMs' | 'maxAppErrorRetries'> & { requireApproved?: boolean };
}

/** Result of {@link runReplay}: the replay outcome plus where its evidence and (if any) operator
 * console ended up. */
export interface RunReplayResult {
  result: ReplayResult;
  runDir: string;
  /** Set only when a console ended up running for this call. */
  operatorUrl?: string;
  /** The run's final control state once the run (and its shutdown) finished -- 'automation'
   *  proves control was handed back after any escalation; 'terminated' once an intervention was
   *  aborted (see {@link controlStateLabel}: `broker.token.state` alone stays 'paused' there). */
  controlState: string;
}

/**
 * The control state to report to a caller/CLI, given the broker a run finished with.
 * `ControlState` (docs/contracts.md section 7) has no terminal member of its own: after `abort()`
 * the token itself still reads `state: 'paused'`, `holder: 'none'` (docs/design/handoff.md, "After
 * abort the token reads `paused` / holder `none` with `terminated: true`"), which prints
 * misleadingly as an ordinary pause rather than the run having ended. `broker.terminated` is the
 * one place that distinction actually lives, so it wins here.
 */
export function controlStateLabel(broker: { terminated: boolean; token: { state: string } }): string {
  return broker.terminated ? 'terminated' : broker.token.state;
}

const noop = (_line: string): void => {
  /* swallowed by default */
};

/**
 * The credential names (`env`) of every `{kind:'secret'}` binding the run will actually execute: the
 * capability with `tenant`'s override applied (steps, recovery rules, and that override's patches
 * and extra steps), and no other tenant's override, so a name only another tenant needs is never
 * demanded. An artifact that does not validate (replay will reject it anyway) is walked raw; none
 * if it is not an object.
 */
export function secretEnvNamesOf(capability: unknown, tenant?: string): string[] {
  const parsed = validateCapability(capability);
  if (parsed.ok) {
    try {
      const effective: Capability = { ...applyTenantOverride(parsed.capability, tenant).capability };
      delete effective.overrides;
      return collectSecretNames(effective);
    } catch {
      /* fall through to the raw walk */
    }
  }
  return collectSecretNames(capability);
}

function collectSecretNames(capability: unknown): string[] {
  const names = new Set<string>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v !== null && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (o.kind === 'secret' && typeof o.env === 'string') names.add(o.env);
      Object.values(o).forEach(walk);
    }
  };
  walk(capability);
  return [...names];
}

/**
 * The values `inputs` supplies for every input a raw artifact declares `sensitive: true`, as
 * strings. None if the artifact is not an object or declares no inputs.
 */
export function sensitiveInputValuesOf(capability: unknown, inputs: Record<string, unknown>): string[] {
  if (capability === null || typeof capability !== 'object') return [];
  const specs = (capability as { inputs?: unknown }).inputs;
  if (specs === null || typeof specs !== 'object' || Array.isArray(specs)) return [];
  const values: string[] = [];
  for (const [name, spec] of Object.entries(specs as Record<string, unknown>)) {
    if (spec === null || typeof spec !== 'object' || (spec as { sensitive?: unknown }).sensitive !== true) continue;
    const v = inputs[name];
    if (v !== undefined && v !== null && v !== '') values.push(String(v));
  }
  return values;
}

/**
 * Names of every output, and every business-outcome return, a raw artifact declares
 * `sensitive: true` (read from a masked element at discovery). None if it is not an object.
 */
export function sensitiveOutputNamesOf(capability: unknown): string[] {
  if (capability === null || typeof capability !== 'object') return [];
  const names = new Set<string>();
  const collect = (specs: unknown): void => {
    if (specs === null || typeof specs !== 'object' || Array.isArray(specs)) return;
    for (const [name, spec] of Object.entries(specs as Record<string, unknown>)) {
      if (spec !== null && typeof spec === 'object' && (spec as { sensitive?: unknown }).sensitive === true) names.add(name);
    }
  };
  const cap = capability as { outputs?: unknown; businessOutcomes?: unknown };
  collect(cap.outputs);
  if (Array.isArray(cap.businessOutcomes)) for (const o of cap.businessOutcomes) collect((o as { returns?: unknown } | null)?.returns);
  return [...names];
}

function isEaddrinuse(err: unknown): boolean {
  return err !== null && typeof err === 'object' && (err as { code?: unknown }).code === 'EADDRINUSE';
}

/**
 * Starts the console on `port`; when that port is taken, on an OS-assigned one instead, logging
 * where it ended up. Any other failure propagates.
 */
async function startOwnConsole(
  port: number,
  log: (line: string) => void,
  start: (opts: StartRelayConsoleOptions) => Promise<RelayServerHandle>,
): Promise<RelayServerHandle> {
  try {
    return await start({ port, log });
  } catch (err) {
    if (!isEaddrinuse(err) || port === 0) throw err;
    const fallback = await start({ port: 0, log });
    log(`warning: operator port ${port} is already in use; the operator console is on ${fallback.url} instead`);
    return fallback;
  }
}

/** Runs one capability replay end to end: composes the runtime, attaches a scripted operator,
 * replays the capability, and cleans up. */
export async function runReplay(opts: RunReplayOptions): Promise<RunReplayResult> {
  const log = opts.log ?? noop;

  // Before anything starts: a missing credential throws here, with nothing to clean up.
  const credentials = await loadRunCredentials(opts.credentials ?? envCredentialProvider(), secretEnvNamesOf(opts.capability, opts.tenant));

  let ownedOperator: RelayServerHandle | undefined;
  let composeOperator: ComposeOptions['operator'] | undefined;

  if (opts.operator !== undefined) {
    if ('server' in opts.operator) {
      composeOperator = { server: opts.operator.server };
    } else {
      ownedOperator = await startOwnConsole(opts.operator.port, log, opts.startConsole ?? startRelayConsole);
      composeOperator = { server: ownedOperator };
    }
  }

  let c: Awaited<ReturnType<typeof compose>>;
  try {
    c = await compose({
      runKind: 'replay',
      credentials,
      sensitiveValues: sensitiveInputValuesOf(opts.capability, opts.inputs),
      ...(opts.policy !== undefined ? { policy: opts.policy } : {}),
      ...(opts.policyPath !== undefined ? { policyPath: opts.policyPath } : {}),
      runsDir: opts.runsDir,
      baseUrl: opts.baseUrl,
      headless: opts.headless,
      ...(opts.browser !== undefined ? { browser: opts.browser } : {}),
      ...(opts.surface !== undefined ? { surface: opts.surface } : {}),
      ...(opts.desktop !== undefined ? { desktop: opts.desktop } : {}),
      ...(composeOperator !== undefined ? { operator: composeOperator } : {}),
    });
  } catch (err) {
    // compose failed (bad policy path, browser launch...): a leaked listener would keep the process alive.
    if (ownedOperator) await ownedOperator.close().catch(() => undefined);
    throw err;
  }

  if (c.operator) log(`operator console: ${c.operator.url}`);

  const auto = attachAutoOperator(c.broker, opts.autoOperator, {
    baseUrl: opts.baseUrl,
    // The relogin operator reads the failing step's checkpoint from the capability to pick its hand-back.
    replay: { capability: opts.capability, inputs: opts.inputs, ...(opts.tenant !== undefined ? { tenant: opts.tenant } : {}) },
    credentials,
    log,
  });

  // The policy file is where run limits live; a caller's own budget (an optimizer trial's 0) wins.
  const maxAppErrorRetries = opts.replayExtras?.maxAppErrorRetries ?? c.policy.limits.maxAppErrorRetries;

  try {
    const result = await runWithShutdown(
      c,
      () =>
        replayCapability({
          capability: opts.capability,
          inputs: opts.inputs,
          surface: c.surface,
          baseUrl: opts.baseUrl,
          ...(opts.tenant !== undefined ? { tenant: opts.tenant } : {}),
          policy: c.guard,
          replayRequiresApproved: opts.replayExtras?.requireApproved === true ? true : c.policy.risk.replayRequiresApproved,
          logger: c.logger,
          escalate: c.escalate,
          ...(opts.readOnly === true ? { readOnly: true } : {}),
          ...(maxAppErrorRetries !== undefined ? { maxAppErrorRetries } : {}),
          ...(opts.appErrorRetryBackoffMs !== undefined ? { appErrorRetryBackoffMs: opts.appErrorRetryBackoffMs } : {}),
          secret: (name) => credentials.get(name),
          ...(opts.replayExtras?.beforeStep !== undefined ? { beforeStep: opts.replayExtras.beforeStep } : {}),
          ...(opts.replayExtras?.stepTimeoutMs !== undefined ? { stepTimeoutMs: opts.replayExtras.stepTimeoutMs } : {}),
        }),
      log,
    );
    return { result, runDir: c.logger.dir, ...(c.operator ? { operatorUrl: c.operator.url } : {}), controlState: controlStateLabel(c.broker) };
  } finally {
    auto?.stop();
    await auto?.idle();
    // runWithShutdown's c.close() only unregisters a {server}-provided operator. An operator
    // started here (bare {port}) is closed here too.
    if (ownedOperator) await ownedOperator.close().catch(() => undefined);
  }
}

/**
 * Shared optimizer wiring: `optimizeCapability` (packages/core/src/optimize, model-free) with its
 * trial runner implemented by `runReplay`, the same single path from "capability + inputs" to a
 * `ReplayResult` that `cu replay` and the catalog use. Used by `cu optimize` and by `discover`'s
 * automatic post-discovery stage.
 *
 * Every trial:
 * - shares ONE browser (launched here on the first trial unless the caller injects one), with a
 *   fresh context per trial, exactly like `cu replay --times` -- no cookie or session state leaks
 *   from one trial into the next;
 * - has no Relay console and a scripted `abort` operator, so any escalation ends the trial (a
 *   failed trial) instead of waiting for a human who is not there;
 * - forces the approval gate (`requireApproved`) on a draft copy, so an action the live policy
 *   flags irreversible fails the trial before it executes, whatever the policy's
 *   `replayRequiresApproved` says;
 * - writes its own run directory, under a prerelease version (`x.y.z-optimize.n`) that `cu approve`
 *   never mistakes for replay evidence of a real version.
 *
 * Irreversibility is also judged statically, before any trial, with the policy guard's own
 * `classifyRisk` over each step's recorded target texts and URL: a capability with any step the
 * policy would classify irreversible is analysis-only. Trials only ever run at all for a capability
 * the operator declared `readOnly` (the core optimizer enforces that).
 *
 * Every trial's failure `detail` is redacted (policy patterns, the run's secret and sensitive
 * values) before the optimizer sees it, because the report persists it.
 *
 * A desktop capability (a `desktop://<process>` base URL) is trialled on the desktop surface: every
 * trial starts its own instance of the app from the caller's launch command, which is the desktop
 * equivalent of a fresh browser session, and no browser is launched. Attaching to an already
 * running app (`--attach-pid`) gives every trial the same live session, so nothing a trial did
 * could be told apart from what the next one found: such a run is analysis-only.
 *
 * Credentials: the capability's credentials are loaded once, from the caller's provider (default
 * the environment), when the first trial is about to run -- an analysis-only run needs none and
 * loads none. Every trial then gets a provider backed by that one loaded set, and the same values
 * feed the redactor.
 */
import path from 'node:path';
import { chromium, type Browser } from 'playwright';
import { createPolicyGuard, loadPolicy } from '@cu/core/policy';
import { createRunRedactor, redactionPatternsFromPolicy } from '@cu/core/evidence';
import type { Capability, Policy, ReplayResult, Step } from '@cu/core/schema';
import { isDesktopUrl, type Surface } from '@cu/core/surface';
import { optimizeCapability, type OptimizeResult, type OutputMap, type RunTrial, type TrialOutcome } from '@cu/core/optimize';
import { envCredentialProvider, type CredentialProvider } from '@cu/core/credentials';
import { DEFAULT_POLICY_FILE } from './compose.js';
import type { DesktopRunOptions } from './desktop.js';
import { loadRunCredentials, preloadedCredentialProvider } from './credentials.js';
import { runReplay, secretEnvNamesOf, sensitiveInputValuesOf, type RunReplayOptions } from './run-replay.js';

/** Default step timeout for removal trials: a removal that breaks the path fails at the first
 *  step that cannot find its target, and should not wait the full replay default to say so. A
 *  too-short timeout can only make the optimizer keep a step, never remove one wrongly: removals
 *  are verified with the normal timeout. */
export const DEFAULT_REMOVAL_STEP_TIMEOUT_MS = 5_000;

/** The credentials option of `runReplay`, if this build's RunReplayOptions has one. */
type CredentialsOption = RunReplayOptions extends { credentials?: infer C } ? C : unknown;

/** The allowlist of runReplay options a caller may thread into optimization trials. */
export interface TrialReplayPassThrough {
  credentials?: CredentialsOption;
}

/** Options for {@link runOptimize}. */
export interface RunOptimizeOptions {
  /** A validated capability. */
  capability: Capability;
  /** The inputs every trial replays with (one input set). */
  inputs: Record<string, unknown>;
  /** Already-loaded policy wins over policyPath. */
  policy?: Policy;
  policyPath?: string;
  runsDir: string;
  baseUrl: string;
  headless: boolean;
  /** capability.overrides[].tenant key the trials apply, if any. */
  tenant?: string;
  /** Share this browser across trials (not closed here). Default: one launched here, closed at the end. */
  browser?: Browser;
  /** Tests: a fresh surface per trial instead of a browser. */
  surfaceFactory?: () => Surface | Promise<Surface>;
  /** For a desktop://<process> base URL: how each trial starts its own instance of the app. */
  desktop?: DesktopRunOptions;
  maxTrials?: number;
  verifyRuns?: number;
  trialDelayMs?: number;
  /** Report only; never replay or rewrite. */
  analyzeOnly?: boolean;
  /** Per-step caller veto (see OptimizeOptions.vetoStep), e.g. a risk-judge raise. */
  vetoStep?: (step: Step) => string | undefined;
  /** Stops the optimizer from starting further trials (Ctrl-C during `discover`'s stage). */
  signal?: AbortSignal;
  /**
   * The ALLOWLISTED `runReplay` options a caller may pass to every trial: a credentials provider,
   * nothing else. Anything that decides what a trial runs, where, as whom, or how unattended it is
   * (surface, browser, tenant, capability, inputs, policy, runsDir, operator, approval gate) is set
   * here and only here; extra keys are ignored.
   */
  replayPassThrough?: TrialReplayPassThrough;
  /** Step timeout for the baseline, start and verification trials. Default: replay's own. */
  stepTimeoutMs?: number;
  /** Step timeout for removal trials. Default {@link DEFAULT_REMOVAL_STEP_TIMEOUT_MS}. */
  removalStepTimeoutMs?: number;
  /** Outputs the baseline must reproduce too (discovery's own). */
  referenceOutputs?: OutputMap;
  bumpVersion?: boolean;
  /** For the provenance note, e.g. `cu optimize`. */
  source?: string;
  log?: (line: string) => void;
}

function summarizeFailure(result: ReplayResult): string | undefined {
  switch (result.kind) {
    case 'success':
      return undefined;
    case 'business_outcome':
      return `business outcome ${result.name}`;
    case 'hard_failure':
      return `${result.code}${result.stepId !== undefined ? ` at ${result.stepId}` : ''}: ${result.message}`;
    case 'escalated':
      return `escalated${result.stepId !== undefined ? ` at ${result.stepId}` : ''} (${result.reason}); an unattended trial counts that as a failure`;
  }
}

/** A replay result as the optimizer sees it. `redact` scrubs the failure detail, which the
 *  optimizer persists in its report. */
export function trialOutcomeOf(result: ReplayResult, runDir: string, redact: (text: string) => string = (t) => t): TrialOutcome {
  const raw = summarizeFailure(result);
  const detail = raw !== undefined ? redact(raw) : undefined;
  return {
    kind: result.kind,
    ...(result.kind === 'success' ? { outputs: result.outputs } : {}),
    runId: result.runId,
    runDir,
    ...(detail !== undefined ? { detail } : {}),
    locatorDepth: result.locatorReport.reduce((sum, e) => sum + e.fallbackDepth, 0),
  };
}

/**
 * The policy's static view of whether a step is irreversible: `classifyRisk` over the step's
 * recorded target name/texts, with the URL of the most recent navigate before it (or the entry
 * URL) as the current page. Recorded texts, not live ones: a trial's own policy gate still checks
 * the live page, and fails the trial (never acts) if it disagrees.
 */
export function policyIrreversibility(policy: Policy, capability: Capability, baseUrl: string): (step: Step) => boolean {
  const guard = createPolicyGuard(policy);
  const bindBase = (url: string): string => url.split('{baseUrl}').join(baseUrl.replace(/\/+$/, ''));
  const urlBefore = new Map<string, string>();
  let current = bindBase(capability.app.entryUrl);
  for (const s of capability.steps) {
    urlBefore.set(s.id, current);
    if (s.action.type === 'navigate') current = bindBase(s.action.url);
  }
  return (step) => {
    const a = step.action;
    const ctx: { targetName?: string; targetText?: string; currentUrl: string } = { currentUrl: urlBefore.get(step.id) ?? current };
    if ('target' in a) {
      const t = a.target;
      const role = t.locators.map((l) => l.strategy).find((st) => st.kind === 'role');
      const text = t.locators.map((l) => l.strategy).find((st) => st.kind === 'text');
      const name = t.snapshot?.name ?? (role?.kind === 'role' ? role.name : undefined);
      if (name !== undefined) ctx.targetName = name;
      ctx.targetText = [t.description, t.snapshot?.text, text?.kind === 'text' ? text.text : undefined].filter((x): x is string => x !== undefined).join(' | ');
    }
    const action = a.type === 'navigate' ? { ...a, url: bindBase(a.url) } : a;
    try {
      return guard.classifyRisk(action, ctx) === 'irreversible';
    } catch {
      return true; // unclassifiable: treat as irreversible, i.e. never trial it
    }
  };
}

/**
 * Optimizes `opts.capability` with replay trials (see the module header). Returns the optimized
 * draft and the report; an interruption (Ctrl-C) propagates after the shared browser is closed.
 */
export async function runOptimize(opts: RunOptimizeOptions): Promise<OptimizeResult> {
  const log = opts.log ?? ((): void => undefined);
  const policy = opts.policy ?? loadPolicy(path.resolve(opts.policyPath ?? DEFAULT_POLICY_FILE));
  const desktopApp = isDesktopUrl(opts.baseUrl);
  // A fresh session per trial is the premise of every comparison the optimizer makes. On a desktop
  // app that means a fresh instance, which only a launch command can give.
  const sharedDesktopSession = desktopApp && opts.surfaceFactory === undefined && opts.desktop?.launch === undefined;
  if (sharedDesktopSession) {
    log('optimize: analysis only: trials need a fresh instance of the desktop app each time, which needs --app-command (an attached app is one shared live session)');
  }
  let ownedBrowser: Browser | undefined;
  const browserFor = async (): Promise<Browser> => {
    if (opts.browser !== undefined) return opts.browser;
    ownedBrowser ??= await chromium.launch({ headless: opts.headless });
    return ownedBrowser;
  };
  // A trial's own progress lines are noise next to the optimizer's; its run directory is already
  // in the report.
  const trialLog = (line: string): void => {
    if (!line.startsWith('run dir:')) log(line);
  };

  // Loaded on the first trial (see the module header). A load failure rejects that trial's
  // promise with CredentialsUnavailableError, which names credentials and the provider only.
  const provider: CredentialProvider = opts.replayPassThrough?.credentials ?? envCredentialProvider();
  let credentialValues: string[] = [];
  let trialCredentials: Promise<CredentialProvider> | undefined;
  const credentialsForTrials = (): Promise<CredentialProvider> => {
    trialCredentials ??= loadRunCredentials(provider, secretEnvNamesOf(opts.capability, opts.tenant)).then((set) => {
      credentialValues = set.values();
      return preloadedCredentialProvider(set, provider.id);
    });
    return trialCredentials;
  };

  const redactor = createRunRedactor({
    patterns: redactionPatternsFromPolicy(policy.redaction.patterns),
    values: () => [...credentialValues, ...sensitiveInputValuesOf(opts.capability, opts.inputs)],
  });
  const redact = (text: string): string => {
    const out = redactor(text);
    return typeof out === 'string' ? out : '[REDACTED]';
  };

  const runTrial: RunTrial = async (req) => {
    const surface = opts.surfaceFactory !== undefined ? await opts.surfaceFactory() : undefined;
    const credentials = await credentialsForTrials();
    const ran = await runReplay({
      // The allowlist, key by key: never a spread of caller-supplied options.
      credentials,
      capability: req.capability,
      inputs: opts.inputs,
      policy,
      runsDir: opts.runsDir,
      baseUrl: opts.baseUrl,
      headless: opts.headless,
      ...(opts.tenant !== undefined ? { tenant: opts.tenant } : {}),
      // Unattended: any escalation is answered by an aborting operator (a failed trial), never a
      // human. No console is started for a trial.
      autoOperator: 'abort',
      operator: undefined,
      ...(surface !== undefined ? { surface } : desktopApp ? (opts.desktop !== undefined ? { desktop: opts.desktop } : {}) : { browser: await browserFor() }),
      log: trialLog,
      replayExtras: {
        ...(opts.stepTimeoutMs !== undefined ? { stepTimeoutMs: opts.stepTimeoutMs } : {}),
        // A trial copy is a draft; this makes the approval gate refuse anything the live policy
        // flags irreversible, whatever the policy's replayRequiresApproved says.
        requireApproved: true,
        // A trial asks "does this variant replay cleanly?". Replay's own retry of a transient app
        // error (a trial capability is read-only, so it would apply) would turn a flaky run into a
        // pass, so trials get no retry budget: an app error fails the trial.
        maxAppErrorRetries: 0,
        ...(req.beforeStep !== undefined ? { beforeStep: req.beforeStep } : {}),
        ...(req.purpose === 'removal' ? { stepTimeoutMs: opts.removalStepTimeoutMs ?? DEFAULT_REMOVAL_STEP_TIMEOUT_MS } : {}),
      },
    });
    return trialOutcomeOf(ran.result, ran.runDir, redact);
  };

  try {
    const result = await optimizeCapability(opts.capability, {
      runTrial,
      isIrreversible: policyIrreversibility(policy, opts.capability, opts.baseUrl),
      ...(opts.analyzeOnly !== undefined || sharedDesktopSession ? { analyzeOnly: opts.analyzeOnly === true || sharedDesktopSession } : {}),
      ...(opts.vetoStep !== undefined ? { vetoStep: opts.vetoStep } : {}),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      ...(opts.maxTrials !== undefined ? { maxTrials: opts.maxTrials } : {}),
      ...(opts.verifyRuns !== undefined ? { verifyRuns: opts.verifyRuns } : {}),
      ...(opts.trialDelayMs !== undefined ? { trialDelayMs: opts.trialDelayMs } : {}),
      ...(opts.referenceOutputs !== undefined ? { referenceOutputs: opts.referenceOutputs } : {}),
      ...(opts.bumpVersion !== undefined ? { bumpVersion: opts.bumpVersion } : {}),
      ...(opts.tenant !== undefined ? { tenant: opts.tenant } : {}),
      source: opts.source ?? 'the optimizer',
      log,
    });
    if (result.report.stop === 'completed' && result.report.trialsUsed > 0) {
      const names = Object.keys(opts.inputs);
      result.report.notes.push(
        `verified against one input set (${names.length > 0 ? names.join(', ') : 'no inputs'}) on ${opts.baseUrl}${opts.tenant !== undefined ? ` (override ${opts.tenant})` : ''}: ` +
          'a step that only matters for other inputs or another tenant can be removed wrongly -- review the draft and replay it more widely before approving',
      );
    }
    return result;
  } finally {
    if (ownedBrowser !== undefined) await ownedBrowser.close().catch(() => undefined);
  }
}

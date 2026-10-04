/**
 * Runs a capability end to end against a Surface: validates the artifact, applies the tenant
 * override, validates inputs, checks the approval gate, then runs the step loop and the final
 * success condition, escalating to a human whenever a failure is eligible for it. On a run asserted
 * read-only, a transient `app_error` is first retried by restarting the steps (`retryAppError`).
 */
import type { Capability, Condition, EscalatedOutcome, FailureCode, InputSpec, ReplayResult, Step } from '../schema/index.js';
import { capabilityDigest, REDACTED_VALUE, validateCapability } from '../schema/index.js';
import type { CapabilityIssue } from '../schema/index.js';
import type { EscalationResolution } from '../session/index.js';
import { bindConditionForReplay, type ReplayBindContext } from './bind.js';
import { shouldEscalate, buildEscalationRequest } from './escalate.js';
import { applyTenantOverride } from './overrides.js';
import { createSafeLogger, SCRUB_MIN_LENGTH } from './safe-logger.js';
import { createValueScrubber } from '../evidence/index.js';
import { appErrorRetryIndex, checkResumeAt, describeResumeRefusal, indexAfterSignIn, resetForResume, stepAfterSignIn } from './rewind.js';
import { bindErrorSignal, countsAsIrreversible, failStep, runStep, verifyPostcondition } from './steps.js';
import {
  APP_ERROR_RETRY,
  DEFAULT_APP_ERROR_RETRY_BACKOFF_MS,
  DEFAULT_APP_ERROR_SIGNALS,
  DEFAULT_ESCALATE_ON,
  DEFAULT_MAX_APP_ERROR_RETRIES,
  DEFAULT_MAX_DURATION_MS,
  DEFAULT_MAX_ESCALATIONS,
  DEFAULT_SESSION_EXPIRED_SIGNALS,
  DEFAULT_STEP_TIMEOUT,
  type HardFailureResult,
  type ReplayClock,
  type ReplayOptions,
  type RunState,
  type Scrubber,
  type StepFailure,
  type StepOutcome,
} from './types.js';
import { validateInputs } from './validate-inputs.js';

const MAX_ISSUES_TEXT = 2000;

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function issuesToObserved(issues: readonly CapabilityIssue[]): string {
  return truncate(issues.map((iss) => `${iss.path.join('.')}: ${iss.code} ${iss.message}`).join('; '), MAX_ISSUES_TEXT);
}

function rawIdVersion(raw: unknown): { capabilityId: string; capabilityVersion: string } {
  const obj = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  // Non-empty only: the result schema requires NonEmpty ids, and finish() validates the result.
  const capabilityId = typeof obj.id === 'string' && obj.id.length > 0 ? obj.id : 'unknown';
  const capabilityVersion = typeof obj.version === 'string' && obj.version.length > 0 ? obj.version : '0.0.0';
  return { capabilityId, capabilityVersion };
}

function describeInputSpec(name: string, spec: InputSpec): string {
  const parts = [`type ${spec.type}`, spec.required ? 'required' : 'optional'];
  if (spec.pattern !== undefined) parts.push(`matching /${spec.pattern}/`);
  return `input "${name}": ${parts.join(', ')}`;
}

interface ReplayBase {
  runId: string;
  capabilityId: string;
  capabilityVersion: string;
  stepsExecuted: number;
  durationMs: number;
  locatorReport: RunState['locatorReport'];
  recoveries: string[];
}

function toBase(s: RunState): ReplayBase {
  return {
    runId: s.runId,
    capabilityId: s.capability.id,
    capabilityVersion: s.capability.version,
    stepsExecuted: s.stepsExecuted,
    durationMs: Math.max(0, s.clock.now() - s.startedAt),
    locatorReport: s.locatorReport,
    recoveries: s.recoveries,
  };
}

/**
 * The escalated result's `outcome` is the caller's real answer -- what the run actually produced
 * (or failed with) after the human handed control back -- built from the same `underlying`
 * ReplayResult the `outcome` log event already carries.
 */
function toEscalatedOutcome(underlying: ReplayResult): EscalatedOutcome {
  switch (underlying.kind) {
    case 'success':
      return { kind: 'success', outputs: underlying.outputs };
    case 'business_outcome':
      return { kind: 'business_outcome', name: underlying.name, data: underlying.data };
    case 'hard_failure':
      return {
        kind: 'hard_failure',
        code: underlying.code,
        message: underlying.message,
        ...(underlying.stepId !== undefined ? { stepId: underlying.stepId } : {}),
      };
    case 'escalated':
      // Never reached: `underlying` is always built from toBase(s)+{success|business_outcome} or
      // toHardFailureResult, never from a nested `escalated` result.
      throw new Error('unreachable: underlying escalated result cannot itself be escalated');
  }
}

/** Builds the `business_outcome` `ReplayResult` from a step's `business_outcome` `StepOutcome`,
 *  carrying `missing` through only when it is non-empty (never an empty array on the wire). */
function toBusinessOutcomeResult(s: RunState, outcome: Extract<StepOutcome, { kind: 'business_outcome' }>): ReplayResult {
  return {
    ...toBase(s),
    kind: 'business_outcome',
    name: outcome.name,
    data: outcome.data,
    ...(outcome.missing !== undefined && outcome.missing.length > 0 ? { missing: outcome.missing } : {}),
  };
}

function toHardFailureResult(s: RunState, failure: StepFailure): HardFailureResult {
  return {
    ...toBase(s),
    kind: 'hard_failure',
    ...(failure.stepId !== undefined ? { stepId: failure.stepId } : {}),
    ...(failure.stepName !== undefined ? { stepName: failure.stepName } : {}),
    code: failure.code,
    expected: failure.expected,
    observed: failure.observed,
    message: failure.message,
    evidence: failure.evidence,
  };
}

type FailureResolution =
  | { kind: 'hard_failure'; result: HardFailureResult }
  | {
      kind: 'resume';
      resumeFrom: 'current_step' | 'next_step' | 'abort';
      resumeAtStepId?: string;
      interventionId: string;
      reason: string;
      /** The failing step counted as irreversible on the page as it was when control was handed over. */
      stepIrreversible: boolean;
    };

/** Where a failure happened, for the code that decides how a resolution resumes. */
interface FailureSite {
  /** The failing step's index; `steps.length` for the final success check, which has no step. */
  index: number;
  step?: Step;
  /** Ids of the steps this run has completed so far. */
  completed: ReadonlySet<string>;
}

/**
 * Decides whether a StepFailure escalates and, if so, drives the handler to a resolution. Shared
 * by the step loop and the final success check: on a success-condition failure, both
 * `current_step` and `next_step` mean re-check the success condition (unless a resume point
 * applies). `reasonCode` is set only when re-asking after a refused resume point.
 */
async function resolveFailure(
  s: RunState,
  opts: ReplayOptions,
  failure: StepFailure,
  site: FailureSite,
  escalateOn: readonly FailureCode[],
  maxEscalations: number,
  counters: { escalationsUsed: number },
  reasonCode?: 'policy_block',
): Promise<FailureResolution> {
  const hasHandler = opts.escalate !== undefined;
  const willEscalate =
    counters.escalationsUsed < maxEscalations && shouldEscalate({ onFailure: site.step?.onFailure, code: failure.code, escalateOn, hasHandler });

  if (!willEscalate) {
    return { kind: 'hard_failure', result: toHardFailureResult(s, failure) };
  }
  counters.escalationsUsed += 1;

  // Everything that reads the surface must complete before the handler is awaited: no surface
  // calls of any kind are allowed once control has passed to the human. That is this check (what
  // the policy guard makes of the failing step on the page as automation left it, in case the
  // human completes the step by hand) and buildEscalationRequest's own screenshot/currentUrl.
  const stepIrreversible = site.step !== undefined && (await countsAsIrreversible(s, site.step, false));
  const retryResume = retryResumeHint(s, failure, site);
  const req = await buildEscalationRequest({
    runId: s.runId,
    capabilityId: s.capability.id,
    failure,
    surface: s.surface,
    scrubber: s.scrubber,
    ...(reasonCode !== undefined ? { reasonCode } : {}),
    ...(retryResume !== undefined ? { context: { retryResume } } : {}),
  });
  s.logger.event({ kind: 'escalation', stepId: failure.stepId, data: { phase: 'raised', reason: req.reason.message, code: failure.code } });

  const t0 = s.clock.now();
  let resolution: EscalationResolution;
  try {
    // opts.escalate is defined here: shouldEscalate returned true only when hasHandler is true.
    resolution = await opts.escalate!(req);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      kind: 'hard_failure',
      result: toHardFailureResult(s, { ...failure, code: 'internal', expected: 'the escalation handler to resolve', observed: message, message }),
    };
  }
  // Time spent waiting on a human is excluded from the automation budget.
  s.deadline += s.clock.now() - t0;

  s.logger.event({
    kind: 'escalation',
    stepId: failure.stepId,
    data: {
      phase: 'resolved',
      interventionId: resolution.interventionId,
      resumeFrom: resolution.resumeFrom,
      ...(resolution.resumeAtStepId !== undefined ? { resumeAtStepId: resolution.resumeAtStepId } : {}),
      by: resolution.by,
      ...(resolution.notes !== undefined ? { notes: resolution.notes } : {}),
      humanActions: resolution.humanActions.length,
    },
  });
  for (const action of resolution.humanActions) {
    s.logger.event({ kind: 'human_action', stepId: failure.stepId, data: { ...action } });
  }

  return {
    kind: 'resume',
    resumeFrom: resolution.resumeFrom,
    // A resume point only means something with current_step: abort ends the run whatever else the
    // resolution says, and next_step already says the human did the failing step.
    ...(resolution.resumeAtStepId !== undefined && resolution.resumeFrom === 'current_step' ? { resumeAtStepId: resolution.resumeAtStepId } : {}),
    interventionId: resolution.interventionId,
    reason: failure.message,
    stepIrreversible,
  };
}

/**
 * Where a `current_step` hand-back that names no resume point resumes when the failure being
 * resolved is a lost session: the first step after the sign-in (rewind.ts, `stepAfterSignIn`).
 * Undefined for any other failure, and for a capability with no sign-in or nothing after it: the
 * hand-back then means what it always did, run the failing step again.
 */
function defaultResumeStep(s: RunState, failure: StepFailure): Step | undefined {
  return failure.code === 'session_expired' ? stepAfterSignIn(s.capability) : undefined;
}

/**
 * What a plain `current_step` does when the engine's own default resume point is refused. The
 * default is an upgrade that applies only where it is safe; where it is not, the hand-back means
 * what it literally says and always did: run the failing step again, alone (for the success
 * check, check again). The one case with nothing left to do is a failing step whose own
 * irreversible action was already dispatched: it may have happened, so it is never sent again.
 */
function retryAfterRefusedDefault(s: RunState, site: FailureSite): 'failing_step' | 'success_check' | undefined {
  if (site.step === undefined) return 'success_check';
  return s.irreversibleRan!.has(site.step.id) ? undefined : 'failing_step';
}

/** A step as the operator console names it: id and name, nothing else. */
interface StepRef {
  stepId: string;
  stepName: string;
}

const stepRef = (st: Step): StepRef => ({ stepId: st.id, stepName: st.name });

/** `context.retryResume` of an escalation request; see {@link retryResumeHint}. */
interface RetryResumeHint extends StepRef {
  /** The resume is accepted: completed steps that are not `read` and will run again. */
  repeats?: StepRef[];
  /** The resume would be refused: why. */
  refused?: string;
  /** With `refused`: the step that already ran and cannot be repeated. */
  blockedBy?: StepRef;
  /** With `refused`: what a retry runs instead. Absent: nothing, the retry is refused and re-asked. */
  retryRuns?: 'failing_step' | 'success_check';
}

/**
 * What the operator console needs to say truthfully what "retry this step" will do after a lost
 * session, worked out when the escalation is raised (nothing it depends on changes while a human
 * holds control). The step the run will resume at, with the already-completed steps that are not
 * `read` and will therefore run a second time. Or, when replay would refuse that resume point (a
 * step in between already had its irreversible action dispatched), why, which step is in the way,
 * and what a retry does instead. Step ids and names only. Undefined when a retry re-runs the
 * failing step, as it does for every other failure.
 */
function retryResumeHint(s: RunState, failure: StepFailure, site: FailureSite): RetryResumeHint | undefined {
  const step = defaultResumeStep(s, failure);
  if (step === undefined) return undefined;
  const steps = s.capability.steps;
  const verdict = checkResumeAt(steps, step.id, site.index, s.irreversibleRan!);
  if (verdict.ok) {
    const repeats = steps.slice(verdict.index, site.index).filter((st) => st.risk !== 'read' && site.completed.has(st.id)).map(stepRef);
    return { ...stepRef(step), ...(repeats.length > 0 ? { repeats } : {}) };
  }
  const blocking = 'stepId' in verdict ? steps.find((st) => st.id === verdict.stepId) : undefined;
  const retryRuns = retryAfterRefusedDefault(s, site);
  return {
    ...stepRef(step),
    refused: describeResumeRefusal(verdict),
    ...(blocking !== undefined ? { blockedBy: stepRef(blocking) } : {}),
    ...(retryRuns !== undefined ? { retryRuns } : {}),
  };
}

/** The step a resolution resumes at, when not the failing one, and whether the engine chose it. */
interface ResumePoint {
  stepId: string;
  /** True when the resolution named none and the engine defaulted it (a lost session). */
  defaulted: boolean;
}

/** `failure` is the failure being resolved (never a refused-resume re-ask built on it). */
function resumePointOf(s: RunState, decision: Extract<FailureResolution, { kind: 'resume' }>, failure: StepFailure): ResumePoint | undefined {
  if (decision.resumeFrom !== 'current_step') return undefined;
  if (decision.resumeAtStepId !== undefined) return { stepId: decision.resumeAtStepId, defaulted: false };
  const step = defaultResumeStep(s, failure);
  return step === undefined ? undefined : { stepId: step.id, defaulted: true };
}

type ResumeAtResult =
  | { kind: 'resume'; index: number }
  | { kind: 'refused'; outcome: StepOutcome }
  /** The engine's own default was refused: carry on as a plain `current_step`. */
  | { kind: 'failing_step_only' };

/**
 * Honours or refuses a resume point (rewind.ts has the rule): the one a resolution named, or the
 * engine's default after a lost session. Accepted: the run state is reset for it and the caller
 * continues the step loop at `index`. A NAMED point that is refused: the same failure comes back
 * with the refusal as its message, for the caller to escalate again (`policy_block`), never a
 * silent fallback to re-running the failing step. The engine's own DEFAULT that is refused: the
 * hand-back was a plain `current_step`, so the failing step alone is run again
 * ({@link retryAfterRefusedDefault}), unless that step's own irreversible action was already
 * dispatched, which is refused and re-asked like a named point.
 */
function resumeAt(s: RunState, point: ResumePoint, site: FailureSite, failure: StepFailure): ResumeAtResult {
  const failingIndex = site.index;
  const verdict = checkResumeAt(s.capability.steps, point.stepId, failingIndex, s.irreversibleRan!);
  const defaulted = point.defaulted ? { defaulted: true } : {};
  if (verdict.ok) {
    // `failure` is the failure being resolved (never a refused-resume re-ask built on it).
    const { clearedOutputs, recoveryBudgetsReset } = resetForResume(s, verdict.index, { afterSessionLoss: failure.code === 'session_expired' });
    s.logger.event({
      kind: 'escalation',
      stepId: failure.stepId,
      data: {
        phase: 'resume_at',
        to: point.stepId,
        ...defaulted,
        ...(clearedOutputs.length > 0 ? { clearedOutputs } : {}),
        ...(recoveryBudgetsReset ? { recoveryBudgetsReset } : {}),
      },
    });
    return { kind: 'resume', index: verdict.index };
  }
  const why = describeResumeRefusal(verdict);
  // The engine's own default that is refused falls back to the plain current_step, when it can.
  const rerun = point.defaulted ? retryAfterRefusedDefault(s, site) : undefined;
  s.logger.event({
    kind: 'escalation',
    stepId: failure.stepId,
    data: {
      phase: 'resume_at_refused',
      to: verdict.target,
      reason: verdict.reason,
      ...('stepId' in verdict ? { blockingStepId: verdict.stepId } : {}),
      ...defaulted,
      // What runs instead: the failing step alone, or the success check again.
      ...(rerun !== undefined ? { rerun } : {}),
    },
  });
  if (rerun !== undefined) return { kind: 'failing_step_only' };
  // A human reads the defaulted refusal: they asked for a retry, not for a resume point. It is
  // only reached when the failing step's own irreversible action was already dispatched.
  const message = point.defaulted
    ? `replay cannot retry after the lost session: ${why}; and step "${site.step?.id ?? ''}" itself already had its irreversible action carried out in this run (by automation or by hand), so it is not sent again either. ` +
      `If it went through and the page is where the next step expects it, hand back "next step"; otherwise abort the run. ` +
      `The failure being resolved: ${failure.message}`
    : `replay refused the resume point it was handed (${why}); hand back another way to resume, or abort. The failure being resolved: ${failure.message}`;
  return {
    kind: 'refused',
    outcome: {
      kind: 'failure',
      failure: {
        ...failure,
        expected: 'a resume point that names a step of this capability and neither repeats nor skips an irreversible step',
        observed: why,
        message,
      },
    },
  };
}

/** One run's app-error retry budget and what it has done with it. */
interface AppErrorRetryState {
  /** The capability is `readOnly`, or the run was asserted read-only: without it nothing retries. */
  readOnly: boolean;
  max: number;
  backoffMs: number;
  used: number;
  /**
   * What the latest retry is trying to get back to: the `app_error` it answered, the index that
   * failure was seen at (`steps.length` = the success check; always that failure's own index, so
   * the two cannot describe different steps), and the step it restarted at. Cleared as soon as it
   * no longer describes the run: a step at or past that index completes, or a human resolves an
   * escalation (from then on a failure is reported as what it is).
   */
  origin?: { failure: StepFailure; index: number; restartedAt: string };
}

/**
 * A caller-supplied count or duration clamped to a non-negative finite integer: a negative value
 * is 0, a fraction is rounded down, and an absent, NaN or infinite one is `fallback`.
 */
function nonNegativeInt(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

/**
 * The bounded recovery from a transient `app_error` on a read-only run: wait, then restart the
 * steps from one that can run from any page (rewind.ts, `appErrorRetryIndex`). Returns the step
 * index to continue at, or undefined when the failure goes on to be resolved as before: it is not
 * an `app_error` read from the page (an error page; a control the surface found but could not
 * operate is also `app_error`, and is not transient), nothing asserts the run read-only (replay
 * cannot tell a harmless repeat from a repeated write), the budget is spent, the time budget
 * cannot cover the wait, or the restart would repeat a step whose irreversible action was
 * dispatched. Each retry is a `recovery` event and an entry in `result.recoveries` under
 * {@link APP_ERROR_RETRY}; a retry that was possible in principle but not taken is a `recovery`
 * event with `skipped: true` and no entry.
 */
async function retryAppError(s: RunState, retry: AppErrorRetryState, failure: StepFailure, failingIndex: number): Promise<number | undefined> {
  if (failure.code !== 'app_error' || failure.matchedSignal === undefined || !retry.readOnly || retry.max <= 0) return undefined;
  const skip = (reason: string): undefined => {
    s.logger.event({ kind: 'recovery', stepId: failure.stepId, data: { rule: APP_ERROR_RETRY, skipped: true, reason } });
    return undefined;
  };
  if (retry.used >= retry.max) return skip(`the retry budget is spent (${retry.used} of ${retry.max})`);

  const index = appErrorRetryIndex(s.capability, failingIndex);
  if (index === undefined) return skip('the capability has no navigation step to restart from: its first step is not a navigate, and only a navigation can run from an error page');
  const target = s.capability.steps[index]!;
  const verdict = checkResumeAt(s.capability.steps, target.id, failingIndex, s.irreversibleRan!);
  if (!verdict.ok) return skip(describeResumeRefusal(verdict));

  const attempt = retry.used + 1;
  const backoffMs = retry.backoffMs * attempt;
  if (s.clock.now() + backoffMs >= s.deadline) return skip('not enough of the run\'s time budget (maxDurationMs) is left to wait and retry');

  retry.used = attempt;
  await s.clock.sleep(backoffMs);
  // Restarting before the end of the sign-in signs in again: a new session, which shows its
  // once-per-session interstitials again, so the recovery-rule budgets start over with it.
  const signsInAgain = index < (indexAfterSignIn(s.capability) ?? 0);
  const { clearedOutputs, recoveryBudgetsReset } = resetForResume(s, index, { afterSessionLoss: signsInAgain });
  s.recoveries.push(APP_ERROR_RETRY);
  s.logger.event({
    kind: 'recovery',
    stepId: failure.stepId,
    data: {
      rule: APP_ERROR_RETRY,
      attempt,
      of: retry.max,
      backoffMs,
      restartAt: target.id,
      ...(clearedOutputs.length > 0 ? { clearedOutputs } : {}),
      ...(recoveryBudgetsReset ? { recoveryBudgetsReset } : {}),
    },
  });
  retry.origin = { failure, index: failingIndex, restartedAt: target.id };
  return index;
}

/** Failure codes that, before the step the app error was seen at, mean the restarted run could not get back there. */
const RETRY_UNREACHED_CODES: readonly FailureCode[] = ['element_not_found', 'precondition_failed', 'checkpoint_failed', 'timeout', 'navigation_failed'];

/**
 * The hard failure a run reports after an app-error retry. When the restarted run fails before it
 * is back at the step the app error was seen at, with a code that says a step could not run, the
 * restart point was not reachable from the error page after all. The run then reports the app
 * error it was retrying (its step, evidence and code), with the retry's own failure in the
 * message, not a failure the retry itself produced. Anything else is reported as it is, and so is
 * every failure once the origin is cleared (see {@link AppErrorRetryState.origin}).
 */
function hardFailureAfterRetry(s: RunState, retry: AppErrorRetryState, result: HardFailureResult, failingIndex: number): HardFailureResult {
  const origin = retry.origin;
  if (origin === undefined || failingIndex >= origin.index || !RETRY_UNREACHED_CODES.includes(result.code)) return result;
  const where = result.stepId !== undefined ? ` at step "${result.stepId}"` : '';
  return toHardFailureResult(s, {
    ...origin.failure,
    message:
      `${origin.failure.message}; ${APP_ERROR_RETRY} restarted the run at step "${origin.restartedAt}" ` +
      `but it could not get back to the failing step (${result.code}${where}: ${result.message})`,
  });
}

async function checkSuccessCondition(s: RunState, stepTimeoutMs: number): Promise<StepOutcome> {
  const ctx: ReplayBindContext = { baseUrl: s.baseUrl, inputs: s.inputs, inputSpecs: s.capability.inputs, secret: s.secret, scrubber: s.scrubber };
  let condition: Condition;
  try {
    condition = bindConditionForReplay(s.capability.success.condition, ctx);
  } catch (err) {
    return failStep(s, undefined, bindErrorSignal(err));
  }
  const timeoutMs = Math.max(1, Math.min(stepTimeoutMs, s.deadline - s.clock.now()));
  const held = await s.surface.waitFor(condition, timeoutMs, { recorded: s.capability.success.condition });
  if (held) return { kind: 'ok' };
  return failStep(s, undefined, {
    code: 'checkpoint_failed',
    expected: `success condition met: ${s.capability.success.description}`,
    observed: 'success condition not met',
    message: `success condition not met: ${s.capability.success.description}`,
  });
}

/**
 * Executes `opts.capability` against `opts.surface` and returns exactly one `ReplayResult`.
 * Never throws: any internal error is captured as a `hard_failure` result instead. Calls
 * `opts.logger.finish()` exactly once, on every path, before returning.
 */
export async function replayCapability(opts: ReplayOptions): Promise<ReplayResult> {
  const clock: ReplayClock = opts.clock ?? { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };
  const startedAt = clock.now();
  const scrubber = createValueScrubber([], { minLength: SCRUB_MIN_LENGTH });
  const log = createSafeLogger(opts.logger, scrubber);
  const runId = opts.logger.runId;

  const sessionExpiredSignals = opts.sessionExpiredSignals ?? DEFAULT_SESSION_EXPIRED_SIGNALS;
  const appErrorSignals = opts.appErrorSignals ?? DEFAULT_APP_ERROR_SIGNALS;
  const escalateOn = opts.escalateOn ?? DEFAULT_ESCALATE_ON;
  const maxEscalations = opts.maxEscalations ?? DEFAULT_MAX_ESCALATIONS;
  const stepTimeoutMs = opts.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT;
  const maxDurationMs = opts.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
  const replayRequiresApproved = opts.replayRequiresApproved ?? true;
  // Clamped here, not trusted: a NaN or infinite budget would leave the deadline as the only bound.
  const maxAppErrorRetries = nonNegativeInt(opts.maxAppErrorRetries, DEFAULT_MAX_APP_ERROR_RETRIES);
  const appErrorRetryBackoffMs = nonNegativeInt(opts.appErrorRetryBackoffMs, DEFAULT_APP_ERROR_RETRY_BACKOFF_MS);

  /** Only for the outer catch's fallback result -- a snapshot of the run once it exists. Never
   *  read from inside `run()` itself; `run()` always works off its own local `const s`. */
  let stateForError: RunState | undefined;
  /** Output (and outcome return) names the capability marks sensitive, per outcome ('' = outputs). */
  let sensitiveOutputs: SensitiveOutputNames = { outputs: new Set(), returns: new Map() };
  /** Outputs this run read from masked content (see RunState.maskedOutputs): redacted like flagged ones. */
  const runtimeMasked = new Set<string>();
  const redactionNames = (): SensitiveOutputNames => ({
    outputs: new Set([...sensitiveOutputs.outputs, ...runtimeMasked]),
    returns: new Map([...sensitiveOutputs.returns].map(([k, v]) => [k, new Set([...v, ...runtimeMasked])])),
  });
  /** The validated capability's content digest (schema/digest.ts), stamped on every result once
   *  known, so `cu approve` can tell which content a replay actually ran. Taken before any tenant
   *  override is applied: approval is of the artifact, not of one tenant's view of it. */
  let digest: string | undefined;

  function hardFailureNoState(idVer: { capabilityId: string; capabilityVersion: string }, args: { code: FailureCode; expected: string; observed: string; message: string }): ReplayResult {
    return {
      runId,
      capabilityId: idVer.capabilityId,
      capabilityVersion: idVer.capabilityVersion,
      stepsExecuted: 0,
      durationMs: Math.max(0, clock.now() - startedAt),
      locatorReport: [],
      recoveries: [],
      kind: 'hard_failure',
      code: args.code,
      expected: args.expected,
      observed: args.observed,
      message: args.message,
      evidence: {},
    };
  }

  async function run(): Promise<ReplayResult> {
    const firstParse = validateCapability(opts.capability);
    if (!firstParse.ok) {
      return hardFailureNoState(rawIdVersion(opts.capability), {
        code: 'internal',
        expected: 'a capability that passes validateCapability',
        observed: issuesToObserved(firstParse.issues),
        message: 'capability failed validateCapability',
      });
    }

    let capability: Capability = firstParse.capability;
    digest = capabilityDigest(firstParse.capability);
    sensitiveOutputs = sensitiveOutputNames(capability);

    // A deprecated capability is retired: it never runs, whatever `replayRequiresApproved` says.
    if (capability.status === 'deprecated') {
      log.event({ kind: 'policy', data: { gate: 'status', decision: 'deny', status: capability.status } });
      return hardFailureNoState(
        { capabilityId: capability.id, capabilityVersion: capability.version },
        {
          code: 'policy_violation',
          expected: 'a capability whose status is "draft" or "approved"',
          observed: 'capability status is "deprecated"',
          message: `capability ${capability.id}@${capability.version} is deprecated and cannot be replayed; use a current version`,
        },
      );
    }

    // A run asserted read-only may re-run steps on its own (the app-error retry), so the assertion
    // is held to the rule the validator holds the artifact's own `readOnly: true` to
    // (`read_only_irreversible`): refused on anything irreversible, before any surface call. The
    // capability itself is left as it is; the digest above is of the artifact.
    if (opts.readOnly === true && capability.readOnly !== true) {
      const declared = validateCapability({ ...capability, readOnly: true });
      if (!declared.ok) {
        log.event({ kind: 'policy', data: { gate: 'read_only', decision: 'deny' } });
        return hardFailureNoState(
          { capabilityId: capability.id, capabilityVersion: capability.version },
          {
            code: 'policy_violation',
            expected: 'a capability with nothing irreversible, for a run asserted read-only',
            observed: issuesToObserved(declared.issues),
            message: 'this run was asserted read-only, but the capability has irreversible effects; a read-only run may re-run steps on its own, so the assertion is refused',
          },
        );
      }
    }
    const readOnly = capability.readOnly === true || opts.readOnly === true;

    const { capability: overridden, applied } = applyTenantOverride(capability, opts.tenant);
    capability = overridden;
    if (applied) {
      log.event({ kind: 'observation', data: { override: applied } });
      const reParse = validateCapability(capability);
      if (!reParse.ok) {
        return hardFailureNoState(
          { capabilityId: capability.id, capabilityVersion: capability.version },
          {
            code: 'internal',
            expected: 'a capability that passes validateCapability after the tenant override is applied',
            observed: issuesToObserved(reParse.issues),
            message: 'capability failed validateCapability after applying tenant override',
          },
        );
      }
      capability = reParse.capability;
    }

    const inputResult = validateInputs(capability.inputs, opts.inputs);
    if (!inputResult.ok) {
      const spec = capability.inputs[inputResult.input];
      return hardFailureNoState(
        { capabilityId: capability.id, capabilityVersion: capability.version },
        {
          code: 'input_validation',
          expected: spec ? describeInputSpec(inputResult.input, spec) : `a declared input named "${inputResult.input}"`,
          observed: inputResult.problem,
          message: `input "${inputResult.input}": ${inputResult.problem}`,
        },
      );
    }

    // Every sensitive input's value is registered with the scrubber up front, regardless of
    // which steps actually use it -- bind.ts only additionally covers secret-env bindings, which
    // are not capability inputs at all and so cannot be registered here.
    for (const [name, spec] of Object.entries(capability.inputs)) {
      if (spec.sensitive) {
        const value = inputResult.values[name];
        if (value !== undefined) scrubber.add(String(value));
      }
    }

    const irreversibleAllowed = capability.status === 'approved' || !replayRequiresApproved;
    const hasUnapprovedIrreversible = !irreversibleAllowed && capability.steps.some((step) => step.risk === 'irreversible');
    if (hasUnapprovedIrreversible) {
      // Before ANY surface call: a draft capability never gets to touch the surface just to be
      // told no.
      log.event({ kind: 'policy', data: { gate: 'approval', decision: 'deny' } });
      return hardFailureNoState(
        { capabilityId: capability.id, capabilityVersion: capability.version },
        {
          code: 'policy_violation',
          expected: 'an approved capability before any irreversible step runs in replay (or replayRequiresApproved: false)',
          observed: `capability status is "${capability.status}"`,
          message: 'this capability contains an irreversible step; only an approved capability may run irreversible steps in replay',
        },
      );
    }

    const s: RunState = {
      runId,
      capability,
      inputs: inputResult.values,
      surface: opts.surface,
      logger: log,
      scrubber,
      clock,
      baseUrl: opts.baseUrl,
      policy: opts.policy,
      irreversibleAllowed,
      stepTimeoutMs,
      startedAt,
      deadline: startedAt + maxDurationMs,
      // A null-prototype object: a capability's declared output name is an Identifier and can
      // legally be "__proto__" (see checkOutcomes's `data` in steps.ts for the same reasoning),
      // so a plain `{}` here would silently drop that output on extraction instead of recording it.
      outputs: Object.create(null) as RunState['outputs'],
      maskedOutputs: runtimeMasked,
      locatorReport: [],
      recoveries: [],
      recoveryAttempts: new Map(),
      stepsExecuted: 0,
      lastCompletedStepId: undefined,
      irreversibleRan: new Set(),
      secret: opts.secret,
      sessionExpiredSignals,
      appErrorSignals,
      ...(opts.beforeStep !== undefined ? { beforeStep: opts.beforeStep } : {}),
      ...(opts.beforeStepTimeoutMs !== undefined ? { beforeStepTimeoutMs: opts.beforeStepTimeoutMs } : {}),
    };
    stateForError = s;

    log.event({
      kind: 'observation',
      data: { capabilityId: capability.id, version: capability.version, tenant: opts.tenant, steps: capability.steps.length, inputs: Object.keys(capability.inputs) },
    });

    const counters = { escalationsUsed: 0 };
    const retry: AppErrorRetryState = { readOnly, max: maxAppErrorRetries, backoffMs: appErrorRetryBackoffMs, used: 0 };
    let anyEscalation = false;
    let abandoned = false;
    let lastIntervention: { id: string; stepId?: string; reason: string } | undefined;
    let underlying: ReplayResult | undefined;

    // A resume point (rewind.ts) can send the run back into the step loop from the step loop itself
    // or from the final success check, hence the outer loop. It cannot spin: a resume point comes
    // from a resolution, and every resolution costs one of maxEscalations, or from an app-error
    // retry, and every retry costs one of maxAppErrorRetries.
    /** Ids of the steps this run has completed: what a rewind would run a second time. */
    const completed = new Set<string>();
    let i = 0;
    run: for (;;) {
      steps: while (i < capability.steps.length) {
        const step = capability.steps[i]!;
        const site: FailureSite = { index: i, step, completed };
        let outcome = await runStep(s, step);
        // The failure being resolved, kept apart from a refused-resume re-ask built on top of it.
        let resolving: StepFailure | undefined;
        let reasonCode: 'policy_block' | undefined;

        while (outcome.kind === 'failure') {
          // A transient app error on a read-only run is retried before anyone is asked. Never while
          // re-asking after a refused resume point: that question is still open.
          if (reasonCode === undefined) {
            const restartAt = await retryAppError(s, retry, outcome.failure, i);
            if (restartAt !== undefined) {
              i = restartAt;
              continue steps;
            }
          }
          const decision = await resolveFailure(s, opts, outcome.failure, site, escalateOn, maxEscalations, counters, reasonCode);
          reasonCode = undefined;
          if (decision.kind === 'hard_failure') {
            underlying = hardFailureAfterRetry(s, retry, decision.result, i);
            break run;
          }
          anyEscalation = true;
          // A human has stepped in: what fails from here on is no longer "the retry could not get back".
          retry.origin = undefined;
          lastIntervention = { id: decision.interventionId, stepId: outcome.failure.stepId, reason: decision.reason };
          if (decision.resumeFrom === 'abort') {
            underlying = toHardFailureResult(s, outcome.failure);
            abandoned = true;
            break run;
          }
          const point = resumePointOf(s, decision, resolving ?? outcome.failure);
          if (point !== undefined) {
            resolving ??= outcome.failure;
            const resumed = resumeAt(s, point, site, resolving);
            if (resumed.kind === 'resume') {
              i = resumed.index;
              continue steps;
            }
            if (resumed.kind === 'refused') {
              outcome = resumed.outcome;
              reasonCode = 'policy_block';
              continue;
            }
            // failing_step_only: the plain current_step below.
          }
          // A human who hands back next_step says they carried the step out. If its action counts
          // as irreversible (declared, or flagged by the policy guard, before or after they acted),
          // it must never be dispatched again by a later rewind, exactly as if automation had sent it.
          if (decision.resumeFrom === 'next_step' && (decision.stepIrreversible || (await countsAsIrreversible(s, step, true)))) {
            if (step.risk !== 'irreversible') {
              s.logger.event({ kind: 'policy', stepId: step.id, data: { gate: 'next_step', decision: 'flag_irreversible', reason: 'completed by a human; the policy flags its action irreversible, so no rewind will run it again' } });
            }
            s.irreversibleRan!.add(step.id);
          }
          resolving = undefined;
          outcome = decision.resumeFrom === 'current_step' ? await runStep(s, step) : await verifyPostcondition(s, step);
        }

        if (outcome.kind === 'business_outcome') {
          underlying = toBusinessOutcomeResult(s, outcome);
          break run;
        }
        if (step.risk === 'irreversible') s.irreversibleRan!.add(step.id);
        completed.add(step.id);
        // The run is at or past the step the latest app-error retry was trying to get back to.
        if (retry.origin !== undefined && i >= retry.origin.index) retry.origin = undefined;
        i += 1;
      }

      let outcome = await checkSuccessCondition(s, stepTimeoutMs);
      let resolving: StepFailure | undefined;
      let reasonCode: 'policy_block' | undefined;
      // The success check has no step: every step lies before it, so its index is steps.length and
      // any resume point or retry from here is a rewind.
      const successIndex = capability.steps.length;
      const site: FailureSite = { index: successIndex, completed };
      while (outcome.kind === 'failure') {
        if (reasonCode === undefined) {
          const restartAt = await retryAppError(s, retry, outcome.failure, successIndex);
          if (restartAt !== undefined) {
            i = restartAt;
            continue run;
          }
        }
        const decision = await resolveFailure(s, opts, outcome.failure, site, escalateOn, maxEscalations, counters, reasonCode);
        reasonCode = undefined;
        if (decision.kind === 'hard_failure') {
          underlying = hardFailureAfterRetry(s, retry, decision.result, successIndex);
          break run;
        }
        anyEscalation = true;
        retry.origin = undefined;
        lastIntervention = { id: decision.interventionId, stepId: outcome.failure.stepId, reason: decision.reason };
        if (decision.resumeFrom === 'abort') {
          underlying = toHardFailureResult(s, outcome.failure);
          abandoned = true;
          break run;
        }
        const point = resumePointOf(s, decision, resolving ?? outcome.failure);
        if (point !== undefined) {
          resolving ??= outcome.failure;
          const resumed = resumeAt(s, point, site, resolving);
          if (resumed.kind === 'resume') {
            i = resumed.index;
            continue run;
          }
          if (resumed.kind === 'refused') {
            outcome = resumed.outcome;
            reasonCode = 'policy_block';
            continue;
          }
          // failing_step_only: for the success check, check again (below).
        }
        resolving = undefined;
        // With no resume point, current_step / next_step on a success failure both mean: re-check
        // the success condition.
        outcome = await checkSuccessCondition(s, stepTimeoutMs);
      }

      if (outcome.kind === 'business_outcome') {
        underlying = toBusinessOutcomeResult(s, outcome);
      } else {
        const missing = Object.keys(capability.outputs).find((k) => !(k in s.outputs));
        if (missing !== undefined) {
          const missingOutcome = await failStep(s, undefined, {
            code: 'checkpoint_failed',
            expected: 'every declared output extracted',
            observed: `outputs extracted so far: ${Object.keys(s.outputs).join(', ') || '(none)'}`,
            message: `declared output "${missing}" was never extracted`,
          });
          underlying =
            missingOutcome.kind === 'business_outcome'
              ? toBusinessOutcomeResult(s, missingOutcome)
              : toHardFailureResult(s, (missingOutcome as Extract<StepOutcome, { kind: 'failure' }>).failure);
        } else {
          underlying = { ...toBase(s), kind: 'success', outputs: s.outputs };
        }
      }
      break run;
    }

    if (underlying === undefined) throw new Error('unreachable: the run loop ended without a result');
    if (anyEscalation) {
      log.event({ kind: 'outcome', data: { underlying: redactSensitiveOutputs(underlying, redactionNames()) } });
      const resolution = abandoned ? 'abandoned' : underlying.kind === 'hard_failure' ? 'resumed_failed' : 'resumed_success';
      return {
        ...toBase(s),
        kind: 'escalated',
        interventionId: lastIntervention!.id,
        ...(lastIntervention!.stepId !== undefined ? { stepId: lastIntervention!.stepId } : {}),
        reason: lastIntervention!.reason,
        resolution,
        outcome: toEscalatedOutcome(underlying),
      };
    }
    return underlying;
  }

  let result: ReplayResult;
  try {
    result = await run();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const idVer = stateForError
      ? { capabilityId: stateForError.capability.id, capabilityVersion: stateForError.capability.version }
      : rawIdVersion(opts.capability);
    result = {
      runId,
      ...idVer,
      stepsExecuted: stateForError?.stepsExecuted ?? 0,
      durationMs: Math.max(0, clock.now() - startedAt),
      locatorReport: stateForError?.locatorReport ?? [],
      recoveries: stateForError?.recoveries ?? [],
      kind: 'hard_failure',
      code: 'internal',
      expected: 'replay to complete without throwing',
      observed: message,
      message,
      evidence: {},
    };
  }

  if (digest !== undefined && result.capabilityDigest === undefined) result = { ...result, capabilityDigest: digest };

  // Exactly once, on every path: success, failure, or a throw. If finish() itself rejects the
  // result (schema drift), persist a minimal internal failure so the run still has a result.json,
  // and return that instead of throwing at the caller.
  try {
    log.finish(redactSensitiveOutputs(result, redactionNames()));
  } catch (err) {
    const message = `result rejected by the run logger: ${err instanceof Error ? err.message : String(err)}`;
    result = {
      runId,
      capabilityId: 'unknown',
      capabilityVersion: '0.0.0',
      stepsExecuted: 0,
      durationMs: Math.max(0, clock.now() - startedAt),
      locatorReport: [],
      recoveries: [],
      kind: 'hard_failure',
      code: 'internal',
      expected: 'a result that satisfies the ReplayResult schema',
      observed: message.slice(0, 2000),
      message: message.slice(0, 2000),
      evidence: {},
    };
    log.finish(result);
  }
  return scrubForCaller(result, scrubber);
}

/** Which outputs, and which returns of which business outcome, a capability declares sensitive. */
interface SensitiveOutputNames {
  outputs: ReadonlySet<string>;
  returns: ReadonlyMap<string, ReadonlySet<string>>;
}

function sensitiveOutputNames(capability: Capability): SensitiveOutputNames {
  const pick = (specs: Record<string, { sensitive?: boolean | undefined }>): Set<string> =>
    new Set(Object.entries(specs).filter(([, spec]) => spec.sensitive === true).map(([name]) => name));
  return {
    outputs: pick(capability.outputs),
    returns: new Map(capability.businessOutcomes.map((o) => [o.name, pick(o.returns)])),
  };
}

function redactNamed<T extends Record<string, unknown>>(values: T, names: ReadonlySet<string> | undefined): T {
  if (names === undefined || names.size === 0) return values;
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [k, v] of Object.entries(values)) out[k] = names.has(k) ? REDACTED_VALUE : v;
  return out as T;
}

/**
 * `result` with every sensitive output (OutputSpec.sensitive) and sensitive business-outcome return
 * replaced by `[REDACTED]`: what evidence (result.json, the outcome event) gets. Numbers need this
 * by name: the value scrubber matches strings, and a short value is below its minimum length.
 */
function redactSensitiveOutputs(result: ReplayResult, names: SensitiveOutputNames): ReplayResult {
  switch (result.kind) {
    case 'success':
      return { ...result, outputs: redactNamed(result.outputs, names.outputs) };
    case 'business_outcome':
      return { ...result, data: redactNamed(result.data, names.returns.get(result.name)) };
    case 'escalated': {
      const o = result.outcome;
      if (o?.kind === 'success') return { ...result, outcome: { ...o, outputs: redactNamed(o.outputs, names.outputs) } };
      if (o?.kind === 'business_outcome') return { ...result, outcome: { ...o, data: redactNamed(o.data, names.returns.get(o.name)) } };
      return result;
    }
    case 'hard_failure':
      return result;
  }
}

/**
 * The returned result goes to the caller (an agent, the CLI's terminal), which is as much a sink
 * as result.json: diagnostic text (`observed` is a page-text excerpt, which can hold e.g. the
 * operator id bound from MOCK_USER) is scrubbed of every bound secret / sensitive input. The
 * caller's data (`outputs`, outcome `data`) is returned as extracted.
 */
function scrubForCaller(result: ReplayResult, scrubber: Scrubber): ReplayResult {
  const scrubbed = scrubber.deep(result);
  if (result.kind === 'success' && scrubbed.kind === 'success') return { ...scrubbed, outputs: result.outputs };
  if (result.kind === 'business_outcome' && scrubbed.kind === 'business_outcome') return { ...scrubbed, data: result.data };
  if (result.kind === 'escalated' && scrubbed.kind === 'escalated' && result.outcome && scrubbed.outcome) {
    if (result.outcome.kind === 'success') return { ...scrubbed, outcome: result.outcome };
    if (result.outcome.kind === 'business_outcome') return { ...scrubbed, outcome: result.outcome };
  }
  return scrubbed;
}

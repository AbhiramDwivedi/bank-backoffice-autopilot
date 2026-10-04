/**
 * rewind.ts -- whether replay may continue a run at another step than the failing one, where, and
 * what resuming there resets. Three things send a run to a resume point:
 *
 * - a resolution that names one (`EscalationResolution.resumeAtStepId`);
 * - a plain `current_step` resolution after a lost session, which the engine sends to the first
 *   step after the sign-in ({@link stepAfterSignIn});
 * - the retry of a transient `app_error` on a read-only run, which restarts the steps from one
 *   that can run from any page ({@link appErrorRetryIndex}).
 *
 * Why a resume point exists at all: `current_step` assumes the page-local effects of the steps
 * before the failing one survived the escalation. After a lost session they did not: a member id
 * typed into a search field went with the expired page, so re-running only the search click
 * searches for nothing. A resolution can instead say "run from step X": the first step after the
 * sign-in, so the form state is rebuilt.
 *
 * The safety rule lives here, in the engine, not in whoever handed back (the scripted relogin
 * operator or a human in Relay), because only the engine knows what this run has already done:
 *
 * - `unknown_step`: the id is not a step of the capability as this run executes it (base steps
 *   plus the applied tenant override's extra steps).
 * - `would_repeat_irreversible`: a step at or after the target has already had its irreversible
 *   action dispatched in this run (a declared `risk: 'irreversible'` step, or one the policy guard
 *   flagged irreversible at act time), or a human completed it with `next_step`. Re-running it
 *   would repeat the side effect: a second transfer. Note this is "dispatched", not "completed": an
 *   irreversible click whose postcondition then failed (the session expired on the confirmation
 *   page) may well have happened on the server, so it counts.
 * - `would_skip_irreversible`: the target lies AFTER the failing step and an irreversible step lies
 *   in between. Jumping forward over the action the capability exists to perform would let the
 *   success condition, not replay, decide whether it happened. A forward resume point is otherwise
 *   allowed: it is what lets a re-login that re-ran the whole sign-in continue after it even when
 *   the expiry hit a step in the middle of the sign-in.
 *
 * A refusal is never a silent fallback to `current_step`: replay.ts turns it into a new escalation
 * of the same failure (reason `policy_block`), so whoever handed back is asked again, within the
 * run's `maxEscalations` budget, and the run ends in a hard failure when the budget is spent.
 */
import { resolveAuth, type Capability, type Step } from '../schema/index.js';
import type { RunState } from './types.js';

/** Why a resume point was refused. `stepId` names the irreversible step that blocked it. */
export type ResumeRefusal =
  | { reason: 'unknown_step'; target: string }
  | { reason: 'would_repeat_irreversible'; target: string; stepId: string }
  | { reason: 'would_skip_irreversible'; target: string; stepId: string };

/** {@link checkResumeAt}'s verdict: the step index to continue from, or why not. */
export type ResumeVerdict = { ok: true; index: number } | ({ ok: false } & ResumeRefusal);

/** Longest resume-point id echoed back in a message or event (the id can come from a human). */
const MAX_ECHOED_ID = 100;

function echo(id: string): string {
  return id.length > MAX_ECHOED_ID ? `${id.slice(0, MAX_ECHOED_ID)}…` : id;
}

/**
 * Decides whether the run may resume at `target`. `failingIndex` is the index of the step that
 * escalated, or `steps.length` for an escalation from the final success check (which has no step).
 * `irreversibleRan` holds the ids of every step whose irreversible action this run has dispatched
 * (or that a human completed with `next_step`).
 */
export function checkResumeAt(steps: readonly Step[], target: string, failingIndex: number, irreversibleRan: ReadonlySet<string>): ResumeVerdict {
  const index = steps.findIndex((st) => st.id === target);
  if (index < 0) return { ok: false, reason: 'unknown_step', target: echo(target) };

  const repeated = steps.slice(index).find((st) => irreversibleRan.has(st.id));
  if (repeated !== undefined) return { ok: false, reason: 'would_repeat_irreversible', target, stepId: repeated.id };

  if (index > failingIndex) {
    const skipped = steps.slice(failingIndex, index).find((st) => st.risk === 'irreversible' || irreversibleRan.has(st.id));
    if (skipped !== undefined) return { ok: false, reason: 'would_skip_irreversible', target, stepId: skipped.id };
  }
  return { ok: true, index };
}

/** One sentence naming a refusal: step ids and the rule only, never a value. */
export function describeResumeRefusal(r: ResumeRefusal): string {
  switch (r.reason) {
    case 'unknown_step':
      return `"${r.target}" is not a step of this capability as this run executes it`;
    case 'would_repeat_irreversible':
      return `resuming at "${r.target}" would run irreversible step "${r.stepId}" again: its action has already been carried out in this run`;
    case 'would_skip_irreversible':
      return `resuming at "${r.target}" would skip irreversible step "${r.stepId}"`;
  }
}

/**
 * Index of the first step after the capability's sign-in steps (its `auth` block, or the sign-in
 * `schema/auth.ts` derives from the steps). It equals `steps.length` when nothing follows the
 * sign-in. Undefined when the capability has no sign-in.
 */
export function indexAfterSignIn(capability: Pick<Capability, 'steps' | 'auth'>): number | undefined {
  const auth = resolveAuth(capability);
  const last = auth?.steps[auth.steps.length - 1];
  if (last === undefined) return undefined;
  const index = capability.steps.findIndex((st) => st.id === last.id);
  return index < 0 ? undefined : index + 1;
}

/**
 * Where a run resumes after a lost session when the hand-back says `current_step` and names no
 * resume point: the first step after the sign-in. It is the point the scripted `relogin` operator
 * names, for the same reason (the file header): what the steps after the sign-in typed went with
 * the session, so re-running only the failing step would act on an emptied form. The rule sits in
 * the engine so that a human, whose console only offers "retry" and "I did it", gets it too.
 * Undefined, and so no default, when the capability has no sign-in or nothing follows it.
 */
export function stepAfterSignIn(capability: Pick<Capability, 'steps' | 'auth'>): Step | undefined {
  const index = indexAfterSignIn(capability);
  return index === undefined ? undefined : capability.steps[index];
}

/**
 * The step index a retry after a transient `app_error` restarts the run at, or undefined when the
 * capability has no step to restart from. An error page has replaced whatever the following steps
 * act on, so the restart point has to be a step that can run from any page, which only a
 * `navigate` is:
 *
 * - the first step after the sign-in, when that step is a `navigate` and the failure is not inside
 *   the sign-in: the session is kept and the whole business flow is rebuilt;
 * - otherwise step 0, the capability's entry step, when it is a `navigate`: the run starts over,
 *   sign-in included;
 * - otherwise nothing. A capability that does not begin with a navigation (a desktop flow that
 *   starts on a window already open) cannot be restarted from the error page, and is not retried.
 *
 * Re-running the failing step alone, or resuming at a step that needs the page the error replaced
 * (a form field), cannot work. The mock app's member search shows it: its error page replaces the
 * frame that holds the search form, so the member-id step has nothing to type into.
 * `failingIndex` is `steps.length` for a failure in the final success check.
 */
export function appErrorRetryIndex(capability: Pick<Capability, 'steps' | 'auth'>, failingIndex: number): number | undefined {
  const after = indexAfterSignIn(capability) ?? 0;
  if (failingIndex >= after && capability.steps[after]?.action.type === 'navigate') return after;
  return capability.steps[0]?.action.type === 'navigate' ? 0 : undefined;
}

/** What {@link resetForResume} reset. */
export interface ResumeReset {
  /** Outputs dropped because a step at or after the resume point extracts them again. */
  clearedOutputs: string[];
  /** True when the recovery-rule attempt counters were reset (a resume after a lost session). */
  recoveryBudgetsReset: boolean;
}

/**
 * Prepares the run state to continue at step `index`, for an ACCEPTED resume point only (a refused
 * one, and a plain `current_step`/`next_step` hand-back, never reach here and reset nothing):
 *
 * - every output an `extract` step at or after `index` produced is dropped (the re-run extracts it
 *   again; a run that never gets that far must report it missing, not return the value read
 *   before the session was lost);
 * - the step before `index` becomes the last completed one, which is what business-outcome
 *   eligibility (`afterSteps`) reads;
 * - when `afterSessionLoss` (the failure being resolved was classified `session_expired`, or an
 *   app-error retry restarts before the end of the sign-in and so signs in again), the
 *   recovery-rule attempt counters are reset. A re-login starts a new session, and a new session
 *   legitimately shows its once-per-session interstitials again (the maintenance notice); with
 *   `maxAttempts` counted per run, the third session's notice would find the budget spent and
 *   block the step. The bound survives: counters only reset on an accepted resume, every resume
 *   comes from a resolution or an app-error retry, and those are capped by `maxEscalations` and
 *   `maxAppErrorRetries`, so a rule fires at most
 *   `maxAttempts × (1 + maxEscalations + maxAppErrorRetries)` times in a run. Narrower than resetting on every
 *   resume: a rewind without a lost session (a human re-running steps in the same session) cannot
 *   bring a per-session notice back, so its budget stays spent and a rule that keeps firing there
 *   still stops at `maxAttempts`. (Resetting only the rules that fired at or after the resume
 *   point would need per-firing step tracking, and would miss the real case anyway: the new
 *   session's notice can appear on a step the previous session never showed it on.)
 *
 * `stepsExecuted`, the locator report and the `recoveries` list are left alone: they record what
 * the run did, and re-running a step is something it did again.
 */
export function resetForResume(state: RunState, index: number, opts: { afterSessionLoss: boolean }): ResumeReset {
  const clearedOutputs: string[] = [];
  for (const st of state.capability.steps.slice(index)) {
    if (st.action.type === 'extract' && Object.prototype.hasOwnProperty.call(state.outputs, st.action.output)) {
      delete state.outputs[st.action.output];
      clearedOutputs.push(st.action.output);
    }
  }
  state.lastCompletedStepId = index > 0 ? state.capability.steps[index - 1]!.id : undefined;
  if (opts.afterSessionLoss) state.recoveryAttempts.clear();
  return { clearedOutputs, recoveryBudgetsReset: opts.afterSessionLoss };
}

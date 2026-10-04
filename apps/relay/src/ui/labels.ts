/**
 * Human copy for the server's codes. Every enum the wire contract sends gets exactly one label
 * here, so a new reason or action type is a one-line addition instead of a scattered switch.
 */
import type { CapturedAction, InterventionDto, ReasonCode, Resolution, ResumeFrom, RetryResumeHint, RetryResumeStep, RunKind } from '../shared/api.js';

export const REASON_LABEL: Record<ReasonCode, string> = {
  stuck: 'Stuck',
  risky_action_confirmation: 'Needs approval',
  unrecoverable_condition: "Can't continue",
  policy_block: 'Blocked by policy',
  max_steps: 'Step limit reached',
  unexpected_dialog: 'Unexpected dialog',
};

export const ACTION_TYPE_LABEL: Record<CapturedAction['type'], string> = {
  click: 'Click',
  input: 'Input',
  keypress: 'Keypress',
  navigate: 'Navigate',
  submit: 'Submit',
};

export const RUN_KIND_LABEL: Record<RunKind, string> = {
  replay: 'Replay',
  discovery: 'Discovery',
};

/** How a finished round's outcome reads in the resolution summary (not the hand-back form's copy). */
export const RESUME_FROM_RESULT_LABEL: Record<ResumeFrom, string> = {
  current_step: 'Retry this step',
  next_step: 'The next step',
};

/** Longest step id or name shown in the hand-back copy. */
const MAX_STEP_TEXT = 120;
/** Most repeated steps listed under the retry option. */
const MAX_REPEATS = 20;

function shortText(v: unknown): string | undefined {
  if (typeof v !== 'string' || v.length === 0) return undefined;
  return v.length > MAX_STEP_TEXT ? `${v.slice(0, MAX_STEP_TEXT)}…` : v;
}

function stepRefOf(v: unknown): RetryResumeStep | undefined {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const rec = v as Record<string, unknown>;
  const stepId = shortText(rec.stepId);
  if (stepId === undefined) return undefined;
  const stepName = shortText(rec.stepName);
  return { stepId, ...(stepName !== undefined ? { stepName } : {}) };
}

/**
 * The intervention's `context.retryResume` (see `RetryResumeHint`), or undefined when automation
 * sent none or sent something else: the context is free-form, so nothing about it is assumed.
 */
export function retryResumeOf(dto: Pick<InterventionDto, 'context'>): RetryResumeHint | undefined {
  const raw = dto.context?.retryResume;
  const head = stepRefOf(raw);
  if (head === undefined) return undefined;
  const rec = raw as Record<string, unknown>;
  const refused = typeof rec.refused === 'string' && rec.refused.length > 0 ? rec.refused.slice(0, 400) : undefined;
  const blockedBy = stepRefOf(rec.blockedBy);
  const retryRuns = rec.retryRuns === 'failing_step' || rec.retryRuns === 'success_check' ? rec.retryRuns : undefined;
  const repeats = Array.isArray(rec.repeats)
    ? rec.repeats.slice(0, MAX_REPEATS).map(stepRefOf).filter((r): r is RetryResumeStep => r !== undefined)
    : [];
  return {
    ...head,
    ...(repeats.length > 0 ? { repeats } : {}),
    ...(refused !== undefined ? { refused } : {}),
    ...(blockedBy !== undefined ? { blockedBy } : {}),
    ...(retryRuns !== undefined ? { retryRuns } : {}),
  };
}

/** A step as the hand-back copy names it: `step s05 (“Enter the member ID”)`. */
export function stepLabel(ref: RetryResumeStep): string {
  return ref.stepName !== undefined ? `step ${ref.stepId} (“${ref.stepName}”)` : `step ${ref.stepId}`;
}

/** Where the escalation was raised: at a step, or at the final success check, which has none. */
export interface FailingSite {
  hasStep: boolean;
}

/**
 * The hand-back form's copy for the `current_step` choice. Normally it retries the failing step
 * (or, with no step, checks the result again). After a lost session automation resumes at the
 * first step after sign-in instead, and the label and help line say that. When automation already
 * knows it will refuse that (`refused`), the help line says up front what it does instead: re-run
 * only the failing step (or check again), because an earlier step already ran; or, when the
 * failing step itself already ran, nothing.
 */
export function retryOptionCopy(hint: RetryResumeHint | undefined, site: FailingSite = { hasStep: true }): { label: string; help?: string } {
  const plainLabel = site.hasStep ? 'Retry this step' : 'Check the result again';
  if (hint === undefined) return { label: plainLabel };
  const after = `${stepLabel(hint)}, the first step after sign-in`;
  if (hint.refused !== undefined) {
    const because = hint.blockedBy !== undefined ? `${stepLabel(hint.blockedBy)} already ran and must not run again` : hint.refused;
    if (hint.retryRuns === 'failing_step') {
      return {
        label: 'Retry only this step',
        help:
          `Automation will re-run only this step, not the steps before it. After a lost session it would normally start again at ${after}, but ${because}. ` +
          'Sign in, then bring the app back to the screen this step expects before you hand back.',
      };
    }
    if (hint.retryRuns === 'success_check') {
      return {
        label: plainLabel,
        help:
          `Automation will only check the result again, not repeat any step. After a lost session it would normally start again at ${after}, but ${because}. ` +
          'Sign in, then bring the app back to the screen that shows the result before you hand back.',
      };
    }
    return {
      label: plainLabel,
      help:
        `Automation will refuse this: ${hint.refused}. This step's own action already went out once and is never sent twice. ` +
        'If it went through and the app shows what the next step expects, choose “I completed this step, continue”. Otherwise abort the run.',
    };
  }
  return {
    label: 'Start again after sign-in',
    help:
      `The session was lost, so automation does not ${site.hasStep ? 'retry only this step' : 'only check the result again'}. It starts again at ${after}, ` +
      'and repeats every step from there. Sign in, and leave the app on the screen shown right after sign-in before you hand back.',
  };
}

/**
 * The completed steps a retry will run a second time, listed under the retry option: only when
 * automation will start again after sign-in (`repeats` is empty or absent otherwise).
 */
export function repeatsCopy(hint: RetryResumeHint | undefined): { intro: string; steps: string[] } | undefined {
  if (hint === undefined || hint.refused !== undefined || hint.repeats === undefined || hint.repeats.length === 0) return undefined;
  return { intro: 'These steps already ran and will run again:', steps: hint.repeats.map(stepLabel) };
}

/**
 * A caution under the `next_step` choice after a lost session. Automation takes "I completed this
 * step" at its word: it only checks the failing step's checkpoint, and a step without one passes.
 * Someone who signed in again and nothing else has not completed a step that types into a form.
 * Not shown when automation will refuse the retry outright (that help line covers both choices),
 * nor for the success check, which has no step to complete.
 */
export function nextStepHelp(hint: RetryResumeHint | undefined, site: FailingSite = { hasStep: true }): string | undefined {
  if (hint === undefined || !site.hasStep) return undefined;
  if (hint.refused !== undefined && hint.retryRuns === undefined) return undefined;
  return `Choose this only if you carried this step out yourself. If you only signed in again, choose “${retryOptionCopy(hint, site).label}”.`;
}

/** How a finished round reads in the resolution summary: what automation was asked to continue with. */
export function continuedWithLabel(resolution: Pick<Resolution, 'resumeFrom' | 'resumeAtStepId'>, hint: RetryResumeHint | undefined): string {
  if (resolution.resumeFrom === 'abort') return 'Nothing: run aborted';
  if (resolution.resumeFrom === 'next_step') return RESUME_FROM_RESULT_LABEL.next_step;
  if (resolution.resumeAtStepId !== undefined) return `Resume at step ${shortText(resolution.resumeAtStepId) ?? ''}`;
  if (hint === undefined) return RESUME_FROM_RESULT_LABEL.current_step;
  if (hint.refused === undefined) return `Start again after sign-in, at step ${hint.stepId}`;
  if (hint.retryRuns === 'failing_step') return 'Retry only this step';
  if (hint.retryRuns === 'success_check') return 'Check the result again';
  return 'Retry this step (automation refused it)';
}

/** What the console says once control is handed back, until the round is resolved. */
export const HANDED_BACK_TEXT = 'Handed back. Automation has control again and is continuing the run.';

/**
 * escalate.ts -- shouldEscalate, interventionReasonFor, buildEscalationRequest.
 */
import type { FailureCode } from '../schema/index.js';
import type { EscalationRequest } from '../session/index.js';
import type { Surface } from '../surface/index.js';
import { NON_PAGE_CODES, type Scrubber, type StepFailure } from './types.js';

/**
 * A failure escalates only when a handler exists, the code isn't one of the replay-internal
 * `NON_PAGE_CODES` (a human cannot route around the allowlist or the approval gate), and either
 * the step declared `onFailure: 'escalate'` or the classified code is in the run's `escalateOn`
 * list.
 */
export function shouldEscalate(args: {
  onFailure?: 'fail' | 'escalate';
  code: FailureCode;
  escalateOn: readonly FailureCode[];
  hasHandler: boolean;
}): boolean {
  if (!args.hasHandler) return false;
  if (NON_PAGE_CODES.includes(args.code)) return false;
  if (args.onFailure === 'escalate') return true;
  return args.escalateOn.includes(args.code);
}

/** Maps a classified FailureCode onto the two Intervention reason codes replay derives from a
 *  failure. (The third it raises, `policy_block`, is not derived from a failure: it re-asks after a
 *  refused resume point; see `buildEscalationRequest`'s `reasonCode`.) */
export function interventionReasonFor(code: FailureCode): 'unexpected_dialog' | 'unrecoverable_condition' {
  return code === 'unexpected_dialog' ? 'unexpected_dialog' : 'unrecoverable_condition';
}

/**
 * Builds the EscalationRequest handed to the EscalationHandler.
 *
 * IMPORTANT: this function runs BEFORE the human gets control of the surface -- it is the last
 * thing replay does with the surface before handing off. Once it returns, the caller (replay.ts)
 * must make no further surface calls until `await escalate(request)` resolves; control belongs
 * to the human for that entire window.
 *
 * `screenshotPng` and `currentUrl` are best-effort: a real surface can throw here (e.g. a
 * native dialog is open), and a failed read of either is omitted from the request rather than
 * failing escalation itself -- the operator can still act from the reason/context text alone.
 * Every text field, `currentUrl` included (a query string can carry a typed or bound value), is
 * scrubbed of the run's registered secret and sensitive values before it leaves replay.
 */
export async function buildEscalationRequest(args: {
  runId: string;
  capabilityId: string;
  failure: StepFailure;
  surface: Surface;
  scrubber: Scrubber;
  /** Overrides the reason code derived from the failure: `policy_block` when replay refused the
   *  resume point the previous resolution named (replay.ts, rewind.ts) and asks again. */
  reasonCode?: 'policy_block';
  /** Extra keys for the request's `context` (step ids and names only; scrubbed like the rest). */
  context?: Record<string, unknown>;
}): Promise<EscalationRequest> {
  const { runId, capabilityId, failure, surface, scrubber } = args;

  let screenshotPng: Buffer | undefined;
  try {
    screenshotPng = await surface.screenshot();
  } catch {
    screenshotPng = undefined;
  }

  let currentUrl: string | undefined;
  try {
    currentUrl = await surface.currentUrl();
  } catch {
    currentUrl = undefined;
  }

  const context: Record<string, unknown> = {
    ...args.context,
    expected: failure.expected,
    observed: failure.observed,
    code: failure.code,
    evidence: failure.evidence,
  };
  if (failure.originalCode !== undefined) context.originalCode = failure.originalCode;
  if (failure.stepName !== undefined) context.stepName = failure.stepName;

  return {
    runId,
    runKind: 'replay',
    capabilityId,
    ...(failure.stepId !== undefined ? { stepId: failure.stepId } : {}),
    reason: {
      code: args.reasonCode ?? interventionReasonFor(failure.code),
      message: scrubber.deep(failure.message),
    },
    ...(screenshotPng !== undefined ? { screenshotPng } : {}),
    ...(currentUrl !== undefined ? { currentUrl: scrubber.text(currentUrl) } : {}),
    context: scrubber.deep(context),
  };
}

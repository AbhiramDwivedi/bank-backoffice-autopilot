/**
 * Step equivalence: when is a step a provably redundant repeat of the one right before it?
 *
 * Discovery records every successful action verbatim, so a retry after an unmet expectation (the
 * model types the password, does not see what it expected, types it again) lands in the
 * capability twice. Replaying the second copy costs time and, worse, its checkpoint is evaluated
 * against a state the first copy already produced.
 *
 * Only one shape is treated as provably redundant, deliberately: two CONSECUTIVE steps whose
 * action is an idempotent field write -- a `type` with `clear: true` and no `pressEnter`, or a
 * `select` on a real `<select>` -- with an identical action (same target descriptor, same locator chain, same value
 * binding, same flags), the same declared risk, failure handling and timeout, and checkpoints that
 * do not conflict. Writing the same value into the same cleared field twice leaves the page exactly
 * as writing it once does. Nothing else is called redundant here: two identical clicks can toggle,
 * two identical navigations can re-submit, a `type` without `clear` appends, and Enter submits.
 * Anything subtler than this is the replay-verified optimizer's job (`packages/core/src/optimize`),
 * not a static rule's.
 *
 * Shared by `validateCapability` (the `redundant_repeated_step` warning) and the optimizer's static
 * pass, so both agree on exactly one definition.
 */
import type { Step } from './action.js';

/** Structural equality over JSON-shaped values (key order ignored; `undefined` members ignored,
 *  as JSON serialization would). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((v, i) => jsonEqual(v, bb[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao).filter((k) => ao[k] !== undefined);
  const bk = Object.keys(bo).filter((k) => bo[k] !== undefined);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => Object.prototype.hasOwnProperty.call(bo, k) && jsonEqual(ao[k], bo[k]));
}

/** True when `step`'s action is an idempotent field write: `type` with `clear: true` and no
 *  `pressEnter`, or a `select` on a real `<select>` (recorded snapshot tag). A `select` on anything
 *  else is a custom dropdown, which the Playwright adapter drives as click-open + click-option --
 *  only as idempotent as two clicks, so never treated as a field write. */
export function isIdempotentFieldWrite(step: Step): boolean {
  const a = step.action;
  if (a.type === 'select') return a.target.snapshot?.tag?.toLowerCase() === 'select';
  return a.type === 'type' && a.clear === true && a.pressEnter !== true;
}

/**
 * True when `next`, run immediately after `prev`, is a provably redundant repeat of it (see the
 * module header): both idempotent field writes with deep-equal actions, the same risk, `onFailure`
 * and `timeoutMs`; `next` has no precondition of its own unless it equals `prev`'s; and their
 * postconditions do not conflict (at most one is set, or both are equal). Collapsing the pair into
 * `prev` carrying whichever postcondition exists loses nothing.
 */
export function isRedundantRepeat(prev: Step, next: Step): boolean {
  if (!isIdempotentFieldWrite(prev) || !isIdempotentFieldWrite(next)) return false;
  if (!jsonEqual(prev.action, next.action)) return false;
  if (prev.risk !== next.risk) return false;
  if ((prev.onFailure ?? 'fail') !== (next.onFailure ?? 'fail')) return false;
  if (prev.timeoutMs !== next.timeoutMs) return false;
  if (next.precondition !== undefined && !jsonEqual(prev.precondition, next.precondition)) return false;
  if (prev.postcondition !== undefined && next.postcondition !== undefined && !jsonEqual(prev.postcondition, next.postcondition)) return false;
  return true;
}

/** One redundant repeat found by {@link findRedundantRepeats}. */
export interface RedundantRepeat {
  /** Index and id of the redundant (later) step. */
  index: number;
  stepId: string;
  /** Id of the earlier step it repeats (the first step of the run of repeats). */
  repeatOf: string;
}

/**
 * Every step that is a redundant repeat of the run it follows: for `[s03, s04, s05]` all writing
 * the same value into the same cleared field, reports s04 and s05 as repeats of s03. The
 * comparison is against the run's first step with the run's postcondition merged in, exactly as
 * the optimizer would collapse it, so a run whose later copies carry two different postconditions
 * stops at the first conflict.
 */
export function findRedundantRepeats(steps: readonly Step[]): RedundantRepeat[] {
  const out: RedundantRepeat[] = [];
  let i = 0;
  while (i < steps.length) {
    let survivor: Step = steps[i]!;
    let j = i + 1;
    while (j < steps.length && isRedundantRepeat(survivor, steps[j]!)) {
      const next = steps[j]!;
      out.push({ index: j, stepId: next.id, repeatOf: steps[i]!.id });
      if (survivor.postcondition === undefined && next.postcondition !== undefined) survivor = { ...survivor, postcondition: next.postcondition };
      j += 1;
    }
    i = j;
  }
  return out;
}

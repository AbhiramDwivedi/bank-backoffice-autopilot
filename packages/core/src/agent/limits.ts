/**
 * Discovery loop limits: resolving caller-supplied step/call/duration budgets against the
 * policy's defaults, and detecting a stuck repeat of the same action across turns.
 */
import type { Action, Policy } from '../schema/index.js';

/** The three discovery-loop budgets, resolved from caller overrides and policy defaults. */
export interface ResolvedLimits {
  maxSteps: number;
  maxLlmCalls: number;
  maxDurationMs: number;
}

/** Clamps one caller-supplied limit to a finite positive integer (`Math.floor`); falls back to
 *  `fallback` for anything that isn't (non-number, `NaN`, `Infinity`, zero, or negative), so an
 *  invalid caller value never silently disables the limit it was meant to set. */
function clampLimit(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

/**
 * Resolves the three discovery-loop limits from caller overrides and the policy's defaults.
 * Each override is clamped to a finite positive integer; an override that fails that check falls
 * back to `policyLimits`'s value instead of being used verbatim.
 */
export function resolveLimits(
  opts: { maxSteps?: number; maxLlmCalls?: number; maxDurationMs?: number },
  policyLimits: Policy['limits'],
): ResolvedLimits {
  return {
    maxSteps: clampLimit(opts.maxSteps, policyLimits.maxSteps),
    maxLlmCalls: clampLimit(opts.maxLlmCalls, policyLimits.maxLlmCalls),
    maxDurationMs: clampLimit(opts.maxDurationMs, policyLimits.maxDurationMs),
  };
}

/** One dispatched action's identity for stuck-repeat comparison: its tool, its target's
 *  human-readable description (a click/type/select/extract target's descriptor description, a
 *  navigate URL, or a pressed key), and the `expect` text the caller attached to it. */
export interface ActionSignature {
  tool: string;
  target: string;
  expect: string;
}

/** Best-known human-readable description of an action's own target, for `ActionSignature`: the
 *  descriptor's description for a targeted action, the URL for `navigate`, the key for `press`.
 *  Actions with no target of their own (wait/dismiss_dialog/switch_frame) never reach here through
 *  the discovery loop's `expect`-carrying tools, so they fall back to an empty string. */
export function actionSignatureTarget(action: Action): string {
  if (action.type === 'click' || action.type === 'type' || action.type === 'select' || action.type === 'extract') {
    return action.target.description;
  }
  if (action.type === 'navigate') return action.url;
  if (action.type === 'press') return action.key;
  return '';
}

/**
 * Tracks repeats of the identical action across consecutive discovery turns, to catch a loop the
 * model isn't recovering from on its own. Only an action with a non-empty `expect` that is still
 * unmet after acting counts towards the streak: a call with no `expect`, or one whose expectation
 * was met, resets it instead. Reaching 3 consecutive identical, still-unmet repeats is reported so
 * the caller can route it through its own stuck-escalation path.
 */
export class StuckRepeatDetector {
  private last: ActionSignature | undefined;
  private streak = 0;

  /** Records one action's outcome. `expectMet` is `undefined` when the call carried no `expect`
   *  (checkpoint never evaluated). Returns `true` once the same signature has now failed its
   *  expectation 3 times in a row. */
  record(signature: ActionSignature, expectMet: boolean | undefined): boolean {
    if (signature.expect === '' || expectMet !== false) {
      this.last = undefined;
      this.streak = 0;
      return false;
    }
    if (this.last !== undefined && sameSignature(this.last, signature)) {
      this.streak += 1;
    } else {
      this.last = signature;
      this.streak = 1;
    }
    return this.streak >= 3;
  }
}

function sameSignature(a: ActionSignature, b: ActionSignature): boolean {
  return a.tool === b.tool && a.target === b.target && a.expect === b.expect;
}

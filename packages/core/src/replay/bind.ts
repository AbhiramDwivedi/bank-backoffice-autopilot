/**
 * Replay-time binding: wraps `packages/core/src/schema/template.ts` (the shared, capability-agnostic
 * templating engine) with the two things replay specifically needs on top of it:
 *
 * 1. `valueRedacted` — whether a bound action's value (or any `{input.x}` placeholder anywhere
 *    in it) came from a secret or a sensitive input. `steps.ts` uses this to decide what the
 *    UNBOUND `action` log event may say (never the bound value itself; see safe-logger.ts).
 * 2. Scrubber registration for secrets: a `{kind:'secret', env}` binding resolves a credential (by
 *    name, through the run's `secret` resolver, i.e. its CredentialSet) at bind time that is never
 *    declared as a capability input, so nothing else in the
 *    system would otherwise know to redact it. Every value bound from a secret is registered
 *    with the scrubber the instant it is resolved, before it can reach the surface, a log event,
 *    or an error message.
 *
 * Sensitive *input* values are registered once, centrally, by replay.ts (every sensitive input
 * is scrubbed regardless of whether a given step happens to use it); this module only owns the
 * secret-env half of that safety net.
 */
import {
  REDACTED_VALUE,
  bindAction,
  bindCondition,
  bindDescriptor,
  collectInputPlaceholders,
  type BindContext,
  type BoundAction,
  type BoundStep,
  type Action,
  type Condition,
  type InputSpec,
  type Step,
  type TargetDescriptor,
} from '../schema/index.js';
import type { SurfaceAction } from '../surface/index.js';
import type { InputValue, ReplayBinding, Scrubber } from './types.js';

/**
 * Everything binding needs from `RunState`, without importing `RunState` itself (keeps bind.ts
 * usable from anywhere that has these five things, e.g. a future CLI dry-run).
 */
export interface ReplayBindContext {
  baseUrl: string;
  inputs: Record<string, InputValue>;
  inputSpecs: Record<string, InputSpec>;
  /** Credential resolver (`CredentialSet.get`). Omitted: every secret binding is unavailable, matching template.ts. */
  secret?: (env: string) => string | undefined;
  scrubber: Scrubber;
}

function toTemplateContext(ctx: ReplayBindContext): BindContext {
  return { baseUrl: ctx.baseUrl, inputs: ctx.inputs, secret: ctx.secret };
}

/** True if `name` is a declared input and that input is marked `sensitive`. */
function isSensitiveInput(ctx: ReplayBindContext, name: string): boolean {
  return ctx.inputSpecs[name]?.sensitive === true;
}

/**
 * Binds one `Action`. `valueRedacted` is true when:
 *  - the action's own value binding (type/select only) is `{kind:'secret'}` or a sensitive input, or
 *  - any `{input.x}` placeholder anywhere in the action (target locators, urls, condition text
 *    inside a `wait` action, ...) names a sensitive input.
 * The second check exists because a locator can legitimately be templated with a sensitive value
 * (e.g. searching by a masked account number) even when the action has no `value` field at all.
 */
export function bindActionForReplay(action: Action, ctx: ReplayBindContext): { action: BoundAction; valueRedacted: boolean } {
  const tctx = toTemplateContext(ctx);
  const bound = bindAction(action, tctx);

  let valueRedacted = false;
  if (action.type === 'type' || action.type === 'select') {
    if (action.value.kind === 'secret') {
      valueRedacted = true;
      // Register now: this is the only place in the system that ever sees this plaintext value.
      ctx.scrubber.add((bound as Extract<BoundAction, { type: 'type' | 'select' }>).value);
    } else if (action.value.kind === 'input' && isSensitiveInput(ctx, action.value.name)) {
      valueRedacted = true;
    }
  }

  if (!valueRedacted) {
    for (const name of collectInputPlaceholders(action)) {
      if (isSensitiveInput(ctx, name)) {
        valueRedacted = true;
        break;
      }
    }
  }

  return { action: bound, valueRedacted };
}

/** Binds a whole step: action, precondition and postcondition together. */
export function bindStepForReplay(step: Step, ctx: ReplayBindContext): ReplayBinding {
  const tctx = toTemplateContext(ctx);
  const { action, valueRedacted } = bindActionForReplay(step.action, ctx);
  const bound: BoundStep = {
    ...step,
    action,
    precondition: step.precondition ? bindCondition(step.precondition, tctx) : undefined,
    postcondition: step.postcondition ? bindCondition(step.postcondition, tctx) : undefined,
  };
  return { bound, valueRedacted };
}

/** Binds a Condition (business-outcome detector, recovery trigger, wait condition, ...). */
export function bindConditionForReplay(c: Condition, ctx: ReplayBindContext): Condition {
  return bindCondition(c, toTemplateContext(ctx));
}

/** Binds a TargetDescriptor (business-outcome extract target, recovery action target, ...). */
export function bindTargetForReplay(t: TargetDescriptor, ctx: ReplayBindContext): TargetDescriptor {
  return bindDescriptor(t, toTemplateContext(ctx));
}

/**
 * Masks `value` on a type/select SurfaceAction before it reaches the policy guard: policy
 * decides on action type, target and URL, never on the typed value (see the `PolicyGuardLike`
 * contract in types.ts), so it must never see a secret or a sensitive input.
 */
export function maskActionValue(a: SurfaceAction): SurfaceAction {
  if (a.type === 'type' || a.type === 'select') {
    return { ...a, value: REDACTED_VALUE } as SurfaceAction;
  }
  return a;
}

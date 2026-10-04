/**
 * Scripted (simulated) operators for unattended CLI runs, demos and e2e tests. They act ONLY
 * through `scriptedOperator` (packages/core/src/session), i.e. through the broker's real takeControl / handBack /
 * abort transitions and the operator-guarded surface on the same live session. Everything they do
 * is labelled `scripted-operator` in the evidence. `none` attaches nothing: a human uses the
 * Relay console (and, with --headed, the browser window itself).
 *
 * `relogin` knows nothing about any particular app. It re-runs the capability's own sign-in steps
 * (its `auth` block, or the same steps derived by `resolveAuth`, packages/core/src/schema/auth.ts),
 * binding their secrets from the run's CredentialSet, then waits for the signed-in condition, and
 * hands back asking replay to resume at the first step after the sign-in
 * ({@link decideReloginHandBack}). Replay may refuse that resume point (it would repeat or skip an
 * irreversible step); relogin then aborts rather than guess.
 */
import type { SessionBroker, ScriptedOperatorHandle, ScriptedOperatorContext, ScriptedOperatorResult } from '@cu/core/session';
import { scriptedOperator } from '@cu/core/session';
import {
  DEFAULT_STEP_TIMEOUT_MS,
  bindCondition,
  bindStep,
  resolveAuth,
  validateCapability,
  type BindContext,
  type BoundStep,
  type Capability,
  type Condition,
  type Step,
} from '@cu/core/schema';
import { applyTenantOverride } from '@cu/core/replay';
import type { CredentialSet } from '@cu/core/credentials';
import type { Surface, SurfaceAction } from '@cu/core/surface';

/** How a scripted operator responds to an escalation: do nothing (a human handles it), approve
 * risky-action confirmations (unless {@link AutoOperatorOptions.approveRiskyActions} is false),
 * abort every escalation, or re-authenticate on session expiry. */
export type AutoOperatorMode = 'none' | 'approve' | 'abort' | 'relogin';

/** The replay a scripted operator is attached to: what `replayCapability` was given. */
export interface AutoOperatorReplay {
  /** Raw artifact JSON, exactly as passed to replayCapability. */
  capability: unknown;
  inputs: Record<string, unknown>;
  /** capability.overrides[].tenant key the run applies, if any (its extraSteps can own the failing step). */
  tenant?: string;
}

/** Options for {@link attachAutoOperator}. */
export interface AutoOperatorOptions {
  baseUrl: string;
  /** The replay being run. The relogin script re-runs its sign-in steps and resumes the run at the
   *  first step after them ({@link decideReloginHandBack}).
   *  Omitted (discovery, or a caller that does not pass it): relogin has nothing to re-run and
   *  aborts. */
  replay?: AutoOperatorReplay;
  /** The run's loaded credentials: what the relogin script binds the sign-in's secrets from.
   *  Omitted: no secret resolves, so a relogin whose sign-in binds one aborts. */
  credentials?: CredentialSet;
  /** One-line progress messages (never contains a value that was typed). */
  log?: (line: string) => void;
  /** `approve` mode only: whether a risky_action_confirmation (an irreversible action) is
   *  approved (`next_step`). False: it is aborted instead. Default true (replay of a capability
   *  whose irreversible steps passed its approval gate). */
  approveRiskyActions?: boolean;
}

/** How long relogin waits for the signed-in condition after the last sign-in step. */
const SIGNED_IN_TIMEOUT_MS = 10_000;
/** The signed-in condition must still hold this long after it first does. */
const SIGNED_IN_SETTLE_MS = 500;

/**
 * Waits for `condition`, then requires it to still hold after a short settle: "the sign-in form is
 * gone" is briefly true while the submit navigates, even when the app is about to re-render the form
 * with "invalid password". Retries within `timeoutMs` if it flickered.
 */
async function waitForStable(surface: Pick<Surface, 'waitFor' | 'check'>, condition: Condition, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    if (!(await surface.waitFor(condition, remaining))) return false;
    await new Promise((r) => setTimeout(r, SIGNED_IN_SETTLE_MS));
    if (await surface.check(condition)) return true;
  }
}

function isSessionExpiry(ctx: ScriptedOperatorContext): boolean {
  const text = `${ctx.intervention.reason.message} ${ctx.intervention.currentUrl ?? ''}`.toLowerCase();
  return text.includes('session') || text.includes('/login');
}

/** The capability as the run executes it (validated, the run's tenant override applied: the base
 * steps plus its extraSteps), or `undefined` when there is no replay or the artifact does not
 * validate. */
export function effectiveCapability(replay: AutoOperatorReplay | undefined): Capability | undefined {
  if (replay === undefined) return undefined;
  const parsed = validateCapability(replay.capability);
  if (!parsed.ok) return undefined;
  try {
    return applyTenantOverride(parsed.capability, replay.tenant).capability;
  } catch {
    return undefined;
  }
}

/** The run's inputs as a template BindContext (non-primitive values cannot be templated and are dropped). */
function bindContextFor(baseUrl: string, inputs: Record<string, unknown>): BindContext {
  const out: BindContext['inputs'] = {};
  for (const [k, v] of Object.entries(inputs)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
  }
  return { baseUrl, inputs: out };
}

/** Which way the relogin script hands back, and the one-line reason recorded in the hand-back notes. */
export interface ReloginHandBack {
  resumeFrom: 'current_step' | 'next_step';
  /** The step replay is asked to resume at (with `current_step`). */
  resumeAtStepId?: string;
  /** Step ids only, never a value. */
  reason: string;
}

/**
 * Where replay resumes after a scripted re-login. One rule: **at the first step after the sign-in
 * steps.** A lost session takes everything after the sign-in with it (the page, and any form state
 * a step typed into it), and the re-login has just re-run the sign-in itself, so that is the one
 * point from which every page-local effect the rest of the run depends on is rebuilt. Wherever the
 * expiry surfaced:
 *
 * - at a sign-in step (the hand-written example's expiry hits its sign-on click): the re-login has
 *   completed the sign-in, so the run continues after it;
 * - at a step after the sign-in (the recorded artifact's expiry on typing the member id, or on the
 *   search click): replay rewinds to the first step after the sign-in, so the member id is typed
 *   again before the search runs. Re-running only the failing search would search for nothing and
 *   report "member not found" for a member who exists;
 * - in the final success check (an escalation with no step): the same rewind.
 *
 * The resume point is a request, not a decision: replay refuses one that would repeat or skip an
 * irreversible step (packages/core/src/replay/rewind.ts) and asks again with reason `policy_block`,
 * which this operator answers by aborting (see {@link attachAutoOperator}). When nothing follows the
 * sign-in (a capability that only signs in), it hands back `next_step`.
 */
export function decideReloginHandBack(cap: Pick<Capability, 'steps'>, signInSteps: readonly Pick<Step, 'id'>[], failingStepId: string | undefined): ReloginHandBack {
  const lastSignIn = cap.steps.findIndex((s) => s.id === signInSteps[signInSteps.length - 1]?.id);
  const resumeAt = lastSignIn >= 0 ? cap.steps[lastSignIn + 1] : undefined;
  if (resumeAt === undefined) return { resumeFrom: 'next_step', reason: 'no step follows the sign-in' };
  const failing = failingStepId === undefined ? -1 : cap.steps.findIndex((s) => s.id === failingStepId);
  const where =
    failingStepId === undefined
      ? 'the final success check found the expiry'
      : failing >= 0 && failing <= lastSignIn
        ? `the expiry hit sign-in step ${failingStepId}, which the re-login completed`
        : `the expiry hit ${failingStepId}; what the steps after the sign-in built went with the session`;
  return { resumeFrom: 'current_step', resumeAtStepId: resumeAt.id, reason: `resuming at ${resumeAt.id}, the first step after the sign-in: ${where}` };
}

const abort = (notes: string): ScriptedOperatorResult => ({ resumeFrom: 'abort', notes });

/**
 * Re-authenticate in the SAME browser by re-running the capability's own sign-in: each auth step
 * is bound (inputs, base URL, secrets from the run's CredentialSet), its precondition waited for,
 * acted through the operator-guarded `ctx.act` (so policy still applies, and the actions are
 * recorded as the scripted operator's), and its postcondition waited for. Then the signed-in
 * condition must hold, and the hand-back follows {@link decideReloginHandBack} (decided from the
 * capability and the failing step id alone, not from the live page).
 *
 * Aborts, with a note naming what failed (a step id, a credential NAME, a failure code; never a
 * value), when there is no capability, no sign-in to re-run, a binding fails, a step fails, or the
 * signed-in condition does not hold. `extract` steps inside the sign-in are skipped: reading is
 * not part of signing in, and an output read here would go nowhere.
 */
async function relogin(ctx: ScriptedOperatorContext, opts: AutoOperatorOptions): Promise<ScriptedOperatorResult> {
  const cap = effectiveCapability(opts.replay);
  if (cap === undefined) return abort('relogin: no valid capability for this run, so there are no sign-in steps to re-run');
  const auth = resolveAuth(cap);
  if (auth === undefined) {
    return abort(
      `relogin: capability ${cap.id} has no auth block, and no sign-in can be derived from its steps ` +
        '(needs an entry navigate, then a secret-bound step and a submit before any step that uses the run inputs, none of them irreversible)',
    );
  }
  const bind: BindContext = { ...bindContextFor(opts.baseUrl, opts.replay?.inputs ?? {}), secret: (name) => opts.credentials?.get(name) };
  const ids = auth.steps.map((s) => s.id).join(', ');

  for (const step of auth.steps) {
    let bound: BoundStep;
    try {
      bound = bindStep(step, bind);
    } catch (err) {
      // bindStep's messages name a placeholder or a credential, never a value.
      return abort(`relogin: cannot bind ${step.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (bound.action.type === 'extract') continue;
    const timeoutMs = step.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
    if (bound.precondition !== undefined && !(await ctx.surface.waitFor(bound.precondition, timeoutMs))) {
      return abort(`relogin: precondition of ${step.id} ("${step.name}") did not hold`);
    }
    if (bound.action.type === 'wait') {
      // As replay does: a wait is a condition to poll, not something the surface acts out.
      if (!(await ctx.surface.waitFor(bound.action.condition, bound.action.timeoutMs ?? timeoutMs))) {
        return abort(`relogin: wait in ${step.id} ("${step.name}") timed out`);
      }
    } else {
      const r = await ctx.act(bound.action as SurfaceAction, timeoutMs);
      if (!r.ok) return abort(`relogin failed at ${step.id} ("${step.name}"): ${r.error?.code ?? 'error'}`);
    }
    if (bound.postcondition !== undefined && !(await ctx.surface.waitFor(bound.postcondition, timeoutMs))) {
      return abort(`relogin: checkpoint of ${step.id} ("${step.name}") did not hold`);
    }
  }

  let signedIn: boolean;
  try {
    signedIn = await waitForStable(ctx.surface, bindCondition(auth.signedIn, bind), SIGNED_IN_TIMEOUT_MS);
  } catch (err) {
    return abort(`relogin: cannot check the signed-in condition: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!signedIn) return abort(`relogin: re-ran the sign-in (${ids}) but the signed-in condition did not hold`);
  opts.log?.(`[operator] scripted relogin re-ran ${auth.source} sign-in steps ${ids}`);

  const decision = decideReloginHandBack(cap, auth.steps, ctx.intervention.stepId);
  opts.log?.(`[operator] scripted relogin done for ${ctx.intervention.id}; handing back (${decision.resumeFrom}: ${decision.reason})`);
  return {
    resumeFrom: decision.resumeFrom,
    ...(decision.resumeAtStepId !== undefined ? { resumeAtStepId: decision.resumeAtStepId } : {}),
    notes:
      `scripted operator re-authenticated in the same browser session by re-running the ${auth.source} sign-in steps (${ids}); ` +
      `${decision.resumeFrom} (${decision.reason})`,
  };
}

/** The note a relogin operator aborts with when replay refused the resume point it handed back. */
export const RELOGIN_REFUSED_NOTE =
  'scripted operator (relogin mode): replay refused the resume point it handed back after re-login ' +
  '(resuming there would repeat or skip an irreversible step, or it names no step of this run). ' +
  'It does not guess another one: the run is aborted, and a human must take over';

/** Attaches a scripted operator to `broker` for the given `mode`; returns `undefined` for
 * `'none'`, when no scripted operator is attached and a human is expected to handle escalations. */
export function attachAutoOperator(broker: SessionBroker, mode: AutoOperatorMode, opts: AutoOperatorOptions): ScriptedOperatorHandle | undefined {
  if (mode === 'none') return undefined;
  return scriptedOperator({
    broker,
    script: async (ctx) => {
      const code = ctx.intervention.reason.code;
      opts.log?.(`[operator] scripted ${mode} operator took ${ctx.intervention.id} (${code}: ${ctx.intervention.reason.message})`);
      if (mode === 'abort') return { resumeFrom: 'abort', notes: 'scripted operator: abort mode' };
      if (mode === 'approve') {
        if (code === 'risky_action_confirmation') {
          if (opts.approveRiskyActions === false) {
            return { resumeFrom: 'abort', notes: 'scripted operator (approve mode) is not allowed to confirm irreversible actions in this run' };
          }
          return { resumeFrom: 'next_step', notes: 'scripted operator approved the risky action' };
        }
        return { resumeFrom: 'abort', notes: `scripted operator (approve mode) does not handle '${code}'` };
      }
      // relogin. Replay re-asks with policy_block only when it refused the resume point the
      // previous hand-back named; checked first, as that re-ask still quotes the session expiry.
      if (code === 'policy_block' && ctx.intervention.runKind === 'replay') {
        opts.log?.(`[operator] scripted relogin: replay refused the resume point for ${ctx.intervention.id}; aborting for a human`);
        return abort(RELOGIN_REFUSED_NOTE);
      }
      if (isSessionExpiry(ctx)) return relogin(ctx, opts);
      return { resumeFrom: 'abort', notes: `scripted operator (relogin mode) does not handle '${code}'` };
    },
  });
}

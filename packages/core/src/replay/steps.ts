/**
 * Executes one step of a replay run. `replay.ts` drives the loop over `capability.steps`;
 * everything about executing a single step -- recovery, pre/postcondition, binding, policy,
 * locator resolution, acting, business-outcome detection and failure classification -- lives
 * here so the orchestrator stays a short, readable state machine.
 */
import type {
  Action,
  BoundAction,
  BoundStep,
  Condition,
  FramePath,
  JsonType,
  RecoveryRule,
  RiskClass,
  Step,
  TargetDescriptor,
} from '../schema/index.js';
import { positionalFallbackRefusal, recordTextShows, type SurfaceAction } from '../surface/index.js';
import { bindActionForReplay, bindConditionForReplay, bindStepForReplay, bindTargetForReplay, maskActionValue, type ReplayBindContext } from './bind.js';
import { classifyFailure } from './classify.js';
import { coerceOutput, parseExtracted } from './extract.js';
import {
  BEFORE_STEP_HOOK_TIMEOUT_MS,
  PRECONDITION_TIMEOUT_FRACTION,
  type FailureSignal,
  type InputValue,
  type PolicyActionContext,
  type ReplayBinding,
  type RunState,
  type StepFailure,
  type StepOutcome,
} from './types.js';

// -------------------------------------------------------------------------------------------
// Small shared helpers
// -------------------------------------------------------------------------------------------

function bindCtxFor(state: RunState): ReplayBindContext {
  return {
    baseUrl: state.baseUrl,
    inputs: state.inputs,
    inputSpecs: state.capability.inputs,
    secret: state.secret,
    scrubber: state.scrubber,
  };
}

/** The step's own timeout (its `timeoutMs`, or the run default), capped to whatever is left of
 *  `maxDurationMs`. `expired: true` means the automation deadline had already passed before this
 *  step could even start. */
function stepTimeoutInfo(state: RunState, step: Step): { timeoutMs: number; expired: boolean } {
  const remaining = state.deadline - state.clock.now();
  if (remaining <= 0) return { timeoutMs: 0, expired: true };
  const requested = step.timeoutMs ?? state.stepTimeoutMs;
  return { timeoutMs: Math.max(1, Math.min(requested, remaining)), expired: false };
}

/** Time left until a local deadline, never less than 1ms (a 0ms wait can behave like "forever"
 *  on some Surface implementations, so callers always get at least one real poll). */
function remainingMs(localDeadline: number, clock: RunState['clock']): number {
  return Math.max(1, localDeadline - clock.now());
}

/** Timeout budget for calls that do not have a per-step local deadline of their own (recovery
 *  checks, business-outcome detection): the step default, capped by whatever automation time is
 *  left overall. */
function remainingBudget(state: RunState): number {
  return Math.max(1, Math.min(state.stepTimeoutMs, state.deadline - state.clock.now()));
}

/** Recorded BEFORE the act, not after it succeeds: an irreversible action that errored or whose
 *  postcondition then failed may still have happened on the server, and a resume point that would
 *  re-run it must be refused (rewind.ts). `allowIrreversible` is the declared risk or the policy
 *  guard's flag. */
function noteIrreversibleDispatch(state: RunState, step: Step, allowIrreversible: boolean): void {
  if (allowIrreversible) state.irreversibleRan?.add(step.id);
}

function markStepComplete(state: RunState, step: Step): void {
  state.stepsExecuted += 1;
  state.lastCompletedStepId = step.id;
}

function frameLabel(frame: FramePath): string {
  const last = frame[frame.length - 1];
  if (!last) return 'top document';
  return last.name ?? last.urlPattern ?? (last.index !== undefined ? `frame #${last.index}` : 'frame');
}

/** Human-readable rendering of an (unbound) Condition, used as `expected` in failure evidence
 *  (e.g. `text "Savings Balance" visible in frame main`). Never shown a bound condition -- the
 *  substituted value could be a secret or a sensitive input. */
function describeCondition(c: Condition): string {
  switch (c.kind) {
    case 'text_visible':
      return `text "${c.text}" visible${c.frame ? ` in frame ${frameLabel(c.frame)}` : ''}`;
    case 'text_absent':
      return `text "${c.text}" absent`;
    case 'element_visible':
      return `element "${c.target.description}" visible`;
    case 'element_absent':
      return `element "${c.target.description}" absent`;
    case 'url_matches':
      return `url matches /${c.pattern}/${c.frame ? ` in frame ${frameLabel(c.frame)}` : ''}`;
    case 'dialog_open':
      return c.messagePattern ? `dialog open matching /${c.messagePattern}/` : 'dialog open';
    case 'all':
      return `all of [${c.of.map(describeCondition).join(', ')}]`;
    case 'any':
      return `any of [${c.of.map(describeCondition).join(', ')}]`;
    case 'not':
      return `not (${describeCondition(c.of)})`;
  }
}

/** JSON of the unbound condition, truncated -- used for the `checkpoint` event's `description`,
 *  which is evidence about what was checked, not a message meant to be read as prose. */
function truncateDescription(c: Condition): string {
  const json = JSON.stringify(c);
  return json.length > 300 ? `${json.slice(0, 300)}…` : json;
}

/** `UnboundPlaceholderError` and "credential X is not available" both throw plain `Error`s; either
 *  way the message names only a placeholder or a credential NAME, never a value, so it is safe to
 *  surface verbatim. */
export function bindErrorSignal(err: unknown): FailureSignal {
  const message = err instanceof Error ? err.message : String(err);
  return {
    code: 'internal',
    expected: 'a fully bindable step (every {baseUrl}/{input.x} placeholder resolvable, every secret credential available)',
    observed: message,
    message,
  };
}

function outcomeEligible(afterSteps: readonly string[] | undefined, stepId: string, lastCompletedStepId: string | undefined): boolean {
  if (afterSteps === undefined) return true;
  if (afterSteps.includes(stepId)) return true;
  if (lastCompletedStepId !== undefined && afterSteps.includes(lastCompletedStepId)) return true;
  return false;
}

function eligibleDetectors(state: RunState, stepId: string): Condition[] {
  return state.capability.businessOutcomes.filter((bo) => outcomeEligible(bo.afterSteps, stepId, state.lastCompletedStepId)).map((bo) => bo.detector);
}

function actionTargetDescription(action: Action): string | undefined {
  switch (action.type) {
    case 'click':
    case 'type':
    case 'select':
    case 'extract':
      return action.target.description;
    default:
      return undefined;
  }
}

function logActionEvent(state: RunState, step: Step, bound: BoundStep, valueRedacted: boolean): void {
  const data: Record<string, unknown> = { name: step.name, actionType: step.action.type, risk: step.risk, valueRedacted };
  const target = actionTargetDescription(step.action);
  if (target !== undefined) data.target = target;
  // The bound navigate URL is the one exception to "never log a bound value": a URL is not a
  // value binding, and callers/tests need to see where replay actually went -- but only when
  // nothing sensitive was substituted into it.
  if (step.action.type === 'navigate' && !valueRedacted && bound.action.type === 'navigate') {
    data.url = bound.action.url;
  }
  state.logger.event({ kind: 'action', stepId: step.id, data });
}

// -------------------------------------------------------------------------------------------
// checkOutcomes
// -------------------------------------------------------------------------------------------

/**
 * Checks every business outcome eligible for `stepId` and, on the first match, runs its
 * `extract`s and returns a `business_outcome`. Called both after a normal step action and, via
 * `failStep`, before any failure is allowed to become a hard failure -- a 403 page is
 * `access_denied`, never `checkpoint_failed`. A detector that cannot be bound (an unbound
 * placeholder, an unset secret) returns a `failure` outcome for `step` instead; an extract
 * target that cannot be bound is reported in `missing`, like any other failed extract.
 */
export async function checkOutcomes(state: RunState, stepId: string, step?: Step): Promise<StepOutcome | undefined> {
  const ctx = bindCtxFor(state);
  const timeoutMs = remainingBudget(state);

  for (const outcome of state.capability.businessOutcomes) {
    if (!outcomeEligible(outcome.afterSteps, stepId, state.lastCompletedStepId)) continue;

    let detector: Condition;
    try {
      detector = bindConditionForReplay(outcome.detector, ctx);
    } catch (err) {
      return recordFailure(state, step, bindErrorSignal(err));
    }
    if (!(await state.surface.check(detector, { recorded: outcome.detector }))) continue;

    // A null-prototype object, not `{}`: `extract[].output` is an Identifier
    // (`[A-Za-z_][A-Za-z0-9_]*`), which legally includes a name like "__proto__". `{}`'s inherited
    // `Object.prototype.__proto__` setter would silently swallow `data['__proto__'] = <value>` as
    // a no-op (or, worse, reparent the object) instead of adding a normal own property, so that
    // field would vanish from the returned outcome data without any error.
    const data: Record<string, InputValue> = Object.create(null) as Record<string, InputValue>;
    // Declared `returns` keys whose extract failed for one reason or another (target not found,
    // read/parse/coerce error): recorded so the caller can tell "this key never applied to this
    // outcome" apart from "this key's extract broke" without having to dig through events.jsonl.
    const missing: string[] = [];
    for (const ex of outcome.extract ?? []) {
      let target: TargetDescriptor;
      try {
        target = bindTargetForReplay(ex.target, ctx);
      } catch (err) {
        state.logger.event({ kind: 'error', stepId, data: { outcome: outcome.name, output: ex.output, code: 'internal', message: bindErrorSignal(err).message } });
        missing.push(ex.output);
        continue;
      }
      const resolution = await state.surface.resolve(target, timeoutMs);
      if (!resolution.found) {
        state.logger.event({
          kind: 'error',
          stepId,
          data: { outcome: outcome.name, output: ex.output, code: 'element_not_found', message: `outcome "${outcome.name}" extract target not found: ${target.description}` },
        });
        missing.push(ex.output);
        continue;
      }
      // An outcome's extract is a read like any other: never by position when the chain could name
      // the value, never by a position that settled an ambiguity. Judged on the target as recorded.
      const refusal = positionalFallbackRefusal(ex.target, resolution, { read: true });
      if (refusal) {
        state.logger.event({
          kind: 'error',
          stepId,
          data: { outcome: outcome.name, output: ex.output, code: 'element_not_found', expected: refusal.expected, observed: refusal.observed, message: `outcome "${outcome.name}": ${refusal.message}` },
        });
        missing.push(ex.output);
        continue;
      }
      state.locatorReport.push({ stepId, strategyKind: resolution.strategyKind, fallbackDepth: resolution.strategyIndex });

      const text = await state.surface.readText({ ref: resolution.ref }, timeoutMs);
      if (!text.ok) {
        state.logger.event({ kind: 'error', stepId, data: { outcome: outcome.name, output: ex.output, code: text.error.code, message: text.error.message } });
        missing.push(ex.output);
        continue;
      }
      const outputSpec = outcome.returns[ex.output];
      const sensitive = outputSpec?.sensitive === true || noteMaskedRead(state, step, ex.output, text.masked === true);
      if (sensitive) state.scrubber.add(text.text.trim());
      const parsed = parseExtracted(text.text, ex.parse, ex.pattern);
      if (!parsed.ok) {
        state.logger.event({ kind: 'error', stepId, data: { outcome: outcome.name, output: ex.output, message: sensitive ? SENSITIVE_WITHHELD : parsed.reason } });
        missing.push(ex.output);
        continue;
      }
      const coerced = outputSpec ? coerceOutput(parsed.value, outputSpec.type) : parsed;
      if (!coerced.ok) {
        state.logger.event({ kind: 'error', stepId, data: { outcome: outcome.name, output: ex.output, message: sensitive ? SENSITIVE_WITHHELD : coerced.reason } });
        missing.push(ex.output);
        continue;
      }
      data[ex.output] = coerced.value;
    }

    state.logger.event({ kind: 'outcome', stepId, data: { name: outcome.name, dataKeys: Object.keys(data), ...(missing.length > 0 ? { missing } : {}) } });
    return { kind: 'business_outcome', name: outcome.name, data, ...(missing.length > 0 ? { missing } : {}) };
  }
  return undefined;
}

// -------------------------------------------------------------------------------------------
// runRecoveries
// -------------------------------------------------------------------------------------------

/** The first recovery rule whose (bound) trigger currently holds and whose attempt budget is not
 *  exhausted. Throws if a trigger cannot be bound; `runRecoveries` turns that into a step
 *  failure. */
async function findFirableRule(state: RunState, ctx: ReplayBindContext): Promise<RecoveryRule | undefined> {
  for (const rule of state.capability.recoveryRules) {
    const attempts = state.recoveryAttempts.get(rule.name) ?? 0;
    if (attempts >= rule.maxAttempts) continue;
    const trigger = bindConditionForReplay(rule.trigger, ctx);
    if (await state.surface.check(trigger, { recorded: rule.trigger })) return rule;
  }
  return undefined;
}

/** Runs one recovery action: resolve (if it has a target) + act, or waitFor for `wait`. Never
 *  throws -- a recovery is best-effort; if it does not actually fix anything the step's own
 *  precondition/postcondition check will fail on its own merits. `recorded` is the same action
 *  before binding: the positional-fallback rule judges its target as recorded, and a refused
 *  resolution means the action is not performed (the recovery reports `ok: false`). */
async function runRecoveryAction(state: RunState, stepId: string, action: BoundAction, recorded: Action): Promise<boolean> {
  try {
    if (action.type === 'wait') {
      return await state.surface.waitFor(action.condition, action.timeoutMs ?? remainingBudget(state), recorded.type === 'wait' ? { recorded: recorded.condition } : undefined);
    }
    if (action.type === 'click' || action.type === 'type' || action.type === 'select' || action.type === 'extract') {
      const timeoutMs = remainingBudget(state);
      const resolution = await state.surface.resolve(action.target, timeoutMs);
      if (!resolution.found) return false;
      // Rule (a) only: a recovery `extract` returns no value, so there is no read to protect.
      const recordedTarget = recorded.type === action.type ? recorded.target : action.target;
      const refusal = positionalFallbackRefusal(recordedTarget, resolution, { read: false });
      if (refusal) {
        state.logger.event({
          kind: 'error',
          stepId,
          data: { code: 'element_not_found', expected: refusal.expected, observed: refusal.observed, message: `recovery action not performed: ${refusal.message}` },
        });
        return false;
      }
      state.locatorReport.push({ stepId, strategyKind: resolution.strategyKind, fallbackDepth: resolution.strategyIndex });
      if (action.type === 'extract') return true; // read-only; nothing further to assert
      const result = await state.surface.act({ ...action, target: { ref: resolution.ref } } as SurfaceAction, timeoutMs);
      return result.ok;
    }
    const result = await state.surface.act(action as SurfaceAction, remainingBudget(state));
    return result.ok;
  } catch {
    return false;
  }
}

/**
 * Runs every recovery rule whose (bound) trigger currently holds and whose per-run attempt
 * budget is not exhausted, one rule at a time, until none fires. Returns whether any rule fired
 * at all (the caller re-waits its condition only then), or a failure `StepOutcome` for `step`
 * when a rule's trigger or action cannot be bound.
 */
async function runRecoveries(state: RunState, step: Step): Promise<boolean | StepOutcome> {
  const stepId = step.id;
  const ctx = bindCtxFor(state);
  let anyFired = false;

  for (;;) {
    // Past the automation budget: stop recovering; the step fails on its own deadline check.
    if (state.clock.now() >= state.deadline) return anyFired;
    let rule: RecoveryRule | undefined;
    try {
      rule = await findFirableRule(state, ctx);
    } catch (err) {
      return failStep(state, step, bindErrorSignal(err));
    }
    if (!rule) return anyFired;
    anyFired = true;

    const attemptNumber = (state.recoveryAttempts.get(rule.name) ?? 0) + 1;
    state.recoveryAttempts.set(rule.name, attemptNumber);

    let skipped = false;
    let skipReason = '';
    let ok = true;

    for (const rawAction of rule.actions) {
      let boundAction: BoundAction;
      try {
        boundAction = bindActionForReplay(rawAction, ctx).action;
      } catch (err) {
        return failStep(state, step, bindErrorSignal(err));
      }
      if (state.policy) {
        const currentUrl = await state.surface.currentUrl();
        const check = state.policy.checkAction(maskActionValue(boundAction as SurfaceAction), policyContext(boundAction as BoundAction, stepId, currentUrl));
        if (check.decision === 'deny' || check.decision === 'flag_irreversible') {
          skipped = true;
          skipReason = check.reason;
          ok = false;
          break;
        }
      }
      ok = await runRecoveryAction(state, stepId, boundAction, rawAction);
      if (!ok) break;
    }

    if (skipped) {
      state.logger.event({ kind: 'recovery', stepId, data: { rule: rule.name, skipped: true, reason: skipReason } });
    } else {
      state.logger.event({ kind: 'recovery', stepId, data: { rule: rule.name, attempt: attemptNumber, ok } });
    }
    state.recoveries.push(rule.name);
  }
}

// -------------------------------------------------------------------------------------------
// failStep
// -------------------------------------------------------------------------------------------

/**
 * True for a failure that never got as far as touching the real surface: the policy guard
 * (`policyGate`, below) always refuses BEFORE the step's own action runs, so if no step has
 * completed yet either (`stepsExecuted === 0`), whatever `screenshot()`/`domSnapshot()` would
 * return right now is just the surface's pristine initial state, not real page content -- capturing
 * it would attach blank, uninformative "evidence" instead of leaving `evidence: {}` honest. Once at
 * least one step has completed, the surface holds real content from it, so a later-step
 * policy_violation keeps its evidence as usual.
 */
function isPreSurfaceFailure(state: RunState, signal: FailureSignal): boolean {
  return signal.code === 'policy_violation' && state.stepsExecuted === 0;
}

/**
 * Turns a raw `FailureSignal` into a classified, evidenced `StepOutcome`. Always checks business
 * outcomes FIRST -- a 403 after clicking a restricted action is `access_denied`, not
 * `checkpoint_failed` -- and only once that comes back empty does this capture a screenshot/DOM
 * (unless `isPreSurfaceFailure`, in which case `evidence` stays `{}`) and classify the failure
 * proper.
 */
export async function failStep(state: RunState, step: Step | undefined, signal: FailureSignal): Promise<StepOutcome> {
  const outcomeStepId = step?.id ?? state.lastCompletedStepId ?? '';
  const outcome = await checkOutcomes(state, outcomeStepId, step);
  if (outcome) return outcome;
  return recordFailure(state, step, signal);
}

/** The second half of {@link failStep}, without the business-outcome check: evidence capture,
 *  classification and the `error` event. Used directly when the outcome check itself failed. */
async function recordFailure(state: RunState, step: Step | undefined, signal: FailureSignal): Promise<StepOutcome> {
  const evidence: { screenshot?: string; dom?: string } = isPreSurfaceFailure(state, signal)
    ? {}
    : { screenshot: state.logger.screenshot(await state.surface.screenshot()), dom: state.logger.dom(await state.surface.domSnapshot()) };

  const classified = await classifyFailure(
    { surface: state.surface, sessionExpiredSignals: state.sessionExpiredSignals, appErrorSignals: state.appErrorSignals },
    signal,
  );

  // When classification left the code as checkpoint_failed (i.e. it is not a dialog/session/app
  // rewrite), a fresh page-text excerpt is a far more useful `observed` than a static string
  // like "postcondition not met" -- it is literally what the page said at the point of giving up.
  const observed = classified.code === 'checkpoint_failed' && classified.textExcerpt !== undefined ? classified.textExcerpt : classified.observed;

  state.logger.event({
    kind: 'error',
    stepId: step?.id,
    data: {
      code: classified.code,
      ...(classified.originalCode !== undefined ? { originalCode: classified.originalCode } : {}),
      expected: classified.expected,
      observed,
      message: classified.message,
    },
    evidence,
  });

  const failure: StepFailure = { ...classified, observed, stepId: step?.id, stepName: step?.name, evidence };
  return { kind: 'failure', failure };
}

/**
 * Called for an output the capability does not flag sensitive: true when its value was read from
 * masked content (`ReadTextResult.masked`). It is then treated as sensitive for this run, and a `policy`
 * event (no value) says so, so the gap between the capability and the policy is visible.
 */
function noteMaskedRead(state: RunState, step: Step | undefined, output: string, masked: boolean): boolean {
  if (!masked) return false;
  state.maskedOutputs ??= new Set();
  state.maskedOutputs.add(output);
  state.logger.event({
    kind: 'policy',
    ...(step?.id !== undefined ? { stepId: step.id } : {}),
    data: { gate: 'screen_mask', decision: 'sensitive_output', output, reason: 'read from masked content; the capability does not flag this output sensitive' },
  });
  return true;
}

/** What a failure says instead of quoting a sensitive output's text. */
const SENSITIVE_WITHHELD = 'the extracted text is withheld: the output is sensitive';

// -------------------------------------------------------------------------------------------
// resolveAndAct + extract
// -------------------------------------------------------------------------------------------

async function runExtract(
  state: RunState,
  step: Step,
  action: Extract<BoundAction, { type: 'extract' }>,
  ref: string,
  timeoutMs: number,
): Promise<StepOutcome | undefined> {
  const outputSpec = state.capability.outputs[action.output];
  const type: JsonType = outputSpec?.type ?? 'string';
  const expected = `"${action.output}" parseable as ${action.parse ?? 'text'} (${type})`;

  const identity = await checkRecordIdentity(state, step, action, ref, timeoutMs);
  if (identity.failure) return identity.failure;

  const text = await state.surface.readText({ ref }, timeoutMs);
  if (!text.ok) {
    return failStep(state, step, { code: text.error.code, expected, observed: text.error.message, message: text.error.message });
  }
  // A sensitive output (read from a masked element at discovery) is scrubbed from every sink from
  // here on, and a failure never quotes it; the caller still gets it in the result.
  const sensitive = outputSpec?.sensitive === true || noteMaskedRead(state, step, action.output, text.masked === true);
  if (sensitive) state.scrubber.add(text.text.trim());
  const parsed = parseExtracted(text.text, action.parse, action.pattern);
  if (!parsed.ok) {
    return failStep(state, step, { code: 'checkpoint_failed', expected, observed: sensitive ? SENSITIVE_WITHHELD : text.text, message: sensitive ? SENSITIVE_WITHHELD : parsed.reason });
  }
  const coerced = coerceOutput(parsed.value, type);
  if (!coerced.ok) {
    return failStep(state, step, { code: 'checkpoint_failed', expected, observed: sensitive ? SENSITIVE_WITHHELD : text.text, message: sensitive ? SENSITIVE_WITHHELD : coerced.reason });
  }

  state.outputs[action.output] = coerced.value;
  // Never the value itself -- extracted values only ever reach evidence via result.json.
  state.logger.event({
    kind: 'action_result',
    stepId: step.id,
    data: { output: action.output, parse: action.parse ?? 'text', ok: true, ...(identity.checked !== undefined ? { identity: identity.checked } : {}) },
  });
  return undefined;
}

/**
 * The record identity check on a read (`identity` on the extract): the declared input's value must
 * be visible in the record container of the element the chain found. Runs after the target is
 * resolved and before the value is read, so a value from another record is never returned.
 *
 * The comparison uses the real text and the real input value and discards both. Nothing that is
 * logged or returned carries either: the failure names the input, never its value. A surface that
 * cannot read a container (no `readRecordText`) skips the check, and the event says so. A read
 * the surface refuses is a failure too: an unverified identity is not a verified one.
 */
async function checkRecordIdentity(
  state: RunState,
  step: Step,
  action: Extract<BoundAction, { type: 'extract' }>,
  ref: string,
  timeoutMs: number,
): Promise<{ failure?: StepOutcome; checked?: 'verified' | 'skipped' }> {
  const identity = action.identity;
  if (identity === undefined) return {};
  if (state.surface.readRecordText === undefined) return { checked: 'skipped' };
  const expected = `the ${identity.within === 'page' ? 'page' : 'record container'} of "${action.output}" shows input "${identity.input}"`;
  const fail = async (observed: string, message: string): Promise<{ failure: StepOutcome }> => ({
    failure: await failStep(state, step, { code: 'checkpoint_failed', expected, observed, message: `step ${step.id}: ${message}` }),
  });
  const raw = state.inputs[identity.input];
  if (raw === undefined) return fail(`input "${identity.input}" was not supplied`, `cannot check the record identity of "${action.output}": input "${identity.input}" was not supplied`);
  const read = await state.surface.readRecordText({ ref }, identity.within, timeoutMs);
  if (!read.ok) {
    return { failure: await failStep(state, step, { code: read.error.code, expected, observed: read.error.message, message: `step ${step.id}: ${read.error.message}` }) };
  }
  if (identity.within === 'container' && read.scope !== 'container') {
    return fail('the value has no record container on this page', `the value "${action.output}" no longer sits in a record container, so its record cannot be checked`);
  }
  if (!recordTextShows(read.text, String(raw))) {
    const where = read.scope === 'page' ? 'the page' : "the value's container";
    return fail(
      `${where} does not show input "${identity.input}"`,
      `the value "${action.output}" was found, but ${where} does not show input "${identity.input}": it belongs to another record, so it was not returned`,
    );
  }
  return { checked: 'verified' };
}

/** Resolves the action's target (if it has one) and acts. Returns a `StepOutcome` only on
 *  failure; `undefined` means "continue to the postcondition check". */
async function resolveAndAct(state: RunState, step: Step, bound: BoundStep, localDeadline: number, allowIrreversible: boolean): Promise<StepOutcome | undefined> {
  const action = bound.action;

  if (action.type === 'wait') {
    const timeoutMs = action.timeoutMs ?? remainingMs(localDeadline, state.clock);
    const unboundCondition = (step.action as Extract<Action, { type: 'wait' }>).condition;
    const met = await state.surface.waitFor(action.condition, timeoutMs, { recorded: unboundCondition });
    if (!met) {
      return failStep(state, step, {
        code: 'timeout',
        expected: describeCondition(unboundCondition),
        observed: 'condition not met before timeout',
        message: `step ${step.id} wait condition timed out`,
      });
    }
    state.logger.event({ kind: 'action_result', stepId: step.id, data: { ok: true, navigated: false } });
    return undefined;
  }

  if (action.type === 'click' || action.type === 'type' || action.type === 'select' || action.type === 'extract') {
    const resolveTimeout = remainingMs(localDeadline, state.clock);
    const resolution = await state.surface.resolve(action.target, resolveTimeout);
    if (!resolution.found) {
      const tried = resolution.tried.map((t) => `${t.strategyKind}: ${t.error}`).join('; ');
      return failStep(state, step, {
        code: 'element_not_found',
        expected: `target "${action.target.description}" resolvable by one of ${action.target.locators.length} locators`,
        observed: tried,
        message: `step ${step.id}: target not found: ${action.target.description}`,
      });
    }
    // Replay never settles an ambiguity by position, and never reads by position when the chain
    // has a named way to find the value. The surface found an element; whether it may be used is
    // decided here, on the target as recorded (before binding). A refusal is `element_not_found`:
    // the element the chain names was not found, whatever sits at the fallback's position.
    const recordedAction = step.action;
    const recordedTarget = recordedAction.type === action.type && 'target' in recordedAction ? recordedAction.target : action.target;
    const refusal = positionalFallbackRefusal(recordedTarget, resolution, { read: action.type === 'extract' });
    if (refusal) {
      return failStep(state, step, {
        code: 'element_not_found',
        expected: refusal.expected,
        observed: refusal.observed,
        message: `step ${step.id}: ${refusal.message}`,
      });
    }
    state.logger.event({
      kind: 'locator_resolved',
      stepId: step.id,
      data: { strategyKind: resolution.strategyKind, fallbackDepth: resolution.strategyIndex, target: action.target.description },
    });
    state.locatorReport.push({ stepId: step.id, strategyKind: resolution.strategyKind, fallbackDepth: resolution.strategyIndex });

    if (action.type === 'extract') {
      return runExtract(state, step, action, resolution.ref, remainingMs(localDeadline, state.clock));
    }

    const actTimeout = remainingMs(localDeadline, state.clock);
    noteIrreversibleDispatch(state, step, allowIrreversible);
    const result = await state.surface.act({ ...action, target: { ref: resolution.ref } } as SurfaceAction, actTimeout, { allowIrreversible });
    if (!result.ok) {
      return failStep(state, step, {
        code: result.error?.code ?? 'internal',
        expected: 'action to succeed',
        observed: result.error?.message ?? 'act() returned ok:false with no error detail',
        message: result.error?.message ?? `step ${step.id} action failed`,
      });
    }
    state.logger.event({ kind: 'action_result', stepId: step.id, data: { ok: true, navigated: result.navigated ?? false } });
    return undefined;
  }

  // navigate / press / dismiss_dialog / switch_frame: nothing to resolve.
  const actTimeout = remainingMs(localDeadline, state.clock);
  noteIrreversibleDispatch(state, step, allowIrreversible);
  const result = await state.surface.act(action as SurfaceAction, actTimeout, { allowIrreversible });
  if (!result.ok) {
    return failStep(state, step, {
      code: result.error?.code ?? 'internal',
      expected: 'action to succeed',
      observed: result.error?.message ?? 'act() returned ok:false with no error detail',
      message: result.error?.message ?? `step ${step.id} action failed`,
    });
  }
  state.logger.event({ kind: 'action_result', stepId: step.id, data: { ok: true, navigated: result.navigated ?? false } });
  return undefined;
}

// -------------------------------------------------------------------------------------------
// policy gate
// -------------------------------------------------------------------------------------------

/**
 * Context for the policy guard. Target name/text come from the (bound) descriptor: the recorded
 * snapshot first, then role-name / text locators, plus the descriptor's own `description` --
 * mirroring `descriptorTexts()` in enforcing-surface.ts, so a target whose only irreversible
 * signal is its description (e.g. a css-only locator authored as "Confirm transfer") is still
 * caught, not just one with a matching snapshot or text locator. The guard matches the combined
 * text against irreversibleTextPatterns, so a "Confirm" click is flagged even if the author marked
 * the step 'read'. The declared step risk is passed as riskOverride, which can only raise the risk.
 */
function policyContext(action: BoundStep['action'], stepId: string, currentUrl: string, riskOverride?: RiskClass): PolicyActionContext {
  const ctx: PolicyActionContext = { runKind: 'replay', stepId, currentUrl };
  if (riskOverride !== undefined) ctx.riskOverride = riskOverride;
  if ('target' in action) {
    const t = action.target;
    const roleName = t.locators.map((l) => l.strategy).find((st) => st.kind === 'role');
    const textLoc = t.locators.map((l) => l.strategy).find((st) => st.kind === 'text');
    const name = t.snapshot?.name ?? (roleName?.kind === 'role' ? roleName.name : undefined);
    const texts = [t.description, t.snapshot?.text, textLoc?.kind === 'text' ? textLoc.text : undefined].filter(
      (s): s is string => s !== undefined,
    );
    if (name !== undefined) ctx.targetName = name;
    if (texts.length > 0) ctx.targetText = texts.join(' | ');
  }
  return ctx;
}

/** Returns the resolved `allowIrreversible` flag on success, or a failure `StepOutcome` when the
 *  guard denies the action or flags it irreversible without an approved capability. */
async function policyGate(state: RunState, step: Step, bound: BoundStep): Promise<boolean | StepOutcome> {
  let allowIrreversible = step.risk === 'irreversible';
  if (!state.policy) return allowIrreversible;

  const masked = maskActionValue(bound.action as SurfaceAction);
  const currentUrl = await state.surface.currentUrl();
  const check = state.policy.checkAction(masked, policyContext(bound.action, step.id, currentUrl, step.risk));
  state.logger.event({ kind: 'policy', stepId: step.id, data: { decision: check.decision, reason: check.reason } });

  if (check.decision === 'deny') {
    return failStep(state, step, {
      code: 'policy_violation',
      expected: 'policy decision allow or flag_irreversible',
      observed: `deny: ${check.reason}`,
      message: check.reason,
    });
  }
  if (check.decision === 'flag_irreversible') {
    if (!state.irreversibleAllowed) {
      return failStep(state, step, {
        code: 'policy_violation',
        expected: 'an approved capability for an irreversible action',
        observed: `flag_irreversible: ${check.reason}`,
        message: 'irreversible action requires an approved capability',
      });
    }
    allowIrreversible = true;
  }
  return allowIrreversible;
}

/**
 * Whether `step`'s action counts as irreversible on the page as it is now: its declared risk, or
 * the policy guard flagging its bound action, which is the check {@link policyGate} makes at act
 * time. Nothing is acted on and no decision is logged. replay.ts asks this for a step a human
 * says they carried out (`next_step`): such a step never went through the gate, so nothing else
 * would stop a later rewind from dispatching it again. `ifUnknown` is the answer when the step
 * cannot be bound or the surface cannot say where it is (a native dialog is open): the caller
 * that has no second chance to ask passes `true`, because the answer only ever blocks a repeat.
 */
export async function countsAsIrreversible(state: RunState, step: Step, ifUnknown: boolean): Promise<boolean> {
  if (step.risk === 'irreversible') return true;
  if (!state.policy) return false;
  try {
    const { bound } = bindStepForReplay(step, bindCtxFor(state));
    const currentUrl = await state.surface.currentUrl();
    const check = state.policy.checkAction(maskActionValue(bound.action as SurfaceAction), policyContext(bound.action, step.id, currentUrl, step.risk));
    return check.decision === 'flag_irreversible';
  } catch {
    return ifUnknown;
  }
}

// -------------------------------------------------------------------------------------------
// postcondition + outcomes
// -------------------------------------------------------------------------------------------

async function postActionCheck(state: RunState, step: Step, bound: BoundStep, localDeadline: number): Promise<StepOutcome> {
  if (bound.postcondition === undefined) {
    // No checkpoint declared for this step; still check business outcomes -- outcome eligibility
    // applies to every step, not just ones with a postcondition.
    const outcome = await checkOutcomes(state, step.id, step);
    if (outcome) return outcome;
    markStepComplete(state, step);
    return { kind: 'ok' };
  }

  const ctx = bindCtxFor(state);
  // The conditions as recorded travel with their bound forms (`CheckOptions.recorded`), so an
  // element condition judges positional locators before binding.
  const recordedPost = step.postcondition;
  const recordedDetectors = eligibleDetectors(state, step.id);
  let detectors: Condition[];
  try {
    detectors = recordedDetectors.map((d) => bindConditionForReplay(d, ctx));
  } catch (err) {
    return recordFailure(state, step, bindErrorSignal(err));
  }
  const waitCondition: Condition = detectors.length > 0 ? { kind: 'any', of: [bound.postcondition, ...detectors] } : bound.postcondition;
  const recordedWait: Condition | undefined =
    recordedPost === undefined ? undefined : detectors.length > 0 ? { kind: 'any', of: [recordedPost, ...recordedDetectors] } : recordedPost;
  // Waiting for postcondition-OR-any-eligible-detector means a 403 page does not have to cost a
  // full timeout before it is recognised as a business outcome rather than a hard failure.
  await state.surface.waitFor(waitCondition, remainingMs(localDeadline, state.clock), { recorded: recordedWait });

  let outcome = await checkOutcomes(state, step.id, step);
  if (outcome) return outcome;

  let held = await state.surface.check(bound.postcondition, { recorded: recordedPost });
  state.logger.event({ kind: 'checkpoint', stepId: step.id, data: { phase: 'post', ok: held, description: truncateDescription(step.postcondition!) } });

  if (!held) {
    const fired = await runRecoveries(state, step);
    if (typeof fired !== 'boolean') return fired;
    if (fired) {
      await state.surface.waitFor(bound.postcondition, remainingMs(localDeadline, state.clock), { recorded: recordedPost });
      outcome = await checkOutcomes(state, step.id, step);
      if (outcome) return outcome;
      held = await state.surface.check(bound.postcondition, { recorded: recordedPost });
      state.logger.event({
        kind: 'checkpoint',
        stepId: step.id,
        data: { phase: 'post', ok: held, description: truncateDescription(step.postcondition!), afterRecovery: true },
      });
    }
  }

  if (held) {
    markStepComplete(state, step);
    return { kind: 'ok' };
  }

  return failStep(state, step, {
    code: 'checkpoint_failed',
    expected: describeCondition(step.postcondition!),
    observed: 'postcondition not met',
    message: `step ${step.id} postcondition not met`,
  });
}

// -------------------------------------------------------------------------------------------
// before-step observation hook
// -------------------------------------------------------------------------------------------

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

/**
 * Calls the run's `beforeStep` hook, if any, with a frozen copy of the step and a read-only
 * `check`. The hook observes; it cannot act. A throw from it is logged and swallowed, and a hook
 * that does not settle within its timeout is logged as hung and left behind, so an observer can
 * never change -- or stall -- how a step runs.
 */
async function observeBeforeAct(state: RunState, step: Step): Promise<void> {
  const hook = state.beforeStep;
  if (hook === undefined) return;
  const ctx = bindCtxFor(state);
  const check = async (condition: Condition): Promise<boolean> => {
    let bound: Condition;
    try {
      bound = bindConditionForReplay(condition, ctx);
    } catch {
      return false;
    }
    const ok = await state.surface.check(bound, { recorded: condition });
    state.logger.event({ kind: 'checkpoint', stepId: step.id, data: { phase: 'observe', ok, description: truncateDescription(condition) } });
    return ok;
  };
  const timeoutMs = state.beforeStepTimeoutMs ?? BEFORE_STEP_HOOK_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hung = new Promise<'hung'>((resolve) => {
    timer = setTimeout(() => resolve('hung'), timeoutMs);
  });
  try {
    const settled = await Promise.race([Promise.resolve(hook({ step: deepFreeze(structuredClone(step)), check })).then(() => 'done' as const), hung]);
    if (settled === 'hung') state.logger.event({ kind: 'observation', stepId: step.id, data: { beforeStepHook: 'hung', timeoutMs } });
  } catch (err) {
    state.logger.event({ kind: 'observation', stepId: step.id, data: { beforeStepHook: 'threw', message: err instanceof Error ? err.message : String(err) } });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// -------------------------------------------------------------------------------------------
// runStep
// -------------------------------------------------------------------------------------------

/**
 * Runs one capability step: binds its target and action, runs any due recovery rules, checks the
 * precondition, then -- unless `opts.skipAct` is set -- passes the action through the policy gate
 * and executes it, and finally verifies the postcondition. Returns a `business_outcome` outcome
 * immediately if one becomes eligible at any point along the way.
 */
export async function runStep(state: RunState, step: Step, opts?: { skipAct?: boolean }): Promise<StepOutcome> {
  const timeoutInfo = stepTimeoutInfo(state, step);
  if (timeoutInfo.expired) {
    return failStep(state, step, {
      code: 'timeout',
      expected: 'time remaining in maxDurationMs',
      observed: 'automation deadline already passed',
      message: `maxDurationMs exceeded before step ${step.id}`,
    });
  }
  const localDeadline = state.clock.now() + timeoutInfo.timeoutMs;
  const ctx = bindCtxFor(state);

  // Bound once, up front: preconditions/postconditions may carry the same {input.x} templates
  // as the action, and the `action` log event below needs `valueRedacted` before anything else
  // happens (it must never itself carry a bound value).
  let binding: ReplayBinding;
  try {
    binding = bindStepForReplay(step, ctx);
  } catch (err) {
    return failStep(state, step, bindErrorSignal(err));
  }
  const { bound, valueRedacted } = binding;

  logActionEvent(state, step, bound, valueRedacted);

  // Known interstitials (maintenance notices, ...) are dismissed before checking whether the
  // page is ready for this step.
  const recovered = await runRecoveries(state, step);
  if (typeof recovered !== 'boolean') return recovered;

  if (step.precondition !== undefined && bound.precondition !== undefined) {
    const preTimeout = Math.max(1, Math.round(timeoutInfo.timeoutMs * PRECONDITION_TIMEOUT_FRACTION));
    const preHeld = await state.surface.waitFor(bound.precondition, preTimeout, { recorded: step.precondition });
    state.logger.event({ kind: 'checkpoint', stepId: step.id, data: { phase: 'pre', ok: preHeld } });
    if (!preHeld) {
      return failStep(state, step, {
        code: 'precondition_failed',
        expected: describeCondition(step.precondition),
        observed: 'precondition not met',
        message: `step ${step.id} precondition not met`,
      });
    }
  }

  if (opts?.skipAct !== true) {
    await observeBeforeAct(state, step);
    const gate = await policyGate(state, step, bound);
    if (typeof gate !== 'boolean') return gate;

    const acted = await resolveAndAct(state, step, bound, localDeadline, gate);
    if (acted) return acted;
  }

  return postActionCheck(state, step, bound, localDeadline);
}

/**
 * Used to resume a `next_step` escalation: the human claims to have carried out the step
 * themselves, so replay only re-verifies the postcondition (no recovery check, no re-acting).
 * `failStep` (called on a miss) still checks business outcomes first, so a human resuming into
 * an outcome page is still reported correctly.
 */
export async function verifyPostcondition(state: RunState, step: Step): Promise<StepOutcome> {
  if (step.postcondition === undefined) {
    const outcome = await checkOutcomes(state, step.id, step);
    if (outcome) return outcome;
    markStepComplete(state, step);
    return { kind: 'ok' };
  }

  let postcondition: Condition;
  try {
    postcondition = bindConditionForReplay(step.postcondition, bindCtxFor(state));
  } catch (err) {
    return failStep(state, step, bindErrorSignal(err));
  }
  const held = await state.surface.waitFor(postcondition, remainingBudget(state), { recorded: step.postcondition });
  state.logger.event({
    kind: 'checkpoint',
    stepId: step.id,
    data: { phase: 'post', ok: held, description: truncateDescription(step.postcondition), resume: 'next_step' },
  });

  if (held) {
    const outcome = await checkOutcomes(state, step.id, step);
    if (outcome) return outcome;
    markStepComplete(state, step);
    return { kind: 'ok' };
  }

  return failStep(state, step, {
    code: 'checkpoint_failed',
    expected: describeCondition(step.postcondition),
    observed: 'postcondition not met after human resume (next_step)',
    message: `step ${step.id} postcondition not met after resume`,
  });
}

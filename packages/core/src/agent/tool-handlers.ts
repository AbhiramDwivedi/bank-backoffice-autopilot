/**
 * Executes one parsed tool call (tools.ts) against the surface and recorder: runs the policy
 * gate, performs the surface action (or the read/declare-only tools' own checks), records a
 * `Step` (or outcome/output/recovery rule) on success, and returns the turn's outcome for the
 * loop to act on. Also owns the escalation / give-up control flow (deny-repeatedly, a stuck
 * repeat, a risky action needing human confirmation) shared by `dispatch` and the discovery
 * loop's own turn-level checks (LLM refusal, no tool use).
 */
import type {
  Action,
  ExtractIdentity,
  Condition,
  FramePath,
  Locator,
  RiskClass,
  TargetDescriptor,
  ValueBinding,
} from '../schema/index.js';
import { REDACTED_VALUE, bindDescriptor } from '../schema/index.js';
import {
  MASKED_PLACEHOLDER_RE,
  type ActOptions,
  type ActResult,
  type Observation,
  type ObservedElement,
  type RecordContext,
  type SurfaceAction,
} from '../surface/index.js';
import type { EscalationRequest, EscalationResolution } from '../session/index.js';
import { maskedOutputPlaceholder } from './finalize.js';
import {
  NEARBY_MAX_CHARS,
  PAGE_CONTEXT_MAX_CHARS,
  capDigest,
  combineRisk,
  frameLabel,
  isJudgeableAction,
  judgeActionOf,
  nearbyLabels,
  textFingerprint,
  type RiskCombination,
  type RiskJudgeRequest,
} from '../policy/index.js';
import { actionSignatureTarget } from './limits.js';
import type { ToolCall } from './tools.js';
import type { PolicyActionContext, PolicyCheck } from './types.js';
import type { RunContext } from './run-context.js';

// -------------------------------------------------------------------------------------------
// Small pure helpers
// -------------------------------------------------------------------------------------------

/** Matches a credential-like field (password/PIN/secret/OTP), so a literal typed value can be
 *  refused there. Narrower than the heuristic `validateCapability` applies after the fact. */
const PASSWORD_LIKE_RE = /pass(word|code|phrase)|\bpin\b|secret|\botp\b/i;

function textVisible(text: string, frame?: FramePath): Condition {
  return frame !== undefined ? { kind: 'text_visible', text, frame } : { kind: 'text_visible', text };
}

function textAbsent(text: string, frame?: FramePath): Condition {
  return frame !== undefined ? { kind: 'text_absent', text, frame } : { kind: 'text_absent', text };
}

function resolveUrl(url: string, currentUrl: string): string {
  try {
    return new URL(url, currentUrl).toString();
  } catch {
    return url;
  }
}

function parseExtractedValue(text: string, parse: 'text' | 'number' | 'currency'): string | number | undefined {
  const trimmed = text.trim();
  if (parse === 'text') return trimmed;
  if (parse === 'number') {
    const n = parseFloat(trimmed.replace(/[^0-9.-]/g, ''));
    return Number.isNaN(n) ? undefined : n;
  }
  // currency: strip symbols/commas/spaces; "(123.45)" is negative.
  let cleaned = trimmed.replace(/[$,\s]/g, '');
  let negative = false;
  if (/^\(.*\)$/.test(cleaned)) {
    negative = true;
    cleaned = cleaned.slice(1, -1);
  }
  const n = parseFloat(cleaned);
  if (Number.isNaN(n)) return undefined;
  return negative ? -n : n;
}

// -------------------------------------------------------------------------------------------
// Turn outcomes
// -------------------------------------------------------------------------------------------

/** The two ways a "give up" (deny-repeatedly / stuck / refusal) resolves once escalation (if
 *  any) has run its course: either the loop keeps going (a human intervened and it's safe to
 *  re-observe), or the whole run ends right here. Kept narrower than `StepOutcome` so the
 *  main loop can exhaustively match on it after ruling out `'continue'`. */
export type GiveUpOutcome = { kind: 'stuck'; reason: string } | { kind: 'aborted'; reason: string };

/** `GiveUpOutcome` plus the "keep looping" case: every way a turn's control flow can resolve
 *  short of a successful `done`. */
export type ControlOutcome = { kind: 'continue' } | GiveUpOutcome;

/** What one dispatched tool call resolved to: keep looping, a terminal give-up, a successful
 *  `done`, or (outcome-discovery runs only) a recorded exceptional outcome ending the run. */
export type StepOutcome =
  | ControlOutcome
  | { kind: 'done'; successText: string; summary: string }
  | { kind: 'declare_outcome_extend' };

type Gate = { ok: true; risk: RiskClass; allowIrreversible: boolean } | { ok: false; outcome: ControlOutcome };

// -------------------------------------------------------------------------------------------
// Escalation
// -------------------------------------------------------------------------------------------

/** Shared escalate() gateway: enforces the 3-per-run budget, logs raise/resolve, records human
 *  involvement, and turns 'abort' into a terminal outcome. Used by both the risky-action-
 *  confirmation flow and the generic stuck path (they share one budget; see docs/design/agent.md). */
async function tryEscalate(
  ctx: RunContext,
  req: EscalationRequest,
): Promise<{ ok: true; resolution: EscalationResolution } | { ok: false; outcome: GiveUpOutcome }> {
  if (!ctx.opts.escalate) {
    return { ok: false, outcome: { kind: 'stuck', reason: `${req.reason.message} (no escalation handler available)` } };
  }
  if (ctx.state.escalationsUsed >= 3) {
    return { ok: false, outcome: { kind: 'stuck', reason: 'too many escalations in this run' } };
  }
  ctx.state.escalationsUsed += 1;
  ctx.logEvent('escalation', { phase: 'raised', code: req.reason.code, message: req.reason.message });
  // The handler persists what it receives (intervention records), so it gets the scrubbed request;
  // the screenshot is passed through as-is (pixels are the operator's evidence).
  const { screenshotPng, ...textual } = req;
  const scrubbedReq: EscalationRequest = { ...ctx.scrubber.deep(textual), ...(screenshotPng !== undefined ? { screenshotPng } : {}) };
  const resolution = await ctx.opts.escalate(scrubbedReq);
  ctx.logEvent('escalation', { phase: 'resolved', resumeFrom: resolution.resumeFrom, humanActions: resolution.humanActions.length, by: resolution.by });
  if (resolution.humanActions.length > 0) {
    ctx.recorder.markHumanInvolved(resolution.notes ?? `${resolution.humanActions.length} manual action(s) during escalation`);
  }
  if (resolution.resumeFrom === 'abort') {
    return { ok: false, outcome: { kind: 'aborted', reason: `human aborted (${req.reason.code}): ${req.reason.message}` } };
  }
  return { ok: true, resolution };
}

/** Raises a 'stuck' escalation for `reasonMessage`; on a human resume, seeds `lastResult` with
 *  what happened and returns `{kind:'continue'}` so the loop re-observes. Used for every give-up
 *  path: policy denied repeatedly, a stuck-repeat action, no tool use, an LLM refusal, and the
 *  model's own `stuck` tool call. */
export async function stuckPath(ctx: RunContext, reasonMessage: string, obs: Observation): Promise<ControlOutcome> {
  const esc = await tryEscalate(ctx, {
    runId: ctx.runId,
    runKind: 'discovery',
    goal: ctx.opts.goal,
    reason: { code: 'stuck', message: reasonMessage },
    screenshotPng: obs.screenshotPng,
    currentUrl: obs.url,
    context: { history: ctx.state.history.map((h) => `${h.stepId} ${h.tool}: ${h.why}`) },
  });
  if (!esc.ok) return esc.outcome;
  ctx.state.lastResult = `A human operator intervened: ${esc.resolution.notes ?? '(no notes)'}; ${esc.resolution.humanActions.length} manual actions. Re-observe and continue.`;
  return { kind: 'continue' };
}

async function denyGate(ctx: RunContext, reason: string, obs: Observation): Promise<ControlOutcome> {
  ctx.state.consecutiveDenies += 1;
  ctx.state.lastResult = `Refused by policy: ${reason}`;
  if (ctx.state.consecutiveDenies >= 3) return stuckPath(ctx, 'policy_denied_repeatedly', obs);
  return { kind: 'continue' };
}

function nextStepId(ctx: RunContext): string {
  return `s${String(ctx.recorder.steps.length + 1).padStart(2, '0')}`;
}

function actionTargetLabel(action: SurfaceAction, el: ObservedElement | undefined): string {
  if (el) return el.name;
  if (action.type === 'navigate') return action.url;
  if (action.type === 'press') return `key "${action.key}"`;
  return '(no target)';
}

/** Consecutive unavailable judgments after which a run that cannot escalate gives up. */
const JUDGE_UNAVAILABLE_LIMIT = 3;

/** Drops `undefined` values so a judge request (and its cache key) carries only what is known. */
function definedOnly<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

/** The judge's view of one pending action: value-free, built from the current observation, and
 *  every string through the run's scrubber (the judge is a third party) before it is capped. The
 *  target comes with its frame and the labels nearest it there; the page text is cut to its head
 *  and tail within what the nearby labels leave of the shared budget. `cacheContext` is a
 *  fingerprint of the FULL scrubbed page text, for the cache key only. */
function judgeRequestFor(
  ctx: RunContext,
  action: SurfaceAction,
  el: ObservedElement | undefined,
  why: string,
  obs: Observation,
  lexicalRisk: RiskClass,
): { req: RiskJudgeRequest; cacheContext: string } {
  const s = (v: string | undefined): string | undefined => (v === undefined ? undefined : ctx.scrubber.text(v));
  const judgeAction = judgeActionOf(action);
  const nearby = el !== undefined ? nearbyLabels(el, obs.elements, (t) => ctx.scrubber.text(t), NEARBY_MAX_CHARS) : [];
  const nearbyChars = nearby.reduce((n, l) => n + l.length, 0);
  const fullDigest = ctx.scrubber.text(obs.textDigest);
  const req: RiskJudgeRequest = {
    phase: 'record',
    action: definedOnly({ ...judgeAction, url: s(judgeAction.url) }),
    ...(el !== undefined
      ? {
          target: definedOnly({
            name: s(el.name),
            text: s(el.text),
            role: s(el.role),
            tag: s(el.tag),
            description: s(el.descriptor.description),
            frame: s(frameLabel(el.frame)),
            ...(nearby.length > 0 ? { nearby } : {}),
          }),
        }
      : {}),
    page: definedOnly({
      url: ctx.scrubber.text(obs.url),
      title: s(obs.title),
      textDigest: capDigest(fullDigest, PAGE_CONTEXT_MAX_CHARS - nearbyChars),
      dialogMessage: s(obs.dialog?.message),
    }),
    goal: ctx.scrubber.text(ctx.opts.goal),
    why: ctx.scrubber.text(why),
    lexicalRisk,
  };
  return { req, cacheContext: textFingerprint(fullDigest) };
}

/** Asks the run's risk judge about an action the lexical guard allowed, logs a `policy` event
 *  (source `risk-judge`), and returns the combined risk (raise-only; see policy/judge.ts). */
async function consultJudge(
  ctx: RunContext,
  judge: NonNullable<RunContext['judge']>,
  action: SurfaceAction,
  el: ObservedElement | undefined,
  why: string,
  obs: Observation,
  lexicalRisk: RiskClass,
): Promise<RiskCombination> {
  const { guarded, config } = judge;
  const { req, cacheContext } = judgeRequestFor(ctx, action, el, why, obs, lexicalRisk);
  const outcome = await guarded.judge(req, cacheContext);
  ctx.state.judgeUnavailableStreak = outcome.kind === 'unavailable' ? (ctx.state.judgeUnavailableStreak ?? 0) + 1 : 0;
  const combo = combineRisk(lexicalRisk, outcome, config);
  const label = ctx.scrubber.text(actionTargetLabel(action, el));
  const decision = combo.risk === 'irreversible' ? 'flag_irreversible' : 'allow';
  const base = { source: 'risk-judge', judge: guarded.id, mode: config.mode, tool: action.type, target: el?.name, lexicalRisk, risk: combo.risk, decision, reason: combo.reason };
  if (outcome.kind === 'judged') {
    ctx.logEvent('policy', {
      ...base,
      judgedRisk: combo.judgedRisk,
      pIrreversible: outcome.judgment.pIrreversible,
      rationale: outcome.judgment.rationale,
      cached: outcome.cached,
      ...(config.mode === 'advise' ? { wouldRaise: combo.wouldRaise === true } : {}),
    });
  } else {
    ctx.logEvent('policy', { ...base, outcome: 'unavailable', onError: config.onError });
    ctx.opts.onRiskJudgeUnavailable?.({ judge: guarded.id, reason: ctx.scrubber.text(outcome.reason), onError: config.onError });
  }
  if (combo.raised) {
    ctx.state.judgeRaised = (ctx.state.judgeRaised ?? 0) + 1;
    ctx.recorder.addNote(`risk judge ${guarded.id} raised ${nextStepId(ctx)} (${action.type} on "${label}") from ${lexicalRisk} to ${combo.risk}: ${combo.reason}`);
  } else if (config.mode === 'advise' && combo.wouldRaise === true) {
    ctx.recorder.addNote(`risk judge ${guarded.id} (advise, not enforced) would raise ${nextStepId(ctx)} (${action.type} on "${label}") from ${lexicalRisk}: ${combo.reason}`);
  }
  return combo;
}

/** Runs an action through the policy guard: a deny routes through `denyGate` (and, after 3 in a
 *  row, `stuckPath`); an irreversible action blocks outright in `discoveryMode: 'block'` (or with
 *  no escalation handler) and otherwise requires a human confirmation via `tryEscalate` before
 *  it's allowed to proceed. An action the lexical guard allows but that can commit something is
 *  then put to the run's risk judge, if any (docs/design/risk-judge.md): a judgment can only raise
 *  the risk, and a raise to irreversible takes exactly the flagged path. */
async function gateAction(
  ctx: RunContext,
  action: SurfaceAction,
  actionCtx: PolicyActionContext,
  el: ObservedElement | undefined,
  why: string,
  obs: Observation,
): Promise<Gate> {
  const check: PolicyCheck = ctx.opts.guard.checkAction(action, actionCtx);
  ctx.logEvent('policy', { decision: check.decision, reason: check.reason, risk: check.risk, tool: action.type });

  if (check.decision === 'deny') {
    return { ok: false, outcome: await denyGate(ctx, check.reason, obs) };
  }
  ctx.state.consecutiveDenies = 0;

  let risk: RiskClass = check.risk ?? 'read';
  let judged: RiskCombination | undefined;
  if (check.decision === 'allow' && ctx.judge !== undefined && isJudgeableAction(action)) {
    judged = await consultJudge(ctx, ctx.judge, action, el, why, obs, risk);
    risk = judged.risk;
  }

  if (check.decision === 'flag_irreversible' || risk === 'irreversible') {
    const judgeSuffix = judged !== undefined ? ` [risk judge: ${judged.reason}]` : '';
    if (ctx.opts.policy.risk.discoveryMode === 'block' || !ctx.opts.escalate) {
      // A fail-closed judge outage refuses every committing action here and nothing else counts
      // toward giving up, so the run would only burn model calls until maxSteps. Stop instead.
      const streak = ctx.state.judgeUnavailableStreak ?? 0;
      if (ctx.judge !== undefined && streak >= JUDGE_UNAVAILABLE_LIMIT) {
        return {
          ok: false,
          outcome: {
            kind: 'stuck',
            reason:
              `risk judge ${ctx.judge.guarded.id} was unavailable for ${streak} committing actions in a row and fail_closed refuses them ` +
              'without a human; fix the judge, or re-run with --risk-judge off to proceed on the lexical patterns only',
          },
        };
      }
      ctx.state.lastResult = `Refused: this action is irreversible and cannot be taken without prior human approval in this run.${judgeSuffix}`;
      return { ok: false, outcome: { kind: 'continue' } };
    }
    const esc = await tryEscalate(ctx, {
      runId: ctx.runId,
      runKind: 'discovery',
      goal: ctx.opts.goal,
      stepId: nextStepId(ctx),
      reason: { code: 'risky_action_confirmation', message: `${action.type} on "${actionTargetLabel(action, el)}": ${why}${judgeSuffix}` },
      screenshotPng: obs.screenshotPng,
      currentUrl: obs.url,
      context: { tool: action.type, target: el?.name, why, ...(judged !== undefined ? { riskJudge: judged.reason } : {}) },
    });
    if (!esc.ok) return { ok: false, outcome: esc.outcome };
    return { ok: true, risk: 'irreversible', allowIrreversible: true };
  }

  return { ok: true, risk, allowIrreversible: false };
}

// -------------------------------------------------------------------------------------------
// Frame probing / checkpoints
//
// Every condition built from model-supplied text (expect, success_text, detector_text,
// trigger_text) is evaluated against the MASKED view (`{ view: 'masked' }`) and nothing else: the
// answer is a pure function of the text the model was shown. Text that is not in the masked view is
// simply not visible, whether the page shows it unmasked, masked or not at all, so a guess at hidden
// content gets the same answer, the same message and the same code path as any other absent text,
// and evaluating guesses can never become a yes/no oracle on what the screen hides. No tool consults
// the real page for model-written text. Replay evaluates recorded conditions against the real page.
// -------------------------------------------------------------------------------------------

const MASKED_VIEW = { view: 'masked' } as const;

/** The frames a text probe tries, in order: the acted-on element's own frame first, then every
 *  frame the observation listed, each once. */
function candidateFrames(preferredFrame: FramePath | undefined, obs: Observation): FramePath[] {
  const seen = new Set<string>();
  const candidates: FramePath[] = [];
  const push = (f: FramePath): void => {
    const key = JSON.stringify(f);
    if (!seen.has(key)) {
      seen.add(key);
      candidates.push(f);
    }
  };
  if (preferredFrame !== undefined) push(preferredFrame);
  for (const f of obs.frames) push(f.path);
  return candidates;
}

async function probeFrame(ctx: RunContext, text: string, preferredFrame: FramePath | undefined, obs: Observation): Promise<FramePath | undefined> {
  for (const f of candidateFrames(preferredFrame, obs)) {
    if (await ctx.opts.surface.check(textVisible(text, f), MASKED_VIEW)) return f;
  }
  return undefined;
}

/** Where `text` is visible right now, before an action: `anywhere` (whole page), and the frames
 *  (JSON keys) it is visible in. The per-frame probe only runs when the cheap whole-page check
 *  already found it, so an expectation that is not yet on screen costs one check. */
interface PreActVisibility {
  anywhere: boolean;
  frames: ReadonlySet<string>;
}

async function preActVisibility(ctx: RunContext, text: string, preferredFrame: FramePath | undefined, obs: Observation): Promise<PreActVisibility> {
  // Model-written text, so the masked view only (see the section comment above): a pre-check against
  // the real page would answer differently for a correct and a wrong guess at hidden text.
  if (!(await ctx.opts.surface.check(textVisible(text), MASKED_VIEW))) return { anywhere: false, frames: new Set() };
  const frames = new Set<string>();
  for (const f of candidateFrames(preferredFrame, obs)) {
    if (await ctx.opts.surface.check(textVisible(text, f), MASKED_VIEW)) frames.add(JSON.stringify(f));
  }
  return { anywhere: true, frames };
}

/**
 * A met expectation is vacuous when the text was already visible, in the frame the checkpoint
 * would be scoped to, before the action ran: the checkpoint would pass even if the action had
 * done nothing, so it cannot detect a failed step at replay. An unscoped checkpoint (no frame
 * found) is vacuous when the text was visible anywhere before.
 */
function isVacuous(pre: PreActVisibility, postcondition: Condition | undefined): boolean {
  if (!pre.anywhere || postcondition === undefined || postcondition.kind !== 'text_visible') return false;
  return postcondition.frame === undefined || pre.frames.has(JSON.stringify(postcondition.frame));
}

async function computeCheckpoint(
  ctx: RunContext,
  expectText: string,
  elFrame: FramePath | undefined,
  obs: Observation,
): Promise<{ met: boolean; postcondition?: Condition }> {
  const met = await ctx.opts.surface.waitFor(textVisible(expectText), ctx.expectTimeoutMs, MASKED_VIEW);
  if (!met) return { met: false };
  const frame = await probeFrame(ctx, expectText, elFrame, obs);
  return { met: true, postcondition: textVisible(expectText, frame) };
}

// -------------------------------------------------------------------------------------------
// Act + record for the tools that carry an `expect`
// -------------------------------------------------------------------------------------------

/**
 * True when the element was painted over, or shows masked content inside it (a result row holding
 * a masked cell): `readText` would return text the model must not see, so the value is withheld
 * and the output recorded sensitive.
 */
function showsMaskedContent(el: ObservedElement): boolean {
  if (el.masked === true) return true;
  return [el.name, el.text, el.value].some((s) => s !== undefined && MASKED_PLACEHOLDER_RE.test(s));
}

function findElement(obs: Observation, ref: string): ObservedElement | undefined {
  return obs.elements.find((e) => e.ref === ref);
}

function ctxFor(el: ObservedElement | undefined, obs: Observation): PolicyActionContext {
  const actionCtx: PolicyActionContext = { runKind: 'discovery', currentUrl: obs.url };
  if (el?.name !== undefined) actionCtx.targetName = el.name;
  if (el?.text !== undefined) actionCtx.targetText = el.text;
  return actionCtx;
}

async function actAndRecord(
  ctx: RunContext,
  params: {
    surfaceAction: SurfaceAction;
    recordAction: Action;
    tool: string;
    why: string;
    expect: string;
    gate: Extract<Gate, { ok: true }>;
    el: ObservedElement | undefined;
    obs: Observation;
    /** The target exactly as it must be recorded (`prepareTarget`). */
    scopedTarget?: TargetDescriptor;
    /** The record-scoped target could not be verified: a replay that misses it escalates. */
    escalate?: boolean;
  },
): Promise<StepOutcome> {
  // Observed BEFORE acting: an expectation that is already true cannot become a checkpoint.
  const pre: PreActVisibility | undefined = params.expect !== '' ? await preActVisibility(ctx, params.expect, params.el?.frame, params.obs) : undefined;
  const actOpts: ActOptions | undefined = params.gate.allowIrreversible ? { allowIrreversible: true } : undefined;
  const actResult: ActResult = await ctx.opts.surface.act(params.surfaceAction, ctx.actionTimeoutMs, actOpts);
  ctx.logEvent('action', { tool: params.tool, target: params.el?.name, why: params.why });
  ctx.logEvent('action_result', { ok: actResult.ok, error: actResult.error, navigated: actResult.navigated });

  if (!actResult.ok) {
    ctx.state.lastResult = `Action failed: ${actResult.error?.message ?? 'unknown error'}`;
    return { kind: 'continue' };
  }

  // `expectMet` is what the history and the stuck-repeat detector see. A vacuous expectation counts
  // as NOT met: it is no evidence the action did anything, and three identical actions with the
  // same already-true expectation are exactly the retry loop the detector exists to stop (it is
  // how a password step got recorded twice). The model is told the difference in `lastResult`.
  let postcondition: Condition | undefined;
  let expectMet: boolean | undefined;
  let vacuous = false;
  if (params.expect !== '') {
    const cp = await computeCheckpoint(ctx, params.expect, params.el?.frame, params.obs);
    vacuous = cp.met && pre !== undefined && isVacuous(pre, cp.postcondition);
    expectMet = cp.met && !vacuous;
    ctx.logEvent('checkpoint', {
      expect: params.expect,
      met: cp.met,
      frame: cp.postcondition && 'frame' in cp.postcondition ? cp.postcondition.frame : undefined,
      ...(vacuous ? { vacuous: true, recorded: false } : {}),
    });
    if (cp.met && !vacuous) postcondition = cp.postcondition;
  }

  const step = ctx.recorder.recordStep({
    action: params.recordAction,
    why: params.why,
    risk: params.gate.risk,
    ...(postcondition !== undefined ? { postcondition } : {}),
    ...(params.gate.allowIrreversible || params.escalate === true ? { onFailure: 'escalate' as const } : {}),
    ...(params.scopedTarget !== undefined ? { scopedTarget: params.scopedTarget } : {}),
  });
  ctx.state.history.push({
    stepId: step.id,
    tool: params.tool,
    why: params.why,
    ...(expectMet !== undefined ? { expectMet } : {}),
    ...(vacuous ? { expectVacuous: true } : {}),
  });

  ctx.state.lastResult =
    params.expect === ''
      ? 'Action performed.'
      : vacuous
        ? `Action performed, but your expectation proves nothing: "${params.expect}" was already visible BEFORE the action, so it was not recorded as a checkpoint. ` +
          'Pick an expectation that only becomes true because of the action (text that appears as a result of it), not text that is already on the screen.'
        : expectMet
          ? `Action performed; expectation met: "${params.expect}" is visible.`
          : `Action performed, but expectation not met: "${params.expect}" is not visible. Reconsider.`;

  const signature = { tool: params.tool, target: actionSignatureTarget(params.recordAction), expect: params.expect };
  if (ctx.stuckRepeats.record(signature, expectMet)) {
    // Say what actually happened: a vacuous expectation WAS visible -- it just proved nothing.
    const why = vacuous
      ? `with an expectation that was already visible before the action, so it never showed the action worked (the model was told to pick a better one): "${params.expect}"`
      : `without meeting its expectation: "${params.expect}"`;
    return stuckPath(ctx, `the same action ("${params.tool}" on "${signature.target}") was repeated 3 times in a row ${why}`, params.obs);
  }
  return { kind: 'continue' };
}

/**
 * True when `target` (canonical), bound with this run's own inputs, finds exactly the element
 * `ref` on the live surface. Node identity only: a surface without `isSameElement` cannot verify,
 * and an unverifiable target counts as not verified (two controls that merely describe alike are
 * not the same control).
 */
async function findsElement(ctx: RunContext, target: TargetDescriptor, ref: string): Promise<boolean> {
  const surface = ctx.opts.surface;
  if (!surface.isSameElement || target.locators.length === 0) return false;
  try {
    const inputs = Object.fromEntries(Object.entries(ctx.opts.inputs).map(([name, decl]) => [name, decl.value]));
    const bound = bindDescriptor(target, { baseUrl: ctx.opts.target.baseUrl, inputs });
    const r = await surface.resolve(bound, 0);
    return r.found && (await surface.isSameElement(ref, r.ref));
  } catch {
    return false;
  }
}

/**
 * The locators of `target` (canonical) that, each ALONE and bound with this run's own inputs, find
 * exactly the element `ref` on the live surface. A locator that misses, is ambiguous or finds
 * another element is left out: at replay it would never fire, or fire on the wrong element, and
 * every run would report the next locator as drift although the app has not changed. Each test is
 * one resolution round with no waiting ({@link findsElement}), so a dead locator costs one lookup,
 * never a timeout.
 */
async function locatorsFinding(ctx: RunContext, target: TargetDescriptor, ref: string): Promise<Locator[]> {
  const kept: Locator[] = [];
  for (const locator of target.locators) {
    if (await findsElement(ctx, { ...target, locators: [locator] }, ref)) kept.push(locator);
  }
  return kept;
}

/**
 * The identity check for a read of `ref`, or undefined. The surface returns the text of the
 * element's record container (the whole frame when it has none); the recorder looks for a run
 * input's value in it and keeps only the input's name. The text is real and is dropped here: it is
 * never logged, shown to the model or stored. A surface that cannot say records no check.
 */
async function recordIdentityOf(ctx: RunContext, ref: string): Promise<ExtractIdentity | undefined> {
  const surface = ctx.opts.surface;
  if (surface.readRecordText === undefined) return undefined;
  const read = await surface.readRecordText({ ref }, 'container', ctx.actionTimeoutMs);
  if (!read.ok) return undefined;
  const identity = ctx.recorder.identityFor({ scope: read.scope, text: read.text });
  ctx.logEvent('locator_resolved', { phase: 'record_identity', scope: read.scope, recorded: identity !== undefined, ...(identity !== undefined ? { input: identity.input } : {}) });
  return identity;
}

/** The recorder-only context of an observed element (`Surface.recordContextOf`); never logged or shown. */
function recordContextOf(ctx: RunContext, ref: string): RecordContext | undefined {
  return ctx.opts.surface.recordContextOf?.(ref);
}

/** A target ready to record, or why the tool call is refused. `escalate`: the record-scoped chain
 *  could not be verified, so a replay that misses it must ask a human rather than guess. */
type PreparedTarget = { ok: true; target: TargetDescriptor; escalate: boolean } | { ok: false; feedback: string };

/**
 * The rule (recorder.ts `scopeLocators`): a target that belongs to a record named by a run input
 * keeps no positional locator, and its input-bound chain is verified here, before anything is
 * recorded (and, for an action, before it is performed).
 *  - A static own name is checked for uniqueness on the live page first: one that is not unique
 *    and sits next to an input-bound anchor (the "Add to cart" in every card) is record-scoped.
 *  - A record-scoped chain must find `ref` when bound with this run's inputs. Each locator is
 *    tested alone, and one that does not find `ref` (a miss, an ambiguity, another element) is not
 *    recorded: a role name two links share would miss at every replay and read as drift. An
 *    own-input chain none of whose locators survives ("4512" inside "45123") is retried in its
 *    specific form ("Row for {input.id}", exact).
 *  - Unverified: an extract is refused (a wrong value is the worst outcome); an action is recorded
 *    with its input-bound locators only and `escalate`, so replay asks a human instead of guessing
 *    a position. A record-scoped target with no locator left is refused outright.
 *  - Any other target is never refused, but a locator that does not find `ref` alone is left out
 *    of its chain too, unless none does.
 */
async function prepareTarget(
  ctx: RunContext,
  descriptor: TargetDescriptor,
  ref: string,
  kind: 'action' | 'extract',
  label: string,
  context: RecordContext | undefined,
): Promise<PreparedTarget> {
  let ownNameUnique = true;
  const withContext = context !== undefined ? { context } : {};
  let scoped = ctx.recorder.scopeTarget(descriptor, withContext);
  if ((scoped.scope === 'static' || scoped.scope === 'page') && scoped.hasInputAnchor && scoped.ownStatic.length > 0) {
    ownNameUnique = await findsElement(ctx, { ...descriptor, locators: scoped.ownStatic }, ref);
    if (!ownNameUnique) scoped = ctx.recorder.scopeTarget(descriptor, { ownNameUnique, ...withContext });
  }
  if (!scoped.recordScoped) {
    // Not a record's target: nothing is refused, and its chain is not required to verify. A locator
    // that does not find the element on its own is still left out. When none does (a surface that
    // cannot compare elements, a ref gone stale), nothing was learned and the chain is kept whole.
    const alive = await locatorsFinding(ctx, scoped.target, ref);
    const dropped = alive.length > 0 ? scoped.target.locators.filter((l) => !alive.includes(l)).map((l) => l.strategy.kind) : [];
    if (dropped.length === 0) return { ok: true, target: scoped.target, escalate: false };
    ctx.logEvent('locator_resolved', { phase: 'record_verify', scope: scoped.scope, pruned: dropped });
    return { ok: true, target: { ...scoped.target, locators: alive }, escalate: false };
  }
  const refuse = (): PreparedTarget =>
    kind === 'extract'
      ? {
          ok: false,
          feedback: `Could not record a reusable locator for "${label}": bound to this run's inputs, it does not find the element you read. Try a different ref for the same value, or a value the page shows next to its record's name.`,
        }
      : {
          ok: false,
          feedback:
            "Refused: this control belongs to the record named by this run's input, but nothing identifies it except its position on the page, which would pick another record for another input. Act on a control the page names with the record's own name, or open the record's own page first.",
        };
  if (scoped.target.locators.length === 0) {
    ctx.logEvent('locator_resolved', { phase: 'record_verify', scope: scoped.scope, verified: false, locators: 0 });
    return refuse();
  }
  // Every locator is tested on its own, so the chain is verified exactly when one survives, and the
  // recorded chain holds only locators that found this element: its first one fires at replay
  // unless the app has changed.
  let target = scoped.target;
  let kept = await locatorsFinding(ctx, target, ref);
  if (kept.length === 0 && (scoped.scope === 'own-input' || scoped.scope === 'content-input')) {
    const specific = ctx.recorder.scopeTarget(descriptor, { ownNameUnique, specific: true, ...withContext });
    if (specific.target.locators.length > 0) {
      target = specific.target;
      kept = await locatorsFinding(ctx, target, ref);
    }
  }
  const verified = kept.length > 0;
  const pruned = verified ? target.locators.filter((l) => !kept.includes(l)).map((l) => l.strategy.kind) : [];
  ctx.logEvent('locator_resolved', { phase: 'record_verify', scope: scoped.scope, verified, ...(pruned.length > 0 ? { pruned } : {}) });
  if (verified) return { ok: true, target: pruned.length > 0 ? { ...target, locators: kept } : target, escalate: false };
  if (kind === 'extract') return refuse();
  ctx.recorder.addNote(
    `step "${label}": its ${scoped.scope} target did not find the acted element when bound with this run's inputs; it keeps only its input-bound locators and escalates when they miss`,
  );
  return { ok: true, target, escalate: true };
}

function feedbackOutcome(ctx: RunContext, text: string): StepOutcome {
  ctx.state.lastResult = text;
  return { kind: 'continue' };
}

function resolveTypeOrSelectValue(
  ctx: RunContext,
  call: { source: 'input' | 'secret' | 'literal'; value: string },
  el: ObservedElement,
): { ok: true; value: string; binding: ValueBinding } | { ok: false; feedback: string } {
  if (call.source === 'input') {
    const decl = ctx.opts.inputs[call.value];
    if (!decl) return { ok: false, feedback: `Unknown input name "${call.value}". Check INPUTS in the current turn.` };
    return { ok: true, value: decl.value, binding: { kind: 'input', name: call.value } };
  }
  if (call.source === 'secret') {
    if (!ctx.opts.secretEnvNames.includes(call.value)) {
      return { ok: false, feedback: `"${call.value}" is not an allowed secret env name. Check SECRETS in the current turn.` };
    }
    const resolved = ctx.secretValues[call.value];
    if (resolved === undefined) {
      return { ok: false, feedback: `Secret env "${call.value}" could not be resolved in this environment.` };
    }
    return { ok: true, value: resolved, binding: { kind: 'secret', env: call.value } };
  }
  // literal
  const targetTexts = [el.name, el.text ?? '', el.descriptor.description];
  if (targetTexts.some((t) => PASSWORD_LIKE_RE.test(t))) {
    return { ok: false, feedback: 'Refused: literal text cannot be typed into a credential-like field. Use source "secret" instead.' };
  }
  if (ctx.scrubber.text(call.value) !== call.value) {
    return { ok: false, feedback: 'Refused: that literal text contains a secret or sensitive value. Use the matching input or secret binding instead.' };
  }
  const matchingInput = Object.entries(ctx.opts.inputs).find(([, decl]) => !decl.sensitive && decl.value === call.value);
  if (matchingInput) {
    const [name] = matchingInput;
    ctx.recorder.addNote(`literal value for "${name}" matched a declared input; recorded as an input binding instead of a literal`);
    return { ok: true, value: call.value, binding: { kind: 'input', name } };
  }
  return { ok: true, value: call.value, binding: { kind: 'literal', value: call.value } };
}

// -------------------------------------------------------------------------------------------
// Per-tool dispatch
// -------------------------------------------------------------------------------------------

/** Executes one parsed tool call against the surface and recorder, and returns the turn's
 *  outcome for the discovery loop to act on. */
export async function dispatch(ctx: RunContext, call: ToolCall, obs: Observation): Promise<StepOutcome> {
  switch (call.tool) {
    case 'click': {
      const el = findElement(obs, call.ref);
      if (!el) return feedbackOutcome(ctx, `Unknown ref "${call.ref}". Re-check the current element list before acting.`);
      const surfaceAction: SurfaceAction = { type: 'click', target: { ref: call.ref } };
      const gate = await gateAction(ctx, surfaceAction, ctxFor(el, obs), el, call.why, obs);
      if (!gate.ok) return gate.outcome;
      const recordAction: Action = { type: 'click', target: el.descriptor };
      const prep = await prepareTarget(ctx, el.descriptor, el.ref, 'action', call.why, recordContextOf(ctx, el.ref));
      if (!prep.ok) return feedbackOutcome(ctx, prep.feedback);
      return actAndRecord(ctx, { surfaceAction, recordAction, tool: 'click', why: call.why, expect: call.expect, gate, el, obs, scopedTarget: prep.target, escalate: prep.escalate });
    }

    case 'type': {
      const el = findElement(obs, call.ref);
      if (!el) return feedbackOutcome(ctx, `Unknown ref "${call.ref}". Re-check the current element list before acting.`);
      const bound = resolveTypeOrSelectValue(ctx, call, el);
      if (!bound.ok) return feedbackOutcome(ctx, bound.feedback);
      const maskedAction: SurfaceAction = { type: 'type', target: { ref: call.ref }, value: REDACTED_VALUE, clear: true };
      const gate = await gateAction(ctx, maskedAction, ctxFor(el, obs), el, call.why, obs);
      if (!gate.ok) return gate.outcome;
      const surfaceAction: SurfaceAction = { type: 'type', target: { ref: call.ref }, value: bound.value, clear: true };
      const recordAction: Action = { type: 'type', target: el.descriptor, value: bound.binding, clear: true };
      const prep = await prepareTarget(ctx, el.descriptor, el.ref, 'action', call.why, recordContextOf(ctx, el.ref));
      if (!prep.ok) return feedbackOutcome(ctx, prep.feedback);
      return actAndRecord(ctx, { surfaceAction, recordAction, tool: 'type', why: call.why, expect: call.expect, gate, el, obs, scopedTarget: prep.target, escalate: prep.escalate });
    }

    case 'select': {
      const el = findElement(obs, call.ref);
      if (!el) return feedbackOutcome(ctx, `Unknown ref "${call.ref}". Re-check the current element list before acting.`);
      const bound = resolveTypeOrSelectValue(ctx, call, el);
      if (!bound.ok) return feedbackOutcome(ctx, bound.feedback);
      const maskedAction: SurfaceAction = { type: 'select', target: { ref: call.ref }, value: REDACTED_VALUE };
      const gate = await gateAction(ctx, maskedAction, ctxFor(el, obs), el, call.why, obs);
      if (!gate.ok) return gate.outcome;
      const surfaceAction: SurfaceAction = { type: 'select', target: { ref: call.ref }, value: bound.value };
      const recordAction: Action = { type: 'select', target: el.descriptor, value: bound.binding };
      const prep = await prepareTarget(ctx, el.descriptor, el.ref, 'action', call.why, recordContextOf(ctx, el.ref));
      if (!prep.ok) return feedbackOutcome(ctx, prep.feedback);
      return actAndRecord(ctx, { surfaceAction, recordAction, tool: 'select', why: call.why, expect: call.expect, gate, el, obs, scopedTarget: prep.target, escalate: prep.escalate });
    }

    case 'press': {
      const surfaceAction: SurfaceAction = { type: 'press', key: call.key };
      const gate = await gateAction(ctx, surfaceAction, ctxFor(undefined, obs), undefined, call.why, obs);
      if (!gate.ok) return gate.outcome;
      const recordAction: Action = { type: 'press', key: call.key };
      return actAndRecord(ctx, { surfaceAction, recordAction, tool: 'press', why: call.why, expect: call.expect, gate, el: undefined, obs });
    }

    case 'navigate': {
      const resolved = resolveUrl(call.url, obs.url);
      const urlCheck = ctx.opts.guard.checkUrl(resolved);
      ctx.logEvent('policy', { decision: urlCheck.allowed ? 'allow' : 'deny', reason: urlCheck.reason, tool: 'navigate', phase: 'url' });
      if (!urlCheck.allowed) return denyGate(ctx, urlCheck.reason, obs);
      const surfaceAction: SurfaceAction = { type: 'navigate', url: resolved };
      const gate = await gateAction(ctx, surfaceAction, ctxFor(undefined, obs), undefined, call.why, obs);
      if (!gate.ok) return gate.outcome;
      const recordAction: Action = { type: 'navigate', url: resolved };
      return actAndRecord(ctx, { surfaceAction, recordAction, tool: 'navigate', why: call.why, expect: call.expect, gate, el: undefined, obs });
    }

    case 'dismiss_dialog': {
      const surfaceAction: SurfaceAction = { type: 'dismiss_dialog', accept: call.accept };
      const gate = await gateAction(ctx, surfaceAction, ctxFor(undefined, obs), undefined, call.why, obs);
      if (!gate.ok) return gate.outcome;
      const actOpts: ActOptions | undefined = gate.allowIrreversible ? { allowIrreversible: true } : undefined;
      const actResult = await ctx.opts.surface.act(surfaceAction, ctx.actionTimeoutMs, actOpts);
      ctx.logEvent('action', { tool: 'dismiss_dialog', accept: call.accept, why: call.why });
      ctx.logEvent('action_result', { ok: actResult.ok, error: actResult.error, navigated: actResult.navigated });
      if (!actResult.ok) return feedbackOutcome(ctx, `Action failed: ${actResult.error?.message ?? 'unknown error'}`);
      const recordAction: Action = { type: 'dismiss_dialog', accept: call.accept };
      const step = ctx.recorder.recordStep({
        action: recordAction,
        why: call.why,
        risk: gate.risk,
        ...(gate.allowIrreversible ? { onFailure: 'escalate' as const } : {}),
      });
      ctx.state.history.push({ stepId: step.id, tool: 'dismiss_dialog', why: call.why });
      return feedbackOutcome(ctx, 'Dialog dismissed.');
    }

    case 'dismiss_interstitial': {
      const el = findElement(obs, call.ref);
      if (!el) return feedbackOutcome(ctx, `Unknown ref "${call.ref}". Re-check the current element list before acting.`);
      const triggerVisible = await ctx.opts.surface.check(textVisible(call.trigger_text), MASKED_VIEW);
      if (!triggerVisible) return feedbackOutcome(ctx, `"${call.trigger_text}" is not currently visible; there is nothing to dismiss.`);
      const triggerFrame = await probeFrame(ctx, call.trigger_text, el.frame, obs);
      const surfaceAction: SurfaceAction = { type: 'click', target: { ref: call.ref } };
      const gate = await gateAction(ctx, surfaceAction, ctxFor(el, obs), el, call.why, obs);
      if (!gate.ok) return gate.outcome;
      const prep = await prepareTarget(ctx, el.descriptor, el.ref, 'action', call.why, recordContextOf(ctx, el.ref));
      if (!prep.ok) return feedbackOutcome(ctx, prep.feedback);
      const actOpts: ActOptions | undefined = gate.allowIrreversible ? { allowIrreversible: true } : undefined;
      const actResult = await ctx.opts.surface.act(surfaceAction, ctx.actionTimeoutMs, actOpts);
      ctx.logEvent('action', { tool: 'dismiss_interstitial', target: el.name, why: call.why });
      ctx.logEvent('action_result', { ok: actResult.ok, error: actResult.error, navigated: actResult.navigated });
      if (!actResult.ok) return feedbackOutcome(ctx, `Action failed: ${actResult.error?.message ?? 'unknown error'}`);
      const dismissed = await ctx.opts.surface.waitFor(textAbsent(call.trigger_text, triggerFrame), 5000, MASKED_VIEW);
      // Only a click that actually cleared the notice becomes a recovery rule: a click on the
      // wrong control would otherwise be replayed forever. The rule is named from the notice's own
      // TITLE (`call.title`), never from `trigger_text` (typically the notice's longer body copy)
      // -- `recordRecovery` falls back to `dismiss_interstitial_<n>` when `title` is "".
      // A recovery rule replays automatically, outside the approval gate, so a click that was only
      // allowed as irreversible (the patterns or the risk judge flagged it and a human confirmed)
      // never becomes one.
      // An unverified record-scoped dismiss control is not made a recovery rule: a recovery replays
      // unattended, with no escalation to fall back on.
      const recordable = dismissed && gate.risk !== 'irreversible' && !prep.escalate;
      if (recordable) {
        ctx.recorder.recordRecovery({
          triggerText: call.trigger_text,
          title: call.title,
          ...(triggerFrame !== undefined ? { frame: triggerFrame } : {}),
          dismissTarget: el.descriptor,
          description: call.why,
          scopedTarget: prep.target,
        });
      }
      ctx.logEvent('recovery', { triggerText: call.trigger_text, frame: triggerFrame, dismissed, recorded: recordable });
      return feedbackOutcome(
        ctx,
        !dismissed
          ? `Clicked, but "${call.trigger_text}" is still visible, so no recovery rule was recorded. Try a different control to dismiss it.`
          : recordable
            ? `Dismissed the notice; "${call.trigger_text}" is no longer visible.`
            : `Dismissed the notice; "${call.trigger_text}" is no longer visible. Not recorded as a recovery rule: the control is irreversible.`,
      );
    }

    case 'extract': {
      const el = findElement(obs, call.ref);
      if (!el) return feedbackOutcome(ctx, `Unknown ref "${call.ref}". Re-check the current element list before acting.`);
      const surfaceAction: SurfaceAction = { type: 'extract', target: { ref: call.ref }, output: call.output, parse: call.parse };
      const gate = await gateAction(ctx, surfaceAction, ctxFor(el, obs), el, call.why, obs);
      if (!gate.ok) return gate.outcome;
      const readResult = await ctx.opts.surface.readText({ ref: call.ref }, ctx.actionTimeoutMs);
      ctx.logEvent('action', { tool: 'extract', target: el.name, output: call.output, why: call.why });
      if (!readResult.ok) return feedbackOutcome(ctx, `Could not read the value: ${readResult.error.message}`);
      // Screen masking: the model extracts a value it cannot see. The real text is read locally and
      // goes to the caller; from here on it is scrubbed out of everything the model, the transcript
      // and the logs see, and the feedback says only that it was extracted.
      // Masked: the surface says the read touched masked content (or the element shows a placeholder).
      const masked = readResult.masked === true || showsMaskedContent(el);
      if (masked) ctx.scrubber.add(readResult.text, maskedOutputPlaceholder(call.output));
      const parsed = parseExtractedValue(readResult.text, call.parse);
      if (parsed === undefined) {
        return feedbackOutcome(
          ctx,
          masked
            ? `Could not parse ${call.output} as ${call.parse}; the value is withheld because the field is masked.`
            : `Could not parse the value as ${call.parse}: "${ctx.scrubber.text(readResult.text)}".`,
        );
      }
      // Defect 1: the raw text just read off the page is record-time data (this run's specific
      // balance, name, ...) -- it must not persist as a reusable locator or leak into free text.
      const sanitized = ctx.recorder.sanitizeExtractedTarget(el.descriptor, call.output, readResult.text);
      if (!sanitized.ok) {
        ctx.logEvent('error', { phase: 'extract_sanitize', output: call.output, message: sanitized.error });
        return feedbackOutcome(
          ctx,
          `Could not record a reusable locator for "${call.output}": ${sanitized.error}. Try extracting from a different element (e.g. a label cell adjacent to the value), or a different ref.`,
        );
      }
      // A wrong value is the worst outcome: a record-scoped target that does not find this very
      // element when bound with this run's inputs is not recorded at all.
      const prep = await prepareTarget(ctx, sanitized.target, call.ref, 'extract', call.output, recordContextOf(ctx, call.ref));
      if (!prep.ok) {
        ctx.logEvent('error', { phase: 'extract_verify', output: call.output });
        return feedbackOutcome(ctx, prep.feedback);
      }
      // The read belongs to a record when that record's container shows a run input: record that
      // input by name, so replay can refuse a value from another record's container.
      const identity = await recordIdentityOf(ctx, call.ref);
      const recordAction: Action = { type: 'extract', target: prep.target, output: call.output, parse: call.parse, ...(identity !== undefined ? { identity } : {}) };
      const step = ctx.recorder.recordStep({ action: recordAction, why: call.why, risk: gate.risk, scopedTarget: prep.target });
      ctx.recorder.recordOutput(call.output, call.parse, call.why, masked ? { sensitive: true } : undefined);
      ctx.state.extractedOutputs.set(call.output, parsed);
      // Sticky, like the recorder's OutputSpec.sensitive: once read from a masked element, always sensitive.
      if (masked) ctx.state.sensitiveOutputs.add(call.output);
      ctx.state.history.push({ stepId: step.id, tool: 'extract', why: call.why });
      if (masked) return feedbackOutcome(ctx, `Extracted ${call.output}; the value is withheld because the field is masked.`);
      return feedbackOutcome(ctx, `Extracted ${call.output} = ${ctx.scrubber.text(String(parsed))}.`);
    }

    case 'declare_outcome': {
      const detectorVisible = await ctx.opts.surface.check(textVisible(call.detector_text), MASKED_VIEW);
      if (!detectorVisible) return feedbackOutcome(ctx, `"${call.detector_text}" is not currently visible; there is nothing to declare.`);
      const frame = await probeFrame(ctx, call.detector_text, undefined, obs);
      const returns: { output: string; target: TargetDescriptor; parse: 'text' | 'number' | 'currency'; description: string; scoped?: boolean; sensitive?: boolean }[] = [];
      for (const r of call.returns) {
        const el = findElement(obs, r.ref);
        if (!el) return feedbackOutcome(ctx, `Unknown ref "${r.ref}" in returns. Re-check the current element list.`);
        // Defect 1 (business-outcome extracts): no readText call happens here (the extract itself
        // runs at replay time), but the observation already captured this record's displayed value
        // -- el.text/el.name -- so the same record-time-data treatment applies now, at record time.
        // A text return that is (part of) the detector text itself is the outcome's static message,
        // not record data, so `sanitizeExtractedTarget` leaves it unregistered. A number/currency
        // return is always treated as record data, even when the detector repeats it.
        const rawValue = el.text ?? el.name;
        const detectorText = r.parse === 'text' ? call.detector_text : undefined;
        const sanitized = ctx.recorder.sanitizeExtractedTarget(el.descriptor, r.output, rawValue, detectorText);
        if (!sanitized.ok) {
          ctx.logEvent('error', { phase: 'extract_sanitize', output: r.output, message: sanitized.error });
          return feedbackOutcome(ctx, `Could not record a reusable locator for return "${r.output}": ${sanitized.error}.`);
        }
        const prep = await prepareTarget(ctx, sanitized.target, r.ref, 'extract', r.output, recordContextOf(ctx, r.ref));
        if (!prep.ok) {
          ctx.logEvent('error', { phase: 'extract_verify', output: r.output });
          return feedbackOutcome(ctx, prep.feedback);
        }
        // Sensitive when the element shows masked content, or the surface says reading it would touch some.
        const probe = showsMaskedContent(el) ? undefined : await ctx.opts.surface.readText({ ref: r.ref }, ctx.actionTimeoutMs);
        const sensitive = probe === undefined || (probe.ok && probe.masked === true);
        returns.push({ output: r.output, target: prep.target, parse: r.parse, description: r.description, scoped: true, ...(sensitive ? { sensitive: true } : {}) });
      }
      const outcome = ctx.recorder.recordOutcome({ name: call.name, description: call.description, detectorText: call.detector_text, ...(frame !== undefined ? { frame } : {}), returns });
      ctx.logEvent('outcome', { name: outcome.name, detectorText: call.detector_text, frame });
      if (ctx.isExtend) return { kind: 'declare_outcome_extend' };
      return feedbackOutcome(ctx, `Outcome "${outcome.name}" recorded. Continue if there is more to do, or call stuck/done as appropriate.`);
    }

    case 'done': {
      if (ctx.isExtend) return { kind: 'stuck', reason: 'no exceptional outcome observed' };
      const missing = Object.keys(ctx.opts.outputs ?? {}).filter((name) => !ctx.state.extractedOutputs.has(name));
      if (missing.length > 0) {
        return feedbackOutcome(ctx, `Cannot finish yet: the following declared outputs have not been extracted: ${missing.join(', ')}.`);
      }
      const successVisible = await ctx.opts.surface.check(textVisible(call.success_text), MASKED_VIEW);
      if (!successVisible) return feedbackOutcome(ctx, `"${call.success_text}" is not currently visible; the goal does not look complete yet.`);
      const frame = await probeFrame(ctx, call.success_text, undefined, obs);
      ctx.recorder.setSuccess(textVisible(call.success_text, frame), call.summary);
      return { kind: 'done', successText: call.success_text, summary: call.summary };
    }

    case 'stuck':
      return stuckPath(ctx, call.reason, obs);

    default: {
      const exhaustive: never = call;
      throw new Error(`discover: unhandled tool ${JSON.stringify(exhaustive)}`);
    }
  }
}

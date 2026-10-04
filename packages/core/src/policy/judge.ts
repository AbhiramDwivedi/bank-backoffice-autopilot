/**
 * The risk-judge port: a judgment-based "does this action commit something the operator cannot
 * undo?" check layered over the lexical guard (`guard.ts`). See docs/design/risk-judge.md.
 *
 * Non-obvious decisions:
 * - The judge runs at record time (discovery) and at audit time, never at replay. A step it calls
 *   irreversible is recorded `risk: 'irreversible'`, and from then on the deterministic machinery
 *   (approval gate, `riskOverride` at replay) enforces it with no model in the loop. Nothing in
 *   this file performs I/O; adapters implement `RiskJudge` outside core.
 * - Raise-only. `combineRisk` returns `max(lexical, judged)`; a judgment can never lower what the
 *   lexical guard (or a step's declared risk) says, the same rule `riskOverride` follows in
 *   `guard.ts`. A judge that answers "read" for a "Confirm transfer" button changes nothing.
 * - `pIrreversible` decides `irreversible`, under the policy's threshold, not the judge's own
 *   `risk` label: the threshold is the operator's knob. Below it, the label only separates `read`
 *   from `reversible` (an `irreversible` label below threshold is read as `reversible`).
 * - Fail closed by default: an unavailable judge (error, timeout, malformed answer) counts as an
 *   irreversible verdict in `enforce` mode. `advise` mode never changes a decision, not even then.
 * - Every string in a `RiskJudgeRequest` must already be scrubbed by the caller: the judge is a
 *   third party. Typed values are never part of a request (the action carries only its type and
 *   key/accept/url/pressEnter), and neither are screenshots.
 * - The judge sees the target in place: its frame, the controls and labels nearest it in that
 *   frame, and the head and tail of the page text, within one character budget. Two "OK" buttons
 *   in different frames, or on two wizard steps with the same chrome, are different requests.
 * - The per-run cache keys on the whole request minus the agent's free-text `why`, plus a caller-
 *   supplied fingerprint of the FULL scrubbed page text (not the capped excerpt sent). Keying on
 *   the excerpt would let two pages that share more chrome than the excerpt holds -- "Step 1 of
 *   3" and "Step 3 of 3 ... Continue sends the money" -- share an answer. URLs are compared
 *   case-sensitively. A dynamic page costs an extra call instead, which is the safe direction.
 */
import { createHash } from 'node:crypto';
import type { Action, ActionType, Capability, FramePath, Policy, RiskClass, Step, TargetDescriptor } from '../schema/index.js';
import { RISK_ORDER, RiskJudgeConfig } from '../schema/index.js';
import type { ObservedElement, SurfaceAction } from '../surface/index.js';
import type { PolicyGuard } from './guard.js';
import { descriptorTexts } from './enforcing-surface.js';

// -------------------------------------------------------------------------------------------
// The port
// -------------------------------------------------------------------------------------------

/** What is being done. Never a typed value: only the fields that say what kind of commit it is. */
export interface RiskJudgeAction {
  type: ActionType;
  /** `press` only. */
  key?: string;
  /** `dismiss_dialog` only. */
  accept?: boolean;
  /** `navigate` only: the destination (resolved, or a `{baseUrl}` template at audit time). */
  url?: string;
  /** `type` only: whether Enter is pressed afterwards (an implicit form submit). */
  pressEnter?: boolean;
}

/** One action, its target and its page, as the judge sees them. Every string is pre-scrubbed. */
export interface RiskJudgeRequest {
  /** `record`: a live discovery run, with the page in view. `audit`: a static capability step. */
  phase: 'record' | 'audit';
  action: RiskJudgeAction;
  /** The control acted on, if the action has one. */
  target?: {
    name?: string;
    text?: string;
    role?: string;
    tag?: string;
    description?: string;
    /** Frame holding the control, e.g. "top" or "main > content". */
    frame?: string;
    /** Names/texts of the controls and labels nearest the target in its frame, nearest first. */
    nearby?: string[];
  };
  page: {
    url: string;
    title?: string;
    /** Visible page text: head and tail, within {@link PAGE_CONTEXT_MAX_CHARS} together with
     *  `target.nearby` (see {@link capDigest}). */
    textDigest?: string;
    /** Message of a pending native dialog, if one is open. */
    dialogMessage?: string;
  };
  /** The run's goal (record) or the capability's name and description (audit). */
  goal: string;
  /** The agent's (or the recorded step's) stated reason for the action. */
  why?: string;
  /** What the lexical guard already says. */
  lexicalRisk: RiskClass;
}

/** A judge's answer. */
export interface RiskJudgment {
  risk: RiskClass;
  /** Probability, 0..1, that the action commits something the operator cannot undo from the UI. */
  pIrreversible: number;
  /** Short, human-readable reason. Third-party text: scrub before persisting. */
  rationale?: string;
}

/** The port: implemented by `@cu/adapter-jev`, `@cu/adapter-anthropic` (`createAnthropicJudge`),
 *  and fakes in tests. Throwing is how an adapter says it could not judge. */
export interface RiskJudge {
  /** Stable label for logs and provenance, e.g. "jev:jev-latest". */
  readonly id: string;
  judge(req: RiskJudgeRequest, signal?: AbortSignal): Promise<RiskJudgment>;
}

// -------------------------------------------------------------------------------------------
// Config
// -------------------------------------------------------------------------------------------

/** `policy.risk.judge` with every default filled in (the block itself is optional). */
export function resolveRiskJudgeConfig(policy: Pick<Policy, 'risk'>): RiskJudgeConfig {
  return RiskJudgeConfig.parse(policy.risk.judge ?? {});
}

// -------------------------------------------------------------------------------------------
// Which actions are judged
// -------------------------------------------------------------------------------------------

/** Budget, in characters, for the page context a judge sees: `target.nearby` plus the page-text
 *  excerpt together. */
export const PAGE_CONTEXT_MAX_CHARS = 2000;
/** Share of {@link PAGE_CONTEXT_MAX_CHARS} the nearby-controls list may use at most. */
export const NEARBY_MAX_CHARS = 600;

type ActionLike = SurfaceAction | Action;

/** Keys that activate a focused control: Enter submits a form, Space presses a focused button. */
const COMMITTING_KEYS: ReadonlySet<string> = new Set(['Enter', 'NumpadEnter', ' ', 'Space', 'Spacebar']);

/**
 * Actions that can commit something: click, select, press Enter/NumpadEnter/Space, type with
 * `pressEnter`, dismiss_dialog with `accept: true`, and navigate. Plain type, extract, wait,
 * switch_frame and other keys are never sent to a judge.
 */
export function isJudgeableAction(action: ActionLike): boolean {
  switch (action.type) {
    case 'click':
    case 'select':
    case 'navigate':
      return true;
    case 'press':
      return COMMITTING_KEYS.has(action.key);
    case 'type':
      return action.pressEnter === true;
    case 'dismiss_dialog':
      return action.accept === true;
    case 'extract':
    case 'wait':
    case 'switch_frame':
      return false;
    default: {
      const exhaustive: never = action;
      throw new Error(`isJudgeableAction: unhandled action ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** The value-free part of an action that a judge may see. */
export function judgeActionOf(action: ActionLike): RiskJudgeAction {
  switch (action.type) {
    case 'press':
      return { type: 'press', key: action.key };
    case 'dismiss_dialog':
      return { type: 'dismiss_dialog', accept: action.accept };
    case 'navigate':
      return { type: 'navigate', url: action.url };
    case 'type':
      return action.pressEnter === true ? { type: 'type', pressEnter: true } : { type: 'type' };
    default:
      return { type: action.type };
  }
}

/** Trims, collapses whitespace and caps a string; `undefined` stays `undefined`. */
export function capText(s: string | undefined, max: number): string | undefined {
  if (s === undefined) return undefined;
  const collapsed = s.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

/** Whitespace-collapses `text` and, when it is longer than `max`, keeps its head and its tail
 *  (where a page's submit controls and their consequences usually sit) around an ellipsis. Call
 *  it on already-scrubbed text. */
export function capDigest(text: string | undefined, max: number): string | undefined {
  if (text === undefined) return undefined;
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= max) return collapsed;
  const marker = ' … ';
  const room = Math.max(0, max - marker.length);
  const head = Math.ceil(room / 2);
  return `${collapsed.slice(0, head)}${marker}${collapsed.slice(collapsed.length - (room - head))}`;
}

/** A frame path as one readable string: "top" for the top document, else "main > content". */
export function frameLabel(frame: FramePath): string {
  if (frame.length === 0) return 'top';
  return frame.map((h) => h.name ?? h.urlPattern ?? `#${String(h.index ?? '?')}`).join(' > ');
}

/**
 * The names (and differing texts) of the elements nearest `target` in the same frame, nearest
 * first by bounding-box centre, each passed through `scrub` and capped, until `maxChars` is used.
 * This is the "what is around the button" a judge needs to tell a confirm from a cancel.
 */
export function nearbyLabels(target: ObservedElement, elements: readonly ObservedElement[], scrub: (s: string) => string, maxChars: number = NEARBY_MAX_CHARS): string[] {
  const sameFrame = JSON.stringify(target.frame);
  const cx = (e: ObservedElement): number => e.bbox.x + e.bbox.w / 2;
  const cy = (e: ObservedElement): number => e.bbox.y + e.bbox.h / 2;
  const others = elements
    .filter((e) => e.ref !== target.ref && JSON.stringify(e.frame) === sameFrame)
    .map((e) => ({ e, d: Math.hypot(cx(e) - cx(target), cy(e) - cy(target)) }))
    .sort((a, b) => a.d - b.d);
  const out: string[] = [];
  let used = 0;
  for (const { e } of others) {
    const raw = e.text !== undefined && e.text !== '' && e.text !== e.name ? `${e.name} | ${e.text}` : e.name;
    const label = capText(scrub(raw), 80);
    if (label === undefined || label === '') continue;
    if (used + label.length > maxChars) break;
    out.push(label);
    used += label.length;
  }
  return out;
}

/** Stable fingerprint of a (scrubbed) text, for {@link GuardedRiskJudge.judge}'s cache context. */
export function textFingerprint(text: string): string {
  return createHash('sha256').update(text.replace(/\s+/g, ' ').trim()).digest('hex');
}

// -------------------------------------------------------------------------------------------
// Combining a judgment with the lexical risk
// -------------------------------------------------------------------------------------------

/** What a guarded judge call produced: a judgment, or a typed "could not judge". */
export type RiskJudgeOutcome =
  | { kind: 'judged'; judgment: RiskJudgment; cached: boolean }
  | { kind: 'unavailable'; reason: string };

/** Result of {@link combineRisk}. */
export interface RiskCombination {
  /** The effective risk to act on and record. Never lower than `lexical`. */
  risk: RiskClass;
  /** True when `risk` is higher than `lexical`. */
  raised: boolean;
  /** What the judgment alone maps to under the threshold (absent when there was none). */
  judgedRisk?: RiskClass;
  /** advise mode: what enforce mode would have done. */
  wouldRaise?: boolean;
  reason: string;
}

function maxRisk(a: RiskClass, b: RiskClass): RiskClass {
  return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b;
}

/** Maps a judgment to a risk class under `threshold`: irreversible iff `pIrreversible >=
 *  threshold`; otherwise the judge's own label, capped at reversible. */
export function judgedRiskClass(judgment: RiskJudgment, threshold: number): RiskClass {
  if (judgment.pIrreversible >= threshold) return 'irreversible';
  return judgment.risk === 'irreversible' ? 'reversible' : judgment.risk;
}

/**
 * Combines the lexical risk with a judge outcome under the policy config. Pure. Raise-only: the
 * result is never below `lexical`. `off` and `advise` return `lexical` unchanged (advise reports
 * `wouldRaise`); `enforce` returns `max(lexical, judged)`, and an unavailable judge counts as
 * irreversible under `fail_closed` and as no opinion under `fail_open`.
 */
export function combineRisk(lexical: RiskClass, outcome: RiskJudgeOutcome | undefined, config: RiskJudgeConfig): RiskCombination {
  if (config.mode === 'off' || outcome === undefined) {
    return { risk: lexical, raised: false, reason: 'risk judge not consulted' };
  }
  let candidate: RiskClass;
  let judgedRisk: RiskClass | undefined;
  let why: string;
  if (outcome.kind === 'judged') {
    judgedRisk = judgedRiskClass(outcome.judgment, config.irreversibleThreshold);
    candidate = judgedRisk;
    why = `judged ${judgedRisk} (pIrreversible=${outcome.judgment.pIrreversible.toFixed(2)}, threshold ${config.irreversibleThreshold})`;
  } else if (config.onError === 'fail_closed') {
    candidate = 'irreversible';
    why = `risk judge unavailable (${outcome.reason}); fail_closed treats the action as irreversible`;
  } else {
    candidate = lexical;
    why = `risk judge unavailable (${outcome.reason}); fail_open keeps the lexical risk`;
  }
  const enforced = maxRisk(lexical, candidate);
  const wouldRaise = RISK_ORDER[enforced] > RISK_ORDER[lexical];
  if (config.mode === 'advise') {
    return { risk: lexical, raised: false, ...(judgedRisk !== undefined ? { judgedRisk } : {}), wouldRaise, reason: `advise: ${why}` };
  }
  return { risk: enforced, raised: wouldRaise, ...(judgedRisk !== undefined ? { judgedRisk } : {}), reason: why };
}

// -------------------------------------------------------------------------------------------
// Timeout + typed errors + per-run cache
// -------------------------------------------------------------------------------------------

/** A {@link RiskJudge} wrapped by {@link createGuardedJudge}: never throws, never hangs past its
 *  timeout, and judges an identical request once per instance. */
export interface GuardedRiskJudge {
  readonly id: string;
  /**
   * `cacheContext` joins the cache key without being sent to the judge: the caller passes a
   * {@link textFingerprint} of the full scrubbed page text, so two pages whose capped excerpts
   * coincide are still judged separately.
   */
  judge(req: RiskJudgeRequest, cacheContext?: string): Promise<RiskJudgeOutcome>;
  /** Calls that reached the underlying judge (cache hits excluded). */
  readonly calls: number;
  readonly cacheHits: number;
  readonly unavailable: number;
}

/** Options for {@link createGuardedJudge}. */
export interface GuardedJudgeOptions {
  timeoutMs: number;
  /** Default true. */
  cache?: boolean;
}

/** Normalized cache key: the whole request except the free-text `why`, plus `cacheContext`, in a
 *  fixed field order. Text is whitespace-collapsed and case-folded; URLs and the key are compared
 *  exactly (a path or query can differ only in case and mean something else). */
export function judgeCacheKey(req: RiskJudgeRequest, cacheContext?: string): string {
  const n = (s: string | undefined): string | null => (s === undefined ? null : s.replace(/\s+/g, ' ').trim().toLowerCase());
  const exact = (s: string | undefined): string | null => (s === undefined ? null : s.trim());
  return JSON.stringify([
    req.phase,
    req.action.type,
    exact(req.action.key),
    req.action.accept ?? null,
    exact(req.action.url),
    req.action.pressEnter ?? null,
    n(req.target?.name),
    n(req.target?.text),
    n(req.target?.role),
    n(req.target?.tag),
    n(req.target?.description),
    exact(req.target?.frame),
    (req.target?.nearby ?? []).map(n),
    exact(req.page.url),
    n(req.page.title),
    n(req.page.textDigest),
    n(req.page.dialogMessage),
    n(req.goal),
    req.lexicalRisk,
    cacheContext ?? null,
  ]);
}

const REASON_MAX_CHARS = 200;

/** A printable reason for a thrown value. Never throws itself: a null-prototype object or a
 *  hostile `toString`/`name`/`message` getter falls back to a fixed string. */
function describeError(err: unknown): string {
  let message: string;
  try {
    message = err instanceof Error ? `${String(err.name)}: ${String(err.message)}` : String(err);
  } catch {
    message = 'judge failed with an unprintable error';
  }
  if (typeof message !== 'string') message = 'judge failed with an unprintable error';
  return message.length > REASON_MAX_CHARS ? `${message.slice(0, REASON_MAX_CHARS)}…` : message;
}

function isValidJudgment(j: unknown): j is RiskJudgment {
  if (typeof j !== 'object' || j === null) return false;
  const r = j as Partial<RiskJudgment>;
  return (
    (r.risk === 'read' || r.risk === 'reversible' || r.risk === 'irreversible') &&
    typeof r.pIrreversible === 'number' &&
    Number.isFinite(r.pIrreversible) &&
    r.pIrreversible >= 0 &&
    r.pIrreversible <= 1 &&
    (r.rationale === undefined || typeof r.rationale === 'string')
  );
}

/** Wraps `judge` with a timeout (the signal is aborted when it fires), turns every error or
 *  malformed answer into `{ kind: 'unavailable' }`, and caches judged outcomes per instance. */
export function createGuardedJudge(judge: RiskJudge, opts: GuardedJudgeOptions): GuardedRiskJudge {
  const cache = new Map<string, RiskJudgment>();
  const useCache = opts.cache !== false;
  let calls = 0;
  let cacheHits = 0;
  let unavailable = 0;

  async function guardedJudge(req: RiskJudgeRequest, cacheContext?: string): Promise<RiskJudgeOutcome> {
    const key = judgeCacheKey(req, cacheContext);
    const hit = useCache ? cache.get(key) : undefined;
    if (hit !== undefined) {
      cacheHits += 1;
      return { kind: 'judged', judgment: hit, cached: true };
    }
    calls += 1;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<{ timedOut: true }>((resolve) => {
      timer = setTimeout(() => {
        controller.abort(new Error(`timed out after ${opts.timeoutMs}ms`));
        resolve({ timedOut: true });
      }, opts.timeoutMs);
    });
    try {
      const raced = await Promise.race([judge.judge(req, controller.signal).then((judgment) => ({ judgment })), timeout]);
      if ('timedOut' in raced) {
        unavailable += 1;
        return { kind: 'unavailable', reason: `timed out after ${opts.timeoutMs}ms` };
      }
      if (!isValidJudgment(raced.judgment)) {
        unavailable += 1;
        return { kind: 'unavailable', reason: 'malformed judgment (risk/pIrreversible out of range)' };
      }
      const judgment: RiskJudgment = {
        risk: raced.judgment.risk,
        pIrreversible: raced.judgment.pIrreversible,
        ...(raced.judgment.rationale !== undefined ? { rationale: capText(raced.judgment.rationale, 500) } : {}),
      };
      if (useCache) cache.set(key, judgment);
      return { kind: 'judged', judgment, cached: false };
    } catch (err) {
      unavailable += 1;
      return { kind: 'unavailable', reason: describeError(err) };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  return {
    id: judge.id,
    judge: guardedJudge,
    get calls() {
      return calls;
    },
    get cacheHits() {
      return cacheHits;
    },
    get unavailable() {
      return unavailable;
    },
  };
}

// -------------------------------------------------------------------------------------------
// Audit: judging a recorded capability step statically
// -------------------------------------------------------------------------------------------

/** The texts on a recorded target, as one `target` block for a judge request. */
function staticTarget(descriptor: TargetDescriptor): RiskJudgeRequest['target'] {
  const locatorTexts = descriptor.locators.map((l) => {
    const st = l.strategy;
    return st.kind === 'text' ? st.text : st.kind === 'label' ? st.label : st.kind === 'role' ? st.name : undefined;
  });
  const text = [descriptor.snapshot?.text, ...locatorTexts].filter((t): t is string => t !== undefined && t !== '');
  return {
    description: descriptor.description,
    ...(descriptor.snapshot?.name !== undefined ? { name: descriptor.snapshot.name } : {}),
    ...(text.length > 0 ? { text: [...new Set(text)].join(' | ') } : {}),
    ...(descriptor.snapshot?.role !== undefined ? { role: descriptor.snapshot.role } : {}),
    ...(descriptor.snapshot?.tag !== undefined ? { tag: descriptor.snapshot.tag } : {}),
    frame: frameLabel(descriptor.frame),
  };
}

/** Best static guess at the page a step runs on: the most recent navigate before it, else the
 *  capability's entry URL. */
export function staticPageUrl(capability: Capability, stepIndex: number): string {
  for (let i = stepIndex - 1; i >= 0; i--) {
    const a = capability.steps[i]!.action;
    if (a.type === 'navigate') return a.url;
  }
  return capability.app.entryUrl;
}

/**
 * The lexical risk of a recorded step, the way replay would see it before the live page is in
 * view: the guard's classification over every descriptor text (description, snapshot, locator
 * texts), maximised. The step's declared risk is not folded in; callers compare against it. Pure.
 */
export function staticLexicalRisk(guard: Pick<PolicyGuard, 'classifyRisk'>, step: Pick<Step, 'action'>, pageUrl: string): RiskClass {
  const action = step.action;
  let risk: RiskClass = 'read';
  if ('target' in action) {
    for (const t of descriptorTexts(action.target)) {
      risk = maxRisk(risk, guard.classifyRisk(action, { targetName: t, currentUrl: pageUrl }));
    }
  } else {
    risk = guard.classifyRisk(action, { currentUrl: pageUrl });
  }
  return risk;
}

/**
 * A judge request for one recorded step, built from its descriptor texts, its `why` (the step
 * name, which the recorder derives from it), and the capability's name and description. The
 * caller scrubs it (`scrub`) before it leaves the process. `undefined` for a step that is not
 * judgeable ({@link isJudgeableAction}).
 */
export function judgeRequestForStep(
  capability: Capability,
  stepIndex: number,
  lexicalRisk: RiskClass,
  scrub: (s: string) => string = (s) => s,
): RiskJudgeRequest | undefined {
  const step = capability.steps[stepIndex];
  if (step === undefined) return undefined;
  return judgeRequestForAction(capability, step.action, step.name, staticPageUrl(capability, stepIndex), lexicalRisk, scrub);
}

/**
 * A judge request for any recorded action -- a base step, a tenant override's extra step, or a
 * recovery-rule action -- from its descriptor texts, a stated reason (`why`), the page it most
 * likely runs on, and the capability's name and description. Every string goes through `scrub`.
 * `undefined` for an action that is not judgeable ({@link isJudgeableAction}).
 */
export function judgeRequestForAction(
  capability: Capability,
  recorded: Action,
  why: string,
  pageUrl: string,
  lexicalRisk: RiskClass,
  scrub: (s: string) => string = (s) => s,
): RiskJudgeRequest | undefined {
  if (!isJudgeableAction(recorded)) return undefined;
  const target = 'target' in recorded ? staticTarget(recorded.target) : undefined;
  const s = (v: string | undefined): string | undefined => (v === undefined ? undefined : scrub(v));
  const action = judgeActionOf(recorded);
  return {
    phase: 'audit',
    action: { ...action, ...(action.url !== undefined ? { url: scrub(action.url) } : {}) },
    ...(target !== undefined
      ? {
          target: Object.fromEntries(Object.entries(target).map(([k, v]) => [k, typeof v === 'string' ? s(v) : v])) as RiskJudgeRequest['target'],
        }
      : {}),
    page: { url: scrub(pageUrl) },
    goal: scrub(`${capability.name}: ${capability.description}`),
    why: scrub(why),
    lexicalRisk,
  };
}

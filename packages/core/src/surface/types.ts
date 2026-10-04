/**
 * The Surface interface: the seam between "how the runtime perceives and acts" and "the recorded flow".
 * Replay, agent, and session code depend on this, never on Playwright directly.
 */
import type {
  HumanAction,
  Action,
  Condition,
  FailureCode,
  FramePath,
  LocatorStrategyKind,
  TargetDescriptor,
} from '../schema/index.js';

/** Axis-aligned bounding box in viewport pixels, top-document coordinates. */
export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One interactive or informative element as `observe()` reports it. */
export interface ObservedElement {
  /** "e12", stable within one observation only. */
  ref: string;
  /** ARIA role or inferred ("clickable", "textbox", "generic"). */
  role: string;
  /** Accessible name or best-effort label. */
  name: string;
  /** Trimmed visible text, max 120 chars. */
  text?: string;
  tag: string;
  /** REDACTED for password fields. */
  value?: string;
  /** Viewport px, top-document coordinates. */
  bbox: BBox;
  frame: FramePath;
  enabled: boolean;
  /** Synthesized fallback chain for this element. Never carries masked text (see surface/mask.ts). */
  descriptor: TargetDescriptor;
  /**
   * Set when a screen-mask rule hides this element (docs/design/screen-masking.md): its `text` and
   * `value` are a `[MASKED:<kind>]` placeholder (an empty field's value stays ''), and so is its
   * `name` unless it is a field (its name is its label) or a control (it keeps its verb:
   * `Delete [MASKED:member]`). It is still addressable by ref, and `readText` returns its real text.
   */
  masked?: true;
}

/**
 * An observed element's own, row and container text, REAL (unmasked), returned only by
 * {@link Surface.recordContextOf}. Discovery's recorder compares it with the run's own
 * non-sensitive input values to decide whether the element belongs to the record an input names,
 * and builds locators from the input placeholders it finds there. It is never part of an
 * `Observation` (so no observation, prompt, transcript, log, escalation or artifact can carry it),
 * never shown to the model, never logged and never persisted. Strings capped at 300 characters.
 */
export interface RecordContext {
  /** The element's own rendered text. */
  ownText: string;
  /**
   * Set when the element's own text holds masked content (screen masking): the element is masked,
   * or a masked text occurs in it. The recorder then never builds a locator quoting the own text.
   */
  ownTextMasked?: true;
  /**
   * The element's table row's other cells with text: where the element sits relative to each, its
   * column (`tag`, `index` among the row's children; absent from an older agent), the static text
   * every data cell of that column shares (`shared`: "Order " in "Order 2001"; three or more
   * cells), and whether the cell holds masked content (`masked`, set by the surface).
   */
  rowCells: {
    text: string;
    relation: 'right-of' | 'left-of';
    tag?: string;
    index?: number;
    shared?: { prefix: string; suffix: string };
    masked?: true;
  }[];
  /** The element's own cell (`td`/`th`, index among its row's children); null outside a table row. */
  cell: { tag: string; index: number } | null;
  /** Text of the smallest ancestor grouping the element with two other text blocks; '' when none. */
  containerText: string;
  /**
   * With a row anchor (the element's label cell): false when that label's text anchors more than
   * once in the document (several cards, each with a "Savings Balance" row). Absent from an older agent.
   */
  labelUnique?: boolean;
  /** The element's tag, and its role when it is a real ARIA role (for building a relative locator). */
  tag: string;
  role?: string;
}

/** Which text {@link Surface.readRecordText} reads: the element's record container, or the whole frame. */
export type RecordTextWithin = 'container' | 'page';

/**
 * Outcome of `Surface.readRecordText`. `scope` is what the text actually is: `container` for the
 * smallest ancestor that groups the element with at least two other text blocks (a card, a detail
 * panel, a table), `page` for the whole frame, which is what a `container` read falls back to when
 * the element has no such ancestor. The text is REAL (unmasked) and is for a boolean comparison
 * only: a caller never logs, shows or persists it.
 */
export type RecordTextResult = { ok: true; text: string; scope: RecordTextWithin } | { ok: false; error: { code: FailureCode; message: string } };

/** A native dialog (alert/confirm/prompt) currently open on the surface. */
export interface ObservedDialog {
  type: 'alert' | 'confirm' | 'prompt';
  message: string;
}

/** A snapshot of the current screen: URL, title, visible elements, frames, and any open dialog. */
export interface Observation {
  url: string;
  title: string;
  /**
   * Absent when the surface deliberately took no screenshot: the page matches the policy's
   * `omitScreenshotUrlPatterns`, or the screen mask could not be computed (fail closed).
   */
  screenshotPng?: Buffer;
  /** Interactive + informative elements, then text values, capped (e.g. 150). */
  elements: ObservedElement[];
  /** How many more elements the surface found than `elements` holds (dropped by its cap); absent or 0 when none. */
  elementsOmitted?: number;
  frames: { path: FramePath; url: string }[];
  dialog?: ObservedDialog;
  /** Visible text, whitespace-collapsed, capped, with masked content replaced by placeholders. */
  textDigest: string;
}

/** A target as the surface receives it: an observation ref (agent) or a descriptor (replay). */
export type ResolvedTarget = { ref: string } | TargetDescriptor;

/** Narrows a `ResolvedTarget` to the `{ ref }` case. */
export function isRefTarget(t: ResolvedTarget): t is { ref: string } {
  return typeof (t as { ref?: unknown }).ref === 'string';
}

type BindTargetsAndValues<A> = A extends { target: TargetDescriptor }
  ? Omit<A, 'target' | 'value'> & { target: ResolvedTarget } & (A extends { value: unknown } ? { value: string } : unknown)
  : A;

/**
 * Action with every `target` as ResolvedTarget and every `value` already bound to a plain string.
 * Secrets are bound by the caller at the last moment and never logged.
 */
export type SurfaceAction = BindTargetsAndValues<Action>;

/** Per-call options for `act`. Surfaces that do not enforce policy ignore them. */
export interface ActOptions {
  /**
   * The caller has already decided an irreversible action may run (approved capability, or a
   * human confirmed an escalation). Only the policy-enforcing wrapper reads this; without it an
   * action classified irreversible is refused with `policy_violation`.
   */
  allowIrreversible?: boolean;
}

/** What a ref points at, for policy classification. Never carries form values. */
export interface RefDescription {
  tag?: string;
  role?: string;
  name?: string;
  text?: string;
  /** URL of the frame holding the element (for irreversibleUrlPatterns). */
  frameUrl?: string;
  /**
   * Screen masking: when `name`/`text` are the masked view, the real ones, for risk
   * classification only. A policy wrapper classifies on these and never logs or shows them.
   */
  classifyName?: string;
  classifyText?: string;
}

/** Outcome of one `Surface.act` call. `navigated` is true when the action changed the current screen or URL. */
export interface ActResult {
  ok: boolean;
  error?: { code: FailureCode; message: string };
  navigated?: boolean;
}

/**
 * One locator of a chain that did not produce the element, and why. `ambiguous` marks a miss that
 * was an ambiguity: the locator (or a relative locator's anchor) matched `matches` elements, two or
 * more, and the surface could not tell which was meant. Every other miss (no match, an unsupported
 * kind, an error) leaves both unset.
 */
export interface TriedStrategy {
  strategyKind: string;
  error: string;
  ambiguous?: true;
  /** With `ambiguous`: how many candidates matched. */
  matches?: number;
}

/**
 * Outcome of resolving a `TargetDescriptor`. Found: which locator matched (and at what index),
 * plus `tried`, the locators tried before it in chain order, so `tried[i]` is `locators[i]` and
 * `tried.length === strategyIndex`. Replay reads it to refuse a positional fallback that would
 * settle an ambiguity (see `positionalFallbackRefusal`). Not found: every locator that failed and why.
 */
export type Resolution =
  | { found: true; ref: string; strategyIndex: number; strategyKind: LocatorStrategyKind; tried: TriedStrategy[] }
  | { found: false; tried: TriedStrategy[] };

/**
 * Outcome of `Surface.readText`. `masked`: the text read touches content the surface masks (the
 * element, an ancestor or a descendant is painted over, or the text contains masked text). A
 * caller that shows the text to a model must withhold it, and one that persists it must redact it.
 */
export type ReadTextResult = { ok: true; text: string; masked?: true } | { ok: false; error: { code: FailureCode; message: string } };

/** Options for `Surface.check`/`waitFor`. */
export interface CheckOptions {
  /**
   * 'masked': evaluate text against the masked view (what `observe()` reports), not the real page.
   * Discovery uses it for model-supplied text, which can never legitimately name hidden content;
   * replay evaluates recorded conditions against the real page (the default).
   */
  view?: 'real' | 'masked';
  /**
   * The condition as recorded, before input binding; it has the same shape as the bound one being
   * checked. An element condition judges which locators are positional on this form (a css
   * attribute holding `{input.memberId}` is identity; once bound to `12345` it would read as a
   * position). Without it, or where the shapes differ, the bound target is judged as it is.
   */
  recorded?: Condition;
}

/** A human's action observed while they hold control of the live session. Values are never carried. */
export interface HumanActionCapture {
  start(onAction: (action: HumanAction) => void): Promise<void>;
  stop(): Promise<void>;
}

/**
 * The seam every automation and replay path acts through instead of touching a real browser or
 * app directly. Implemented by `FakeSurface`, the Playwright surface (`@cu/adapter-playwright`) and
 * the Windows UI Automation surface (`@cu/adapter-desktop`).
 */
export interface Surface {
  observe(): Promise<Observation>;
  resolve(target: TargetDescriptor, timeoutMs: number): Promise<Resolution>;
  act(action: SurfaceAction, timeoutMs: number, opts?: ActOptions): Promise<ActResult>;
  /** Visible text (or form value) of one element; used by `extract` actions. The real text, even for a masked element. */
  readText(target: ResolvedTarget, timeoutMs: number): Promise<ReadTextResult>;
  /** Present when the surface can record what a human does in the live session (handoff). */
  humanCapture?: HumanActionCapture;
  check(condition: Condition, opts?: CheckOptions): Promise<boolean>;
  waitFor(condition: Condition, timeoutMs: number, opts?: CheckOptions): Promise<boolean>;
  /** Masked PNG; the `omittedScreenshotPng()` placeholder when the surface must not take one. */
  screenshot(): Promise<Buffer>;
  /** For failure evidence; may be truncated. Masked content is replaced like the screenshot's. */
  domSnapshot(): Promise<string>;
  currentUrl(): Promise<string>;
  /**
   * Optional: URLs of the top document and every frame, top first. The policy wrapper uses it
   * to detect off-allowlist navigation in any frame; falls back to `currentUrl()` when absent.
   */
  frameUrls?(): Promise<string[]>;
  /**
   * Optional: what a ref (from `observe` or `resolve`) currently points at, so the policy wrapper
   * can classify risk for `{ref}` targets. Undefined for unknown/stale refs.
   */
  describeRef?(ref: string): Promise<RefDescription | undefined>;
  /**
   * True when two refs (an observed one, one `resolve()` returned) point at the very same element.
   * Discovery uses it to check, before recording, that a target scoped to a run input finds the
   * element that was acted on. Optional: without it, discovery compares `describeRef` results.
   */
  isSameElement?(refA: string, refB: string): Promise<boolean>;
  /**
   * The {@link RecordContext} of an element of the LATEST observation (`e<n>` refs only), or
   * undefined (unknown ref, a surface that computes none). For discovery's recorder only: a policy
   * wrapper forwards it, the operator's surface does not expose it, and nothing logs it.
   */
  recordContextOf?(ref: string): RecordContext | undefined;
  /**
   * Optional: the visible text of an element's record container (`within: 'container'`, which
   * falls back to the whole frame when the element has no container) or of its whole frame
   * (`within: 'page'`), for a record identity check on a read (an `extract` step's `identity`).
   * Accepts an observation ref, a resolution ref or a descriptor. The text is real, never masked;
   * the caller compares it and discards it. Absent on a surface that cannot say: replay then skips
   * the check and discovery records none.
   */
  readRecordText?(target: ResolvedTarget, within: RecordTextWithin, timeoutMs: number): Promise<RecordTextResult>;
  close(): Promise<void>;
}

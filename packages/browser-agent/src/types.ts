/**
 * Public API of @cu/browser-agent: the shape of `window.__cuAgent` and of everything it returns.
 * Types only. The runtime is agent.ts plus the modules it composes (naming, selectors, enumerate,
 * capture, sink). Everything here is plain JSON except `EnumerateResult.els` (live elements).
 */

/** An element's border box in CSS px, relative to its own frame's viewport. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A frame's own viewport size (`innerWidth` / `innerHeight`). */
export interface Viewport {
  width: number;
  height: number;
}

/** Inferred role. `real` is true only for a genuine ARIA role (not 'clickable', 'label', 'generic'). */
export interface RoleInfo {
  role: string;
  real: boolean;
}

/** How a form control's label was found. */
export type LabelKind = 'aria' | 'label' | 'adjacent-cell';

/** A control's label text and how it was found. */
export interface LabelInfo {
  text: string;
  kind: LabelKind;
}

/** Which rule of the accessible-name priority chain produced the name ('' when none did). */
export type NameSource =
  | ''
  | 'aria-label'
  | 'aria-labelledby'
  | 'label'
  | 'alt'
  | 'title'
  | 'placeholder'
  | 'adjacent-cell'
  | 'text'
  | 'attr';

/** An accessible name and the rule that produced it. */
export interface AccessibleName {
  name: string;
  source: NameSource;
}

/** Options for the text and naming functions. */
export interface TextOptions {
  /**
   * When true, no `.value` property is read: a button-type input (button, submit, reset) is
   * labelled from its `value` attribute instead. An editable region, or an element containing a
   * select, textarea or contenteditable, has no text (its innerText can hold typed text or every
   * option label). Capture always sets this.
   */
  valueFree?: boolean;
}

/** What `describe(el)` reports about one element. Never a field's value. */
export interface ElementDescription {
  tag: string;
  role: string;
  realRole: boolean;
  name: string;
  nameSource: NameSource;
  text: string;
  selector: string;
  label: string;
  labelKind: '' | LabelKind;
  inputType: string;
}

/**
 * Enumeration group: actionable controls; text the legacy rules select (headings, label/value
 * cells, message cells, short bold texts, error items); or any other leaf text block (a price in a
 * <div>, a status in a <span>), listed last and capped by `priority`. See leaves.ts.
 */
export type ElementGroup = 'interactive' | 'informative' | 'text';

/**
 * An anchor from an element's container (the nearest ancestor holding other unique text, such as
 * a product card's name), verified at enumeration time to pick the element back out through a
 * 'relative' locator: the anchor text, this relation, the element's tag (and role when real),
 * and `selector` when non-empty.
 */
export interface ContainerAnchor {
  text: string;
  relation: 'below' | 'right-of' | 'above' | 'left-of';
  /** CSS selector every candidate must also match (`div.price`, `div.pricebar > div`); '' for none. */
  selector: string;
  /** The container's stable class selector: only candidates inside `anchor.closest(within)` count. */
  within: string;
}

/**
 * One enumerated element: identity, geometry, and every input descriptor synthesis needs, so a
 * driver builds locators without another round trip. Same fields and semantics as the driver's
 * legacy in-page library.
 */
export interface ElementData {
  tag: string;
  role: string;
  roleReal: boolean;
  name: string;
  nameSource: NameSource;
  /** True when the winning raw name was longer than the 80-char name cap. */
  nameTruncated: boolean;
  text: string;
  /** Field value. `[REDACTED]` for a non-empty password; absent for buttons, files, hidden. */
  value?: string;
  inputType: string;
  enabled: boolean;
  rect: Rect;
  group: ElementGroup;
  labelKind: '' | LabelKind;
  labelText: string;
  /** True when labelText is shorter than the label it came from (an adjacent-cell label over 80 chars, or any label over the 300-char field cap). */
  labelTruncated: boolean;
  /** Label text in the cell to the left (legacy table layouts), for a 'right-of' relative locator. */
  rowAnchorText: string;
  /** Nearest short text directly above, for a 'below' relative locator ('' when rowAnchorText is set). */
  aboveAnchorText: string;
  /** Own text for a text locator; for a clickable row, its first non-empty cell's text. */
  textLocatorCandidate: string;
  /** True when the text locator must not carry a tag (the resolver climbs from the cell to the row). */
  textLocatorTagOmit: boolean;
  /** True when textLocatorCandidate matches exactly one element (by closest clickable) in this document. */
  textUnique: boolean;
  /** Structural CSS selector, unique in this document, never a generated id; '' when none fits. For a 'text' leaf, a unique class selector is preferred. */
  cssSelector: string;
  /** Cap priority within the 'text' group, 0 kept first (see leaves.ts); 0 for the other groups. */
  priority: number;
  /** Verified anchors from the element's container, best first; empty when rowAnchorText is set or none was found. */
  containerAnchors: ContainerAnchor[];
  /** True when the element's box intersects its frame's viewport (what a screenshot of the frame shows); the cap prefers these. */
  inViewport: boolean;
  /** True when `rowAnchorText` comes from a cell that reads as a label (a th, a label, a colon, a
   *  two-cell label/value row, a constant column), not the previous column's value. A driver
   *  emits a row-anchored locator only then. */
  rowAnchorIsLabel: boolean;
  /**
   * Used ONLY by a discovery recorder to decide whether the element belongs to the record a run
   * input names (its own text, its row's other cells, its own column, a tight container's text).
   * Never shown to the model and never persisted in an artifact or evidence; a driver keeps it out
   * of everything but that decision. Strings capped at 300 characters.
   */
  recordContext: RecordContext;
}

/** See {@link ElementData.recordContext}. */
export interface RecordContext {
  ownText: string;
  /**
   * The element's row's other cells with text, each with where the element sits relative to it,
   * its column (`tag`, index among the row's children), and the text every data cell of that
   * column shares (`shared`: "Order " in "Order 2001"), when the column has three or more.
   */
  rowCells: { text: string; relation: 'right-of' | 'left-of'; tag: string; index: number; shared?: { prefix: string; suffix: string } }[];
  /** The element's own cell in its row (`td`/`th` and its index among the row's children); null outside a table row. */
  cell: { tag: string; index: number } | null;
  /** Text of the smallest ancestor grouping the element with two other text blocks (60 elements at most); '' when none. */
  containerText: string;
  /** With a row anchor (the element's label cell): whether that label's text anchors only once in the document. */
  labelUnique?: boolean;
}

/** Result of `enumerate()` for this document. `data[i]` describes `els[i]`. */
export interface EnumerateResult {
  data: ElementData[];
  /** Live elements, parallel to `data`. A driver reads them as handles; never JSON-serialize this. */
  els: Element[];
  viewport: Viewport;
  /** `document.body.innerText`, whitespace-collapsed, capped at `maxBodyTextChars`. */
  bodyText: string;
  /** Entries the `maxElements` cap dropped; absent when nothing was dropped. */
  omitted?: number;
}

/** Options for `enumerate()`. With the defaults, the interactive and informative entries are the legacy library's, in its order; text leaves follow them. */
export interface EnumerateOptions {
  /**
   * Keep at most this many entries. A third of the cap (or fewer, when there are fewer) is held
   * for text leaves, so controls cannot crowd every value out; the rest goes to interactive, then
   * informative entries; whatever is left over goes to more text leaves. Within each tier, entries
   * inside the viewport come first, then (text) by priority, then document order; the kept
   * entries are returned in document order. Default: no cap.
   */
  maxElements?: number;
  /** Cap on `bodyText`. Default 8000 (the driver's text-digest cap). */
  maxBodyTextChars?: number;
}

/** What a driver asks the page to plan. Everything here is policy, never a run value. */
export interface MaskPlanOptions {
  /** Attribute that marks a hidden element; its value is `nonce`. */
  attr: string;
  /** Per-plan token, so a page cannot pre-mark (or un-mark) elements of a later plan. */
  nonce: string;
  maskInputs: 'all' | 'typed';
  /** CSS selectors always hidden. */
  selectors: string[];
  /** Regex sources (compiled with 'i'): the value associated with a matching label is hidden. */
  labels: string[];
  /** Regex sources (compiled with 'i'): an element whose own text matches is hidden. Empty = rule off. */
  textPatterns: { name: string; regex: string }[];
}

/** One piece of hidden text and the rule that hid it. */
export interface MaskedText {
  text: string;
  kind: string;
  /** Part of a hidden element (an inner element's own text), not the whole of what was hidden. */
  part?: boolean;
}

/** One stretch of a block's text to hide: `[start, end)` in `MaskPlanResult.blocks[block]`. */
export interface MaskRange {
  block: number;
  start: number;
  end: number;
}

/** What `maskPlan` found and did. */
export interface MaskPlanResult {
  /** Elements marked by this plan. */
  marked: number;
  /** Every hidden piece of text, whitespace-collapsed (whole hidden elements, their inner texts, hidden text ranges). */
  texts: MaskedText[];
  /** The text of every block of the document left visible (text nodes concatenated per block), for `maskMark`'s ranges. */
  blocks: string[];
  /** Value of every field left visible, for `maskMark`'s `fieldIdx`. */
  fields: string[];
  /** More candidates existed than were reported (the driver must fail closed). */
  truncated: boolean;
  /** Rules that could not be applied (invalid selector or regex). Non-empty = the plan failed. */
  errors: string[];
}

/** What `maskMark` hid. */
export interface MaskMarkResult {
  texts: MaskedText[];
}

/**
 * `maskPlan`, `enumerate` and the enumerated elements' mask kinds from ONE synchronous call, so the
 * page cannot change between the plan and the text the driver reads.
 */
export interface MaskObserveResult {
  plan: MaskPlanResult;
  enumeration: EnumerateResult;
  /** Per `enumeration.els[i]`: the kind of the mark on it or an ancestor ('password' for a password field), else null. */
  kinds: (string | null)[];
}

/**
 * Low-level helpers with the same names and semantics as the adapter's former in-page library, so
 * a driver's resolver can switch to `window.__cuAgent.lib` without behaviour change.
 */
export interface CuAgentLib {
  collapse(s: unknown): string;
  stripColon(s: unknown): string;
  isVisible(el: Element): boolean;
  inferRole(el: Element): RoleInfo;
  labelFor(el: Element): LabelInfo | null;
  adjacentCellLabel(el: Element): string;
  /** Visible form controls whose adjacent-cell label matches `label` (the inverse of `adjacentCellLabel`, via `labelFor`). */
  findAdjacentCellControls(label: string, exact: boolean): Element[];
  accessibleName(el: Element): AccessibleName;
  ownText(el: Element, max?: number): string;
  /** True when no visible descendant renders the same own text: `el` is the innermost element for that text. */
  isTextLeaf(el: Element, textCache?: Map<Element, string>): boolean;
  isInteractive(el: Element): boolean;
  closestClickable(el: Node | null): Element | null;
  structuralSelector(el: Element): string;
  describe(el: Element): ElementDescription;
  elementAtPoint(x: number, y: number): Element | null;
  rect(el: Element): Rect;
  enumerate(opts?: EnumerateOptions): EnumerateResult;
  /** Marks what a screenshot must paint over in this document (see mask.ts); marks stay until `maskClear`. */
  maskPlan(opts: MaskPlanOptions): MaskPlanResult;
  /** Hides block ranges and fields of the `nonce` plan a driver matched itself; `null` when that plan is gone. */
  maskMark(nonce: string, ranges: MaskRange[], fieldIdx: number[], kind: string): MaskMarkResult | null;
  /** `maskPlan` + `enumerate` + the enumerated elements' mask kinds, in one call (see `MaskObserveResult`). */
  maskObserve(opts: MaskPlanOptions, enumerateOpts?: EnumerateOptions): MaskObserveResult;
  /** `maskPlan` + the body's `innerText`, in one call: the text a condition is checked against is the text the plan saw. */
  maskObserveText(opts: MaskPlanOptions): { plan: MaskPlanResult; text: string };
  /**
   * After a capture: whether the document is exactly as the `nonce` plan left it (no node, text,
   * `value` or `alt` change, no `style` change inside marked content, the content fingerprint
   * unchanged, every mark and paint mark in place). `false` or `null` (the plan is
   * gone: the document was replaced) means the capture must be discarded.
   */
  maskVerify(nonce: string): boolean | null;
  /**
   * Before a capture: how many of the `nonce` plan's elements the redaction stylesheet `css` does
   * not win on (0: it hides them all; -1: it cannot be applied; `null`: the plan is gone).
   */
  maskSheetCheck(nonce: string, css: string): number | null;
  /** True when `el`, an ancestor or a descendant was hidden by the `nonce` plan, or a hidden text range lies inside it. */
  maskTouches(nonce: string, el: Element): boolean;
  /**
   * A copy of the document with the `nonce` plan's masks applied (marked elements' content and
   * hidden text ranges replaced by placeholders, marks removed), for a DOM snapshot; `null` when
   * the plan is gone. The live document is untouched.
   */
  maskClone(nonce: string): Element | null;
  /** Removes every mark and paint mark carrying `nonce` under `attr`. */
  maskClear(attr: string, nonce: string): void;
  /**
   * The rule that would hide `el` (or an ancestor) under `opts`: '' when none would; 'masked' when
   * a rule is invalid. Cached until the document changes or the rules do.
   */
  maskKindOf(el: Element, opts: Omit<MaskPlanOptions, 'nonce'>): string;
}

/** What a human did. */
export type HumanActionType = 'click' | 'input' | 'keypress' | 'navigate' | 'submit';

/** The only keys capture reports. */
export type CapturedKey = 'Enter' | 'Tab' | 'Escape';

/** One hop of a frame path: the frame's name when it has one, else its index in the parent. */
export interface FrameHop {
  name?: string;
  index?: number;
}

/** Identity of the element acted on. Never a value. */
export interface HumanActionTarget {
  tag?: string;
  role?: string;
  name?: string;
  text?: string;
  selector?: string;
}

/**
 * One captured human action. Field-compatible with the core `HumanAction` schema, plus
 * `frameTruncated`, which a strict `HumanAction` consumer drops.
 */
export interface HumanActionRecord {
  /** ISO 8601 time the action happened. */
  ts: string;
  type: HumanActionType;
  /** Hops from the top document to this document ([] = top). */
  frame: FrameHop[];
  target: HumanActionTarget;
  /** Always true: capture never reads or records a value. */
  valueRedacted: true;
  /** Key name, for keypress records. */
  key?: CapturedKey;
  /** This document's URL (capped at 300 chars). */
  url?: string;
  /**
   * Present only when the frame chain stopped at a cross-origin ancestor. `frame` then starts at
   * the highest frame this document can read, not at the top document.
   */
  frameTruncated?: true;
}

/** The `window.postMessage` envelope the fallback sink posts. */
export interface ActionMessage {
  type: 'cu-agent:action';
  action: HumanActionRecord;
}

/** Turns human-action capture on and off for this document. Off by default. */
export interface CaptureControl {
  start(): void;
  stop(): void;
  isActive(): boolean;
}

/** The agent, installed once per document as `window.__cuAgent`. */
export interface CuAgent {
  /** Semantic version; the major number is the compatibility contract. */
  readonly version: string;
  /** Interactive and informative elements of this document, with descriptor-synthesis inputs. */
  enumerate(opts?: EnumerateOptions): EnumerateResult;
  /** Role, accessible name, label, text and structural selector of one element. */
  describe(el: Element): ElementDescription;
  /** The element itself or its closest interactive ancestor; null at body/html. */
  closestClickable(el: Node | null): Element | null;
  /** Unique structural CSS selector for `el` in this document; '' when none fits. */
  structuralSelector(el: Element): string;
  /** Human-action capture for this document. */
  readonly capture: CaptureControl;
  /** Returns the fallback sink's buffered records and empties the buffer. */
  drain(): HumanActionRecord[];
  /** The fallback sink's buffer (max 500, oldest dropped first). Empty while a binding is present. */
  readonly events: readonly HumanActionRecord[];
  /** Low-level helpers (the adapter's former in-page library surface) for a driver's resolver. */
  readonly lib: CuAgentLib;
}

declare global {
  interface Window {
    __cuAgent?: CuAgent;
    /** Installed by a driver (Playwright `exposeBinding`); the sink prefers it when present. */
    __cuHumanAction?: (action: HumanActionRecord) => unknown;
  }
}

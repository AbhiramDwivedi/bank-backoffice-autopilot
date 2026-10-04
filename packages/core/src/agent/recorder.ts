/**
 * Discovery agent: the recorder. Turns accepted model actions into a canonicalized `Capability`
 * draft.
 *
 * The recorder never touches the surface; it takes descriptors/values the loop already has
 * (from the observation the model acted on) and:
 *  - canonicalizes every input value out of every string it stores (`{input.<name>}`),
 *  - narrows result-row-shaped locators so they don't over-fit the recorded record,
 *  - binds a step's postcondition (and the success condition) to the landing URL when that URL
 *    carries an input's run value, so replay checks it reached THIS input's record,
 *  - assembles steps/outcomes/recovery rules/outputs into a draft capability, with the `auth`
 *    block (sign-in steps + signed-in condition) derived by `deriveAuth` (schema/auth.ts),
 *  - validates + repairs it, and fails closed if a secret or sensitive value would persist.
 */
import type {
  Action,
  BusinessOutcome,
  Capability,
  CapabilityIssue,
  Condition,
  ExtractIdentity,
  FrameHop,
  FramePath,
  InputSpec,
  JsonType,
  Locator,
  OutcomeExtract,
  OutputSpec,
  ParseMode,
  RecoveryRule,
  RiskClass,
  Step,
  TargetDescriptor,
  ValidateCapabilityOptions,
} from '../schema/index.js';
import { createValueScrubber } from '../evidence/index.js';
import { KEBAB_RE, RISK_ORDER, alnumFold, collectInputPlaceholders, deriveAuth, isPositional, validateCapability, wholeTokenRegex } from '../schema/index.js';
import { recordTextShows, type RecordContext, type RecordTextWithin } from '../surface/index.js';
import type { DiscoverOptions, InputDecl, OutputDecl } from './types.js';

// -------------------------------------------------------------------------------------------
// Public option / result types.
// -------------------------------------------------------------------------------------------

/** Options for {@link createRecorder}: the run's base URL and inputs, for value canonicalization. */
export interface RecorderOptions {
  baseUrl: string;
  /** Concrete run values. */
  inputs: Record<string, InputDecl>;
  outputsHint?: Record<string, OutputDecl>;
  /** Secret VALUES (and any other strings) that must never be persisted; used by the leak check. */
  forbiddenValues?: string[];
  /** Log each canonicalization substitution, dropped input, repair. Never receives raw values. */
  onLog?: (message: string, data?: Record<string, unknown>) => void;
}

/** Input to {@link Recorder.recordStep}. */
export interface RecordStepInput {
  action: Action;
  why: string;
  risk: RiskClass;
  postcondition?: Condition;
  onFailure?: 'fail' | 'escalate';
  /** The action's target exactly as it must be recorded, already canonical and scoped (see
   *  {@link Recorder.scopeTarget}; discovery verifies a record-scoped one on the live page first).
   *  Used verbatim instead of canonicalizing `action.target`. */
  scopedTarget?: TargetDescriptor;
}

/** Input to {@link Recorder.recordOutcome}. */
export interface RecordOutcomeInput {
  name: string;
  description: string;
  detectorText: string;
  frame?: FramePath;
  /**
   * `scoped`: the target is already canonical and scoped (see {@link Recorder.scopeTarget}); used verbatim.
   * `sensitive`: the return was read from a masked element (screen masking); see OutputSpec.sensitive.
   */
  returns: { output: string; target: TargetDescriptor; parse: ParseMode; description: string; scoped?: boolean; sensitive?: boolean }[];
}

/** Metadata for {@link Recorder.build}: identity, provenance, and validation options for the
 *  finished capability. */
export interface BuildMeta {
  id: string;
  name?: string;
  goal: string;
  summary?: string;
  app: DiscoverOptions['app'];
  /** Concrete; you canonicalize it. */
  entryUrl: string;
  runId: string;
  model: string;
  /** ISO. */
  discoveredAt: string;
  validateOptions?: ValidateCapabilityOptions;
  /** Record `readOnly: true` (the operator's declaration; validateCapability refuses it on anything irreversible). */
  readOnly?: boolean;
}

/** Result of {@link Recorder.build}: the finished capability, or the draft plus the issues that
 *  kept it from validating. */
export type BuildResult =
  | { ok: true; capability: Capability; warnings: string[]; repairs: string[] }
  | { ok: false; draft: unknown; issues: CapabilityIssue[]; warnings: string[]; repairs: string[] };

/** How a target is identified once canonicalized; see `scopeLocators` in recorder.ts. */
export type TargetScope = 'own-input' | 'anchor-input' | 'repeated-input' | 'content-input' | 'page' | 'static' | 'legacy';

/** Scopes of a target that belongs to a record named by a run input (no positional locator is kept,
 *  and discovery verifies the kept chain on the live page before recording it). */
export const RECORD_SCOPES: ReadonlySet<TargetScope> = new Set<TargetScope>(['own-input', 'anchor-input', 'repeated-input', 'content-input', 'page']);

/** Options for {@link Recorder.scopeTarget}. */
export interface ScopeOptions {
  /** Whether the element's static own name (role-with-name, label, own text) finds exactly this
   *  element on the record-time page. Default true. False makes a control with an input-bound
   *  anchor (an "Add to cart" repeated in every card) record-scoped. */
  ownNameUnique?: boolean;
  /** Keep an own locator holding a run input whole (`Row for {input.id}`, exact) instead of
   *  narrowing it to the bare placeholder (a contains match). For when the narrowed form is
   *  ambiguous on the record-time page. */
  specific?: boolean;
  /** The element's own, row and container text (`Surface.recordContextOf`), used only to
   *  decide record membership: a target whose content holds a run input's value is record-scoped
   *  even when no locator expresses it. Never persisted. */
  context?: RecordContext;
}

/** Result of {@link Recorder.scopeTarget}: the canonical target as it would be recorded, and its scope. */
export interface ScopedTarget {
  scope: TargetScope;
  /** True for a target that belongs to a record named by a run input ({@link RECORD_SCOPES}). */
  recordScoped: boolean;
  target: TargetDescriptor;
  /** The canonical own-identity locators holding no run input, for a uniqueness check. */
  ownStatic: Locator[];
  /** True when some relative locator is anchored on a run input. */
  hasInputAnchor: boolean;
}

/** Result of {@link Recorder.sanitizeExtractedTarget}. */
export type SanitizeExtractResult = { ok: true; target: TargetDescriptor } | { ok: false; error: string };

/** Where the surface is: the top document's URL and each frame's URL, as an observation reports them. */
export interface ObservedLocation {
  url: string;
  frames: readonly { path: FramePath; url: string }[];
}

/** Accumulates canonicalized steps, outcomes, and recovery rules over a discovery run, then
 *  assembles and validates them into a `Capability` draft. */
export interface Recorder {
  canonicalizeString(s: string): string;
  /** baseUrl prefix -> {baseUrl}, then input values. */
  canonicalizeUrl(url: string): string;
  canonicalizeDescriptor(d: TargetDescriptor): TargetDescriptor;
  /**
   * The canonical target exactly as it will be stored, with its identity scope. A caller verifies
   * a record-scoped target on the live surface (bound with this run's inputs, it must find the
   * acted element) before recording it, and passes the result as `scopedTarget`.
   */
  scopeTarget(d: TargetDescriptor, opts?: ScopeOptions): ScopedTarget;
  canonicalizeCondition(c: Condition): Condition;
  /**
   * The identity check to record on a read, or undefined. `text` is the record text the surface
   * returned for the element read (`Surface.readRecordText`) and `scope` what it is. When the text
   * shows a declared, non-sensitive input's value (3+ characters, as a whole token), the read
   * belongs to the record that input names, and the check is that input's NAME with the scope: the
   * value is never stored. With several inputs shown, the one a step drove first wins (the input
   * that named the record, not a filter typed later). The text is compared and dropped.
   */
  identityFor(read: { scope: RecordTextWithin; text: string }): ExtractIdentity | undefined;
  /** Canonicalizes action (descriptor, url, literal values), assigns id s01.., name via
   * shortStepName(why). Returns the stored Step. */
  recordStep(s: RecordStepInput): Step;
  /** Declares an output produced by the most recent extract step: type number for
   * parse number|currency else string; description from outputsHint[name] ?? why. `sensitive`
   * (the value was read from a masked element) marks the OutputSpec sensitive; once sensitive, a
   * later re-extract of the same name keeps it sensitive. */
  recordOutput(name: string, parse: ParseMode, why: string, opts?: { sensitive?: boolean }): void;
  /** RecoveryRule: name = "dismiss_" + the first 4 words of `r.title` (the modal's own
   * heading/title text, e.g. "System Maintenance Notice" -- NEVER derived from `triggerText`,
   * which is typically the notice's longer body copy and would make an unstable, run-on rule
   * name), snake_cased (the schema's Identifier requires `[A-Za-z_][A-Za-z0-9_]*`, so this is
   * snake_case, not kebab-case), capped at 40 chars; falls back to "dismiss_interstitial_<n>"
   * when `title` is absent/empty or yields no usable word characters at all.
   * trigger text_visible(canonical triggerText, frame), actions [click dismissTarget(canonical),
   * wait text_absent(triggerText, frame) timeoutMs 5000], maxAttempts 2. Dedupe by name (by
   * trigger for an untitled notice): the existing rule is returned when its dismiss target is the
   * same, and replaced (keeping its name) when the new dismiss target differs. Call it only for a
   * dismissal that actually cleared the notice. */
  recordRecovery(r: { triggerText: string; title?: string; frame?: FramePath; dismissTarget: TargetDescriptor; description: string; scopedTarget?: TargetDescriptor }): RecoveryRule;
  /** BusinessOutcome: name sanitized to Identifier (snake_case), detector
   * text_visible(canonical detectorText, frame), afterSteps [last step id] when a step
   * exists, returns/extract from r.returns (type from parse like outputs). Replace an
   * existing outcome with the same name (log). */
  recordOutcome(o: RecordOutcomeInput): BusinessOutcome;
  /**
   * Defect fix (record-time data must not persist as reusable artifact content): call this on
   * an `extract` target (steps and business-outcome extracts alike) BEFORE recordStep/
   * recordOutcome, with the raw text just read off the page for it. Drops every locator whose
   * own match string (role name / label text / text anchor) equals `rawValue` (whitespace-
   * collapsed, case-insensitive) -- a `relative`/`css`/`bbox` locator never matches on the
   * element's own content, so it is dropped only when its CSS selector or `within` contains the
   * value (compared alnum-folded, 3+ characters: "In transit" in `status-in-transit`) -- strips a matching `snapshot.text`,
   * and rewrites `description` from the best remaining locator. Registers `rawValue` (3+ chars)
   * so `build()` scrubs it out of the rest of the artifact's free text as `{output.<name>}`.
   * Fails (without mutating anything) if every locator would be dropped, rather than emit a
   * target only the recorded record can ever resolve.
   *
   * `detectorText`, for a business-outcome return, is that outcome's detector text. A `rawValue`
   * equal to or contained in it (whitespace-collapsed, case-insensitive) is the static page text
   * the outcome is detected by, not record data: the target is returned unchanged and nothing is
   * registered.
   */
  sanitizeExtractedTarget(target: TargetDescriptor, outputName: string, rawValue: string, detectorText?: string): SanitizeExtractResult;
  /**
   * Reports where the surface is now; call it with every fresh observation. When a step was
   * recorded since the previous call, and the URL of the frame that step acted in (else the top
   * document) changed and now contains a declared input's run value as a whole token, an
   * input-bound `url_matches` check (see {@link inputBoundUrlPatterns}) is merged into that step's
   * postcondition. `setSuccess` reads the latest location the same way.
   */
  noteLocation(location: ObservedLocation): void;
  /** Canonicalize condition. When the latest noted location's URL (in the condition's frame, else
   *  the top document) contains a declared input's run value, the same input-bound `url_matches`
   *  check `noteLocation` builds is merged into it. */
  setSuccess(condition: Condition, description: string): void;
  /** provenance.recordedBy becomes 'mixed', note appended. */
  markHumanInvolved(note: string): void;
  addNote(note: string): void;
  readonly steps: readonly Step[];
  readonly outcomes: readonly BusinessOutcome[];
  readonly recoveryRules: readonly RecoveryRule[];
  /** Values registered by `sanitizeExtractedTarget` (3+ chars), one per output name: the latest
   *  registration for a name replaces the earlier one. */
  readonly extractedValues: readonly { name: string; value: string }[];
  /** Replaces every registered extracted value in the capability's free-text prose fields with
   *  `{output.<name>}` (the same pass `build()` applies). */
  scrubExtractedValues(cap: Capability): Capability;
  build(meta: BuildMeta): BuildResult;
}

// -------------------------------------------------------------------------------------------
// Small pure helpers (exported).
// -------------------------------------------------------------------------------------------

const INPUT_PLACEHOLDER_ONLY_RE = /\{input\.[A-Za-z_][A-Za-z0-9_]*\}/g;
const ANY_PLACEHOLDER_RE = /\{[^{}]*\}/g;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractInputPlaceholders(s: string): string[] {
  return s.match(INPUT_PLACEHOLDER_ONLY_RE) ?? [];
}

/** True if, after stripping every `{...}` placeholder, non-whitespace text remains. */
function hasNonPlaceholderText(s: string): boolean {
  return s.replace(ANY_PLACEHOLDER_RE, '').trim() !== '';
}

/** True when a locator's match string carries an `{input.x}` placeholder, so what it finds depends
 *  on the run's input (a bbox never does). */
function isInputBound(l: Locator): boolean {
  const s = l.strategy;
  switch (s.kind) {
    case 'role':
      return hasInputPlaceholder(s.name);
    case 'label':
      return hasInputPlaceholder(s.label);
    case 'text':
      return hasInputPlaceholder(s.text);
    case 'relative':
      return hasInputPlaceholder(s.anchor.text) || (s.selector !== undefined && hasInputPlaceholder(s.selector));
    case 'css':
      return hasInputPlaceholder(s.selector);
    case 'automation_id':
      return hasInputPlaceholder(s.id);
    case 'bbox':
      return false;
  }
}

/** A locator naming the element by its own identity: an accessible role + name, a label, its own text. */
function isOwnIdentity(l: Locator): boolean {
  return l.strategy.kind === 'role' || l.strategy.kind === 'label' || l.strategy.kind === 'text';
}

/** A relative locator whose anchor is bound to a run input. */
function isInputAnchored(l: Locator): boolean {
  return l.strategy.kind === 'relative' && hasInputPlaceholder(l.strategy.anchor.text);
}

// `isPositional` lives in schema/positional.ts (replay and the validator use it too); re-exported
// here for the recorder's own callers.
export { isPositional };

/** An input-anchored relative a record-scoped target may keep: one derived from its container
 *  (verified in the page, anchored on a leaf rendering that text itself), or one whose anchor is
 *  the input and nothing else (a table row's id cell). A legacy above-anchor that merely contains
 *  the input is unverified neighbouring text -- "Member: Jane Q. Sample (#{input.memberId})", or a
 *  card's name glued to its description -- and would persist that record's data. */
function isTrustedInputAnchor(l: Locator): boolean {
  if (l.strategy.kind !== 'relative' || !isInputAnchored(l)) return false;
  return l.strategy.within !== undefined || !hasNonPlaceholderText(l.strategy.anchor.text);
}

/** A relative locator anchored on the element's own associated label: the legacy adjacent label
 *  cell (`right-of`, no container). Every other non-input anchor is neighbouring text -- often
 *  record data (a member's name, a staff note) -- and is not recorded. */
function isLabelAnchor(l: Locator): boolean {
  return l.strategy.kind === 'relative' && l.strategy.relation === 'right-of' && l.strategy.within === undefined && !isInputAnchored(l);
}

/**
 * Which locators of a canonical target survive. The rule: a target that belongs to a record named
 * by a run input never keeps a positional locator. It is record-scoped when
 *  - `own-input`: its own name/text holds the input (the result row whose text is the member id);
 *  - `anchor-input`: it has no static identity of its own and a relative anchored on the input,
 *    with or without a container bound (a table cell right of "{input.orderId}" counts);
 *  - `repeated-input`: its static own name is not unique on the record-time page and it has an
 *    input-anchored relative (the "Add to cart" in every card);
 * and then it keeps ONLY its input-bound, non-positional locators. Or
 *  - `content-input`: its own text, its table row's other cells or its record container's text
 *    hold a run input's value although no locator expresses it (a "View" button in the row of the
 *    person searched for): it keeps its input-bound locators plus ones built from that content
 *    (see `contentLocators`). When only the container's text holds the value, the element is a
 *    field of a one-record detail view (the member's profile table that shows the last name
 *    searched for): it also keeps its own label anchor ("Savings Balance"), which discovery then
 *    verifies on the live page -- a label repeated on the page (several cards, each with a
 *    "Savings Balance" row) makes the anchor lookup ambiguous, so the target is refused there;
 *  - `page`: its page (frame URL) is bound to the input. On the record's own page (the input in a
 *    path segment) it keeps its chain; on a list/search page (the input in a query string) it
 *    keeps its chain minus positional locators.
 * Otherwise (`static`, `legacy`) it keeps its chain, positional fallbacks included. In every scope
 * a relative is kept only when it is anchored on the input or on the element's own label; an
 * anchor on any other neighbouring text is dropped (record data), and a `static` target also
 * drops input-anchored relatives (they add risk, not identity). A run input slugged into a CSS id
 * (`#savings-form`) is never identity.
 */
function scopeLocators(
  all: readonly Locator[],
  o: { ownNameUnique: boolean; page: 'path' | 'query' | undefined; content: Locator[] | undefined; containerOnly?: boolean },
): { scope: TargetScope; kept: Locator[] } {
  const own = all.filter(isOwnIdentity);
  const ownInput = own.filter(isInputBound);
  const ownStatic = own.filter((l) => !isInputBound(l));
  // Only a trusted anchor says "this record": a legacy above-anchor that merely contains the input
  // ("Member: Jane Q. Sample (#{input.memberId})") is neighbouring text and is dropped below.
  const trustedAnchor = all.some(isTrustedInputAnchor);
  const inputBoundOnly = (ls: readonly Locator[]): Locator[] => ls.filter((l) => isInputBound(l) && !isPositional(l) && (l.strategy.kind !== 'relative' || isTrustedInputAnchor(l)));
  let scope: TargetScope;
  if (ownInput.length > 0) scope = 'own-input';
  else if (ownStatic.length === 0 && trustedAnchor) scope = 'anchor-input';
  else if (ownStatic.length > 0 && trustedAnchor && !o.ownNameUnique) scope = 'repeated-input';
  else if (o.content !== undefined) scope = 'content-input';
  else if (o.page !== undefined) scope = 'page';
  else scope = ownStatic.length > 0 ? 'static' : 'legacy';
  if (scope === 'own-input' || scope === 'anchor-input' || scope === 'repeated-input') return { scope, kept: inputBoundOnly(all) };
  if (scope === 'content-input') {
    const kept = inputBoundOnly(all);
    for (const l of o.content ?? []) if (!kept.some((k) => JSON.stringify(k.strategy) === JSON.stringify(l.strategy))) kept.push(l);
    // Membership from the container's text alone: the element's own label anchor identifies the
    // field within that one record. Only a label the page shows once (the agent says so, and
    // discovery verifies it on the live page before recording): a repeated label stays refused.
    if (o.containerOnly === true) kept.push(...all.filter(isLabelAnchor));
    return { scope, kept };
  }
  const anchorsKept = all.filter((l) => l.strategy.kind !== 'relative' || isLabelAnchor(l));
  // On the record's own page (the input in a URL path segment) nothing else is listed, so a
  // position still means this record; on a list or search page (the input in a query string)
  // other records sit around it, so it does not.
  return { scope, kept: scope === 'page' && o.page === 'query' ? anchorsKept.filter((l) => !isPositional(l)) : anchorsKept };
}

/** True for a text/role locator whose whole string is input placeholders (the narrowing result). */
function isNarrowed(l: Locator): boolean {
  const s = l.strategy;
  const v = s.kind === 'text' ? s.text : s.kind === 'role' ? s.name : undefined;
  return v !== undefined && extractInputPlaceholders(v).length > 0 && !hasNonPlaceholderText(v);
}

/** A role locator narrowed to a run input out of a longer name: a substring match on the bound
 *  value ("Bolt" finds "Bolt T-Shirt"). A role name that is the input alone, and the specific form,
 *  are recorded `exact`, so after canonicalization only the narrowed form is input-bound and not exact. */
function isSubstringRole(l: Locator): boolean {
  return l.strategy.kind === 'role' && l.strategy.exact !== true && hasInputPlaceholder(l.strategy.name);
}

/** Words that carry no meaning in a capability id. */
const ID_STOP_WORDS: ReadonlySet<string> = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'their', 'his', 'her', 'its', 'my', 'then', 'with', 'by', 'current']);

// -------------------------------------------------------------------------------------------
// Defect fix: extracted values must not persist as reusable artifact content (record-time data,
// not schema). Two halves: (a) drop a locator that only matches an extract target because it
// carries the extracted value itself (`sanitizeExtractedTarget`, below); (b) scrub every
// registered extracted value out of the artifact's free-text prose fields at build() time
// (`scrubExtractedValuesFromCapability`). Both share these small pure helpers.
// -------------------------------------------------------------------------------------------

/** Trims and collapses internal whitespace runs to a single space, for tolerant text comparison
 *  (mirrors `collapseWs` in packages/core/src/schema/validate.ts, kept local here to avoid a schema<->agent
 *  layering dependency for one helper). */
function collapseWs(s: string): string {
  return s.trim().replace(/\s+/g, ' ');
}

/** Minimum length (chars, after trim) an extracted value must have before it is (1) registered
 *  for the build()-time free-text scrub, or (2) considered by the validator's `knownValues`
 *  leak check. A shorter value ("OK", "1", "$") would match unrelated, legitimate text all over
 *  the artifact, turning the safety net into noise. `sanitizeExtractedTarget`'s own locator-drop
 *  (an exact-match comparison against the SAME target's own locator, not a substring scan) has no
 *  such false-positive risk, so it applies regardless of length. */
const MIN_SCRUB_VALUE_LEN = 3;

/** The locator's own human-readable match string, for the strategy kinds whose match text could
 *  itself BE the value being extracted (an ARIA role's accessible name, a label association, a
 *  text anchor). A `relative`/`css`/`bbox` locator never matches on the element's own content --
 *  it matches on a neighboring anchor, a structural selector, or a position -- so it can never
 *  itself leak the value and is excluded here. */
function locatorValueText(s: Locator['strategy']): string | undefined {
  switch (s.kind) {
    case 'role':
      return s.name;
    case 'label':
      return s.label;
    case 'text':
      return s.text;
    case 'relative':
    case 'css':
    case 'bbox':
    case 'automation_id':
      return undefined;
  }
}

const RELATION_WORDS: Record<'right-of' | 'below' | 'left-of' | 'above' | 'same-row', string> = {
  'right-of': 'right of',
  below: 'below',
  'left-of': 'left of',
  above: 'above',
  'same-row': 'in the same row as',
};

/** Renders one surviving locator as a short human phrase, for {@link formatDescriptorDescription}. */
function describeLocatorCore(s: Locator['strategy'], noun: string): string {
  switch (s.kind) {
    case 'role':
      return `${s.role} "${s.name}"`;
    case 'label':
      return `${noun} labeled "${s.label}"`;
    case 'text':
      return `${noun} "${s.text}"`;
    case 'relative':
      return `${noun} ${RELATION_WORDS[s.relation]} "${s.anchor.text}"`;
    case 'css':
      return `${noun} matching selector "${s.selector}"`;
    case 'bbox':
      return `${noun} at its recorded position`;
    case 'automation_id':
      return `${noun} with automation id "${s.id}"`;
  }
}

/** Rebuilds a target's `description` from its best surviving locator once
 *  `sanitizeExtractedTarget` has dropped the value-bearing one(s). Mirrors the
 *  `"${role} \"${label}\" (<${tag}>)"` shape the surface synthesizers use (see
 *  packages/adapter-playwright/src/enumerate.ts's `synthesizeDescriptor` and
 *  packages/core/src/surface/fake/view.ts's -- read for reference, not imported: the recorder never depends on
 *  a surface module), but built from a locator strategy plus the record-time `snapshot` instead
 *  of a live DOM element. */
function formatDescriptorDescription(best: Locator, snapshot: TargetDescriptor['snapshot']): string {
  const tag = snapshot?.tag;
  const noun = snapshot?.role ?? tag ?? 'element';
  const core = describeLocatorCore(best.strategy, noun);
  return tag !== undefined ? `${core} (<${tag}>)` : core;
}

/** Builds a case-insensitive, whitespace-tolerant regex matching `value` literally (internal
 *  whitespace runs match any whitespace run), for {@link scrubValueFromText}. */
function buildLooseValueRegex(value: string): RegExp {
  const pattern = collapseWs(value)
    .split(' ')
    .map((word) => escapeRegExp(word))
    .join('\\s+');
  return new RegExp(pattern, 'gi');
}

/** Replaces every occurrence of `value` in `text` (case-insensitive, whitespace-tolerant) with
 *  `placeholder`. A no-op when `text` or `value` is empty. */
function scrubValueFromText(text: string, value: string, placeholder: string): string {
  if (text === '' || collapseWs(value) === '') return text;
  return text.replace(buildLooseValueRegex(value), placeholder);
}

/** kebab-case; default derived from the goal. Drop input values & placeholders, lowercase,
 * kebab, max 6 words / 60 chars, KEBAB_RE-valid, fallback 'discovered-capability'. */
export function kebabFromGoal(goal: string, inputValues: string[] = []): string {
  let s = goal.replace(ANY_PLACEHOLDER_RE, ' ');
  const values = [...inputValues].filter((v) => v.length > 0).sort((a, b) => b.length - a.length);
  for (const v of values) {
    const re = wholeTokenRegex(v);
    s = s.replace(re, ' ');
  }
  const words = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => !ID_STOP_WORDS.has(w))
    .slice(0, 6);
  let kebab = words.join('-');
  if (kebab.length > 60) {
    kebab = kebab.slice(0, 60).replace(/-[^-]*$/, '');
  }
  kebab = kebab.replace(/^-+|-+$/g, '');
  if (kebab === '' || !KEBAB_RE.test(kebab)) return 'discovered-capability';
  return kebab;
}

/** First sentence/clause of `why`, <= 60 chars, capitalized, non-empty fallback 'Step'. */
export function shortStepName(why: string): string {
  const trimmed = why.trim();
  if (trimmed === '') return 'Step';
  const m = trimmed.match(/^[^.!?;\n]+/);
  let first = (m ? m[0] : trimmed).trim();
  if (first === '') return 'Step';
  if (first.length > 60) first = first.slice(0, 60).trim();
  if (first === '') return 'Step';
  return first.charAt(0).toUpperCase() + first.slice(1);
}

/** snake_case, IDENT_RE valid. */
export function toIdentifier(s: string): string {
  const withBoundaries = s.replace(/([a-z0-9])([A-Z])/g, '$1_$2');
  let id = withBoundaries
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (id === '') id = 'x';
  if (/^[0-9]/.test(id)) id = `_${id}`;
  return id;
}

/** JSON-pointer-ish paths of string leaves containing any forbidden string (skip empty forbidden). */
export function findLeaks(value: unknown, forbidden: readonly string[]): string[] {
  const needles = forbidden.filter((v) => v.length > 0);
  if (needles.length === 0) return [];
  const hits: string[] = [];
  const walk = (v: unknown, path: string): void => {
    if (typeof v === 'string') {
      if (needles.some((n) => v.includes(n))) hits.push(path === '' ? '/' : path);
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((item, i) => walk(item, `${path}/${i}`));
      return;
    }
    if (v !== null && typeof v === 'object') {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) walk(val, `${path}/${k}`);
    }
  };
  walk(value, '');
  return hits;
}

function pointerToPath(pointer: string): (string | number)[] {
  return pointer
    .split('/')
    .filter((seg) => seg !== '')
    .map((seg) => (/^\d+$/.test(seg) ? Number(seg) : seg));
}

function redactDeep<T>(value: T, needles: readonly string[]): T {
  return createValueScrubber(needles).deep(value);
}

function jsonTypeFromParse(parse: ParseMode): JsonType {
  return parse === 'number' || parse === 'currency' ? 'number' : 'string';
}

function computeMaxRisk(steps: readonly Step[]): RiskClass {
  let max: RiskClass = 'read';
  for (const s of steps) if (RISK_ORDER[s.risk] > RISK_ORDER[max]) max = s.risk;
  return max;
}

function titleCaseFromId(id: string): string {
  return id
    .split('-')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Applies `replace` to a target's `description` only (its locators/snapshot were already
 *  sanitized by `sanitizeExtractedTarget` at record time; this pass is for prose fields only). */
function scrubTargetDescription(target: TargetDescriptor, replace: (s: string) => string): TargetDescriptor {
  const description = replace(target.description);
  return description === target.description ? target : { ...target, description };
}

/** Applies `replace` to every value's `description` field in a name-keyed record (InputSpec,
 *  OutputSpec), preserving every other field. */
function scrubDescriptions<T extends { description: string }>(record: Record<string, T>, replace: (s: string) => string): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(record)) out[k] = { ...v, description: replace(v.description) };
  return out;
}

/** `value` in identifier form (lowercase, runs of other characters as `_`, no leading or trailing
 *  `_`), the way it would read inside a snake_case outcome or rule name. */
function identifierToken(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Replaces each extracted value found as a whole token inside a snake_case name (in identifier
 * form, see {@link identifierToken}) with its output name in the same form, so `overdrawn_98765`
 * becomes `overdrawn_balance`. `taken` holds the names already in use; a scrubbed name that would
 * collide gets a numeric suffix. An unchanged name is returned as is.
 */
function scrubValuesFromName(name: string, values: readonly { name: string; value: string }[], taken: Set<string>): string {
  let out = name;
  for (const { name: output, value } of values) {
    const token = identifierToken(value);
    if (token.length < MIN_SCRUB_VALUE_LEN) continue;
    out = out.replace(wholeTokenRegex(token, 'gi'), toIdentifier(output).replace(/^_+/, ''));
  }
  if (out === name) return name;
  let unique = out;
  for (let n = 2; taken.has(unique); n++) unique = `${out}_${n}`;
  taken.add(unique);
  return unique;
}

/**
 * Defect-1 fix, half (b): scrubs every registered extracted value (3+ chars) out of every
 * free-text prose field of the built capability, replacing it with `{output.<name>}` --
 * case-insensitively, whitespace-tolerant, longest value first. Deliberately narrow to fields a
 * human/LLM reads as prose: `description`, `success.description`, step `name`s, every target
 * `description` (steps + business-outcome extracts + recovery-rule actions), business-outcome
 * `description`/`returns[].description`, recovery-rule `description`, `provenance.notes`, and
 * input/output `description`s. Business-outcome and recovery-rule names get the same treatment in
 * identifier form ({@link scrubValuesFromName}). NEVER touches a locator's own match string (role name/label/text/
 * relative anchor), a Condition's match text, a ValueBinding literal, or any URL/pattern -- those
 * must stay byte-for-byte what the app actually shows, or replay breaks.
 */
function scrubExtractedValuesFromCapability(cap: Capability, values: readonly { name: string; value: string }[]): Capability {
  const qualifying = values.filter((v) => v.value.trim().length >= MIN_SCRUB_VALUE_LEN).sort((a, b) => b.value.length - a.value.length);
  if (qualifying.length === 0) return cap;

  const replace = (s: string): string => {
    let out = s;
    for (const { name, value } of qualifying) out = scrubValueFromText(out, value, `{output.${name}}`);
    return out;
  };

  const steps: Step[] = cap.steps.map((step) => {
    const name = replace(step.name);
    const action = 'target' in step.action ? { ...step.action, target: scrubTargetDescription(step.action.target, replace) } : step.action;
    return name === step.name && action === step.action ? step : { ...step, name, action };
  });

  const outcomeNames = new Set(cap.businessOutcomes.map((o) => o.name));
  const businessOutcomes: BusinessOutcome[] = cap.businessOutcomes.map((o) => {
    const returns = scrubDescriptions(o.returns, replace);
    const extract = o.extract?.map((e) => ({ ...e, target: scrubTargetDescription(e.target, replace) }));
    const name = scrubValuesFromName(o.name, qualifying, outcomeNames);
    const out: BusinessOutcome = { ...o, name, description: replace(o.description), returns };
    if (extract !== undefined) out.extract = extract;
    return out;
  });

  const ruleNames = new Set(cap.recoveryRules.map((r) => r.name));
  const recoveryRules: RecoveryRule[] = cap.recoveryRules.map((r) => ({
    ...r,
    name: scrubValuesFromName(r.name, qualifying, ruleNames),
    description: replace(r.description),
    actions: r.actions.map((a) => ('target' in a ? { ...a, target: scrubTargetDescription(a.target, replace) } : a)),
  }));

  const inputs: Record<string, InputSpec> = scrubDescriptions(cap.inputs, replace);
  const outputs: Record<string, OutputSpec> = scrubDescriptions(cap.outputs, replace);

  return {
    ...cap,
    description: replace(cap.description),
    success: { ...cap.success, description: replace(cap.success.description) },
    steps,
    businessOutcomes,
    recoveryRules,
    inputs,
    outputs,
    provenance: cap.provenance.notes !== undefined ? { ...cap.provenance, notes: replace(cap.provenance.notes) } : cap.provenance,
  };
}

/** Structural equality for two recovery-rule trigger conditions, as `recordRecovery` builds them
 *  (always `{kind:'text_visible', text, frame?}`): same text, same frame path. Used to dedupe an
 *  untitled recovery by what it actually detects, since its fallback name is otherwise unique per
 *  call. */
function triggerConditionsEqual(a: Condition, b: Condition): boolean {
  if (a.kind !== 'text_visible' || b.kind !== 'text_visible') return false;
  if (a.text !== b.text) return false;
  return JSON.stringify(a.frame ?? []) === JSON.stringify(b.frame ?? []);
}

/** The dismiss control of a recovery rule as `recordRecovery` builds it (its `click` action's
 *  target), for comparing a repeat dismissal against the recorded one. */
function recoveryClickTarget(rule: RecoveryRule): TargetDescriptor | undefined {
  const click = rule.actions.find((a) => a.type === 'click');
  return click?.type === 'click' ? click.target : undefined;
}

/** Recursively finds every `{kind:'input', name}` ValueBinding anywhere in a JSON-like value. */
function collectInputBindingNames(value: unknown, out: Set<string>): void {
  if (Array.isArray(value)) {
    for (const v of value) collectInputBindingNames(v, out);
    return;
  }
  if (value !== null && typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    if (rec.kind === 'input' && typeof rec.name === 'string') out.add(rec.name);
    for (const v of Object.values(rec)) collectInputBindingNames(v, out);
  }
}

// -------------------------------------------------------------------------------------------
// Input-bound URL checkpoints: a postcondition/success check that the page landed on THIS run's
// record (e.g. `/members/{input.memberId}`), not just on a page with the right static labels.
// -------------------------------------------------------------------------------------------

/** Closes every input-bound URL check: the bound value must end at a token boundary (the same
 *  boundary `wholeTokenRegex` uses), so member 1234 does not match `/members/12345`. */
const URL_TOKEN_END = '(?![A-Za-z0-9])';

/** Strips a URL's `scheme://host[:port]` so a check does not pin one tenant's origin. */
const URL_ORIGIN_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*/;

function hasInputPlaceholder(s: string): boolean {
  return extractInputPlaceholders(s).length > 0;
}

/** `s` up to and including its last `{input.x}` placeholder: whatever follows is left unpinned. */
function cutAfterLastPlaceholder(s: string): string {
  let end = 0;
  for (const m of s.matchAll(INPUT_PLACEHOLDER_ONLY_RE)) end = m.index + m[0].length;
  return s.slice(0, end);
}

/** Regex source for a canonical URL fragment: literal text is regex-escaped and `{input.x}`
 *  placeholders are kept for `bindPattern` to fill in (regex-escaped) at replay. */
function templateToPattern(s: string): string {
  let out = '';
  let last = 0;
  for (const m of s.matchAll(INPUT_PLACEHOLDER_ONLY_RE)) {
    out += escapeRegExp(s.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  return out + escapeRegExp(s.slice(last));
}

/** An ASP.NET cookieless session segment such as `(S(abc123))`: a per-session token, never pinned. */
const SESSION_SEGMENT_RE = /^\([A-Za-z]\(.*\)\)$/;

/**
 * Pattern sources for a URL path: one per path segment holding an `{input.x}` placeholder,
 * pinning that segment (up to its last placeholder) together with the single literal segment
 * right before it, e.g. `/members/{input.memberId}` out of `/branch/004/members/12345`. Segments
 * further up the path (a branch, a tenant prefix, a session token) are record- or session-specific
 * and stay unpinned. A placeholder segment with no literal segment before it (the first segment,
 * or one after another placeholder segment or a session segment) is pinned on its own.
 */
function inputBoundPathPatterns(path: string): string[] {
  const segments = path.split('/');
  const patterns: string[] = [];
  segments.forEach((seg, i) => {
    if (!hasInputPlaceholder(seg)) return;
    const prev = i > 0 ? segments[i - 1]! : undefined;
    const literalPrev = prev !== undefined && prev !== '' && !hasInputPlaceholder(prev) && !SESSION_SEGMENT_RE.test(prev) ? `/${prev}` : '';
    const lead = i > 0 ? '/' : '';
    patterns.push(templateToPattern(`${literalPrev}${lead}${cutAfterLastPlaceholder(seg)}`) + URL_TOKEN_END);
  });
  return patterns;
}

/**
 * `url_matches` pattern sources pinning every `{input.x}` placeholder in a canonical URL tail
 * (origin already stripped): the path segments holding one ({@link inputBoundPathPatterns}), one
 * per query parameter holding one (`[?&]name=...`, so parameter order does not matter), and one
 * for the fragment. Each ends with {@link URL_TOKEN_END}; duplicates are dropped. Empty when the
 * tail holds no placeholder.
 */
function inputBoundUrlPatterns(tail: string): string[] {
  const hashAt = tail.indexOf('#');
  const beforeHash = hashAt >= 0 ? tail.slice(0, hashAt) : tail;
  const hash = hashAt >= 0 ? tail.slice(hashAt) : '';
  const queryAt = beforeHash.indexOf('?');
  const path = queryAt >= 0 ? beforeHash.slice(0, queryAt) : beforeHash;
  const query = queryAt >= 0 ? beforeHash.slice(queryAt + 1) : '';
  const patterns: string[] = inputBoundPathPatterns(path);
  for (const param of query.split('&')) {
    if (hasInputPlaceholder(param)) patterns.push(`[?&]${templateToPattern(cutAfterLastPlaceholder(param))}${URL_TOKEN_END}`);
  }
  if (hasInputPlaceholder(hash)) patterns.push(templateToPattern(cutAfterLastPlaceholder(hash)) + URL_TOKEN_END);
  return [...new Set(patterns)];
}

/** URL of `frame` in `location` ([] = top document); undefined when that frame is absent. */
function urlInFrame(location: ObservedLocation, frame: FramePath): string | undefined {
  if (frame.length === 0) return location.url;
  const key = JSON.stringify(frame);
  return location.frames.find((f) => JSON.stringify(f.path) === key)?.url;
}

/** The first frame path a condition is scoped to, depth-first; undefined when none is. */
function conditionFrame(c: Condition): FramePath | undefined {
  switch (c.kind) {
    case 'text_visible':
    case 'text_absent':
    case 'url_matches':
      return c.frame;
    case 'element_visible':
    case 'element_absent':
      return c.target.frame;
    case 'dialog_open':
      return undefined;
    case 'all':
    case 'any':
      for (const sub of c.of) {
        const f = conditionFrame(sub);
        if (f !== undefined) return f;
      }
      return undefined;
    case 'not':
      return conditionFrame(c.of);
  }
}

/** Frames to look for an input-bound URL in, most specific first: `frame` when it is a sub-frame,
 *  then the top document. */
function urlScopes(frame: FramePath | undefined): FramePath[] {
  return frame !== undefined && frame.length > 0 ? [frame, []] : [[]];
}

/** `existing` AND `check`, as one flat `all` (a check already present is not added twice). */
function withCheckpoint(existing: Condition | undefined, check: Condition): Condition {
  if (existing === undefined) return check;
  const base = existing.kind === 'all' ? existing.of : [existing];
  const added = (check.kind === 'all' ? check.of : [check]).filter((c) => !base.some((b) => JSON.stringify(b) === JSON.stringify(c)));
  return added.length === 0 ? existing : { kind: 'all', of: [...base, ...added] };
}

// -------------------------------------------------------------------------------------------
// Recorder implementation.
// -------------------------------------------------------------------------------------------

interface QualifyingInput {
  name: string;
  value: string;
}

class RecorderImpl implements Recorder {
  private readonly qualifyingInputs: QualifyingInput[];
  private readonly forbiddenAll: string[];
  private readonly stepsInternal: Step[] = [];
  private readonly outcomesInternal: BusinessOutcome[] = [];
  private readonly recoveryRulesInternal: RecoveryRule[] = [];
  private readonly outputsInternal: Record<string, OutputSpec> = {};
  private readonly notes: string[] = [];
  /** Raw values passed to `sanitizeExtractedTarget` (3+ chars only), keyed by output name, for the
   *  build()-time free-text scrub and the validator's `knownValues` leak check. A re-extract of
   *  the same output replaces its earlier value. */
  private readonly extractedValuesByName = new Map<string, string>();
  private successInternal: { condition: Condition; description: string } | undefined;
  private recordedBy: 'llm' | 'mixed' = 'llm';
  /** The latest location passed to `noteLocation`. */
  private lastLocation: ObservedLocation | undefined;
  /** The step recorded since the last `noteLocation`, with the (raw) frame it acted in and the
   *  location it was taken from, awaiting the location it led to. */
  private awaitingLocation: { index: number; frame: FramePath; before: ObservedLocation | undefined } | undefined;

  constructor(private readonly opts: RecorderOptions) {
    const entries = Object.entries(opts.inputs);
    this.qualifyingInputs = entries
      .filter(([, decl]) => decl.value.length >= 3)
      .map(([name, decl]) => ({ name, value: decl.value }))
      .sort((a, b) => b.value.length - a.value.length || a.name.localeCompare(b.name));
    for (const [name, decl] of entries) {
      if (decl.value.length < 3) {
        this.opts.onLog?.(`canonicalize: input ${name} value too short to canonicalize (length < 3)`, { input: name });
      }
    }
    this.forbiddenAll = [
      ...(opts.forbiddenValues ?? []),
      ...entries.filter(([, decl]) => decl.sensitive).map(([, decl]) => decl.value),
    ];
  }

  // --- canonicalization --------------------------------------------------------------------

  private substitute(input: string, where: string): string {
    let s = input;
    for (const { name, value } of this.qualifyingInputs) {
      const spans = protectedSpans(s);
      const { result, count } = replaceWholeToken(s, value, `{input.${name}}`, spans);
      if (count > 0) {
        this.opts.onLog?.(`canonicalize: replaced value of input ${name} in ${where}`, { input: name, where });
      }
      s = result;
    }
    return s;
  }

  canonicalizeString(s: string): string {
    return this.substitute(s, 'string');
  }

  canonicalizeUrl(url: string): string {
    const trimmedBase = this.opts.baseUrl.replace(/\/+$/, '');
    let s = url;
    if (trimmedBase.length > 0) {
      if (s === trimmedBase) {
        s = '{baseUrl}';
      } else if (s.startsWith(`${trimmedBase}/`)) {
        s = `{baseUrl}${s.slice(trimmedBase.length)}`;
      }
    }
    return this.substitute(s, 'url');
  }

  private canonicalizeFramePath(frame: FramePath): FramePath {
    return frame.map((hop) => {
      const out: FrameHop = {};
      if (hop.name !== undefined) out.name = this.substitute(hop.name, 'frame.name');
      if (hop.urlPattern !== undefined) out.urlPattern = this.substitute(hop.urlPattern, 'frame.urlPattern');
      if (hop.index !== undefined) out.index = hop.index;
      return out;
    });
  }

  private narrowLog(kind: string): void {
    this.opts.onLog?.(`canonicalize: narrowed ${kind} locator to input placeholder only`, { kind });
  }

  private canonicalizeLocator(loc: Locator, specific = false): Locator {
    const s = loc.strategy;
    switch (s.kind) {
      case 'role': {
        const name = this.substitute(s.name, 'locator.role.name');
        const placeholders = extractInputPlaceholders(name);
        if (placeholders.length === 0) return { ...loc, strategy: { ...s, name } };
        // The role strategy matches a name exactly or as a substring; it has no whole-word form. A
        // name bound to a run input is therefore recorded exact or not at all: the name that IS the
        // input, and the specific form (the whole name, quoted), are exact.
        if (specific || !hasNonPlaceholderText(name)) return { ...loc, strategy: { ...s, name, exact: true } };
        // The input inside a longer name ("View details for {input.x}"): narrowed to the placeholder
        // this is a substring match, and "Bolt" would find "Bolt T-Shirt". It still says the
        // element's own name holds the input, which decides the target's scope; `scopeTarget` then
        // leaves it out of the recorded chain (`isSubstringRole`).
        this.narrowLog('role');
        return {
          ...loc,
          strategy: { kind: 'role', role: s.role, name: placeholders.join(' '), exact: false },
          confidence: Math.max(0.05, loc.confidence - 0.1),
        };
      }
      case 'label': {
        const label = this.substitute(s.label, 'locator.label.label');
        return { ...loc, strategy: { ...s, label } };
      }
      case 'text': {
        const text = this.substitute(s.text, 'locator.text.text');
        const placeholders = extractInputPlaceholders(text);
        if (specific && placeholders.length > 0) return { ...loc, strategy: { ...s, text, exact: true } };
        if (placeholders.length > 0 && hasNonPlaceholderText(text)) {
          this.narrowLog('text');
          const strategy: Locator['strategy'] =
            s.tag !== undefined
              ? { kind: 'text', text: placeholders.join(' '), exact: false, tag: s.tag, wholeWord: true }
              : { kind: 'text', text: placeholders.join(' '), exact: false, wholeWord: true };
          return { ...loc, strategy, confidence: Math.max(0.05, loc.confidence - 0.1) };
        }
        return { ...loc, strategy: { ...s, text } };
      }
      case 'relative': {
        const text = this.substitute(s.anchor.text, 'locator.relative.anchor.text');
        const selector = s.selector !== undefined ? this.substitute(s.selector, 'locator.relative.selector') : undefined;
        const within = s.within !== undefined ? this.substitute(s.within, 'locator.relative.within') : undefined;
        // An anchor bound to a run input must match that input exactly at replay ("Bike" must not
        // find "Bike Light"); the resolver cannot tell after binding, so it is persisted here.
        // A container anchor holding the input among other text ("Al {input.q}" from a card
        // titled "Al Smithers") keeps the placeholder alone, as a contains match that must find
        // exactly one anchor: the rest is that record's data, and would not match another record.
        const placeholders = extractInputPlaceholders(text);
        const narrow = !specific && s.within !== undefined && placeholders.length > 0 && hasNonPlaceholderText(text);
        const anchorText = narrow ? placeholders.join(' ') : text;
        const exact = narrow ? false : hasInputPlaceholder(text) ? true : s.anchor.exact;
        return {
          ...loc,
          strategy: {
            ...s,
            anchor: { text: anchorText, ...(exact !== undefined ? { exact } : {}), ...(narrow ? { wholeWord: true } : {}) },
            ...(selector !== undefined ? { selector } : {}),
            ...(within !== undefined ? { within } : {}),
          },
        };
      }
      case 'css': {
        const selector = this.substitute(s.selector, 'locator.css.selector');
        return { ...loc, strategy: { ...s, selector } };
      }
      case 'automation_id': {
        const id = this.substitute(s.id, 'locator.automation_id.id');
        return { ...loc, strategy: { ...s, id } };
      }
      case 'bbox':
        return loc;
    }
  }

  canonicalizeDescriptor(d: TargetDescriptor): TargetDescriptor {
    return this.scopeTarget(d).target;
  }

  scopeTarget(d: TargetDescriptor, opts?: ScopeOptions): ScopedTarget {
    const canonical = this.canonicalizeOnly(d, opts?.specific === true);
    const all = canonical.locators;
    const page = this.pagePlacement(d.frame);
    // Record membership from content: not on the record's own page, where every block may show
    // the input and nothing else is listed.
    const content = page === 'path' || opts?.context === undefined ? undefined : this.contentLocators(opts.context, opts?.specific === true);
    const scoped = scopeLocators(all, { ownNameUnique: opts?.ownNameUnique !== false, page, content: content?.locators, containerOnly: content !== undefined && content.containerOnly && content.labelUnique });
    const scope = scoped.scope;
    // A role locator narrowed out of a longer name has done its part (the scope above); as a
    // substring match on the input it is never recorded.
    const kept = scoped.kept.filter((l) => !isSubstringRole(l));
    if (kept.length !== all.length || scope === 'content-input') {
      this.opts.onLog?.(`canonicalize: ${scope} target keeps ${kept.length} of ${all.length} locator(s)`, { scope, kept: kept.map((l) => l.strategy.kind) });
    }
    const target: TargetDescriptor = { ...canonical, locators: kept };
    // The description named the first locator; when that one is gone, name the new first one. A
    // record-scoped description never keeps the record's own text either.
    const synthesized = canonical.snapshot?.role !== undefined && canonical.description.startsWith(`${canonical.snapshot.role} "`);
    if (kept[0] !== undefined && (kept[0] !== all[0] || (RECORD_SCOPES.has(scope) && synthesized))) target.description = formatDescriptorDescription(kept[0], canonical.snapshot);
    return {
      scope,
      recordScoped: RECORD_SCOPES.has(scope),
      target,
      ownStatic: all.filter((l) => isOwnIdentity(l) && !isInputBound(l)),
      hasInputAnchor: all.some(isTrustedInputAnchor),
    };
  }

  /** Where the latest noted location's URL (in `frame`, else the top document) holds a run input:
   *  in a path segment (the record's own page), in the query or fragment (a list or search page),
   *  or nowhere. */
  private pagePlacement(frame: FramePath): 'path' | 'query' | undefined {
    if (this.lastLocation === undefined) return undefined;
    for (const scope of urlScopes(frame)) {
      const url = urlInFrame(this.lastLocation, scope);
      if (url === undefined) continue;
      const canonical = this.canonicalizeUrl(url);
      const tail = canonical.startsWith('{baseUrl}') ? canonical.slice('{baseUrl}'.length) : canonical.replace(URL_ORIGIN_RE, '');
      const cut = tail.search(/[?#]/);
      const path = cut >= 0 ? tail.slice(0, cut) : tail;
      const rest = cut >= 0 ? tail.slice(cut) : '';
      if (hasInputPlaceholder(path)) return 'path';
      if (hasInputPlaceholder(rest)) return 'query';
    }
    return undefined;
  }

  /**
   * Input-bound locators built from an element's content, or undefined when its content holds no
   * run input's value (non-sensitive inputs, 3+ characters, whole token):
   *  - its own text holding the value: a text locator on the placeholder (a contains match; the
   *    whole text, exact, when `specific`);
   *  - a cell of its table row holding the value: a relative anchored on that cell, looked up in
   *    that cell's column only (`anchor.selector`), filtered to the element's own column when it
   *    sits in a cell. The anchor is exact when the cell is the value alone, or the value inside
   *    text every cell of the column shares ("Order {input.orderNo}"); otherwise a case-sensitive
   *    whole-word contains match that must find exactly one cell at replay;
   *  - only its container's text holding the value (`containerOnly`): nothing is built from it
   *    (the container has no anchor the page could verify); `scopeLocators` keeps the element's own
   *    label anchor, else the target is refused rather than recorded by position.
   */
  private contentLocators(ctx: RecordContext, specific: boolean): { locators: Locator[]; containerOnly: boolean; labelUnique: boolean } | undefined {
    const inputs = this.qualifyingInputs.filter((i) => this.opts.inputs[i.name]?.sensitive !== true);
    const holds = (text: string, value: string): boolean => text !== '' && wholeTokenRegex(value).test(text);
    const ownOrRow = inputs.some((i) => holds(ctx.ownText, i.value) || ctx.rowCells.some((c) => holds(c.text, i.value)));
    if (!ownOrRow && !inputs.some((i) => holds(ctx.containerText, i.value))) return undefined;
    const out: Locator[] = [];
    const ownCanonical = this.canonicalizeString(ctx.ownText);
    // The specific form quotes the whole own text: never when that text holds masked content
    // (screen masking) -- the placeholder-only form never quotes page text.
    if (inputs.some((i) => holds(ctx.ownText, i.value)) && !(specific && ctx.ownTextMasked === true)) {
      const placeholders = extractInputPlaceholders(ownCanonical);
      const text = specific ? ownCanonical : placeholders.join(' ');
      const exact = specific || !hasNonPlaceholderText(ownCanonical);
      if (text !== '' && extractInputPlaceholders(text).length > 0) {
        out.push({ strategy: { kind: 'text', text, exact, tag: ctx.tag, ...(exact ? {} : { wholeWord: true }) }, confidence: 0.6, source: 'inferred' });
      }
    }
    for (const cell of ctx.rowCells) {
      const input = inputs.find((i) => holds(cell.text, i.value));
      if (!input) continue;
      const selector = ctx.cell ? `${ctx.cell.tag}:nth-child(${ctx.cell.index + 1})${ctx.tag !== ctx.cell.tag ? ` ${ctx.tag}` : ''}` : undefined;
      const anchor = this.cellAnchor(cell, input);
      out.push({
        strategy: {
          kind: 'relative',
          anchor,
          relation: cell.relation,
          tag: ctx.tag,
          ...(ctx.role !== undefined ? { role: ctx.role } : {}),
          ...(selector !== undefined ? { selector } : {}),
        },
        confidence: 0.5,
        source: 'inferred',
      });
    }
    return { locators: out, containerOnly: !ownOrRow, labelUnique: ctx.labelUnique !== false };
  }

  /**
   * The anchor on a row cell holding a run input's value, never quoting record data:
   *  - the cell is the value alone: `{input.x}`, exact;
   *  - the cell is the value inside the static text its whole column shares (three or more data
   *    cells, no digits, not masked: "Order " in "Order 2001"): that text with the placeholder,
   *    exact (`Order {input.x}`), so "Order 3005 | 03/02/2001" or "Order A-1001-B" never matches;
   *  - otherwise `{input.x}` as a case-sensitive whole word. The value can still be a whole word of
   *    another record's cell in the same column ("Lee" in "Lee Wong"): a named limit.
   * Every one is looked up in the cell's own column (`anchor.selector`), when the agent reports it.
   */
  private cellAnchor(cell: RecordContext['rowCells'][number], input: { name: string; value: string }): { text: string; exact: boolean; wholeWord?: boolean; selector?: string } {
    const ph = `{input.${input.name}}`;
    const column = cell.index !== undefined ? { selector: `${cell.tag ?? 'td'}:nth-child(${cell.index + 1})` } : {};
    const text = collapseWs(cell.text);
    if (text === collapseWs(input.value)) return { text: ph, exact: true, ...column };
    const shared = cell.masked === true ? undefined : cell.shared;
    if (shared !== undefined && text === collapseWs(`${shared.prefix}${input.value}${shared.suffix}`)) {
      const templated = collapseWs(`${shared.prefix}${ph}${shared.suffix}`);
      if (extractInputPlaceholders(templated).length === 1) return { text: templated, exact: true, ...column };
    }
    return { text: ph, exact: false, wholeWord: true, ...column };
  }

  private canonicalizeOnly(d: TargetDescriptor, specific = false): TargetDescriptor {
    let description = this.substitute(d.description, 'descriptor.description');
    const frame = this.canonicalizeFramePath(d.frame);
    const locators = d.locators.map((l) => this.canonicalizeLocator(l, specific));
    const narrowed = locators.some((l, i) => l !== d.locators[i] && isNarrowed(l));
    // A narrowed target is a record-shaped element (e.g. a result row): the rest of its text is
    // specific to the recorded record (a customer's name, dates). Keeping it in the description or
    // snapshot would persist that record's PII in a reusable artifact, so it is narrowed there too.
    // Trade-off: the snapshot loses some drift-diagnostic detail for those targets.
    const narrowText = (t: string): string => {
      const ph = extractInputPlaceholders(t);
      return ph.length > 0 && hasNonPlaceholderText(t) ? ph.join(' ') : t;
    };
    const name = d.snapshot?.name !== undefined ? this.substitute(d.snapshot.name, 'snapshot.name') : undefined;
    const text = d.snapshot?.text !== undefined ? this.substitute(d.snapshot.text, 'snapshot.text') : undefined;
    if (narrowed) {
      // Only the record text the surface embedded in the description is narrowed; an authored
      // description ("Row for account {input.x}") is left alone.
      for (const t of [text, name]) {
        if (t !== undefined && narrowText(t) !== t) description = description.split(t).join(narrowText(t));
      }
    }
    const out: TargetDescriptor = { description, frame, locators };
    if (d.snapshot !== undefined) {
      out.snapshot = {
        ...d.snapshot,
        ...(name !== undefined ? { name: narrowed ? narrowText(name) : name } : {}),
        ...(text !== undefined ? { text: narrowed ? narrowText(text) : text } : {}),
      };
    }
    return out;
  }

  canonicalizeCondition(c: Condition): Condition {
    switch (c.kind) {
      case 'text_visible': {
        const out: Condition = { kind: 'text_visible', text: this.substitute(c.text, 'condition.text_visible.text') };
        if (c.frame !== undefined) out.frame = this.canonicalizeFramePath(c.frame);
        if (c.exact !== undefined) out.exact = c.exact;
        return out;
      }
      case 'text_absent': {
        const out: Condition = { kind: 'text_absent', text: this.substitute(c.text, 'condition.text_absent.text') };
        if (c.frame !== undefined) out.frame = this.canonicalizeFramePath(c.frame);
        return out;
      }
      case 'element_visible':
        return { kind: 'element_visible', target: this.canonicalizeDescriptor(c.target) };
      case 'element_absent':
        return { kind: 'element_absent', target: this.canonicalizeDescriptor(c.target) };
      case 'url_matches': {
        const out: Condition = { kind: 'url_matches', pattern: c.pattern };
        if (c.frame !== undefined) out.frame = this.canonicalizeFramePath(c.frame);
        return out;
      }
      case 'dialog_open':
        return c.messagePattern !== undefined ? { kind: 'dialog_open', messagePattern: c.messagePattern } : { kind: 'dialog_open' };
      case 'all':
        return { kind: 'all', of: c.of.map((x) => this.canonicalizeCondition(x)) };
      case 'any':
        return { kind: 'any', of: c.of.map((x) => this.canonicalizeCondition(x)) };
      case 'not':
        return { kind: 'not', of: this.canonicalizeCondition(c.of) };
    }
  }

  private canonicalizeAction(a: Action): Action {
    switch (a.type) {
      case 'navigate':
        return { type: 'navigate', url: this.canonicalizeUrl(a.url) };
      case 'click':
        return { type: 'click', target: this.canonicalizeDescriptor(a.target) };
      case 'type': {
        const target = this.canonicalizeDescriptor(a.target);
        const value = a.value.kind === 'literal' ? { kind: 'literal' as const, value: this.substitute(a.value.value, 'action.type.value') } : a.value;
        const out: Action = { type: 'type', target, value };
        if (a.clear !== undefined) out.clear = a.clear;
        if (a.pressEnter !== undefined) out.pressEnter = a.pressEnter;
        return out;
      }
      case 'select': {
        const target = this.canonicalizeDescriptor(a.target);
        const value =
          a.value.kind === 'literal' ? { kind: 'literal' as const, value: this.substitute(a.value.value, 'action.select.value') } : a.value;
        return { type: 'select', target, value };
      }
      case 'press':
        return a;
      case 'extract': {
        const target = this.canonicalizeDescriptor(a.target);
        const out: Action = { type: 'extract', target, output: a.output };
        if (a.parse !== undefined) out.parse = a.parse;
        if (a.pattern !== undefined) out.pattern = a.pattern;
        if (a.identity !== undefined) out.identity = a.identity;
        return out;
      }
      case 'wait': {
        const out: Action = { type: 'wait', condition: this.canonicalizeCondition(a.condition) };
        if (a.timeoutMs !== undefined) out.timeoutMs = a.timeoutMs;
        return out;
      }
      case 'dismiss_dialog':
        return a;
      case 'switch_frame':
        return { type: 'switch_frame', frame: this.canonicalizeFramePath(a.frame) };
    }
  }

  identityFor(read: { scope: RecordTextWithin; text: string }): ExtractIdentity | undefined {
    const candidates = this.qualifyingInputs.filter((i) => this.opts.inputs[i.name]?.sensitive !== true && recordTextShows(read.text, i.value));
    if (candidates.length === 0) return undefined;
    // The input a recorded step drove first: its value typed or selected, or its placeholder in a url or target.
    const order = new Map<string, number>();
    this.stepsInternal.forEach((step, index) => {
      const names = new Set<string>();
      collectInputBindingNames(step.action, names);
      for (const n of collectInputPlaceholders(step.action)) names.add(n);
      for (const n of names) if (!order.has(n)) order.set(n, index);
    });
    const first = [...candidates].sort((a, b) => (order.get(a.name) ?? Infinity) - (order.get(b.name) ?? Infinity))[0]!;
    return { input: first.name, within: read.scope };
  }

  // --- recording -----------------------------------------------------------------------------

  recordStep(s: RecordStepInput): Step {
    let action = this.canonicalizeAction(s.action);
    if (s.scopedTarget !== undefined && 'target' in action) action = { ...action, target: s.scopedTarget } as Action;
    const id = `s${String(this.stepsInternal.length + 1).padStart(2, '0')}`;
    const name = shortStepName(s.why);
    const step: Step = { id, name, action, risk: s.risk };
    if (s.postcondition !== undefined) step.postcondition = this.canonicalizeCondition(s.postcondition);
    if (s.onFailure !== undefined) step.onFailure = s.onFailure;
    this.stepsInternal.push(step);
    this.awaitingLocation = {
      index: this.stepsInternal.length - 1,
      frame: 'target' in s.action ? s.action.target.frame : [],
      before: this.lastLocation,
    };
    return step;
  }

  /** The input-bound `url_matches` check for a raw URL seen in `frame` (a single check, or an
   *  `all` of one per pinned URL part), or undefined when the URL holds no declared input's run
   *  value. The URL goes through `canonicalizeUrl`, so the same whole-token, 3+ character rule
   *  that templates every other string decides what is bound. A check that would carry a secret
   *  or sensitive value is dropped rather than failing the build. */
  private inputBoundUrlCheck(rawUrl: string, frame: FramePath): Condition | undefined {
    const canonical = this.canonicalizeUrl(rawUrl);
    const tail = canonical.startsWith('{baseUrl}') ? canonical.slice('{baseUrl}'.length) : canonical.replace(URL_ORIGIN_RE, '');
    const patterns = inputBoundUrlPatterns(tail);
    if (patterns.length === 0 || findLeaks(patterns, this.forbiddenAll).length > 0) return undefined;
    const checks: Condition[] = patterns.map((pattern) =>
      frame.length > 0 ? { kind: 'url_matches', pattern, frame: this.canonicalizeFramePath(frame) } : { kind: 'url_matches', pattern },
    );
    return checks.length === 1 ? checks[0] : { kind: 'all', of: checks };
  }

  /** The input-bound URL check for the first of `scopes` whose URL in `location` supports one;
   *  `changedSince`, when given, skips a frame whose URL is the same there. */
  private firstInputBoundUrlCheck(location: ObservedLocation, scopes: FramePath[], changedSince?: ObservedLocation): Condition | undefined {
    for (const scope of scopes) {
      const url = urlInFrame(location, scope);
      if (url === undefined) continue;
      if (changedSince !== undefined && urlInFrame(changedSince, scope) === url) continue;
      const check = this.inputBoundUrlCheck(url, scope);
      if (check !== undefined) return check;
    }
    return undefined;
  }

  noteLocation(location: ObservedLocation): void {
    const awaiting = this.awaitingLocation;
    this.awaitingLocation = undefined;
    this.lastLocation = location;
    if (awaiting === undefined) return;
    const step = this.stepsInternal[awaiting.index];
    if (step === undefined) return;
    const check = this.firstInputBoundUrlCheck(location, urlScopes(awaiting.frame), awaiting.before);
    if (check === undefined) return;
    step.postcondition = withCheckpoint(step.postcondition, check);
    this.opts.onLog?.(`checkpoint: step ${step.id} postcondition binds the landing URL to an input`, { stepId: step.id });
  }

  recordOutput(name: string, parse: ParseMode, why: string, opts?: { sensitive?: boolean }): void {
    const type = jsonTypeFromParse(parse);
    const description = this.opts.outputsHint?.[name]?.description ?? why;
    const sensitive = opts?.sensitive === true || this.outputsInternal[name]?.sensitive === true;
    this.outputsInternal[name] = { type, description: this.canonicalizeString(description), ...(sensitive ? { sensitive: true } : {}) };
  }

  /** Defect 3: name a recovery rule from the modal's own TITLE -- the first 4 words of
   *  `title`, snake_cased (the schema's `RecoveryRule.name` is `Identifier`, i.e.
   *  `[A-Za-z_][A-Za-z0-9_]*`; it does not allow kebab-case, so this follows the schema), capped
   *  at 40 chars. NEVER derived from the trigger text: the trigger is typically the notice's
   *  longer body copy (e.g. "Scheduled maintenance Sunday 02:00-04:00 ET. Some functions may be
   *  unavailable."), and naming off it is exactly what produced the real buggy artifact's
   *  "dismiss_scheduled_maintenance_sunday_02_00_04_00_et". Falls back to
   *  `dismiss_interstitial_<n>` when `title` is absent/empty or has no usable word characters at
   *  all (e.g. pure punctuation). */
  private recoveryRuleName(title: string | undefined): string {
    const trimmedTitle = (title ?? '').trim();
    if (trimmedTitle === '') return `dismiss_interstitial_${this.recoveryRulesInternal.length + 1}`;
    const words = trimmedTitle.split(/\s+/).filter(Boolean).slice(0, 4).join(' ');
    const wordsIdent = toIdentifier(words);
    const usable = wordsIdent !== '' && wordsIdent !== 'x';
    let name = usable ? `dismiss_${wordsIdent}` : `dismiss_interstitial_${this.recoveryRulesInternal.length + 1}`;
    if (name.length > 40) {
      const truncated = name.slice(0, 40).replace(/_[^_]*$/, '');
      name = truncated.length > 0 ? truncated : name.slice(0, 40);
    }
    return name;
  }

  recordRecovery(r: { triggerText: string; title?: string; frame?: FramePath; dismissTarget: TargetDescriptor; description: string; scopedTarget?: TargetDescriptor }): RecoveryRule {
    const canonicalTrigger = this.canonicalizeString(r.triggerText);
    const canonicalFrame = r.frame !== undefined ? this.canonicalizeFramePath(r.frame) : undefined;
    const trigger: Condition =
      canonicalFrame !== undefined
        ? { kind: 'text_visible', text: canonicalTrigger, frame: canonicalFrame }
        : { kind: 'text_visible', text: canonicalTrigger };

    // `dismiss_interstitial_<n>` is unique per CALL (n keeps counting up), not per notice, so an
    // untitled notice is matched against earlier rules by its trigger CONDITION (text + frame);
    // a titled one by its name.
    const dismissTarget = r.scopedTarget ?? this.canonicalizeDescriptor(r.dismissTarget);
    const untitled = (r.title ?? '').trim() === '';
    const existingIdx = untitled
      ? this.recoveryRulesInternal.findIndex((rule) => triggerConditionsEqual(rule.trigger, trigger))
      : this.recoveryRulesInternal.findIndex((rule) => rule.name === this.recoveryRuleName(r.title));
    const existing = existingIdx >= 0 ? this.recoveryRulesInternal[existingIdx] : undefined;
    // Same notice, same dismiss control: keep the rule already recorded. Same notice, different
    // control: the latest successful dismissal wins, under the existing rule's name.
    if (existing && JSON.stringify(recoveryClickTarget(existing)) === JSON.stringify(dismissTarget)) return existing;

    const name = existing?.name ?? this.recoveryRuleName(r.title);
    const waitCondition: Condition =
      canonicalFrame !== undefined
        ? { kind: 'text_absent', text: canonicalTrigger, frame: canonicalFrame }
        : { kind: 'text_absent', text: canonicalTrigger };

    const rule: RecoveryRule = {
      name,
      description: this.canonicalizeString(r.description),
      trigger,
      actions: [
        { type: 'click', target: dismissTarget },
        { type: 'wait', condition: waitCondition, timeoutMs: 5000 },
      ],
      maxAttempts: 2,
    };
    if (existing) {
      this.opts.onLog?.(`recordRecovery: replacing recovery rule ${name} with a different dismiss target`, { name });
      this.recoveryRulesInternal[existingIdx] = rule;
    } else {
      this.recoveryRulesInternal.push(rule);
    }
    return rule;
  }

  recordOutcome(o: RecordOutcomeInput): BusinessOutcome {
    const name = toIdentifier(o.name);
    const canonicalDetector = this.canonicalizeString(o.detectorText);
    const canonicalFrame = o.frame !== undefined ? this.canonicalizeFramePath(o.frame) : undefined;
    const detector: Condition =
      canonicalFrame !== undefined
        ? { kind: 'text_visible', text: canonicalDetector, frame: canonicalFrame }
        : { kind: 'text_visible', text: canonicalDetector };

    const returns: Record<string, OutputSpec> = {};
    const extract: OutcomeExtract[] = [];
    for (const ret of o.returns) {
      returns[ret.output] = {
        type: jsonTypeFromParse(ret.parse),
        description: this.canonicalizeString(ret.description),
        ...(ret.sensitive === true ? { sensitive: true } : {}),
      };
      extract.push({ output: ret.output, target: ret.scoped === true ? ret.target : this.canonicalizeDescriptor(ret.target), parse: ret.parse });
    }

    const outcome: BusinessOutcome = {
      name,
      description: this.canonicalizeString(o.description),
      detector,
      returns,
    };
    if (extract.length > 0) outcome.extract = extract;
    if (this.stepsInternal.length > 0) outcome.afterSteps = [this.stepsInternal[this.stepsInternal.length - 1]!.id];

    const idx = this.outcomesInternal.findIndex((x) => x.name === name);
    if (idx >= 0) {
      this.opts.onLog?.(`recordOutcome: replacing existing outcome ${name}`, { name });
      this.outcomesInternal[idx] = outcome;
    } else {
      this.outcomesInternal.push(outcome);
    }
    return outcome;
  }

  sanitizeExtractedTarget(target: TargetDescriptor, outputName: string, rawValue: string, detectorText?: string): SanitizeExtractResult {
    const norm = collapseWs(rawValue).toLowerCase();
    if (norm === '') return { ok: true, target };
    if (detectorText !== undefined && collapseWs(detectorText).toLowerCase().includes(norm)) return { ok: true, target };

    // A selector can encode the value too (`span.status-shipped` for "Shipped"): such a locator
    // finds only records holding this run's value, and the build's leak check would refuse it.
    // Compared alnum-folded on both sides: "In transit" is slugged as `status-in-transit`.
    const folded = alnumFold(rawValue);
    const selectorCarriesValue = (s: Locator['strategy']): boolean => {
      const sels = s.kind === 'css' ? [s.selector] : s.kind === 'relative' ? [s.selector, s.within] : [];
      return folded.length >= MIN_SCRUB_VALUE_LEN && sels.some((sel) => sel !== undefined && alnumFold(sel).includes(folded));
    };
    const keptLocators = target.locators.filter((l) => {
      const v = locatorValueText(l.strategy);
      return (v === undefined || collapseWs(v).toLowerCase() !== norm) && !selectorCarriesValue(l.strategy);
    });
    if (keptLocators.length === 0) {
      return {
        ok: false,
        error: `every locator for output "${outputName}" matches on the extracted value itself ("${rawValue.trim()}"); none would survive as a reusable locator`,
      };
    }

    // Review fix: register only once we know this call SUCCEEDS -- the docstring promises the
    // all-dropped failure above leaves everything unmutated, so registration must come after it.
    const trimmed = rawValue.trim();
    if (trimmed.length >= MIN_SCRUB_VALUE_LEN) {
      this.extractedValuesByName.set(outputName, trimmed);
    } else {
      this.extractedValuesByName.delete(outputName);
    }
    const dropped = keptLocators.length !== target.locators.length;
    // The description names the first locator; rebuild it only when that one may be gone.
    const out: TargetDescriptor = dropped ? { ...target, description: formatDescriptorDescription(keptLocators[0]!, target.snapshot), locators: keptLocators } : { ...target };
    // The snapshot holds the record-time value whether or not a locator did (a value whose text
    // is not unique has no text locator, but its snapshot still reads "In transit").
    if (target.snapshot !== undefined) {
      const snap = { ...target.snapshot };
      let changed = false;
      if (snap.text !== undefined && collapseWs(snap.text).toLowerCase() === norm) {
        delete snap.text;
        changed = true;
      }
      // `snapshot.name` is the accessible-name equivalent of the same record-time value (a value
      // cell's ARIA name is usually its own text) -- drop it too when it's the value, for the
      // same reason `snapshot.text` is dropped.
      if (snap.name !== undefined && collapseWs(snap.name).toLowerCase() === norm) {
        delete snap.name;
        changed = true;
      }
      if (changed) out.snapshot = snap;
    }
    return { ok: true, target: dropped || out.snapshot !== target.snapshot ? out : target };
  }

  setSuccess(condition: Condition, description: string): void {
    let canonical = this.canonicalizeCondition(condition);
    if (this.lastLocation !== undefined) {
      const check = this.firstInputBoundUrlCheck(this.lastLocation, urlScopes(conditionFrame(condition)));
      if (check !== undefined) {
        canonical = withCheckpoint(canonical, check);
        this.opts.onLog?.('checkpoint: success condition binds the final URL to an input');
      }
    }
    this.successInternal = { condition: canonical, description: this.canonicalizeString(description) };
  }

  markHumanInvolved(note: string): void {
    this.recordedBy = 'mixed';
    this.notes.push(this.canonicalizeString(note));
  }

  addNote(note: string): void {
    this.notes.push(this.canonicalizeString(note));
  }

  get steps(): readonly Step[] {
    return this.stepsInternal;
  }
  get outcomes(): readonly BusinessOutcome[] {
    return this.outcomesInternal;
  }
  get recoveryRules(): readonly RecoveryRule[] {
    return this.recoveryRulesInternal;
  }
  get extractedValues(): readonly { name: string; value: string }[] {
    return [...this.extractedValuesByName].map(([name, value]) => ({ name, value }));
  }

  scrubExtractedValues(cap: Capability): Capability {
    return scrubExtractedValuesFromCapability(cap, this.extractedValues);
  }

  // --- build ---------------------------------------------------------------------------------

  private repair(draft: Capability, issues: CapabilityIssue[], repairs: string[]): Capability {
    let next = draft;
    for (const issue of issues) {
      switch (issue.code) {
        case 'output_not_produced': {
          const key = issue.path[1];
          if (typeof key === 'string' && Object.prototype.hasOwnProperty.call(next.outputs, key)) {
            const rest = { ...next.outputs };
            delete rest[key];
            next = { ...next, outputs: rest };
            repairs.push(`removed output "${key}": not produced by any step extract`);
          }
          break;
        }
        case 'undeclared_output': {
          const stepIdx = issue.path[1];
          if (typeof stepIdx === 'number') {
            const step = next.steps[stepIdx];
            if (step && step.action.type === 'extract') {
              const outName = step.action.output;
              if (!Object.prototype.hasOwnProperty.call(next.outputs, outName)) {
                next = { ...next, outputs: { ...next.outputs, [outName]: { type: 'string', description: `Extracted value ${outName}` } } };
                repairs.push(`declared output "${outName}": produced by step ${step.id} but missing from outputs`);
              }
            }
          }
          break;
        }
        case 'risk_level_mismatch': {
          const maxRisk = computeMaxRisk(next.steps);
          next = { ...next, riskLevel: maxRisk };
          repairs.push(`recomputed riskLevel to "${maxRisk}"`);
          break;
        }
        case 'unknown_step_ref': {
          next = this.dropBadStepRef(next, issue, repairs);
          break;
        }
        case 'invalid_auth': {
          if (next.auth !== undefined) {
            const rest: Capability = { ...next };
            delete rest.auth;
            next = rest;
            repairs.push('removed the auth block: it did not validate (relogin falls back to deriving it at run time)');
          }
          break;
        }
        case 'unknown_input':
        default:
          break;
      }
    }
    return next;
  }

  private dropBadStepRef(cap: Capability, issue: CapabilityIssue, repairs: string[]): Capability {
    const [section, oi, field, ai] = issue.path;
    if (section === 'businessOutcomes' && typeof oi === 'number' && field === 'afterSteps' && typeof ai === 'number') {
      const outcome = cap.businessOutcomes[oi];
      if (outcome?.afterSteps) {
        const outcomes = cap.businessOutcomes.slice();
        const newAfterSteps = outcome.afterSteps.filter((_, idx) => idx !== ai);
        const updated: BusinessOutcome = { ...outcome };
        if (newAfterSteps.length > 0) updated.afterSteps = newAfterSteps;
        else delete updated.afterSteps;
        outcomes[oi] = updated;
        repairs.push(`dropped invalid afterSteps entry from outcome "${outcome.name}"`);
        return { ...cap, businessOutcomes: outcomes };
      }
    }
    return cap;
  }

  /** `this.forbiddenAll` (secrets + sensitive input values) PLUS every value registered via
   *  `sanitizeExtractedTarget` so far. Review fix: a draft written on ANY failure path (schema
   *  invalid, capability-invalid after validate/repair, or a residual secret/sensitive leak) must
   *  redact extracted values too -- `output_value_in_artifact` can fire on a field the (b) scrub
   *  deliberately never touches (a Condition's match text: a postcondition, `success.condition`,
   *  a business-outcome detector, a recovery trigger), so without this the WRITTEN
   *  `capability.draft.json` would still contain the raw value even though `issues` correctly
   *  reports the leak. `forbiddenAll` itself is not mutated (it is set once in the constructor,
   *  before any run-time value is known, and used elsewhere too); this recomputes the combined
   *  list fresh from current state each time. */
  private draftRedactionValues(): string[] {
    return [...this.forbiddenAll, ...this.extractedValuesByName.values()];
  }

  build(meta: BuildMeta): BuildResult {
    const warnings: string[] = [];
    const repairs: string[] = [];

    const entryUrl = this.canonicalizeUrl(meta.entryUrl);
    const app: Capability['app'] = {
      vendor: meta.app.vendor,
      product: meta.app.product,
      surface: meta.app.surface,
      entryUrl,
    };
    if (meta.app.productVersion !== undefined) app.productVersion = meta.app.productVersion;
    if (meta.app.tenant !== undefined) app.tenant = meta.app.tenant;

    if (this.successInternal === undefined) {
      const partialDraft = {
        schemaVersion: '1.0',
        id: meta.id,
        app,
        steps: this.stepsInternal,
      };
      return {
        ok: false,
        draft: redactDeep(partialDraft, this.draftRedactionValues()),
        issues: [{ code: 'schema', path: ['success'], message: 'success condition was never set (call setSuccess before build)' }],
        warnings,
        repairs,
      };
    }

    // inputs, minus anything never referenced anywhere in the capability.
    const allInputSpecs: Record<string, InputSpec> = {};
    for (const [name, decl] of Object.entries(this.opts.inputs)) {
      const isAllDigits = /^[0-9]+$/.test(decl.value);
      const spec: InputSpec = {
        type: decl.type,
        description: this.canonicalizeString(decl.description),
        required: true,
        sensitive: decl.sensitive,
      };
      if (isAllDigits) spec.pattern = '^\\d+$';
      allInputSpecs[name] = spec;
    }

    const referenced = new Set<string>();
    collectInputPlaceholders(this.stepsInternal, referenced);
    collectInputPlaceholders(this.successInternal, referenced);
    collectInputPlaceholders(this.outcomesInternal, referenced);
    collectInputPlaceholders(this.recoveryRulesInternal, referenced);
    collectInputPlaceholders(entryUrl, referenced);
    collectInputBindingNames(this.stepsInternal, referenced);
    collectInputBindingNames(this.recoveryRulesInternal, referenced);

    const inputs: Record<string, InputSpec> = {};
    for (const [name, spec] of Object.entries(allInputSpecs)) {
      if (referenced.has(name)) {
        inputs[name] = spec;
      } else {
        const message = `input "${name}" is never referenced in the capability; dropped`;
        warnings.push(message);
        this.opts.onLog?.(`build: ${message}`, { input: name });
      }
    }

    const riskLevel = computeMaxRisk(this.stepsInternal);
    const name = meta.name ?? titleCaseFromId(meta.id);
    // Defect 1(c): `description` is the goal text (canonicalized) ONLY -- never the model's
    // `done.summary`. The summary may name this run's specific record (a balance, a member
    // name); folding it into `description` would persist that into a reusable artifact.
    // `success.description` (set by `setSuccess`, called with the model's summary) is where the
    // summary belongs, and it goes through the extracted-value scrub below like everything else.
    const description = this.canonicalizeString(meta.goal);

    const provenance: Capability['provenance'] = {
      discoveredAt: meta.discoveredAt,
      discoveryRunId: meta.runId,
      recordedBy: this.recordedBy,
      model: meta.model,
    };
    if (this.notes.length > 0) provenance.notes = this.notes.join('; ');

    let draft: Capability = {
      schemaVersion: '1.0',
      id: meta.id,
      version: '1.0.0',
      name,
      description,
      app,
      status: 'draft',
      riskLevel,
      ...(meta.readOnly === true ? { readOnly: true as const } : {}),
      inputs,
      outputs: { ...this.outputsInternal },
      steps: [...this.stepsInternal],
      success: this.successInternal,
      businessOutcomes: [...this.outcomesInternal],
      recoveryRules: [...this.recoveryRulesInternal],
      provenance,
    };

    // Defect 1(b): scrub every registered extracted value out of the artifact's free-text prose
    // fields (description/success.description/step names/target descriptions/outcome & recovery
    // descriptions/provenance notes/input & output descriptions) before validating.
    draft = scrubExtractedValuesFromCapability(draft, this.extractedValues);

    // The sign-in steps and signed-in condition, by the same rule `relogin` applies at run time to
    // an artifact without the block (schema/auth.ts), so the block only freezes and exposes it.
    const auth = deriveAuth(draft);
    if (auth !== undefined) {
      draft = { ...draft, auth };
      this.opts.onLog?.(`build: auth block covers steps ${auth.steps.join(', ')}`, { authSteps: auth.steps.length });
    }

    // Defect 1: enforce the leak check at emission time, not just where this recorder happened to
    // scrub -- validateCapability's knownValues option re-scans the WHOLE artifact for any of
    // these values, so a spot this recorder missed fails the build rather than silently shipping.
    const validateOptions: ValidateCapabilityOptions = {
      ...meta.validateOptions,
      knownValues: [...(meta.validateOptions?.knownValues ?? []), ...this.extractedValuesByName.values()],
    };

    let result = validateCapability(draft, validateOptions);
    if (!result.ok) {
      draft = this.repair(draft, result.issues, repairs);
      result = validateCapability(draft, validateOptions);
    }
    if (!result.ok) {
      return { ok: false, draft: redactDeep(draft, this.draftRedactionValues()), issues: result.issues, warnings, repairs };
    }

    const leaks = findLeaks(result.capability, this.forbiddenAll);
    if (leaks.length > 0) {
      const issues: CapabilityIssue[] = leaks.map((pointer) => ({
        code: 'schema',
        path: pointerToPath(pointer),
        message: 'secret or sensitive value would be persisted',
      }));
      return { ok: false, draft: redactDeep(draft, this.draftRedactionValues()), issues, warnings, repairs };
    }

    for (const w of result.warnings) {
      const message = `${w.code} at ${w.path.join('.')}: ${w.message}`;
      warnings.push(message);
      this.opts.onLog?.(`build: ${message}`, { code: w.code });
    }
    return { ok: true, capability: result.capability, warnings, repairs };
  }
}

// -------------------------------------------------------------------------------------------
// Whole-token, longest-first, placeholder-safe substitution.
// -------------------------------------------------------------------------------------------

function protectedSpans(s: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const re = /\{[^{}]*\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) spans.push([m.index, m.index + m[0].length]);
  return spans;
}

function replaceWholeToken(
  s: string,
  value: string,
  placeholder: string,
  protectedRanges: ReadonlyArray<[number, number]>,
): { result: string; count: number } {
  const re = wholeTokenRegex(value);
  let result = '';
  let last = 0;
  let count = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    const overlapping = protectedRanges.some(([s0, e0]) => start < e0 && end > s0);
    if (overlapping) continue;
    result += s.slice(last, start) + placeholder;
    last = end;
    count += 1;
  }
  result += s.slice(last);
  return { result, count };
}

/** Creates a fresh {@link Recorder} for one discovery run. */
export function createRecorder(opts: RecorderOptions): Recorder {
  return new RecorderImpl(opts);
}

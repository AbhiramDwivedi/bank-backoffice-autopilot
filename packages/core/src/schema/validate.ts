import { Capability } from './capability.js';
import type {
  BusinessOutcome,
  OutcomeExtract,
  PartialAction,
  RecoveryRule,
  TenantOverride,
} from './capability.js';
import { RISK_ORDER } from './action.js';
import type { Action, Condition, RiskClass, Step } from './action.js';
import type { TargetDescriptor } from './locator.js';
import { isPositional, isPositionalOnly } from './positional.js';
import { collectInputPlaceholders, wholeTokenRegex } from './template.js';
import { dependsOnRunInputs, isSecretBound, isSubmitStep } from './auth.js';
import { findRedundantRepeats } from './step-equivalence.js';

/** Machine-readable reason code for one {@link CapabilityIssue}; see the inline comments on each
 * member for what triggers it. */
export type CapabilityIssueCode =
  | 'schema' // zod parse error (other than version)
  | 'invalid_semver' // zod error at path ['version'] is mapped to this code
  | 'duplicate_step_id'
  | 'unknown_input' // {kind:'input', name} binding, or `{input.name}` placeholder in any string replay binds, not declared in inputs: app.entryUrl, step actions/pre/postconditions (urls, locators, descriptions, literal values, wait conditions), success.condition, businessOutcomes detector/extract, recoveryRules trigger/actions, overrides (entryUrl, stepPatches, extraSteps)
  | 'output_not_produced' // capability.outputs key with no step `extract` action producing it
  | 'undeclared_output' // step extract `output` not declared in capability.outputs
  | 'outcome_return_mismatch' // businessOutcome: returns key not produced by that outcome's extract[], or extract output not in returns
  | 'risk_level_mismatch' // capability.riskLevel !== max(step.risk) using RISK_ORDER
  | 'unknown_step_ref' // businessOutcomes[].afterSteps, overrides[].stepPatches[].stepId, overrides[].extraSteps[].afterStepId not a real step id
  | 'irreversible_recovery_action' // a recoveryRules[].actions[] entry whose target (click/type/select) matches an irreversible text pattern
  | 'invalid_regex' // any regex source that does not compile: url_matches.pattern, dialog_open.messagePattern (recurse all conditions: step pre/post, wait actions, success, detectors, triggers), InputSpec.pattern, extract pattern (steps + outcome extracts)
  | 'regex_parse_needs_pattern' // extract with parse:'regex' but no pattern (steps and outcome extracts)
  | 'positional_only_target' // warning only (reported in `warnings`, never in `issues`): an extract (a step's, a business outcome's, or one a tenant override adds or retargets) whose target chain holds only positional locators (a bbox, a structural css; see positional.ts). Replay refuses a positional fallback for a read when the chain names the value, but a chain that names nothing can only be read by position: whatever sits there is returned, and nothing can check it
  | 'read_without_record_identity' // warning only (reported in `warnings`, never in `issues`): a step extract that follows a step driven by a non-sensitive input but carries no `identity` check, so replay cannot verify that the value read belongs to the record that input names. Discovery records the check only when the record's container showed the input at record time; a card that shows only a name (a search by e-mail) cannot be checked
  | 'plaintext_credential' // type/select action with {kind:'literal'} value whose target looks like a password field (any locator role/label/text/name or snapshot name/text/description matching /pass(word|code)|\bpin\b|secret/i) — credentials must use {kind:'secret'} or a sensitive input
  | 'sensitive_input_not_sensitive' // an input bound into a password-like target (same test) whose InputSpec.sensitive is false
  | 'sensitive_input_has_example' // InputSpec.sensitive is true but .example is set — example values are documentation/UI fodder, not a redaction boundary, so a real value there would leak
  | 'override_action_type_mismatch' // a tenant stepPatch whose action.type differs from the patched step's action.type
  | 'override_irreversible_change' // a tenant override (extraSteps or stepPatches target/action) declares/targets an irreversible-looking step — a TenantOverride carries no approval of its own, so it must never smuggle a step the base capability's approval never covered
  | 'invalid_auth' // the `auth` block: an id that is not a step, ids that are not the capability's first steps in order (a contiguous run from s01), no secret-bound step among them, an irreversible / input-dependent / extract step among them, a last step that is not a submit, or a signedIn that depends on inputs or proves nothing (only negations)
  | 'unverified_input_binding' // warning only (reported in `warnings`, never in `issues`): steps act on a non-sensitive input (placeholder in a navigate url or target, or an input-bound typed/selected value), yet no condition at or after the last of them, or after a click following them, binds any input (a postcondition or wait condition of that or a later step, or success.condition), so replay cannot tell the result belongs to that input
  | 'read_only_irreversible' // readOnly: true on a capability whose riskLevel is irreversible, or that has an irreversible step, tenant-override extra step, or recovery action -- the read-only declaration lets the optimizer replay mutated variants, so it must never sit on anything irreversible
  | 'redundant_repeated_step' // warning only (reported in `warnings`, never in `issues`): a step is a provably redundant repeat of the step right before it (same idempotent `type`-with-clear or `select`, same target chain and value binding; see step-equivalence.ts) -- typically a discovery retry recorded twice. Replay still works; `cu optimize` collapses it
  | 'unbound_outcome_detector' // warning only: a business-outcome detector that binds no input, checked after a step that submits form state an earlier step typed/selected from an input, with no input-bound condition between them -- an emptied form (a lost session) matches it too and reports the outcome for an input never submitted
  | 'output_value_in_artifact'; // opts.knownValues: a record-time value (typically an extract's raw output) appears in the artifact's own strings (as a whole token, or as a substring in a css selector, URL or URL pattern; machine-generated identity fields excluded), case-insensitively and whitespace-collapsed -- data extracted FROM a run must not persist as reusable artifact content

/** One problem found by {@link validateCapability}, with a path into the capability JSON and a
 * human-readable message. */
export interface CapabilityIssue {
  code: CapabilityIssueCode;
  path: (string | number)[];
  message: string;
}

/** Options for {@link validateCapability}. */
export interface ValidateCapabilityOptions {
  /** Regex sources compiled with 'i'. Default DEFAULT_IRREVERSIBLE_TEXT_PATTERNS. */
  irreversibleTextPatterns?: readonly string[];
  /** Regex sources compiled with 'i', tested against recovery-rule navigate URLs. Default none; pass policy.risk.irreversibleUrlPatterns. */
  irreversibleUrlPatterns?: readonly string[];
  /**
   * Record-time values (typically the raw values an `extract` step read off the page during
   * discovery) that must never appear anywhere in the artifact's own strings. Matched as a whole
   * token (not inside a longer word or number), case-insensitively with internal whitespace
   * collapsed, so formatting differences (extra spaces, a line break) don't hide a leak. CSS
   * selectors, URLs and URL patterns are matched as plain substrings instead, since a value can
   * sit glued to other characters there (`tr#member12345`). The artifact's machine-generated
   * identity fields (schemaVersion, id, version, name, app vendor/product/productVersion/tenant,
   * provenance other than `notes`, step ids and step references, override tenant) are not
   * checked. Values shorter than 3 characters are skipped: a
   * short value ("OK", "1", "$") would match unrelated, legitimate text throughout the artifact,
   * turning this into noise rather than a signal.
   */
  knownValues?: readonly string[];
}

/** Default `irreversibleTextPatterns` used when
 * {@link ValidateCapabilityOptions.irreversibleTextPatterns} is omitted. */
export const DEFAULT_IRREVERSIBLE_TEXT_PATTERNS: readonly string[] = [
  '^(submit|confirm|create|open account|transfer|delete|approve|post)\\b',
];

/** Result of {@link validateCapability}. `warnings` flags a valid capability's weak spots (see
 *  `unverified_input_binding`, `redundant_repeated_step`); they never make it invalid. */
export type ValidateCapabilityResult =
  | { ok: true; capability: Capability; issues: []; warnings: CapabilityIssue[] }
  | { ok: false; issues: CapabilityIssue[] };

/** Password-like target heuristic shared by plaintext_credential / sensitive_input_not_sensitive. */
const PASSWORD_LIKE_RE = /pass(word|code|phrase)|\bpin\b|secret|\botp\b|one[- ]time|security code|api[ _-]?key|token/i;

/** Texts for the password-like heuristic: targetTexts plus the description (css/bbox-only targets have nothing else). */
function credentialTexts(t: TargetDescriptor): string[] {
  return [...targetTexts(t), t.description];
}

/**
 * Texts for the irreversible-action heuristic (recovery-rule actions, tenant-override
 * extraSteps/stepPatches): `targetTexts` plus the target's own `description`.
 *
 * `targetTexts` alone is not enough here. A target identified only by a `css` locator (or a
 * `bbox` locator, or a `snapshot`-less descriptor) contributes nothing to `targetTexts` --
 * role/label/text/relative locators are the only ones it reads -- so an author could give the
 * control a perfectly honest, human-readable `description` ("Confirm transfer button") while the
 * locator itself carries no matching text, walking the irreversible-action check right past its
 * pattern list. `description` is always present (`NonEmpty`) and is the field most likely to be
 * read by a human, so it must be in scope here even though `credentialTexts` (a different,
 * narrower heuristic for a different check) already happens to include it too.
 */
function irreversibleCheckTexts(t: TargetDescriptor): string[] {
  return [...targetTexts(t), t.description];
}

/** Trims and collapses runs of whitespace to a single space, for tolerant text comparison. */
function collapseWs(s: string): string {
  return s.trim().replace(/\s+/g, ' ');
}

/** Depth-first walk of every string leaf in a JSON-like value, calling `visit(value, path)`. */
function walkStrings(node: unknown, path: (string | number)[], visit: (s: string, path: (string | number)[]) => void): void {
  if (typeof node === 'string') {
    visit(node, path);
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((v: unknown, i) => walkStrings(v, [...path, i], visit));
    return;
  }
  if (node !== null && typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) walkStrings(v, [...path, k], visit);
  }
}

const IDENTITY_TOP_LEVEL_KEYS: ReadonlySet<string | number> = new Set(['schemaVersion', 'id', 'version', 'name']);
const IDENTITY_APP_KEYS: ReadonlySet<string | number> = new Set(['vendor', 'product', 'productVersion', 'tenant']);
const IDENTITY_PROVENANCE_KEYS: ReadonlySet<string | number> = new Set(['discoveredAt', 'discoveryRunId', 'recordedBy', 'model']);
const STEP_REF_KEYS: ReadonlySet<string | number> = new Set(['stepId', 'afterStepId', 'afterSteps']);

/**
 * True for a machine-generated identity field rather than content: the top-level schemaVersion,
 * id, version and name (the name is the title-cased id unless the operator supplies one), the
 * app's vendor/product/productVersion/tenant, provenance bookkeeping (timestamp, run id, recorder,
 * model), step ids (base and override extra steps), step references, and an override's tenant.
 * A record-time value colliding with one of these ("Savings" in the id
 * "lookup-member-savings-account-type") is not a leak. Business-outcome and recovery-rule names
 * and every `notes` field are still checked.
 */
function isIdentityPath(path: readonly (string | number)[]): boolean {
  const [first, second] = path;
  const last = path[path.length - 1];
  if (path.length === 1 && IDENTITY_TOP_LEVEL_KEYS.has(first!)) return true;
  if (first === 'provenance' && path.length === 2 && IDENTITY_PROVENANCE_KEYS.has(second!)) return true;
  if (first === 'app' && path.length === 2 && IDENTITY_APP_KEYS.has(second!)) return true;
  if (path.some((seg) => STEP_REF_KEYS.has(seg))) return true;
  if (first === 'auth' && second === 'steps') return true;
  if (first === 'steps' && path.length === 3 && last === 'id') return true;
  if (first === 'overrides' && last === 'id' && path[path.length - 2] === 'step') return true;
  if (first === 'overrides' && path.length === 3 && last === 'tenant') return true;
  return false;
}

/**
 * True for a string leaf a record-time value can be glued into without a separator: a `css` or
 * `relative` locator's selector (`tr#member12345`), an `automation_id` locator's id (`rowMember12345`), a URL
 * (`app.entryUrl`, an override's `entryUrl`, a
 * `navigate` action's `url`) and a URL pattern (`url_matches.pattern`, a frame hop's
 * `urlPattern`). These are matched as plain substrings; every other leaf as a whole token.
 */
function isSubstringLeaf(key: string | number | undefined, parent: Record<string, unknown> | undefined): boolean {
  if (key === 'entryUrl' || key === 'urlPattern') return true;
  if (parent === undefined) return false;
  if (key === 'selector') return parent.kind === 'css' || parent.kind === 'relative';
  if (key === 'within') return parent.kind === 'relative';
  if (key === 'id') return parent.kind === 'automation_id';
  if (key === 'url') return parent.type === 'navigate';
  if (key === 'pattern') return parent.kind === 'url_matches';
  return false;
}

/** Like {@link walkStrings}, also passing the object holding each string leaf (undefined for an
 *  array element or the root). */
function walkStringLeaves(
  node: unknown,
  path: (string | number)[],
  parent: Record<string, unknown> | undefined,
  visit: (s: string, path: (string | number)[], parent: Record<string, unknown> | undefined) => void,
): void {
  if (typeof node === 'string') {
    visit(node, path, parent);
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((v: unknown, i) => walkStringLeaves(v, [...path, i], undefined, visit));
    return;
  }
  if (node !== null && typeof node === 'object') {
    const rec = node as Record<string, unknown>;
    for (const [k, v] of Object.entries(rec)) walkStringLeaves(v, [...path, k], rec, visit);
  }
}

/** `output_value_in_artifact`: flags every string leaf of `cap` outside its machine-generated
 *  identity fields ({@link isIdentityPath}) that contains one of `knownValues`,
 *  case-insensitively and whitespace-collapsed. Selectors, URLs and URL patterns
 *  ({@link isSubstringLeaf}) are matched as plain substrings; every other leaf as a whole token
 *  (see `wholeTokenRegex`), so "Active" is not found inside "Inactive". Values under 3 characters
 *  are dropped first (see {@link ValidateCapabilityOptions.knownValues}). */
/** `s` case-folded with everything but letters and digits removed: how a value reads once it has
 *  been slugged into a CSS class or id ("In transit" and `status-in-transit` both hold "intransit"). */
export function alnumFold(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

/** True for a CSS selector leaf (a `css` locator's selector, a `relative` locator's selector or
 *  `within`), where a value may appear slugged rather than verbatim. */
function isSelectorLeaf(key: string | number | undefined, parent: Record<string, unknown> | undefined): boolean {
  if (parent === undefined) return false;
  // A relative locator's anchor object has no `kind`: its `selector` is the one with a `text` beside it.
  const isAnchor = parent.kind === undefined && typeof parent.text === 'string';
  return (key === 'selector' && (parent.kind === 'css' || parent.kind === 'relative' || isAnchor)) || (key === 'within' && parent.kind === 'relative');
}

function checkKnownValues(cap: Capability, knownValues: readonly string[] | undefined, issues: CapabilityIssue[]): void {
  const needles = [...new Set((knownValues ?? []).map((v) => collapseWs(v)).filter((v) => v.length >= 3))];
  if (needles.length === 0) return;
  const patterns = needles.map((n) => wholeTokenRegex(n, 'i'));
  const lowered = needles.map((n) => n.toLowerCase());
  const folded = needles.map((n) => alnumFold(n));
  walkStringLeaves(cap, [], undefined, (s, path, parent) => {
    if (isIdentityPath(path)) return;
    const hay = collapseWs(s);
    const key = path[path.length - 1];
    const substring = isSubstringLeaf(key, parent);
    const selector = isSelectorLeaf(key, parent);
    const hayLower = hay.toLowerCase();
    const hayFolded = selector ? alnumFold(hay) : '';
    for (let i = 0; i < needles.length; i++) {
      const slugHit = selector && folded[i]!.length >= 3 && hayFolded.includes(folded[i]!);
      if (slugHit || (substring ? hayLower.includes(lowered[i]!) : patterns[i]!.test(hay))) {
        issues.push({ code: 'output_value_in_artifact', path, message: `value "${needles[i]}" would be persisted in the artifact` });
        break;
      }
    }
  });
}

/** Compiles every FrameHop.urlPattern anywhere in the parsed capability (targets, condition frames, patches). */
function checkFrameUrlPatterns(node: unknown, path: (string | number)[], issues: CapabilityIssue[]): void {
  if (Array.isArray(node)) {
    node.forEach((v: unknown, i) => checkFrameUrlPatterns(v, [...path, i], issues));
    return;
  }
  if (node === null || typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node)) {
    if (k === 'frame' && Array.isArray(v)) {
      v.forEach((hop: unknown, hi) => {
        if (hop !== null && typeof hop === 'object' && 'urlPattern' in hop && typeof hop.urlPattern === 'string') {
          tryCompileRegex(hop.urlPattern, [...path, 'frame', hi, 'urlPattern'], issues);
        }
      });
    } else {
      checkFrameUrlPatterns(v, [...path, k], issues);
    }
  }
}

/**
 * Walks a Condition tree depth-first, calling fn on every node (including all/any/not nodes).
 */
export function walkCondition(
  c: Condition,
  fn: (c: Condition, path: (string | number)[]) => void,
  path: (string | number)[] = [],
): void {
  fn(c, path);
  switch (c.kind) {
    case 'all':
    case 'any':
      c.of.forEach((sub, i) => walkCondition(sub, fn, [...path, 'of', i]));
      break;
    case 'not':
      walkCondition(c.of, fn, [...path, 'of']);
      break;
    default:
      break;
  }
}

/**
 * Strings a target could be named by: role names, labels, texts, relative anchor texts,
 * snapshot name/text. Used for irreversible-text and password-like checks.
 */
export function targetTexts(t: TargetDescriptor): string[] {
  const out: string[] = [];
  for (const locator of t.locators) {
    const s = locator.strategy;
    switch (s.kind) {
      case 'role':
        out.push(s.name);
        break;
      case 'label':
        out.push(s.label);
        break;
      case 'text':
        out.push(s.text);
        break;
      case 'relative':
        out.push(s.anchor.text);
        break;
      case 'css':
      case 'bbox':
      case 'automation_id':
        break;
    }
  }
  if (t.snapshot?.name !== undefined) out.push(t.snapshot.name);
  if (t.snapshot?.text !== undefined) out.push(t.snapshot.text);
  return out;
}

/** Loose structural view of an Action or a Partial<Action>: only the fields this validator inspects. */
interface ActionLike {
  type?: string;
  url?: string;
  target?: TargetDescriptor;
  value?: { kind: 'input' | 'literal' | 'secret'; name?: string };
  output?: string;
  parse?: string;
  pattern?: string;
  condition?: Condition;
}

/**
 * `unknown_input` for `{input.name}` placeholders: flags every string leaf under `node` (a url, a
 * locator's name/label/text/selector, a condition's text/pattern, a literal value, ...) that
 * references an input not declared in `inputNames`, at that leaf's own path. Replay binds these
 * strings with the invocation's inputs, so an undeclared name could only ever fail at run time.
 */
function checkPlaceholderInputs(
  node: unknown,
  path: (string | number)[],
  inputNames: ReadonlySet<string>,
  issues: CapabilityIssue[],
): void {
  if (node === undefined) return;
  walkStrings(node, path, (s, leafPath) => {
    for (const name of collectInputPlaceholders(s)) {
      if (!inputNames.has(name)) {
        issues.push({ code: 'unknown_input', path: leafPath, message: `undeclared input "${name}" referenced in placeholder {input.${name}}` });
      }
    }
  });
}

function checkActionUnknownInputs(
  action: ActionLike,
  path: (string | number)[],
  inputNames: ReadonlySet<string>,
  issues: CapabilityIssue[],
): void {
  checkPlaceholderInputs(action, path, inputNames, issues);
  if (action.value !== undefined && action.value.kind === 'input') {
    const name = action.value.name!;
    if (!inputNames.has(name)) {
      issues.push({ code: 'unknown_input', path: [...path, 'value', 'name'], message: `undeclared input "${name}"` });
    }
  }
}

function tryCompileRegex(source: string, path: (string | number)[], issues: CapabilityIssue[]): void {
  try {
    new RegExp(source);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    issues.push({ code: 'invalid_regex', path, message: `invalid regex /${source}/: ${message}` });
  }
}

function checkConditionRegexes(root: Condition, basePath: (string | number)[], issues: CapabilityIssue[]): void {
  walkCondition(
    root,
    (node, path) => {
      if (node.kind === 'url_matches') {
        tryCompileRegex(node.pattern, [...path, 'pattern'], issues);
      } else if (node.kind === 'dialog_open' && node.messagePattern !== undefined) {
        tryCompileRegex(node.messagePattern, [...path, 'messagePattern'], issues);
      }
    },
    basePath,
  );
}

function checkExtractRegex(
  parse: string | undefined,
  pattern: string | undefined,
  path: (string | number)[],
  issues: CapabilityIssue[],
): void {
  if (pattern !== undefined) {
    tryCompileRegex(pattern, [...path, 'pattern'], issues);
  }
  if (parse === 'regex' && pattern === undefined) {
    issues.push({ code: 'regex_parse_needs_pattern', path: [...path, 'pattern'], message: "extract parse:'regex' requires a pattern" });
  }
}

function checkCredential(
  action: ActionLike,
  path: (string | number)[],
  inputs: Capability['inputs'],
  issues: CapabilityIssue[],
): void {
  // Only 'type' and 'select' actions carry both a target and a value; a partial patch that
  // supplies both is necessarily one of those two kinds regardless of whether `type` itself
  // was included in the patch.
  if (action.target === undefined || action.value === undefined) return;
  const texts = credentialTexts(action.target);
  const looksLikePassword = texts.some((t) => PASSWORD_LIKE_RE.test(t));
  if (!looksLikePassword) return;
  if (action.value.kind === 'literal') {
    issues.push({
      code: 'plaintext_credential',
      path: [...path, 'value', 'value'],
      message: 'literal value bound into a password-like target; use {kind:"secret"} or a sensitive input',
    });
  } else if (action.value.kind === 'input') {
    const name = action.value.name!;
    const spec = inputs[name];
    if (spec !== undefined && spec.sensitive === false) {
      issues.push({
        code: 'sensitive_input_not_sensitive',
        path: ['inputs', name, 'sensitive'],
        message: `input "${name}" is bound into a password-like target but is not marked sensitive`,
      });
    }
  }
}

function stepConditionPaths(
  step: { precondition?: Condition; postcondition?: Condition; action: Action },
  basePath: (string | number)[],
  issues: CapabilityIssue[],
): void {
  if (step.precondition !== undefined) checkConditionRegexes(step.precondition, [...basePath, 'precondition'], issues);
  if (step.postcondition !== undefined) checkConditionRegexes(step.postcondition, [...basePath, 'postcondition'], issues);
  if (step.action.type === 'wait') {
    checkConditionRegexes(step.action.condition, [...basePath, 'action', 'condition'], issues);
  }
}

/** True when `node` holds an `{input.x}` placeholder naming one of `names` (any name when omitted). */
function bindsInput(node: unknown, names?: ReadonlySet<string>): boolean {
  if (node === undefined) return false;
  const found = collectInputPlaceholders(node);
  return names === undefined ? found.size > 0 : [...found].some((n) => names.has(n));
}

/** True when an action is driven by one of `names`: a placeholder in its url or target (locators,
 *  description), or a typed/selected value bound to (or templated with) one of them. */
function actionBindsInput(action: Action, names: ReadonlySet<string>): boolean {
  if (action.type === 'navigate') return bindsInput(action.url, names);
  if (!('target' in action)) return false;
  if (bindsInput(action.target, names)) return true;
  if (action.type === 'type' || action.type === 'select') {
    const v = action.value;
    return v.kind === 'input' ? names.has(v.name) : v.kind === 'literal' && bindsInput(v.value, names);
  }
  return false;
}

/**
 * True when a locator can only find an element named by one of `names`: its own match string holds
 * the placeholder (role name, label, text, automation id, a non-positional CSS selector), or, for
 * `relative`, its anchor text or its container (`within`) does. A bbox never is.
 */
function locatorTiedToInput(locator: TargetDescriptor['locators'][number], names: ReadonlySet<string>): boolean {
  const s = locator.strategy;
  switch (s.kind) {
    case 'role':
      return bindsInput(s.name, names);
    case 'label':
      return bindsInput(s.label, names);
    case 'text':
      return bindsInput(s.text, names);
    case 'automation_id':
      return bindsInput(s.id, names);
    case 'relative':
      return bindsInput(s.anchor.text, names) || bindsInput(s.within, names);
    case 'css':
      return bindsInput(s.selector, names) && !isPositional(locator);
    case 'bbox':
      return false;
  }
}

/**
 * True when the capability reads at least one value and every `extract` step reads it through a
 * chain in which every locator is tied to one of `names` ({@link locatorTiedToInput}). Such a read
 * belongs to the input by construction: no locator in the chain can find another record's element,
 * so there is no fallback that passes on static labels. Strict: one locator that is not tied (a
 * bbox, a static label anchor, a structural selector) fails the whole capability, and so does a
 * tenant override that retargets an extract step, or adds one, with such a chain.
 */
function extractsTiedToInput(cap: Capability, names: ReadonlySet<string>): boolean {
  const chains: TargetDescriptor[] = [];
  const extractIds = new Set<string>();
  for (const s of cap.steps) {
    if (s.action.type !== 'extract') continue;
    chains.push(s.action.target);
    extractIds.add(s.id);
  }
  if (chains.length === 0) return false;
  for (const override of cap.overrides ?? []) {
    for (const patch of override.stepPatches) {
      if (!extractIds.has(patch.stepId)) continue;
      if (patch.target !== undefined) chains.push(patch.target);
      if (patch.action !== undefined && 'target' in patch.action && patch.action.target !== undefined) chains.push(patch.action.target);
    }
    for (const extra of override.extraSteps ?? []) if (extra.step.action.type === 'extract') chains.push(extra.step.action.target);
  }
  return chains.every((t) => t.locators.length > 0 && t.locators.every((l) => locatorTiedToInput(l, names)));
}

/**
 * `unverified_input_binding` (warning): finds the first step driven by a non-sensitive input and
 * the last step at or after it that is input-driven or a click (a click after an input-driven step
 * typically opens the matching result). Unless a postcondition or wait condition of that step or
 * a later one, or `success.condition`, binds some input, nothing at replay ties the result to the
 * input: a fallback locator that opens the first result row would still pass on static labels.
 * Sensitive inputs are not counted as drivers, since they are credentials rather than a record
 * the capability looks up.
 *
 * A capability whose every `extract` reads through locators tied to an input
 * ({@link extractsTiedToInput}) is verified without a checkpoint: a price found only below the
 * exact product name, inside that product's container, cannot be another product's.
 */
function checkInputBoundCheckpoint(cap: Capability, warnings: CapabilityIssue[]): void {
  const lookupInputs = new Set(Object.entries(cap.inputs).filter(([, spec]) => !spec.sensitive).map(([name]) => name));
  if (lookupInputs.size === 0) return;
  const first = cap.steps.findIndex((s) => actionBindsInput(s.action, lookupInputs));
  if (first < 0) return;
  let last = first;
  cap.steps.forEach((s, i) => {
    if (i > first && (s.action.type === 'click' || actionBindsInput(s.action, lookupInputs))) last = i;
  });
  const verified =
    cap.steps.slice(last).some((s) => bindsInput(s.postcondition) || (s.action.type === 'wait' && bindsInput(s.action.condition))) ||
    bindsInput(cap.success.condition) ||
    extractsTiedToInput(cap, lookupInputs);
  if (verified) return;
  warnings.push({
    code: 'unverified_input_binding',
    path: ['steps', last],
    message: `capability has input-bound steps but no input-bound checkpoint (postcondition or success) verifies the result belongs to that input; nothing at or after step "${cap.steps[last]!.id}" binds an input`,
  });
}

/** A `type`/`select` whose value comes from (or is templated with) one of `names`: page-local form
 *  state derived from an input, which a later step submits. */
function fillsFormFromInput(step: Step, names: ReadonlySet<string>): boolean {
  const a = step.action;
  if (a.type !== 'type' && a.type !== 'select') return false;
  return a.value.kind === 'input' ? names.has(a.value.name) : a.value.kind === 'literal' && bindsInput(a.value.value, names);
}

/**
 * `unbound_outcome_detector` (warning). A business outcome whose detector binds no input, checked
 * after a step S that is not itself driven by an input but submits form state an earlier step F
 * filled from one (F types the member id, S clicks Search), with no input-bound condition between
 * them (a postcondition of F..S-1, or a precondition or wait of F+1..S; S's own postcondition does
 * not count, since replay checks outcomes before it). Such a detector cannot tell "nothing matched
 * this input" from "the input never reached the page": an emptied form (a lost session, a field
 * the app cleared) produces the same "No records found" page, and the run reports the outcome for
 * an input it never searched. Reported once per outcome, at its detector. Narrow on purpose:
 * an outcome after a step that carries the input itself (a click on the row named by it, a
 * navigate to a URL with it) is not flagged, nor is one whose detector or window binds the input.
 */
function checkOutcomeDetectorBinding(cap: Capability, warnings: CapabilityIssue[]): void {
  const lookupInputs = new Set(Object.entries(cap.inputs).filter(([, spec]) => !spec.sensitive).map(([name]) => name));
  if (lookupInputs.size === 0) return;
  cap.businessOutcomes.forEach((outcome, oi) => {
    if (bindsInput(outcome.detector)) return;
    const window =
      outcome.afterSteps === undefined ? cap.steps.map((_, i) => i) : outcome.afterSteps.map((id) => cap.steps.findIndex((s) => s.id === id)).filter((i) => i >= 0);
    for (const at of window) {
      const step = cap.steps[at]!;
      if (actionBindsInput(step.action, lookupInputs)) continue;
      let filler = -1;
      for (let j = at - 1; j >= 0; j -= 1) {
        if (fillsFormFromInput(cap.steps[j]!, lookupInputs)) {
          filler = j;
          break;
        }
      }
      if (filler < 0) continue;
      const verified =
        cap.steps.slice(filler, at).some((s) => bindsInput(s.postcondition)) ||
        cap.steps.slice(filler + 1, at + 1).some((s) => bindsInput(s.precondition) || (s.action.type === 'wait' && bindsInput(s.action.condition)));
      if (verified) continue;
      const fill = cap.steps[filler]!;
      const value = fill.action.type === 'type' || fill.action.type === 'select' ? fill.action.value : undefined;
      const inputName = value?.kind === 'input' ? value.name : [...collectInputPlaceholders(value ?? {})][0];
      warnings.push({
        code: 'unbound_outcome_detector',
        path: ['businessOutcomes', oi, 'detector'],
        message:
          `business outcome "${outcome.name}" is detected after step "${step.id}", which submits what step "${fill.id}" filled from input "${inputName ?? '?'}", ` +
          'but its detector binds no input: a page that lost that state (an expired session, an emptied form) matches it too, and the run would report ' +
          `"${outcome.name}" for an input it never submitted. Bind the detector to the input (for example a url_matches on {input.${inputName ?? 'x'}}), ` +
          `or add an input-bound checkpoint between "${fill.id}" and "${step.id}".`,
      });
      return;
    }
  });
}

/**
 * The `auth` block (capability.ts `AuthBlock`), when present: every id names a step; the ids are
 * exactly the capability's first N step ids in order (re-running a sign-in must start from the
 * entry and skip nothing in between); at least one of those steps is secret-bound (otherwise it is
 * not a sign-in); none is irreversible (the relogin operator re-runs these unattended); none depends
 * on the run's inputs or extracts (signing in never re-runs the business flow); the last one is the
 * submit. The signed-in condition must not depend on inputs, must actually prove something (not
 * only negations, except "the secret's field is gone"), and gets the same regex checks as every
 * other condition. See schema/auth.ts for the rule these mirror.
 */
function checkAuthBlock(cap: Capability, inputNames: ReadonlySet<string>, issues: CapabilityIssue[]): void {
  const auth = cap.auth;
  if (auth === undefined) return;
  checkConditionRegexes(auth.signedIn, ['auth', 'signedIn'], issues);
  checkPlaceholderInputs(auth.signedIn, ['auth', 'signedIn'], inputNames, issues);

  const byId = new Map(cap.steps.map((s) => [s.id, s]));
  let shapeOk = true;
  auth.steps.forEach((id, i) => {
    if (!byId.has(id)) {
      issues.push({ code: 'invalid_auth', path: ['auth', 'steps', i], message: `auth step "${id}" is not a step of this capability` });
      shapeOk = false;
    } else if (cap.steps[i]?.id !== id) {
      issues.push({
        code: 'invalid_auth',
        path: ['auth', 'steps', i],
        message: `auth steps must be the capability's first steps, in order and without gaps; position ${i} is "${id}", expected "${cap.steps[i]?.id ?? '(none)'}"`,
      });
      shapeOk = false;
    }
  });
  if (!shapeOk) return;

  const run = auth.steps.map((id) => byId.get(id)!);
  if (!run.some(isSecretBound)) {
    issues.push({ code: 'invalid_auth', path: ['auth', 'steps'], message: 'auth steps contain no secret-bound step, so they do not sign in' });
  }
  run.forEach((s, i) => {
    if (s.risk === 'irreversible') {
      issues.push({
        code: 'invalid_auth',
        path: ['auth', 'steps', i],
        message: `auth step "${s.id}" is irreversible; the sign-in is re-run unattended on session expiry, so it must not include one`,
      });
    }
    if (dependsOnRunInputs(s)) {
      issues.push({
        code: 'invalid_auth',
        path: ['auth', 'steps', i],
        message: `auth step "${s.id}" depends on the run's inputs or extracts a value; signing in must not, or a relogin would re-run part of the business flow`,
      });
    }
  });

  const last = run[run.length - 1]!;
  // (Being last, the submit is necessarily at or after the last secret.)
  if (!isSubmitStep(last)) {
    issues.push({
      code: 'invalid_auth',
      path: ['auth', 'steps', run.length - 1],
      message: `auth steps must end at the submit (a click on a non-toggle control, Enter, or a value typed with Enter) after the last secret; "${last.id}" is not one`,
    });
  }

  if (collectInputPlaceholders(auth.signedIn).size > 0) {
    issues.push({ code: 'invalid_auth', path: ['auth', 'signedIn'], message: 'the signed-in condition must not depend on the run\'s inputs' });
  }
  const secretTargets = run.filter(isSecretBound).flatMap((s) => ('target' in s.action ? [s.action.target] : []));
  if (!provesSignedIn(auth.signedIn, secretTargets)) {
    issues.push({
      code: 'invalid_auth',
      path: ['auth', 'signedIn'],
      message:
        'the signed-in condition proves nothing: a condition made only of negations (not, text_absent, element_absent) holds on almost any page; ' +
        'the one negative form accepted is "the sign-in field is gone" (not element_visible / element_absent over a secret step\'s own target)',
    });
  }
}

/** True when `c` positively shows something about the page, or is "a secret's field is gone" over
 *  one of `secretTargets` (bounding boxes excluded, since a coordinate always hits something). */
function provesSignedIn(c: Condition, secretTargets: readonly TargetDescriptor[]): boolean {
  const isSecretField = (t: TargetDescriptor): boolean =>
    !t.locators.some((l) => l.strategy.kind === 'bbox') &&
    secretTargets.some(
      (s) =>
        s.description === t.description &&
        JSON.stringify(s.frame) === JSON.stringify(t.frame) &&
        t.locators.every((l) => s.locators.some((sl) => JSON.stringify(sl) === JSON.stringify(l))),
    );
  switch (c.kind) {
    case 'text_visible':
    case 'element_visible':
    case 'url_matches':
    case 'dialog_open':
      return true;
    case 'text_absent':
      return false;
    case 'element_absent':
      return isSecretField(c.target);
    case 'not':
      return c.of.kind === 'element_visible' && isSecretField(c.of.target);
    case 'all':
      return c.of.some((x) => provesSignedIn(x, secretTargets));
    case 'any':
      return c.of.length > 0 && c.of.every((x) => provesSignedIn(x, secretTargets));
  }
}

/**
 * `redundant_repeated_step` (warning): a step that provably repeats the one before it (see
 * `findRedundantRepeats`). A warning, not an error: the capability replays correctly, it just does
 * the same idempotent write twice, and its second checkpoint is evaluated against a state the
 * first write already produced. Static analysis can see this much; a checkpoint that already held
 * before its step needs page state to detect, which only the replay-backed optimizer has.
 */
function checkRedundantRepeats(cap: Capability, warnings: CapabilityIssue[]): void {
  for (const r of findRedundantRepeats(cap.steps)) {
    warnings.push({
      code: 'redundant_repeated_step',
      path: ['steps', r.index],
      message: `step "${r.stepId}" repeats step "${r.repeatOf}" exactly (the same idempotent write to the same target with the same value); it is redundant -- \`cu optimize\` collapses it`,
    });
  }
}

/**
 * `read_without_record_identity` (warning). A step extract that comes after a step driven by a
 * non-sensitive input and has no `identity` check. The recorder adds the check when the read
 * value's record container showed the input at record time. Without it, a locator that names the
 * value but finds another record's element is returned as a success, and nothing can tell. A
 * warning, not an error: an artifact recorded before the check existed must keep loading, and a
 * page that shows one record needs nothing more. Covers step extracts only: a business outcome's
 * extract and a tenant override's extract carry no identity check.
 */
function checkReadsWithoutIdentity(cap: Capability, warnings: CapabilityIssue[]): void {
  const names = new Set(Object.entries(cap.inputs).filter(([, spec]) => !spec.sensitive).map(([name]) => name));
  if (names.size === 0) return;
  let driven = false;
  cap.steps.forEach((s, i) => {
    if (s.action.type === 'extract' && driven && s.action.identity === undefined) {
      warnings.push({
        code: 'read_without_record_identity',
        path: ['steps', i, 'action'],
        message:
          `step "${s.id}" reads "${s.action.target.description}" after steps driven by an input, but nothing checks that the value belongs to that input's record: ` +
          'it was recorded without an identity check (older artifact), or the container of the value showed no input value at record time. Replay returns whatever the locators find. Record it again from a page that shows the record id next to the value, or review it by hand.',
      });
    }
    if (actionBindsInput(s.action, names)) driven = true;
  });
}

/**
 * `positional_only_target` (warning): an extract whose target chain holds only positional locators.
 * Replay never reads by position when the chain has a locator that names the value
 * (surface/positional-fallback.ts), so a chain that names nothing is the one read that is still
 * taken from a position, with nothing to check it against. A warning, not an error: on a page that
 * shows one record and never changes shape the read is right, and an existing artifact must keep
 * loading. Covers step extracts, business-outcome extracts, and the extracts a tenant override
 * adds (`extraSteps`) or retargets (`stepPatches`).
 */
function checkPositionalOnlyTargets(cap: Capability, warnings: CapabilityIssue[]): void {
  const warn = (target: TargetDescriptor, path: (string | number)[], what: string): void => {
    if (!isPositionalOnly(target)) return;
    const kinds = target.locators.map((l) => l.strategy.kind).join(', ');
    warnings.push({
      code: 'positional_only_target',
      path,
      message:
        `${what} reads "${target.description}" through positional locators only (${kinds}): replay returns whatever sits at that position, and nothing can check it is the recorded value. ` +
        'Add a locator that names the value (a label, its own text, or a relative locator anchored on its label).',
    });
  };
  cap.steps.forEach((s, i) => {
    if (s.action.type === 'extract') warn(s.action.target, ['steps', i, 'action', 'target'], `step "${s.id}"`);
  });
  cap.businessOutcomes.forEach((bo, bi) => {
    (bo.extract ?? []).forEach((ex, ei) => warn(ex.target, ['businessOutcomes', bi, 'extract', ei, 'target'], `business outcome "${bo.name}"`));
  });
  (cap.overrides ?? []).forEach((o, oi) => {
    o.stepPatches.forEach((patch, pi) => {
      if (cap.steps.find((s) => s.id === patch.stepId)?.action.type !== 'extract') return;
      const actionTarget = patch.action !== undefined && 'target' in patch.action ? patch.action.target : undefined;
      const target = actionTarget ?? patch.target;
      if (target !== undefined) {
        warn(target, ['overrides', oi, 'stepPatches', pi, actionTarget !== undefined ? 'action' : 'target'], `override ${o.tenant} patch of step "${patch.stepId}"`);
      }
    });
    (o.extraSteps ?? []).forEach((es, ei) => {
      if (es.step.action.type === 'extract') {
        warn(es.step.action.target, ['overrides', oi, 'extraSteps', ei, 'step', 'action', 'target'], `override ${o.tenant} extra step "${es.step.id}"`);
      }
    });
  });
}

/**
 * Validates a raw capability beyond what the zod schema alone can express: cross-references
 * between steps/outputs/business outcomes, regex compilability, and irreversible-action/
 * credential-safety heuristics. Never throws; a malformed `obj` surfaces as `issues` with a
 * `schema` (or `invalid_semver`) code instead.
 */
export function validateCapability(obj: unknown, opts?: ValidateCapabilityOptions): ValidateCapabilityResult {
  const parsed = Capability.safeParse(obj);
  if (!parsed.success) {
    const issues: CapabilityIssue[] = parsed.error.issues.map((iss) => {
      const path = iss.path.map((p) => p as string | number);
      const code: CapabilityIssueCode = path.length === 1 && path[0] === 'version' ? 'invalid_semver' : 'schema';
      return { code, path, message: iss.message };
    });
    return { ok: false, issues };
  }

  const cap = parsed.data;
  const issues: CapabilityIssue[] = [];

  const stepIds = new Set(cap.steps.map((s) => s.id));
  const inputNames = new Set(Object.keys(cap.inputs));

  // duplicate_step_id
  {
    const seen = new Set<string>();
    cap.steps.forEach((s, i) => {
      if (seen.has(s.id)) {
        issues.push({ code: 'duplicate_step_id', path: ['steps', i, 'id'], message: `duplicate step id "${s.id}"` });
      }
      seen.add(s.id);
    });
  }

  // duplicate_step_id also covers tenant extraSteps (against base steps and each other)
  (cap.overrides ?? []).forEach((override, oi) => {
    const seen = new Set(stepIds);
    (override.extraSteps ?? []).forEach((es, ei) => {
      if (seen.has(es.step.id)) {
        issues.push({
          code: 'duplicate_step_id',
          path: ['overrides', oi, 'extraSteps', ei, 'step', 'id'],
          message: `extra step id "${es.step.id}" collides with an existing step id`,
        });
      }
      seen.add(es.step.id);
    });
  });

  // invalid_regex: frame hop url patterns anywhere
  checkFrameUrlPatterns(cap, [], issues);

  // unknown_input: app.entryUrl, success condition
  checkPlaceholderInputs(cap.app.entryUrl, ['app', 'entryUrl'], inputNames, issues);
  checkPlaceholderInputs(cap.success.condition, ['success', 'condition'], inputNames, issues);

  // steps: unknown_input, output bookkeeping, regex checks, credential checks
  const producedOutputs = new Set<string>();
  cap.steps.forEach((step, i) => {
    const basePath: (string | number)[] = ['steps', i];
    checkActionUnknownInputs(step.action as ActionLike, [...basePath, 'action'], inputNames, issues);
    checkPlaceholderInputs(step.precondition, [...basePath, 'precondition'], inputNames, issues);
    checkPlaceholderInputs(step.postcondition, [...basePath, 'postcondition'], inputNames, issues);
    checkCredential(step.action as ActionLike, [...basePath, 'action'], cap.inputs, issues);
    stepConditionPaths(step, basePath, issues);

    if (step.action.type === 'extract') {
      producedOutputs.add(step.action.output);
      if (!Object.prototype.hasOwnProperty.call(cap.outputs, step.action.output)) {
        issues.push({
          code: 'undeclared_output',
          path: [...basePath, 'action', 'output'],
          message: `extract output "${step.action.output}" is not declared in capability.outputs`,
        });
      }
      checkExtractRegex(step.action.parse, step.action.pattern, [...basePath, 'action'], issues);
      if (step.action.identity !== undefined && !inputNames.has(step.action.identity.input)) {
        issues.push({
          code: 'unknown_input',
          path: [...basePath, 'action', 'identity', 'input'],
          message: `undeclared input "${step.action.identity.input}" in the read's identity check`,
        });
      }
    }
  });

  for (const key of Object.keys(cap.outputs)) {
    if (!producedOutputs.has(key)) {
      issues.push({ code: 'output_not_produced', path: ['outputs', key], message: `output "${key}" is not produced by any step extract` });
    }
  }

  // InputSpec.pattern regexes; sensitive input with an example value: `example` is
  // documentation/UI fodder, potentially surfaced by a catalog listing, never a redaction
  // boundary, so a real secret placed there would leak in plain sight even though
  // `sensitive: true` promises it is never persisted in plaintext.
  for (const [name, spec] of Object.entries(cap.inputs)) {
    if (spec.pattern !== undefined) {
      tryCompileRegex(spec.pattern, ['inputs', name, 'pattern'], issues);
    }
    if (spec.sensitive && spec.example !== undefined) {
      issues.push({
        code: 'sensitive_input_has_example',
        path: ['inputs', name, 'example'],
        message: `input "${name}" is sensitive but declares an example value; a sensitive input must not carry a literal example`,
      });
    }
  }

  // success condition
  checkConditionRegexes(cap.success.condition, ['success', 'condition'], issues);

  // businessOutcomes
  cap.businessOutcomes.forEach((bo: BusinessOutcome, oi) => {
    const basePath: (string | number)[] = ['businessOutcomes', oi];
    checkConditionRegexes(bo.detector, [...basePath, 'detector'], issues);
    checkPlaceholderInputs(bo.detector, [...basePath, 'detector'], inputNames, issues);
    checkPlaceholderInputs(bo.extract, [...basePath, 'extract'], inputNames, issues);

    (bo.afterSteps ?? []).forEach((stepId, ai) => {
      if (!stepIds.has(stepId)) {
        issues.push({ code: 'unknown_step_ref', path: [...basePath, 'afterSteps', ai], message: `unknown step id "${stepId}"` });
      }
    });

    const extractOutputs = new Set((bo.extract ?? []).map((e) => e.output));
    for (const key of Object.keys(bo.returns)) {
      if (!extractOutputs.has(key)) {
        issues.push({
          code: 'outcome_return_mismatch',
          path: [...basePath, 'returns', key],
          message: `returns key "${key}" is not produced by any extract in this outcome`,
        });
      }
    }
    (bo.extract ?? []).forEach((e: OutcomeExtract, ei) => {
      const extractPath = [...basePath, 'extract', ei];
      if (!Object.prototype.hasOwnProperty.call(bo.returns, e.output)) {
        issues.push({
          code: 'outcome_return_mismatch',
          path: [...extractPath, 'output'],
          message: `extract output "${e.output}" is not declared in returns`,
        });
      }
      checkExtractRegex(e.parse, e.pattern, extractPath, issues);
    });
  });

  // recoveryRules
  const irreversiblePatterns = (opts?.irreversibleTextPatterns ?? DEFAULT_IRREVERSIBLE_TEXT_PATTERNS).map((p) => new RegExp(p, 'i'));
  const irreversibleUrlPatterns = (opts?.irreversibleUrlPatterns ?? []).map((p) => new RegExp(p, 'i'));
  cap.recoveryRules.forEach((rule: RecoveryRule, ri) => {
    const basePath: (string | number)[] = ['recoveryRules', ri];
    checkConditionRegexes(rule.trigger, [...basePath, 'trigger'], issues);
    checkPlaceholderInputs(rule.trigger, [...basePath, 'trigger'], inputNames, issues);
    rule.actions.forEach((action: Action, ai) => {
      const actionPath = [...basePath, 'actions', ai];
      checkActionUnknownInputs(action as ActionLike, actionPath, inputNames, issues);
      checkCredential(action as ActionLike, actionPath, cap.inputs, issues);
      if (action.type === 'wait') {
        checkConditionRegexes(action.condition, [...actionPath, 'condition'], issues);
      }
      if (action.type === 'extract') {
        checkExtractRegex(action.parse, action.pattern, actionPath, issues);
      }
      if (action.type === 'navigate' && irreversibleUrlPatterns.some((re) => re.test(action.url))) {
        issues.push({
          code: 'irreversible_recovery_action',
          path: [...actionPath, 'url'],
          message: 'recovery navigate URL matches an irreversible URL pattern',
        });
      }
      if ((action.type === 'click' || action.type === 'type' || action.type === 'select') && action.target) {
        const texts = irreversibleCheckTexts(action.target);
        const isIrreversible = texts.some((t) => irreversiblePatterns.some((re) => re.test(t)));
        if (isIrreversible) {
          issues.push({
            code: 'irreversible_recovery_action',
            path: actionPath,
            message: 'recovery action target text matches an irreversible-action pattern',
          });
        }
      }
    });
  });

  // overrides
  (cap.overrides ?? []).forEach((override: TenantOverride, oi) => {
    const basePath: (string | number)[] = ['overrides', oi];
    if (override.entryUrl !== undefined) {
      checkPlaceholderInputs(override.entryUrl, [...basePath, 'entryUrl'], inputNames, issues);
    }
    override.stepPatches.forEach((patch, pi) => {
      const patchPath = [...basePath, 'stepPatches', pi];
      if (!stepIds.has(patch.stepId)) {
        issues.push({ code: 'unknown_step_ref', path: [...patchPath, 'stepId'], message: `unknown step id "${patch.stepId}"` });
      }
      const patched = cap.steps.find((s) => s.id === patch.stepId);
      if (patched && patch.action?.type !== undefined && patch.action.type !== patched.action.type) {
        issues.push({
          code: 'override_action_type_mismatch',
          path: [...patchPath, 'action', 'type'],
          message: `patch changes the action type of step "${patch.stepId}" from "${patched.action.type}" to "${patch.action.type}"; add a replacement via extraSteps instead`,
        });
      }
      checkPlaceholderInputs(patch.target, [...patchPath, 'target'], inputNames, issues);
      if (patch.action !== undefined) {
        checkActionUnknownInputs(patch.action as PartialAction as ActionLike, [...patchPath, 'action'], inputNames, issues);
        checkCredential(patch.action as PartialAction as ActionLike, [...patchPath, 'action'], cap.inputs, issues);
      }

      // A tenant override must not be able to silently retarget a step onto an
      // irreversible-looking control. A TenantOverride carries no `approvedBy`/status of its own,
      // so it always executes under the base capability's `status` -- an approver who signed off
      // on the base capability never saw this patch. Checked on both the top-level
      // `patch.target` and a same-shaped `patch.action.target`.
      const patchActionTarget = patch.action !== undefined ? (patch.action as PartialAction as ActionLike).target : undefined;
      const patchTarget = patch.target ?? patchActionTarget;
      if (patchTarget !== undefined) {
        const texts = irreversibleCheckTexts(patchTarget);
        if (texts.some((t) => irreversiblePatterns.some((re) => re.test(t)))) {
          issues.push({
            code: 'override_irreversible_change',
            path: [...patchPath, patch.target !== undefined ? 'target' : 'action'],
            message: `tenant override patches step "${patch.stepId}" onto a target whose text matches an irreversible-action pattern; a tenant override cannot introduce or retarget an irreversible action without its own approval`,
          });
        }
      }
    });
    (override.extraSteps ?? []).forEach((es, ei) => {
      const esPath = [...basePath, 'extraSteps', ei];
      if (!stepIds.has(es.afterStepId)) {
        issues.push({ code: 'unknown_step_ref', path: [...esPath, 'afterStepId'], message: `unknown step id "${es.afterStepId}"` });
      }
      const stepPath = [...esPath, 'step'];
      checkActionUnknownInputs(es.step.action as ActionLike, [...stepPath, 'action'], inputNames, issues);
      checkPlaceholderInputs(es.step.precondition, [...stepPath, 'precondition'], inputNames, issues);
      checkPlaceholderInputs(es.step.postcondition, [...stepPath, 'postcondition'], inputNames, issues);
      checkCredential(es.step.action as ActionLike, [...stepPath, 'action'], cap.inputs, issues);
      stepConditionPaths(es.step, stepPath, issues);
      if (es.step.action.type === 'extract') {
        checkExtractRegex(es.step.action.parse, es.step.action.pattern, [...stepPath, 'action'], issues);
      }

      // `applyTenantOverride` recomputes the effective capability's `riskLevel` to cover an
      // inserted extra step (see overrides.ts), but never touches `status` -- so an extra step
      // declared `risk: 'irreversible'` would run under whatever approval the base capability
      // already has, even though nobody with authority to approve ever saw this step. Since
      // TenantOverride has no approval field of its own, the only sound answer is to reject it
      // unconditionally: an irreversible capability change belongs in the base capability (or a
      // new, separately-approved version of it), not in a per-tenant patch. Also flagged when the
      // declared risk understates an irreversible-looking target/action (same heuristic as
      // recovery rules), so a tenant cannot dodge the check by mislabelling the step 'read'.
      if (es.step.risk === 'irreversible') {
        issues.push({
          code: 'override_irreversible_change',
          path: [...stepPath, 'risk'],
          message: `tenant override extra step "${es.step.id}" is declared risk "irreversible"; a tenant override cannot introduce an irreversible step (it would run under the base capability's existing approval, which never reviewed it)`,
        });
      } else {
        const extraTarget = (es.step.action as ActionLike).target;
        if (extraTarget !== undefined) {
          const texts = irreversibleCheckTexts(extraTarget);
          if (texts.some((t) => irreversiblePatterns.some((re) => re.test(t)))) {
            issues.push({
              code: 'override_irreversible_change',
              path: [...stepPath, 'action', 'target'],
              message: `tenant override extra step "${es.step.id}" target text matches an irreversible-action pattern; a tenant override cannot introduce an irreversible-looking step`,
            });
          }
        }
      }
    });
  });

  // risk_level_mismatch
  {
    let maxRisk: RiskClass = 'read';
    for (const step of cap.steps) {
      if (RISK_ORDER[step.risk] > RISK_ORDER[maxRisk]) maxRisk = step.risk;
    }
    if (RISK_ORDER[cap.riskLevel] !== RISK_ORDER[maxRisk]) {
      issues.push({
        code: 'risk_level_mismatch',
        path: ['riskLevel'],
        message: `riskLevel "${cap.riskLevel}" does not equal max step risk "${maxRisk}"`,
      });
    }
  }

  // invalid_auth, plus the signed-in condition's regexes and input placeholders
  checkAuthBlock(cap, inputNames, issues);
  // read_only_irreversible: the read-only declaration and anything irreversible cannot coexist.
  if (cap.readOnly === true) {
    const why: string[] = [];
    if (cap.riskLevel === 'irreversible') why.push('riskLevel is "irreversible"');
    cap.steps.forEach((s) => {
      if (s.risk === 'irreversible') why.push(`step "${s.id}" is irreversible`);
    });
    (cap.overrides ?? []).forEach((o) => (o.extraSteps ?? []).forEach((x) => {
      if (x.step.risk === 'irreversible') why.push(`override ${o.tenant} extra step "${x.step.id}" is irreversible`);
    }));
    if (issues.some((i) => i.code === 'irreversible_recovery_action')) why.push('a recovery action is irreversible');
    if (why.length > 0) {
      issues.push({ code: 'read_only_irreversible', path: ['readOnly'], message: `readOnly: true on a capability with irreversible effects (${why.join('; ')})` });
    }
  }

  // output_value_in_artifact
  checkKnownValues(cap, opts?.knownValues, issues);

  if (issues.length === 0) {
    const warnings: CapabilityIssue[] = [];
    checkInputBoundCheckpoint(cap, warnings);
    checkRedundantRepeats(cap, warnings);
    checkOutcomeDetectorBinding(cap, warnings);
    checkPositionalOnlyTargets(cap, warnings);
    checkReadsWithoutIdentity(cap, warnings);
    return { ok: true, capability: cap, issues: [], warnings };
  }
  return { ok: false, issues };
}

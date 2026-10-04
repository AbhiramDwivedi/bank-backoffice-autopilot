# Contracts

These are the shared types every module builds against. They live in `packages/core/src/schema/` as zod
schemas, with JSON Schema exported to `packages/core/schema/*.json` by `npm run schema:export`.

Design principles:
- An **artifact is a capability**, not a step list: it has a contract (typed inputs, typed
  outputs, declared outcomes), and the steps are the implementation.
- **Target descriptors** carry an ordered fallback chain of locator strategies. Replay reports
  which strategy fired. Fallback depth is the drift signal.
- **Four replay result kinds**: `success`, `business_outcome`, `hard_failure`, `escalated`.
  Recoverable conditions are handlers that fire mid-run and appear in the log, never a result.
- The **Surface** interface is the seam between perceiving/acting on the app and the recorded
  flow. Replay, agent and session code never import Playwright directly.
- **Redaction happens at the sink** (run logger) and at artifact emission. Inputs marked
  `sensitive` and values bound from `secret` never appear in plaintext anywhere persisted.

## 1. Locators and targets

```ts
// One way to find a control. Ordered from most to least stable in a TargetDescriptor.
type LocatorStrategy =
  | { kind: 'role';     role: string; name: string; exact?: boolean }          // ARIA role + accessible name
  | { kind: 'label';    label: string; exact?: boolean }                        // control associated with label text; includes adjacent-cell heuristic for legacy tables
  | { kind: 'text';     text: string; exact?: boolean; tag?: string; wholeWord?: boolean }   // visible text anchor (clickable rows, span tabs, div buttons)
  | { kind: 'relative'; anchor: { text: string; exact?: boolean; wholeWord?: boolean; selector?: string };
      relation: 'right-of' | 'below' | 'left-of' | 'above' | 'same-row'; role?: string; tag?: string;
      selector?: string; within?: string }   // see the notes below
  | { kind: 'css';      selector: string }                                      // permitted, low confidence; for legacy quirks
  | { kind: 'bbox';     x: number; y: number; w: number; h: number }            // normalized 0..1 within the frame viewport; last resort
  | { kind: 'automation_id'; id: string }                                       // UI Automation AutomationId, exact and case-sensitive; native apps only, always a miss on the web

interface Locator {
  strategy: LocatorStrategy;
  confidence: number;               // 0..1, recorder's estimate of stability
  source: 'recorded' | 'inferred' | 'human';
}

interface FrameHop { name?: string; urlPattern?: string; index?: number }   // path from top document to the frame holding the element
type FramePath = FrameHop[];      // [] = top document

interface TargetDescriptor {
  description: string;              // human readable: "Member ID text field on the search form"
  frame: FramePath;
  locators: Locator[];              // ordered; replay tries in order
  snapshot?: { tag?: string; role?: string; name?: string; text?: string };  // what it looked like at record time; for drift diagnostics only
}
```

Matching options on `text` and `relative` (an older capability without them resolves as before):

- `anchor.exact`: the anchor must equal the text, case-sensitively. There is no contains fallback.
- `wholeWord` (on `text`, or on a relative's anchor): a contains match whose bound value must be a
  whole token of the text, case-sensitively, so "4512" never matches "Row for 45123" and "Lee"
  never matches "lee". A joiner (`- _ / @ ' .`) between two letters or digits does not end a word,
  so "A-1001" never matches "A-1001-B". On an anchor, a cell equal to the text wins first; the whole
  word is only the fallback when no cell is equal, and several word matches are ambiguous. It does
  match another value holding it as a whole word ("Lee Wong") then. Discovery sets it on every
  contains match it narrows to an input placeholder, and records a cell that is the value alone
  as `exact`, which has no word fallback. No schema field was added for this.
- `anchor.selector`: the anchor element, or an ancestor of it, must match this CSS selector, so the
  anchor is looked up in one table column (`td:nth-child(1)`). A surface without CSS treats it as a
  miss. Templated like `selector`.
- `within`: a CSS selector for the record's container, such as a product card. Candidates must
  sit in the same nearest `within` container as the anchor, not in a nested one, and more than one
  candidate is a miss rather than the nearest.
- `selector`: a CSS filter on the candidates, such as `div.price` or `td:nth-child(3) button` (the
  element's own column). Templated like any string (`{input.x}`).

Positional (`isPositional`, `packages/core/src/schema/positional.ts`) is a `bbox`, or a `css`
selector with any of these:

- a structural pseudo-class (`:nth-of-type`, `:first-child`, ...);
- a `+` or `~` combinator;
- a bare-tag step;
- an index-like class or id (`.row-1`, `.odd`, `#item-3`);
- a numeric attribute value (`[data-index="0"]`, `a[href="/members/10009"]`).

Every other locator names the element: `role`, `label`, `text`, `relative`, `automation_id`, and a
`css` with none of the above (`input[name="memberId"]`). An attribute holding a run input is judged
as recorded: `a[href="/members/{input.memberId}"]` names the element, although its bound form ends
in a number.

Two rules use it:

- **Recording.** A target that belongs to a record named by a run input keeps no positional
  locator. See `docs/design/browser-agent.md`, "The rule".
- **Replay.** A positional locator that wins is not used when an earlier naming locator matched
  several candidates (any action), or when the action is an `extract` and the chain holds any
  naming locator. The step fails as `element_not_found`. See section 6 and
  `docs/design/replay.md`, "Positional fallbacks".

## 2. Actions, conditions, steps

```ts
type ValueBinding =
  | { kind: 'input';   name: string }             // from capability inputs at invocation
  | { kind: 'literal'; value: string }
  | { kind: 'secret';  env: string };             // a credential NAME ([A-Z_][A-Z0-9_]*), resolved at bind time by the run's
                                                  // CredentialProvider (section 13); the value is never persisted

type Condition =
  | { kind: 'text_visible';    text: string; frame?: FramePath; exact?: boolean }
  | { kind: 'text_absent';     text: string; frame?: FramePath }
  | { kind: 'element_visible'; target: TargetDescriptor }
  | { kind: 'element_absent';  target: TargetDescriptor }
  | { kind: 'url_matches';     pattern: string; frame?: FramePath }   // regex source; frame-scoped when given (a frameset hides the content frame's own URL from the top-level one)
  | { kind: 'dialog_open';     messagePattern?: string }              // native alert/confirm/prompt
  | { kind: 'all';             of: Condition[] }
  | { kind: 'any';             of: Condition[] }
  | { kind: 'not';             of: Condition };

type Action =
  | { type: 'navigate';       url: string }                                          // may contain {baseUrl} and {input.name}
  | { type: 'click';          target: TargetDescriptor }
  | { type: 'type';           target: TargetDescriptor; value: ValueBinding; clear?: boolean; pressEnter?: boolean }
  | { type: 'select';         target: TargetDescriptor; value: ValueBinding }        // native <select> or custom dropdown (surface decides)
  | { type: 'press';          key: string }
  | { type: 'extract';        target: TargetDescriptor; output: string; parse?: 'text' | 'number' | 'currency' | 'regex'; pattern?: string;
                              identity?: { input: string; within: 'container' | 'page' } }  // the input's value must be visible in the value's record container (below)
  | { type: 'wait';           condition: Condition; timeoutMs?: number }
  | { type: 'dismiss_dialog'; accept: boolean; promptText?: string }
  | { type: 'switch_frame';   frame: FramePath };                                    // rarely needed; targets carry frame paths

type ActionType = Action['type'];

// An extract's `identity` names a declared input (never its value). Discovery records it when the
// value's record container showed that input; replay checks it after the target resolves and before the
// value is read. A miss is `hard_failure` `checkpoint_failed`. `container` is the smallest ancestor that
// groups the element with two other text blocks; `page` is the whole frame, for an element with none.
type RiskClass = 'read' | 'reversible' | 'irreversible';

interface Step {
  id: string;                       // "s01"
  name: string;                     // "Enter member ID"
  action: Action;
  precondition?: Condition;         // what must be true before acting (else hard_failure: precondition_failed)
  postcondition?: Condition;        // the checkpoint after acting (else hard_failure: checkpoint_failed)
  risk: RiskClass;
  timeoutMs?: number;               // default 10000
  onFailure?: 'fail' | 'escalate';  // default 'fail'
}
```

### Templating

Any string in a Capability (URLs, locator names/labels/texts, relative anchors, css selectors,
condition texts and url patterns, literal values) may contain `{baseUrl}` and
`{input.<name>}` placeholders. They are bound at replay time, immediately before a step runs,
by `bindStep()` in `packages/core/src/schema/template.ts`. Unknown placeholders throw.
`validateCapability` rejects an `{input.x}` placeholder anywhere in the capability whose `x` is not
declared in `inputs`, so an artifact with one never reaches replay. This is how a recorded
click on "row containing 12345" becomes "row containing {input.memberId}". A substituted value is
regex-escaped when it lands in a regex-typed field (`url_matches.pattern`,
`dialog_open.messagePattern`), and CSS-escaped when it lands in a `css` locator's selector. Either
way, it can only ever match itself literally. In `url_matches.pattern` the value is bound as an
alternation of its raw, percent-encoded and form-encoded forms, since a browser reports `Mary Ann`
in a URL as `Mary%20Ann` or `Mary+Ann`. `FrameHop.urlPattern` is the one string never templated.

### Validation issues and warnings

`validateCapability(obj, opts?)` returns `{ ok: true, capability, issues: [], warnings }` or
`{ ok: false, issues }`. Each issue or warning is `{ code, path, message }`
(`packages/core/src/schema/validate.ts`, type `CapabilityIssueCode`). It never throws.

Issues (the capability is invalid):

| Code | Fires on |
|---|---|
| `schema`, `invalid_semver` | a zod parse error; a bad `version` |
| `duplicate_step_id` | two steps, or a step and a tenant extra step, share an id |
| `unknown_input` | an `{input.x}` placeholder or `{kind:'input'}` binding whose `x` is not declared |
| `output_not_produced`, `undeclared_output` | a declared output no step extracts; an extract into an undeclared output |
| `outcome_return_mismatch` | a business outcome's `returns` and `extract` disagree |
| `risk_level_mismatch` | `riskLevel` is not the max of the step risks |
| `unknown_step_ref` | `afterSteps`, `stepPatches[].stepId` or `extraSteps[].afterStepId` names no step |
| `irreversible_recovery_action` | a recovery action targets an irreversible-looking control |
| `invalid_regex`, `regex_parse_needs_pattern` | a regex source that does not compile; `parse: 'regex'` without a pattern |
| `plaintext_credential`, `sensitive_input_not_sensitive`, `sensitive_input_has_example` | a literal or non-sensitive input typed into a password-like field; a sensitive input with an `example` |
| `override_action_type_mismatch`, `override_irreversible_change` | a tenant patch changes an action's type, or adds or retargets onto irreversible work |
| `invalid_auth` | an `auth` block that breaks the sign-in rule (section 3) |
| `read_only_irreversible` | `readOnly: true` on a capability with an irreversible `riskLevel`, step, tenant extra step or recovery action |
| `output_value_in_artifact` | with `opts.knownValues`: a value a run extracted appears in the artifact's own strings |

Warnings (the capability is valid; `cu validate` prints them to stderr and exits 0, and `cu
optimize` prints them before it starts):

| Code | Fires on |
|---|---|
| `unverified_input_binding` | a non-sensitive input drives a step (a placeholder in a navigate URL or target, or an input-bound typed or selected value), but no postcondition or wait condition at or after the last such step (or a click following one), and not `success.condition`, binds any input. Replay cannot tell the record it reached belongs to that input. Not raised when the capability reads at least one value and every `extract` step (and every tenant override of one) reads through a chain whose every locator is bound to a non-sensitive input: a role name, label, text, automation id or non-positional CSS selector holding the placeholder, or a `relative` whose anchor text or `within` holds it. One `bbox`, static label anchor or structural selector in such a chain keeps the warning. |
| `redundant_repeated_step` | a step provably repeats the one right before it: the same idempotent `type` with `clear: true` and no `pressEnter`, or `select` on a real `<select>`, same target chain and value (`schema/step-equivalence.ts`). Usually a retry discovery recorded twice. `cu optimize` collapses it. |
| `unbound_outcome_detector` | a business-outcome detector that binds no input is checked after a step that submits what an earlier step filled from an input, with no input-bound condition between them. A page that lost that state (an expired session, an emptied form) matches it too. |
| `positional_only_target` | an `extract` whose target chain holds only positional locators (section 1): a step's, a business outcome's, or one a tenant override adds or retargets. Replay refuses a positional fallback for a read when the chain names the value. A chain that names nothing can only be read by position, and nothing can check what comes back. `cu approve` refuses a capability with such a read unless `--force`. |
| `read_without_record_identity` | a step `extract` that comes after a step driven by a non-sensitive input and has no `identity` check. Discovery records the check only when the value's record container showed the input; a card that shows only a name, or a record id outside the value's table, leaves the read unchecked, and so does any capability recorded before the field existed. Replay returns whatever the locators find. |

## 3. Outcomes, recovery, capability

```ts
type JsonType = 'string' | 'number' | 'boolean';

interface InputSpec  { type: JsonType; description: string; required: boolean; sensitive: boolean; pattern?: string; example?: string }
interface OutputSpec {
  type: JsonType;
  description: string;
  sensitive?: boolean;              // read from masked content (screen masking): returned to the caller, redacted wherever it would persist
}

interface BusinessOutcome {
  name: string;                     // "member_not_found"
  description: string;
  detector: Condition;              // checked after every step and on any failure before it becomes a hard_failure
  afterSteps?: string[];            // step ids where it may legitimately occur; omitted = any
  returns: Record<string, OutputSpec>;   // shape of `data` in the result; may be {}
  extract?: { output: string; target: TargetDescriptor; parse?: 'text' | 'number' | 'currency' | 'regex'; pattern?: string }[];
}

interface RecoveryRule {
  name: string;                     // "dismiss_maintenance_notice"
  description: string;
  trigger: Condition;
  actions: Action[];                // must be 'read'/'reversible' risk in effect; executor rejects irreversible
  maxAttempts: number;
}

interface Capability {
  schemaVersion: '1.0';
  id: string;                       // kebab-case, stable across versions: "lookup-member-savings-balance"
  version: string;                  // semver
  name: string;
  description: string;
  app: {
    vendor: string;                 // "Acme Core Systems"
    product: string;                // "CU Core Workstation"
    productVersion?: string;
    tenant?: string;                // omitted = base capability for the product
    surface: 'web' | 'desktop';     // discover records 'desktop' for a desktop://<process> base URL
    entryUrl: string;               // may contain {baseUrl}
  };                                // vendor and product are whatever `discover --vendor/--product` was given;
                                    // nothing detects them
  status: 'draft' | 'approved' | 'deprecated';   // 'approved' unlocks irreversible steps under
                                                  // replayRequiresApproved; see "Approval" below
  riskLevel: RiskClass;             // max over steps
  readOnly?: true;                  // the operator's assertion that replaying this capability, whole or with
                                    // steps removed, changes nothing in the app; see "Read-only" below
  inputs:  Record<string, InputSpec>;
  outputs: Record<string, OutputSpec>;
  steps: Step[];
  success: { condition: Condition; description: string };
  businessOutcomes: BusinessOutcome[];
  recoveryRules: RecoveryRule[];
  auth?: AuthBlock;                 // the sign-in steps; derived at run time when omitted. See "Auth block" below
  provenance: {
    discoveredAt: string;           // ISO
    discoveryRunId: string;
    recordedBy: 'llm' | 'human' | 'mixed';
    model?: string;
    notes?: string;
  };
  overrides?: TenantOverride[];     // design seam for multi-tenant; may be empty in v1
}
```

### Approval

`cu approve <artifact.json> --by <name> [--notes <text>]` is the durable path to `status:
'approved'`. It requires a prior successful replay of the same `id` and `version` under
`--runs-dir` (or an explicit `--force`). When that replay's result carries a `capabilityDigest`
(section 6), the digest must match the file being approved. A result without one is accepted, with
a printed note, only while no result for that id and version carries a digest. On success, it sets `status`, bumps the patch version,
and appends a line recording who approved it and when to `provenance.notes`. `discover --extend` writes a new minor version with `status: 'draft'`, so an approval never
carries over to the extended capability. A `deprecated` capability is refused by replay (`cu replay --approve` included), and the
catalog skips it, falling back to the highest non-deprecated version of the same id. `replay --approve` is a one-run
override: it treats the in-memory capability as approved for that invocation only and never writes
the file. A `TenantOverride` carries no approval field of its own, so it can never introduce or
retarget an irreversible step. That always has to go through the base capability's own approval.

```ts
interface TenantOverride {
  tenant: string;
  entryUrl?: string;
  stepPatches: { stepId: string; target?: TargetDescriptor; action?: Partial<Action> }[];
  extraSteps?: { afterStepId: string; step: Step }[];
  notes?: string;
}
```

### Read-only

`readOnly: true` means replaying the capability, whole or with any steps removed, changes nothing
in the target app. `discover --read-only` records it and `cu optimize --read-only` writes it into
its output; it is never inferred, and nothing verifies it. It is what lets the optimizer replay
variants of the capability (`docs/design/optimize.md`). The validator rejects it on anything
irreversible (`read_only_irreversible`). A discovery declared read-only that records an
irreversible step drops the declaration and reports it in `DiscoveryResult.readOnlyDropped`.

### Auth block

```ts
interface AuthBlock {
  steps: string[];                  // step ids, in order: a contiguous run from the first step, containing a secret-bound step
  signedIn: Condition;              // holds once the session is signed in; checked after re-running `steps`
}
```

`deriveAuth` (`packages/core/src/schema/auth.ts`) produces it, at record time and, for an artifact
without one, at run time. Signing in never depends on the run's inputs: no auth step binds an
input, carries an `{input.x}` placeholder, extracts, or is irreversible, and the last one is a
submit. When the submit has no postcondition, the derived `signedIn` is "the field the last secret
was typed into is gone". `validateCapability` holds an explicit block to the same rule
(`invalid_auth`), and refuses a `signedIn` that depends on inputs or is made only of negations,
other than "a secret's own field is gone". The rule and its history are in
`docs/design/credentials.md`.

## 4. Policy

```ts
interface Policy {
  name: string;
  allowedOrigins: string[];                 // exact origins: "http://localhost:4173", or "desktop://<process>" for a Windows app
  allowedPathPatterns: string[];            // regex sources, matched against pathname (desktop: "/" + the decoded window title); empty = all paths on allowed origins
  deniedPathPatterns: string[];             // wins over allowed
  allowedActions: ActionType[];
  risk: {
    irreversibleTextPatterns: string[];     // regex sources matched against target name/text: "submit|confirm|transfer|delete|approve|post"
    irreversibleUrlPatterns: string[];      // desktop: matched against the encoded and the decoded location
    discoveryMode: 'block' | 'escalate';    // what discovery does when about to take an irreversible action
    replayRequiresApproved: boolean;        // irreversible steps only run if capability.status === 'approved'
    judge?: RiskJudgeConfig;                // judgment-based check at record and audit time; never consulted by replay
  };
  redaction: {
    patterns: { name: string; regex: string; replacement?: string }[];   // SSN, card numbers, account numbers...
    screen?: ScreenMaskPolicy;              // what the surfaces hide before anything leaves them; every field defaults
  };
  limits: {
    maxSteps: number; maxDurationMs: number; maxLlmCalls: number;   // discovery
    maxAppErrorRetries?: number;            // replay: app-error retries per read-only run; absent = 2, 0 = off (section 11)
  };
}

interface ScreenMaskPolicy {                // docs/design/screen-masking.md; resolved type ScreenMaskConfig (resolveScreenMask)
  maskInputs: 'all' | 'typed';              // default 'all': every text-like field, empty or not; 'typed': typed-into fields (passwords always)
  maskSelectors: string[];                  // default []: CSS selectors always masked (web only)
  maskLabels: string[];                     // default []: regex sources, each matched against a WHOLE label as ^(?:source)$, case-insensitive
  maskTextPatterns: boolean;                // default true: redaction patterns and the run's values are masked on screen too
  omitScreenshotUrlPatterns: string[];      // default []: no screenshot at all where a top or frame URL matches
}

interface RiskJudgeConfig {                 // every field has a default, and the block itself is optional
  mode: 'off' | 'advise' | 'enforce';       // default 'enforce': a judgment may raise risk; 'advise' only logs it
  irreversibleThreshold: number;            // default 0.5: pIrreversible at or above it counts as irreversible
  onError: 'fail_closed' | 'fail_open';     // default 'fail_closed': an unavailable judge makes the action irreversible
  timeoutMs: number;                        // default 5000, per judgment, retries included
}
```

A desktop origin is `desktop://<process>`: the process name as the OS reports it, lower-cased,
without `.exe` (an entry with `.exe` is rejected with a message saying so). It matches exactly that
process, case-insensitively, with no wildcards. An `allowedOrigins` entry that is neither an
http(s) origin nor a well-formed desktop location makes the guard throw. Origins compare through
`allowlistOrigin` (`packages/core/src/policy/guard.ts`), never `URL.origin`, which is `"null"` for
every desktop URL. See `docs/design/desktop.md`, "Policy and desktop locations".

A press of any committing key (`Enter`, `Return`, `NumpadEnter`, `Space`, `Spacebar`, `" "`,
`\r`, `\n`, `\r\n`; names case-insensitive) is classified like Enter (`committingKey`,
`packages/core/src/surface/url-shape.ts`).

## 5. Run events (JSONL evidence)

```ts
type RunKind = 'discovery' | 'replay';

interface RunEvent {
  runId: string;
  seq: number;
  ts: string;
  kind:
    | 'run_started' | 'run_finished'
    | 'observation'        // summary of what the surface reported (element count, url, screenshot path)
    | 'decision'           // discovery only: model's stated reasoning + chosen action (redacted)
    | 'action' | 'action_result'
    | 'locator_resolved'   // replay: which strategy fired, fallbackDepth
    | 'checkpoint'         // pre/postcondition evaluation result
    | 'recovery'           // a RecoveryRule fired
    | 'outcome'            // business outcome detected
    | 'policy'             // allow/deny/flag decision
    | 'escalation'         // intervention raised
    | 'control_transfer'   // automation -> paused -> human -> resuming -> automation
    | 'human_action'       // captured during human control
    | 'error';
  stepId?: string;
  data: Record<string, unknown>;    // already redacted
  evidence?: { screenshot?: string; dom?: string };   // paths relative to the run directory
}
```

Run directory layout: `runs/<runId>/events.jsonl`, `runs/<runId>/shots/<seq>.png`,
`runs/<runId>/dom/<seq>.html` (failures only), `runs/<runId>/interventions/<id>.json` (handoff
records), `runs/<runId>/result.json`, and for discovery runs `runs/<runId>/transcript.jsonl` (the
redacted model transcript). A discovery run also holds `capability.json` (the capability as
discovered, written before the optimizer stage), `optimize.json` (that stage's report) and, under
`--candidates`, `candidate.json`. `cu optimize` writes its report to
`runs/optimize-<runId>/optimize.json`. Optimizer reports hold output names and verdicts, never
input or output values.

A risk-judge consultation is a `policy` event with `data.source: 'risk-judge'`, the judge id, the
mode, the lexical and resulting risk, `pIrreversible`, the scrubbed rationale and whether it came
from the cache. A `beforeStep` probe (section 11) is a `checkpoint` event with `phase: 'observe'`.
Escalation events add the phases `resume_at` and `resume_at_refused` (section 7).

## 6. Replay result

```ts
type FailureCode =
  | 'element_not_found' | 'precondition_failed' | 'checkpoint_failed' | 'timeout'
  | 'policy_violation' | 'unexpected_dialog' | 'session_expired' | 'app_error'
  | 'navigation_failed' | 'input_validation' | 'internal';

interface LocatorReportEntry { stepId: string; strategyKind: LocatorStrategy['kind']; fallbackDepth: number }

interface ReplayBase { runId: string; capabilityId: string; capabilityVersion: string; capabilityDigest?: string; stepsExecuted: number; durationMs: number; locatorReport: LocatorReportEntry[]; recoveries: string[] }
// capabilityDigest: sha256 over the canonical JSON of the replayed capability without status, version and
// provenance (packages/core/src/schema/digest.ts). Set on every result of a capability that passed
// validation; absent when the artifact failed validation, and on results written before it existed.
// `cu approve` checks it (section 3, "Approval").
// recoveries: the names of the recovery rules that fired, in order, plus `retry_app_error` once per
// app-error retry (the engine's own recovery, not a rule of the capability; section 11).

type ReplayResult =
  | (ReplayBase & { kind: 'success';          outputs: Record<string, string | number | boolean> })
  | (ReplayBase & { kind: 'business_outcome'; name: string; data: Record<string, string | number | boolean>; missing?: string[] })
  | (ReplayBase & { kind: 'hard_failure';     stepId?: string; stepName?: string; code: FailureCode; expected: string; observed: string; message: string; evidence: { screenshot?: string; dom?: string } })
  | (ReplayBase & { kind: 'escalated';        interventionId: string; stepId?: string; reason: string; resolution?: 'resumed_success' | 'resumed_failed' | 'abandoned';
                    outcome?: { kind: 'success'; outputs } | { kind: 'business_outcome'; name; data } | { kind: 'hard_failure'; code; message; stepId? } });  // the caller's real answer after hand-back
```

`element_not_found` has two causes. No locator of the chain matched, and `observed` lists each one
with its reason. Or a positional locator matched and replay did not use it (section 1,
"Replay"). No new code exists for that; the three strings say which rule refused it:

| | `message` | `observed` |
|---|---|---|
| ambiguity | `step s09: 2 candidates matched the relative locator of "<target>"; replay does not settle an ambiguity by position (css fallback at depth 1 not used)` | `2 candidates matched its relative locator (relative: ambiguous anchor: 2 matches); the positional css locator at depth 1 matched and was not used` |
| read | `step s09: a positional fallback (css at depth 1) was not used for a read of "<target>": none of the locators that name it matched` | `no locator that names it matched (relative: no anchor match); the positional css locator at depth 1 matched and was not used` |

`expected` is `exactly one match for a locator that names "<target>"`, or `"<target>" found by a
locator that names it (relative) before its value is read`. `<target>` is the description as
recorded, placeholders unbound. A refused resolution adds no `locatorReport` entry and no
`locator_resolved` event.

`business_outcome.missing` names every declared `returns` key whose `extract` failed (target not
found, a positional fallback replay refused, or a read/parse/coerce error), so it is absent from
`data`. Omitted (never an empty array)
when every attempted key extracted successfully; a business outcome with no `extract` at all
(e.g. `member_not_found`) never has it either. The escalated result's own nested
`{kind:'business_outcome'}` outcome does not carry `missing`. It is a `ReplayResult`-only field.

### Stability summary

`replay --times N` aggregates its results with `summarizeStability` (`packages/core/src/replay/describe.ts`):

```ts
interface StabilitySummary {
  runs: number;
  successes: number;
  byKind: Record<'success' | 'business_outcome' | 'hard_failure' | 'escalated', number>;   // every kind present, zero included
  businessOutcomes: Record<string, number>;     // by outcome name
  failures: Record<string, number>;             // hard failures by FailureCode
  escalations: number;
  escalationBreakdown: {
    reason: Record<string, number>;             // by intervention reason
    resolution: Record<string, number>;         // resumed_success | resumed_failed | abandoned | pending
    outcome: Record<string, number>;            // success | business_outcome:<name> | hard_failure:<code> | none
  };
  recoveries: Record<string, { fired: number; runs: number }>;   // by recovery rule name; app-error retries count under `retry_app_error`
  fallbackDepths: Record<string, number>;       // every locator resolution in the series, by depth ("0" = first locator)
  drift: LocatorDriftSummary;                   // union across runs of targets that did not resolve at depth 0
  meanDurationMs: number; minDurationMs: number; maxDurationMs: number;
}
```

Every keyed counter is prototype-free, so an outcome or rule named `__proto__` counts like any
other key. With `--json`, a series prints `{ runs: ReplayResult[], stability: StabilitySummary,
chaos? }`. `chaos` is present only when `--fault` set mock-app chaos (section 9):

```ts
interface SeriesChaos {
  seed: number;
  fault: unknown;                               // the exact --fault value; re-running with it and the same --times reproduces the series
  report?: {                                    // what GET /__faults/chaos returned after the series
    config: Record<string, unknown> | null;
    stats: Record<string, { draws: number; fired: number }>;
    log: { seq: number; kind: string; draw: number; method: string; path: string; delayMs?: number }[];
    logDropped: number;
  };
  reportError?: string;                         // why report is missing
}
```

## 7. Session control and intervention

```ts
type ControlState = 'automation' | 'paused' | 'human' | 'resuming';
// Transitions: automation -> paused (escalation raised) -> human (operator takes control)
//              human -> resuming (operator hands back) -> automation (checkpoint re-verified) | paused (re-verify failed)
//              any -> aborted terminal via intervention status 'abandoned'

interface HumanAction {
  ts: string;
  type: 'click' | 'input' | 'keypress' | 'navigate' | 'submit';
  frame: FramePath;
  target: { tag?: string; role?: string; name?: string; text?: string; selector?: string };
  valueRedacted?: boolean;          // inputs are never stored in plaintext
  key?: string;                     // keypress only: a named key ('Enter', 'Tab', 'Escape')
  url?: string;
}

interface Intervention {
  id: string;
  runId: string;
  runKind: RunKind;
  capabilityId?: string;
  goal?: string;
  stepId?: string;
  reason: { code: 'stuck' | 'risky_action_confirmation' | 'unrecoverable_condition' | 'policy_block' | 'max_steps' | 'unexpected_dialog'; message: string };
  screenshotPath?: string;
  currentUrl?: string;
  createdAt: string;
  status: 'open' | 'human_active' | 'resolved' | 'abandoned';
  resolution?: {
    by: string;
    at: string;
    notes?: string;
    humanActions: HumanAction[];
    resumeFrom: 'current_step' | 'next_step' | 'abort';
    resumeAtStepId?: string;        // with 'current_step' only: the step replay was asked to resume at
  };
}
```

A resolution may name a resume point, `resumeAtStepId`, so replay rebuilds page state a lost
session destroyed (a typed member id) instead of re-running only the failing step. The broker and
Relay's API reject it with `next_step`; Relay's UI never sends it. It does not have to after a lost
session: when the failure being resolved was classified `session_expired`, a `current_step`
resolution that names no resume point resumes at the first step after the capability's sign-in
steps, chosen by replay (the `resume_at` event then carries `defaulted: true`). A capability with
no sign-in steps, or with nothing after them, has no such default and re-runs the failing step.
When the default applies, the escalation request's `context` carries
`retryResume: { stepId: string; stepName: string; refused?: string }`: where a retry will resume,
and, when replay would refuse it, why. Relay's hand-back form words its retry option from it.
Replay decides whether a resume point, named or defaulted, is safe
(`packages/core/src/replay/rewind.ts`) and refuses a step that is not part of the run
(`unknown_step`), one that would repeat a step whose irreversible action was dispatched
(`would_repeat_irreversible`), or one that would skip an irreversible step
(`would_skip_irreversible`). A refusal never falls back to `current_step`: replay logs
`escalation {phase: 'resume_at_refused'}` and escalates the same failure again with reason
`policy_block`. An accepted resume point logs `escalation {phase: 'resume_at'}`, drops outputs
extracted at or after it, and, when the failure was `session_expired`, resets recovery-rule
budgets. See `docs/design/replay.md`, "Resuming at another step".

## 7b. Escalation seam (`packages/core/src/session/types.ts`)

Replay and discovery call an `EscalationHandler(req) => Promise<EscalationResolution>` and
await it; while pending, control belongs to the human and automation must not touch the
surface. `EscalationResolution` is `{ interventionId, resumeFrom, resumeAtStepId?, notes?,
humanActions, by }`; discovery ignores `resumeAtStepId` and sees a plain `current_step`. The SessionBroker implements it (control token state machine, operator surface,
human-action capture). The `SessionBroker` interface (`packages/core/src/session/broker-api.ts`)
also exposes `leaseMs` (its `interventionLeaseMs`) and `onHumanAction(listener)` (fires once per
accepted, sanitized human action), both consumed by Relay's broker adapter
(`apps/relay/src/server/broker-adapter.ts`). Tests use a scripted handler. See those files for the
exact types.

## 8. Surface interface (`packages/core/src/surface/types.ts`)

```ts
interface ObservedElement {
  ref: string;                      // "e12", stable within one observation only
  role: string;                     // ARIA role or inferred ("clickable", "textbox", "generic")
  name: string;                     // accessible name or best-effort label
  text?: string;                    // trimmed visible text, max 120 chars
  tag: string;
  value?: string;                   // REDACTED for password fields
  bbox: { x: number; y: number; w: number; h: number };   // viewport px, top-document coordinates
  frame: FramePath;
  enabled: boolean;
  descriptor: TargetDescriptor;     // synthesized fallback chain for this element
  masked?: true;                    // a screen-mask rule hides it: text/value are a placeholder ('' stays ''), and so is name unless
                                    // it is a field (name = its label) or a web control (keeps its verb: "Delete [MASKED:member]")
}

interface Observation {
  url: string;
  title: string;
  screenshotPng?: Buffer;           // absent when screen masking took none (omitted by policy, unplannable, out-ranked, never still)
  elements: ObservedElement[];      // interactive + informative elements, then text leaves, capped (e.g. 150)
  elementsOmitted?: number;         // how many more the surface found than `elements` holds (its cap dropped them); absent when none
  frames: { path: FramePath; url: string }[];
  dialog?: { type: 'alert' | 'confirm' | 'prompt'; message: string };
  textDigest: string;               // visible text, whitespace-collapsed, capped, for the model and for text conditions
}

type ResolvedTarget = { ref: string } | TargetDescriptor;
type SurfaceAction = Action with targets as ResolvedTarget, values already bound to strings (secrets bound at the last moment)

interface ActResult { ok: boolean; error?: { code: FailureCode; message: string }; navigated?: boolean }

interface ActOptions { allowIrreversible?: boolean }   // read only by the policy-enforcing wrapper

interface RefDescription {
  tag?: string; role?: string; frameUrl?: string;
  name?: string; text?: string;     // the masked view, as the observation shows it (what a policy decision event may quote)
  classifyName?: string;            // the real strings, for risk classification only; never logged
  classifyText?: string;
}

interface TriedStrategy {           // one locator that did not produce the element
  strategyKind: string;
  error: string;                    // "no match", "ambiguous: 2 matches", "ambiguous anchor: 2 matches", ...
  ambiguous?: true;                 // the miss was an ambiguity: several elements matched and none could be preferred
  matches?: number;                 // with `ambiguous`: how many
}

type Resolution =
  | { found: true;  ref: string; strategyIndex: number; strategyKind: LocatorStrategy['kind'];
      tried: TriedStrategy[] }      // the misses before the winner, in chain order: tried[i] is locators[i]
  | { found: false; tried: TriedStrategy[] };

type ReadTextResult =
  | { ok: true; text: string; masked?: true }   // masked: the read touched masked content; the caller withholds it and records it sensitive
  | { ok: false; error: { code: FailureCode; message: string } };

interface CheckOptions {
  view?: 'real' | 'masked';         // 'masked': evaluate against the masked text view (discovery, for model-written text)
  recorded?: Condition;             // the condition before input binding, same shape: element conditions judge positional locators on it
}

interface HumanActionCapture {          // present on surfaces that can record what a human does during handoff
  start(onAction: (a: HumanAction) => void): Promise<void>;
  stop(): Promise<void>;
}

interface Surface {
  observe(): Promise<Observation>;
  resolve(target: TargetDescriptor, timeoutMs: number): Promise<Resolution>;
  act(action: SurfaceAction, timeoutMs: number, opts?: ActOptions): Promise<ActResult>;
  readText(target: ResolvedTarget, timeoutMs: number): Promise<ReadTextResult>;   // used by `extract`
  humanCapture?: HumanActionCapture;
  check(condition: Condition, opts?: CheckOptions): Promise<boolean>;
  waitFor(condition: Condition, timeoutMs: number, opts?: CheckOptions): Promise<boolean>;
  screenshot(): Promise<Buffer>;    // masked; the omitted-screenshot placeholder PNG where none may be taken (isOmittedScreenshot)
  domSnapshot(): Promise<string>;   // for failure evidence; may be truncated
  currentUrl(): Promise<string>;
  frameUrls?(): Promise<string[]>;                            // top document and every frame, top first; used by the policy wrapper
  describeRef?(ref: string): Promise<RefDescription | undefined>;   // what a ref points at, for risk classification; undefined when unknown or stale
  isSameElement?(refA: string, refB: string): Promise<boolean>;      // node identity of two refs (an observed one, one resolve() returned)
  recordContextOf?(ref: string): RecordContext | undefined;         // discovery's recorder only; see below
  readRecordText?(target: ResolvedTarget, within: 'container' | 'page', timeoutMs: number): Promise<RecordTextResult>;   // text of the value's record container, for an extract's identity check; see below
  close(): Promise<void>;
}

interface RecordContext {           // REAL (unmasked) text; never part of an Observation, never shown, logged or persisted
  ownText: string;
  ownTextMasked?: true;             // the element's own text holds masked content: no locator may quote it
  rowCells: {                       // the element's table row's other cells
    text: string; relation: 'right-of' | 'left-of';
    tag?: string; index?: number;   // the cell's column
    shared?: { prefix: string; suffix: string };   // static text every data cell of that column shares (3+ cells, no digits)
    masked?: true;                  // set by the surface: the cell holds masked content
  }[];
  cell: { tag: string; index: number } | null;                      // its own cell
  containerText: string;            // its record container's text
  labelUnique?: boolean;            // with a label cell: false when that label anchors more than once on the page
  tag: string; role?: string;
}
```

Discovery uses `isSameElement` to check, before recording, that a target scoped to a run input
finds the element that was acted on. A surface without it cannot verify, so a record-scoped extract
is refused and a record-scoped action escalates at replay. `recordContextOf` returns the
`RecordContext` of an element of the latest observation. The recorder compares it with the run's
own non-sensitive inputs to decide whether the element belongs to the record an input names. The
policy wrapper and the agent's broker surface forward it. The operator's surface does not.

`readRecordText` returns `{ ok: true, text, scope: 'container' | 'page' }` or a typed failure: the
real, unmasked text of the element's record container (the whole frame when `within` is `page`, or
when the element has no container, which `scope` reports). It is for one comparison, made by
`recordTextShows` (a whole-token, case-sensitive match) at record time and again at replay. A caller
never logs, shows or persists the text. The policy wrapper and the broker's surface forward it, the
operator's does not, and a surface without it records and checks nothing.

A surface resolves a chain by "first unique match wins" and reports what missed before the
winner. It does not decide whether a positional winner may be used. `positionalFallbackRefusal(
recordedTarget, resolution, { read })` (`packages/core/src/surface/positional-fallback.ts`) does,
from the target as recorded: it returns `undefined`, or `{ reason: 'ambiguous' | 'positional_read',
winner, ambiguous?, expected, observed, message }`. Replay calls it after every `resolve`.
`evaluateCondition` calls it for `element_visible` and `element_absent` with `read: false`, so an
element condition never holds through a positional locator that won after an ambiguity. A refusal
never makes a condition true: `element_absent` and `not element_visible` are false on it too.

`FakeSurface` is an in-memory implementation: a graph of named screens, each with
elements, and transition rules `(screenId, action) -> screenId | dialog | error`. Replay,
session and discovery code all test against it. It honors descriptors (resolves by role/name,
label, text; reports strategyIndex and `tried`) so fallback behaviour can be unit tested. Its
relative anchor follows the real resolver's rule: one element whose text equals the anchor wins,
else one element containing it, and several are an ambiguity.

The other implementations are the Playwright surface (`@cu/adapter-playwright`) and the Windows
UI Automation surface (`@cu/adapter-desktop`). On the desktop surface `Observation.url` is
`desktop://<process>/<window title>` (the title percent-encoded as one segment), a `FramePath` hop
is another window of the app or a named group, `domSnapshot` is the accessibility tree with no
values, and an `automation_id` locator resolves; on the web it is always a miss. The full mapping
is in `docs/design/desktop.md`.

## 9. Mock app route map (tenant A; tenant B differs only where noted)

Base URL `http://localhost:4173` (tenant A) and `http://localhost:4174` (tenant B), selected by
env `MOCK_TENANT=a|b` and `MOCK_PORT`.

| Route | Page | Notes |
|---|---|---|
| `GET /login`, `POST /login` | Login (1998) | user `operator1`, password from env `MOCK_PASSWORD` (default `demo-pass-123`). Wrong password -> red text "Invalid user ID or password." |
| `GET /workstation` | Frameset (2001) | frames: `banner`, `nav`, `main`. Tenant B uses an `<iframe name="main">` inside a table instead of a frameset. |
| `GET /frames/banner`, `/frames/nav` | Banner (tenant branding), nav links table | |
| `GET /members/search` | Member search (2005) | query `memberId`, `lastName`. Results in nested table; row `onclick` -> detail. Zero results -> `<td class="msg">No records found.</td>` (red). Tenant B label "Member #" instead of "Member ID". |
| `GET /members/:id` | Member detail (2008) | span tabs `?tab=profile|accounts|notes`. Profile shows Savings Balance in a label/value table. |
| `GET /members/:id` for restricted member | Access denied page | HTTP 403, text "Access Denied: your role does not permit viewing this member." |
| `GET /members/:id/subaccounts/new` | Open sub-account form (2012) | custom div dropdown for account type, initial deposit field, nickname. Tenant B adds required "Branch code". Client-side confirm modal (div overlay) before POST. `window.confirm` on navigating away with unsaved changes. |
| `POST /members/:id/subaccounts` | Server validation or create | Missing/invalid -> same form with red error list at top. Success -> redirect to confirmation. |
| `GET /members/:id/subaccounts/:ref/confirmation` | Confirmation (2012) | reference number `SA-XXXXXXX` in `<b>` inside a table cell. |
| `GET /session-expired` | Session expired | text "Your session has expired. Click here to log in." |
| `GET /__faults`, `POST /__faults`, `POST /__reset` | Fault injection | JSON body: `{ slowMs?: number, failSearch?: boolean, expireSession?: boolean, interstitial?: boolean, denyMember?: string, chaos?: ChaosConfig \| null }`. `expireSession` makes the *next* authenticated request redirect to `/session-expired` and clear the flag. `POST /__faults` answers the new flags plus a `rejected` list of keys it refused; a non-object or malformed body is HTTP 400. `POST /__reset` restores the defaults, chaos off. |
| `GET /__faults/chaos` | Chaos report (read-only) | `{ config, stats: { <kind>: { draws, fired } }, log: [{ seq, kind, draw, method, path, delayMs? }], logDropped }`. The log keeps the latest 1000 injected faults and holds no session ids, cookies, query strings or credentials. |

Seed data: members `10001`–`10020` (names, savings/checking balances). Fixed cases:
`12345` = Jane Q. Sample, savings `$1,234.56`, checking `$310.00`. `99999` = not found.
`90001` = restricted (403). Interstitial: "System Maintenance Notice" div modal with an "OK"
div-button, shown once per session when `interstitial` fault is on (default ON, so the
recoverable path is exercised on every run).

Seeded chaos makes the same faults fire per request with a probability:

```ts
interface ChaosConfig {
  seed: number;                                       // integer 0..2^32-1, required
  failSearch?: number;                                // probability 0..1, drawn on each GET /members/search
  interstitial?: number;                              // drawn on each main-content page the once-per-session notice did not take
  expireSession?: number;                             // drawn on each authenticated /members/... request
  slowMs?: { p: number; minMs: number; maxMs: number };   // one /members/... response delayed by a uniform integer in [minMs, maxMs]; 0 <= minMs <= maxMs <= 120000
}
```

Chaos is off by default and per app instance. Each kind has its own seeded stream, and draws
happen only on `/members/...` requests, so the same seed and the same sequence of member requests
produce the same faults. An explicit switch wins over chaos for the same fault. Every accepted
`chaos` object restarts the streams from the seed; an invalid one is rejected whole (named in
`rejected`, for example `chaos.failSearch`) and the previous chaos keeps running. The policy's
`^/__faults` deny pattern keeps automation off `/__faults/chaos` too. Precedence and what breaks
determinism are in `docs/design/mock-app.md`, "Seeded chaos".

## 10. Discovery goals

- **G1 (primary, read-only):** "Log in to the workstation, look up member {memberId} and read their current savings balance and member name." Inputs: `memberId`. Outputs: `savingsBalance` (number), `memberName` (string). Business outcomes, each declared by an extend run: `member_not_found` and `member_access_denied`. This is the goal recorded in `evidence/discovery-run`. The hand-written example artifact names the second outcome `access_denied`.
- **G2 (irreversible, defined, not recorded in `evidence/`):** "Open a new savings sub-account for member {memberId} with initial deposit {amount} and reach the confirmation screen." Exercises risky-action escalation and the confirmation modal. Output: `referenceNumber`.

## 11. Replay options (`packages/core/src/replay/types.ts`)

`replayCapability(opts: ReplayOptions)` takes the raw artifact, the inputs, a surface, the base
URL and a run logger, plus optional tenant, policy guard, approval setting, escalation handler and
limits, and timing settings. The options added since the first version:

```ts
interface ReplayOptions {
  // ...
  secret?: (name: string) => string | undefined;   // resolves {kind:'secret'} bindings at bind time (typically CredentialSet.get).
                                                   // Omitted: every secret binding fails to bind. There is no fallback to process.env.
  beforeStep?: BeforeStepHook;                     // observational per-step hook, below
  readOnly?: boolean;                              // the caller's unverified assertion, for this run, that replaying the capability changes
                                                   // nothing in the app: the run-level form of the artifact's `readOnly: true`.
                                                   // Refused (hard_failure policy_violation, before any surface call) on a capability the
                                                   // validator would not accept `readOnly: true` on (`read_only_irreversible`).
  maxAppErrorRetries?: number;                     // app-error retries per run; default 2, 0 disables; counted apart from maxEscalations
  appErrorRetryBackoffMs?: number;                 // retry n waits n times this on the run's clock; default 1000
                                                   // Both are clamped to non-negative integers: negative is 0, a fraction rounds down,
                                                   // NaN or infinite falls back to the default.
}

type BeforeStepHook = (info: BeforeStepInfo) => void | Promise<void>;
interface BeforeStepInfo {
  step: Readonly<Step>;                            // a frozen copy of the step about to act, as this run executes it, unbound
  check(condition: Condition): Promise<boolean>;   // binds placeholders like the step's own conditions and evaluates once; never acts
}
```

The hook runs once per step attempt, after recovery rules and the precondition, just before the
policy gate and the action. It cannot act or change the run. A throw is logged and ignored, and a
hook that has not settled after 10 seconds (`BEFORE_STEP_HOOK_TIMEOUT_MS`) is logged as hung and the
step proceeds. The optimizer uses it to find postconditions that already held before their step.

The app-error retry applies only to a run asserted read-only: the capability's own `readOnly: true`,
or `readOnly` here (`replay --read-only`, `catalog invoke --read-only`). Only an `app_error` read from
the page is retried: the page text matched an app-error signal (`matchedSignal` on the classified
failure). An `app_error` a surface reports for a control it found but could not operate is not. Such
a failure makes replay wait and restart its steps at a `navigate`: the first step after the sign-in
when that step is one, otherwise step 0 when it is one, otherwise no retry. Each retry is a `recovery` event
`{rule: 'retry_app_error', attempt, of, backoffMs, restartAt}` and a `retry_app_error` entry in
`result.recoveries`; a retry not taken is a `recovery` event with `skipped: true` and a `reason`.
With the retries spent the result is `hard_failure app_error` as before. The CLI passes the
policy's `limits.maxAppErrorRetries`; optimizer trials pass 0. Details and limits:
`docs/design/replay.md`, "Retrying a transient app error".

## 12. Discovery result (`packages/core/src/agent/types.ts`)

`discover(opts: DiscoverOptions): Promise<DiscoveryResult>`. Additions to the options:
`app.surface: 'web' | 'desktop'`; `judge?: RiskJudge` (section 14) with
`onRiskJudgeUnavailable?`; `secrets?: (name) => string | undefined`, the credential resolver for
`secretEnvNames` (omitted, none resolves); and `readOnly?: boolean`. Additions to the result:

```ts
interface DiscoveryResult {
  // ...
  readOnlyDropped?: string[];       // declared read-only, but these recorded steps are irreversible: the capability is written without readOnly
  riskJudge?: RiskJudgeSummary;     // present when a judge was wired in and its mode is not 'off'
}

interface RiskJudgeSummary {
  id: string;                       // e.g. "jev:jev-latest"
  mode: 'advise' | 'enforce';
  calls: number;                    // calls that reached the judge (cache hits excluded)
  cacheHits: number;
  unavailable: number;
  raised: number;                   // actions the judge raised above the lexical risk (enforce mode)
}
```

## 13. Credentials (`packages/core/src/credentials/types.ts`)

```ts
interface CredentialProvider {
  readonly id: string;                                          // 'env', 'file:<path>', 'exec:<program>' (never the arguments)
  load(names: readonly string[]): Promise<CredentialLoadResult>;
}

interface CredentialSet {
  get(name: string): string | undefined;                        // backs bind-time resolution; never an empty string
  values(): string[];                                           // what the run's redactor scrubs
  names(): string[];
}

type CredentialLoadResult = { ok: true; set: CredentialSet } | { ok: false; error: CredentialFailure };

interface CredentialFailure {
  code: 'missing' | 'invalid_name' | 'unavailable' | 'malformed' | 'refused' | 'timeout' | 'failed' | 'provider_error';
  providerId: string;
  names: string[];                                              // for 'missing': exactly the absent names
  message: string;                                              // names credentials and the provider, never a value
}
```

`load` runs once per run, before a browser, a console or a model client exists. `loadCredentials`
(same module) validates and de-duplicates the names, trims the set to exactly those requested, and
turns any name without a non-empty value into `missing`. Providers: `envCredentialProvider` in core
(the default), and `file:` and `exec:` in `@cu/adapter-credentials`, picked by `--credentials` or
`CU_CREDENTIALS`. The `exec:` protocol and the `file:` dialect are in `docs/design/credentials.md`.

## 14. Risk judge (`packages/core/src/policy/judge.ts`)

```ts
interface RiskJudge {
  readonly id: string;
  judge(req: RiskJudgeRequest, signal?: AbortSignal): Promise<RiskJudgment>;   // throwing means "could not judge"
}

interface RiskJudgeRequest {
  phase: 'record' | 'audit';
  action: { type: ActionType; key?: string; accept?: boolean; url?: string; pressEnter?: boolean };   // never a typed value
  target?: { name?; text?; role?; tag?; description?; frame?; nearby?: string[] };
  page: { url: string; title?: string; textDigest?: string; dialogMessage?: string };   // head and tail of the visible text; 2,000 characters with `nearby`
  goal: string;                     // the run's goal (record) or the capability's name and description (audit)
  why?: string;
  lexicalRisk: RiskClass;
}

interface RiskJudgment { risk: RiskClass; pIrreversible: number; rationale?: string }
```

Every string in a request is scrubbed before it leaves (secret and sensitive values, policy
redaction patterns). `combineRisk` returns the maximum of the lexical and judged risk, so a
judgment never lowers risk, and `irreversible` is decided by `pIrreversible >=
irreversibleThreshold`, not by the judge's own label. `createGuardedJudge` adds the timeout, turns
errors and malformed answers into an `unavailable` outcome, and caches per run. Replay never calls
a judge. See `docs/design/risk-judge.md`.

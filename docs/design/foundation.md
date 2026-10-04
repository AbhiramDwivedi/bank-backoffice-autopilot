# Foundation: schema, Surface seam, evidence

This is the code every other module builds against: the contract types (`docs/contracts.md`), the
`Surface` seam, and the evidence sink.

## Schema

Every contract type has a zod schema and an inferred TS type of the same name, re-exported from
`packages/core/src/schema/index.ts`. Discriminated unions (`LocatorStrategy`, `ValueBinding`, `Condition`,
`Action`, `ReplayResult`) use `z.discriminatedUnion`; `Condition` is recursive (`all`/`any`/`not`).
Objects are strict, so an unknown key in a hand-edited artifact fails loudly.

`validateCapability(obj)` parses the object and enforces the cross-field invariants: unique step
ids, and `{kind:'input'}` bindings and `{input.x}` placeholders that reference declared inputs,
wherever replay binds a string (entry URL, steps, conditions, outcomes, recovery rules, overrides). Declared outputs and extract steps agree in both directions, and business-outcome
`returns` and `extract` agree. `riskLevel` equals the max step risk, and `afterSteps` and override
`stepId`s reference real steps. Recovery-rule actions are not irreversible, version is semver, and
regex sources compile; a tenant override cannot introduce or retarget an irreversible step. It
returns typed issues (`code`, `path`, `message`) and never throws.

JSON Schema for `Capability`, `Policy`, `ReplayResult`, `RunEvent` and `Intervention` is exported
to `packages/core/schema/*.json` by `npm run schema:export`, using zod v4's native `z.toJSONSchema`. (The
`zod-to-json-schema` package emits empty schemas for zod v4, so it is unused.) A hand-written
example capability for the primary discovery goal lives at
`artifacts/examples/lookup-member-savings-balance.example.json` and passes `validateCapability`.

## Templating

Any string in a `Capability` (locator names/labels/texts, relative anchors, css selectors,
condition texts and URL patterns, literal values, navigate URLs) may contain `{baseUrl}` and
`{input.<name>}` placeholders. These are bound at replay time by `bindStep` (`packages/core/src/schema/template.ts`).
Regex-typed fields (`url_matches.pattern`, `dialog_open.messagePattern`) are bound with the
substituted value regex-escaped. A `css` locator's selector is bound with the value CSS-escaped
(the CSSOM `CSS.escape` algorithm). So a malicious input value can only ever match itself
literally, never change the pattern or selector's structure. Plain-text fields substitute the
value as-is. `FrameHop.urlPattern` is the one string never templated: a placeholder there is left
unbound, so a frame hop cannot depend on an input value.

## Deterministic replay

Targets carry an ordered locator chain; `Resolution` reports `strategyIndex` and `strategyKind`,
so fallback depth is observable. `ReplayResult` has exactly four kinds; recoverable conditions are
`RecoveryRule`s and appear in `recoveries[]`, never as a result kind. `FakeSurface` can simulate
every runtime condition the product needs to demonstrate: not-found, access denied, interstitial,
session expiry, timeout/slowness, element not found, and a native dialog.

## Safety

`policies/default.yaml` parses to a `Policy`; fault-injection routes are denied; every action type
is listed explicitly in `allowedActions`. Credentials are bound via `{kind:'secret', env}`; the
validator rejects a literal typed into a password-like target and a literal that matches a
redaction pattern. The run logger redacts `data` deeply before writing and never mutates its
input.

## Evidence

`runs/<runId>/events.jsonl` has monotonically increasing `seq`, an ISO `ts`, and schema-valid
`RunEvent`s; screenshots and DOM snapshots go to `shots/<seq>.png` and `dom/<seq>.html`;
`result.json` is written on finish.

## Handoff

`ControlState`, `HumanAction` (the typed value is never stored, only `valueRedacted`), and
`Intervention` with its resolution and `resumeFrom` are part of the schema. `packages/core/src/session/`
builds the state machine on top; `apps/relay/` builds the console on top of that (see
`docs/design/handoff.md`, `docs/design/relay.md`).

## Conventions

Cross-module imports go through each module's `index.ts` (an ESLint `no-restricted-imports` rule
enforces this); imports use `.js` suffixes (NodeNext). Regex sources in a `Policy` are compiled
with the `i` flag; regex sources in a `Capability` (`url_matches`, `InputSpec.pattern`, extract
`pattern`, `dialog_open.messagePattern`) are compiled with no flags. `Condition` evaluation
semantics live only in `packages/core/src/surface/conditions.ts`. A real Playwright surface builds a
`ConditionView` and calls the same function. This way, the fake and real surfaces cannot drift
apart on semantics. See `docs/design/surface.md`.

## Design rationale

**Capability, not a step list.** A calling agent needs a contract it can plan against: what to
supply (`inputs`, typed, with `sensitive` and `pattern`) and what comes back (`outputs`). It also
needs to know which non-success answers are legitimate (`businessOutcomes`). Steps are the implementation behind that
contract and can be re-recorded, or patched per tenant, without changing the contract. `riskLevel`
is denormalized onto the capability (validator-checked to equal the max step risk) so a caller can
gate on it without reading steps. `status`, `version` and `provenance` make it reviewable: who or
what recorded it, from which run, and whether it has been approved.

**Ordered locator chain.** Legacy surfaces rarely offer one identifier that is both stable and
available. The chain goes from semantic (role and name, label) to structural (relative to a text
anchor, which handles label/value tables with no `for=`). It continues to brittle (css), then to
purely visual (bbox, the only strategy a desktop surface is guaranteed to have). Replay tries
them in order and reports which one fired. Fallback depth greater than zero is the drift signal:
the run still succeeds, but the artifact should be re-recorded before the chain runs out.
Resolution is strict: a strategy that matches more than one element counts as a miss and falls
through, because clicking the wrong row is worse than escalating.

**Four result kinds.** `success`, `business_outcome`, `hard_failure`, `escalated`. A common
mistake is conflating "no such member" with a crash, so business outcomes are declared on the
artifact with their own detector and return shape. Recoverable conditions (a maintenance notice,
transient slowness) are not a result kind: a `RecoveryRule` handles them mid-run and shows up in
`recoveries[]` and the event log. That keeps a caller's switch statement to four cases, each with a
distinct next action: use the data, relay the outcome, report a bug, or wait for a human.

**Redaction at the sink.** Callers of the run logger pass raw data; the logger redacts before
anything touches disk. One enforcement point means no call site has to remember to redact, and a
new event kind cannot leak by omission. Default patterns (password, token, secret, authorization,
cookie keys; SSN, card, bearer shapes) are always on and merged with policy patterns, so they are
hard to switch off by accident. On the artifact side, credentials are `{kind:'secret', env}`
bindings, and `validateCapability` rejects a literal typed into a password-like field. A DOM
snapshot is an unstructured string, so the logger can only apply pattern redaction to it. Key-based
protection for DOM evidence has to happen one layer up, in `Surface.domSnapshot()`, which blanks
password-field values. A secret with no recognizable shape rendered as visible page text would
still get through.

**FakeSurface.** A scenario is a graph of screens: each screen has a URL, title, extra text, and
frames. Each element carries the metadata the locator strategies need (role, name, text, tag,
label, row, css, bbox, frame). Transitions are ordered rules keyed by `(from, action, when?)`, so
data-dependent flows (searching for a missing id goes to the empty-results screen) are one `when`
guard. `resolve()` walks the locator chain in order inside the target's frame, and a strategy only
fires on exactly one match. Failure injection covers every condition named above:

- `act_error`
- `hide_element`
- `drift` (mutates an element so an earlier locator stops matching and a later one fires)
- `delay` (becomes `timeout` past the step budget)
- `expire_session`
- an unexpected native dialog

A pluggable clock means tests never really sleep. `fake-scenarios/cu-core.ts` models the mock
app's primary path for both tenants.

## Known limits

- **FakeSurface vocabulary does not exactly mirror `apps/mock-app/`.** The login submit is an
  `<input type="image">` with no accessible name. Labels carry a trailing colon ("User ID:").
  Tenant A and B differ in banner name and frame-vs-table shell layout, and not-found/403 pages
  are standalone rather than inside the `main` frame. These need reconciling before an artifact
  recorded against the fake replays unchanged against the real app.
- **Validator risk checks are heuristic.** "Irreversible" is inferred from target text patterns.
  The authoritative gate is the policy engine at act time, not the validator.
- **Credential heuristic.** "Password-like" means the target's names, labels, texts or description
  match password/passcode/PIN/secret/OTP/security code/API key/token. A credential field with none
  of those words would get past the validator; `sensitive` inputs and sink redaction are the
  backstop.
- **Card pattern over-redacts.** Any 13-19 digit run separated by spaces or dashes is redacted,
  including non-card reference numbers. That trade-off is deliberate. Account-number redaction is
  omitted because a generic pattern would also hit member IDs.

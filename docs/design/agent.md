# Discovery agent and recorder

Code: `packages/core/src/agent/`. `discover(opts)` drives an LLM through an observe-decide-act loop against a
live `Surface` and records what it did as a `Capability` artifact (see `docs/contracts.md`). It
consumes a `Surface`, a `Policy` and policy guard, an `EscalationHandler` and a `RunLogger`.

## Loop

`discover(opts)` takes a goal, a target (`baseUrl`, `entryUrl`), an app identity, typed inputs
with concrete run values, and optional declared outputs. It observes the surface, asks the model
for one action, checks that action against policy, executes it, and records it. The loop ends
when the model calls `done` or `stuck`, or when the run is aborted. It also ends when a limit is
hit (`maxSteps`, `maxLlmCalls`, `maxDurationMs`, defaulting from `policy.limits`; see "Limits and
stuck detection" below).

The model acts only through tools (click, type, select, press, navigate, dismiss_dialog,
dismiss_interstitial, extract, declare_outcome, done, stuck), one action per turn, addressing
elements by observation ref. Perception is a screenshot plus a compact element list plus a text
digest, so the loop degrades gracefully on a page with no clean DOM. Every action states an
`expect`; the recorder verifies it with `waitFor(text_visible, 5s)` and tells the model when it
did not hold.

## What goes into the artifact

| Field | Source |
|---|---|
| `schemaVersion` | constant `'1.0'` |
| `id` | `capabilityId`, or kebab-case of the goal; extend mode keeps the existing id |
| `version` | `'1.0.0'`; extend mode bumps the minor version |
| `name` / `description` | `capabilityName` or a title-cased id; the goal text, canonicalized (never the model's `done.summary`) |
| `app` | `opts.app` plus `entryUrl` with `{baseUrl}` substituted |
| `status` | always `'draft'`; approval is a separate, human act |
| `riskLevel` | max over step risks |
| `inputs` | declared inputs, minus any never referenced (a dropped input is logged) |
| `outputs` | one per accepted `extract`, typed from the parse (`number`/`currency` to number, else string) |
| `steps[]` | one per accepted action, with a canonicalized descriptor, the value binding the model chose, the verified `expect` as `postcondition` (plus an input-bound URL check when the step landed on a URL carrying an input value), and risk from the policy guard |
| `success` | `done.success_text` as a frame-scoped `text_visible` condition, combined in an `all` with an input-bound URL check when the final URL carries an input value; `success.description` is the model's summary after the extracted-value scrub |
| `businessOutcomes[]` | one per `declare_outcome` call, detector frame-scoped to where the text appeared |
| `recoveryRules[]` | one per `dismiss_interstitial` call: trigger, dismiss actions, `maxAttempts: 2`; named `dismiss_<first 4 words of the modal title>` (snake_case, 40 chars max), else `dismiss_interstitial_<n>` |
| `provenance` | discovery time, run id, `recordedBy` (`llm`, or `mixed` if a human acted during an escalation), model name, and notes |

**Canonicalization.** Every input value (length 3 or more) that appears in a locator string,
descriptor text, condition text, or navigate URL is replaced with `{input.<name>}`. Substitution
uses the longest value first, matched only on whole tokens. `baseUrl` is replaced with `{baseUrl}`. A text
locator that mixes an input value with other record-time text (for example a result row reading
"12345 Sample, Jane Q. Active") is narrowed to the placeholder alone, matched as a whole word. The rest of that
text is the recorded member's PII and would not match any other invocation, so the same narrowing
applies to the descriptor's `description` and `snapshot`. This trades some drift-diagnostic detail
for not persisting PII in a reusable artifact. A role locator cannot be narrowed that way, because
the role strategy has no whole-word match: one whose name is the input alone is recorded `exact`,
and one whose name holds the input among other text is not recorded
([browser-agent.md](browser-agent.md)).

**Record-time data never persists.** A value read by an `extract` step or a business-outcome
extract is data about the member on screen during discovery, not part of the procedure. The
recorder drops any `text`, `role` or `label` locator on the extract target whose match string equals the
extracted value (whitespace-collapsed, case-insensitive), drops it from the target's `snapshot`, and
rewrites the target `description` from the best surviving locator (for example
`cell right of "Savings Balance" (<td>)`). If no locator survives, the extract is rejected back to the
model instead of being recorded. At build time every extracted value is replaced with
`{output.<name>}` in every free-text field: descriptions, step names, target descriptions, outcome and
recovery descriptions, and provenance notes. Outcome and recovery-rule names get the same treatment in
snake_case form (`overdrawn_98765` becomes `overdrawn_account_number`). `validateCapability` is then
called with those values as `knownValues`. Any value that is still present fails emission with
`output_value_in_artifact`: matched as a whole token in text fields and as a plain substring in CSS
selectors, URLs and URL patterns. Only machine-generated identity fields are exempt (schemaVersion,
id, version, name, app vendor/product/tenant, provenance other than notes, step ids and references).
A text return of a business outcome whose value equals or sits inside that outcome's detector text is
the outcome's static message (an "Access Denied" line), not record data, so it is not registered.

`validateCapability` runs before the artifact is returned. One repair pass fixes known issue codes
(unreferenced input, output not produced, undeclared output, risk level mismatch, unknown step
ref). Anything left is returned as issues, and the draft is still written to
`<runDir>/capability.draft.json`.

**Extend mode** re-runs the loop with different inputs to probe for exceptional outcomes; the
first `declare_outcome` ends the run. The new outcome is merged into the existing capability. Its
`afterSteps` map onto the matching existing step, by action type and canonical target
description, falling back to the same index. Steps are otherwise unchanged: the version's minor
number is bumped, the status is reset to `draft` (an approval never carries over to the new
version), and provenance notes record the merge.

## Safety

`guard.checkAction` runs before every surface action, including the entry navigation, interstitial
dismissal, and dialog dismissal; `navigate` also runs `guard.checkUrl`. The action passed to the
guard has its value masked. A `deny` is not executed; the model is told why, and a `policy` event
is logged. Three consecutive denies route the run to `stuck`.

A `flag_irreversible` decision depends on `policy.risk.discoveryMode`:

- `block` refuses the action outright.
- `escalate` raises a `risky_action_confirmation` intervention (screenshot plus intended action).
  It proceeds with `allowIrreversible` only if the human approves, marking the step
  `risk: 'irreversible'` and `onFailure: 'escalate'`. A decline aborts the run. With no escalation
  handler configured, `escalate` mode behaves like `block`.

The model references credentials by environment variable name from an allowlist and never sees
their values; values are resolved only at the moment of the act call. Sensitive input values are
shown to the model as `<sensitive>`. A scrubber replaces every secret and sensitive value with a
placeholder everywhere the model or the evidence log can see it. That covers observation text,
element values, `events.jsonl`, `transcript.jsonl`, and the capability itself. Screenshots are
images, so the scrubber cannot reach them; instead the surface masks them, and the observed text,
by the policy's `redaction.screen` rules: every form field, the value next to each listed label,
text matching a redaction pattern or a run value, and named selectors
([screen-masking.md](screen-masking.md)). Anything no rule names, such as personal data in free
text or inside an image, is visible to the model. A final leak check
fails closed before the run finishes. Every outbound request's text blocks are scrubbed at one
choke point in `discover.ts`, so a raw surface error message echoed back to the model cannot carry
a secret through unscrubbed. A sensitive value extracted as a number is scrubbed too: scrubbing
also runs over numeric leaves in outputs and results, not just strings. A literal value typed into
a password-like target is refused outright.

## Limits and stuck detection

`resolveLimits` (`packages/core/src/agent/limits.ts`) clamps each of `maxSteps`, `maxLlmCalls` and
`maxDurationMs` to a finite positive integer. A caller value that is not (`Infinity`, `NaN`, zero,
negative, or not a number) falls back to `policy.limits`'s value instead of silently disabling the
limit. `StuckRepeatDetector` tracks the same action (tool, target, `expect`) repeated across
consecutive turns. Three repeats in a row with the expectation still unmet routes the run to
`stuck`, instead of letting the loop spin indefinitely.

## Evidence

Evidence for one turn includes an `observation` event (with a screenshot path) and a `decision`
event per model call (reasoning and chosen action, scrubbed). It also includes `policy`, `action`,
`action_result`, `checkpoint`, `escalation`, `outcome`, `recovery` and `error` events.
`<runDir>/transcript.jsonl` holds every
model request and response as text, with images replaced by their screenshot path, scrubbed and
policy-redacted before write. `result.json` is written once via `logger.finish(result)`, carrying
status, capability id/version, step and call counts, and token usage (persisted as `llmUsage`,
because the shared redactor blanks any key containing "token").

## Escalation

A `stuck` outcome, when a handler is configured, raises an `EscalationHandler` request (reason
code `stuck`, screenshot, URL, goal, recent history). An `abort` resolution ends the run as
`aborted`. Otherwise, the loop resumes on the same surface, and the model is told what the human
did (notes and action count), marking `recordedBy: 'mixed'`. With no handler, the run ends as `stuck`.

## Design decisions

**Single-turn model calls, not a growing conversation.** Each model call is one fresh user
message. It carries the goal, inputs, the last action's result, a short history of accepted
steps, and the current observation (screenshot, compact element list, text digest). History is
what the model needs; old screenshots are not. This bounds cost per turn, avoids replaying
thinking blocks, and keeps the system prompt and tool list a stable cacheable prefix. It also keeps
the transcript one request and one response per turn, easy to audit. The cost is that the model loses
its own prior reasoning text; the recorded `why` of each accepted step covers most of that.

**The recorder is inline, not a post-processor over the transcript.** A step's descriptor comes
from the observation the model acted on. That works because the surface already synthesizes a
ranked locator chain for every element. The model chooses what to act on; the recorder decides how
it is identified.

**A recorded locator found the element on its own.** The surface's chain for an element is a
set of guesses. Before a target is recorded (`prepareTarget` in `tool-handlers.ts`), each locator
of its chain is bound with the run's inputs and resolved alone, in one round with no waiting. One
that misses, is ambiguous or finds another element is left out. The first recorded locator is
therefore one that found the element, a freshly recorded capability replays at depth zero, and
fallback depth at replay means the app changed. A target that belongs to a record named by a run
input must keep at least one locator, or it is refused or escalated
([browser-agent.md](browser-agent.md)). Any other target keeps its chain whole when no locator
can be checked.

**Postcondition inference from `expect`.** After acting, the recorder waits for
`text_visible(expect)` over the whole page for 5 seconds. If it holds, the recorder then probes
each known frame to scope the condition to the most specific frame containing the text. A
verified condition becomes the step's `postcondition`. An unverified one is dropped (and the
model is told), so a guess never becomes a checkpoint that fails every replay.

**Vacuous expectations are not checkpoints.** Before acting, the recorder checks whether the
`expect` text is already visible (whole page first, then per frame only if it is). If the
checkpoint would be scoped to a frame where the text was already visible, the expectation proves
nothing about the action. It is not recorded, the `checkpoint` event carries `vacuous: true`, and
the model is told to pick text that only appears because of the action. For the history and the
stuck-repeat detector it counts as not met, because it is no evidence the action worked (the
stuck reason says the expectation was already visible, not that it was unmet). `discover
--read-only` sets `DiscoverOptions.readOnly`, and the recorder writes `readOnly: true`. See
`docs/design/optimize.md` for why, and for the optimizer that removes the ones already in old
artifacts.

**Input-bound URL checkpoints.** The loop hands every fresh observation's URLs to the recorder
(`noteLocation`). If the step recorded since the previous observation changed the URL of the frame
it acted in (else the top document), and that URL now contains an input's run value as a whole
token, the recorder adds a `url_matches` check to the step's postcondition, merged with any text
check in one flat `all`. The URL goes through `canonicalizeUrl`, the origin (or `{baseUrl}`) is
dropped, and each part holding a placeholder becomes one pattern ending in `(?![A-Za-z0-9])`: each
path segment holding a placeholder together with the one literal segment before it
(`/members/{input.memberId}(?![A-Za-z0-9])` out of `/branch/004/members/12345`, so a branch or
session prefix stays unpinned), each query parameter as
`[?&]memberId={input.memberId}(?![A-Za-z0-9])`, and the fragment. A sub-frame check carries the
step's frame path. `done` adds the same check to `success`, scoped to the success text's frame, else
the top document. Replay binds the value regex-escaped, as an alternation of its raw,
percent-encoded and form-encoded (`+` for a space) forms, so the check passes only on the record for
this run's input: a fallback locator that opens the first result
row fails the step instead of succeeding on another member. `validateCapability` warns
(`unverified_input_binding`) when input-driven steps have no such checkpoint. A checkpoint is not
the only way to tie a result to its input: when every `extract` step reads through a chain in
which every locator is bound to an input and none is positional (a price found only below the
exact product name, inside that product's container), the value read cannot be another record's,
and the warning is not raised. It is strict. One locator that is not bound to an input (a bbox, a
static label anchor, a structural selector) keeps the warning, and so does a capability that
extracts nothing. The recorder does not
bind business-outcome detectors the same way, so it also warns (`unbound_outcome_detector`) when a
detector binds no input yet is checked after a step that submits form state typed from one: an
emptied form (a lost session) shows the same "No records found" page, and replay checks outcomes
before the step's own postcondition, so the run would report the outcome for an input it never
searched.

**Tool schemas are flat.** `type` and `select` take `source: 'input' | 'secret' | 'literal'` and a
`value` string, rather than a nested union. Strict tool schemas handle flat shapes more reliably.
Every property is required; "none" is represented as an empty string.

**Model default.** `claude-opus-5`, overridable via `ANTHROPIC_MODEL`. Adaptive thinking,
`tool_choice: auto` with parallel tool use disabled, server-side refusal fallback enabled.

## Known limits

- Screenshots are sent at captured size, with no in-process downscaling; one over about 3.75MB base64
  is omitted with a note to the model.
- Human actions taken during an escalation are logged and mark the capability `mixed`, but are not
  converted into steps.
- Postconditions are inferred from `expect` as `text_visible`, plus a `url_matches` check only
  when the landing URL carries an input value. An input value that the URL percent-encodes
  (spaces, quotes) is never found there, so it gets no URL check. A `press` step has no target
  frame, so only the top document's URL is checked for it.

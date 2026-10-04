# Replay engine

`replayCapability(opts): Promise<ReplayResult>` (`packages/core/src/replay/**`, internal contracts in
`packages/core/src/replay/types.ts`) executes a validated capability artifact against a `Surface`. No LLM sits anywhere on
the path: an agent calls a capability with typed inputs and gets back one of four result kinds.

## Runtime conditions

Every condition is detected deterministically, handled deliberately, and ends in exactly one of the four
result kinds. Recoverable is never a result kind: it is a `RecoveryRule` that fires mid-run, is logged as a
`recovery` event, and listed in `result.recoveries`.

| Condition | Detection | Response | Result |
|---|---|---|---|
| record not found (e.g. member 99999) | `businessOutcomes[].detector` evaluated after each step, before any failure is classified | run the outcome's extracts, log `outcome` | `business_outcome` `member_not_found` |
| permission denial (member 90001, HTTP 403) | same, detector on "Access Denied" | run the outcome's extracts, if any | `business_outcome` `member_access_denied` (shipped artifact, no data), or `access_denied` with `data.message` (hand-written example) |
| known interstitial (maintenance notice) | `recoveryRules[].trigger` checked before every step's precondition, and again when a postcondition fails | run the rule's actions (bounded by `maxAttempts` per run), re-check | continues; `recoveries: ['dismiss_maintenance_notice']` |
| slow load | `waitFor` with the step timeout; precondition gets 25% of it | wait, do not proceed blindly | continues, or `hard_failure` `timeout`/`checkpoint_failed` |
| validation error / unexpected page state | postcondition not met within timeout | classify, capture evidence | `hard_failure` `checkpoint_failed` with a page-text excerpt as `observed` |
| unexpected native dialog | `check({kind:'dialog_open'})` at classification, checked first because reading a page with a pending dialog can hang a real browser | escalate if a handler is configured, else fail | `escalated` or `hard_failure` `unexpected_dialog` |
| session timeout | page text matches a session-expired signal | escalate (human re-authenticates on the same session) or fail | `escalated` (`resumed_success`/`resumed_failed`/`abandoned`) or `hard_failure` `session_expired` |
| outright app error (HTTP 500, `ORA-`) | page text matches an app-error signal | on a run asserted read-only: wait, restart the steps, at most `maxAppErrorRetries` times ("Retrying a transient app error" below). Otherwise, or when the retries run out: fail with evidence | continues, with `retry_app_error` in `recoveries`, or `hard_failure` `app_error` |
| control missing | `resolve` returns `found:false` | fail with every tried strategy in `observed` | `hard_failure` `element_not_found` |
| control found only by position, after an ambiguity or for a read | `resolve` returns a positional winner that `positionalFallbackRefusal` refuses (see "Positional fallbacks") | do not act, do not read; fail saying how many candidates matched, or that a positional fallback was not used for a read | `hard_failure` `element_not_found` |
| navigation failed | surface `act` returns `navigation_failed` | fail | `hard_failure` `navigation_failed` |
| overall budget exceeded | `maxDurationMs` checked before every step; step timeouts are capped to the remaining budget | stop | `hard_failure` `timeout` with the stepId |
| bad invocation | inputs checked against `capability.inputs` (required, type coercible, `pattern`) before touching the surface | reject, never echo a sensitive value | `hard_failure` `input_validation` naming the input |
| broken artifact | `validateCapability` fails | reject before touching the surface | `hard_failure` `internal`, issues in `observed` |
| policy | `deprecated` capability, a run asserted read-only on a capability with anything irreversible, or draft capability with an irreversible step (status, read-only and approval gates, before any surface call); guard `deny`; guard `flag_irreversible` on an unapproved capability | refuse | `hard_failure` `policy_violation` |

Declared outputs must all be present on `success`, typed per `OutputSpec` (currency `"$1,234.56"` ->
`1234.56`); a missing one is `checkpoint_failed`. `locatorReport` has one entry per resolved target (step
and recovery targets), with `fallbackDepth = strategyIndex`; `summarizeLocatorDrift` turns it into the drift
signal. Every failure result carries `stepId`, `stepName`, `expected`, `observed`, `message` and evidence
paths that exist in the run directory. Tenant overrides (step patches, extra steps, entry URL) are applied
before execution and logged; the patched capability is re-validated.

## Human in the loop, replay side

A failure escalates when `step.onFailure === 'escalate'`, or when its classified code is in `escalateOn`
(default `unexpected_dialog`, `session_expired`); both require an `escalate` handler, otherwise it is a
`hard_failure`. The `EscalationRequest` carries the capability/step identity, the reason, a live screenshot,
current URL and scrubbed context (expected vs. observed). While `await escalate(req)` is pending, replay
makes zero surface calls: control belongs to the human. At most `maxEscalations` (default 3) per run; beyond
that a failure is a `hard_failure`. `policy_violation`, `input_validation` and `internal` never escalate. A
human cannot take over to route around the allowlist or approval gate. See "Escalation and the escalated
result" below for how resume works.

## Safety and evidence

No bound secret or sensitive input value reaches `events.jsonl`, `result.json`, or `dom/*.html`.
Irreversible steps run only when the approval gate passed, passed to the surface with `allowIrreversible:
true` plus a `policy` event. Recovery actions are policy-checked too; one the guard flags as irreversible or
denies is skipped and logged, never executed. `logger.finish(result)` is always called exactly once,
including on internal errors.

## Architecture

`replay.ts` is the orchestrator (validate -> overrides -> inputs -> approval gate -> step loop -> success
check -> escalation loop -> finish); `steps.ts` runs one step. `classify.ts`, `escalate.ts`, `extract.ts`,
`overrides.ts`, `validate-inputs.ts`, `bind.ts`, `safe-logger.ts` and `describe.ts` each own the piece their
name says. `no-llm.test.ts` is an import guard: nothing here imports `@anthropic-ai/sdk` or `packages/core/src/agent`.

`RunState` (types.ts) is created once by `replay.ts` after validation and passed to every `runStep`. It
holds the effective (overridden) capability, validated inputs, the scrubbing logger, the clock, the automation
deadline, and the accumulators that become `ReplayBase`. `runStep` returns a `StepOutcome` (`ok` |
`business_outcome` | `failure`); `replay.ts` alone decides escalate vs. `hard_failure`, and alone builds the
final `ReplayResult`.

### One step (steps.ts)

A deadline check opens every step (`maxDurationMs` -> `timeout`), then binding (secrets read and registered
with the scrubber before anything is logged) and the unbound `action` event. A recovery check runs next: any
rule whose trigger holds and whose per-run attempts are under `maxAttempts` fires. It is policy-checked,
resolved and acted the same way a step is, logged as `recovery`, and repeated until none fires. The
precondition follows (`waitFor` at 25% of the step timeout; false -> `precondition_failed`).

If the caller passed `ReplayOptions.beforeStep`, it is called next, once per step attempt, before
the policy gate and the action. It is purely observational: it gets a frozen copy of the step and a
`check(condition)` that binds placeholders like the step's own conditions and evaluates once (logged
as a `checkpoint` event with `phase: 'observe'`). It has no way to act, a throw is logged and
ignored, and a hook that does not settle within 10 s is logged as hung and the step proceeds.

Every result carries `capabilityDigest`, the content digest of the replayed capability
(`schema/digest.ts`: sha256 over canonical JSON without `status`, `version`, `provenance`), so
`cu approve` can tell which content a replay actually ran. The optimizer uses the `beforeStep`
hook above to find postconditions that already hold before their step
(`docs/design/optimize.md`).

Policy runs next: `checkAction` on the masked bound action, with target name/text built from the recorded
snapshot, role/text locators, and the descriptor's own `description`. This catches a css-only target whose
only irreversible signal is its description, and the pattern applies even to a step mislabelled `read`,
since `riskOverride` can only raise risk. Two outcomes follow:

- `deny`, or an unapproved `flag_irreversible`, becomes `policy_violation`.
- An approved irreversible step acts with `allowIrreversible: true`.

The target then resolves (not found -> `element_not_found`). A found target passes the positional-fallback
rule below before anything else happens. Then it is logged (`locator_resolved`, a `locatorReport` entry) and
acted on by `{ref}`. `extract` parses and coerces to the `OutputSpec` type, `wait` runs `waitFor` directly, and
act errors keep the surface's code.

Finally it waits for `any[postcondition, eligible detectors...]` with the remaining step time, so a 403 page
does not cost a full timeout. It checks business outcomes first, then the postcondition. A failed
postcondition runs the recovery check once and re-waits if a rule fired. On any other failure it checks
outcomes again, then captures screenshot/DOM evidence and classifies. Business-outcome extracts that fail
(target missing, a refused positional fallback, parse error) are logged as `error` events, with the key
omitted from `data` and recorded in the result's `missing: string[]` (contracts.md section 6) instead. The
outcome is still returned. The outcome kind ("access denied") is the answer the caller needs; a decorative
message that could not be read should not conflate it with a hard failure. `data` and `RunState.outputs` are
built with `Object.create(null)`, so a declared input or output named `__proto__` behaves like any other key.
Outcome eligibility: `afterSteps` omitted, or it contains the current or last-completed step id (a failure
during step N is observed on the page step N-1 produced).

### Positional fallbacks

Replay never settles an ambiguity by position, and never reads by position when the chain has a named way
to find the value.

A surface resolves a chain by "first unique match wins". A locator that matches several elements is a miss
like any other, so the chain used to fall through to a structural css or a bbox, and replay acted on, or
read, whatever sat at that position. On a page that lists several records, that is another record's value
returned as `success`.

A found `Resolution` now carries `tried`: the locators that missed before the winner, each marked
`ambiguous` with its match count when the miss was an ambiguity. After every `resolve`, replay calls
`positionalFallbackRefusal` (`packages/core/src/surface/positional-fallback.ts`). The winner is refused when
it is positional (`isPositional`: a bbox, a structural css) and either:

- **(a)** an earlier locator that names the element matched several candidates. This holds for every
  action type. Several matches for a `relative` locator's anchor, several candidates in its container and
  a geometric tie all count.
- **(b)** the action is an `extract` and the chain holds any locator that names the value. None of them
  found it, so nothing ties the element at that position to the recorded value.

Positional-ness is judged on the target as recorded, before input binding. A css bound to an input
(`tr[onclick*="/members/{input.memberId}"]`) names its element; bound, it would end in a number and read as
a position.

What is not refused:

- A naming winner, at any depth. Drift from `label` to `relative`, or to an identity css
  (`input[name="memberId"]`), still self-heals and is still reported as drift.
- A click, type or select whose naming locators simply miss (no ambiguity) and whose positional fallback
  matches. The action still has its checkpoint after it. A read has nothing after it, which is why rule (b)
  covers reads only.
- A read through a chain of positional locators only. There is nothing to compare a position against.
  `cu validate` warns about it (`positional_only_target`), and `cu approve` refuses it unless `--force`.
- An ambiguous positional locator followed by another positional winner.

A refusal is a typed step failure, `element_not_found`. `expected`, `observed` and `message` say that N
candidates matched, or that a positional fallback was not used for a read (contracts.md section 6). No
`locator_resolved` event and no `locatorReport` entry are written for it. It classifies and escalates like
any other `element_not_found`.

The same rule runs wherever replay resolves a target:

- **A business outcome's extract** (rules a and b). A refused extract is logged as an `error` event and its
  key goes to `missing`, like any other failed outcome extract. The outcome is still returned.
- **A recovery action** (rule a). A refused resolution means the action is not performed. The `recovery`
  event says `ok: false`, and an `error` event carries the refusal.
- **Element conditions** (rule a): `element_visible` and `element_absent` in preconditions, postconditions,
  wait actions, detectors, triggers and the success condition. `evaluateCondition` applies it inside the
  surface's `check`. Replay passes the condition as recorded in `CheckOptions.recorded`. A refusal never
  makes a condition true: `element_visible` is false on it, and `element_absent` and `not element_visible`
  are false too.

Two paths are outside the rule. A surface's own `act` or `readText` called with a descriptor resolves
inside the surface; replay never calls them that way, but the scripted `relogin` operator does for the
sign-in steps. And the Playwright resolver judges a transient ambiguity like a lasting one: a page that
shows a label twice for a moment fails typed rather than waiting it out.

`tests/e2e/positional-fallback.redteam.test.ts` reproduces both silent cases on a fixture whose joint
members' pages list a second account holder. Before the rule, a "View statement" click opened the other
holder's statement, and a savings read returned the other holder's balance, both as `success`.
`packages/core/src/replay/positional-fallback.redteam.test.ts` covers each branch on the fake surface.


## Record identity on reads

A positional fallback is not the only way to read another record's value. A locator that names the
value can match exactly one element, and that element can belong to another record: a page that
lists two records where only the other one has a "Savings Balance" row, or a search page whose
detail panel shows the second result. Nothing is ambiguous, so the rules above do not apply.

An `extract` step may carry `identity: { input, within }` (contracts.md section 2). After the target
resolves, and before `readText`, replay reads the text of the value's record container
(`Surface.readRecordText`) and checks that the bound value of `input` is a whole token of it. The
match is case-sensitive, so "Smith" is not found in "Al Smithers". A miss ends the step as
`hard_failure` `checkpoint_failed`: the value is not returned and no output is set. A surface that
refuses the read fails the step with its own code. A surface without the method skips the check,
and the `action_result` event says `identity: "skipped"`; a pass says `"verified"`.

The check runs on the real text and the real input value and keeps neither. The failure names the
input ("does not show input memberId") and never its value. A step without the field behaves as
before, so a capability recorded earlier replays unchanged.

### Classification (classify.ts)

Order: `check({kind:'dialog_open'})` -> `unexpected_dialog`; page text (case-insensitive substring of
`observe()`'s `textDigest`) matching a session-expired signal -> `session_expired`; matching an app-error
signal -> `app_error`; else the original code. Codes in `NON_PAGE_CODES` are never rewritten; `originalCode`
records a rewrite, and `textExcerpt` feeds `observed`.

### Escalation and the escalated result

`replay.ts` builds the request, logs `escalation {phase:'raised'}`, and awaits the handler with no surface
calls in between, adding the wait time to the automation deadline. On resolution it logs `escalation
{phase:'resolved', ...}` plus one `human_action` event per captured action, then branches on the resolution:

- `abort` -> `escalated {resolution:'abandoned'}`.
- `current_step` -> re-runs the whole step, meaning "the human restored the state, do this step again". For
  an irreversible step this would repeat the side effect, so the operator console surfaces the failing phase
  to make that choice visible. The exception is a lost session, next.
- `current_step` when the failure being resolved is `session_expired` and the capability has sign-in steps
  with a step after them -> continues the run at the first step after the sign-in, not at the failing step
  (below). The engine picks that resume point itself; the resolution does not have to name it.
- `next_step` -> waits for the step's postcondition. If it holds, the run continues; otherwise replay treats
  it as `checkpoint_failed`, which may escalate again up to the cap.
- `current_step` with `resumeAtStepId` -> continues the run at that step instead of the failing one (below).

### Resuming at another step (rewind.ts)

`current_step` assumes the page-local effects of the steps before the failing one survived the escalation.
After a lost session they did not: the member id s06 typed went with the expired page, and re-running only
the search click searches for nothing. Seeded chaos found exactly that (`docs/design/mock-app.md`, "What chaos
found"). So a resolution may name the step to resume at, `resumeAtStepId` (with `current_step` only; the
broker and Relay's API reject it with `next_step`). The scripted `relogin` operator always names the first
step after the sign-in.

A human cannot name one: the Relay console offers "retry" and "I completed this step", and sends a plain
`current_step`. That left the same defect on the human path. A person who signed in again and chose retry
after an expiry on the search step got the search re-run on the emptied form, and the run reported
`member_not_found` for a member who exists. So the rule is the engine's, not the operator's: **when the
failure being resolved was classified `session_expired`, the hand-back is `current_step`, and the resolution
names no resume point, replay resumes at the first step after the sign-in steps**
(`stepAfterSignIn` in `rewind.ts`, from the capability's `auth` block or the sign-in `schema/auth.ts`
derives). It goes through the same check and the same reset as a named resume point, with the recovery-rule
budgets reset because the session is new. The `resume_at` event carries `defaulted: true`, so the evidence
shows the engine chose the step. `next_step` and `abort` mean what they did. Two cases keep the old meaning
of `current_step`, run the failing step again:

- a failure that is not a lost session;
- a capability with no sign-in steps (no `auth` block and none derivable), or with nothing after them. The
  engine then has no point to resume at. A session expiry on such a capability still re-runs only the failing
  step, so the defect above remains for it; `cu validate`'s `unbound_outcome_detector` warning names the
  detector that would misreport.

So that the console can say what "retry" will do, the escalation request's `context` carries
`retryResume: { stepId, stepName, repeats?, refused?, blockedBy?, retryRuns? }` whenever this default
applies. It is worked out when the escalation is raised; nothing it depends on changes while a human holds
control. `stepId` is the step the run would resume at, and `repeats` lists the steps between it and the
failing step that already completed and are not declared `read`: they will run a second time. When replay
would refuse that resume point (next list), `refused` is the reason, `blockedBy` the step in the way, and
`retryRuns` what a retry does instead: `failing_step` or `success_check` (below), or absent when the retry is
refused outright.

`next_step` is not covered by any of this, and it can still produce the wrong answer. It takes the human
at their word: replay checks the failing step's postcondition and moves on, and a step with no
postcondition passes. With the shipped capability and `{"expireSession": true}` the expiry is found at s06
(type the member id, no postcondition). A human who only signs in again and hands back "I completed this
step" gets the search run on the empty form and `member_not_found` for a member who exists. This was run
against the mock app, not inferred. The console now puts a caution under that choice after a lost session;
nothing in the engine prevents it.

The safety rule lives in the engine, not in whoever handed back, because only the engine knows what this run
has done. A resume point is refused when:

- it is not a step of the capability as the run executes it (base steps plus the applied tenant override's
  extra steps): `unknown_step`;
- a step at or after it already had its irreversible action dispatched in this run, or was handed back
  `next_step` while counting as irreversible: `would_repeat_irreversible`. "Dispatched", not "completed": an
  irreversible click whose postcondition then failed may still have happened on the server. A step counts as
  irreversible by its declared `risk` or by the policy guard flagging its bound action. Automation asks the
  guard at act time. For a step a human completed (`next_step`) it never went through the gate, so replay
  makes the same check itself (`countsAsIrreversible` in `steps.ts`): before handing control over, on the page
  as automation left it, and again after the hand-back. A step either check flags is recorded as carried out,
  with a `policy {gate: 'next_step', decision: 'flag_irreversible'}` event when only the guard flags it;
- it lies after the failing step and an irreversible step lies in between: `would_skip_irreversible`. A
  forward resume point is otherwise allowed; it is how a re-login that re-ran the whole sign-in continues after
  it when the expiry hit a step in the middle of the sign-in.

A refused resume point that a resolution named never falls back to `current_step`. Replay logs `escalation
{phase:'resume_at_refused', to, reason, blockingStepId}` and escalates the same failure again with reason
`policy_block` and a message naming the refusal, so the human (or scripted operator) is asked again.

The engine's own default applies only where it is safe. When it would be refused (an irreversible step
between the first step after the sign-in and the failing one already ran), the hand-back was a plain
`current_step` and gets what that meant before the default existed: the failing step alone runs again, or
at the success check the success condition is checked again. There is no re-ask. The `resume_at_refused`
event then also carries `defaulted: true` and `rerun: 'failing_step'` (or `'success_check'`). This is what
makes a lost session recoverable after an irreversible step: a human who signs in again and brings the app
back to the screen the failing step expects gets that step re-run, an extract included (`next_step` cannot
do that for an extract: it checks a postcondition the extract does not have and ends `checkpoint_failed`).
What it cannot do is rebuild a form the lost session emptied; the console says so up front. The one case
still refused is a failing step that itself already had its irreversible action dispatched (or was
completed by hand): it may have gone through, so it is never sent again. That refusal is re-asked with
`policy_block`, and the message says what is left: if the action went through and the page is where the next
step expects it, hand back "next step"; otherwise abort. Asking for the same retry again is refused again,
until `maxEscalations` ends the run. Before these rules a plain `current_step` re-ran the failing step
whatever it was, a dispatched irreversible one included; after a lost session it no longer does. No new `FailureCode`: the page's failure
(`session_expired`) is still what went wrong, and a run that ends there (aborted, or out of escalations) is a
`hard_failure` with that code and the refusal in its message. An accepted resume point logs `escalation
{phase:'resume_at', to, clearedOutputs?}`: outputs extracted at or after it are dropped (the re-run reads them
again; a run that never gets that far reports them missing rather than returning a value read before the
session was lost), and the step before it becomes the last completed one for outcome eligibility.
`stepsExecuted`, the locator report and the `recoveries` list are not rewound: they record what the run did, and
a re-run step appears in them twice. A resume point comes from a resolution, and every resolution costs one of
`maxEscalations`, or from an app-error retry (next section), and every retry costs one of
`maxAppErrorRetries`. So a rewind loop ends in a hard failure.

Recovery-rule budgets (`maxAttempts`, counted per run) are reset on an accepted resume point only when the
run continues in a new session: the failure being resolved was `session_expired`, or an app-error retry
restarts before the end of the sign-in and so signs in again (the event then carries
`recoveryBudgetsReset: true`). A re-login starts a new session, and a new session shows its once-per-session
interstitials again; without the reset, the third session's maintenance notice found the budget spent and
blocked the search (chaos seed 7). A refused resume point, a `next_step`, a `current_step` that re-runs the
failing step, and a resume without a new session reset nothing, so a rule that keeps firing in one session
still stops at `maxAttempts`. The bound: a rule fires at most
`maxAttempts × (1 + maxEscalations + maxAppErrorRetries)` times in a run.

### Retrying a transient app error (replay.ts `retryAppError`, rewind.ts `appErrorRetryIndex`)

An HTTP 500 or an "Application Error" page is often gone on the next request. Replay retries it, within
limits, and only where it can know the retry is harmless.

**Why "retry the failing step" does not work.** A seeded chaos run on the shipped capability shows it
(`tests/e2e/replay-app-error-retry.test.ts`, seed 5). The search request answered with the error page. The
Search click (s07) passed its checkpoint on that page, and it was the next step (s08) that failed, ten
seconds later, with `element_not_found`, which classification rewrote to `app_error`. Running s08 again
finds the same error page. So does running s07 again: its Search button is gone. Recovery has to go back
further.

**The gate.** Replay retries only when the run is asserted read-only: the capability carries
`readOnly: true`, or the run was started with `ReplayOptions.readOnly` (`replay --read-only`,
`catalog invoke --read-only`). Without the assertion nothing changes, because replay cannot tell a harmless
repeated click from a repeated write. It is the boundary the optimizer uses (`docs/design/optimize.md`), and
as unverified. The run-level assertion is held to the validator's rule for the artifact's own field
(`read_only_irreversible`): on a capability with an irreversible `riskLevel`, step, tenant extra step or
recovery action the run is refused before any surface call, as `hard_failure policy_violation` with a
`policy {gate: 'read_only', decision: 'deny'}` event. The artifact is never modified and its digest is
unchanged.

Only an app error read from the page is retried: the page text matched an app-error signal
(`matchedSignal` on the classified failure). A surface also answers `app_error` for a control it found but
could not operate (disabled; on the desktop surface, one that cannot be activated). That is not a page that
may be gone on the next request, and it is not retried.

**The action.** When a failure is classified `app_error`, in the step loop or in the final success check,
and before any escalation is considered, replay waits and then restarts the steps at a step that can run
from any page:

- the first step after the sign-in, when that step is a `navigate` and the failure is not inside the
  sign-in. The session is kept and the business flow is rebuilt;
- otherwise step 0, the capability's entry step, when it is a `navigate`. The run starts over and signs in
  again;
- otherwise nothing: a capability that does not begin with a navigation (a desktop flow that starts on a
  window already open) cannot be restarted from an error page, and the retry is skipped with that reason.

Resuming at the first step after the sign-in whatever it is does not work. It was tried against the mock
app: the error page replaces the frame that holds the search form, so the member-id step (s06, the first
step after the shipped capability's sign-in) has nothing to type into, and both retries failed there. The
restart goes through `checkResumeAt` and `resetForResume` like any resume point: outputs extracted at or
after it are dropped and read again, and a restart that would run a step again whose irreversible action
was dispatched in this run (the policy guard can flag one at act time even in a read-only run) is not taken.

**The budget.** `maxAppErrorRetries` retries per run, default 2, counted apart from `maxEscalations`. The
CLI takes it from the policy's `limits.maxAppErrorRetries`; 0 turns the retry off. Retry n waits
n × `appErrorRetryBackoffMs` (default 1000 ms) on the run's clock, and a wait the run's time budget
(`maxDurationMs`) cannot cover is not taken. Both numbers are clamped to non-negative integers (a negative
value is 0, a fraction rounds down, NaN or infinity falls back to the default). When the retries are spent,
or one is not taken, the failure is
resolved as before: an `app_error` that is set to escalate still escalates, and otherwise the result is
`hard_failure app_error`.

**Reporting.** Each retry is a `recovery` event `{rule: 'retry_app_error', attempt, of, backoffMs,
restartAt}` and an entry `retry_app_error` in `result.recoveries`, so `replay --times N` counts it in
"recoveries fired" next to the declared recovery rules. It is the engine's own name, not a `RecoveryRule`; a
capability that declares a rule called `retry_app_error` would be counted together with it. A retry that was
possible in principle but not taken (budget spent, no navigation to restart from, an irreversible step in
the way, no time left) is a
`recovery` event with `skipped: true` and a reason, and no entry in `recoveries`.

**Assumptions and limits.**

- The restart assumes the capability can be run again from its restart step in the same browser session: an
  entry navigation that works from any page, and a sign-in that works while a session exists. The mock app's
  login page does. An app that redirects a signed-in user away from its login page would fail the restart.
  When the restarted run fails before it is back at the step the app error was seen at (a step not found, a
  checkpoint not met, a timeout) and that failure is not escalated, the result is the app error it was
  retrying, with its step and evidence, and the retry's own failure quoted in the message. That failure is not
  an app error read from the page, so it is not retried; another error page on the restarted run is, while
  the budget lasts. This rewrite stops applying once the run gets back to that step or a human resolves an
  escalation: from then on a failure is reported as what it is.
- Nothing probes for an error page after each step. The error is noticed when a step fails, which for a
  click that passes its checkpoint on the error page means the next step's full timeout (10 s by default).
  Each retry therefore costs that timeout plus the backoff before the run moves again.
- A restart from step 0 signs in again, so it uses the credentials again and starts a new session. The
  recovery-rule budgets are reset for that new session only when the engine knows the restart re-runs a
  sign-in (an `auth` block, or one it can derive). A capability whose sign-in it cannot see restarts with
  its budgets as they were.
- "Transient" is an assumption. A persistent error costs the timeouts and backoffs of every retry before
  the same `hard_failure app_error`.
- Optimizer trials do not retry: `runOptimize` passes a budget of 0, so a trial still means "this variant
  replays cleanly" (`docs/design/optimize.md`).

Once any escalation happened the final result kind is `escalated`, with `resolution` `resumed_success` or
`resumed_failed` depending on how the resumed run ended. The underlying result (outputs, outcome data, or a
hard failure's code/message) is logged in a final `outcome` event. It is also mapped onto the result's own
`outcome` field, so the calling agent gets its real answer back from `replayCapability()` directly, not only
from the evidence log.

Three invariants hold across all of the above. Business outcome is checked before hard failure everywhere a
failure can arise. Recoverable is never a result kind. Exactly one `finish()` runs per run, with a thrown
error anywhere becoming `hard_failure internal`.

## Secrets and redaction

Logging uses the unbound step (templates, `{kind:'secret', env}`), plus `valueRedacted: true` when a value
came from a secret or a sensitive input. `createScrubber()` also holds every bound secret and sensitive
value in memory. `createSafeLogger` scrubs event data, DOM snapshots and the final result before the
`RunLogger`'s own key/pattern redaction runs. This covers leaks not otherwise controlled: surface error
messages, a DOM snapshot of a non-password field holding a secret (a user id bound from `MOCK_USER`), and
page text excerpts.

Values shorter than 3 characters are not scrubbed, since that would destroy the log. The policy guard
receives the action with `value` masked; policy never needs it.

Screenshots cannot be scrubbed as text. The surface masks them before replay gets them, by the policy's
`redaction.screen` rules: every form field, the value next to each listed label, text matching a redaction
pattern or a run value, and named selectors ([screen-masking.md](screen-masking.md)). Anything no rule names,
such as personal data in free text or inside an image, is in the pixels, so evidence directories are
access-controlled like the app itself. Extracted output
values are not written into events (only `{output, parse, ok}`); they appear in `result.json`, which is the
caller's data. `PolicyGuardLike` (types.ts) is the structural subset of `createPolicyGuard(policy)` that
replay needs; `policy-guard-compat.test.ts` asserts the real guard is assignable to it and replays the
example capability under the default policy.

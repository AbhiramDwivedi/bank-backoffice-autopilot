# Design write-up

An LLM works out once how to do a task in a legacy back-office app, and the run is recorded as a typed capability. From then on the capability replays with no model in the loop, and hands the live session to a human when it cannot proceed safely.

The main target is a mock credit-union workstation built to be hard to automate: frames, table layouts, div buttons, no test IDs. It injects not-found, permission-denied, expired-session, app-error and slow-load conditions on demand or from a seed. The same runtime drives a Windows Forms app.

## 1. Architecture

One Node process: a domain package with ports, adapters that implement them, and thin apps that wire them together.

```
        apps/cu (CLI, composition root)               apps/relay (human console)
                   |                                           ^
   +---------------v-------------------------------------------+---------+
   | packages/core                                                       |
   |   agent (LLM loop + recorder) --> Capability --> replay (no LLM)    |
   |   policy guard on every act()       session broker (control token)  |
   |   evidence logger (redacts)         credentials (names, not values) |
   +------+---------------+----------------+----------------+------------+
          v               v                v                v
   adapter-playwright  adapter-desktop  adapter-anthropic  adapter-jev    adapter-credentials
   (Chromium)          (Windows UIA)    (LLM, risk judge)  (risk judge)   (file, helper)
```

- **Core** holds the domain and five ports: `Surface`, `LlmClient`, `RiskJudge`, `CredentialProvider`, `EscalationHandler`. It does no browser or network I/O.
- **Adapters** implement the ports. Lint stops them importing anything but core and the browser agent.
- **The browser agent** runs in the page. It names legacy controls and records what a human clicks during a handoff, never what they type.
- **Apps** compose: `cu` is the CLI, Relay the operator console, two mock apps the targets.

A static scan fails the build if replay, policy, session or schema code can reach the agent, a model adapter or a model key.

Three trade-offs shaped this:

- **Element identity over raw coordinates.** Coordinates give the recorder nothing durable to store. They survive only as the last-resort locator.
- **A mock app as the main target.** The interesting failures must be injectable on demand. A public site checks for tailoring (section 4).
- **One process, not services.** Infrastructure was not the problem. A worker pool would attach at the composition root.

Detail: `docs/design/architecture.md`, `docs/design/extending.md`.

## 2. Artifact schema

The artifact is a capability, not a step list. Its top level is the contract an agent calls; the steps are the implementation.

```ts
Capability {
  id, version, status: draft | approved | deprecated, riskLevel, readOnly?
  app: { vendor, product, tenant?, surface: web | desktop, entryUrl }
  inputs:  { name: { type, required, sensitive, pattern? } }
  outputs: { name: { type } }
  steps: [{ id, action, precondition?, postcondition?, risk, onFailure? }]
  success: { condition, description }
  businessOutcomes: [{ name, detector: Condition, returns, extract? }]
  recoveryRules:    [{ name, trigger: Condition, actions, maxAttempts }]
  overrides?: [{ tenant, stepPatches, extraSteps? }]
  auth?: { steps, signedIn: Condition }
  provenance: { discoveryRunId, recordedBy, model? }
}
TargetDescriptor { frame, locators: [{ strategy, confidence, source }] }
ReplayResult = success { outputs } | business_outcome { name, data }
             | hard_failure { code, stepId, expected, observed, evidence }
             | escalated { interventionId, resolution, outcome? }
```

- **A target is an ordered fallback chain:** role and name, label, text, position relative to an anchor, structural CSS, bounding box, native automation id. Accessibility trees carry most of these, so desktop apps fit too. A depth above zero is the drift signal.
- **Business outcomes are declared, with detectors.** "No such member" is a result with its own shape, checked before anything is called a failure.
- **Recovery rules are separate from steps**, so an intermittent notice does not change the step list.
- **Approval is tied to content.** An irreversible step runs unattended only in an `approved` capability, and `cu approve` needs a successful replay whose content digest matches the file.
- **`readOnly` is an assertion** that replaying changes nothing. Nothing verifies it; the validator rejects it on irreversible work. It gates optimizer trials and the app-error retry.
- **Inputs are templates**, escaped where they enter a regex or selector.
- **Validation is cross-field.** It rejects undeclared inputs, unextracted outputs, a wrong risk level and overrides that add irreversible work. It warns when no checkpoint ties the record to the input, a detector binds no input, or a read is positional only.

Detail: `docs/contracts.md`, `packages/core/schema/`.

## 3. Determinism & error handling

For each step, replay checks recovery triggers, waits for the precondition, asks the policy guard, resolves the target, acts, and waits for the postcondition and outcome detectors together. It uses no fixed sleeps.

| Condition | Result |
|---|---|
| Record not found, permission denied | `business_outcome` |
| Known interstitial | continues; listed in `recoveries` |
| App error, run asserted read-only | steps restart, twice by default |
| Session expired, unexpected dialog | `escalated` to a human |
| App error otherwise, or retries spent | `hard_failure` `app_error` |
| Control missing, checkpoint not met, slow load | `hard_failure` with expected, observed, screenshot, DOM |
| Bad input, broken artifact, off-policy action | `hard_failure`, before the app is touched |

Every failure names its step, what was expected and what was observed. Secrets never reach a result or a log.

**A wrong answer is worse than a failure.** A position finds the same spot whoever is in it, so a fallback chain can succeed on the wrong record. At record time, each locator must find the element alone or it is dropped, a role locator on an input is exact or not kept, and a target in the record an input names keeps no positional locator. At replay, position never settles an ambiguity and never answers a read the chain could name. Both give a typed failure instead of another member's balance. Four cases can still succeed silently (section 7).

**Recovery restarts; it does not retry in place.** The step that hits an error is often not the one that fails: a search returned an error page, its checkpoint passed, and the next step failed. On a run asserted read-only (`readOnly: true` or `replay --read-only`), replay waits after an app error read from the page, then restarts at a navigation: the first step after sign-in when it is one, else the entry step. `limits.maxAppErrorRetries` caps it; each retry is listed as `retry_app_error`. Without the assertion nothing retries: replay cannot tell a re-click from a repeated write. Asserting read-only on irreversible work is a `policy_violation`.

A lost session rewinds too: a plain retry after a fresh sign-in resumes at the first step after sign-in, because the form state went with the session. The engine refuses any rewind that would repeat or skip an irreversible step (section 5).

**What chaos found.** Chaos fires faults from a seed, so a failing series replays exactly. It found the lost-session defect the rewind fixes: replay re-ran only the search click on an emptied form and reported "member not found" for an existing member. Six runs at seed 42 (search failure 0.2, interstitial 0.5, session expiry 0.15, scripted re-login) gave 2 success, 1 `hard_failure` `app_error` and 3 escalated, 2 of which then hit `app_error`. With `--read-only`: 3 success, no hard failure, 3 escalated, 1 of which then hit `app_error`. The retry fired twice, in one run. Mean run time rose from 15.8 to 23.4 seconds. Retries consume random draws, so the faults differed. Neither series used a fallback locator.

Detail: `docs/design/replay.md`, `docs/design/browser-agent.md`, `evidence/followups/retry/`.

## 4. Heterogeneity & multi-tenant

**Surfaces.** The seam is the `Surface` port: observe, resolve, act, read, wait. Recorded flows use roles, names, labels, text and positions, which accessibility trees carry. Legacy web needed no new surface: targets carry a frame path, and controls are named from adjacent table cells. Desktop is a second implementation, over Windows UI Automation, with no new action, condition or result kind. Desktop reach ends at what the app's UI toolkit exposes to UI Automation. Standard Win32, Windows Forms and WPF expose good trees; custom-drawn, VB6-era and terminal-emulator apps may expose little, and there is no OCR fallback. A live discovery took 7 steps and 7 model calls; the capability replays in about 3 seconds.

**A check against tailoring.** The first discovery on a public demo storefront failed: the browser agent did not list a price in a plain `<div>`. After enumeration was generalised, the re-run worked, though its product link always fell back from a `role` locator that never matched. With record-time pruning, a later run replays at depth zero and validates with no warning.

**Tenants.** A capability is recorded against a vendor product, not a tenant. Reuse is a base capability plus per-tenant overrides, which may patch a target, insert steps or change the entry URL, but not add irreversible work. The second mock tenant differs in branding, one label, its frame shell and one field. Without an override it replays at depth two at that field; with it, at depth zero.

**Drift.** Every replay emits a locator report and a checkpoint trail. Across tenants that becomes a table of fallback depth and checkpoint failures per capability per tenant. A fallback carrying a step calls for an override; a failing checkpoint calls for a re-record.

Detail: `docs/design/surface.md`, `docs/design/desktop.md`, `docs/design/public-target.md`.

## 5. Escalation & handoff

**Detecting stuck.** Replay escalates on an expired session, an unexpected dialog, or a step marked `onFailure: escalate`. Discovery escalates when the model says it is stuck, repeats a failing action three times, or wants an irreversible action. Both call `escalate(request)` with the step, reason, expected versus observed, and a screenshot.

**Who is in control.** A control token moves through `automation`, `paused`, `human`, `resuming`. Only the holder may act; the check sits on `act()`. Taking control waits for any in-flight action. Every transition is logged. A lease bounds each state: a quiet human loses control, and a request nobody takes is aborted.

**The same session.** The human works in the window automation was driving: same page and cookies. Relay shows the queue, screenshots, the token timeline and captured actions.

**Handing back.** The human retries, continues from the next step, or aborts. Replay re-runs the step or re-checks its postcondition, and a failed check escalates again, up to a limit. After an expired session the retry choice reads "Start again after sign-in" and lists the steps it will repeat. If that would repeat an irreversible step, the console says up front that only the failing step runs again. Replay takes "I completed this step" at its word: a human who only signed in again and picks it can get "member not found" for an existing member. The console warns; the engine does not prevent it.

**What is mocked.** The operator must be at the machine, and Relay ships no authenticator, though it accepts one. A production console would stream the page over an authenticated channel.

Detail: `docs/design/handoff.md`, `docs/design/relay.md`.

## 6. Safety

**Allowlist.** A policy file declares allowed origins, paths and action types. The guard checks every action and every frame's URL before the app sees anything. Each run is narrowed to its own origin.

**Irreversible actions.** Patterns mark controls irreversible ("Submit", "Transfer"). Discovery needs a human's confirmation for one; replay runs one only in an approved capability. Patterns see only words, so a small-model risk judge asks whether a committing action really commits. Claude and Jev implement it; the default is Claude when its key is set, else Jev. It runs at record and audit time, never at replay, and only raises risk; by default an unavailable judge counts as irreversible. A raise is written into the artifact, where the approval gate enforces it. On a 27-case set written by the prompt's author, both judges caught 11 of 11 irreversible actions with no false positives, Jev only after a question was reworded.

**Sensitive data.** Artifacts hold credential names, never values. One scrubber, seeded with every credential and sensitive input, runs over everything that leaves a run. Screens are masked at the surface before anything reaches the model, the evidence or Relay. A masked value can still be extracted, for the caller only.

**Limits.** The approval gate plus a human is the real control for irreversible work. `readOnly` is the operator's word; a wrong one lets retries and optimizer trials repeat writes. Redaction is by value and named rule, not data-loss prevention: personal data in free text or images reaches the model provider. Prompt injection is contained, not prevented. A page's own requests are not observed.

Detail: `docs/design/policy.md`, `docs/design/risk-judge.md`, `docs/design/screen-masking.md`, `docs/design/security-review.md`.

## 7. Cuts

Three parts the brief allowed to be mocked or left as design are real, because each deepens a core requirement:

- The Windows desktop surface, with a live discovery and replays.
- Relay, with leases, heartbeats, request guards and a live screenshot. It is still local, with no sign-in.
- A second tenant, with overrides and drift depth.

Also built:

- Targets: a flexbox shop fixture and a public demo store (section 4).
- Stretch goals: the catalog with tool definitions and invoke, digest-bound approval, cross-tenant overrides, and `--times` stability with seeded chaos. Not built: code generation, assisted fallback, a reliability score.
- Safety: the risk judge (section 6), screen masking with a leak fuzzer, credential providers, and a red-team test per security finding.
- The read-only app-error retry (section 3), and an optimizer that drops only steps replay proves unneeded.

Other model providers, credential sources, consoles and surfaces are extension points with a port.

Four cases can still act on another record without failing. Two more are closed by a record identity check on reads: the read's container must show the input (`checkpoint_failed` if not).

- An action whose naming locators all miss falls back to a position. A control both renamed and repeated is clicked by position, guarded only by its checkpoint.
- A target recorded with positional locators only stays positional. `cu validate` warns about such a read.
- A target whose record shows the input nowhere near it (a search by e-mail whose result shows only the name) is acted on when the page shows one such record. Its read cannot be checked, and `cu validate` warns (`read_without_record_identity`).
- An input that is a whole word of another record's value in the same column: "Lee" recorded on "Ann Lee" opens "Lee Wong" when only he is listed.

Other limits: a capability that writes gets no automatic retry; the operator, not the runtime, names the vendor product; the risk judge does not run at replay.

Next, in order:

1. A second discovery source: a human demonstrates the flow and the model annotates the recording.
2. The cross-tenant drift table, feeding a confidence score that gates unattended replay.
3. An `approvedBy` field on tenant overrides, so an override can carry an irreversible step under its own review.
4. A bounded, policy-checked model recovery for one failed step, recorded as evidence.
5. A model-driven capability selector, limited to approved capabilities (`docs/design/capability-selection.md`).

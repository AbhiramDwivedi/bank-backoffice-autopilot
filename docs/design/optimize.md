# Capability optimization

Discovery records the path the model happened to take, verbatim. Failed actions are dropped, but a
successful wrong turn (click the wrong tab, then the right one) or a retry (type the password,
miss the expected text, type it again) stays in the capability forever, and every replay pays for
it. Nothing in discovery compares routes or asks whether a step was needed.

The optimizer is a deterministic, model-free search over an existing capability. Every change it
makes is verified by replaying the capability against the live app. It runs as a stage of
`discover` and as `cu optimize` on an existing artifact.

- `packages/core/src/optimize/`: the algorithm (`optimizeCapability`). It never creates a surface or
  a browser, and every replay goes through an injected
  `runTrial(request) => Promise<TrialOutcome>`. The no-LLM redteam test guards it like replay.
- `apps/cu/src/runtime/run-optimize.ts`: the real trial runner, built on `runReplay`.
- `apps/cu/src/commands/optimize.ts` (`cu optimize`), `discover-optimize.ts` (the `discover` stage),
  `discover-candidates.ts` (`discover --candidates`).

## The boundary: trials execute the capability

**A trial is a replay of the capability, or of a variant of it with steps removed, against the live
target app.** The optimizer can't optimize anything without running it, many times, in forms nobody
recorded.

For a lookup that is harmless. For anything that writes, it isn't, and the system can't tell the
difference:

- `riskLevel` doesn't separate a write from a read. Every click and every typed value is
  `reversible`, and a "Save" or "Update" button matches no irreversible pattern.
- An independent review built an "update mobile phone" capability: navigate, select the "Mobile"
  slot, type the number, click Save, no outputs. The first version of this optimizer removed the
  slot select and the typing, "verified" the result three times, and five of its six trial replays
  wrote to the wrong slot in the app.
- With no outputs, output equality compares `{}` with `{}`, which is always true. The capability
  had been reduced to "open a page".

So the rule is: **every rewrite is replay-verified, and the replay-backed passes run only on a
capability the operator has declared read-only. Models and heuristics may veto, never permit.**

- **The declaration.** `readOnly: true` on the capability means: replaying this capability, in
  whole or with steps removed, changes nothing in the target app. It is set in one of three ways:
  - `discover --read-only`: the operator asserts it about the goal, as they declare inputs and
    outputs. The recorder writes it.
  - `cu optimize --read-only`: asserts it for an artifact that lacks the field, and writes it into
    the optimized output.
  - by hand.

  `validateCapability` rejects `readOnly: true` on anything irreversible: an irreversible
  `riskLevel`, step, tenant-override extra step, or recovery action.
- **Without the declaration the optimizer rewrites nothing.** It is analysis-only: it reports what
  it would look at (repeats it would try collapsing, checkpoints it would probe, steps it would try
  removing) and says how to enable trials. That includes the collapse of an exact repeat, because a
  recorded retry is evidence that the first write may not have stuck (a late script clearing the
  field), so collapsing it without a replay to confirm it is not safe.
- **Vetoes.** Even with the declaration, the optimizer falls back to analysis-only, with the reason,
  when:
  - anything a trial can execute is declared irreversible, or the policy classifies it irreversible
    (the guard's `classifyRisk` over the recorded target texts and URL). That covers the base steps,
    the trialled tenant's override extra steps, and every recovery-rule action. It does not depend
    on the validator, which `cu optimize` runs without the policy's URL patterns;
  - the capability declares no outputs, so there is nothing to compare;
  - the caller vetoes a step through `vetoStep` (the composition root's hook for, for example, a
    step whose risk the risk judge raised).
- **What the system does not verify.** The declaration is the operator's assertion. Nothing checks
  that a "read-only" capability really changes nothing.

  A wrong declaration costs two things, both demonstrated by the review:
  - Trial replays, with steps removed, write to the live app, at most
    `1 + 2 + maxTrials + 2·verifyRuns` times per optimization (about 35 with the defaults).
  - The result can be a *verified draft with necessary steps removed*. The review's wrong-declaration
    case removed the slot-select step and still verified 3/3, because nothing the capability
    returns depended on which slot was written.

  The vetoes catch what the policy can see. They can't catch a "Save" the policy doesn't know about.
  What stands between such a draft and production is the draft/approval gate: the output is always
  a `draft`, its provenance note names every removed step and the read-only declaration it relied
  on, and `cu approve` needs a content-matched replay of that exact draft. That is why the
  declaration is explicit, opt-in, recorded in the artifact, and named in every provenance note.

## The shipped artifact as the test case

`artifacts/lookup-member-savings-balance.json` (v1.2.2) has two defects:

- **A duplicate step.** s03 and s04 are the same "Enter the operator password" `type`. A retry got
  recorded twice.
- **Vacuous checkpoints.** s02 and s04 check `text_visible "Password:"`, which is already on the
  login page before either step runs.

It is not declared read-only, and the file is not changed. `cu optimize` on it without the flag
reports exactly those findings and writes nothing. `cu validate` warns about the repeat.

With `--read-only` (it is a lookup), optimizing it against the mock app:

- removes s04 and drops both "Password:" checkpoints;
- keeps every other step and checkpoint;
- writes a draft that returns the same balance (`tests/e2e/optimize.test.ts`).

## The passes, under the declaration

**1. Collapse candidates.** Each run of consecutive redundant repeats folds into its first step,
which takes over the run's postcondition (`schema/step-equivalence.ts`). Two steps count as
redundant repeats only if all of these hold:

- both are idempotent field writes: a `type` with `clear: true` and no `pressEnter`, or a `select`
  on a real `<select>` (recorded snapshot tag);
- their actions are deep-equal;
- they have the same `risk`, `onFailure` and `timeoutMs`;
- their pre- and postconditions don't conflict.

A `select` on a custom dropdown is excluded: the Playwright adapter drives it as click-open plus
click-option, which is only as idempotent as two clicks. The first copy survives so that it runs
from the same page state the original first copy did, which is what lets the vacuity probe observe
its merged checkpoint. A collapse is a candidate, kept only if trials confirm it.

**2. Vacuity probe.** Replay the unmodified capability once as the baseline. Before each step acts,
check whether its postcondition (after the collapse) already holds. A postcondition that held
before its step could not detect a step that did nothing, so it is a drop candidate.

It is never dropped on a step a tenant override references: the probe observed one tenant (the
report names it), and for another tenant that checkpoint may be the only one that catches a failed
step. It is also kept when dropping it would add a validator warning, for example when it is the
only checkpoint bound to the input.

The probe is replay's observational per-step hook, `ReplayOptions.beforeStep`. It is called after
recoveries and the precondition, just before the policy gate and the action, and receives:

- a frozen copy of the step;
- a `check(condition)` that binds placeholders and evaluates once.

It cannot act. A throw is logged and ignored. A hook that doesn't settle within 10 seconds is
logged as hung and the step proceeds.

Dropping a vacuous checkpoint loses its detection value, which is nil. It usually loses no settling
either, because a postcondition that already holds makes replay's wait return at once. One case is
not covered: an AJAX re-render that removes and then restores the same text. That is why every
dropped checkpoint is re-probed on every verification run, and the drop is undone if it ever didn't
hold before its step.

**3. Replay-verified removal.** The search starts from the most aggressive rewrite level
(collapse + vacuity, then collapse alone) that reproduces the baseline in one trial. Then:

- Try removing steps one at a time. A removal is kept only if the trial is `success` and its
  outputs deep-equal the baseline's. Repeat to a fixpoint (a step rejected earlier is retried once
  something else is removed), bounded by `maxTrials`.
- Verify the result with `verifyRuns` (default 3) consecutive successful, output-equal replays.
- If verification fails, fall back to verifying the starting point. If that fails too, return the
  input unchanged. Nothing unverified is ever applied.

Some steps are never tried, and the report says why:

- steps a tenant override or a business outcome references;
- the last extract of each declared output;
- the last step that consumes each declared input (a lookup that stops looking the input up can
  still pass on one input set);
- steps whose removal fails validation or adds a validator warning.

**Why output equality, not just success.** A removal that still ends in `success` can still change
what the capability does. Without the "Accounts" tab click, the same locator reads a different
number. Equality with the baseline is the only signal a model-free search has. Inside `discover`,
the discovery's own extracted outputs must match the baseline too. If they don't, nothing is
rewritten (`baseline_mismatch`).

## Trial wiring

- **Drafts behind a forced gate.** Each trial replays a draft copy with the approval gate forced on
  (`requireApproved`), whatever the policy's `replayRequiresApproved` says. Anything the live
  policy flags irreversible fails the trial before it acts.
- **Versions that can't pass as evidence.** The copy's version is `<x.y.z>-optimize.<n>`, so a
  trial's `result.json` can never be taken as approval evidence for a real version.
- **Unattended.** No Relay console, and a scripted `abort` operator: any escalation fails the trial
  and never prompts a human.
- **No app-error retry.** Replay retries a transient app error on a read-only run
  (`docs/design/replay.md`, "Retrying a transient app error"), and every trial capability is
  read-only. Trials pass a retry budget of 0, so a trial keeps meaning "this variant replays
  cleanly": an app error fails it. A flaky target can therefore stop an optimization
  (`baseline_failed`), keep a removable step, or reject a candidate at verification. It cannot
  cause a wrong removal either way; with the retry on, a removal that itself provokes an app
  error would be replayed three times before it failed.
- **Isolated, polite, interruptible.**
  - One browser serves all trials, as with `cu replay --times`, but every trial gets a fresh
    context.
  - `--trial-delay-ms` paces the trials.
  - An `AbortSignal` (Ctrl-C) stops the optimizer between trials.
- **No values in the report.** The report holds output names, equality verdicts and run ids, never
  output or input values. Trial failure details are redacted with the policy's patterns and the
  run's secret and sensitive values before they are stored. The values are only in each trial's
  own redacted evidence.
- **Pass-through options.** `runOptimize` forwards an explicit allowlist of `runReplay` options
  to every trial (`replayPassThrough`): today only `credentials`. It is not a spread: the trial's
  capability, inputs, policy, runs directory, browser or surface, tenant, operator and approval gate
  are set by the runner alone, and any other key a caller passes is ignored (pinned by
  `optimize-report-leak.redteam.test.ts`). `discover` threads the same allowlist
  (`RunDiscoverDeps.trialReplay`).

## Approval and content

A replay matches an approval by content, not just by id and version.

- **The problem.** This feature mints different contents under one version: every
  `discover --candidates` run is `1.0.0`, and two `cu optimize` runs with different options both
  produce `x.y.(z+1)`. Matching by id and version alone would let a replay of one count as approval
  evidence for another.
- **The digest.** Replay stamps `capabilityDigest` on every result: sha256 over the canonical JSON
  of the capability without `status`, `version` and `provenance`, defined once in
  `schema/digest.ts`.
- **The check.** `cu approve` requires a digest match whenever the result carries one. A result
  without a digest is accepted, with a printed note, only while no result for that id and version
  carries a digest. Once a digest-bearing run exists for the version, evidence for this content
  must carry one too.
- **Canonicalization limit.** The digest does not Unicode-normalize strings: two contents that
  differ only in normalization form get different digests. That fails closed: approval is refused,
  never wrongly granted.

## Output

- The result is a `draft` with a provenance note listing what was collapsed, dropped and removed,
  the verification result, and the tenant observed. The note says it was produced under the read-only
  declaration.
- `cu optimize` bumps the patch version. Inside `discover` the capability is already a fresh draft,
  so the version is left alone.
- If nothing changed, or the run was analysis-only, aborted, or the baseline failed, the input comes
  back untouched and `cu optimize` writes no artifact.
- The report goes to `<run dir>/optimize.json` for `discover`, and to
  `<runs-dir>/optimize-<run id>/optimize.json` for `cu optimize`.
- The reason a run stopped short (analysis only, a baseline that did not replay or did not match
  the reference, an interruption) is the report's `stopDetail`. The optimizer does not log it:
  its `log` carries progress only. `cu optimize` and the `discover` stage print it once, from
  `summarizeOptimization`. Both used to print it twice, once from each.

## `discover`

The stage runs by default after a successful discovery, before the capability is written.

- **Without `--read-only`**, it prints one line: the goal was not declared read-only, so nothing
  was replayed or rewritten, plus how to enable it.
- **`--read-only`, but the run performed an irreversible action** (a confirmed risky click): the
  declaration is dropped, not the capability. It is written without `readOnly`, the operator is
  told plainly that the goal declared read-only performed an irreversible action so the flag was
  removed and no trials ran, and the exit code is the successful discovery's 0.
- **Nothing is lost on interrupt.** The as-discovered capability is in the run directory
  (`capability.json`) before the stage starts, and the stage says so. On any failure, interruption
  included, the un-optimized capability is what gets written. The first Ctrl-C stops the stage
  between trials and the normal write completes.
- **`--candidates <n>`** requires `--read-only` and costs n discoveries (n times the model spend).
  - Each candidate is written into its own run directory as `candidate.json` and is never deleted.
  - The winner is the verified candidate with the fewest steps, but only if every verified
    candidate's baseline outputs equal the winner's. Otherwise a shorter candidate that read the
    wrong field would win.
  - On any disagreement, no candidate is kept automatically: the disagreeing outputs are named and
    every candidate stays for a human to choose (exit 2).

## The record-time fix

The cheapest vacuous checkpoint is one never recorded. In `actAndRecord`
(`packages/core/src/agent/tool-handlers.ts`), the recorder checks whether the `expect` text is
already visible before acting: on the whole page first, and then per frame only if it is. If the
checkpoint would be scoped to a frame where the text was already visible, it is not recorded. The
`checkpoint` event says `vacuous: true`, and the model is told to pick text that only the action
produces.

Text already visible in a different frame doesn't count. For the stuck-repeat detector a vacuous
expectation counts as not met: three identical repeats with an already-true expectation is the
retry loop to stop. The stuck reason says what happened ("with an expectation that was already
visible before the action"), not that the expectation was unmet.

## Analysis for artifacts nobody re-optimizes

`validateCapability` can't see page state, so it can't detect vacuity. It reports redundant repeats
as the warning `redundant_repeated_step`. `cu validate` prints it, and so does `cu optimize` before
it starts.

## What "optimized" guarantees, and what it doesn't

**It guarantees** that the draft, replayed `verifyRuns` times in a row with the given inputs on the
given tenant, succeeded every time with exactly the baseline's outputs, and that every dropped
checkpoint held before its step on every one of those runs.

**It doesn't guarantee** anything about other inputs or other tenants. A step that only matters
for another input can be removed wrongly: a "dismiss the overdraft warning" click that never fires
for member 12345. Three things bound that:

- the draft, the provenance note and human approval;
- `cu approve`'s content-checked replay requirement;
- `--verify-runs`.

**It doesn't make a wrong read-only declaration safe.** Side effects nobody reads back are
invisible to output equality, and that is exactly what the declaration rules out.

## Limits

- **Trials cost real time.** The mock app's 10-step lookup takes about 30 s with
  `--verify-runs 2`, mostly removal trials that fail and wait out their step timeout. Removal trials
  use `--removal-timeout-ms` (default 5000). A too-short timeout can only keep a step, never remove
  one wrongly, because verification uses the normal timeout.
- **Single-step removal.** Two steps that are only unnecessary together (open a menu, pick an item)
  survive.
- **Whole conditions.** Vacuity is judged on whole conditions: a compound `all` that is partly
  vacuous is kept whole.
- **Trials are only as faithful as their environment.** The in-memory FakeSurface starts on the
  login page, so the entry navigate looks removable there. A real browser starts on `about:blank`,
  where it is kept.
- **`--extend` runs aren't optimized.** Their steps belong to an existing capability.

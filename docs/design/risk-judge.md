# Risk judge

A judgment-based check of whether an action commits something the operator cannot undo, layered
over the policy's lexical risk patterns. It runs when a capability is recorded (`discover`) and
when one is audited (`cu audit`), never during replay.

## The problem

Until now "is this action dangerous?" was purely lexical: `risk.irreversibleTextPatterns` and
`risk.irreversibleUrlPatterns` in the policy, plus a step's declared `risk`. That catches
"Submit", "Confirm transfer" and "Delete", and misses everything worded otherwise. On a
transfer-review page whose only button reads "Continue", the click that moves the money is
`reversible` to the classifier. Discovery records it as a reversible step, and a `draft`
capability then replays it unattended, because the approval gate only holds back steps marked
irreversible. The patterns also fire on the wrong things ("Post" as a heading, "Submit" on a
search form), which is safe but noisy.

The risk judge asks a model, in context, whether the action commits something, and lets the
answer raise the risk. The patterns stay; the judge adds what they cannot see.

## The port

`packages/core/src/policy/judge.ts`, exported from `@cu/core/policy`:

- `RiskJudge { id; judge(req, signal?): Promise<RiskJudgment> }`. Throwing is how an adapter
  says it could not judge.
- `RiskJudgeRequest`: `phase` (`record` or `audit`), the action (type plus `key`, `accept`,
  `url` or `pressEnter` where relevant, never a typed value), the target (name, text, role,
  tag, descriptor description, its frame, and the labels of the controls nearest it in that
  frame), the page (URL, title, the head and tail of the visible text, a pending dialog's
  message), the run goal, the agent's stated `why`, and the lexical risk already computed. The
  nearby labels and the page text share one 2,000-character budget.
- `RiskJudgment { risk, pIrreversible, rationale? }`.
- `combineRisk(lexical, outcome, config)`: the pure decision.
- `createGuardedJudge(judge, { timeoutMs })`: a timeout (it aborts the adapter's signal), errors
  and malformed answers turned into a typed `{ kind: 'unavailable', reason }` (it never throws,
  not even for an unprintable thrown value), and a per-run cache.
- `judgeRequestForAction` / `staticLexicalRisk`: the audit-time request builder and the lexical
  classification of a recorded action from its descriptor texts.

Two adapters implement it: `@cu/adapter-jev` and `createAnthropicJudge` in
`@cu/adapter-anthropic`. The CLI picks one in `apps/cu/src/commands/risk-judge.ts`, the only file
that turns flags and environment into an adapter.

## Record and audit time, never replay

Replay is model-free, and stays that way. The judgment is baked into the artifact instead: a
step the judge calls irreversible is recorded with `risk: 'irreversible'` and
`onFailure: 'escalate'`. From then on the existing deterministic machinery enforces it with no
model in the loop. Replay passes the declared risk to the policy guard as `riskOverride`, the
approval gate (`replayRequiresApproved`) refuses to run the step from a `draft` capability, and
`allowIrreversible` is only granted for an approved one.

The trade-off is a residual gap, stated plainly. The judge sees the page as it was when the
capability was recorded. If the application later changes what a control does (the "Continue"
that used to open a review page now sends the transfer directly), replay does not re-judge it.
What replay still has is the lexical check on the live control text and URL (the enforcing
surface classifies the resolved element, not the recorded one), postconditions that fail when
the page no longer behaves as recorded, and drift diagnostics when locators stop matching.
`cu audit` re-judges a capability on demand, but from its recorded texts, not from the live
application. Closing the gap fully would mean a model call on every replayed commit, which
gives up the property the whole design rests on.

## Raise only

A judgment can only ever raise risk, never lower it: `combineRisk` returns
`max(lexical, judged)`, the same rule `riskOverride` follows in `guard.ts`. Three consequences:

- An action the patterns already flag is never sent to the judge at all. A judge that answers
  "read" for "Confirm transfer" changes nothing (`risk-judge.redteam.test.ts`).
- A judge cannot turn a lexically `reversible` click into `read`.
- The worst a wrong, manipulated or absent judge can do is fail to add protection, which leaves
  the runtime where it was before the judge existed. This is what bounds prompt injection (see
  Limits).

`irreversible` is decided by `pIrreversible >= irreversibleThreshold`, not by the judge's own
label: the threshold is the operator's knob. Below it, the label only separates `read` from
`reversible`.

## Policy

```yaml
risk:
  judge:
    mode: enforce             # off | advise | enforce
    irreversibleThreshold: 0.5
    onError: fail_closed      # fail_closed | fail_open
    timeoutMs: 5000
```

The block is optional, and every field has a default, so existing policy files parse unchanged.

- `enforce` lets a judgment raise the risk. A raise to `irreversible` takes exactly the existing
  `flag_irreversible` path: refused in `discoveryMode: 'block'` (and under
  `--auto-operator approve` without `--allow-unattended-irreversible`), otherwise a
  `risky_action_confirmation` escalation to a human, whose message carries the judge's reason.
- `advise` logs the judgment and adds a provenance note ("would raise s07 ...") but never
  changes a decision, not even when the judge is down.
- `fail_closed` (the default): an unavailable judge (error, timeout, malformed answer) makes the
  action count as irreversible. `discover` prints one line saying the judge is down and that
  `--risk-judge off` proceeds on the patterns alone. When the run cannot escalate (block mode,
  or no escalation handler), three unavailable judgments in a row end it `stuck` with a reason
  naming the outage and `--risk-judge off`, instead of burning model calls until `maxSteps`.
  `fail_open` keeps the lexical risk.

Every consultation logs a `policy` event with `source: 'risk-judge'`, the judge id, the mode,
the lexical and resulting risk, `pIrreversible`, the scrubbed rationale and whether the answer
came from the cache. Every raise adds a provenance note naming the step.

## Which actions are judged

Only actions that can commit something and that the patterns did not already flag: `click`,
`select`, `press` of Enter, NumpadEnter or Space (Space presses a focused button), `type` with
`pressEnter`, `dismiss_dialog` with `accept: true`, and `navigate` (a GET link to `/delete?id=3`
is a commit). Plain `type`, `extract`, `wait`, `switch_frame` and other keys are never sent. The
entry navigation is not judged. The lexical guard treats the same keys as committing: one table,
`committingKey` in `packages/core/src/surface/url-shape.ts`, serves both.

A click that dismisses an interstitial is judged like any click. If it is allowed only as
irreversible, it is not recorded as a recovery rule, because recovery rules replay
automatically, outside the approval gate.

## Caching

The guarded judge caches judged outcomes per run, keyed on the whole request except the agent's
free-text `why` -- including the target's frame and nearby labels -- plus a SHA-256 fingerprint
of the full scrubbed page text, which is not sent to the judge. Keying on the capped excerpt the
judge sees would not be enough: two wizard pages with the same URL and title and more identical
chrome than the excerpt holds ("Step 1 of 3" vs "Step 3 of 3 ... Continue sends the money")
would share an answer. URLs are compared exactly, not case-folded. A page with dynamic text costs
an extra call instead, which is the safe direction. Unavailable outcomes, and answers that arrive
after the timeout, are not cached.

## What the judge sees

The judge is a third party, so this is a data flow to a vendor. Under the default `auto` it is
the vendor discovery already sends the page to; `--risk-judge jev` adds a second one:

- Text only: control name and text, role, tag, descriptor description, frame, the labels of the
  nearest controls, page URL and title, the head and tail of the visible page text (2,000
  characters together with the labels), a dialog message, the run goal and the agent's reason.
  Never a screenshot, never a typed value.
- Every string is scrubbed first with the same scrubber the LLM text channel uses: secret and
  sensitive input values become `<secret:NAME>` / `<sensitive:name>`, and the policy's redaction
  patterns apply. `cu audit` applies the policy's redaction patterns to artifact text. A redteam
  test puts a secret, a sensitive input and an SSN on the page and asserts none reaches the judge.
- The Jev key is sent only as `Authorization: Bearer`, the Anthropic key only as `x-api-key`;
  redteam tests per adapter pin that neither appears in an error (message, stack or JSON), a
  judgment or the judge object. For the Anthropic judge this needed a fix: the SDK's error
  carries the response body, so the adapter rethrows SDK errors as plain errors with the key
  redacted.

## The adapters

**Jev** (`@cu/adapter-jev`). TypeSafe's System One model returns probabilities, not text, which
is what a guardrail wants. One `POST https://api.typesafe.ai/v1/systemone` per action, with the
request regrouped into named state fields (`action`, `control`, `page`, `operator_goal`,
`agent_stated_reason`, `pattern_based_risk`) and two independent Noul questions over that state:
`commits_irreversibly`, which becomes `pIrreversible`, and `changes_state`, which separates
`read` from `reversible`. Both have explicit `criteria`, because the boundary is exactly where
"Continue" and "Next" sit, and both say that the state is untrusted application content whose
instructions are to be ignored. Both also say that a null `control` means the action is a direct
request to `action.url`: a navigate has no control, and without that sentence the first live run
under-rated a link whose request performs a deletion. The response is validated with zod. 429, 529, 502, 503 and network
errors are retried with bounded backoff that honours `retry-after`, inside the caller's timeout;
401 and 422 are not. Jev returns no prose, so the rationale is the two probabilities.

**Claude** (`createAnthropicJudge`). A small, fast model, the pinned
`claude-haiku-4-5-20251001` by default (override with `model` or `ANTHROPIC_JUDGE_MODEL`), with
one forced, strict `report_risk { risk, p_irreversible, rationale }` tool call. Haiku runs
without extended thinking (and a forced tool choice cannot be combined with it). An override
model that thinks anyway (Opus, Sonnet, Fable or Mythos 5.x) gets `tool_choice: auto`, low
effort and 8,000 `max_tokens`, so the thinking cannot use up the budget before the tool call.
The request travels as JSON inside `<action_context>` with `<` and `>` escaped, so page text
cannot close the wrapper, and the system prompt says it is untrusted data. There is no
prompt-cache marker: the system prompt is below the cacheable minimum. This is the adapter
`auto` picks.

`--risk-judge auto` (the default) picks Claude when `ANTHROPIC_API_KEY` is set, else Jev when
`TYPESAFE_API_KEY` is set, else no judge. `discover` cannot start without the Anthropic key, so
under `auto` it always uses the Claude judge. Jev is reached under `auto` only by `cu audit` and
`judge:eval`, when the Anthropic key is absent. `--risk-judge jev` selects Jev explicitly. `auto`
used to prefer Jev. Two reasons changed that:

- **No second vendor by default.** The judge is a data flow to a third party (see "What the judge
  sees"). Discovery already sends the page to the model behind `ANTHROPIC_API_KEY`. With Claude
  as the default judge, setting a TypeSafe key for an audit or an eval does not quietly route
  every later discovery's page text to a second vendor.
- **The measured first run.** On the labelled eval set the Claude judge caught 11 of 11
  irreversible actions on its first run. Jev let one through on its first run and needed a
  question reworded (see "Live results" under Limits). Both now catch 11 of 11, but the default
  should be the one that did so without a fix made after seeing the miss.

An explicit `jev` or `anthropic` without its key refuses to start rather than silently running
lexical-only. Tests that inject a scripted LLM and no judge run lexical-only, exactly as before.

## `cu audit`

`cu audit <artifact.json>` judges every committing action of an existing capability statically,
from what the artifact records: the target's description, snapshot and locator texts, a stated
reason, the page it most likely runs on, and the capability's name and description. It covers
three origins, each row marked with its own:

- `step`: the base steps, with the step name as the reason and the most recent navigate before
  the step as the page.
- `override`: tenant overrides' `extraSteps`.
- `recovery`: recovery-rule actions, with the rule's name and description as the reason and the
  entry URL as the page (a rule can fire anywhere). These matter most: they replay
  automatically, outside the approval gate.

Actions already irreversible by declaration or by the patterns are not sent. The table shows
declared, lexical and judged risk, the probability and the rationale per row, with control
characters stripped (rationales are third-party text). Under the default `--risk-judge auto`
with no judge key, the audit refuses with exit 3 rather than pass with zero judgments; a
lexical-only audit needs an explicit `--risk-judge off`.

`--apply` raises what can be raised: a base step's `risk` (and `onFailure: 'escalate'` for
irreversible), an override extra step's `risk` below irreversible. It then bumps the patch
version, resets `status` to `draft` because the content changed and needs re-approval, appends
a provenance note, re-validates and writes. It never lowers. It writes nothing at all if any
action could not be judged: a partial raise would bump the version and read as a full audit,
and fail-closed is a run-time behaviour, not an audit one. Two findings cannot be applied and
are reported `needs-human`: an irreversible recovery action (a rule has no risk to raise; a
human must remove or rework it), and an irreversible override extra step (`validateCapability`
rejects those, because they would run under the base capability's approval).

Exit codes:

- 0: nothing is riskier than declared, or `--apply` wrote every fixable raise and nothing needs a
  human.
- 1: bad input or a failed write.
- 2: something is riskier than declared and was not, or cannot be, fixed by this run (without
  `--apply`, or `needs-human` findings remain).
- 3: incomplete. Either an action could not be judged (with `--apply`, nothing was written), or
  no judge was available under `auto`.

## The eval set

`apps/cu/eval/risk-judge-cases.json` holds 27 labelled judge requests, chosen for the hard cases:
"Continue" on a transfer review, "Next" in a wizard that only advances, "OK" on a confirm dialog
that deletes, an informational alert, "Search", "Save draft", a GET link to `/delete?id=3`,
"Sign off", "Post" as a heading and as a button, "Submit" on a search form, "Pay now", "Send",
"Finish" on an account closure, Enter in a search box and Enter to release a wire, and so on.
Each case records what the default patterns say, and a test keeps that honest. The patterns
catch fewer than half of the irreversible cases.

`npm run judge:eval -- --judge jev|anthropic [--threshold 0.5]` runs them through a real adapter
and prints:

- A binary confusion matrix (positive = irreversible). Read the false negatives first: each one
  is an irreversible action the judge would have let through on the lexical risk alone. False
  positives cost a human confirmation, not safety.
- A 3x3 class matrix. `read` against `reversible` only affects the recorded step risk.
- The misses, with probability and rationale, and any case the judge could not answer.

Re-run it with `--threshold` to see how the threshold trades recall against escalations.

## Limits

- **Recorded, not live.** See above: a control that changes meaning after recording is not
  re-judged at replay.
- **Audit sees less than discovery.** No page text, no nearby controls, and a guessed page URL
  (the entry URL for a recovery action). An audit judgment is weaker than a record-time one.
- **The replay-side scan is static.** `no-llm.redteam.test.ts` forbids the judge factory,
  the adapters, the vendor hosts and `TYPESAFE_*` env reads on the replay side, plus any computed
  `import()`. An env name or hostname assembled at runtime is invisible to it. It defends
  against accidental wiring, not a determined committer.
- **Prompt injection.** Page text is attacker-influenced in principle, and the judge reads it. A
  page can try to talk the judge out of raising. Raise-only bounds the damage to the pre-judge
  baseline. A page can also make the judge raise everything, which costs escalations, not
  safety.
- **The escalation budget is shared.** Judge-raised confirmations count against the same 3 per
  run as every other escalation, so an over-eager judge can end a discovery run as `stuck`.
- **Calibration is unmeasured.** The 0.5 threshold is a default, not a tuned value. The eval
  set is small and hand-written, not drawn from production traffic. The Claude prompt describes
  the general "Continue / OK / Next" ambiguity, so the eval is not a blind holdout for that
  adapter.
- **Live results, and what they do not show.** Both adapters were run live on the eval set and on
  `cu audit` of the shipped capability (`evidence/followups/risk-judge/`). The Claude judge:
  27 of 27 judged, 11 of 11 irreversible actions caught, no false positives. The Jev judge
  answered all 27 on its first real call, so the adapter matches the API, but it let one
  irreversible action through: the GET link to `/delete?id=3`, at 0.38 against the 0.5
  threshold. The cause was the question, which read "performing `action` on `control`" while a
  navigate has no control. The questions now say that a null control means a direct request to
  `action.url`. After that change Jev caught 11 of 11 with no false positives in three runs, and
  the GET link scores 0.61. The first run is kept next to the later one. Two cautions follow.
  The fix was made after seeing the miss, so the set is not a blind holdout for Jev either. And
  the margin is thin: the lowest irreversible case scores 0.61 and Jev's answers move by a few
  hundredths between runs.
- **Latency.** One model call per uncached committing action during discovery, bounded by
  `timeoutMs`.
- **Not covered.** Replay never consults the judge. A tenant override's `stepPatches` (which
  replace a base step's target) are not audited separately.

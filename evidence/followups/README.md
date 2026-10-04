# Evidence for the later features

Live runs of the real CLI on 2026-10-01, on the code as merged. Each folder holds `commands.md` (the commands, in order), one `.txt` per command with its captured output and exit code, and the run directories and artifacts the commands produced. Local paths in the captured output were made repo-relative; nothing else was edited. `npm run evidence` does not rebuild this folder.

Where a model was involved it was a real one: Claude for discovery, and the Claude Haiku and Jev risk judges.

## risk-judge

- `judge-eval-anthropic.txt`: `npm run judge:eval -- --judge anthropic`. 27 of 27 cases judged. As a binary decision (irreversible or not): 11 of 11 irreversible actions caught, no false positives. Three cases got the right binary verdict and the wrong class ("read" judged "reversible", the harmless direction). The model is not deterministic, so which three varies between runs. The set is small and hand-written by the author of the judge prompt: it shows the judge works end to end on the intended hard cases, not that the 0.5 threshold is tuned.
- `audit-shipped-capability.txt`: `cu audit` on the shipped capability. Five committing actions judged (four steps and one recovery action); nothing is riskier than it declares.
- `judge-eval-jev-first-run.txt`: the first real call to Jev, `npm run judge:eval -- --judge jev`. 27 of 27 judged, so the adapter matches the API. 10 of 11 irreversible actions caught, no false positives. The miss is `get-link-to-delete`, a plain link whose request performs the deletion, at 0.38 against the 0.5 threshold. The question asked about "performing `action` on `control`", and a navigate has no control.
- `judge-eval-jev.txt`: the same command after the questions were reworded to say that a null control means a direct request to the action's URL. 11 of 11 caught, no false positives, the same in two further runs. The link now scores 0.61, the lowest of the irreversible cases, and Jev's answers move by a few hundredths between runs, so the margin is thin. The rewording was made after seeing the miss: the set is not a blind test for this adapter. Four or five cases get the right binary verdict and the wrong class, in both directions between "read" and "reversible".
- `audit-shipped-capability-jev.txt`: `cu audit --risk-judge jev` on the shipped capability. The same five actions; nothing is riskier than it declares.

## optimizer

Against the mock app, on the shipped capability `artifacts/lookup-member-savings-balance.json`, which is left unchanged.

- `1-validate-shipped.txt`: `cu validate` warns about the repeated password step and the outcome detector that binds no input.
- `2-optimize-not-declared-read-only.txt`: without a read-only declaration the optimizer only analyses. It replays nothing and writes nothing.
- `3-optimize-read-only.txt`: with `--read-only`, 10 steps become 9. Step `s04` (the repeated password entry) collapses into `s03`, and the two `"Password:"` postconditions that already held before their step are dropped. Nine trial replays; the result passed 3 of 3 verification replays. The output is `lookup-member-savings-balance.optimized.json`, version 1.2.3, status `draft`.
- `5-replay-optimized-draft.txt`: the draft replays for another member (10002) and returns that member's balance.
- `reports/` holds the optimizer's own `optimize.json` for both runs.

## chaos

`replay --times 6` with `--fault '{"chaos":{"seed":42,"failSearch":0.2,"interstitial":0.5,"expireSession":0.15}}'` and the scripted `relogin` operator.

Six runs: 2 success, 1 hard failure (`app_error`), 3 escalated (1 resumed to success; 2 resumed and then hit the injected `app_error`). No business outcome and no wrong answer. 58 locator resolutions, none by a fallback. The interstitial recovery fired 10 times. The output lists every injected fault in order and the command that reproduces the series; the same seed gives the same series.

Without a read-only assertion an injected search failure ends the run. With `--read-only` replay retries it; see `retry` below.

## retry

Replay now retries an `app_error` itself, up to two times, but only when the run is marked `--read-only` (the flag is an assertion; nothing verifies it). Against tenant A of the mock app, `replay` of `lookup-member-savings-balance` for member 12345, run directories alongside:

- `a-chaos-seed5-read-only.txt`: seed 5, `failSearch` 0.2, one injected search failure. Result `success` in 17 steps, 15.6 seconds, recoveries `dismiss_system_maintenance_notice`, `retry_app_error`, `dismiss_system_maintenance_notice`. No locator drift.
- `b-failsearch-read-only.txt`: every search fails (`{"failSearch":true}`). Two `retry_app_error` recoveries, then `hard_failure` (`app_error`) at step s06 after 15 steps, 37.8 seconds. Exit code 4.
- `c1-seed42-times6.txt`: the seed-42 series without `--read-only`. Six runs, duration mean 15.8 seconds (min 2.6, max 26.8): 2 success, 1 hard failure (`app_error`), 3 escalated (1 resumed to success, 2 resumed and then hit `app_error`). No retry fired. Same result as the earlier chaos capture. 58 locator resolutions, all at depth 0.
- `c2-seed42-times6-read-only.txt`: the same series with `--read-only`. Six runs, duration mean 23.4 seconds (min 2.5, max 64.9): 3 success, 0 hard failures, 3 escalated (2 resumed to success, 1 resumed and then hit `app_error`). `retry_app_error` fired twice, in one run. 87 locator resolutions, all at depth 0. The injected fault draws differ from the first series because the retries consume draws.

So with `--read-only`, the series went from 2 success and 1 hard failure to 3 success and 0 hard failures; one run still ends in `app_error` after a session-expiry escalation. Without the flag nothing changes. Runs are slower with retries (mean 23.4 against 15.8 seconds).

## discovery-mock-app

A real model discovers "look up a member and read the savings balance and name" on the mock app, with screen masking on (the default policy).

- `1-discover.txt`: success, 9 steps, 10 model calls. The risk judge was asked about 4 committing actions and raised none. The built-in optimizer stage ran 3 trial replays and changed nothing. The transcript the model saw carries `[MASKED:address]`, `[MASKED:phone]`, `[MASKED:input]` and `[MASKED:sensitive]` in place of the member's address, phone number, field values and the credentials; the screenshots under `shots/` show the same fields painted over.
- `2-replay-other-member.txt`: the capability replays without a model for member 10002 and returns that member's balance and name.
- `3-replay-unknown-member.txt`: an unknown member ends as a typed `hard_failure` (`element_not_found`). This capability was not extended with a "member not found" business outcome, so that is the expected result.

## discovery-desktop

The same task on Teller Workstation, the Windows Forms mock app, through Windows UI Automation (`--base-url desktop://tellerworkstation`, launched by `--app-command`).

- `1-discover.txt`: success, 7 steps, 7 model calls. The optimizer stage ran its trials on the desktop surface and changed nothing.
- `2-replay-other-member.txt` and `4-replay-other-member-json.txt`: replay for member 10002 succeeds in about 3 seconds with no locator drift. The balance comes from an edit field, which the desktop policy masks, so the output is marked sensitive: the caller gets the value (`--json` shows 12500) and the summary line and the persisted `result.json` show it redacted.
- `3-replay-unknown-member.txt`: an unknown member ends as a typed `hard_failure` (`checkpoint_failed`).

No application process was left running after any of these.

## public-target

A public demo storefront that publishes its own demo login, under `policies/saucedemo.yaml`. Only that published login was used, at a handful of runs with pauses between them. Screenshots and DOM snapshots of the site are not kept here; the event logs, results and transcripts are.

- `first-run-before-the-fix/`: the first attempt failed with `max_steps` after 11 steps and 20 model calls. The page agent listed only controls and table cells, so a price in a plain `<div>` had no reference the model could extract. That was real tailoring to the mock app, and it is why element enumeration was generalised.
- `1-discover.txt`: after the fix, discovery succeeds in 6 steps and 7 model calls and reads the price of the product named by the run input.
- `2-replay-same-product.txt`, `3-replay-other-product.txt`: replay without a model returns the right price for the recorded product and for a different one, in under 2 seconds each.
- `4-replay-unlisted-product.txt`: a product the site does not list ends as a typed `hard_failure` (`element_not_found`), not as some other product's price.
- `5-optimize.txt`: the optimizer, with a 2 second pause between trials, found nothing to remove.

Two things this run shows that are not clean. The first locator recorded for the product link (a `role` locator) does not resolve at replay, so every replay uses the `text` fallback and reports it as locator drift. And `cu validate` warns that no checkpoint binds the input: the price is tied to the product only by its locator, which is anchored on the product name.

After pruning (`after-pruning/`, same discover command, run once with the site's published demo login): discovery succeeded in 6 steps and 8 model calls, price 29.99 for the backpack. The risk judge timed out once (5 seconds, fail closed) during discovery; the run still finished. `cu validate` printed `valid: read-product-price@1.0.0 (draft, 6 steps, risk reversible)` with no warning. Replay for Sauce Labs Backpack (29.99) and Sauce Labs Bike Light (9.99) succeeded in 6 steps, 1.2 seconds each, no recoveries, no locator drift. Replay for an unlisted product (Sauce Labs Unicorn Saddle) ended as a typed `hard_failure` (`element_not_found`) at step s05. The product link now carries one locator (`text`, "1 locators" in the failure), so it resolves at depth 0 instead of falling back from a `role` locator that never matched. Screenshots and DOM snapshots were deleted from the copied run directories.

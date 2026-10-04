# Evidence

Each directory at the top level here is a real run directory, copied unchanged from `runs/`. The live runs behind the later features are under `followups/`, described at the end. Every run directory holds `events.jsonl` (the structured log) and `result.json`. The rest appear only when a run produces them: `shots/` (screenshots: one per model turn in discovery runs, and the failure or escalation screenshots in replay runs), `dom/` (DOM snapshots on failure), and `interventions/` (handoff records). Discovery runs also hold `transcript.jsonl` and the `capability.json` they produced.

The capability under test is [capability.json](capability.json), recorded by the discovery run below and replayed for every scenario.

## discovery-run

This LLM-driven run produced the capability. It finished with status `success`, recorded 10 steps, and made 11 model calls. `transcript.jsonl` is the redacted model transcript, and the `decision` events in `events.jsonl` carry the model's reasoning for each step.

## discovery-extend-1

This extend-mode discovery run tried a different input to find an exceptional outcome. It finished with status `success` after 7 model calls. The run merged the outcome the model declared into the capability as a business outcome.

## discovery-extend-2

This extend-mode discovery run tried a different input to find an exceptional outcome. It finished with status `success` after 8 model calls. The run merged the outcome the model declared into the capability as a business outcome.

## replay-success

Replay, success with outputs. Command: `replay --input memberId=12345`. Result kind `success`, outputs: `{"savingsBalance":1234.56,"memberName":"Jane Q. Sample"}`. Locator fallback depth (max across the run): `0`.

## replay-not-found

Replay, business outcome (member not found). Command: `replay --input memberId=99999`. Result kind `business_outcome`, outcome `member_not_found`, data: `{"recordCountMessage":"No records found."}`. Locator fallback depth (max across the run): `0`.

## replay-access-denied

Replay, business outcome (access denied). Command: `replay --input memberId=90001`. Result kind `business_outcome`, outcome `member_access_denied`, data: `{}`. Locator fallback depth (max across the run): `0`.

## replay-app-error

Replay, hard failure (injected application error). Command: `replay --input memberId=12345 --fault '{"failSearch":true}'`. Result kind `hard_failure`, code `app_error` at step `s06`; evidence `{"screenshot":"shots/31.png","dom":"dom/31.html"}`. Locator fallback depth (max across the run): `0`.

## replay-handoff

Replay, escalation to a human and resume (injected session expiry). Command: `replay --input memberId=12345 --fault '{"expireSession":true}' --auto-operator relogin`. Result kind `escalated`, resolution `resumed_success`; outcome after hand-back: `{"kind":"success","outputs":{"savingsBalance":1234.56,"memberName":"Jane Q. Sample"}}`. Locator fallback depth (max across the run): `0`.

## replay-tenant-b

Replay on tenant B through the override. Command: `replay --input memberId=12345 --tenant b`. Result kind `success`, outputs: `{"savingsBalance":1234.56,"memberName":"Jane Q. Sample"}`. Locator fallback depth (max across the run): `0`.

## replay-tenant-b-no-override

Replay against tenant B's base URL directly, without `--tenant`. Command: `replay --input memberId=12345 --base-url http://localhost:4174`. Result kind `success`, outputs: `{"savingsBalance":1234.56,"memberName":"Jane Q. Sample"}`. Locator fallback depth (max across the run): `2`. Drift signal: step `s06` (the member id field label) resolved at fallback depth `2` instead of `0`, because this run has no tenant override and the base capability's "Member ID" label locator does not match tenant B's real "Member #" label.

## followups

Live runs of the risk judge, `cu audit`, the optimizer, seeded chaos, discovery with a real model on the mock app and on the Windows mock desktop app, and the public-target run. Each has its own folder with the commands, their captured output, and the run directories the commands produced; [followups/README.md](followups/README.md) lists them with their results. `npm run evidence` does not rebuild this folder.

## explainer.mp4

This narrated walkthrough covers the problem, the design, and a live run. `npm run video:build` rebuilds it from real runs, as described in [how the explainer video is built](../docs/video/README.md).

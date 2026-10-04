# Command and configuration reference

[Getting started](getting-started.md) covers setup and the demo path. This page lists the rest: every command, the global flags, exit codes, configuration, and what a run writes. Per-flag detail for the `cu` command is in [`apps/cu/README.md`](../apps/cu/README.md), and `npm run --silent cli -- <command> --help` prints the options of one command.

Commands use bash quoting. In Windows PowerShell, call `npm.cmd`, join multi-line commands into one line, and escape the quotes inside JSON arguments (`'{\"failSearch\":true}'`).

## Commands

`cu` runs from source. Run it from the repo root through the root scripts: `npm run cli -- <command>`, or the shortcuts `npm run discover`, `npm run replay`, `npm run approve` and `npm run operator` (which runs `operator --demo`). Add `--silent` to keep npm's own banner out of the output.

| Command | What it does | Calls a model |
|---|---|---|
| `discover --goal <text> --id <kebab> [--input name=value] [--output name:type] [--read-only] [--out <path>]` | Learns a capability and writes a draft. Also `--sensitive`, `--secret`, `--entry`, `--vendor`, `--product`, `--risk-judge`, `--auto-operator`, `--no-optimize`, `--candidates`. | yes |
| `discover --extend <artifact.json> ...` | Probes an existing capability with other inputs for business outcomes; writes a new draft minor version. | yes |
| `replay <artifact.json> [--input name=value] [--json]` | Runs a capability with no model. Also `--read-only`, `--approve`, `--fault`, `--auto-operator`, `--operator-port`, `--times`. | no |
| `validate <artifact.json>` | Schema and cross-field checks, with warnings. A read that nothing checks against its record is warned (`read_without_record_identity`, contracts.md section 2). | no |
| `approve <artifact.json> --by <name> [--notes <text>] [--force]` | Draft to approved, patch version bumped. Needs a completed replay of that version under `runs/`, digest-matched when the replay recorded a digest, unless `--force`. Also refuses a capability with a read whose target is positional-only (the `positional_only_target` warning of `validate`), naming the step; `--force` overrides it and says so. Positional-only actions do not block. | no |
| `audit <artifact.json> [--risk-judge auto\|jev\|anthropic\|off] [--apply] [--out <path>]` | Re-judges every committing action with the risk judge. `--apply` raises what it can and resets the capability to draft. A lexical-only audit needs an explicit `--risk-judge off`. | yes, unless `off` |
| `optimize <artifact.json> --input name=value [--read-only] [--analyze-only] [--out <path>]` | Removes steps replay proves unneeded. Replays only a capability declared read-only; writes `<name>.optimized.json` as a draft. | no |
| `catalog list` | Every capability an agent may call. | no |
| `catalog search "<text>" [--top-k n] [--json] [--approved-only]` | Ranked keyword search. | no |
| `catalog tools [--brief] [--id <id>] [--query "<text>" --top-k n] [--approved-only]` | Tool definitions for an agent caller: one line each, one in full, or the search shortlist. | no |
| `catalog invoke <id> --input name=value [--read-only] [--json]` | Replays the highest non-deprecated version of a capability by id. Same output and exit codes as `replay`. | no |
| `operator --demo [--port <n>]` | Handoff walkthrough on an in-memory app; open `http://127.0.0.1:4300`. | no |

`catalog` takes `--dir <path>` (default `artifacts`). Search and `tools` include drafts; a caller that must only run approved capabilities passes `--approved-only`. See [`docs/design/capability-selection.md`](design/capability-selection.md).

Other scripts:

```bash
npm run judge:eval -- --judge anthropic    # the risk judge against 27 labelled cases; also --judge jev
npm run evidence -- --artifact <artifact.json> [--discovery-run <runId>] [--extend-run <runId>] [--tenant-b]   # rebuild evidence/
npm run mock-app                           # tenant A on 4173; MOCK_TENANT=b for tenant B on 4174
npm run mock-desktop                       # Teller Workstation (Windows only)
npm run build:relay                        # pre-build Relay's UI (otherwise built on first use)
npm run schema:export                      # refresh packages/core/schema/*.json after a schema change
```

`npm run evidence` replays against the running mock app, so it needs tenant A on 4173, and tenant B on 4174 with `--tenant-b`. `--extend-run` can be repeated. It rewrites `evidence/README.md` and does not touch `evidence/followups/`.

## Global flags

Every command accepts these, before or after the command name:

| Flag | Meaning |
|---|---|
| `--policy <path>` | Policy YAML. Default `policies/default.yaml`. |
| `--runs-dir <dir>` | Where run directories go. Default `runs`. |
| `--base-url <url>` | The app. An http(s) URL drives Chromium; `desktop://<process>` drives a Windows app. Default: the mock app's tenant A. Its origin must be allowed by the policy. |
| `--tenant <a\|b\|key>` | `a` or `b` picks a mock tenant's base URL (and, for `b`, its override); any other value selects that capability override key. |
| `--headed` / `--headless` | Show the browser (needed for a person to work in it during a handoff) or not (default). |
| `--credentials <spec>` | Where secret bindings resolve: `env` (default), `file:<path>` or `exec:<command>`. Also `CU_CREDENTIALS`. |
| `--app-command "<command line>"` | With a `desktop://` base URL: start the app. The run owns its process tree and ends it. |
| `--attach-pid <pid>` | With a `desktop://` base URL: drive this running process and leave it running. |

`replay`, `discover` and `catalog invoke` also take `--operator-port <n>` for Relay (default 4300 when a person may need it; `0` for an OS-assigned port).

## Unattended runs

`--auto-operator` answers escalations without a person:

| Mode | Behaviour |
|---|---|
| `none` (default) | A person answers in Relay. |
| `approve` | On `discover`, irreversible actions are refused unless `--allow-unattended-irreversible` is also passed; other escalations are aborted. |
| `abort` | Aborts every escalation. |
| `relogin` | `replay` and `catalog invoke` only. Re-runs the capability's own sign-in steps on the live session and resumes at the first step after sign-in. Aborts if that would repeat or skip an irreversible step. |

## Exit codes

| Command | Codes |
|---|---|
| `replay`, `catalog invoke` | `0` success, `3` business outcome, `4` hard failure, `5` escalated, `1` bad input or crash. With `--times`, the worst run's code. If the mock app rejects a `--fault` key, the previous faults are restored and the command exits `1` without running. |
| `audit` | `0` clean, `2` something is riskier than declared, `3` incomplete (an action could not be judged, or no judge key), `1` bad input. |
| `optimize` | `0` done, `2` the unmodified capability did not replay to success (nothing rewritten), `1` error, `130` interrupted. |
| `validate` | `0` valid (warnings may print), `1` invalid. |

## Replay scenarios on the web mock app

`artifacts/lookup-member-savings-balance.json` is a shipped, approved capability. The model recorded it, two extend runs added the "not found" and "access denied" outcomes, and its tenant B override was written by hand. It predates the optimizer and is deliberately left as approved, so `cu validate` warns that its password step is recorded twice, that its `member_not_found` detector is not bound to the input, and that its two reads have no record identity check (`read_without_record_identity`). A hand-written version of the same capability, `artifacts/examples/lookup-member-savings-balance.example.json`, works with every command below.

Each row is a suffix to `npm run --silent replay -- artifacts/lookup-member-savings-balance.json`. Rows without an `--input` also take `--input memberId=12345`. `--fault` asks the mock app to misbehave for that run and restores it afterwards.

| Command suffix | Result | Exit |
|---|---|---|
| `--input memberId=12345` | `success`, outputs returned | 0 |
| `--input memberId=99999` | `business_outcome` `member_not_found` | 3 |
| `--input memberId=90001` | `business_outcome` `member_access_denied` | 3 |
| `--input memberId=abc` | `hard_failure` `input_validation`, before the app is touched | 4 |
| `--fault '{"failSearch":true}'` | `hard_failure` `app_error`, screenshot and DOM saved | 4 |
| `--fault '{"failSearch":true}' --read-only` | two `retry_app_error` recoveries, then `hard_failure` `app_error` | 4 |
| `--read-only --fault '{"chaos":{"seed":5,"failSearch":0.2}}'` | `success` after one `retry_app_error` | 0 |
| `--fault '{"expireSession":true}' --auto-operator relogin` | `escalated`; a scripted operator signs in again and the run resumes to `success` | 5 |
| `--tenant b` | `success` on tenant B through the tenant override | 0 |
| `--times 5` | stability summary across five runs | worst run |
| `--times 6 --auto-operator relogin --fault '{"chaos":{"seed":42,"failSearch":0.2,"interstitial":0.5,"expireSession":0.15}}'` | stability summary under seeded intermittent faults: runs per result kind, failure codes, escalations, recoveries, fallback depths, and a line that re-runs the same series. In the evidence: 2 `success`, 1 `hard_failure`, 3 `escalated` | worst run |
| the same row with `--read-only` | in the evidence: 3 `success`, 0 `hard_failure`, 3 `escalated`; `retry_app_error` fired twice | worst run |

`--read-only` on replay asserts, for that run, that the capability changes nothing in the app. With it, replay retries an `app_error` read from the page by restarting its steps from a navigation, at most `limits.maxAppErrorRetries` times (2 by default). It is refused with `policy_violation` on a capability with anything irreversible. The runs behind those rows are in [`evidence/followups/retry/`](../evidence/followups/retry/).

Tenant B is a second instance of the same app with different branding, one renamed label, an iframe shell and one extra field. Start it in another terminal before the `--tenant b` row:

```bash
MOCK_TENANT=b npm run mock-app     # listens on 4174
```

## Configuration

### Policy

`policies/default.yaml` is the policy for the mock web app. `policies/desktop.yaml` covers Teller Workstation, and `policies/saucedemo.yaml` a public demo site ([`docs/design/public-target.md`](design/public-target.md)). Point the runtime at a new app with a policy file of its own; do not widen the default one. A policy sets:

- allowed origins (http(s), or `desktop://<process>`), path patterns and action types;
- the text and URL patterns that mark a control irreversible, `discoveryMode` (escalate or block irreversible actions during discovery) and `replayRequiresApproved`;
- how the risk judge is used (`risk.judge`: enforce, advise or off, the threshold, the timeout, and what an unavailable judge means);
- redaction patterns for logs and evidence;
- screen masking (`redaction.screen`): `maskInputs` (`all` masks every form field), `maskLabels` (values next to whole labels such as address, phone, SSN or tax id, date of birth, email), `maskTextPatterns`, `maskSelectors` (CSS, web only) and `omitScreenshotUrlPatterns` (no screenshot at all). Masked values reach the model and the evidence as placeholders, and the caller as real values. See [`docs/design/screen-masking.md`](design/screen-masking.md);
- run limits: discovery's step, model-call and time limits, and `maxAppErrorRetries` for read-only replays.

The fields are typed in [`docs/contracts.md`](contracts.md#4-policy), and enforcement is described in [`docs/design/policy.md`](design/policy.md).

### Environment variables

The CLI reads these from the environment, or from `.env` in the current directory. `.env.example` lists them.

| Variable | Used by | Meaning |
|---|---|---|
| `ANTHROPIC_API_KEY` | `discover`, `audit`, `judge:eval` | The model key. `discover` refuses to start without it. |
| `ANTHROPIC_WORKSPACE_ID` | same | Only when the key is not scoped to a workspace. |
| `ANTHROPIC_MODEL` | `discover` | The discovery model. Default `claude-opus-5`. |
| `ANTHROPIC_JUDGE_MODEL` | the Claude risk judge | Overrides the judge's default small model. |
| `TYPESAFE_API_KEY` | `discover`, `audit`, `judge:eval` | The Jev judge's key. `--risk-judge auto` uses Jev only when `ANTHROPIC_API_KEY` is unset. |
| `CU_CREDENTIALS` | `discover`, `replay`, `optimize`, `catalog invoke` | Where secret bindings resolve; the `--credentials` flag wins. Never echoed. |
| `MOCK_USER`, `MOCK_PASSWORD` | the `env` credential provider | The mock apps' login, which their capabilities bind by name. Default to the demo values when unset. |
| `CU_DEBUG` | the Chromium surface | `1` or `true`: write the raw browser message of a failed action to stderr. What reaches the model, evidence and Relay is fixed text either way. |

The mock web app also reads `MOCK_TENANT` (`a` or `b`), `MOCK_PORT`, `MOCK_HOST` and `MOCK_PASSWORD`. Teller Workstation reads `MOCK_DESKTOP_FAULTS` and `MOCK_DESKTOP_FAULT_FILE` ([`apps/mock-desktop/README.md`](../apps/mock-desktop/README.md)); an app the CLI launches gets only a minimal Windows environment, so set these when starting it yourself with `npm run mock-desktop` and attach with `--attach-pid`.

### Credentials

A capability stores credential names, never values. `discover --secret NAME` (repeatable) names the credentials the agent may bind; without it, the list is `MOCK_USER` and `MOCK_PASSWORD`. A missing credential stops a run before any browser or app starts. The `file:` and `exec:` providers, and the planned OAuth2 and SSO ones, are in [`docs/design/credentials.md`](design/credentials.md).

## What a run writes

Each `discover` or `replay` run gets a directory under `runs/` (git-ignored):

- `events.jsonl`: the structured log, including policy decisions, escalations, control transfers and captured human actions.
- `result.json`: the typed result.
- `shots/`: screenshots, one per model turn in discovery runs, and the failure or escalation screenshot in replay runs.
- `dom/`: page snapshots on failure, values blanked (on desktop, the accessibility tree with no values).
- `interventions/`: handoff records.
- Discovery runs add `transcript.jsonl` (the redacted model transcript), `capability.json` as discovered, `optimize.json`, and with `--candidates`, `candidate.json`.

Capabilities go to `artifacts/` (new drafts there are git-ignored). Curated run directories are committed under [`evidence/`](../evidence/README.md).

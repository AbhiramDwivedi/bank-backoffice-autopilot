# Integration: CLI, composition root, end-to-end tests

Code: `apps/cu/src/runtime/**` (composition root), the rest of `apps/cu/src/**` (the `cu` command), `apps/cu/src/catalog/**`
(agent-facing capability catalog), `tests/e2e/**`.

## Composition

`apps/cu/src/runtime/compose.ts`'s `compose(opts)` is the only place the runtime is assembled; CLI
commands and e2e tests all call it:

```
raw Surface (createPlaywrightSurface {onAgentDetected -> logger 'observation' event}, or injected)
  -> withPolicy(guard, {onDecision -> logger 'policy' event})
  -> createSessionBroker({surface, logger, capture: humanCapture, secretValues})
       broker.surface  = what automation (replay / discover) gets
       broker.escalate = wrapped by resumingEscalation() (below)
  -> Relay console (in-process, --operator-port) registered with the broker
logger = createRunLogger(runsDir, redactor from policy.redaction.patterns)
```

`compose()`'s `operator` option is `{port}` (own a Relay server, built via `startRelayConsole`,
`apps/cu/src/runtime/relay-ui.ts`) or `{server}` (register with one the caller already started).
`startRelayConsole` builds Relay's UI on demand (`ensureRelayBuilt`, into `apps/relay/dist`, skipped
if already fresh) and starts it with `startRelayServer` (`@cu/relay`); `register(broker)` reads the
lease length straight from `broker.leaseMs`.

**Resume after hand-back.** The broker stops in `resuming` and expects `resumed()` (see
`docs/design/handoff.md`). Replay and discovery re-verify by acting instead of calling it directly (replay re-runs the
step or waits on its postcondition; discovery re-observes); acting is refused in `resuming`. `resumingEscalation(broker)`
calls `broker.resumed()` as soon as hand-back resolves, so that re-verification runs as automation; a failure escalates
again as a new intervention, bounded by `maxEscalations`. `reverifyFailed` is therefore never exercised by the wired
system.

**Scripted operators** (`apps/cu/src/runtime/operators.ts`, `--auto-operator`) act only through the
broker's real transitions, labelled `scripted-operator`:

- `approve` sends risky-action confirmations to `next_step` and aborts anything else. In
  `discover`, it does not confirm irreversible actions unless `--allow-unattended-irreversible` is
  also passed: without the flag the run uses `discoveryMode: 'block'`, so an irreversible action
  is refused and the model is told why. The flag, valid only with `--auto-operator approve`, is the
  explicit opt-in to let discovery take an irreversible action with no human watching
  (`docs/design/security-review.md`, "Limits").
- `relogin` re-runs the capability's own sign-in on the same browser after a session expiry
  (`docs/design/credentials.md`), waits for the signed-in condition, then hands back
  `current_step` with `resumeAtStepId` set to **the first step after the sign-in**, wherever the
  expiry surfaced. A lost session takes the page and any form state typed into it, so that is the
  one point from which the rest of the run is rebuilt: the hand-written example's expiry on its
  sign-on step continues at s05; the recorded artifact's expiry on typing the member id resumes
  at that step, and an expiry on the search click (or in the final success check) rewinds to it,
  so the id is typed again before the search runs. Replay refuses a resume point that would repeat
  or skip an irreversible step and asks again with reason `policy_block`; `relogin` answers that
  by aborting with a note saying a human must take over (`docs/design/replay.md`, "Resuming at
  another step").
- `abort` aborts every intervention.
- `none` leaves it to a human on the Relay console.

`runWithShutdown` (`apps/cu/src/runtime/lifecycle.ts`) closes the browser and any operator server the call owns on
completion, on error, and on SIGINT/SIGTERM, always printing the run directory. `runReplay`
(`apps/cu/src/runtime/run-replay.ts`) is the shared path from a capability plus inputs to a `ReplayResult` (compose ->
attachAutoOperator -> replayCapability -> close). Both `replay` and `Catalog.invoke` call it, so there is one wiring
regardless of who is driving it. A busy operator port is caught before a browser is ever launched.

## CLI

`apps/cu/src/index.ts` is the `cu` entry point (commander). It loads `.env` plus the mock app's demo defaults
(`MOCK_USER`/`MOCK_PASSWORD` default to `operator1`/`demo-pass-123` when unset), then registers the global options and
every subcommand. An uncaught error anywhere prints only `err.message`, never a stack or an env value, as
`cu: <message>` and exits 1. A command that produces a `ReplayResult` sets its own more specific exit code first.

### Global options (every subcommand)

| Flag | Default | Notes |
|---|---|---|
| `--policy <path>` / `--runs-dir <dir>` | `policies/default.yaml` / `runs` | policy YAML path; evidence root (`<runs-dir>/<runId>/`) |
| `--headless` / `--headed` | headless | independent booleans; `--headed` wins when both given, and is required for a human to work the same browser window during a live handoff |
| `--base-url <url>` | `http://localhost:4173`, or the `--tenant` default | overrides the tenant default |
| `--tenant <a\|b\|key>` | none | `a`/`b` select the mock app's base URL (4173/4174) and, for `b`, the override key `riverbend-fcu`; anything else passes through as the override key |

### `replay <artifact.json>`

Reads and parses the artifact, then runs it through `replayCapability` via `runReplay`:

| Flag | Notes |
|---|---|
| `--input <name=value>` | repeatable; typed, coerced and validated by `replayCapability` itself |
| `--approve` | sets `status: 'approved'` on the in-memory parsed artifact only; the file on disk is never written; prints a warning and a reminder to use `cu approve` |
| `--read-only` | asserts, for this run only, that replaying the capability changes nothing in the target app (not verified; the file on disk is never written; prints a note). It lets replay retry a transient app error by waiting and restarting its steps, up to the policy's `limits.maxAppErrorRetries` (default 2). Replay refuses it on a capability with anything irreversible (`hard_failure policy_violation`, exit 4). A capability that carries `readOnly: true` needs no flag. `catalog invoke` takes the same flag |
| `--fault <json>` | see below |
| `--auto-operator <none\|approve\|abort\|relogin>` / `--operator-port <n>` | default `none`; `--operator-port` defaults to `0` (ephemeral) unless `--headed` or `--auto-operator none` (the default) is in effect, in which case `4300` (`discover` always defaults to `4300`); an explicit value always wins; a busy port moves the console to an OS-assigned port and logs its URL |
| `--times <n>` | default 1; runs N times in one shared browser and prints a stability summary (`summarizeStability`) instead of a single result: runs by result kind, failures by `FailureCode`, business outcomes by name, escalations by reason / resolution / underlying outcome, recovery rules fired (app-error retries count there as `retry_app_error`), locator fallback depths and durations (a table; the same data under `--json`). Under `--fault` chaos it also echoes the seed and the target's chaos report (`docs/design/mock-app.md`, "Seeded chaos"). The exit code is the worst of the series |
| `--json` | stdout carries only the pretty-printed result JSON; everything else moves to stderr |

**`--fault` semantics.** The replay surface can never reach `/__faults`/`/__reset` (the default policy denies both).
Only the CLI process itself hits them, over a plain `fetch` outside the surface entirely. It snapshots the current
fault state, applies the requested fault(s), runs the replay (or the `--times` series), then always restores the
snapshot in a `finally`, even on a crash. The faults are applied once per series, not per run, so a seeded chaos
config's random streams run on across the whole series instead of handing every run the same faults; the CLI
reads `GET /__faults/chaos` after the series and before the restore.

**Exit codes** (`exitCodeForResult`, shared with `catalog invoke`): `success` 0, `business_outcome`
3, `hard_failure` 4, `escalated` 5, a crash 1.

### `approve <artifact.json> --by <name>`

The durable approval path (`docs/contracts.md` "Approval") refuses (exit 1) an artifact that is
invalid, or already `approved`/`deprecated`. It also refuses one with no successful replay under
`--runs-dir` for the same id and version, unless `--force`. On success: `status: 'approved'`, patch version bumped,
an approval line appended to `provenance.notes`, re-validated and written back.

### `validate <artifact.json>`

Static check only (no surface, no policy, no run directory): `validateCapability` on the parsed
JSON. Valid: `valid: <id>@<version> (<status>, <n> steps, risk <riskLevel>)`, exit 0. Invalid:
`invalid: <path>` plus one issue line per problem, exit 1.

### `catalog list|tools|invoke`

`--dir <path>` (default `artifacts`) is shared by all three, scanned recursively for `*.json`. The
highest semver version wins for a duplicate id, except that any non-deprecated version outranks a
`deprecated` one, so deprecating the newest version falls back to the highest non-deprecated one.
An id whose every version is deprecated is still listed, but has no tool definition and `invoke`
refuses it. Anything invalid is reported by `list`, never silently dropped.

- `list`: a table (id, version, status, risk, inputs -> outputs, file), then a `skipped:` section.
- `tools`: the `ToolDefinition[]` (Anthropic tool-use shape) for every valid, non-`deprecated`
  capability; `draft` and `sensitive` are called out in the descriptions.
- `invoke <id> --input <name=value>...`: runs `Catalog.invoke` through the same `runReplay`
  wiring as `replay` (same exit codes); an unknown id rejects with the list of known ids.

### `catalog search`, `audit`, `optimize`

Three later commands, each with its own design note:

- `catalog search <query>` ranks capabilities for a task description with no model, and
  `catalog tools --brief | --id | --query` serves a small tool list first and the full definition
  on request (`docs/design/capability-selection.md`).
- `audit <artifact.json>` judges every committing action of a capability with the risk judge
  (`docs/design/risk-judge.md`). It is one of the few commands allowed to reach a model, and it
  never replays.
- `optimize <artifact.json>` replays variants of a capability through the same `runReplay`
  wiring as `replay`, only under a read-only declaration (`docs/design/optimize.md`). It loads
  the run's credentials once and hands every trial the same set.

`compose()` also picks the surface from the base URL's scheme: `desktop://<process>` builds the
Windows UI Automation surface instead of Chromium (`docs/design/desktop.md`). The credential
provider (`--credentials`, `docs/design/credentials.md`) and the policy's screen-masking rules
(`docs/design/screen-masking.md`) are threaded through the same composition root.

### `operator [--demo] [--port 4300]`

A standalone console cannot attach to another process's live browser: the `SessionBroker` lives in-process with whatever automation it guards. Without `--demo` it explains that and exits non-zero; with `--demo` it runs a self-contained `FakeSurface` walkthrough in this process instead, on Relay (`apps/cu/src/commands/operator-demo.ts`, `startOperatorDemo`/`runOperatorDemo`, no real browser). For a real handoff against the live mock app, use `replay --headed` or `discover --headed`, which start the console in-process with the browser.

### `discover`

Wires `compose()` to the discovery agent: builds typed inputs/outputs from repeatable
`--input`/`--sensitive`/`--output` flags, runs `discover()`, then validates and secret-scans the
resulting capability before writing it to `artifacts/<id>.json`. That default path is never
overwritten: if the file already exists the run refuses to start, and if it appears during the run
the capability is written into the run directory instead. `--out <path>` chooses the path
explicitly and is written as given, replacing any existing file. `--auto-operator` takes `none` (default), `approve`
or `abort`, and `--allow-unattended-irreversible` widens `approve` as described above. With
`--extend <artifact.json>` the result is a new minor version with `status: 'draft'`. See
`docs/design/agent.md`.

## Demo path

Run from the repo root (`npm run --silent` keeps npm's banner off stdout, needed when piping
`--json`); `discover` needs `ANTHROPIC_API_KEY` in the environment or `.env`, nothing else does.

```bash
npm run mock-app   # terminal 1: tenant A on :4173 (MOCK_TENANT=b MOCK_PORT=4174 for tenant B)

# terminal 2: discover writes a new draft to artifacts/my-lookup.json, then replay it
npm run discover -- --goal "Log in to the workstation, look up member {memberId} and read their current savings balance and member name." \
  --input memberId=12345 --output savingsBalance:number --output memberName:string \
  --id lookup-member-savings-balance --out artifacts/my-lookup.json
npm run --silent replay -- artifacts/my-lookup.json --input memberId=12345

A=artifacts/lookup-member-savings-balance.json   # the shipped, approved artifact the table below uses
npm run --silent replay -- $A --input memberId=12345
```

Progress, the console URL, the run directory and the final control state go to stderr; stdout
prints the result description (which already ends with its own "Locator drift: ..." sentence) and
the `result.json` path. The shipped artifact against other `--input`/`--fault`/`--tenant` values
exercises every result kind (see `docs/design/replay.md`). The hand-written example
(`artifacts/examples/lookup-member-savings-balance.example.json`) behaves the same, except that it
names the access-denied outcome `access_denied`.

| Flags | Result |
|---|---|
| `--input memberId=99999` | `business_outcome member_not_found` |
| `--input memberId=90001` | `business_outcome member_access_denied` |
| `--input memberId=abc` | `hard_failure input_validation` |
| `--fault '{"failSearch":true}'` | `hard_failure app_error` |
| `--fault '{"failSearch":true}' --read-only` | two `retry_app_error` recoveries (the run restarts from s01 each time), then `hard_failure app_error` |
| `--fault '{"chaos":{"seed":5,"failSearch":0.2}}' --read-only` | the search fails once; one `retry_app_error`, then `success` |
| `--fault '{"expireSession":true}' --auto-operator relogin` | `escalated resumed_success`, `control: automation` |
| same, `--auto-operator abort` | `escalated abandoned`, `control: terminated` (see handoff.md limits) |
| `--tenant b` | success via the `riverbend-fcu` override |

For a real handoff, run the `expireSession` case `--headed` and without `--auto-operator`: the run
pauses at s04 (the sign-on click) with the hand-written example, or at s06 (typing the member id) with the
shipped artifact. Open `http://127.0.0.1:4300`, take control, log in again in the Chromium window, and
hand back with the default choice, "Start again after sign-in": replay resumes at the first step after the
sign-in (s05 in the example, s06 in the shipped artifact), whichever step the expiry was found at. "I
completed this step, continue" is right only when you did the failing step yourself. With the example that
is the sign-on, so it works there. With the shipped artifact it is typing the member id, and handing back
that way after only signing in searches an empty form and reports `member_not_found`
(`docs/design/replay.md`, "Resuming at another step"). The run resumes on the same browser session; the intervention record
and captured (value-redacted) human actions are in the run directory, laid out as in
`docs/design/replay.md` and `docs/design/handoff.md`.

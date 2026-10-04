# @cu/cli

`cu` is the command-line tool. It discovers a capability with an LLM, replays it deterministically, hands off to a human operator, and records approvals. The package also holds two pieces that other code builds on:

- `apps/cu/src/runtime` is the composition root. It wires `@cu/core` to the `@cu/adapter-playwright`, `@cu/adapter-desktop` and `@cu/adapter-anthropic` adapters, and mounts the Relay console for human handoff.
- `apps/cu/src/catalog` is the agent-facing catalog, built on that runtime.

The package depends on `@cu/core`, `@cu/relay`, `@cu/adapter-playwright`, `@cu/adapter-desktop`, `@cu/adapter-anthropic`, `@cu/adapter-jev`, and `@cu/adapter-credentials`.

## Run it

`cu` runs from source through `tsx`, with no build step. `bin.cu` points at `src/index.ts` directly.

Commands resolve `policies/`, `runs/`, and `artifacts/` relative to the current directory, so run `cu` from the repo root (`npm run cli -- ...`), not from inside `apps/cu`.

The root scripts `npm run cli`, `npm run discover`, `npm run replay`, `npm run operator`, and `npm run approve` each run `tsx apps/cu/src/index.ts <command>`. `cu optimize` has no root script of its own; run it as `npm run cli -- optimize ...`.

## Relay console

The composition root mounts Relay (`@cu/relay`, in `apps/relay`) as the human-in-the-loop console. Any command that starts its own console (`replay`, `discover`, `catalog invoke`, and `operator --demo`) builds Relay's UI into `apps/relay/dist` on demand. The build runs the first time a console starts in a fresh checkout, and again whenever `apps/relay/src/ui` or `apps/relay/src/shared` is newer than the last build. The check is `ensureRelayBuilt` in `apps/cu/src/runtime/relay-ui.ts`.

To avoid that first-start delay, or to pre-build for a headless host, run `npm run build:relay`.

## Operator port

`--operator-port <n>` on `discover`, `replay`, and `catalog invoke` sets the port Relay's console binds to. `0` means an ephemeral port that the OS assigns. An explicit `--operator-port` always overrides the defaults in the following table, which also shows what happens when the port is busy.

| Command | Default port | If the port is busy |
|---|---|---|
| `discover` | Always the well-known port (`DEFAULT_OPERATOR_PORT`, 4300), because a person may need to find the console. | Continues without a console and logs a warning. |
| `replay`, `catalog invoke` | 4300 when you pass `--headed` or `--auto-operator` is `none`, since a human may need the console. Otherwise `0`: a headless run with a scripted `--auto-operator` resolves every escalation itself, so no console needs a discoverable port. | Starts the console on an OS-assigned port and logs a warning with its URL. |

`resolveOperatorPortDefault` in `apps/cu/src/operator-port.ts` picks the `replay` and `catalog invoke` default.

`cu operator --demo` has its own `--port` flag with the same 4300 default. That flag is unrelated to `--operator-port`: the demo never attaches to a live run, only to its own `FakeSurface` walkthrough.

## Finding a capability

`catalog list` browses everything; the commands below find and load capabilities progressively, so a caller (or a model) never has to read the whole catalog. All take `--dir <path>` on `catalog` (default `artifacts`).

| Command | What it prints |
|---|---|
| `catalog search "<text>" [--top-k n] [--json] [--include-deprecated] [--approved-only]` | Ranked table: rank, id, version, status, score, which fields matched (with the query words), one-line description. `--json` prints `{ query, topK, results: [...] }`. Default top 10. |
| `catalog tools --brief` | Level 1: a JSON array of `{ id, name, description, status, riskLevel }`, one line each (`name` is the tool name, which differs from `id` only for ids over 64 characters; `--id` accepts either). |
| `catalog tools --id <id>` | Level 2: the full tool definition for one capability. An unknown id fails and suggests close matches; a deprecated one is refused. |
| `catalog tools --query "<text>" [--top-k n] [--brief]` | Full definitions (or briefs) for the search shortlist only, best first. |
| `catalog tools` | Unchanged: every non-deprecated definition. |

Search is deterministic keyword ranking (BM25F over id, name, description, inputs, outputs, business outcomes and app/tenant metadata); it needs no model and no network. It excludes deprecated capabilities unless asked, includes drafts (marked by `status`; `--approved-only` on `search` and `tools` drops them, and a selector should always pass it, because `catalog invoke` refuses only deprecated capabilities), and returns nothing rather than a guess when no word matches. `--top-k` must be a positive integer; `--brief` with `--id`, and `--id` with `--query`, are errors. The one-line description is the first sentence of the capability's description, capped at 120 characters. The design, measured scale and what is not built (a model-driven selector, meaning-based matching, a persisted index) are in [`docs/design/capability-selection.md`](../../docs/design/capability-selection.md). `npx tsx apps/cu/scripts/catalog-scale-bench.ts 2000` reproduces the timings.

## Credentials

A capability's secret bindings (`{"kind": "secret", "env": "NAME"}`) name a credential; the run decides where its value comes from. The global `--credentials <spec>` flag, or the `CU_CREDENTIALS` variable, picks the source:

| Spec | Source |
|---|---|
| `env` (default) | Environment variables, after `.env` is loaded. |
| `file:<path>` | A JSON object or `KEY=VALUE` file. Refused when it sits inside a git work tree and is not git-ignored. |
| `exec:<command>` | A credential helper: gets `{"names": [...]}` on stdin, prints a JSON object of values on stdout. Runs without a shell. |

```bash
npm run --silent replay -- artifacts/lookup-member-savings-balance.json --input memberId=12345 --credentials file:../creds.json
CU_CREDENTIALS='exec:node ../vault-helper.mjs' npm run --silent replay -- artifacts/lookup-member-savings-balance.json --input memberId=12345
```

`discover --secret NAME` (repeatable) names the credentials the agent may bind. Without it, the list is the mock app's `MOCK_USER` and `MOCK_PASSWORD`, which `cu` defaults to the mock's demo login when they are unset. A missing credential stops `discover`, `replay` and `catalog invoke` before any browser launches, naming the missing names and the source, never a value. See `docs/design/credentials.md`.

## Desktop apps

The base URL's scheme selects the surface. An http(s) `--base-url` drives Chromium; `--base-url desktop://<process-name>` drives a Windows app through UI Automation (`@cu/adapter-desktop`, [`docs/design/desktop.md`](../../docs/design/desktop.md)). A desktop run needs one of two global flags:

- `--app-command "<command line>"` starts the app. The run owns its process tree and ends it when the run ends.
- `--attach-pid <pid>` drives an app that is already running and leaves it running.

The policy must list the `desktop://<process-name>` origin ([`policies/desktop.yaml`](../../policies/desktop.yaml) does for the mock desktop app). `discover` records `app.surface: 'desktop'` and starts at the app itself, so `--entry` has no default for a desktop run. `--fault` is web-only: the mock desktop app takes its faults from `MOCK_DESKTOP_FAULTS` or its control file ([`apps/mock-desktop/README.md`](../mock-desktop/README.md)).

## Unattended runs

`--auto-operator` answers escalations without a human. It accepts `approve` and `abort`, and on `replay` and `catalog invoke` also `relogin`. The default, `none`, leaves escalations to a human.

`relogin` re-runs the capability's own sign-in steps on the live session: its `auth` block, or, for an artifact without one, the same steps derived from it (entry navigation through the submit after the last secret-bound step, never past a step that uses the run's inputs). It binds their secrets from the run's credentials, waits for the signed-in condition, and hands back asking replay to resume at the first step after the sign-in, so whatever the lost session took (a typed member id) is entered again. Replay refuses that resume point if it would repeat or skip an irreversible step; `relogin` then aborts and the run needs a human. It knows nothing about any particular app.

On `discover`, `approve` doesn't confirm irreversible actions. The run refuses them, as it does under `discoveryMode: 'block'`, unless you also pass `--allow-unattended-irreversible`. That flag is the explicit opt-in to unattended irreversible work.

## Risk judge

On top of the policy's lexical patterns, `discover` asks a risk judge whether each committing action (click, select, Enter, `dismiss_dialog` accept, navigate) the patterns allow is in fact irreversible: a "Continue" that sends a transfer, an "OK" that confirms a deletion. A step the judge flags escalates to a human, is recorded `risk: irreversible` with `onFailure: escalate`, and from then on replay's approval gate enforces it with no model. Replay never calls a judge. See [`docs/design/risk-judge.md`](../../docs/design/risk-judge.md).

| Flag | Meaning |
|---|---|
| `--risk-judge auto` (default) | Claude (`createAnthropicJudge`) when `ANTHROPIC_API_KEY` is set, which `discover` needs anyway, so the default adds no second vendor. Else Jev (`@cu/adapter-jev`) when `TYPESAFE_API_KEY` is set, which can only happen in `cu audit` and `judge:eval`. |
| `--risk-judge jev` / `anthropic` | That adapter; refuses to start if its key is missing. `jev` needs `TYPESAFE_API_KEY`. |
| `--risk-judge off` | Lexical patterns only. |

The policy's `risk.judge` block decides how a judgment is used (`enforce`, `advise`, `off`), the probability threshold, the timeout, and what an unavailable judge means (`fail_closed`, the default, treats the action as irreversible). `discover` prints the active judge at start, prints one line if the judge goes down (with the `--risk-judge off` way out), and reports the judge call count in its summary. All judge construction lives in `src/commands/risk-judge.ts`. Only `index.ts`, `discover`, `audit` and the eval script may import it (or any other model-touching file); `packages/core/src/replay/no-llm.redteam.test.ts` scans every other file under `src/` for such an import, a computed `import()`, or a path into a model adapter. It is a static scan: it catches accidental wiring, not a deliberately disguised one.

`cu audit <artifact.json> [--risk-judge ...] [--apply] [--out <path>]` judges every committing action of an existing capability from what the artifact says (target descriptions and texts, step names, the capability description): base steps, tenant override extra steps, and recovery-rule actions, each row marked with its origin. It exits 2 when something is riskier than declared and not fixed, and 3 when the audit is incomplete (an action could not be judged, or no judge key is set under the default `auto`; pass `--risk-judge off` for a deliberate lexical-only audit). `--apply` raises what it can, bumps the patch version, resets the capability to `draft` for re-approval, and writes it back (or to `--out`), exiting 0, or 2 if a finding needs a human (an irreversible recovery action or override extra step). It never lowers a risk, and writes nothing when any action could not be judged.

`npm run judge:eval -- --judge jev|anthropic` runs the labelled cases in `apps/cu/eval/risk-judge-cases.json` through a real judge and prints a confusion matrix and the misses.

## Entry path

`discover --entry <path>` is a path under `--base-url`. The default is `/login`, and `--entry ""` starts at the base URL itself. Git Bash on Windows rewrites an argument that starts with `/` into a Windows path before the program sees it, so `--entry /` arrives as `C:/Program Files/Git/`. `discover` refuses an entry with a drive letter or a backslash, and a full URL, before anything starts. To pass a leading slash from Git Bash, prefix the command with `MSYS_NO_PATHCONV=1`, as in `MSYS_NO_PATHCONV=1 npm run discover -- ... --entry /login`, or drop the slash (`--entry login`). `--entry //` also arrives as `/` in Git Bash, but it reaches the program unchanged from any other shell, so don't rely on it.

## Output

By default, `discover` writes `artifacts/<id>.json` and never overwrites an existing file there. If that file already exists, the run refuses to start. To choose the path yourself, pass `--out <path>`. `discover` writes to that path exactly as given.

An output that discovery read from a masked element (see [`docs/design/screen-masking.md`](../../docs/design/screen-masking.md)) is recorded as `sensitive: true`. `replay` and `catalog invoke` return its value, but `result.json` and the event log hold `[REDACTED]`. The human summary shows `<sensitive>` in place of the value, and `--json` prints the full result, value included, because `--json` is the programmatic return channel. `discover` prints the outputs it extracted, values included, to the operator who ran it; its `result.json` holds `<masked:name>` instead.
## Optimization

Optimizing a capability means replaying it, and variants of it with steps removed, against the live app. Each change is verified by replay, and no model is involved. Because trials execute the capability, they run only for a capability the operator has declared read-only: replaying it, whole or with steps removed, changes nothing in the app. The system does not verify that declaration. Without it, the optimizer only analyses: it reports what it would look at and rewrites nothing.

Under the declaration, the optimizer:

- collapses exact repeats of the same field write
- drops checkpoints that already held before their step ran
- removes steps whose removal still replays to the same outputs

Even with the declaration, the optimizer only analyses when a step is irreversible (declared, or by policy) or when the capability has no outputs.

`discover` runs the optimizer before it writes a capability:

- With `--read-only` (recorded in the capability as `readOnly: true`), it optimizes under the declaration.
- Without it, it prints one line saying nothing was rewritten.
- The as-discovered capability is always saved first as `<run dir>/capability.json`.
- Ctrl-C stops the optimizer and still writes the discovered capability.
- The report goes to `<run dir>/optimize.json`.

| `discover` flag | Effect |
|---|---|
| `--read-only` | Declare the goal read-only. Required for optimization trials and for `--candidates`. |
| `--no-optimize` | Skip optimization. |
| `--optimize-max-trials <n>` | Cap the removal trials. Each trial is one replay. Default 25. |
| `--optimize-verify-runs <n>` | Number of consecutive successful replays the result must pass. Default 3. |
| `--candidates <n>` | Run the whole discovery n times (n times the model cost) and keep the verified candidate with the fewest steps, if all verified candidates agree on the outputs. Every candidate stays in its run directory as `candidate.json`. |

To optimize an existing artifact, use `cu optimize`:

```bash
npm run --silent cli -- optimize artifacts/lookup-member-savings-balance.json --input memberId=12345 --read-only
```

`cu optimize` writes a draft with its patch version bumped to `<name>.optimized.json` next to the input. It never overwrites the input, comparing real paths and ignoring case on Windows. It refuses to replace an existing default output unless you pass `--out`. It writes nothing for analysis-only runs or when nothing changed. Inputs are checked against the capability before anything starts. The report, which holds no input or output values, goes to `<runs-dir>/optimize-<run id>/optimize.json`.

Progress and validator warnings go to stderr, and the summary goes to stdout. The reason a run stopped short (analysis only, a baseline that did not replay, an interruption) is printed once, in the summary.

| `cu optimize` flag | Effect |
|---|---|
| `--read-only` | Assert the declaration for an artifact that lacks it. The declaration is written into the output. |
| `--analyze-only` | Never replay and never write an artifact. |
| `--max-trials`, `--verify-runs` | Same as the `discover` flags. |
| `--trial-delay-ms <n>` | Pause between trials, to keep a polite pace against a real site. |
| `--removal-timeout-ms <n>` | Step timeout for removal trials. Default 5000. |
| `--json` | Print the report as JSON. |

`--base-url`, `--policy`, `--runs-dir` and `--tenant` work as they do for `replay`.

Exit codes: `0` done, `2` the unmodified capability didn't replay to success (nothing rewritten), `1` error, `130` interrupted.

Each trial runs in a fresh browser context with no console, an aborting operator, and the approval gate forced on. Trials replay a draft copy under a prerelease version (`x.y.z-optimize.n`). `cu approve` also requires the replay's content digest to match the artifact. See [`docs/design/optimize.md`](../../docs/design/optimize.md).

## Tests

To run the tests, use either command from the repo root:

```bash
npx vitest run --project cli
# or
npm test -w @cu/cli
```

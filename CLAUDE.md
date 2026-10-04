# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A computer-use capability runtime. An LLM discovers how to do a task in a legacy app once
(`discover`), the run is recorded as a typed, versioned capability artifact (JSON), and from then on
the artifact replays deterministically with no model in the loop (`replay`). When replay can't
proceed safely it escalates to a human on the same live session through Relay, the operator
console, and resumes after they hand control back. The main target is `apps/mock-app`, a
deliberately legacy-looking credit-union workstation (framesets, table layouts, div buttons, no test
IDs) with fault injection and seeded chaos. A second target, `apps/mock-desktop` (Teller
Workstation, Windows Forms), is driven through Windows UI Automation by the same runtime.

Frame everything as a sample system for automating a legacy back-office app. Don't add references
to any specific company. The unit of work is a "capability", never a "recipe".

## Commands

npm workspaces monorepo, Node 22. No build step: `tsx` and `vitest` run `.ts` source directly, and
every package's `exports` points at `./src/**/*.ts`.

```bash
npm install && npx playwright install chromium
npm run typecheck        # every workspace + tests/
npm run lint             # includes the dependency-direction rules (see below)
npm test                 # all vitest projects: unit + e2e
npm run test:unit        # everything except e2e
npm run test:e2e         # tests/, Chromium against the real mock app, one file at a time
```

CI (`.github/workflows/ci.yml`, ubuntu-latest) runs `typecheck`, `lint`, `test`, in that order.

Run a single test file or test. Tests are vitest projects defined in the root `vitest.config.ts`:
`core`, `adapter-playwright`, `adapter-desktop`, `adapter-anthropic`, `adapter-jev`,
`adapter-credentials`, `cli`, `mock-app`, `relay`, `browser-agent`, `e2e`.

```bash
npx vitest run packages/core/src/replay/replay-success.test.ts
npx vitest run --project core -t "part of the test name"
```

Desktop tests that open real windows (`packages/adapter-desktop/src/mock-desktop.integration.test.ts`,
`tests/e2e/desktop.test.ts`) run only on Windows; elsewhere the adapter is tested against an
in-process fake bridge. `judge.live.test.ts` in `adapter-anthropic` and `adapter-jev` call a real
model and are skipped unless the key is set. The full `npm test` is memory-hungry (several
Chromium suites); when the machine is short of memory, run one project or one file set at a time.
`tests/fixtures/storefront` is a small div-and-flexbox shop the e2e suite uses to check that
discovery and replay are not tailored to the mock app's table markup.

Running the system (mock app first, in its own terminal):

```bash
npm run mock-app                              # tenant A on :4173
MOCK_TENANT=b npm run mock-app                # tenant B on :4174
npm run mock-desktop                          # Teller Workstation (Windows only)
npm run --silent replay -- artifacts/lookup-member-savings-balance.json --input memberId=12345
npm run --silent cli -- <validate|approve|audit|optimize|catalog|discover|replay> --help
npm run --silent cli -- catalog search "savings balance"
npm run judge:eval -- --judge anthropic       # risk-judge eval set (27 cases); also jev
npm run operator                              # handoff demo on an in-memory surface, Relay on :4300
```

Replay exit codes: 0 `success`, 3 `business_outcome`, 4 `hard_failure`, 5 `escalated`. Faults are
injected with `--fault '{"failSearch":true}'`, `'{"expireSession":true}'`, and so on; seeded chaos
with `--times N --fault '{"chaos":{"seed":42,"failSearch":0.2}}'`. `cu audit` exits 0 clean, 2
riskier than declared, 3 incomplete, 1 bad input. `cu optimize` exits 0 done, 2 baseline failed,
1 error, 130 interrupted. `replay --read-only` (and `catalog invoke --read-only`) asserts that the run
changes nothing in the app; it turns on the app-error retry and is refused with `policy_violation` on
anything irreversible. docs/reference.md has the full replay scenario matrix.

Model keys: `discover` needs `ANTHROPIC_API_KEY`; `cu audit` and `judge:eval` need a judge key
(`ANTHROPIC_API_KEY`, or `TYPESAFE_API_KEY` for Jev; `--risk-judge auto` uses Claude when
`ANTHROPIC_API_KEY` is set, else Jev).
`ANTHROPIC_JUDGE_MODEL` overrides the Claude judge's model. Every test runs offline: e2e drives the
discovery agent with a scripted LLM (`packages/core/src/agent/scripted-llm.ts`), and the judge
adapters are tested against injected fakes. The CLI loads `.env` from the current working directory
(`apps/cu/src/env.ts`, no dotenv) and defaults `MOCK_USER`/`MOCK_PASSWORD` to the demo credentials.
`--credentials env|file:<path>|exec:<command>` (or `CU_CREDENTIALS`) picks where secret bindings
resolve; `discover --secret NAME` names the credentials the agent may bind.

A desktop run is `--base-url desktop://<process>` plus `--app-command "<command line>"` or
`--attach-pid <pid>`, under a policy that allows that origin (`policies/desktop.yaml`).

Windows PowerShell: call `npm.cmd`, not `npm`. The `npm.ps1` shim drops `--`, so flags meant for the
script go to npm instead. In Git Bash, an argument that starts with `/` (`--entry /`) is rewritten
into a Windows path unless `MSYS_NO_PATHCONV=1` is set.

## Architecture

Hexagonal. `packages/core` is the domain and its ports, and knows nothing about Chromium, Windows or
any model vendor. Adapters implement the ports, and `apps/cu` is the composition root
(`apps/cu/src/runtime/compose.ts`), which picks the surface from the base URL's scheme. The full map
is in `docs/design/architecture.md`, and the types are in `docs/contracts.md`.

Ports:
- `Surface` (`packages/core/src/surface/types.ts`): perceive and act on the app. Implementations are
  `@cu/adapter-playwright` (Chromium), `@cu/adapter-desktop` (Windows UI Automation over a
  PowerShell-hosted C# bridge) and `FakeSurface` (`core/src/surface/fake/`, in-memory, used by most
  unit tests).
- `LlmClient` (`packages/core/src/agent/types.ts`): implemented by `@cu/adapter-anthropic` and the
  scripted LLM for tests.
- `RiskJudge` (`packages/core/src/policy/judge.ts`): implemented by `@cu/adapter-jev` and
  `createAnthropicJudge` in `@cu/adapter-anthropic`. Built from flags and environment only in
  `apps/cu/src/commands/risk-judge.ts`.
- `CredentialProvider` (`packages/core/src/credentials/types.ts`): the `env` provider in core, and
  `file:` / `exec:` in `@cu/adapter-credentials`.
- `EscalationHandler` (`packages/core/src/session/types.ts`): the seam the session broker exposes
  and Relay plugs into.

Core modules, each depending only on the ones above it: `schema` → `credentials` → `evidence` →
`surface` → `policy` → `session` → `replay` → `optimize` / `agent`. One core module may import
another only through that module's `index.ts` (lint-enforced; the order itself is convention).

**Dependency rules are enforced by lint, not convention.** `eslint.config.js` uses
`no-restricted-imports` to stop core importing any workspace package and to limit adapters
(`packages/adapter-*`) to `@cu/core` and `@cu/browser-agent`. `apps/cu` may import core, `@cu/relay`
and the five adapters. `apps/mock-app` may import only `@cu/browser-agent`, `apps/mock-desktop`
imports no workspace package, and `apps/cu/src/{runtime,catalog}` must never import CLI files.
Across packages, import by package name (`@cu/core/replay`), never by a relative path.
`apps/relay` and `packages/browser-agent` have their own additional eslint configs: in Relay, only
`src/server/core.ts` may import `@cu/*`, and `src/ui` imports no server code or Node built-ins. When
lint rejects an import, the architecture is telling you something. Don't work around it.

Guarantees pinned by tests:
- Replay never touches an LLM. `packages/core/src/replay/no-llm.redteam.test.ts` fails if any file
  outside `packages/adapter-anthropic` imports `@anthropic-ai/*`. It also fails if `replay`,
  `optimize`, `session`, `policy`, `surface`, `evidence` or `schema` reach `core/src/agent`,
  `@cu/adapter-anthropic`, `@cu/adapter-jev`, `api.anthropic.com`, `api.typesafe.ai`, or an
  `ANTHROPIC_*`/`TYPESAFE_*` env read, or load a module by a computed specifier. In `apps/cu/src`,
  only `commands/discover.ts` and `commands/risk-judge.ts` may import a model adapter or read a
  model key, and only `index.ts`, `discover.ts`, `discover-candidates.ts`, `audit.ts`,
  `judge-eval.ts` and `risk-judge.ts` may import a model-touching file. New LLM-touching code
  belongs in `agent/` or an adapter. It is a static scan: it catches accidental wiring, not a
  disguised one.
- `packages/core/src/credentials/process-env.redteam.test.ts` limits `process.env` reads in
  `packages/core/src` and `apps/cu/src` to an allowlist; only the `env` credential provider reads
  credentials.
- `packages/adapter-desktop/src/no-global-input.redteam.test.ts` fails if the desktop adapter or the
  mock desktop app calls anything that synthesizes global input or takes the foreground.
- `apps/mock-app/repo-hygiene.redteam.test.ts` checks `git ls-files`: no `.env` (only
  `.env.example`), nothing under `runs/`, no `.pdf`, no `APPROACH.md`, no API-key-shaped strings.
  Tests that need a key-shaped string build it at runtime, never as a literal.
- `*.redteam.test.ts` files in general pin the findings in `docs/design/security-review.md`; a new
  one gets a row there.

Domain rules that shape the code:
- Expected failures are typed results, not exceptions. Replay classifies against a closed
  `FailureCode` set. There are four result kinds (`success`, `business_outcome`, `hard_failure`,
  `escalated`). Recoverable conditions are handlers that fire mid-run and show up in the log, never
  as a result. Credential loading returns a typed `CredentialLoadResult` too.
- Targets carry an ordered fallback chain of locator strategies (`role`, `label`, `text`,
  `relative`, `css`, `bbox`, `automation_id`). The depth of the strategy that fired is the drift
  signal replay reports. A `relative` locator's anchor may be `exact`, `wholeWord` (case-sensitive)
  or bound to a column or container (`anchor.selector`, `within`). Replay refuses a positional
  (`css`/`bbox`) winner when an earlier naming locator was ambiguous, or when the step is a read and
  the chain has a naming locator (`packages/core/src/surface/positional-fallback.ts`); `cu validate`
  warns about a read with positional locators only (`positional_only_target`).
- The record rule (`packages/core/src/agent/recorder.ts`, `docs/design/browser-agent.md`): a target
  that belongs to a record named by a run input never keeps a positional locator, and its kept
  locators are verified on the live page at record time. A target that cannot be anchored on the
  input is refused or escalated at discovery, not recorded by position. Every recorded locator must
  find the element alone at record time or it is dropped, and a role locator on an input is recorded
  `exact` or not at all. A read also carries an `identity` check when its record container showed the input: replay
  fails `checkpoint_failed` when the container no longer shows it (`Surface.readRecordText`). The
  four cases that can still act on another record silently are listed in
  `docs/design/browser-agent.md`; a change to the
  recorder's scoping must keep `tests/e2e/record-*.test.ts` and `discover-lastname.test.ts` green.
- Redaction happens at the sink (the run logger) and when an artifact is emitted. `sensitive`
  inputs and `secret` bindings must never be persisted in plaintext. A secret binding's `env` field
  is a credential name, resolved by the run's `CredentialProvider`; core never falls back to
  `process.env`. Human actions captured during handoff record what was clicked, never the values.
- Screen masking happens at the `Surface`, before anything reaches the model, the evidence or the
  operator console (`docs/design/screen-masking.md`). The policy's `redaction.screen` block
  (`maskInputs`, `maskSelectors`, `maskLabels`, `maskTextPatterns`, `omitScreenshotUrlPatterns`)
  drives it on both surfaces. A value the model could not see is still extractable: the output is
  marked `sensitive` (`OutputSpec.sensitive`), returned to the caller and redacted wherever it
  would persist. New data that flows from the page to the recorder or a log must not carry masked
  text; the `screen-mask*.redteam.test.ts` files and the seeded leak fuzzer
  (`packages/adapter-playwright/src/screen-mask-fuzz.redteam.test.ts`) pin that.
- Policy (`policies/default.yaml`) allowlists origins (http(s), or `desktop://<process>`) and
  action types and marks irreversible controls. The CLI refuses to start a browser or app for an
  origin the policy doesn't allow, and narrows each run's policy to its own base URL. Point `cu` at
  another app with its own policy file (`policies/desktop.yaml`, `policies/saucedemo.yaml`); never
  widen `default.yaml`.
- The risk judge runs at record time (`discover`) and audit time (`cu audit`), never at replay. A
  judgment only raises risk; a raise is written into the artifact as `risk: irreversible` plus
  `onFailure: escalate`, and the approval gate enforces it.
- The optimizer replays variants of a capability only when it carries `readOnly: true` (the
  operator's unverified assertion); otherwise it is analysis-only. It never applies an unverified
  rewrite, and its output is always a `draft`. Its trials never retry an app error.
- Replay retries an `app_error` read from the page only on a run asserted read-only (`readOnly: true`
  or `--read-only`): it waits and restarts at a `navigate` step (the first step after sign-in when it
  is one, else step 0), at most `limits.maxAppErrorRetries` times (default 2), each listed as
  `retry_app_error` in `result.recoveries`.
- `cu approve` needs a successful replay of that version whose `capabilityDigest` matches the file.
- A hand-back may name `resumeAtStepId` (with `current_step` only); replay refuses a resume point
  that would repeat or skip an irreversible step and re-asks with `policy_block`. The scripted
  `relogin` re-runs the capability's `auth` steps (explicit or derived by
  `packages/core/src/schema/auth.ts`) and resumes after them. A plain `current_step` hand-back after
  a `session_expired` failure also resumes at the first step after sign-in (the engine's default,
  `stepAfterSignIn` in `replay/rewind.ts`); when that would repeat an irreversible step it re-runs
  the failing step alone, and Relay says so before the hand-back. `next_step` is taken at its word.

Build exceptions to the "no build step" rule:
- `@cu/browser-agent` bundles to `dist/cu-agent.js` (gitignored). The adapter injects that bundle,
  and the mock app serves it at `/static/cu-agent.js`. The bundle is built on demand, and the
  browser-agent tests rebuild it in `globalSetup`. It has a 48 KB size budget
  (`packages/browser-agent/test/package.test.ts`) and its own version (`src/version.ts`), which
  changes whenever the enumeration a page reports changes.
- Relay's browser UI is a static bundle in `apps/relay/dist` (gitignored). The CLI rebuilds it on
  demand (`ensureRelayBuilt`) when `src/ui` or `src/shared` has changed; `npm run build:relay`
  builds it explicitly.
- The desktop bridge (`packages/adapter-desktop/bridge/`) and Teller Workstation are C#, compiled by
  PowerShell `Add-Type` on first run and cached per user under `%LOCALAPPDATA%`.

## Outputs and artifacts

- `runs/` (gitignored): one directory per discover or replay run, containing `events.jsonl`,
  `result.json`, `shots/`, `dom/` and `interventions/`. Discovery runs add `transcript.jsonl`,
  `capability.json` (as discovered, before optimization), `optimize.json` and, with
  `--candidates`, `candidate.json`. `cu optimize` writes `runs/optimize-<runId>/optimize.json`.
- `artifacts/`: capability JSON. `discover` refuses to overwrite `artifacts/<id>.json` unless you
  pass `--out`. `approve` promotes a draft to approved and needs a successful, content-matched
  replay of that version under `runs/` (or `--force`). The shipped
  `artifacts/lookup-member-savings-balance.json` is approved and deliberately unchanged; `cu validate`
  warns about it (`redundant_repeated_step`, `unbound_outcome_detector`, `read_without_record_identity`).
- `evidence/`: curated run directories copied from `runs/`, committed on purpose. Regenerate the
  top level with `npm run evidence` (needs the mock app running; it rewrites `evidence/README.md`);
  don't hand-edit. `evidence/followups/` holds live runs of the later features and is not
  regenerated by that script.
- After changing the zod schemas in `packages/core/src/schema/`, run `npm run schema:export` to
  refresh `packages/core/schema/*.json`. No test checks that these are in sync.

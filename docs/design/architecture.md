# Architecture

npm workspaces: seven library packages, four apps, and tool and test trees that sit outside the
dependency rules. `packages/core` holds the domain and the ports. The Chromium and Windows desktop
surfaces, the Anthropic and Jev clients, and the non-environment credential providers are adapter
packages. The composition root (`runtime`) and the catalog live in `apps/cu`, and the operator
console is `apps/relay`.

## Packages

- `packages/core` (`@cu/core`). The domain: schema, the `Surface`, `LlmClient`, `RiskJudge` and
  `CredentialProvider` ports, the discovery loop, replay, the optimizer, policy, session/escalation,
  and evidence. Depends on no other workspace package; test code may import `@cu/mock-app` as a
  fixture.
- `packages/browser-agent` (`@cu/browser-agent`). The dependency-free in-page agent. It does
  accessible naming, enumeration of controls, label/value cells and leaf text blocks (a price
  `<div>`, a status `<span>`) under a shared cap, container anchors for a record's own name, the
  recorder-only record context, screen-mask planning and value-free human-action capture. A driver
  injects it, or an app includes it as a script tag (see `docs/design/browser-agent.md` and
  `docs/design/screen-masking.md`). Depends on nothing; lints under its own
  `packages/browser-agent/eslint.config.js`.
- `packages/adapter-playwright` (`@cu/adapter-playwright`). Implements `Surface` for Chromium.
  Depends on `@cu/core` and `@cu/browser-agent`, whose bundle it injects or reuses.
- `packages/adapter-desktop` (`@cu/adapter-desktop`). Implements `Surface` for native Windows apps
  through UI Automation, over a PowerShell-hosted C# bridge (see `docs/design/desktop.md`).
  Depends on `@cu/core` only; its tests may also use `@cu/mock-desktop`.
- `packages/adapter-anthropic` (`@cu/adapter-anthropic`). Implements `LlmClient` against the
  Anthropic SDK, and `RiskJudge` with a small Claude model (`createAnthropicJudge`). Depends on
  `@cu/core` only, and is the one package allowed to import `@anthropic-ai/*`.
- `packages/adapter-jev` (`@cu/adapter-jev`). Implements `RiskJudge` with Jev, TypeSafe's System
  One model, over raw `fetch` (see `docs/design/risk-judge.md`). Depends on `@cu/core` only.
- `packages/adapter-credentials` (`@cu/adapter-credentials`). Implements `CredentialProvider` for
  a credentials file (`file:`) and a credential-helper process (`exec:`) (see
  `docs/design/credentials.md`). Depends on `@cu/core` only.
- `apps/cu` (`@cu/cli`). The `cu` command, the composition root (`apps/cu/src/runtime/compose.ts`),
  and the capability catalog. Depends on `@cu/core`, `@cu/relay` and all five adapters.
- `apps/relay` (`@cu/relay`). The human-in-the-loop console: an HTTP app plus a browser UI, mounted
  in-process by `apps/cu`. Depends on `@cu/core` only, and only from `src/server/core.ts` (see
  `docs/design/relay.md`).
- `apps/mock-app` (`@cu/mock-app`). The target legacy web app, two tenants, fault injection and
  seeded chaos. Depends only on `@cu/browser-agent`, which it serves as its monitoring tag; other
  packages may depend on it, but only from tests.
- `apps/mock-desktop` (`@cu/mock-desktop`). Teller Workstation, the target Windows Forms app
  (C# compiled at launch). Its TypeScript helpers import no workspace package; adapter tests may
  depend on it.
- `tools/video`, `tools/evidence`. Demo video and evidence-directory builders. Depend on anything.
- `tests/e2e`. End-to-end tests against the real mock app in Chromium (and the real mock desktop
  app on Windows). Depend on anything.

## Modules inside core

| module | role | depends on |
|---|---|---|
| `schema` | Zod contracts, validator, templating, auth-block derivation, content digest, step equivalence, which locators are positional (`positional.ts`), shared constants | nothing |
| `credentials` | `CredentialProvider` port, `CredentialSet`, `loadCredentials`, the `env` provider | nothing |
| `evidence` | run logger, ids, key/pattern redactor, value scrubber | schema |
| `surface` | `Surface` seam, conditions, the positional-fallback rule replay applies to a resolution (`positional-fallback.ts`), FakeSurface, desktop-location parsing, URL and key shapes, the shared screen-masking text view (`mask.ts`: matcher, masked elements and descriptors, labelled lines, the omitted-screenshot placeholder) | schema |
| `policy` | policy loading, guard, policy-enforcing surface wrapper, `RiskJudge` port and the guarded judge | schema, surface |
| `session` | control-token broker, intervention store, scripted operator | schema, surface, evidence |
| `replay` | deterministic replay engine, resume points, stability summary | schema, surface, session, evidence |
| `optimize` | model-free, replay-verified capability optimizer | schema, replay |
| `agent` | LLM discovery loop, recorder, prompt, tools, record-time risk judging | schema, surface, policy, session, evidence |

Dependencies point down this table, and `schema` is the module almost every other module imports.
`credentials` imports nothing and nothing else in core imports it: the composition root loads a
`CredentialSet` and hands its `get` and `values` to replay, discovery and the redactor. `replay`
does not import `policy`; it codes against `PolicyGuardLike`, a structural subset of the guard.
`optimize` reaches a surface only through an injected trial runner, never directly.

Lint enforces two things about these modules: a module reaches another only through that
module's `index.ts`, and core imports no other workspace package. The order in the table is the
observed import graph, not a lint rule.

Expected failures are typed results, not exceptions: replay classification depends on a closed
`FailureCode` set, and exceptions would hide that set from the type checker.

## Ports

| Port | Defined in | Implementations |
|---|---|---|
| `Surface` | `packages/core/src/surface/types.ts` | `packages/adapter-playwright/src/index.ts` (Chromium); `packages/adapter-desktop/src/surface.ts` (`createDesktopSurface`, Windows UI Automation); `packages/core/src/surface/fake/surface.ts` (`FakeSurface`, in-memory, for tests) |
| `LlmClient` | `packages/core/src/agent/types.ts` | `packages/adapter-anthropic/src/llm.ts` (`createAnthropicClient`, re-exported from the package's `src/index.ts`); `packages/core/src/agent/scripted-llm.ts` (`createScriptedLlm`, for tests) |
| `RiskJudge` | `packages/core/src/policy/judge.ts` | `packages/adapter-jev/src/judge.ts` (`createJevJudge`); `packages/adapter-anthropic/src/judge.ts` (`createAnthropicJudge`); built from flags and environment only in `apps/cu/src/commands/risk-judge.ts` |
| `CredentialProvider` | `packages/core/src/credentials/types.ts` | `packages/core/src/credentials/env.ts` (`envCredentialProvider`, the default); `packages/adapter-credentials/src/file.ts` (`file:`) and `src/exec.ts` (`exec:`), chosen by `parseCredentialSpec` |
| Escalation seam (`EscalationHandler`) | `packages/core/src/session/types.ts` | `packages/core/src/session/broker.ts` (`createSessionBroker`); `packages/core/src/session/scripted-operator.ts` (for tests); wired up in `apps/cu/src/runtime/compose.ts` |
| Relay console handle (`RelayServerHandle`) | `apps/relay/src/server/start.ts` | `startRelayServer`, same file, wrapped by `startRelayConsole` (`apps/cu/src/runtime/relay-ui.ts`); registered and closed from `apps/cu/src/runtime/compose.ts`. Both accept an optional `authenticate` middleware; none ships |
| Relay's own broker port (`RelayBrokerPort`) | `apps/relay/src/server/ports.ts` | `apps/relay/src/server/broker-adapter.ts` (`fromSessionBroker`, `createSessionRegistry`), against `SessionBroker` |

The composition root picks the surface from the base URL's scheme: `desktop://<process>` composes
the desktop surface (`apps/cu/src/runtime/desktop.ts`), anything else Chromium.

## Dependency direction

```
apps/cu ---> apps/relay -----------> core
        \--> adapter-playwright ----\
        \--> adapter-desktop --------\
        \--> adapter-anthropic -------> core
        \--> adapter-jev -------------/
        \--> adapter-credentials ----/
adapter-playwright -----------------> browser-agent
apps/mock-app ----------------------> browser-agent   (no edge to core, the adapters or other apps)
apps/mock-desktop                                     (no edge to any workspace package)

tools/*, tests/e2e ---> anything
```

Enforced by `no-restricted-imports` in `eslint.config.js`: core imports nothing (tests may reach
`@cu/mock-app`); every `packages/adapter-*` package imports `@cu/core` and `@cu/browser-agent`
only (their tests may also reach `@cu/mock-app` and `@cu/mock-desktop`); `apps/cu` imports core,
`@cu/relay` and the five adapters; `apps/mock-app` imports only `@cu/browser-agent`;
`apps/mock-desktop` imports no workspace package; `tools/**` and `tests/**` are unrestricted.
Inside `packages/core`, one module reaches another only through that module's `index.ts`. Inside
`apps/cu`, `runtime/` and `catalog/` never import a CLI file. `apps/relay` keeps its own
boundaries (`apps/relay/eslint.config.js`): only `src/server/core.ts` may import `@cu/*`, and
`src/ui` imports no server code, no core, and no Node built-ins.

A second, narrower guard covers what eslint can't. The no-LLM scanner
(`packages/core/src/replay/no-llm.redteam.test.ts`):

- fails if `@anthropic-ai/*` is imported anywhere outside `packages/adapter-anthropic`;
- scans `replay`, `optimize`, `session`, `policy`, `surface`, `evidence` and `schema` for a path
  into `core/src/agent`, either model adapter, a vendor host (`api.anthropic.com`,
  `api.typesafe.ai`), or an `ANTHROPIC_*` or `TYPESAFE_*` environment read;
- in `apps/cu/src`, lets only `commands/discover.ts` and `commands/risk-judge.ts` import a model
  adapter or read a model key, and lets only `index.ts`, `discover.ts`, `discover-candidates.ts`,
  `audit.ts`, `judge-eval.ts` and `risk-judge.ts` import a model-touching file.

It is a static scan. A name or host assembled at runtime is invisible to it, so it catches
accidental wiring, not a deliberately disguised one. A third scan
(`packages/core/src/credentials/process-env.redteam.test.ts`) limits `process.env` reads in
`packages/core/src` and `apps/cu/src` to an allowlist, with the `env` credential provider as the
only reader of credentials.

## Exceptions

- The catalog lives in `apps/cu`, next to the composition root, not in core. Its invoke path runs
  a capability through `runReplay`, which lives in `apps/cu`'s runtime; putting the catalog in
  core would make core depend on the app.
- The optimizer's algorithm is in core, but its real trial runner
  (`apps/cu/src/runtime/run-optimize.ts`) is in `apps/cu`, for the same reason: a trial is a
  `runReplay` call.

## No build step

Everything runs from source: `tsx` executes `.ts` directly, `vitest` resolves it the same
way, and every package's `exports` field points straight at `./src/**/*.ts`. No package has a
compile step before running or testing.

The exceptions:

- Relay's browser UI is a static bundle (`index.html` plus `assets/app.js`) that a real browser
  loads, so it cannot run straight from `.ts` source. The CLI builds it on demand:
  `ensureRelayBuilt` (`apps/cu/src/runtime/relay-ui.ts`) builds into `apps/relay/dist`
  (gitignored) the first time a console starts in a fresh checkout, and again whenever
  `apps/relay/src/ui` or `apps/relay/src/shared` is newer than the last build; otherwise it reuses
  what is there. `npm run build:relay` builds it explicitly, ahead of time.
- `@cu/browser-agent` bundles to `dist/cu-agent.js` (gitignored), built on demand.
- The desktop bridge (`packages/adapter-desktop/bridge/`) and Teller Workstation
  (`apps/mock-desktop/src/TellerWorkstation.cs`) are C#, compiled by PowerShell's `Add-Type` the
  first time they run and cached per user under `%LOCALAPPDATA%`.

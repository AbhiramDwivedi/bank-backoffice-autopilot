# Extending the runtime

`packages/core` defines ports, adapter packages implement them, and `apps/cu` wires them together
(`apps/cu/src/runtime/` and the CLI commands). Five extension points have a port. Storage and the
catalog do not. Each section ends with where the seam is not clean today.

## Adding an adapter package

1. Create `packages/adapter-<name>`. It may import only `@cu/core` (`ADAPTER_RULE`,
   `eslint.config.js`).
2. Add it to `apps/cu/package.json` and to `CLI_RULE` in `eslint.config.js`.
3. Add it to the `typecheck`, `lint` and `test:unit` scripts in the root `package.json`, and to
   `vitest.config.ts`. These name each package. One left out is not linted or tested.

## 1. Model provider for discovery

- **Port:** `LlmClient` (`packages/core/src/agent/types.ts`): `model` and `complete(request)`.
- **Ships:** `@cu/adapter-anthropic`.
- **An adapter must:** take one system prompt and one user message per call, with no history;
  accept PNG images; offer 11 tools with JSON Schema inputs; return token counts; map a refusal to
  `stopReason: 'refusal'`; retry on its own, because a thrown error ends the run. The loop reads
  only the first tool call, so turn parallel calls off. Strict schemas are optional: core
  re-validates each call.
- **Not clean:** `discover` is hard-wired. `apps/cu/src/commands/discover.ts` imports
  `createAnthropicClient` and refuses to start without `ANTHROPIC_API_KEY`. No flag picks a
  provider. A second provider means editing that file, widening its entry in
  `packages/core/src/credentials/process-env.redteam.test.ts`, and adding the new package, host
  and key prefix to `packages/core/src/replay/no-llm.redteam.test.ts`. That scan names two
  vendors, so it does not guard replay against a third. Core's default model id is
  a vendor's (`agent/model.ts`), and the loop always asks for 16,000 output tokens.

## 2. Risk judge

- **Port:** `RiskJudge` (`packages/core/src/policy/judge.ts`): `id` and `judge(request, signal)`,
  returning `{ risk, pIrreversible, rationale? }`. Throw when you cannot judge. Core adds the
  timeout and the cache.
- **Ships:** `@cu/adapter-jev` and `createAnthropicJudge`.
- **To add:** in `apps/cu/src/commands/risk-judge.ts`, add a value to `RISK_JUDGE_CHOICES`, a
  factory, and a case in `resolveRiskJudge`. `discover`, `audit` and `judge:eval` read from there.
  Add the vendor to the no-LLM scan.
- **Not clean:** the choices are a closed list in code. `auto` hard-codes its order: Claude when
  `ANTHROPIC_API_KEY` is set, else Jev when `TYPESAFE_API_KEY` is set, else no judge.

## 3. Surface

- **Port:** `Surface` (`packages/core/src/surface/types.ts`): `observe`, `resolve`, `act`,
  `readText`, `check`, `waitFor`, `screenshot`, `domSnapshot`, `currentUrl`, `close`. Optional:
  `humanCapture`, `frameUrls`, `describeRef`, `isSameElement`, `recordContextOf`.
- **Ships:** Chromium and Windows UI Automation.
- **To add:** implement the port, mask the screen inside it, and add a branch in `compose()`.
  - *macOS:* the accessibility tree gives `role`, `label`, `text`, `relative` and `bbox`, as on
    Windows.
  - *Remote desktop, pixels only:* OCR gives `text`, `relative` and `bbox`. The record rule drops
    `bbox` for a target in an input's record, so that target needs a text anchor. Without
    `isSameElement`, discovery cannot verify it: it refuses the extract and records the action to
    escalate.
  - *Terminal emulator:* the same three kinds on a character grid.
- **Not clean:** `compose()` has one test: `desktop://` or Chromium. A third surface needs a new
  URL scheme in `allowlistOrigin` (`packages/core/src/policy/guard.ts`) and a new value in
  `app.surface` (`z.enum(['web', 'desktop'])`). A new locator kind is a schema change.
  `ComposeOptions` exposes Playwright's `Browser` type. Only the Chromium adapter implements
  `recordContextOf`, so elsewhere the record rule sees locators, not row text.

## 4. Credentials and sign-in

- **Port:** `CredentialProvider` (`packages/core/src/credentials/types.ts`): `id` and
  `load(names)`.
- **Ships:** `env`, `file:` and `exec:`. A secrets vault works today through an `exec:` helper
  script. OAuth2 and SSO providers are designed in [credentials.md](credentials.md), not built.
- **To add:** write a provider and add its prefix to `parseCredentialSpec`
  (`packages/adapter-credentials/src/spec.ts`). A library caller can pass a provider object to
  `runReplay` instead.
- **Not clean:** credentials load once per run, so a short-lived token is not refreshed. A
  credential can only be typed into a field: `Surface` cannot set a header. The scripted re-login
  aborts on MFA. The binding field is still named `env`. `discover` defaults its secret names to
  `MOCK_USER` and `MOCK_PASSWORD`, and `apps/cu/src/env.ts` fills in demo values for them.

## 5. Operator console and operator sign-in

- **Port:** `EscalationHandler` (`packages/core/src/session/types.ts`): a request in, a promise of
  a resolution out. The session broker implements it and exposes `takeControl`, `handBack`, `abort`
  and `recordHeartbeat`.
- **Ships:** Relay, and scripted operators (`approve`, `abort`, `relogin`).
- **To replace Relay:** call `compose()` without `operator` and drive `composition.broker` from
  your own tool.
- **To add an authenticator:** pass an Express middleware as `authenticate` to
  `startRelayConsole`, and pass the handle to `runReplay` as `operator: { server }`. A name it sets
  in `res.locals.operator` replaces the self-asserted one.
- **Not clean:** no authenticator ships and the CLI has no flag for one. The CLI's own
  `startRelayConsole` calls never pass `authenticate`, so the console under `cu` has no sign-in.
  Relay refuses a non-loopback host. `ComposeOptions.operator` is typed by Relay's handle, not by
  core.

## 6. Storage and the catalog

There is no port. To move storage today, sync `runs/` and `artifacts/` outside the runtime.

- **Run evidence:** `createRunLogger` writes `runs/<runId>/` on local disk. `RunLogger` exposes
  `dir`, discovery and the broker write their own files under it, and `cu approve` scans
  `runs/*/result.json`. `compose()` accepts no logger.
- **Intervention records:** the broker accepts an `InterventionStore`, but `compose()` does not
  pass one through. Its methods are synchronous, so a database needs an in-memory front.
- **Catalog:** `loadCatalog(dir)` reads every JSON file under a directory on each call.

## 7. Policy and tenant overrides

Policy is one YAML file per app, chosen with `--policy`. `compose()` also accepts a loaded `Policy`
object. There is no per-tenant policy layer. Tenant differences live in the capability's
`overrides[]`, chosen with `--tenant <key>`. Not clean: `compose.ts` hard-codes the mock app's
tenant aliases and base URL.

## Summary

| Extension point | Port | Ships today | Not built |
|---|---|---|---|
| Model provider | `LlmClient` | Anthropic | Provider selection in the CLI |
| Risk judge | `RiskJudge` | Jev, Claude | A registry |
| Surface | `Surface` | Chromium, Windows UIA | macOS, pixel-only, terminal |
| Credentials | `CredentialProvider` | `env`, `file:`, `exec:` | OAuth2, SSO, token refresh |
| Operator console | `EscalationHandler` | Relay, scripted operators | An authenticator, remote access |
| Storage | none | Local files | A database or object store |
| Catalog | none | A directory of JSON files | An index, a remote store |
| Policy | `Policy` schema | One YAML file per app | A per-tenant layer |

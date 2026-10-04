# @cu/core

`@cu/core` is the domain library that every other package wires up. It covers capability discovery, deterministic replay, model-free optimization, policy enforcement, session brokering, operator handoff, credentials, and evidence bundling.

The package defines ports and leaves the I/O adapters to other packages:

- `Surface`, in `packages/core/src/surface/types.ts`.
- `LlmClient`, in `packages/core/src/agent/types.ts`.
- `RiskJudge`, in `packages/core/src/policy/judge.ts`.
- `CredentialProvider`, in `packages/core/src/credentials/types.ts`. The default `env` provider lives here too, because it wraps nothing external.
- The human-escalation seam, in `packages/core/src/session`.

Browser automation lives in `@cu/adapter-playwright`, Windows desktop automation in `@cu/adapter-desktop`, the Anthropic client and a Claude risk judge in `@cu/adapter-anthropic`, the Jev risk judge in `@cu/adapter-jev`, and the `file:` and `exec:` credential providers in `@cu/adapter-credentials`. The operator console is also outside this package: it lives in `apps/relay` (`@cu/relay`), a delivery adapter for the escalation seam in `session`. For details, see [`docs/design/relay.md`](../../docs/design/relay.md).

The package runs from source with no build step. `exports` points straight at `.ts` files, which `tsx` and Vitest resolve directly.

## Modules

The package exports these entry points: `@cu/core/schema`, `@cu/core/credentials`, `@cu/core/surface`, `@cu/core/agent`, `@cu/core/replay`, `@cu/core/optimize`, `@cu/core/policy`, `@cu/core/session`, and `@cu/core/evidence`. `@cu/core/agent/test-helpers` is for tests only; `tests/e2e` uses it.

## Tests

To run the tests, use either command from the repo root:

```bash
npx vitest run --project core
# or
npm test -w @cu/core
```

## JSON Schema

To regenerate the JSON Schema files under `packages/core/schema/`, run `npm run schema:export` from the repo root. The script runs `packages/core/src/schema/export.ts`.

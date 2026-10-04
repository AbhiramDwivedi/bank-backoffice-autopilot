# @cu/adapter-anthropic

`@cu/adapter-anthropic` implements the `LlmClient` port against the Anthropic API. The port is exported from `@cu/core/agent` and defined in `packages/core/src/agent/types.ts`. This is the only package in the repo allowed to import `@anthropic-ai/*`.

It also implements the `RiskJudge` port (`@cu/core/policy`, see [`docs/design/risk-judge.md`](../../docs/design/risk-judge.md)) in `src/judge.ts`: `createAnthropicJudge()` asks a small, fast model (default the pinned `claude-haiku-4-5-20251001`; override with `model` or `ANTHROPIC_JUDGE_MODEL`) whether a pending action commits something irreversible, through one forced, strict `report_risk { risk, p_irreversible, rationale }` tool call. The page context is passed as untrusted data inside `<action_context>`.

The package depends on `@cu/core`. It runs from source through `tsx` with no build step: `exports["."]` points at `src/index.ts`.

## Tests

To run the tests, use either command from the repo root:

```bash
npx vitest run --project adapter-anthropic
# or
npm test -w @cu/adapter-anthropic
```

Every test runs offline against a fake SDK. `src/judge.live.test.ts` calls the real API and is skipped unless `ANTHROPIC_API_KEY` is set.

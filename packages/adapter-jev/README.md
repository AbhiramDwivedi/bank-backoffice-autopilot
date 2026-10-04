# @cu/adapter-jev

`@cu/adapter-jev` implements the `RiskJudge` port (exported from `@cu/core/policy`, defined in `packages/core/src/policy/judge.ts`) with Jev, TypeSafe's System One model. Jev returns typed judgments and probabilities instead of text, which is what a guardrail wants: a probability the code thresholds, not a sentence it parses.

The judge sends one request per action to `POST https://api.typesafe.ai/v1/systemone` with the action, the control, the page and the run's goal as named state fields, and two Noul (yes/no probability) questions over that state:

| Question | Becomes |
|---|---|
| `commits_irreversibly`: does this action commit something the operator cannot undo from the app (move money, create/submit/approve/delete a record, send a message)? | `pIrreversible` |
| `changes_state`: does it change stored data at all? | separates `read` from `reversible` |

Everything in the state is already scrubbed by the caller; typed values and screenshots are never sent. For why the judge exists, where it runs (discovery and `cu audit`, never replay) and what its answers can and cannot change, see [`docs/design/risk-judge.md`](../../docs/design/risk-judge.md).

## Configuration

```ts
import { createJevJudge } from '@cu/adapter-jev';

const judge = createJevJudge({ apiKey: process.env.TYPESAFE_API_KEY! });
```

| Option | Default | |
|---|---|---|
| `apiKey` | required | Sent only as `Authorization: Bearer`. Never appears in an error, a judgment or the judge object. |
| `model` | `jev-latest` | |
| `maxAttempts` | 3 | 429, 529, 502, 503 and network errors are retried with exponential backoff (honouring `retry-after`), inside the caller's abort signal. 401 and 422 are not retried. |
| `fetch` | global `fetch` | Injection seam for tests. |

The CLI builds this judge in `apps/cu/src/commands/risk-judge.ts`, from `TYPESAFE_API_KEY`, when you pass `--risk-judge jev` to `discover` or `cu audit`. The default, `--risk-judge auto`, uses the Claude judge when `ANTHROPIC_API_KEY` is set and falls back to Jev only when it is not.

## Tests

```bash
npx vitest run --project adapter-jev
```

Every test runs offline against an injected `fetch`. `src/judge.live.test.ts` calls the real API and is skipped unless `TYPESAFE_API_KEY` is set.

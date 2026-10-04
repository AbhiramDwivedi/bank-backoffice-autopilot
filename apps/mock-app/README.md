# CU Core Workstation (mock target app)

CU Core Workstation is a deliberately legacy, automation-hostile credit-union back-office app. Discovery and replay run against it. The [mock app design doc](../../docs/design/mock-app.md) explains the design and has a page-by-page table of what each page defeats. The route map and seed IDs are frozen in section 9 of the [contracts](../../docs/contracts.md). All data is fictional.

## Run

To start tenant A or tenant B in bash, run:

```bash
npm run mock-app                                  # tenant A, http://localhost:4173
MOCK_TENANT=b npm run mock-app                    # tenant B, http://localhost:4174  (bash)
```

To start tenant B in PowerShell, run:

```powershell
$env:MOCK_TENANT='b'; npm run mock-app            # tenant B (PowerShell)
```

The server reads these environment variables:

| Env | Default | Meaning |
|---|---|---|
| `MOCK_TENANT` | `a` | `a` = Pioneer Valley Community CU (frameset shell), `b` = Riverbend Federal Credit Union (iframe shell, "Member #", required Branch code) |
| `MOCK_PORT` | 4173 (A) / 4174 (B) | Listen port |
| `MOCK_HOST` | loopback (`127.0.0.1` and `::1`) | Bind address. Set one address (for example, `0.0.0.0`) to expose the app, including `/__faults` and `/__reset`, beyond this machine. |
| `MOCK_PASSWORD` | `demo-pass-123` | Password for user `operator1` |

By default the server binds only to the loopback interface, so other machines can't reach it.

To run the app in-process, import it from the package. Each instance has its own state, and `getContext` gives a test harness access to it:

```ts
import { createApp, getContext } from '@cu/mock-app/app';

const app = createApp({ tenant: 'a' });
app.listen(0);
const ctx = getContext(app); // live state, faults, and sessions
```

## Monitoring tag

Every rendered page includes the institution's monitoring (RUM) tag from `@cu/browser-agent`, the way a real core system adds one. The tag is `<script src="/static/cu-agent.js">`, the first child of `<head>`. `GET /static/cu-agent.js` serves it without authentication, delayed by `slowMs` like any other asset.

## Pages

The main flow runs through these routes:

`/login` -> `/workstation` (frames `banner`, `nav`, `main`) -> `/members/search` ->
`/members/:id` (`?tab=profile|accounts|notes`, `?warn=1`) -> `/members/:id/subaccounts/new` ->
`POST /members/:id/subaccounts` -> `/members/:id/subaccounts/:ref/confirmation`.

The app also serves `/session-expired` and `/logout`.

The seed data has these fixed members:

| Member ID | Behavior |
|---|---|
| `12345` | Jane Q. Sample (savings $1,234.56, checking $310.00) |
| `90001` | Restricted (403) |
| `99999` | Does not exist |
| `10001` to `10020` | General seed |

## Fault injection

The fault routes need no authentication and aren't delayed by `slowMs`, so test harnesses can always reach them.

| Route | Effect |
|---|---|
| `GET /__faults` | Returns the current flags as JSON. Posting this JSON back restores the switches and the chaos config, but not the chaos position: a posted `chaos` config restarts from its seed, with counters and log cleared. To restore switches without touching chaos that is running, post the JSON without its `chaos` key (`replay --fault` does this unless its own fault sets `chaos`). |
| `POST /__faults` | Merges the JSON body into the flags. The response lists the flags and any `rejected` keys (unknown key or wrong type). A non-object or malformed body returns HTTP 400. |
| `GET /__faults/chaos` | Returns the chaos config, per-kind draw and fire counters, and the ordered log of injected faults. Read-only. |
| `POST /__reset` | Restores the default flags (no chaos) and fresh seed data (the reference counter goes back to `SA-1000001`). Sessions are kept. |

The following flags are available:

| Flag | Default | Effect |
|---|---|---|
| `slowMs` | `0` | Delays every response outside the fault routes (pages and static assets) by N ms. |
| `failSearch` | `false` | `GET /members/search` returns HTTP 500 "Application Error" (ORA-01017). |
| `expireSession` | `false` | The next authenticated request destroys the session and redirects to `/session-expired`. The flag then clears itself. |
| `interstitial` | `true` | Injects a "System Maintenance Notice" div modal (OK div-button) once per session into the first main-content page. |
| `denyMember` | `''` | This member ID also returns the 403 Access Denied page (detail and sub-account routes). |
| `chaos` | `null` | Seeded, intermittent versions of the faults above. See [Seeded chaos](#seeded-chaos). |

To read, set, and reset the flags with curl, run:

```bash
curl localhost:4173/__faults
curl -X POST localhost:4173/__faults -H 'content-type: application/json' -d '{"failSearch":true,"slowMs":1500}'
curl -X POST localhost:4173/__reset
```

## Seeded chaos

Chaos makes faults fire on some requests only, with a probability, from a seeded random generator.
The same seed and the same sequence of member requests always produce the same faults, so a
`replay --times N` series under chaos is reproducible. The [design doc](../../docs/design/mock-app.md#seeded-chaos)
has the full model, the precedence rules and what breaks determinism.

To turn chaos on, read what it did, and turn it off, run:

```bash
curl -X POST localhost:4173/__faults -H 'content-type: application/json' \
  -d '{"chaos":{"seed":42,"failSearch":0.05,"interstitial":0.2,"expireSession":0.02,"slowMs":{"p":0.1,"minMs":500,"maxMs":3000}}}'
curl localhost:4173/__faults/chaos
curl -X POST localhost:4173/__faults -H 'content-type: application/json' -d '{"chaos":null}'
```

| Key | Value | Draws on | When it fires |
|---|---|---|---|
| `seed` | Integer 0 to 2^32-1. Required. | | |
| `failSearch` | Probability, 0 to 1 | Each `GET /members/search` | The 500 Application Error page. |
| `interstitial` | Probability, 0 to 1 | Each main-content page the once-per-session notice did not already take (every page, with `interstitial: false`) | The maintenance notice, again. |
| `expireSession` | Probability, 0 to 1 | Each authenticated `/members/...` request | The session is destroyed: 302 to `/session-expired`. |
| `slowMs` | `{"p": 0-1, "minMs": n, "maxMs": n}`, integers, `maxMs` at most 120000 | Each `/members/...` request | That one response is delayed by `minMs` to `maxMs` ms. |

Keep these rules in mind:

- Chaos is off by default. `{"chaos": null}` and `POST /__reset` turn it off.
- Each kind has its own random stream, so adding a kind or changing its probability never changes the numbers another kind draws. It can still change which request gets them: a search that fails ends the run early, so the pages after it never draw.
- Chaos draws only on `/members/...` requests, never on login, the shell frames, static assets or the `/__` routes.
- An explicit flag wins: with `failSearch: true`, every search fails and chaos does not draw for it.
- Every accepted `chaos` object restarts the streams from the seed and clears the counters and log, even if it is identical to the current one.
- An invalid `chaos` object is rejected as a whole and named in `rejected` (for example, `chaos.failSearch`); the previous chaos keeps running.
- The policy denies `/__faults` and everything under it to the automation, so a replay can never read or change chaos.

To run a reproducible series against the shipped capability, run:

```bash
npm run --silent replay -- artifacts/lookup-member-savings-balance.json --input memberId=12345 \
  --times 5 --auto-operator relogin --fault '{"chaos":{"seed":42,"failSearch":0.2,"interstitial":0.5}}'
```

The summary ends with the seed, how often each kind fired, the injected faults in order, and the
exact flags to re-run the series (quoted for bash; re-quote for PowerShell). Re-run against a mock
app that nothing else is using. If the app rejects any key of `--fault`, the CLI restores the
previous faults and exits 1 without running.

## Tests

To run the tests, use these commands from the repo root:

```bash
npx vitest run --project mock-app                        # HTTP-level suite (or: npm test -w @cu/mock-app)
npx playwright test -c apps/mock-app/e2e/playwright.config.ts # headless Chromium smoke through the frameset
```

## Package

The package is `@cu/mock-app`. It runs from source through `tsx`, with no build step.

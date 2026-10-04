# Mock app: CU Core Workstation

A deliberately legacy, automation-hostile credit-union back-office app. It stands in for the real
environment and is the target for the discovery goals in `docs/contracts.md` section 10. The route
map, texts, seed ids and fault flags are frozen in `docs/contracts.md` section 9; this doc does not
redefine them.

Vendor "Acme Core Systems", product "CU Core Workstation" 7.4.2. Two tenants run the same product
configured differently: tenant A "Pioneer Valley Community CU" (port 4173) and tenant B "Riverbend
Federal Credit Union" (port 4174). All data is fictional.

## Why it looks like this

The product reads as patched for about 15 years: every page is from a different era, with markup of
a different quality. A locator fallback chain (role, label, text, relative, css, bbox) should
hit different strategies on different pages.

| Page | Era | What it defeats |
|---|---|---|
| Login | 1998 | `getByLabel` (label text sits in an adjacent `<td>`, no `<label for>`); `getByRole('button', {name})` on the submit (an `<input type="image">` with no accessible name) |
| Shell | 2001 | naive `page.locator()` (content lives in a frame named `main`; tenant B uses an iframe instead, same name) |
| Search | 2005 | `getByRole('button')` (Search is a `div.btn`), `getByRole('link')` for results (row `onclick`, no anchor), header-based table locators (no `<thead>`) |
| Detail | 2008 | `getByRole('tab')` (tabs are bare `<span onclick>`) |
| Sub-account form | 2012 | `selectOption` (Account Type is a div plus `<ul>` writing a hidden input), native dialog handling for the confirm step (div overlay modal); `window.confirm` on leaving with unsaved changes |
| Confirmation | 2012 | reference number only identifiable by format (`SA-` plus 7 digits in a `<b>` in a table cell) |

## Runtime conditions

| Condition | Produced by | Replay classification it exercises |
|---|---|---|
| validation error | POST sub-account with missing type, non-numeric or under-$25 deposit, or (tenant B) a missing branch code -> form re-rendered with a red `<ul class="errors">` | business outcome (bad input) |
| record not found | search `memberId=99999` -> `<td class="msg">No records found.</td>`; `GET /members/99999` -> 404 page | business outcome `member_not_found` |
| permission denial | `GET /members/90001`, or the `denyMember` fault -> HTTP 403 "Access Denied: your role does not permit viewing this member." | business outcome (`member_access_denied` in the shipped artifact, `access_denied` in the hand-written example) |
| unexpected confirmation dialog | maintenance interstitial div modal (default on, once per session); `window.confirm` when leaving the dirty sub-account form | recoverable (dismiss) |
| session/timeout expiry | `expireSession` fault -> the next authenticated request redirects to `/session-expired` | recoverable (re-login) or escalate |
| transient slowness | `slowMs` fault delays every response | recoverable (wait) |
| outright app error | `failSearch` fault -> HTTP 500 "Application Error" page with `ORA-01017` | hard failure; on a run asserted read-only, retried first (bounded) |
| harmless noise | `?warn=1` on detail -> yellow "Your session will expire in 5 minutes" banner | must be ignored |
| intermittent trouble | seeded `chaos` (below): any of the above faults on some requests only | whatever the fault on that request exercises |

## Functional behavior

`GET /login` renders the 1998 login. `POST /login` with `operator1` and `MOCK_PASSWORD` (default
`demo-pass-123`) sets cookie `CUCWSESSID` and redirects to `/workstation`; wrong credentials
re-render with red "Invalid user ID or password." (HTTP 200). `GET /` redirects to `/workstation` if
logged in, else `/login`; `GET /logout` clears the session. Any authenticated route without a
session redirects (302) to `/login`.

`/workstation`: tenant A is a `<frameset>` with frames `banner`, `nav`, `main` (main src
`/members/search`). Tenant B is a table layout with `<iframe name="main">`, banner and nav inlined
in the same table (still reachable at `/frames/banner`, `/frames/nav`). The banner shows the
tenant's institution name and colors; nav is a table of links targeting `main` (tenant B too),
including "Member Search" and "Log Off" (target `_top`).

Search matches `memberId` exactly, else `lastName` case-insensitive prefix. Results render in nested
tables with no `<thead>`, zebra striping via inline `bgcolor`, and a row `onclick` that navigates to
`/members/:id`. A "Next >>" link pages 10 rows at a time. Zero results render `<td class="msg">No
records found.</td>` in red. The label reads "Member ID" on tenant A, "Member
#" on tenant B.

Detail has span tabs Profile | Accounts | Notes (`?tab=profile|accounts|notes`, switched
client-side). The profile table shows "Member Name", "Member ID", "Savings Balance" (`$1,234.56` for
member 12345), "Checking Balance" (`$310.00`). The Accounts tab lists sub-accounts with an "Open New
Sub-Account" link. `?warn=1` shows the yellow expiry banner. Member 12345 is Jane Q. Sample;
10001-10020 are seeded; 90001 is restricted (403 "Access Denied"); 99999 is absent (404).

The sub-account form uses a custom div dropdown (no `<select>`) writing a hidden `accountType`
input, a nickname field, and an initial deposit field with a `$` prefix span. Tenant B adds a
required "Branch code". "Continue" opens a div-overlay modal with "Confirm"/"Cancel" div-buttons.
Nav links ask `window.confirm("You have unsaved changes. Leave this page?")` when the form is dirty.
Server validation re-renders the form (HTTP 200) with a `<ul class="errors">` listing messages.
Examples: "Please select an account type.", "Initial deposit must be at least $25.00", or (tenant B)
"Branch code must be 3 digits.". Entered values are preserved. The nickname input has
`maxlength="40"` client-side but a 30-character server rule, a classic client/server mismatch that
makes a 31-40 character nickname a reachable validation error. Success appends to the member's
accounts, allocates `SA-1000001`, `SA-1000002`, ..., and redirects to a confirmation page showing
the reference number in a `<b>` inside a table cell.

`/session-expired` shows "Your session has expired. Click here to log in." linking to `/login`
(target `_top`). A maintenance interstitial ("System Maintenance Notice") is injected once per
session into the first main-content page while the `interstitial` fault is on (default on).
Icon-only image buttons (power, help, print, search, plus the login sign-on button) are rendered
PNGs with no alt, title or aria attributes. The search page also has a placeholder-only input and
color-only error indication.

## Fault injection

No auth, not delayed by `slowMs`. `GET /__faults` returns the current flags. `POST /__faults` merges
a JSON body and returns the new flags plus any rejected keys (a non-object or malformed body is HTTP
400, never a silent no-op). `POST /__reset` restores default flags (`interstitial: true`, everything
else off, no chaos) and a fresh seed (reference counter back to `SA-1000001`). `slowMs` delays every other
response, including static files, by N ms. `failSearch` makes `GET /members/search` return 500 with
an "Application Error" page mentioning `ORA-01017`. `expireSession` destroys the session on the next
authenticated request (302 to `/session-expired`) and then clears itself. `denyMember` makes that
member id's detail and sub-account routes return the 403 page.

`GET /__faults` is round-trippable for configuration: posting its JSON back restores the switches
and the chaos config, but not the chaos position, because a posted `chaos` config restarts from its
seed (see below). `replay --fault` and the video recorder snapshot the flags and restore them
afterwards, so nothing that is runtime state (chaos counters, the chaos log) is part of the
snapshot; that lives at `GET /__faults/chaos`. Both leave `chaos` out of what they restore unless
their own fault body set `chaos`: a `--fault '{"failSearch":true}'` run against an instance with
chaos already running restores `failSearch` and leaves the chaos streams where they were, instead of
rewinding them. A fault body that does set `chaos` restores the previous chaos config, `null`
included, and that restart is inherent.

## Seeded chaos

The switches above are all-or-nothing, and the stateful ones are predictable, so on their own they
only ever test the replay engine against a perfectly predictable app. Real legacy apps fail
intermittently: a search errors once in twenty, a maintenance popup shows up some days, a session
dies in the middle of a lookup. Chaos makes the same faults fire with a probability per request,
from a seeded random generator, so `replay --times N` measures resilience to intermittent trouble
and a failing series can be re-run fault for fault.

### Contract

Chaos is a property of one app instance, set through the existing endpoint:

```bash
curl -X POST localhost:4173/__faults -H 'content-type: application/json' -d '{
  "chaos": {
    "seed": 42,
    "failSearch": 0.05,
    "interstitial": 0.2,
    "expireSession": 0.02,
    "slowMs": { "p": 0.1, "minMs": 500, "maxMs": 3000 }
  }
}'
curl localhost:4173/__faults/chaos                     # config, counters, log of injected faults
curl -X POST localhost:4173/__faults -H 'content-type: application/json' -d '{"chaos":null}'   # off
```

| Key | Type | Fires on | Effect when it fires |
|---|---|---|---|
| `seed` | integer 0..2^32-1, required | | seeds every stream |
| `failSearch` | probability [0,1] | each `GET /members/search` | the 500 "Application Error" page |
| `interstitial` | probability [0,1] | each main-content page (search, detail, sub-account form, confirmation, member 404) that the once-per-session notice did not already take | the "System Maintenance Notice" modal |
| `expireSession` | probability [0,1] | each authenticated `/members/...` request | session destroyed, 302 to `/session-expired` (the flag itself is not touched) |
| `slowMs` | `{p, minMs, maxMs}`, integers, `0 <= minMs <= maxMs <= 120000` | each `/members/...` request | that one response delayed by a uniform integer in `[minMs, maxMs]`; a delay that comes out at 0 ms (only possible with `minMs: 0`) counts as a draw, not as fired, and is not logged |

Omitted kinds never draw. `slowMs` is the one chaos-only shape: the switch delays every response,
chaos delays a single request, the way one slow transaction looks on a real system. It takes an
explicit `{p, minMs, maxMs}` object rather than a bare `[min, max]` range, so there is exactly one
shape and the probability is never implied.

Validation follows the rest of `mergeFaults`: an unknown kind, a missing or non-integer seed, a
probability outside [0,1], or a malformed `slowMs` is rejected and named (`chaos.failSearch`,
`chaos.slowMs.maxMs (must be >= minMs)`, ...), never ignored. The chaos object is validated as a
whole: one bad sub-key rejects all of it and leaves the previous chaos state (config, streams,
counters, log) untouched. Other top-level keys in the same body still merge on their own, as they
always have.

`GET /__faults/chaos` returns:

```json
{
  "config": { "seed": 42, "failSearch": 0.05 },
  "stats": { "failSearch": { "draws": 37, "fired": 2 } },
  "log": [
    { "seq": 1, "kind": "failSearch", "draw": 14, "method": "GET", "path": "/members/search" },
    { "seq": 2, "kind": "failSearch", "draw": 31, "method": "GET", "path": "/members/search" }
  ],
  "logDropped": 0
}
```

`log` is every injected fault in order: `seq` across all kinds, `draw` within the kind's own stream,
the request path without its query string, and `delayMs` for `slowMs`. It holds no session ids,
cookies, query strings or credentials, and keeps the latest 1000 entries (`logDropped` counts the
rest).

### Precedence

An explicit switch always wins for the same fault, and chaos only draws where the switch would not
already inject it on that request: `failSearch: true` fails every search and the chaos `failSearch`
stream never draws; `slowMs > 0` delays as configured and the chaos `slowMs` stream never draws;
`expireSession: true` expires the next request without a draw; the once-per-session interstitial
shows without a draw and chaos draws only on the pages after it. So a deterministic test that sets a
switch stays deterministic with chaos on. `interstitial: false` turns off only the once-per-session
notice; chaos `interstitial` still applies, because it was asked for explicitly.

### Determinism

The generator is mulberry32 (32-bit state, no dependencies; not cryptographic and never used as
such). Each kind has its own stream, seeded with `fmix32(seed XOR fnv1a(kind))`, so adding a kind,
or one kind drawing more often, never shifts the numbers another kind draws. It can still shift
which request gets them: a fault that ends a run early (a failed search) means the pages after it
never make their draws, so the next draw of every other kind lands on a later request.

**Same seed + same request sequence => same faults.** "Same request sequence" means: the same
`/members/...` requests, in the same order, against an instance whose chaos was set (or re-set)
with that config and not otherwise drawn from. Draws happen only on the member routes, never on the
shell frames, static assets, login or the `/__` routes: the workstation loads its three frames in
parallel, and drawing on them would hand the same random number to a different request depending on
which frame Chromium fetched first. The member routes load one at a time in the `main` frame, in the
replay's own step order. What breaks it:

- concurrent member requests (two clients, or a page that loads two member URLs in parallel); the
  order they arrive in decides who gets which draw;
- a different capability, different inputs, a different tenant, or a changed artifact: different
  requests;
- anything else that makes requests on the same instance meanwhile, including a human in a headed
  run or Relay handoff;
- a change in replay behaviour that adds or removes a member request (a retry, a re-navigation).
  That one is the point: it is exactly what a pinned-seed test should catch.

Timing does not break it: a slow response delays sequential requests, it does not reorder them. A
delayed request whose client has gone away by the time the delay ends (a step timed out, the run's
browser context closed) is dropped instead of handled, so it cannot draw from the other streams in
the middle of a later run. What timing can still change is whether a replay step waits out a chaos
delay close to its timeout, which depends on machine load; keep `maxMs` well under the step
timeout (10 s by default) in a pinned test.

Every accepted `POST /__faults {"chaos": {...}}` restarts the streams from the seed and clears the
counters and log, even with an identical config. `{"chaos": null}` and `/__reset` turn chaos off.
Internally the runtime remembers the config object it was built from (`chaosRuntime` in
`context.ts`); any new config object is the restart signal, whichever path set it.

### Reproducing a series

`replay --times N --fault '{"chaos": {...}}'` posts the faults once, before the first run, and
restores the pre-run snapshot after the last. The streams are deliberately not reset between runs:
resetting would give every run the same faults, and the series would measure nothing. Session state
behaves as it always has: each run is a fresh browser context, so a fresh login and a fresh
once-per-session notice. After the series, before the restore, the CLI reads `/__faults/chaos` and
the summary ends with the seed, the per-kind counters, the injected faults in order, and a
`re-run this exact series: --times N --fault '...'` line (bash quoting). If the app rejects any key
of `--fault` (it answers 200 with a `rejected` list), the CLI restores the snapshot and exits 1
without running, so a typo can never produce a series that silently ran without chaos. Running that line against a mock app with
no other traffic reproduces the series. `tests/e2e/replay-chaos.test.ts` does exactly that with
seed 2 and pins the result.

### What chaos found

Running the shipped capability under chaos surfaced one real defect in the runtime, reproduced
deterministically by seed 38 with `expireSession: 0.5`, and since fixed. The session expired on the
results page that step s07 ("Search for the member by ID") navigates to. The scripted relogin
operator signed back in and handed back `current_step`, because s07's postcondition did not hold.
But the member id that s06 typed went with the expired page, so s07 ran an empty search, the
capability's `member_not_found` detector (not bound to the input) fired, and the run reported
`escalated / resumed_success` with outcome `business_outcome: member_not_found` for a member who
exists: a wrong business answer delivered as a successful resolution. Two things combined: the
resume point assumed the page state earlier steps built survived a lost session, and outcome
detectors are checked before the step's own input-bound postcondition.

The fix, in three parts:

- **Resume points** (`docs/design/replay.md`, "Resuming at another step"). A resolution can name the
  step to resume at (`resumeAtStepId`). The relogin operator always names the first step after the
  sign-in, so the member id is typed again. Replay refuses a resume point that would repeat or skip
  an irreversible step, and asks again (`policy_block`) instead of falling back to `current_step`;
  relogin then aborts.
- **The same rule for a human.** The first part fixed the scripted operator only. A person in the
  Relay console cannot name a resume point: the console sends a plain `current_step` for "retry".
  With the same seed, a human who signed in again and chose retry still got `member_not_found`.
  Replay now resumes a plain `current_step` at the first step after the sign-in whenever the
  failure being resolved is `session_expired`, and the console's retry option says so.
  `tests/e2e/replay-human-retry.test.ts` pins it: seed 38 at `0.2`, the shipped artifact, the real
  console page, the default hand-back, the real balance. A capability with no sign-in steps is
  not covered (`docs/design/replay.md` says why).
- **A validator warning**, `unbound_outcome_detector`: a business-outcome detector that binds no
  input, checked after a step that submits what an earlier step typed from an input. It flags
  exactly `member_not_found` in both the shipped and the example artifact, and nothing else. The
  shipped artifact is unchanged (it is human-approved); binding its detector is a re-approval.

`tests/e2e/replay-chaos.test.ts` pins the result with the same seed and stream. With
`expireSession: 0.2` the stream's draws are identical (draw 2, 0.136, is below both
probabilities) and no later draw fires, so the run expires on the s07 search exactly as before,
resumes at s06 and returns the real balance. With `0.5` the same first expiry is followed by three
more (the member page, then the workstation twice): each relogin resumes at s06, the escalation
budget (`maxEscalations`, 3) runs out, and the run ends `resumed_failed` with `session_expired`.
That is an honest failure, never `member_not_found`. A third pinned case, seed 1 at `0.5`, puts the
expiry on the member page (s08), after the search succeeded, and rewinds to s06 from there.

A sweep of 18 runs (seeds 1, 7, 27, 38, 69, 79 at 0.5 and seed 38 at 0.2; the shipped and the
example artifact; tenants A and B) checked the fix wherever the expiry lands: the workstation load
(failing at the member-id step, resumed there), the search (rewound to the member-id step), the
member page (rewound there too), and two or three expiries in one run. None reported a business
outcome for member 12345. 15 returned the real balance; 3 ended in a hard failure: seed 38 at 0.5
(both artifacts) honestly ran out of escalations with `session_expired`, and seed 7 at 0.5 (both
tenants) ended in a `timeout` at the search click. That last one was a sibling bug, now fixed:
every re-login starts a new session, which shows the once-per-session maintenance notice again,
but the dismissing rule's budget (2) was per run, so after two re-logins the third notice stayed
up and blocked the click. An accepted resume after a lost session now resets recovery budgets
(`docs/design/replay.md`, "Resuming at another step"), and seed 7 at 0.5 is pinned in
`tests/e2e/replay-chaos.test.ts`: three expiries, four sessions, every notice dismissed, the
real balance.

Two weaker observations from the same runs, both behaving as designed:

- An intermittent search error was terminal: `app_error` was a hard failure with no retry, so a
  1-in-20 failing search was a 1-in-20 failed run. Replay now retries it, but only on a run asserted
  read-only (`replay --read-only`, or a capability with `readOnly: true`): it waits and restarts the
  steps from the entry navigation, at most twice (`docs/design/replay.md`, "Retrying a transient app
  error"). The shipped artifact does not carry `readOnly`, so without the flag its runs still end
  in `hard_failure app_error`, and the seed 2 series in `tests/e2e/replay-chaos.test.ts` is
  unchanged. `tests/e2e/replay-app-error-retry.test.ts` pins the retry: seed 5 (the search fails
  once, one retry, the balance), seed 31 (two failures in a row, two retries, the balance), and
  `failSearch: true` (the retries run out, `hard_failure app_error`).
- A recovery rule's `maxAttempts` is a per-run budget (reset only by a resume after a lost session,
  above). Within one session, with chaos `interstitial` the notice can show
  three times in one run (session, results page, member page) against the shipped rule's budget of
  2. It is harmless with this capability only because the third notice lands on the extract-only
  page, where nothing is clicked.

## Monitoring tag

Every page rendered from a view ships the institution's monitoring tag,
`<script src="/static/cu-agent.js">`, as the first child of `<head>`
(`views/partials/cu-agent.ejs`), the way a real core system carries a RUM or analytics tag. The
script is `@cu/browser-agent`, a separate package in `packages/browser-agent` that the app depends
on and serves with `GET /static/cu-agent.js` (unauthenticated, delayed by `slowMs`, built on demand;
a failed build is a plain-text 500). The Apache-style 404 and the 400 body-parser page are raw
strings and carry no tag; the sub-account "Reference not found" 404 does. On load the agent installs
`window.__cuAgent` (non-enumerable) and sets `data-cu-agent="<version>"` on `<html>`. It adds no DOM
node, changes no layout and no hostile-markup property above (no `<label>`, still no `<thead>`, and
so on), sends nothing over the network, and captures nothing until a driver starts capture. The tag
does not make the app automatable by itself: the Playwright adapter reuses the agent when the tag is
present and injects the same bundle when it is not, so discovery and replay behave the same with or
without it (`docs/design/surface.md`).

## Non-functional

Express plus EJS, server-rendered, no build step of its own, no CDN or network calls, bound to
the loopback interface only; static files
served from `apps/mock-app/public` under `/static`, plus `/static/cu-agent.js` (see above). `createApp({tenant})` holds no module-level mutable state, so
many instances can run per process. A vitest suite runs over real HTTP (`app.listen(0)` plus
`fetch`); a Playwright smoke test exercises the frameset.

## Architecture

Routes live under `apps/mock-app/routes/` (one file per area: faults, auth, shell, members, subaccounts).
Views live under `apps/mock-app/views/*.ejs` (one self-contained page per era, each its own doctype and
markup style). State and seed data live in `context.ts`/`tenant.ts`/`data/seed.ts`. Icon PNGs are pre-rendered
by the dev-only `apps/mock-app/scripts/render-assets.ts` (not run at request time; `npx tsx
apps/mock-app/scripts/render-assets.ts` regenerates them).

Middleware order in `createApp`:

1. Body parsers and cookies.
2. Fault routes (no auth, no delay): `/__faults`, `/__faults/chaos`, `/__reset`.
3. `slowMs` delay (or, with the switch off, a chaos `slowMs` draw on `/members/...`).
4. `/static/cu-agent.js` (the agent bundle), then `/static`.
5. Public auth routes.
6. The auth gate: no session -> 302 `/login`; `expireSession` -> destroy the session, 302
   `/session-expired`, then clear the flag; otherwise a chaos `expireSession` draw on
   `/members/...` does the same without touching the flag.
7. Shell/member/sub-account routes.
8. An Apache-style 404.

## Decisions

- **State lives per app instance** (`AppContext`), not in module globals, so tests run isolated apps
  in parallel and `/__reset` is a pointer swap. Chaos streams, counters and log are on
  `AppContext.chaos`; two instances in one process (tenant A and B) have independent chaos, pinned
  by `faults.chaos.test.ts`.
- **Chaos lives under `/__faults`.** The policy's existing `^/__faults` deny pattern already keeps
  the automation off `/__faults/chaos`, so no new pattern was needed; both redteam suites
  (`faults.redteam.test.ts`, `packages/core/src/policy/allowlist.redteam.test.ts`) check it in its
  mangled forms.
- **The interstitial is server-injected** into the main-content page rather than the shell. It
  appears inside the `main` frame, where a replay is looking. It shows only once per session, so a
  replay sees it on the first page and must continue past it.
- **`window.confirm` on nav links, not `beforeunload`.** Automation drivers suppress or auto-accept
  `beforeunload` prompts; an onclick confirm is deterministic and still a real native dialog the
  replay engine must handle.
- **Balances are stored in cents**, formatted as `$1,234.56`, so currency-parse extraction is
  exercised.
- **Tenant B is configuration, not a fork.** Same views, branching on tenant locals: the same vendor
  product, configured differently.

## Running

```
npm run mock-app                                   # tenant A on :4173
MOCK_TENANT=b npm run mock-app                     # tenant B on :4174 (bash)
$env:MOCK_TENANT='b'; npm run mock-app             # tenant B (PowerShell)
```

```
curl localhost:4173/__faults
curl -X POST localhost:4173/__faults -H 'content-type: application/json' -d '{"failSearch":true}'
curl -X POST localhost:4173/__reset
```

# Relay: the human-in-the-loop console

Code: `apps/relay/`.
Relay is where a person steps in when automation cannot continue safely. A run pauses and raises
an intervention, and Relay shows it in a queue. The operator takes control of the same live
browser, finishes the step, and hands back. Relay shows who holds control, the evidence
automation captured, and what the operator did. It keeps the lease alive while the operator works.

## The port Relay depends on

Relay is a delivery adapter for the human port. Its HTTP app depends on one interface,
`RelayBrokerPort` (`src/server/ports.ts`), and nothing else from the core:

| Method | Purpose |
|---|---|
| `runs()`, `controlToken(runId)` | Live runs and who holds each session |
| `listInterventions({status})`, `getIntervention(id)` | Relay's view model of each intervention |
| `take`, `handBack`, `abort`, `heartbeat` | The four operator commands |
| `subscribe(listener)` | Intervention changes, control transfers, heartbeats |
| `escalationScreenshot(id)`, `liveScreenshot(runId)` | PNG bytes |

`fromSessionBroker(broker)` and `createSessionRegistry(brokers)` (`src/server/broker-adapter.ts`)
implement the port on `SessionBroker`. They map core errors to `PortNotFoundError` and
`PortConflictError`, and core views to the wire types in `src/shared/api.ts`. Only
`src/server/core.ts` imports the core; `eslint.config.js` in `apps/relay` enforces that, and keeps
`src/ui` from importing server code, the core or Node.

Why this boundary: the console changes for UX reasons and the broker for runtime reasons; the
port keeps each change on its own side. Relay never imports Playwright, the agent or replay.

The core exposes what the adapter needs directly: `broker.onHumanAction(listener)` fires once per
captured human action accepted into a live round (capture or scripted operator), so the adapter
emits an `actions` change from that listener instead of polling; and `broker.leaseMs` is the
broker's own `interventionLeaseMs`, so the adapter's default lease length always matches the core's
(an explicit `leaseMs` option, on `register()` or `createSessionRegistry()`, still overrides it).
The adapter still tracks who took control and the control timeline itself, from `onTransfer`
(`heldBy`, `tookControlAt`), since the broker exposes live control state but not a history of it.

## Server

`createRelayApp({port, redact, staticDir})` returns an Express app. `startRelayServer` binds it.

| Route | Returns |
|---|---|
| `GET /` | The built UI with a redacted snapshot inlined as `application/json` (first paint needs no request) |
| `GET /api/runs` | Control state, kind, capability or goal per run |
| `GET /api/interventions?status=` | Views, newest first, plus the current event id |
| `GET /api/interventions/:id[/screenshot]` | One view, or its escalation PNG |
| `GET /api/runs/:runId/screenshot` | Live PNG, at most one capture per second per run; callers in between share the cached frame |
| `POST /api/interventions/:id/{take,handback,abort,heartbeat}` | The updated view, the resolution, or the new lease |
| `GET /api/events` | Server-Sent Events |

Errors are `{error: {code, message}}`; a 409 adds the control `state` that refused the call.

`handback` takes `{by, resumeFrom: 'current_step'|'next_step', notes?}` and, through the API only,
`resumeAtStepId` (a step id, with `current_step` only; anything else is a 400): "resume at this step
instead of the failing one", the lever a lost session needs (`docs/design/replay.md`, "Resuming at
another step"). Relay checks its shape; the run decides whether resuming there is safe and, when it
is not, escalates again with reason `policy_block`. The console UI never sends it: its hand-back is
always a plain `current_step` or `next_step`. After a lost session that is enough, because replay
itself resumes a plain `current_step` at the first step after the sign-in.

## Server-Sent Events

Event types: `intervention` (a store change or a new captured action, with the full view),
`control` (a control transfer, with the run), `heartbeat` (the renewed lease), and `reset`.
Each event has `id: <bootId>.<seq>`. The server keeps the last 500 events in a ring buffer. A
client that reconnects with `Last-Event-ID` (or `?lastEventId=`) receives every event after that
id. When the id is from another server process, or older than the buffer, the server sends one
`reset` and the client refetches the snapshot. A `: keep-alive` comment goes out every 15 s, and
`retry: 2000` sets the browser's reconnect delay. A client that falls 1 MiB behind is dropped; it
reconnects and replays. `close()` ends every stream.

## UI model

Vanilla TypeScript and CSS, bundled by esbuild into `dist/`. No framework.
- **Store** (`src/ui/store.ts`): one immutable state object. Listeners run once per microtask, so
  a burst of events renders once. SSE events upsert views; nothing polls except the live screenshot.
- **Rendering**: small functions patch the DOM through `src/ui/dom.ts`. Server strings become
  text nodes, never markup. Keyed lists keep focus and form input across updates.
- **Queue**: Open, In progress and Resolved. Each card shows capability or goal, run, step,
  reason, a live age and who holds control.
- **Detail**: state pill, the control timeline (automation, paused, human, resuming, automation,
  with times), the escalation or live screenshot, expected versus observed, URL and reason.
- **Act**: Take control; while held, the window to work in, the lease countdown, captured actions,
  and the hand-back form; Abort run with an in-page confirmation. Input actions show a
  "value hidden" marker. The UI never renders a value or an input's text, even if one arrives.
  The form's first choice is "Retry this step" (`current_step`), or "Check the result again" when
  the escalation came from the final success check and has no step. When the intervention's
  context carries `retryResume` (replay sets it for a failure classified `session_expired`; the
  shape is `RetryResumeHint` in `src/shared/api.ts`), the copy follows what replay already decided
  when it raised the escalation:
  - the restart is accepted: the choice reads "Start again after sign-in", the help line names the
    step the run resumes at and tells the human to sign in and leave the app on the screen shown
    right after sign-in, and a list names the completed steps that will run again (`repeats`);
  - the restart is refused but the failing step can run again (`retryRuns`): the choice reads
    "Retry only this step" (or "Check the result again"), and the help line says up front that
    automation will re-run only this step because step X already ran, and that the human should
    first bring the app back to the screen this step expects;
  - the retry is refused outright (the failing step itself already ran irreversibly): the help
    line says so; if its action went through, "I completed this step, continue", otherwise abort.
  Whenever there is a hint and a step, the "I completed this step, continue" choice carries a
  caution: replay takes it at its word, so someone who only signed in again should use the retry
  choice. This is copy only. The form still sends `current_step` or `next_step` with no resume
  point, and there is no step picker. After the hand-back the console says automation has control
  again and is continuing the run; it does not claim to know what automation is checking.
- **Heartbeats**: every 5 s for each intervention this operator holds. A 409 stops them and says why.
- **Live screenshot**: refreshes about once a second while the operator holds control, the Live
  view is chosen and the tab is visible. It stops otherwise.
- **Keyboard**: `j`/`k` move, `Enter` opens, `t` takes, `h` hands back, `a` aborts after
  confirmation. Shortcuts are off while typing or while a dialog is open.
- **Themes**: light tokens on `:root`, dark under `prefers-color-scheme` or the top bar toggle.

## Security perimeter

- Binds to a loopback address; `startRelayServer` refuses any other host.
- Every route checks `Host` (loopback names only) and, when present, `Origin` and
  `Sec-Fetch-Site`. An `Origin` must equal the server's own host exactly, host and port, so a page
  on another local port is refused too. This blocks DNS rebinding and cross-site reads and writes.
- POSTs must be `application/json` (16 kB limit, 413 above it) and pass zod validation.
- A strict CSP (`script-src 'self'`, no inline script), `nosniff`, `frame-ancestors 'none'`.
- The run's redactor (the policy's patterns plus that run's secret and sensitive values, the same
  one that writes `events.jsonl` and `interventions/*.json`) runs over every JSON body, SSE payload,
  inlined snapshot and error message. Ids, the control holder (`heldBy`), statuses and timestamps
  are left untouched, so the UI always addresses the right intervention and knows who holds it.
  Responses never include a stack trace or a file path.
- Operator identity is a name each browser stores and sends as `by`. No authentication ships; it
  plugs in as an `authenticate` middleware, accepted by `createRelayApp`, `startRelayServer` and the
  CLI's `startRelayConsole` (no CLI flag sets it). It is mounted app-wide after the Host/Origin
  guards, so it runs before every route: the console page (`GET /`), `/assets`, every API route
  including the `/api/events` stream, and the 404 fallback. Its `res.locals.operator` overrides
  `by`. `test/server/operator-auth.redteam.test.ts` pins this.

## What a production deployment adds

- **Authentication and roles**: SSO in the `authenticate` seam; approval rights checked per
  reason code (a `risky_action_confirmation` needs an approver role).
- **Remote access**: stream the session over a CDP screencast and relay input over the same
  authenticated channel, so the operator does not need to sit at the machine running the browser.
  Relay would then own the only input path and enforce control in both directions.
- **Multi-operator claims**: a server-side claim with expiry per intervention, so two operators
  cannot both believe they hold it. Today the control token is the only lock.
- **Shared event log**: SSE fed from a durable stream, so several Relay instances serve one fleet.

## Mounting in the composition root

`apps/cu/src/runtime/compose.ts` mounts Relay in-process. `ComposeOptions.operator` is either
`{port}` (own a console) or `{server}` (register with one the caller already started). For its own
console, `compose()` calls `startRelayConsole` (`apps/cu/src/runtime/relay-ui.ts`), which builds
Relay's UI on demand (`ensureRelayBuilt`, into `apps/relay/dist`, skipped once it is already fresh)
and then calls `startRelayServer({port, host: '127.0.0.1', brokers: [broker], leaseMs:
broker.leaseMs, staticDir?})`. For a server it was given, `compose()` calls `register(broker)`,
which reads the lease length straight from `broker.leaseMs` unless overridden.

`startRelayServer` resolves to `{url, port, register(broker), unregister(runId), close()}`.
`compose()` closes an owned server in `close()`, or calls `unregister(runId)` on one it was given.
Building the UI ahead of time is optional (`npm run build:relay`, or `npm --prefix apps/relay run
build`); the console API works even before it exists, and `GET /` answers 503 until it does.

# Human-in-the-loop escalation and handoff

Code: `packages/core/src/session/`, `apps/relay/`. The seam (`EscalationHandler`, control types) is in
`packages/core/src/session/types.ts` (`docs/contracts.md` sections 7, 7b).

Replay and the discovery agent raise an intervention through one call, `EscalationHandler(req)`;
neither knows how a human is reached. The intervention carries the capability or goal, the current
step, a reason code and message, the current URL (scrubbed of the run's secret and sensitive values), a persisted screenshot, and automation's
free-form context (expected vs. observed). It becomes visible to an operator immediately, pushed
over SSE to the Relay console (`docs/design/relay.md`) and via `GET /api/interventions`. The human
operates the same
`Surface`/browser automation was driving; the broker never opens a new one. Taking control waits
for any in-flight automation action to settle, so the human never races a half-finished click. The
mechanics of holding, taking and handing back control are in the state machine below.

## Control-transfer model

One **SessionBroker** owns one live session (one Surface, one browser). The broker holds
the raw surface; automation only ever gets `broker.surface`, a guarded wrapper.

```
                escalate(req)                  takeControl(id, by)
 +------------+ ------------> +--------+ ----------------------> +-------+
 | automation |               | paused |                         | human |
 +------------+               +--------+                         +-------+
       ^                        ^                                    |
       |                        | reverifyFailed(id, why)            | handBack(id, {resumeFrom, notes, by})
       |                        |                                    v
       |       resumed()      +----------+                           |
       +--------------------- | resuming | <-------------------------+
                              +----------+

 abort(id, by) from paused | human | resuming  --->  TERMINAL
     (intervention 'abandoned'; token reads paused / holder none; broker.terminated = true)
```

| state      | holder     | automation `act` | operator acts   | intervention status |
|------------|------------|------------------|-----------------|---------------------|
| automation | automation | allowed          | no              | resolved (or none)  |
| paused     | none       | refused          | no (take first) | open                |
| human      | human      | refused          | yes             | human_active        |
| resuming   | none       | refused          | no              | resolved            |
| terminal   | none       | refused          | no              | abandoned           |

Transition table (anything not listed throws `IllegalControlTransitionError`):

| call | from | to | side effects |
|---|---|---|---|
| `escalate(req)` | automation | paused | new `Intervention` (open), screenshot via `logger.screenshot`, `escalation` event, returns pending promise |
| `takeControl(id, by)` | paused | human | waits for in-flight automation `act`, starts capture, status `human_active` |
| `handBack(id, {resumeFrom, notes, by})` | human | resuming | stops capture (trailing actions kept), status `resolved` + resolution, resolves the promise |
| `resumed()` | resuming | automation | caller re-verified its checkpoint |
| `reverifyFailed(id, why)` | resuming | paused | status back to `open`, note appended, new round; `waitForResolution` waits again |
| `abort(id, by)` | paused, human, resuming | terminal | stops capture, status `abandoned`, resolves with `resumeFrom: 'abort'` |

Invariants:

- Only the holder may act, and the gate is on `act` itself, so it covers `{ref}` targets as well as descriptors.
- Every transition is logged as `control_transfer {from, to, by, at, interventionId}` before `onTransfer` listeners run.
- Only one intervention is live per session (`escalate` is legal only from `automation`).
- The intervention outlives the handoff, updated in place through every round, so the file on disk is always the latest schema-valid record.
- Nothing a human typed is stored.

Transitions do not interleave: async transitions hold a transition lock, so a concurrent call
throws rather than racing. `escalate` flips the token to `paused` synchronously, before its first
`await`, so automation cannot act while the screenshot is being persisted. Capture
`start()`/`stop()` run under the lock with a timeout (`quiesceTimeoutMs`); on timeout the handoff
proceeds without capture and an `error` event is logged.

## Reads stay allowed while the human holds control

`observe`, `check`, `waitFor`, `screenshot`, `domSnapshot`, `currentUrl`, `readText` pass through
the guard in every state: they do not change application state. The Relay console needs a live
screenshot at all times, and in `resuming` the caller must read the page to re-verify its
checkpoint before it can act again. `resolve` is refused even though it is a read, because it
exists to produce a target for an action, so the guard makes automation's intent to act fail
early. `close()` is refused while an intervention is live. The guarded surface does not expose
`humanCapture`: automation must not start or stop capture.

**Re-verification is the caller's job, not the broker's.** The broker cannot know what "back on
track" means for a given step. Replay knows the step's precondition (`current_step`), the
postcondition of the step the human completed (`next_step`), or, when the hand-back names a resume
point (`resumeAtStepId`, with `current_step`), the steps from that one on, after checking that
resuming there neither repeats nor skips an irreversible action (`docs/design/replay.md`, "Resuming
at another step"). The broker only records the resume point and rejects it with `next_step`; Relay's
HTTP API accepts it (`POST .../handback {"resumeFrom":"current_step","resumeAtStepId":"s06"}`), the
console UI never sends it. It does not need to after a lost session: for a failure classified
`session_expired`, replay itself resumes a plain `current_step` at the first step after the sign-in
(the same section), and tells the console so in the request's `context.retryResume`, which is what
the hand-back form's "Start again after sign-in" option and its help line are built from
(`docs/design/relay.md`). For any other failure a retry from the console still re-runs the failing
step only. The agent re-observes and re-plans
instead. The broker stops at `resuming`, and the caller calls `resumed()` or
`reverifyFailed(id, reason)`. The latter hands the intervention back to the operator with the
reason attached, instead of letting automation continue from a state nobody has verified. The CLI
wires it differently: `resumingEscalation` calls `resumed()` as soon as hand-back resolves, so
replay re-verifies as automation, and a failed re-verification escalates again as a new
intervention, up to `maxEscalations` (`docs/design/integration.md`).

## How "stuck" is detected

Detection belongs to whoever has the context; routing is always `escalate(req)`. Replay escalates
when a failure's classified code is in `escalateOn` (default `session_expired` and
`unexpected_dialog`) or the step's `onFailure` is `'escalate'` (`unrecoverable_condition`,
`unexpected_dialog`), and when an irreversible step needs a human decision
(`risky_action_confirmation`). The discovery agent escalates when it calls its `stuck`
tool, when it repeats a failing action three times, or when policy flags an irreversible action
(`policy_block` / `risky_action_confirmation`). Hitting a step, call or time limit ends the run
with status `max_steps` instead of escalating. `EscalationRequest.context` carries expected vs.
observed and the last actions; it is logged in the `escalation` event and shown on the Relay
console.

## Operating the same live session

The broker holds the Surface that automation was driving. With the Playwright surface the browser
is launched headed for handoff runs, so the operator works directly in that browser window. It is
the same process, with the same page objects, same cookies and server-side session, and the same
frameset state. The Relay console (default `http://127.0.0.1:4300/`, see `docs/design/relay.md`)
shows the queue, context, screenshots, who holds control, and the captured actions, and tells the
operator which browser window to work in.

What this does not give you, and a real co-browsing console would:

- **Remote access.** The operator must be at the machine running the browser; a real console streams the page over CDP screencast or VNC and relays input over an authenticated channel.
- **Enforcement against the human.** The guard stops automation from acting while a human holds control, but nothing stops a person clicking the window while automation holds it. A console would own the only input path, enforcing control in both directions.
- **Operator auth.** `by` is whatever the operator types; no role check, no claim/lock across operators beyond the token itself; the server binds to 127.0.0.1. Relay accepts an `authenticate` middleware on every route, the seam for a login, but none ships and the CLI has no flag for one (`docs/design/relay.md`).

## Record what the human did

Capture is behind `Surface.humanCapture` (Playwright: listeners in every frame, values never
read), started on `takeControl` and stopped on `handBack`/`abort`. Every action goes through
`recordHumanAction`, which rebuilds it from the `HumanAction` whitelist (`ts, type, frame,
target{tag,role,name,text,selector}, url, key`). It drops `target.text` for `input` actions (for a
textarea, or a buggy capture, the text is the value), caps every string at 300 characters, and
forces `valueRedacted: true` on `input`. A `keypress` action keeps `key` only when it names a key
(`Enter`, `Tab`, `Escape`, `ArrowDown`, `F5`, ...); a single printable character is dropped, so a
buggy capture sending one key event per keystroke cannot leak typed text one character at a time.
It also scrubs every registered secret value (the `secretValues` option, wired from
`apps/cu/src/runtime/compose.ts`) out of the surviving `name`/`selector`/`text`/`key`/`url` fields before
validating and storing it. This is defense in depth against a capture that puts a live value where
it should not be. A malformed action is dropped and logged as an `error` event, never stored raw.
Each accepted action also fires `broker.onHumanAction(listener)` once, which Relay's broker adapter
uses to push an `actions` change over SSE instead of polling (listener errors are swallowed).
With no capture, `captureMode` is `none` and the Relay console says so; simulated human work is
labelled `by`/`source: 'scripted-operator'` everywhere.

## Evidence across the handoff

`runs/<runId>/events.jsonl` carries `escalation` (with `evidence.screenshot`), `control_transfer`
for every hop, and `human_action` for every captured action, interleaved with automation's own
events. `shots/<seq>.png` holds the escalation screenshot. `interventions/<id>.json` holds the
intervention record, rewritten on every change.

## Known limits

- `Intervention` has no top-level `humanActions` or `context`. Actions captured during a live
  round are kept in the broker and in `human_action` events, only entering the record at
  hand-back (`resolution.humanActions`). Automation's context is kept in the `escalation` event
  only. A `rounds[]` history on `Intervention` would make a multi-round escalation easier to
  inspect from the file alone.
- Reopening after a failed re-verification keeps the previous `resolution` (so the operator sees
  what the last hand-back said) with a `[re-verification failed: ...]` note appended;
  `humanActions` accumulate across rounds.
- The refusal message on the guarded surface is `control held by human (state: …)` in every
  non-automation state, including `paused`, where nobody holds it yet. The `state` suffix is the
  accurate part.
- Relay's API errors return the message passed through the evidence redactor, never a stack.
- After abort the token reads `paused` / holder `none` with `terminated: true`, because
  `ControlState` has no terminal member of its own.
- No audit trail beyond the event log. Captured actions arrive through an in-page binding that
  page script can also call, so they are page-reported, not tamper-proof.

An intervention lease bounds how long control may sit idle. A `human` round needs a heartbeat
within `interventionLeaseMs` (default 15 minutes), sent by Relay every 5 s while it holds control.
Without one, the lease checker returns the intervention to `paused`, with a
`[lease expired: no operator heartbeat for N ms]` note and a `control_transfer` event. If the human closes the browser
mid-handoff, heartbeats stop and this lease expires the same way. The intervention then reopens
directly in `paused`, skipping hand-back re-verification, because `handBack` never ran and there
is no resume decision to check. A `paused` intervention nobody takes within another lease window
is aborted, through the same path a human abort uses, so the run ends like any abort.
The unattended abort note reads `[unattended: no operator took control within N ms]`. N is the
elapsed time the checker observed. Scripted operators are exempt, since they resolve at once and
send no heartbeat.
If someone does take control again, the normal hand-back re-verification runs on their hand-back.
A page the absent human left off-policy is also caught by the policy layer's pre-act allowlist
check, which quarantines the surface and refuses the next action.

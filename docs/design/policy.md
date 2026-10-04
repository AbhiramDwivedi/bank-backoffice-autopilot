# Policy enforcement

An allowlist of origins, routes and action types, a risk classifier that distinguishes safe or
reversible actions from irreversible ones, and enforcement of both against the `Surface` seam.
Two pieces:

- `packages/core/src/policy/guard.ts` (`createPolicyGuard(policy)`): a pure, synchronous decision function. No
  I/O, no knowledge of Surfaces, refs or descriptors.
- `packages/core/src/policy/enforcing-surface.ts` (`withPolicy(surface, guard, opts)`): a `Surface` wrapper that
  gathers whatever context the guard needs (live target name/text, current URL). It applies its
  decision before an action reaches the underlying surface.

## What it enforces

**Origin allowlist.** `checkUrl` requires an exact origin match (`allowlistOrigin`: `URL.origin`
for http(s)) against `policy.allowedOrigins`; no wildcards, no subdomain or port slop. A desktop
location (`desktop://<process>/<window title>`) is matched by process name, case-insensitively,
against `desktop://<process>` entries; its `URL.origin` would be the opaque `"null"` and is never
used. See [desktop.md](desktop.md#policy-and-desktop-locations).

**Route allowlist.** The pathname is normalized before matching: percent-decoded once, repeated
`/` collapsed, and `.`/`..` segments resolved. This stops a deny pattern from being evaded by
encoding, a doubled slash, or a `..` escape. A pathname whose percent-encoding cannot be decoded is
denied outright. `deniedPathPatterns` (matched against the lower-cased normalized path) always
wins; `allowedPathPatterns`, if non-empty, further restricts to matching paths. Empty means all
paths on an allowed origin.

**Action-type allowlist.** `policy.allowedActions` is checked before anything else.

**Risk classification.** `classifyRisk` uses text and URL-pattern heuristics to produce `read`,
`reversible` or `irreversible`. An `irreversible` classification is refused, not silently run,
unless the caller explicitly passes `allowIrreversible`.

**No bypass via refs.** A bare `{ref}` target is described live via `describeRef` on every call.
The guard never trusts an earlier observation. An unknown or undescribable ref is treated as
irreversible, not as an unclassified pass-through.

**Quarantine.** An action that leaves the surface (any frame) on an off-policy URL locks the
surface down to `navigate`/`dismiss_dialog` only, until every frame is back on-policy.

**Events.** Every decision (allow/deny/flag/refused/quarantine/cleared) is reported via
`onDecision`; `apps/cu/src/runtime/compose.ts` wires this to the run logger as a `policy` event.

**Never persist secrets.** `PolicyDecisionEvent` carries what a target *is* (name, text, tag,
role) and URLs, never `SurfaceAction.value`. A dedicated test asserts a typed secret value never
appears in any emitted event's JSON.

**Run limits.** `policy.limits` is not enforced by the guard; it carries the limits the runs
themselves read. Discovery reads `maxSteps`, `maxLlmCalls` and `maxDurationMs`. Replay reads
`maxAppErrorRetries` (optional; absent means replay's default of 2, and 0 turns the retry off):
how many times one read-only run may restart its steps after a transient app error
(`docs/design/replay.md`, "Retrying a transient app error").

## Design decisions

**Guard is pure; the surface wrapper does all the I/O.** `PolicyGuard.checkAction` takes
`{ targetName?, targetText?, currentUrl, riskOverride? }`: plain strings, not refs or
descriptors. Every branch of policy decision-making (origin/path/action allowlists, each action
type's risk classification, override semantics) is therefore testable synchronously with no
fixtures. The async, surface-specific work lives in `enforcing-surface.ts` instead: what a ref
currently points at, and whether it resolved to the element it looks like on paper. That module is
the only place that can get it wrong in a security-relevant way.

**Flag-and-refuse by default, explicit `allowIrreversible` to proceed.** An irreversible action is
never silently run, and it is never silently blocked forever. It comes back as
`{ ok: false, error: { code: 'policy_violation' } }` with a `refused_irreversible` event. The
caller then decides whether to retry with `allowIrreversible: true`:

- Replay retries only if `capability.status === 'approved'`.
- Discovery retries only after human escalation.

The decision to run stays in policy/caller hands, not in the surface guessing intent.

**`riskOverride` can only raise risk, never lower it.** A `Step.risk: 'read'` authored by a
capability may be wrong, or LLM-authored. It must not be able to downgrade a live "Confirm" click
to non-irreversible: doing so would make the text/URL heuristics pointless. `checkAction` computes
`max(riskOverride, classifyRisk(...))`, never the reverse.

**Resolve-then-act-by-ref.** For a `TargetDescriptor` target, the wrapper calls `surface.resolve()`
first. It classifies risk from the resulting ref's live description (`describeRef`), then passes
`{ ref }` (not the original descriptor) to the inner `act()`. The element classified is exactly
the element acted on, which catches drift in both directions:

- A descriptor whose stale `snapshot` says "Continue" but resolves to "Confirm": the live
  description catches it.
- A descriptor whose static texts say "Confirm" but resolves to something reading "Continue": the
  union of static and live text catches it, via `riskOverride`, which can only raise.

A bare `{ref}` target has no descriptor to fall back on, so an unknown or stale ref is classified
`irreversible` outright.

**Quarantine, not "abort the run".** A single denied action is a clean, resumable failure. An
action that leaves some frame on an off-policy URL (via an app redirect, an unexpected link, or a
compromised page) is a different problem. The page itself is no longer where the run thinks it
is, so nothing further should be trusted until it is back on known ground. Quarantine checks every frame URL after every action (`about:blank`/`about:srcdoc` are neutral).
Any off-policy URL locks the surface to `navigate`/`dismiss_dialog` only. It clears automatically
once every frame is back on-policy. The same check also runs before every action, not only after.
So a surface already off-policy when the next action begins (for example, a human navigated away
during a handoff) is quarantined. The action is refused before it reaches the inner surface.

## Limits

- **Risk classification in this module is lexical, not semantic.** A judgment-based check sits
  on top of it at record time and audit time only (`docs/design/risk-judge.md`); it can raise a
  step's risk and never lower it, and replay still enforces only what the artifact declares.
  `irreversibleTextPatterns`/`irreversibleUrlPatterns` are regexes over names, text and URLs. A control renamed to dodge the
  pattern, or a legitimately worded irreversible action outside the pattern list, will
  misclassify. `policies/default.yaml` documents the specific patterns and their edge cases (a
  word boundary after the alternation, so "Submitted" does not trip the same guard as "Submit").
- **Popups and new tabs are not covered.** Quarantine watches `frameUrls()` of the current
  surface; a `target="_blank"` popup or a new browser tab or window is outside that surface
  entirely.
- **Page-script requests are not intercepted.** This module governs the actions this runtime takes
  through the Surface. A script already running on the page can make its own network requests
  off-policy without going through `act()`. A context-level request-interception layer (for
  example Playwright's `BrowserContext.route`) would close this gap but is out of scope for the
  `Surface` abstraction as specified.

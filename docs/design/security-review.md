# Security review

## Threat model

The deployment is a single operator on localhost, working against synthetic mock data, running
capabilities authored by the discovery agent or an engineer. Three kinds of adversary are
considered:

- A capability artifact or its inputs, via untrusted authorship or injection through a templated
  value.
- A compromised or adversarial legacy page or desktop app, via prompt injection into the discovery
  agent or the risk judge, an unexpected redirect during replay, or a hand-off to another process.
- Another local process or browser tab attempting to reach the operator console.

Two data flows leave the machine on purpose and are treated as untrusted sinks: requests to the
discovery model and requests to the risk judge. A credentials source (a file or a helper process)
is trusted code the operator chose, but nothing it reports may reach evidence.

Operator identity and network access to the console itself are out of scope: no authenticator
ships. Relay accepts an `authenticate` middleware that gates every route, and a deployment that
needs operator identity supplies one. The console is meant to run on a machine the operator already
controls. For every attack below, a test in a `*.redteam.test.ts` file next to the code under
attack pins the fix; a regression in that file means the attack works again.

## Attacks covered

| Attack | Mechanism that stops it | Test |
|---|---|---|
| A tenant override adds an irreversible step, or retargets an existing step onto an irreversible-looking control, on an already-approved capability | `validateCapability` rejects any override that declares or retargets onto an irreversible-looking step, unconditionally; a `TenantOverride` carries no approval field of its own | `packages/core/src/schema/validate.redteam.test.ts`, `packages/core/src/replay/injection.redteam.test.ts` |
| Typing into an unrelated field, or a bare key press, submits a form via Enter whose only submit control is "Confirm transfer" | risk classification treats any Enter as irreversible when an enabled irreversible-looking control exists anywhere on the page, not only the acted-on target | `packages/core/src/policy/allowlist.redteam.test.ts` |
| An input value spliced into a `url_matches` pattern or `dialog_open.messagePattern` widens or breaks the regex (e.g. `.*`, an unbalanced `(`) | `bindPattern` regex-escapes every substituted value before splicing | `packages/core/src/schema/template.redteam.test.ts`, `packages/core/src/replay/injection.redteam.test.ts` |
| An input value spliced into a `css` locator escapes the selector (e.g. closes a quoted attribute value) | `bindCssSelector` applies the CSSOM `CSS.escape` algorithm to every substituted value | `packages/core/src/schema/template.redteam.test.ts` |
| A recovery rule's action targets a css-only element whose readable `description` says "Confirm transfer" | the validator's irreversible-action check reads the target's `description` too, not only role/label/text locators | `packages/core/src/schema/validate.redteam.test.ts` |
| A password value inside a `srcdoc` iframe leaks through the parent frame's DOM snapshot | `iframe[srcdoc]` is blanked in the parent's own snapshot, not only the child frame's | `packages/adapter-playwright/src/snapshot.redteam.test.ts` |
| A secret or sensitive value echoed back in a different case (e.g. an upper-cased hostname) reaches evidence | value scrubbing (replay and discovery) is case-insensitive | `packages/core/src/replay/rundir-leak.redteam.test.ts`, `packages/core/src/agent/llm-leak.redteam.test.ts` |
| Any page in the operator's browser, or a DNS-rebinding attacker, calls take/handback/abort, or reads intervention context and screenshots | every Relay route, GET included, checks Host (loopback names only) and Sec-Fetch-Site, and requires any `Origin` to equal the server's own host exactly (host and port), before acting | `apps/relay/test/server/console.redteam.test.ts` |
| A pattern-shaped secret nobody registered (e.g. an SSN in free-form context) leaks over the operator API | one redactor per run, built from the policy's patterns plus that run's secret and sensitive values, covers `events.jsonl`, `interventions/*.json`, and Relay's API and SSE payloads alike | `apps/relay/test/server/console.redteam.test.ts` |
| An unexpected error quotes a local absolute path (an fs error, a screenshot path) in a Relay 500 or in evidence | Relay strips absolute paths from a 500 message before redaction, and the default redactor has a filesystem-path pattern | `apps/relay/test/server/console.redteam.test.ts` |
| A secret-shaped string used as an object *key* rather than a value passes the redactor | pattern matching is applied to keys as well as values | `packages/core/src/evidence/redaction.redteam.test.ts` |
| A declared input named `__proto__`, or an invalid `InputSpec.pattern` | input values are built with `Object.create(null)`; a pattern is validated at load time and a bad one is reported as a structured issue, never an uncaught throw | `packages/core/src/replay/validate-inputs.redteam.test.ts`, `packages/core/src/schema/validate.redteam.test.ts` |
| `maxSteps`/`maxLlmCalls`/`maxDurationMs` set to `Infinity`, `NaN`, zero or negative disables a discovery limit | `resolveLimits` clamps every caller value to a finite positive integer, falling back to `policy.limits` | `packages/core/src/agent/limits.redteam.test.ts` |
| The same action repeated every turn with its expectation never met runs unbounded except by `maxSteps` | `StuckRepeatDetector` routes 3 consecutive identical, still-unmet repeats to `stuck` | `packages/core/src/agent/limits.redteam.test.ts` |
| Captured human actions persist a live value via `target.name`/`selector`/`key`/non-input `text` | `recordHumanAction` scrubs every registered secret value out of the surviving fields before storing | `apps/relay/test/server/human-action.redteam.test.ts` |
| An oversized request body to the operator API crashes the handler | bodies over 16 kB are rejected with 413 | `apps/relay/src/server/app.redteam.test.ts` |
| Deny-path mangling against `/__faults` (case, percent-encoding, doubled slashes, `..` segments), including the chaos report at `/__faults/chaos`, or a POST to it that would set chaos | the policy guard normalizes the pathname (decode once, collapse `//`, resolve dot segments, lower-case for the deny check) independent of the app's own router; the `^/__faults` deny covers the chaos route, and the route is read-only | `packages/core/src/policy/allowlist.redteam.test.ts`, `apps/mock-app/faults.redteam.test.ts` |
| A UNC path (`\\host\share\x`), a backslash URL or a protocol-relative URL (`//host/x`) passes the origin check once resolved against an allowed page, or reaches Chromium as a `file:` page | the guard refuses any URL containing a backslash or starting with `//` before resolving it; the Playwright surface hands `goto` only the URL it checked and resolved, accepts only http(s) or exactly `about:blank`, and refuses `desktop://` | `packages/core/src/policy/allowlist.redteam.test.ts`, `packages/adapter-playwright/src/desktop-scheme.redteam.test.ts` |
| A committing key spelled other than `Enter` (`\r`, `Return`, `NumpadEnter`, `Space`, `" "`, `Spacebar`) fires a focused irreversible button as a `read` press | one `committingKey` table classifies every spelling like Enter, and both surfaces press the normalized key, so the key the guard judged is the key pressed | `packages/core/src/policy/allowlist.redteam.test.ts`, `packages/adapter-playwright/src/desktop-scheme.redteam.test.ts` |
| A desktop allowlist compared by `URL.origin`, which is `"null"` for every desktop and `file:`/`blob:` URL, lets one desktop app stand in for another or for a non-http scheme; a deny pattern is evaded by encoding the window title; the app hands over to another process | the guard compares through `allowlistOrigin`: `desktop://<process>`, exact and case-insensitive; path patterns match the decoded title; `.exe` in an entry is refused; a web policy allows no desktop location and the reverse; a surface whose app hands over to another process is quarantined | `packages/core/src/policy/desktop-allowlist.redteam.test.ts` |
| A desktop run synthesizes global input or takes the foreground, acting on whatever window the user has focused | no `SendInput`, `SendKeys`, `keybd_event`, `mouse_event`, `SetForegroundWindow`, `SetFocus`, `BringWindowToTop`, `AttachThreadInput` or `ShowWindow` anywhere in the desktop adapter or the mock desktop app (a static scan with a self-test); the integration tests also assert no window the test started has the foreground | `packages/adapter-desktop/src/no-global-input.redteam.test.ts` |
| A judge that answers "read" for "Confirm transfer", or a page that talks the judge out of raising, lowers the risk of a committing action | a judgment can only raise risk (`combineRisk` returns the maximum of lexical and judged); an action the patterns already flag is never sent | `packages/core/src/agent/risk-judge.redteam.test.ts` |
| A secret, a sensitive input or pattern-shaped PII on the page reaches the third-party risk judge, in the page text, the navigate URL (plain or URL-encoded), a dialog message, the goal or the agent's reason | every string in the judge request goes through the same scrubber as the model's text channel, plus the policy's redaction patterns; typed values and screenshots are never sent | `packages/core/src/agent/risk-judge.redteam.test.ts` |
| A judge vendor's API key leaks through an error (an SDK error carrying the response body, a 401 or 422 echoing the request, a network error), a judgment, or the judge object | the Anthropic judge rethrows SDK errors as plain errors with the key redacted; the Jev judge never puts the key anywhere but the `Authorization` header; both keys appear only in their request header | `packages/adapter-anthropic/src/judge.redteam.test.ts`, `packages/adapter-jev/src/judge.redteam.test.ts` |
| A credential provider echoes a value in a failure: a helper's stdout before a non-zero exit, truncated JSON quoted by V8's parse error, an invalid credentials file, a token passed as a helper argument | no failure message carries stdout, file contents, parser messages or arguments (the provider id is `exec:<program>`); a credentials file inside a git work tree is refused unless git-ignored | `packages/adapter-credentials/src/credentials.redteam.test.ts` |
| A credential from a `file:` or `exec:` provider reaches the discovered artifact, the evidence, or a Relay payload, including when the app echoes it into an error or the URL at escalation | the run's scrubber and redactor are seeded from the loaded `CredentialSet`, whatever its source; the artifact stores names only | `apps/cu/src/credentials.redteam.test.ts` |
| A file in core or the CLI reads a credential straight from `process.env`, bypassing the provider | a static scan allows `process.env` reads only in an allowlist of files, each limited to the names it may read; only the `env` provider reads credentials | `packages/core/src/credentials/process-env.redteam.test.ts` |
| The optimizer's own sinks (`optimize.json`, `--json` output, the summary, the provenance note) carry an output value, a sensitive input or an SSN that trial replays returned | the report holds output names and verdicts only, and failure text is redacted with the policy's patterns and the run's values | `apps/cu/src/commands/optimize-report-leak.redteam.test.ts` |
| A caller's pass-through options turn an optimizer trial into an attended or approved run, or point it at another capability, policy or runs directory | the trial runner sets the capability copy, inputs, policy, runs directory, browser, tenant, aborting operator, no console and the forced approval gate itself; only an explicit allowlist (`credentials`) passes through | `apps/cu/src/commands/optimize-report-leak.redteam.test.ts` |
| An unauthenticated caller reaches Relay's static assets, the 404 fallback or the event stream because the `authenticate` hook was mounted per route, or the hook cannot be passed through the server or the CLI | the hook is mounted once, app-wide, after the Host and Origin guards, and `startRelayServer` and `startRelayConsole` forward it; an authenticated identity replaces the body's `by` | `apps/relay/test/server/operator-auth.redteam.test.ts` |
| An `authenticate` hook that throws, rejects or calls `next(err)` leaks its error (an LDAP bind error quoting a password) in a 500 | a failing hook answers a fixed `401 authentication failed` with nothing from the error, logged server-side by class name only | `apps/relay/test/server/operator-auth-failure.redteam.test.ts` |
| An outcome or recovery rule named `__proto__` or `constructor` rewrites a stability counter's prototype or reads an inherited function | every keyed counter in `summarizeStability` is prototype-free | `packages/core/src/replay/describe.redteam.test.ts` |
| A frame that cannot be planned (a sabotaged in-page agent, an invalid selector), a page changing between the mask plan and the capture, a script stripping the mask marks, overlapping captures, an endless loop, 25,000 text blocks with a run value, a Playwright error quoting the page, or a native dialog leaks masked content in a screenshot, DOM snapshot or error | fail closed: no screenshot or DOM for an unplanned frame and its text dropped; every capture verified afterwards (navigation, a new frame, counted node/text/value changes, a content fingerprint, the marks) and discarded on any change; one capture lock per surface with a deadline; fixed error messages, raw ones only to a local `CU_DEBUG` sink | `packages/adapter-playwright/src/screen-mask.redteam.test.ts` |
| A script moves masked content out from under its mask during the capture (a class toggle every 7 ms, an `adoptedStyleSheets` swap every 3 ms, `insertRule` every 5 ms), or the value overflows its box, sits in a `display:contents` element, is absolutely positioned or casts a `text-shadow`; a page's inline `!important` style out-ranks the redaction; a replaced `MutationObserver` hides PII flashed in during the capture | pixels are redacted by a stylesheet keyed on per-capture nonce attributes and laid out with the content (Playwright's screenshot `style`), checked before every capture to win on every marked element, with Playwright's element masks as a second layer; the agent keeps its own copies of the observer API | `packages/adapter-playwright/src/screen-mask-capture.redteam.test.ts` |
| Ordinary page activity during a capture, over every layout the label rules support, leaks a PII pixel or string, or a masker passes by withholding, failing or greying everything | a seeded fuzzer (four fixed seeds in CI, overridable) requires zero PII pixels and strings in every returned capture, a real capture at rest on every page, and 90% of non-PII marker text kept | `packages/adapter-playwright/src/screen-mask-fuzz.redteam.test.ts` |
| The model learns hidden on-screen text by guessing it in a condition (`expect`, `done`, `declare_outcome`, `dismiss_interstitial`, including the optimizer's vacuous-expectation pre-check), or reads a masked notes block through `extract` | every model-written condition is evaluated against the masked view only, so a correct and a wrong guess of the same length produce byte-identical prompts, transcript, events, result and capability; a masked read is withheld from the model and its output recorded `sensitive` | `packages/adapter-playwright/src/screen-mask-agent.redteam.test.ts`, `packages/core/src/agent/masked-view-conditions.redteam.test.ts` |
| A masked value reaches the prompt, transcript, events, result or capability during discovery | the value is registered with the run's scrubber before anything echoes it; evidence `outputs` hold a placeholder for a sensitive output | `packages/core/src/agent/screen-mask-leak.redteam.test.ts` |
| Masking blinds the irreversible-action guardrail ("Delete <masked name>" classified as a read), or a policy decision event quotes masked content | `describeRef` returns the masked view and carries the real strings in `classifyName`/`classifyText`, which the enforcing surface classifies on and never logs; a masked button counts as possibly irreversible for a committing key | `packages/core/src/policy/screen-mask-guard.redteam.test.ts` |
| A sensitive output (flagged, or read from masked content) reaches a replay run file, including on a parse failure | the value is registered with replay's scrubber before parsing; `result.json` and the post-escalation `outcome` event redact by name; a `screen_mask` policy event flags an output the capability did not mark | `packages/core/src/replay/sensitive-output.redteam.test.ts` |
| A capability recorded for one record acts on, or reads from, another record at replay: a value matched by a name it merely contains ("Mug" inside "Mini Mug", "4512" inside "Row for 45123"), the next card when the named one lacks the value, a nested card's price, a list price above a sale price, the "Add to cart" of whichever card sits first, a status cell anchored on the previous column's value, or a search result opened by its position | a target that belongs to a record named by a run input keeps no positional locator; its anchors are exact, container-bounded (`within`, one candidate or a miss) or whole-word; a row anchor is only a cell that reads as a label; membership is decided from the element's real row and container text; the input-bound chain is verified on the live page before recording, else an extract is refused and an action escalates | `tests/e2e/record-scope-storefront.test.ts`, `tests/e2e/record-membership.test.ts`, `tests/e2e/discover-storefront.test.ts`, `tests/e2e/discover-mock-record-scope.test.ts`, `packages/core/src/agent/record-verify.test.ts`, `packages/adapter-playwright/src/text-leaves.test.ts` |
| At replay a locator that names its target matches several elements (a control now repeated once per listed record, a label shown once per record), or a read's naming locators miss, and the fallback chain reaches a structural css or a bbox: replay clicks, or reads, whatever sits at that position and returns another record's value as `success` | a found resolution reports the locators that missed before the winner and marks an ambiguity with its match count (Playwright, desktop and fake surfaces); replay refuses a positional winner after an ambiguous naming locator, for every action, and for any `extract` whose chain names the value; the refusal is a typed `element_not_found` saying how many candidates matched; business-outcome extracts, recovery actions and element conditions follow the same rule; positional-ness is judged on the target as recorded, before binding | `tests/e2e/positional-fallback.redteam.test.ts`, `packages/core/src/replay/positional-fallback.redteam.test.ts`, `packages/core/src/surface/positional-fallback.test.ts`, `packages/adapter-playwright/src/resolve.test.ts` |
| A discovered capability persists another record's data: a neighbour's e-mail as a row anchor, a customer's name as a status cell's anchor, a value slugged into a class (`span.status-shipped`) | only input-bound or label anchors are kept in a record-scoped target; the validator's leak check compares selectors and `within` letters-and-digits only; an extracted value's slug in a selector drops that locator | `tests/e2e/discover-member-tabs.redteam.test.ts`, `tests/e2e/record-membership.test.ts`, `packages/core/src/schema/validate.test.ts` |
| Masked text leaves the surface through a text leaf (a price, a fragment of a split address), a container anchor, a relative locator's `selector` or `within` (verbatim or slugged into a class), or the real row text the recorder decides membership from | text leaves go through the masked view like every element, and a leaf whose whole text masks to one placeholder counts as masked; `maskDescriptor` drops a locator whose anchor, css, `selector` or `within` carries masked text (letters and digits compared); the row text is never part of an observation, only `Surface.recordContextOf` returns it, and the operator's surface does not expose it | `packages/adapter-playwright/src/text-leaves-mask.redteam.test.ts`, `tests/e2e/record-scope-masked.redteam.test.ts`, `packages/core/src/surface/mask.test.ts`, `packages/core/src/session/control.redteam.test.ts` |
| On the desktop surface, a masked static's real value reaches `events.jsonl` through the policy decision event, a guess at hidden text is evaluated against the real view, or a masked read goes to the model | the desktop surface follows the same contract: `describeRef` returns the masked view with the real strings only for classification, `check`/`waitFor` honour `{ view: 'masked' }`, `readText` flags masked reads, and the composition root passes it the policy's `redaction.screen` block | `packages/adapter-desktop/src/screen-mask.redteam.test.ts` |

## Guarantees confirmed by test

- **Origin allowlist.** Matching is exact-origin: http(s) origins, or `desktop://<process>` for a
  Windows app. `javascript:`, `data:`, `file:`, protocol-relative `//evil`, UNC and backslash paths,
  userinfo tricks, a trailing-dot host and a wrong port are all denied, on `FakeSurface` and on real
  Chromium (`packages/core/src/policy/allowlist.redteam.test.ts`,
  `packages/adapter-playwright/src/allowlist.redteam.test.ts`). A web run cannot reach a desktop
  location and a desktop run cannot reach an http origin.
- **Quarantine.** Trips on a real off-origin redirect and on a click through an off-origin link;
  after that, click and type are refused before reaching Playwright
  (`packages/adapter-playwright/src/allowlist.redteam.test.ts`). A desktop surface whose app hands
  over to another process is quarantined the same way.
- **Desktop scope.** The bridge lists, acts on and captures only windows of the process tree it
  launched or attached to; another program's window, even one re-parented into the app, is never
  fetched and is painted over in screenshots. A launched app gets an allowlisted environment
  without the runtime's model keys or credentials. Password fields are never read. Nothing sends
  global input or takes the foreground (`packages/adapter-desktop/src/no-global-input.redteam.test.ts`
  statically; the Windows-only integration tests at run time).
- **Risk overrides.** `{ref}` targets cannot bypass risk classification: unknown or stale refs
  count as irreversible, and drift is caught in both directions. `riskOverride` only ever raises
  risk. `waitFor`, `check` and `observe` never reach the inner surface's `act`.
- **Raise-only risk judgment.** A risk judge can raise an action's risk and never lower it, in
  every mode and on every error path; an unavailable judge counts the action as irreversible by
  default. The judge receives scrubbed text only (`packages/core/src/agent/risk-judge.redteam.test.ts`).
- **Control transfer.** The broker refuses automation `act`/`resolve` during `human` control, a
  second `escalate`, a hand-back or take against the wrong intervention id, and anything after
  `abort`. The control token rotates, so a stale operator surface cannot act on a later
  intervention (`packages/core/src/session/control.redteam.test.ts`).
- **Resume points.** Replay refuses a resume point that would repeat a dispatched irreversible step
  or skip one, and never falls back to `current_step` when it refuses
  (`packages/core/src/replay/replay-resume-at.test.ts`). The points replay picks itself go through
  the same check: the default after a lost session (a human's plain retry), and the restart of an
  app-error retry, which also runs only on a run asserted read-only
  (`packages/core/src/replay/replay-app-error-retry.test.ts`).
- **Credentials.** A missing credential stops a run before any browser, fault request or console
  starts (`apps/cu/src/credentials.cli.test.ts`). Values come only from the run's provider and reach
  nothing persisted or served; no failure message carries one
  (`packages/adapter-credentials/src/credentials.redteam.test.ts`,
  `apps/cu/src/credentials.redteam.test.ts`).
- **Operator authentication hook.** When a deployment supplies `authenticate`, every Relay route is
  behind it, including assets, the event stream and the 404, and a failing hook answers a fixed 401
  (`apps/relay/test/server/operator-auth.redteam.test.ts`,
  `apps/relay/test/server/operator-auth-failure.redteam.test.ts`).
- **Input validation.** `InputSpec.pattern` is enforced with no implicit multiline flag; unknown or
  missing inputs are rejected; a sensitive value is never echoed in a validation error.
- **Evidence leak grep.** Across every file under a run directory, including an escalated run, a
  secret or sensitive value never appears in raw form. Nor does it appear as base64 (standard or
  URL-safe), URL-encoded, `+`-encoded, form-encoded, HTML-entity-encoded, or JSON-escaped. The discovery transcript binds
  `{kind:'input'}`, never the literal. On the text channel the model sees `<sensitive>` or a
  placeholder. In screenshots, DOM snapshots and observed text, every field, every password field
  and every value a screen-masking rule names are masked, and a value the model extracts from
  masked content is returned to the caller but recorded `sensitive` and redacted in every run file
  (`docs/design/screen-masking.md`). Data the app shows that no rule names is visible to the
  model. An escalation's `currentUrl` and the URLs on captured human actions are scrubbed of
  the run's values like every other string (`packages/core/src/session/escalation-url-leak.redteam.test.ts`).
- **Prompt injection does not cross the allowlist.** A scripted model that obeys an injected
  instruction to navigate off-allowlist is still stopped by the policy guard before the surface
  (`packages/core/src/agent/prompt-injection.redteam.test.ts`).
- **Evidence integrity.** `seq` is strictly monotonic under concurrent writers, and `run_finished`
  is always the last line. Logging after `finish()` throws. An invalid result throws before
  `result.json` is written. Every screenshot or DOM path referenced in events or the result exists
  on disk (`packages/core/src/evidence/evidence-integrity.redteam.test.ts`).
- **The fake matches the browser on escaped CSS.** `FakeSurface` compares CSS selectors modulo CSS
  escapes, so a CSS locator bound through the escaping binder resolves on the fake exactly when it
  would on a real page (`packages/core/src/surface/fake-css.redteam.test.ts`).
- **Evidence DOM snapshots are inert.** A DOM snapshot written to `dom/` has its scripts and
  inline event handlers stripped and carries a restrictive CSP, so opening one in a browser does
  not run the captured page's code (`packages/adapter-playwright/src/snapshot.test.ts`).
- **Scoped runs.** Each run's policy is narrowed to the origin of its own base URL, so a run
  against one tenant cannot act on another tenant the shared policy file also allows
  (`apps/cu/src/runtime/compose.test.ts`). Separately, the mock app binds to loopback only by
  default (`MOCK_HOST` overrides it); that is configuration, not a tested guarantee.
- **No LLM in replay.** A static scan of `packages/core/src/{replay,optimize,session,policy,surface,evidence,schema}`
  finds no Anthropic SDK import, no `packages/core/src/agent` import, no path into either model
  adapter (`@cu/adapter-anthropic`, `@cu/adapter-jev`), no `api.anthropic.com` or `api.typesafe.ai`,
  no vendor-referencing `fetch`, no `ANTHROPIC_*` or `TYPESAFE_*` env read, and no computed
  `import()`. In `apps/cu/src`, only `commands/discover.ts` and `commands/risk-judge.ts` may import a
  model adapter or read a model key, and only `index.ts`, `commands/discover.ts`,
  `commands/discover-candidates.ts`, `commands/audit.ts`, `commands/judge-eval.ts` and
  `commands/risk-judge.ts` may import a model-touching file. The scanner has a self-test against
  synthetic offenders (`packages/core/src/replay/no-llm.redteam.test.ts`).
- **Repo hygiene.** No tracked API key prefix, `.env`, `runs/`, or PDF file; a manual audit of
  history found no real key and only synthetic SSNs/card numbers
  (`apps/mock-app/repo-hygiene.redteam.test.ts`).

## Limits of the guardrail model

1. **Risk classification is lexical at replay, with a judgment added at record time.** To the
   policy guard, "irreversible" means a name, text or URL matches a configured pattern. The risk
   judge (`docs/design/risk-judge.md`) adds a judgment in context when a capability is recorded
   (`discover`) or audited (`cu audit`): it can raise a "Continue" that moves money to
   irreversible, and the raise is written into the artifact, where the approval gate enforces it
   with no model. What it does not add: replay never consults it, so a control whose meaning
   changes after recording is classified lexically at replay; an audit judges from recorded text
   only, which is weaker than a record-time judgment; with `--risk-judge off`, or with no judge
   key, classification is lexical alone; and the 0.5 threshold is a default, measured only against
   a small hand-written eval set. The committing-key fix over-approximates in the safe direction:
   the `Surface` seam has no focus or form model, so any committing key (Enter, NumpadEnter, Space
   and their spellings) on a page with any enabled irreversible-looking control counts as
   irreversible. This costs an extra observation per press. The approval gate plus a human is the
   real control, not the classifier or the judge.
2. **Redaction is value-based plus a few shapes, not a DLP system.** Known secret and sensitive
   values are scrubbed wherever they appear as a contiguous string, case-insensitively, plus
   SSN/card/token-key/filesystem-path shapes. Numbers and structural fields (ids, timestamps,
   enumeration values, run-relative evidence paths) are not value-scrubbed, so records stay valid
   and point at the right files; a value that is only ever a number, or sits in one of those
   fields, stays there. A value split across DOM text nodes, or re-formatted
   by the app (masked, re-grouped), is not caught. PII nobody registered, in a shape no pattern
   matches, is not caught. On-screen content is masked by rule (item 7 and
   `docs/design/screen-masking.md`): in screenshots by a redaction stylesheet applied at capture,
   in DOM snapshots by placeholders written into the copy, and in observed text by the same plan's
   matcher; a value no rule names is not masked anywhere. A local absolute filesystem path is one of the shapes: the default
   redactor (`packages/core/src/evidence/redact.ts`) matches a Windows drive path, a UNC path, or
   a POSIX path under a well-known root (`/home/`, `/Users/`, `/tmp/`, `/var/` and a few more),
   and Relay strips the same shape from an unexpected error's message before that message goes
   through the redactor (`apps/relay/src/server/errors.ts`, pinned in
   `apps/relay/test/server/console.redteam.test.ts`). A POSIX path under any other root
   (`/data/x`) is not caught, nor is a drive path glued to a preceding word (`fileC:/x`); the
   pattern needs a non-word character before the drive letter so it never reads `http:` as one.
3. **Enforcement happens only at the Surface.** Page scripts' own `fetch`/XHR calls are not
   intercepted. Popups and new tabs are not observed, so quarantine only sees the current surface's
   frames. Relay's perimeter (`docs/design/relay.md`) is a Host/Origin/Sec-Fetch-Site check on
   localhost. An `authenticate` middleware, when a deployment supplies one through
   `createRelayApp`, `startRelayServer` or `startRelayConsole`, runs before every route (pages,
   assets, the API, the event stream, the 404), and the identity it sets replaces the
   self-asserted `by` on take, hand-back and abort. No authenticator ships and the CLI has no flag
   to pass one, so as shipped anyone with a local shell or a local browser tab on 127.0.0.1 can
   take control. Because assets are gated too, a browser-facing authenticator has to be cookie-based
   or sit behind a proxy.
4. **Prompt injection is contained, not prevented.** The system prompt frames page content as
   untrusted, but the boundary that actually holds is the policy allowlist and the irreversible
   gate. A compromised page can still steer discovery into any allowed, reversible action.
5. **The approval workflow.** `cu approve <artifact> --by <name>` records who approved it and when
   in `provenance.notes`. It requires a prior successful replay of the same id and version under
   `--runs-dir` (or an explicit `--force`) before it will mark a capability `approved`, and when
   that replay's result carries a `capabilityDigest`, the digest must match the file's content.
   `replay --approve` is a one-run override: it treats the in-memory capability as approved for
   that invocation only, and never touches the file. It prints a reminder to use `cu approve`
   for a durable approval.
6. **Unattended irreversible confirmations are an explicit opt-in.** `discover --auto-operator
   approve` answers escalations without a human, but on its own it runs discovery with
   `discoveryMode: 'block'`, so an irreversible action is refused rather than confirmed. Only
   `--allow-unattended-irreversible` lets it confirm one. That flag is the one way to let discovery take an irreversible action with nobody
   watching, and it should stay off outside a disposable test target.
7. **Screenshots are masked by rule, not by understanding.** Screenshots go to the model provider
   during discovery and into evidence. Before any leaves the surface, every field (under the
   default `maskInputs: all`), every password field, and every value a `redaction.screen` rule
   names are redacted: a whole-label match on a label/value cell, header column, `dt`, caption,
   form label or inline `Label:` / `Label：`, a CSS selector, a redaction pattern, a run value, or
   a value repeated elsewhere. On the web the redaction is a stylesheet laid out with the content,
   so a script cannot move a value out from under its mask; a page whose own styles out-rank that
   stylesheet gets no screenshots at all. The desktop surface paints the same rules' elements
   through UI Automation. What the rules do not name is visible in the pixels: PII in free text
   without a label, an unlisted label variant, text inside images, canvas or shadow DOM, and a
   native dialog that quotes a value before any capture of the page. The limits of
   `docs/design/screen-masking.md` list each.
8. **Captured human actions are page-reported.** Relay and the evidence show what the operator
   did from records the page delivers through an in-page binding. The page itself can call that
   binding, so a hostile page can add or shape records. They are a useful account of the
   handoff, not a tamper-proof audit trail. On the desktop surface they are translated UIA events
   from the app's own windows, which the app itself can also raise.
9. **The risk judge is a third-party data flow and reads attacker-influenced text.** It receives
   scrubbed text only, but that text includes the page's own content, which goes to the judge's
   vendor. A page can try to talk the judge out of raising; raise-only bounds that at the lexical
   baseline. A page can also make the judge raise everything, which costs escalations (they share
   the run's budget of three) rather than safety. On its first live run the Jev judge let one
   irreversible action through (a GET link that deletes); its question was reworded and it then
   caught all eleven, with a thin margin (`docs/design/risk-judge.md`, Limits).
10. **The model-free scans are static.** `no-llm.redteam.test.ts`,
    `process-env.redteam.test.ts` and `no-global-input.redteam.test.ts` read source text. A module
    name, environment variable or host assembled at runtime is invisible to them. They catch
    accidental wiring, not a determined committer; code review covers that.
11. **The optimizer trusts the read-only declaration.** Replay-backed rewrites run only on a
    capability declared `readOnly`, and nothing verifies that declaration. A wrong one lets trial
    replays write to the live app (about 35 with the defaults) and can yield a verified draft with
    a necessary step removed, because side effects nobody reads back are invisible to output
    equality. The policy-visible vetoes catch only what the policy can see. The draft and approval
    gate, with a content-matched replay, is what stands between such a draft and production
    (`docs/design/optimize.md`). Replay's app-error retry trusts the same declaration, or its
    run-level form (`replay --read-only`): a wrong one lets a retry repeat a write, up to twice
    per run with the default budget. The retry never re-runs a step whose irreversible action it
    knows was dispatched, and the run-level assertion is refused on a capability with anything
    irreversible, but a write the artifact and the policy both call reversible is invisible to it
    (`docs/design/replay.md`, "Retrying a transient app error").
12. **Credentials live in process memory.** A loaded credential is a plain string for the whole run,
    and JavaScript cannot zero it. Scrubbing is by value, so a credential the app re-formats is not
    recognised. A `file:` provider checks git, not file permissions. An `exec:` helper is trusted
    code with the user's privileges, and its stderr goes to the terminal
    (`docs/design/credentials.md`).
13. **The desktop surface's boundaries are the process tree and the user's session.** It cannot
    drive an elevated app from a non-elevated runtime, it sees nothing a toolkit does not expose
    to UI Automation, and an app can still activate its own dialogs. A posted key is translated
    with the thread's current keyboard state, so a key a person is holding at that moment changes
    it (`docs/design/desktop.md`).
14. **A capability can still succeed silently on another record in four cases.** Everywhere else
    the record rule and the replay rule give a typed failure or an escalation
    (`docs/design/browser-agent.md`, "The rule"; `docs/design/replay.md`, "Positional fallbacks").
    This list had six entries, and a narrowed role locator (a substring match) has since been closed by the whole-word rule. Two of them are now typed failures in their common form: a control
    unique at record time but repeated at replay, and a record's own page that also lists other
    records. Both went wrong when a naming locator matched several elements and the chain fell
    through to a position, which replay now refuses. Two more are closed by the read identity check
    (`docs/design/browser-agent.md`, "A read's record identity"; `docs/design/replay.md`, "Record
    identity on reads"): when only another record shows the label, and a detail panel on a search
    page. The check is recorded when the value's record container shows a run input at record time,
    and replay fails `checkpoint_failed` when the container no longer shows it
    (`tests/e2e/positional-fallback.redteam.test.ts`). Four remain:
    - an action (click, type, select) whose naming locators all miss, with no ambiguity, still
      falls back to a position. A control that is both renamed and repeated at replay is clicked
      by position; its checkpoint is the only guard. Reads no longer fall back;
    - a target recorded with positional locators only (a control with no name, a value with no
      label) has nothing that can be ambiguous. An action on it stays positional; a read does
      too, `cu validate` warns (`positional_only_target`), and `cu approve` refuses it unless `--force`;
    - a target whose record shows the input nowhere near it (a search by e-mail whose card shows
      only the name) cannot be seen to belong to a record, so its read gets no identity check.
      `cu validate` warns (`read_without_record_identity`). Several such records listed at replay
      fail typed; one record, or one label, is read or clicked;
    - an input that is a whole word of another record's value in the same column, with no
      static text around it in that column. "Lee" recorded on "Ann Lee" opens "Lee Wong" when
      only he is listed and no cell is exactly "Lee". The whole-word match covers "Bo Leeson",
      "Lee-Wong" and "lee", not "Lee Wong"; "A-1001" no longer matches "A-1001-B", because a hyphen
      does not end a word (`tests/e2e/record-row-anchor.test.ts` pins it).

    The identity check has its own gaps: it covers step extracts only, a record id that sits outside
    the value's container (a page header, beside a table) records no check, and a surface without
    `readRecordText` skips it.

    The replay rule has its own gaps. It runs where replay resolves a target; a surface's own
    `act` or `readText` called with a descriptor resolves inside the surface, and the scripted
    `relogin` operator acts on the sign-in steps that way. And it costs a self-heal: a read whose
    label moved or was renamed used to resolve through a structural css and is now a typed
    `element_not_found`.

## Open items

- `TenantOverride` has no approval field of its own, which is why an override can never
  legitimately add or retarget an irreversible step today. Adding one (e.g. an `approvedBy`) would
  let a tenant override do so without weakening the check.
- No focused-element or implicit-submit primitive exists on the `Surface` seam, so the Enter fix
  above over-approximates rather than precisely identifying the form an Enter would submit.
- `FrameHop.urlPattern` is never templated, so an `{input.x}` placeholder there is inert rather
  than bound at replay time.

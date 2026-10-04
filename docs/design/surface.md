# Surface: PlaywrightSurface

The `Surface` interface (`packages/core/src/surface/types.ts`, `docs/contracts.md` section 8) is the seam
between "how the runtime perceives and acts on an app" and "the recorded flow". `PlaywrightSurface`
(`packages/adapter-playwright/src/`) implements it for web apps. It is built for the legacy case: framesets,
labels in adjacent table cells, div buttons, `tr onclick` rows, span tabs, and custom dropdowns. It
also handles native `confirm()` dialogs, and pages with no ids or test hooks. Replay, discovery and session code
import `Surface` only; `page` is exposed so the session broker can share it with the operator view.

## What it does

`observe()` returns a screenshot, the elements from every frame (frameset, iframe, nested) with
top-document bboxes and a `FramePath`, a whitespace-collapsed text digest, the frame list, and any
pending native dialog. Every element carries a usable accessible name even with no ARIA: an
adjacent-cell heuristic gives the 1998 login's password input the name "Password". Elements
without semantics are still reachable: `tr[onclick]`, `div.btn`, span tabs and `li[data-value]`
are enumerated as `clickable`, and label/value `td`s as `cell`. Values on markup that is not a
table are listed too: after the controls and the legacy cells, every leaf text block, such as a
price `<div>` in a card or a status `<span>`, comes as a `text`-group element. The list is capped
at 150. A third of the list is held for text, the rest goes to controls first, and on-screen entries
come first. `elementsOmitted` says how many were dropped. See [browser-agent.md](./browser-agent.md#what-enumerate-lists). Every element
carries a synthesized `TargetDescriptor` with an ordered locator chain:

- role (0.9, real ARIA only)
- label (0.8)
- text (0.7, unique matches only)
- relative (0.5): a row or above anchor, plus verified anchors from the element's container (a
  card's name). A text leaf lists its container anchors first. Each carries an optional CSS
  `selector` that every candidate must match, which is what tells a card's price from its
  description, and `within`, the card's own selector: only candidates inside the anchor's card
  count. The recorder marks an anchor bound to a run input `exact`, so it never matches a
  longer name.
- css (0.3)
- bbox (0.1, coordinates-only, the last resort)

`act()` handles click (rows, div buttons, tabs, image inputs), type (fill, with a keystroke
fallback and Enter), select (native, plus custom list dropdowns), press, navigate, wait,
dismiss_dialog, switch_frame and extract. Playwright errors map to `FailureCode`s. Human actions
during a handoff are captured in every frame, including ones that load later, with values never
captured.

`resolve()` tries the locators in order inside the target's frame. A strategy that matches zero or
more than one visible element is a miss. The first unique match wins, and its `strategyIndex`/
`strategyKind` is reported, since fallback depth is the drift signal. Resolution time is bounded by
`timeoutMs` (overrun of at most about 20%); a missing frame is `element_not_found`, never a throw.

A found resolution also reports `tried`: the strategies that missed before the winner in the
winning round, in chain order. A miss that was an ambiguity carries `ambiguous: true` and
`matches`, the number of candidates. These count as ambiguities:

- a `role`, `label`, `text` or `css` strategy that matches several visible elements;
- a `relative` strategy whose anchor text several elements show ("ambiguous anchor");
- a `relative` strategy with `within` and several candidates in the anchor's container;
- a `relative` strategy whose two nearest candidates tie within 1px.

The surface reports an ambiguity. It does not act on it: the chain still falls through, and a
later strategy may still win. Whether that winner may be used is replay's decision
([replay.md](replay.md#positional-fallbacks)): a positional winner (a bbox, a structural css) is
refused after an ambiguous naming strategy, and for any read whose chain names the value. Replay
decides because only replay has the target as recorded. The surface gets the bound target, where a
css bound to an input can no longer be told from a css that pins a position.

`check()` and `waitFor()` resolve `element_visible` and `element_absent` targets with one round and
no waiting. The shared `evaluateCondition` applies the ambiguity half of the same rule to them, on
the recorded condition a caller passes in `CheckOptions.recorded`.

Native dialogs are held, not auto-handled, so `dialog_open` can be a checkpoint or recovery
trigger; while one is held, every action except `dismiss_dialog` returns `unexpected_dialog`.
`check()`/`waitFor()` use the shared `evaluateCondition` from `conditions.ts`, which is async
because live `hasElement` resolution is async; `FakeSurface` uses the same function.

Password values are `[REDACTED]` in `observe()`. `readText()` refuses password fields.
`domSnapshot()` blanks every `value` attribute; live values are never serialized.

Nothing in `packages/core` imports Playwright; `apps/cu` launches Chromium and passes the browser to the adapter. The desktop surface
(`@cu/adapter-desktop`, Windows UI Automation, [desktop.md](desktop.md)) implements the same
`observe`/`resolve`/`act` with the same locator kinds: role/name and label from the accessibility
tree, relative/bbox from geometry, plus `automation_id`, which this surface treats as a miss. It
reports `tried` and ambiguity the same way, and its relative anchor follows the same rule as here:
one element equal to the anchor text wins, else one element containing it, and several are an
ambiguity (it used to take the first static in the tree). `FakeSurface` follows that rule too. This
surface navigates only to URLs that parse (as the browser parses them, tabs and newlines removed)
to `http:` or `https:`, or to exactly `about:blank`; a `desktop://` location, `file:` and every
other scheme are refused before Chromium sees them.

## Architecture

```
packages/adapter-playwright/src/
  surface.ts     glue: lifecycle, dialog holding, ref registry, ConditionView, Surface methods
  inpage.ts      installs or reuses @cu/browser-agent (window.__cuAgent) per frame; detects
                 whether the app shipped it (ensureAgent, installAgentInitScript, detectAgent)
  enumerate.ts   observe(): per-frame enumeration, prioritization/cap, descriptor synthesis
  resolve.ts     locator strategies + round-based fallback
  act.ts         per-action behavior, readText, error -> FailureCode mapping
  frames.ts      FramePath <-> Frame, frame offsets
  refs.ts        ref -> ElementHandle registry (e1..eN per observe; r1.. per resolve)
  snapshot.ts    domSnapshot(): value blanking, inert on disk (CSP meta, Node-side tag strip)
  capture.ts     HumanActionCapture (exposeBinding + the agent's capture.start/stop per frame)
  index.ts       public entry: createPlaywrightSurface, PlaywrightSurface
```

The in-page code is `@cu/browser-agent` (`packages/browser-agent`), not part of this package.
Enumeration calls `window.__cuAgent.enumerate()`, resolution and actions call the helpers on
`window.__cuAgent.lib`, and human capture turns
`window.__cuAgent.capture` on and off. All three use one naming heuristic, and it is the same one an
app gets when it ships the agent as its own script tag.

## The in-page agent: injected or included

The adapter works the same whether or not the app ships the agent.

- **Injection mode** (the app has no tag). `createPlaywrightSurface` adds one init script per
  browser context (`installAgentInitScript`), so every new document in every frame gets the agent
  before any page script runs. A document that loaded before the surface attached gets it from
  `ensureAgent(frame)`, which every enumerate, resolve, act and capture path calls first: it reads
  `window.__cuAgent.version` and evaluates the bundle only when the agent is missing or
  `isCurrentAgentVersion(v)` is false (another major, or older than the driver's copy, which lacks
  API the driver calls). If the frame still holds no usable agent afterwards (the page pinned one),
  it throws `AgentVersionError`, and `observe()` fails with it instead of skipping the frame.
- **Included mode** (the app ships `<script src=".../cu-agent.js">`, as the mock app does). The
  init script still runs first, so the driver's copy is installed when the app's tag executes. The
  bundle's install is idempotent: it finds a same-major agent and returns without changing anything,
  so the page has exactly one agent. If the app's agent loaded before the surface attached,
  `ensureAgent` reuses it when it is the driver's version or newer, and installs the driver's copy
  over it when it is older.

**Detection.** The injected script is the bundle wrapped in a small marker
(`agentInjectionSource()`). When the wrapper's own run installed the agent, it records that under
`Symbol.for('cu-agent.driver')` and turns `window.__cuAgent` into a non-enumerable getter that
returns the same object. The getter notes whether it was read while a page `<script>` element was
executing (`document.currentScript` is set). The app's tag does exactly that when its install checks
for an existing agent, and a Playwright `evaluate` never does. `detectAgent(frame)` waits for
`domcontentloaded` and reports `{ present, version, source }`:

- `app`: the app's tag ran, or the agent was installed without the driver's marker (loaded before
  attach).
- `injected`: only the driver installed it.
- `none`: no agent.

Everything the page returns is validated Node-side, because a hostile page can spoof the global or
read it from its own script and so claim `app`. The value is evidence of which mode ran, not a
security boundary.

**Evidence.** Once per surface, after the first `observe`, `resolve`, `act` or `readText` that
completes on a non-blank page with no native dialog held, the surface runs `ensureAgent` and then
detection on every frame, so the record describes the agent the driver uses. When the driver
replaced an app-shipped copy, the record says `source: 'injected'` and names the app's version in
`replacedVersion`. It calls `onAgentDetected` (an option of `createPlaywrightSurface`) with
`{ browserAgent: { source, present, version, compatible, replacedVersion, frames: [{ frame, source,
compatible }] } }` and writes one line to the surface's `log`. The
caller that owns the run logger records that detail as an `observation` event. The result is also
readable as `surface.agentDetection`.

**Capture.** `exposeBinding('__cuHumanAction')` stays; the agent's sink calls it directly with each
`HumanActionRecord`. The adapter re-validates every record (`sanitizeTarget`, `key` only when it is
Enter, Tab or Escape) and takes `frame` and `url` from the binding's source frame, not from the
record. It drops the agent's in-page `navigate` records, because its own `framenavigated` handler
already reports every navigation, same-document ones included. Every record from the agent carries
`valueRedacted: true`, and keypress records carry `key`.

## Decisions

- **In-page code is a built bundle, evaluated as a string.** The agent is built by esbuild into one
  es2018 IIFE (`packages/browser-agent/dist/cu-agent.js`) and injected as text. It is never a
  serialized TS function. Functions passed to `evaluate` are serialized with `toString()`, and a
  transpiler (tsx, vitest, esbuild) can inject helpers such as `__name` that do not exist in the
  page and break only at runtime. The adapter's remaining `evaluate` callbacks are small inline
  functions that reference only `window.__cuAgent` and their arguments.
- **Refs are bound to ElementHandles.** Observation refs (`e*`) are replaced on each `observe()`.
  Resolution refs (`r*`) survive an observe, so a replay step's resolve-then-act pair is stable.
  If the element's document has navigated, the stale handle fails as `element_not_found`.
- **Resolution runs in rounds, not fixed time slices per strategy.** Each round tries every
  strategy instantly (`count()`, never auto-wait) and rounds repeat every 250ms. A non-primary
  winner is accepted only once the frame's `readyState` is `complete`, and only once the primary
  strategy has already missed once or 40% of the budget has passed. A half-loaded page is
  therefore not reported as drift, and a genuinely drifted primary strategy does not cost a fixed
  slice of the timeout waiting on it.
- **Dialogs are held.** Playwright freezes a `click` whose handler calls `confirm()` until the
  dialog is handled. So `act` races the action against "a dialog opened" and returns `ok: true`
  once the dialog wins. Chromium also blocks script evaluation while a dialog is open, so
  observe/check answer from cached text during that time. An evaluation already in flight when a
  dialog opens (observe, check, resolve, readText, screenshot, domSnapshot, describeRef) is raced
  against the dialog the same way and falls back to that cached answer.
- **A `text` locator's `tag` filter applies to the climbed clickable element, not the raw text
  match.** A `getByText` leaf climbs to its clickable ancestor before the constraint is checked.
  So `{text: '...', tag: 'tr'}` matches a clickable table row whose visible text sits in a
  child cell, not just an element whose own tag is `tr`.
- **Descriptors are self-consistent.** On the page it was synthesized on, every descriptor from
  `observe()` resolves at strategy index 0 to the same DOM node, so a freshly recorded artifact
  replays with zero drift. Relative anchors are measured against the text leaf that `getByText` will
  bind to, and ancestor/descendant ties among relative candidates collapse to the actionable node.
  `packages/adapter-playwright/src/self-consistency.integration.test.ts` enforces this for every element in the
  discovery flow on tenant A and for tenant B's "Member #" field. It does not hold on every page:
  the page's own naming and the browser's role lookup can disagree (an image link takes no name
  from its image's alt text in the first, and does in the second, so it shares a name with the
  title link beside it). Discovery therefore does not rely on it. It resolves each locator alone
  before recording a target and leaves out the ones that do not find the element
  (`docs/design/agent.md`).
- **Policy is not in the surface.** `withPolicy()` (`packages/core/src/policy/enforcing-surface.ts`) wraps any
  Surface. The surface reports `describeRef()` and `frameUrls()` so the wrapper can classify
  `{ref}` targets and detect off-allowlist frames.

## Known limitations of the locator strategies

- **role:** only as good as the page's ARIA. Legacy pages rarely have any, so it is rarely
  emitted.
- **label:** the adjacent-cell heuristic assumes the label sits in the preceding cell of the same
  row. Stacked layouts (a label row above an input row) fall to `relative below` instead.
- **text:** needs a unique visible text. Repeated texts ("Edit" on every row) fall through by
  design; template bindings (`{input.memberId}`) are what make row text usable.
- **relative:** depends on geometry. Anchor text must be unique, and multi-column forms with
  wrapped labels can pick a neighbor's field.
- **css:** a structural selector (`nth-of-type` chain) breaks as soon as a row or column is
  inserted, hence its low confidence. When it does not break, it finds whatever sits at that
  position.
- **bbox:** breaks when the viewport, zoom or layout changes. Last resort only.
- **css and bbox as fallbacks:** replay uses a positional winner only for a click, type or select
  whose naming strategies missed without an ambiguity, and for a read whose chain holds no naming
  strategy at all. An ambiguous naming strategy, or a read that could have been named, ends as a
  typed `element_not_found` instead ([replay.md](replay.md#positional-fallbacks)).

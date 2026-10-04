# @cu/browser-agent

`@cu/browser-agent` is a dependency-free script that runs inside the page. It computes accessible names, enumerates elements, and captures human actions without reading their values. The same bundle supports two ways of getting into a page.

## Integration

To have the driver inject the agent, add it as an init script:

```ts
await context.addInitScript({ content: agentSource() });
```

For a frame whose document has already loaded, evaluate it in that frame instead:

```ts
await frame.evaluate(agentSource());
```

To have the app include the agent itself, put `<script src="/static/cu-agent.js"></script>` in `<head>` and serve the bundle from that route:

```ts
app.get('/static/cu-agent.js', (_req, res) => res.type('application/javascript').send(agentSource()));
```

## Versioning

The version lives in `src/version.ts` (`AGENT_VERSION`) and `package.json`, and a test keeps the two equal. Bump the minor version when the agent adds output a driver can use, and the major version when a driver built against the old API would break. 1.3.0 added the screen-masking calls (`lib.maskPlan`, `lib.maskObserve` and the rest; see [docs/design/screen-masking.md](../../docs/design/screen-masking.md)). 1.4.0 added the `text` group, `priority`, `containerAnchors`, `inViewport`, `rowAnchorIsLabel`, `recordContext`, `omitted` and the shared cap (`selectForCap`). A driver passes the cap through `maskObserve`'s enumeration options too, so a masked observation is capped in the page. A driver reinstalls its own copy over an older agent of the same major (`ensureAgent`), so a page that ships an older 1.x still gets text leaves.

## Version detection

The major version is the compatibility contract. A driver reads `window.__cuAgent.version` and passes it to `isCurrentAgentVersion(v)`, which returns true when the installed agent has the same major as the driver's copy and is not older.

When a copy installs into a page that already has an agent, it follows these rules:

- If the installed agent has the same major, the newer of the two stays.
- If the installed agent has a different major, the new copy replaces it.

So across majors, whichever copy installs last wins. A driver that finds another major, or an older copy of its own major, re-installs its own copy and checks again.

## API

The agent installs itself as `window.__cuAgent` with these members:

- `version`: the installed semver. The major number is the compatibility contract.
- `enumerate(opts)`: returns elements in three groups, with bounding boxes, selectors, descriptor inputs, and capped strings. The groups are, in order: `interactive` (controls), `informative` (the legacy rules: headings, label/value table cells, message cells, short bold texts, error items), and `text`. The `text` group holds every other leaf text block: a visible element that renders text of its own, such as a price `<div>`, a status `<span>` or a `<p>`. It leaves out text inside a control, a listed control's label, text a person cannot see (transparent, `aria-hidden`, 1px, off the page), and prose over 200 characters. `maxElements` holds a third of the cap for text leaves, gives the rest to controls and then the legacy entries, and prefers what is on screen. A text leaf then goes by `priority` (messages and short values first). The same selection is exported as `selectForCap` for a driver's cross-frame cap, and `omitted` counts what it dropped. Each element without a row anchor also carries `containerAnchors`: unique text from the nearest ancestor that holds some and has a stable class selector, such as a product card's name. Each anchor comes with a candidate `selector` and a `within` container selector, and is verified to find the element again through a `relative` locator. Classes slugged from the element's own text are never used. Inside a container the anchor is emitted whenever the element is a candidate there; a driver resolves it only when the element is the one candidate in the anchor's own (not a nested) container, and the recorder verifies it on the live page before recording it. `rowAnchorIsLabel` says whether the cell to an element's left reads as a label: a `th`, a `<label>`, text ending in a colon, a two-cell row, or a column with the same text in every row. A driver emits a row anchor only when it does, so a value is never anchored on the previous column's value. `recordContext` holds the element's own text, its table row's other cells and its record container's text. The recorder reads it once, to decide whether the element belongs to the record a run input names. A driver keeps it off the elements it reports: the Playwright surface holds it per ref and returns it only from `Surface.recordContextOf`. It is never shown to the model, logged or persisted, and it holds real (unmasked) text. See the design doc for the record rule built on these fields. See [docs/design/browser-agent.md](../../docs/design/browser-agent.md#what-enumerate-lists) for the rules, the cap, and the measured cost.
- `describe(el)`: returns the role, accessible name, label, and selector for one element.
- `closestClickable(el)`: returns the element itself or its nearest interactive ancestor.
- `structuralSelector(el)`: returns a unique CSS selector for the element that never relies on a generated id.
- `capture.start()`, `capture.stop()`, and `capture.isActive()`: control value-free human-action capture, which is off by default.
- `drain()`: returns the fallback sink's buffered records and empties the buffer.
- `events`: the fallback sink's buffer, which holds at most 500 records and drops the oldest first.
- `lib`: naming and selector helpers for a driver's resolver, plus the screen-mask planner a driver calls before every screenshot: `lib.maskPlan(opts)` marks what to paint over under the policy's rules (selectors, filled fields, the value next to a matching label, text-pattern matches, and wherever the page repeats hidden text), `lib.maskMark` hides the text ranges and fields the driver matched against values it never sends to the page, `lib.maskVerify` tells the driver after a capture whether the page changed since the plan (a MutationObserver counts changes), `lib.maskTouches` answers whether a read touched masked content, `lib.maskClone` returns a masked copy of the document for a DOM snapshot, `lib.maskClear` removes the marks, and `lib.maskKindOf(el, opts)` answers for one element (cached until the document changes). See [`docs/design/screen-masking.md`](../../docs/design/screen-masking.md).

Captured records go to `window.__cuHumanAction` when a driver has installed that binding. Otherwise they go to the fallback sink, which buffers them in the page and broadcasts them with `window.postMessage`.

## Security

The agent uses no `eval`, `new Function`, `innerHTML`, `outerHTML`, or `document.write`. Its only DOM writes are the `data-cu-agent` detection attribute and the screen-mask marks a driver asks for (`data-cu-mask`, `data-cu-mask-kind`), which `lib.maskClear` removes again; it never inserts an element. `lib.maskClone` edits a detached copy, never the live document. The first mask plan installs one MutationObserver, which only counts changes. Capture never reads `.value`. Every string the agent emits is capped at 300 characters, or 8000 for `bodyText`.

The agent runs in the page's realm, so a hostile page can spoof it. Treat its output as untrusted.

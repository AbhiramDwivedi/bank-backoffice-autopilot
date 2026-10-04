# Screen masking

During discovery a screenshot goes to the model provider on every turn, and every screenshot, DOM
snapshot and piece of observed text can end up in evidence and in the operator console. Screen
masking hides sensitive on-screen content before any of it leaves the `Surface`. That covers the
value next to an "Address" label, every filled form field, text that looks like an SSN, and
anything that shows one of the run's secrets. The same content is hidden in the pixels, in the
text the model reads and in the DOM written to evidence. The model can still extract a value it
cannot see, and that value reaches the caller and nowhere else.

The prior art is session-replay tooling (Glassbox, FullStory and similar): mask inputs by default,
block elements by rule, keep the page's structure visible and hide its values. This is the same
idea applied to a model's view of a legacy app.

## Where pixels and observed text go

Every pixel and every observed string leaves the system through the `Surface`:

| Consumer | What it takes | Call |
|---|---|---|
| Model provider (discovery) | screenshot, element list, text digest, title | `observe()` |
| Discovery evidence (`shots/`, `events.jsonl`, `transcript.jsonl`) | the same observation | `observe()` |
| Model-supplied conditions (`expect`, `done`, `declare_outcome`, `dismiss_interstitial`) | yes/no on text | `check()`/`waitFor()` in the masked view |
| Policy decision events (`events.jsonl`, `source: enforcing-surface`) | an action target's name and text | `describeRef()` |
| Replay failure evidence (`shots/`, `dom/`) | screenshot, DOM | `screenshot()`, `domSnapshot()` |
| Replay failure classification (`observed` in `result.json`, escalation context) | text digest | `observe()` |
| Action errors (`lastResult`, `result.json`, escalation requests) | an error message | `act()`, `readText()`, `resolve()` |
| Escalation request (Relay, `interventions/`) | screenshot | `screenshot()` (replay `buildEscalationRequest`, broker `escalate`) |
| Relay live view | screenshot | `broker.liveScreenshot()` -> `surface.screenshot()` |
| Captured human actions (Relay, `interventions/`) | the clicked element's name and text | the adapter's human capture |
| Operator demo | screenshot | `broker.surface.screenshot()` |

No pixel path bypasses the surface. A repo-wide search finds `page.screenshot()` only inside the
Playwright surface, and in test, video and asset-rendering tooling, which are not runtime paths.
The one channel outside this design is the headed browser window a human operator may be looking
at, which shows the real page.

## Mask at the surface, once

Masking happens inside the surface, not in each consumer. A consumer that had to remember to mask
would eventually forget: Relay's live view, a new evidence writer, a future escalation path. At
the surface, each call computes a mask plan and applies it to everything that call returns.
`observe()` reads the elements, the text digest and the title in the same in-page call that plans
them, then takes its screenshot under a plan of its own (see "How a plan is computed").

The policy says what to hide; the surface decides how. The config type is `ScreenMaskConfig`
(`@cu/core/schema`). `screenMaskOptionsFromPolicy(policy, runValues)` (`@cu/core/surface`)
bundles it with the policy's redaction patterns and a getter for the run's secret and sensitive
values. The getter is read on every capture, because a value can become known mid-run. The
options type (`ScreenMaskOptions`) is shared by both real surfaces. The Chromium surface applies
it as this document describes. The Windows desktop surface takes it through
`desktopScreenMaskFromPolicy` (`maskInputs`, whole-label `maskLabels`, the redaction patterns, the
run's values and `omitScreenshotUrlPatterns`; CSS selectors mean nothing there), paints masked
UI Automation elements in its own captures, and follows the same port contract: the masked view
for `check`/`waitFor`, `readText` flagging masked reads, `describeRef` with the masked view and
`classifyName`/`classifyText`, and no screenshot in an observation that may not carry one
(`docs/design/desktop.md`). The text half is shared too: `maskObservedElement`, `maskDescriptor`
and `createMaskMatcher` in `packages/core/src/surface/mask.ts` turn "this element was painted,
these texts were hidden" into the text view for the web surface. `FakeSurface` supports it with a
`masked` element spec and an `omitScreenshot` screen.

## The policy block

`redaction.screen` in the policy (`packages/core/src/schema/policy.ts`). The block and each field
are optional; the exported JSON schema (`packages/core/schema/policy.json`) is the input shape,
so a partial block validates. A policy without the block gets every default, which is at least as
strict as the behaviour before the block existed.

```yaml
redaction:
  patterns: [...]                # existing; now also applied to on-screen text
  screen:
    maskInputs: all              # all | typed
    maskSelectors: []
    maskLabels: []
    maskTextPatterns: true
    omitScreenshotUrlPatterns: []
```

- **`maskInputs`.** `all` (the default) paints every text-like input, textarea, select and
  contenteditable region, empty or not, so a value that appears after the plan (a script filling
  the field, a human typing during a handoff) is already under its mask. An empty field's value
  stays `''` in the text channel; it is flagged `masked`. A painted select also hides its option
  texts, which its rendered text lists. `typed` paints only
  the fields this surface typed into, and any field still holding a typed value (the behaviour
  before this block). Password fields are always painted. A field's value is masked in its own
  element only, not elsewhere on the page: a search key is echoed all over a results page, and
  hiding every echo would hide the results.
- **`maskSelectors`.** CSS selectors whose elements are always painted. The `alt`, `aria-label`
  and `title` of a painted element and of everything inside it are hidden with it.
- **`maskLabels`.** Regex sources, compiled with `i` like every policy regex. A source must match a
  **whole** label (whitespace collapsed, a trailing `:`, `：` or `﹕` dropped): it is applied as
  `^(?:source)$`, never as a substring search. So `address` matches "Address" and not "Address
  book", "Address verified" or "Email address"; a policy lists the variants it means
  (`(home |mailing |street )?address`). Every label rule below uses this whole-label match: the
  form-control, `<output>`, adjacent-cell, header-cell, `dt` and caption rules all used to
  substring-match, and now do not. The value associated
  with a matching label is hidden; the label stays visible. "Associated" means what legacy apps
  actually render, with the same associations the browser agent uses to name a control
  (`packages/browser-agent/src/naming.ts`):
  - a form control's label: `aria-label`, `aria-labelledby`, `<label for>`, the adjacent cell
    (`labelFor`), or its `title` or `placeholder`; an `<output>`'s `<label for>`;
  - a table cell whose nearest preceding non-empty cell in the row matches (`adjacentCellLabel`:
    the label/value layout, spacer cells skipped). A neighbour that is itself "Label: value" is not
    a label;
  - a value cell that carries its value only in an `alt`, `aria-label` or `title` (an `<img alt>`
    or a `<span aria-label>` in the cell) counts as having content, so it is masked too;
  - the cells under a matching header cell. Any row can be a header row: one in a `<thead>`, or
    one with two or more non-empty cells that are all `<th>` or wholly bold. A header labels the
    rows below it, up to the next header row. Columns are mapped on the table grid, with `rowspan`
    and `colspan` applied. A row that pairs a `<th>` with a plain `<td>` is a label/value row;
  - the `<dd>` elements after a matching `<dt>`;
  - the content after a `<b>`, `<strong>` or control-less `<label>` caption in the same parent, up
    to the next line break, block or caption (`<b>Phone</b> (413) 555-0100<br>`);
  - anywhere in a line of a block, the value after `Label:`. The candidates are the one to five
    words right before the colon, tried shortest first, never across a sentence end or another
    pair, and one of them must match a rule whole (`<td>Address: 1 Main St</td>`,
    `Phone: 413-555-0100<br>Address: 1 Main St`,
    `Called member about the overdue payment plan. Address: 1 Main St`). Because the one-word
    candidate is tried, a longer phrase that ends in a label word counts, deliberately: "Mailing
    address: 7 Mail Rd" and "Please confirm the following address: 8 Prose Ave" are masked as
    `address`. A phrase whose last word is not a label does not: "Address book: 12 entries",
    "Phone support hours: 9 to 5", "Address verified: yes" and
    "https://intranet/address: details" stay visible. The value runs to the next `Word:` or the
    end of the line, so several pairs on one line are masked one by one
    (`Phone: 413-555-0177 Address: 3 Pair Ave Branch: North` hides the phone and the address,
    not the branch). The separators are `:` followed by a space or the end of the line, and the
    full-width `：` (U+FF1A) and small `﹕` (U+FE55), which need nothing after them
    (`Address：1 Main St`). A `:` followed by a non-space (`10:30`, a URL) is not a separator, and a
    label word with no separator after it ("the address on file") is not a label. The same rule
    runs over `alt`, `aria-label` and `title` values (`aria-label="Address: 5 Aria Ct"`).
  The kind in the placeholder is the slug of the label that matched (`[MASKED:savings_balance]`,
  `[MASKED:address]`). A label cell that carries data ("SSN 123-45-6789") does not match a rule
  whole, so it is not a label at all.
- **`maskTextPatterns`.** When true (the default), two more rules apply. First, every match of the
  redaction patterns in a block's text is hidden, as `[MASKED:<pattern name>]`. The built-in
  patterns (SSN, card, bearer token, filesystem path) always apply, as they do for the evidence
  redactor: a policy can add patterns, never remove them. In the text channel the same patterns
  also run over element names taken from `alt` or `title`, the document title and DOM-snapshot
  attribute values. Second, every occurrence of one of the run's secret or sensitive values is
  hidden, as `[MASKED:sensitive]`. Those values are compared in the surface process and never sent
  to the page. Values learned from masked elements (see "Propagation") apply only while this flag
  is on, like the run's own values.
- **`omitScreenshotUrlPatterns`.** Regex sources matched against the top document's URL and every
  frame's URL. On a match, no screenshot is taken. `observe()` reports none, and the prompt already
  renders a missing screenshot as "screenshot omitted". `screenshot()` returns a placeholder PNG
  that reads "SCREENSHOT OMITTED / BY SCREEN MASKING POLICY" and carries a `cu:screenshot-omitted`
  text chunk (`omittedScreenshotPng`, `isOmittedScreenshot`). The text channel still flows, masked.

Text is matched per block, never per text node. The text nodes under one block element (a cell, a
paragraph, a list item) are concatenated, whitespace-collapsed, with `<br>` as a line break. A match
maps back to a DOM range across however many nodes it spans, so a value split across spans
(`Mail goes to <span>1 Main</span><span> St</span>`, `123-<b>45</b>-6789`, card digits in four
spans) is matched and hidden as one. A match that is the block's whole text hides the block
element.

Pixels are redacted in CSS. The screenshot is taken with a stylesheet (Playwright's screenshot
`style`, which it applies to every frame and shadow root for the duration of the capture) keyed
on the plan's per-capture nonce attributes. A marked element's own text, value, placeholder,
selection, first letter and first line become transparent (fill, stroke, shadow, decoration and
caret too), its box is painted grey, and everything inside it, including `::before`/`::after`, is
`visibility: hidden`. Images, canvas, video, SVG and frames that are marked themselves are hidden
outright. Because the browser lays the redaction out and paints it together with the content, in
the same frame, nothing a script does during the capture (a class toggle, an inserted rule, an
`adoptedStyleSheets` swap, a scroll, an animation) can separate a value from its mask: the value
is transparent wherever it is painted, including text that overflows its box, a `display:
contents` element, an absolutely positioned or off-screen element, and a `text-shadow` far outside
the box. Every selector carries eight `:not(#id)` terms, so the sheet out-ranks any page rule
short of an inline `!important` style or an `@layer` `!important` rule; those are checked before
every capture (see "Fail closed"). Playwright's element `mask` over the same elements stays on as
a second layer.

A hidden range that is not the whole block marks its **paint host**: the innermost element that
holds the whole range (`rangeHost`). The pixels over-mask the rest of that element (the label in
the same cell, the rest of a paragraph whose value is a bare text node); the text channel stays
precise (`Address: [MASKED:address]`). A value in a text node directly under `<body>` paints the
whole body: that screenshot shows nothing but grey. A range inside an interactive control (link,
button, `onclick`) marks the whole control, and the control's name in the text channel has only
the matched part replaced, so it keeps its verb: `Delete [MASKED:name]`.

Two rules apply on top of the policy, whatever it says:

- **Propagation.** Text hidden by a rule is hidden wherever else the page repeats it, as a range.
  Once the member name cell is masked, the name inside the heading "Member: Jane Q. Sample" is
  masked too. Within a frame the page does this itself; across frames the surface does it, so a
  value masked in a child frame is masked where the top document repeats it. Texts under 3
  characters are not propagated. A value the agent or replay reads (`readText`) from masked
  content is remembered and masked wherever a later page shows it, in pixels and text, for example
  a confirmation page that repeats an extracted balance without its label. A remembered value must
  have 6 or more characters, or 4 or more with a digit, and it matches only as a whole token: a
  remembered "0.00" never hides "$10.00", and "Yes" is never remembered.
- **One masked view.** See the next section.

`maskLabels` and `omitScreenshotUrlPatterns` sources are checked at policy load, like every other
policy regex. A CSS selector can only be checked by a browser, so an invalid one fails the plan
(see "Fail closed").

The default policy for the mock app (`policies/default.yaml`) masks the address, phone, SSN, date
of birth and email values a member page can show, with whole-label patterns that list the common
variants: `(home |mailing |street |residential |postal )?address`,
`(phone|telephone|tel\.?|mobile|cell|fax)( number| no\.?| #)?`,
`ssn|social security( number| no\.?)?|tax id|tin`, `date of birth|birth ?date|dob` and
`e-?mail( address)?`. The mock app's own labels are "Address" and "Phone", both still matched. The mock app renders an address and a phone
number. Member names and balances stay visible, because the shipped capability reads them. A
deployment that must hide a balance adds its label, and discovery still works (see the e2e test).

## One masked view

What is painted in the screenshot is masked in the text channel the same way:

- A painted element's `text` and `value` become `[MASKED:<kind>]`, and it is flagged
  `ObservedElement.masked: true`. Its `name` becomes the placeholder too, unless it is a form
  field, whose name is its label ("Nickname"). An empty field's value stays `''`. A control keeps
  its verb (see above). A password keeps its `[REDACTED]` value marker.
- Every other string the surface reports has each hidden text replaced wherever it occurs,
  whitespace- and case-insensitively. That covers other elements' names and texts (a clickable
  result row that contains a masked cell), the text digest and the title. A hidden text under 3
  characters is replaced only where it stands as a whole token ("Age 42"), and only when it is the
  whole of a hidden element (a "Go" button inside a masked panel is not hidden everywhere). A
  string cut off inside a hidden text (element names are capped at 80 and 300 characters, the
  digest at 8000) has the cut-off tail replaced too, when the tail is at least 5 characters and
  starts at a word boundary.
- A native dialog's message is masked wherever it leaves the surface: the observation, an
  `unexpected_dialog` error, the DOM comment. The message has no page to plan, so it gets recently
  hidden texts, the run's values, the patterns and the "Label: value" line rule. Conditions
  (`dialog_open` with a message pattern) still see the real message.
- The synthesized descriptor loses every locator whose match string carries hidden text: a text,
  role, label or relative-anchor locator, or a CSS selector that quotes it. Hidden text in its
  description and snapshot is replaced. The bbox locator always survives, and a value cell keeps
  the relative locator anchored on its unmasked label. So a masked element stays addressable, and
  record-time PII is never recorded into a capability's locators.
- `describeRef()` returns the masked view, so a policy event that quotes an action target never
  quotes hidden content. A masked control keeps its verb there too, as in the observation
  (`keepsVerbWhenMasked`): only the known hidden texts in its name are replaced, and when none is
  known the whole name becomes the placeholder. It also carries the real strings in `classifyName`/`classifyText`. The
  enforcing surface classifies on those and never logs them, so masking cannot blind the
  irreversible guardrail: a "Delete Jane Q. Sample" button is still a delete. The Enter-submit
  check has only the observation, so it treats a masked button or link as possibly irreversible.
  Its in-page check is cached until the document changes (a mutation counter), so a policy check
  on every action does not re-plan an unchanged page.
- Captured human actions have their target's name and text scrubbed against recently hidden texts,
  the run's values and the patterns.
- A DOM snapshot gets the same masks, applied in the page while it is copied
  (`lib.maskClone`). In the copy, each painted element's content becomes the placeholder (a masked
  select also loses its `selected` option), and each hidden text range is replaced in the text
  nodes it spans. The `alt`, `aria-label`, `title` and `value` attributes inside a painted element
  become the placeholder. The live document is never touched. Node-side, the plan's matcher then
  runs over text, comments and attribute values only. That pass catches an SSN shape in an `alt`,
  `aria-label`, `title` or `data-*` attribute anywhere, and any attribute that repeats a hidden
  text.
- Errors never quote the page. Playwright's own messages carry a call log with element previews
  ("`<div>Member Jane Q Sample at 1 Main St</div>` intercepts pointer events"), so `act()`,
  `readText()` and `resolve()` report a fixed message of their own instead ("the action timed
  out: the element was not actionable (another element covers it)"). Only a `net::ERR_*` code
  survives, and whatever text remains is scrubbed. The raw message goes to a local debug sink
  only: with `CU_DEBUG=1` the adapter writes `[cu-debug] <where>: <message>` to its own stderr
  (`packages/adapter-playwright/src/debug.ts`), never to the run log, events or Relay.

`readText()` reads the real page, and replay's conditions evaluate against it. Extraction happens
locally, and a recorded postcondition must see what the page really says.

## Conditions the model writes are evaluated in the masked view

Condition text the model supplies (`expect` on click, type, select, press and navigate;
`success_text`; `detector_text`; `trigger_text`) would otherwise be a yes/no oracle on hidden text:
checked against the real page, a model guessing part of an SSN would learn whether it guessed right.

So in discovery, whether such a condition holds is a pure function of the masked view.
`Surface.check(condition, { view: 'masked' })` and `waitFor(..., { view: 'masked' })` read each
frame's body text in the same in-page call that plans that frame's masks (`lib.maskObserveText`),
put it through that plan's matcher, and evaluate the condition against the result. A frame the
plan does not cover reads as empty. No tool consults the real page for model-written text.

Text that is not in the masked view is simply not visible. A correct guess at a hidden value and a
wrong guess get the same answer, the same message ("... is not visible"), the same code path, the
same events and the same capability output. Nothing about the guess is treated specially: it is not
refused, not registered with any scrubber, not looked up anywhere else. The acceptance test runs
discovery on the real surface twice per tool, once with the hidden value and once with a wrong
value of the same length, and requires the prompts, tool results, transcript, events, result and
capability to be byte-identical apart from the guess string itself.

What this means for persistence: the guess is model output, so it is recorded like any other model
output: in `transcript.jsonl`, in the decision events, and in the feedback that echoes it ("`<guess>`
is not visible"). The evidence redactor's patterns apply to it as to everything (an SSN-shaped guess
is redacted); a free-text guess ("1 Main St") is written as is. Treating a correct guess differently
would be the oracle. A condition is recorded into the capability only when it holds in the masked
view, so a recorded condition never names hidden text. But the model's own prose is recorded: a
step's name comes from the tool call's `why`, so a guess the model writes there is persisted in the
capability, the same for a correct and a wrong guess (not an oracle, but a persisted guess).

This is the smallest contract change that says "evaluate in the masked view": an optional flag on
`check`/`waitFor` that every wrapper forwards. The alternative was for the agent to test text
against a masked observation. That would cost a full `observe()` (a screenshot) on every poll of
a `waitFor`, and it could not evaluate frame-scoped conditions. Replay keeps evaluating recorded
conditions against the real page; they were written in the masked view, so they hold no hidden
text.

## The model extracts what it cannot see

The model finds a masked field by its placeholder (`cell "[MASKED:savings_balance]"`) and calls
`extract` on its ref. The agent (`packages/core/src/agent/tool-handlers.ts`):

1. Reads the real text through `readText`. The surface reports `masked: true` when the read
   touched masked content: the element, an ancestor or a descendant is painted, a hidden range
   lies inside it, or the full text holds something the plan hides. The full text matters because
   a long notes block can carry a label-masked phone number past the 300-character text the
   observation shows. The agent keys "withhold and record sensitive" off that signal (or a
   placeholder in the observed element).
2. Registers the text with the run's scrubber as `<masked:<output>>` before anything else. From
   then on, nothing derived from it can enter the prompt, the transcript or the event log, even an
   error message that would quote it.
3. Withholds the value from the model: "Extracted savingsBalance; the value is withheld because
   the field is masked." A parse failure says the same, without quoting the text.
4. Records the extract step against the already-sanitized descriptor. The recorder scrubs the
   value out of the capability's prose as well, as it does for every extracted value.
5. Marks the output `sensitive: true` (`OutputSpec.sensitive`, `packages/core/src/schema/capability.ts`).
   A business-outcome return is marked the same way when its element shows masked content or
   reading it would touch some.

`DiscoveryResult.outputs` carries the real value back to the caller. The `discover` command prints
it to the operator who ran it. The discovery `result.json` holds `<masked:savingsBalance>`.

## Sensitive outputs in replay

A sensitive output is returned to the caller and redacted wherever it would persist:

- On extract, the raw text is registered with replay's value scrubber before parsing, so the safe
  logger scrubs it from every event, DOM snapshot and failure. A failed parse or coercion reports
  "the extracted text is withheld: the output is sensitive" instead of quoting the text.
- An output the capability does not flag is treated the same way for the run when `readText`
  reports it was read from masked content. That happens with a capability discovered under a
  looser policy and replayed under a stricter one. Replay writes a `policy` event
  (`gate: 'screen_mask', decision: 'sensitive_output'`, no value), so the gap is visible.
- `result.json`, and the `outcome` event replay writes after an escalation, hold `[REDACTED]` for
  each sensitive output and sensitive business-outcome return, by name. Names are needed because
  the value scrubber only matches strings, and a short value is below its minimum length.
- The `ReplayResult` returned to the caller (an agent through the catalog, a test, the CLI)
  carries the value.
- The CLI human summary (`replay`, `catalog invoke`) shows `<sensitive>` in place of the value,
  because a terminal's scrollback and CI logs are persistent sinks. `--json` prints the full
  result, value included: it is the programmatic return channel, and the caller asked for the data.

## Fail closed

What is detected, and what happens:

- **A rendered frame that cannot be planned** (the top document, or a child frame whose frame
  element has a box). The causes are an agent the page made unusable, a plan that keeps failing
  after one retry, a rule the page rejects (an invalid selector), or marking failing.
  `screenshot()` returns the omitted placeholder and `observe()` reports no screenshot. That
  frame's elements and text are left out of the observation, and `domSnapshot()` writes it as
  "unavailable". When it is the top document, the observation's title is withheld too. A frame
  that is detached, or whose frame element has no box, shows nothing and is skipped.
- **A page whose styles out-rank the redaction.** Before every capture `lib.maskSheetCheck` adopts
  the redaction stylesheet for a moment and reads the computed style of every marked element, every
  paint host and every password field: own text and pseudo-elements transparent, every descendant
  and its `::before`/`::after` hidden, a marked image hidden. An inline `!important` style or an
  `@layer` `!important` rule beats it; then no screenshot is taken (the text channel flows). A
  page whose own styles always out-rank the sheet therefore gets **no screenshots at all**: a
  utility framework that puts `!important` colours in an `@layer`, inline `!important` colours on
  value cells, or a browser in `forced-colors: active` (system colours replace `color:
  transparent`; observed in review, not pinned by a test here). It fails closed, and the model works from the masked text channel.
- **A page that changes between the plan and the pixels.** CSS redaction moves with the content, so
  movement (a class toggle, an inserted rule, a stylesheet swap, a scroll, an animation, a
  re-layout) needs no detection. What CSS cannot cover is content the plan never marked. After every
  capture the plan is verified, and the capture is discarded when any of these happened:
  - a frame navigated (Playwright's `framenavigated`) or a frame appeared;
  - the in-page MutationObserver counted a node or text change, a `value` or `alt` change, or a
    `style` change on or inside marked content (an inline `!important` set during the capture).
    Changes inside an element marked whole are not counted: the stylesheet hides all of it and a
    DOM snapshot replaces all of it. Class, scroll and other style changes are not counted, and
    neither are the capture's own artifacts (the stylesheet Playwright inserts, which starts with
    the plan's nonce, and its mask glass pane);
  - the content fingerprint (a hash of every text node, field value, `alt`, `aria-label` and
    `title` outside wholly marked elements, from DOM reads alone) differs from the plan's;
  - a mark or paint mark is missing, or a typed-into field lost its mark (a page script that strips
    them).

  A discarded screenshot is re-planned, up to 3 times, with up to 1 s between attempts for the page
  to finish loading. After that `screenshot()` returns the omitted placeholder and `observe()`
  reports none. `domSnapshot()` is verified the same way, and otherwise writes "DOM withheld".
- **Text that changes while it is read.** The observation's elements, digest and title, and the
  masked condition view, are read in the same synchronous in-page call that plans them
  (`lib.maskObserve`, `lib.maskObserveText`), so they are exactly what the plan saw; a busy page
  cannot slip text in between. A frame without such a read (it attached after the plan) reports
  nothing; the observation re-reads up to 3 times while frames keep appearing.
- **A page that never answers** (a script in an endless loop). Plan, capture and verification run
  under a per-surface lock with a deadline: 20 s (`captureDeadlineMs`), and 9 times that for
  `observe()`, which also enumerates the page inside its plan (see "Cost"). Past it the
  caller gets the withheld form, the lock is released, and the abandoned work checks a flag and
  captures nothing when it resumes. `describeRef` falls back to the masked ref snapshot, and
  `readText` counts as masked.
- **More than 200,000 text blocks or fields in a frame.** The ones past the limit could not be
  compared against the run's values, so the frame fails.
- **A native dialog** blocks script evaluation, so nothing can be planned while one is held.
  `screenshot()` returns the placeholder, unless the policy could mask nothing anyway (typed-only
  inputs, nothing typed, no selectors, labels, patterns or run values). A dialog-blocked
  observation reports the last masked text digest.
- **An invalid `omitScreenshotUrlPatterns` source** matches every URL.
- **A pinned agent of another major** still fails `observe()` loudly with `AgentVersionError`.

Measured behaviour on the real surface (`screen-mask-capture.redteam.test.ts`, 100 returned
captures required for each):

| Page activity during capture | Returned | Withheld | Leaked |
|---|---|---|---|
| class toggle shifting a margin every 7 ms | 100 | 0 | 0 |
| `adoptedStyleSheets` swap every 3 ms | 100 | 0 | 0 |
| `adoptedStyleSheets` swap every 7 ms | 100 | 0 | 0 |
| `insertRule`/`deleteRule` every 5 ms | 100 | 0 | 0 |
| 50 ms `style.left` ticker on unrelated content | 10 of 10 | 0 | 0 |
| the same ticker moving the masked table | 10 of 10 | 0 | 0 |
| inline `color: ... !important` toggled on a masked cell every 4 ms | 0 | 60 | 0 |

With the stylesheet removed (element masks only), the 3 ms and 7 ms stylesheet swaps leaked in 52
and 59 of 100 captures. The inline `!important` row is a page that out-ranks the redaction while
it is being captured: the observer counts every toggle and discards every capture. With that
counting switched off, 20 of 49 captures went out and none leaked (the sheet check withheld the
rest); with Playwright's element mask also removed, 20 of 39 went out and none leaked either. So
this run does not show which of the two layers would catch a toggle that lands inside a capture:
it shows the counter's cost on such a page (nothing goes out), and that the element mask is kept
as a second layer, not that it is needed here. The seeded fuzzer (below), which
re-renders sections, edits values in place and reloads a frame every few tens of ms, still has a
third to a half of its screenshots withheld; a re-rendered node is unmarked content, so those
discards are correct. Its DOM snapshots almost always go out.

What is not detected: see "Limits".

## How a plan is computed

`packages/adapter-playwright/src/mask.ts`, per capture, across every frame, under the lock:

1. The elements this surface typed into are marked through handles it owns. This covers a page
   that reformats a typed value.
2. In each frame, one synchronous in-page call applies the rules
   (`packages/browser-agent/src/mask.ts`): `lib.maskPlan(opts)` for a screenshot or DOM snapshot,
   `lib.maskObserve(opts)` for an observation (the plan, then the frame's enumeration, then every
   enumerated element's mask kind) and `lib.maskObserveText(opts)` for the masked condition view
   (the plan, then the body text). The plan first collects every mark, then writes them as a
   per-plan nonce attribute, then marks the paint host of every hidden range. `opts` carries only
   policy (selectors, label and pattern sources), never a run value. The call returns the hidden
   texts, and the text of every block and the value of every field it left visible.
3. In the surface process, those blocks are compared against the run's secret and sensitive
   values, the values this surface typed, learned values, and the text other frames hid. A frame
   with a hit gets one more call (`lib.maskMark`) with the ranges and fields to hide; it marks
   paint hosts the same way. A page on one origin never learns a value typed on, or shown by,
   another. The observation's text goes through the matcher built from all of it, so a value
   matched here is replaced in the text read in step 2.
4. For a screenshot: check that the redaction stylesheet wins (`lib.maskSheetCheck`), capture with
   it as Playwright's `style` and Playwright's `mask` over every password field,
   `[data-cu-mask="<nonce>"]` and `[data-cu-mask-paint="<nonce>"]`, verify (`lib.maskVerify`),
   and remove every mark.

The browser agent never inserts an element: its only writes are its two mark attributes (and,
for the duration of `maskSheetCheck`, an adopted stylesheet). The redaction stylesheet itself is
inserted by Playwright during the capture and removed after it.

Which functions decide "this is masked":

| Question | Function |
|---|---|
| Which elements, text ranges and fields a rule hides, in the page | `maskPlan` (`packages/browser-agent/src/mask.ts`) |
| Which ranges and fields hold a run, typed, learned or cross-frame value | the adapter's `ScreenMasker.plan` (`findRanges`, `fieldValues`), then `maskMark` in the page |
| The element a hidden range is painted with | `rangeHost` (browser agent) |
| The value after an inline `Label:` (blocks and `alt`/`aria-label`/`title`) | `labelledValues` (browser agent) |
| What the pixels hide for a mark | `redactionSheet` (adapter), checked by `maskSheetCheck` (browser agent) |
| The mask kind of each enumerated element | `maskKindsOf` (browser agent), read in `maskObserve`; consumed by the adapter's `enumeratePage` |
| The kind of one element, for `describeRef` and the policy check | `maskKindOf` (browser agent) |
| Whether a read touched masked content | `maskTouches` (browser agent), plus the plan matcher, in the adapter's `readTouchesMask` |
| The text view of an element and its descriptor | `maskObservedElement`, `maskDescriptor`, `keepsVerbWhenMasked` (`packages/core/src/surface/mask.ts`) |
| Which strings a hidden text replaces | `createMaskMatcher` (core) |

Plans never overlap on one surface. Relay's live view polling during an observation, or a policy
check describing a target, cannot re-mark another capture's elements with its own nonce, which
would send that capture out unmasked. A one-element probe (`describeRef`) plans under its own
attribute. Propagation and the Node-side comparisons scan with an index on the first characters
of each text, and the text-channel matcher does the same. A replace costs one pass over the
input, not one pass per masked text, which keeps a 5,000-row table with a masked column fast.

## Cost

Median ms over 3 runs, headless Chromium, 1280x800, on the shared development machine (load from
other runs varies, by a factor of 2 on the large tables). "Base" is the commit before screen
masking, measured in the same session. "Now" uses `policies/default.yaml`'s screen block, which
masks the address column of the tables, and "now, no labels" uses the same block with
`maskLabels: []`. `describeRef` is reported for a cell ref and a button ref, cold (the document
changed since the last policy check, so the page is planned again) and warm (cached).

| Page | Run | observe | screenshot | domSnapshot | describeRef cell cold / warm | describeRef button cold / warm |
|---|---|---|---|---|---|---|
| mock member page | base | 63 | 29 | 2 | 5 / 5 | not measured |
| | now | 95 | 47 | 12 | 7 / 4 | not measured |
| | now, no labels | 82 | 69 | 11 | 6 / 4 | not measured |
| 500-row table | base | 1,692 | 29 | 3 | 2 / 2 | 2 / 2 |
| | now | 2,242 | 122 | 55 | 16 / 2 | 18 / 4 |
| | now, no labels | 1,893 | 62 | 24 | 8 / 3 | 9 / 3 |
| 5,000-row table | base | 260,606 (1 run, earlier) | 40 | 18 | 4 / 4 | 2 / 2 |
| | now | 170,790 (1 run, earlier) | 1,122 | 655 | 195 / 6 | 183 / 6 |
| | now, no labels | not run | 247 | 174 | 55 / 4 | 58 / 3 |

A cold `describeRef` re-plans the whole page under the probe attribute, so on 5,000 rows it costs
what a plan costs (about 190 ms with label rules, 55 ms without); a warm one is a cache hit. The
reviewer measured 64 ms and 125 ms for a button ref; the 8 ms reported last round was the warm
figure.

`observe()` on a large table is dominated by element enumeration, which costs the same with or
without masking (the reviewer measured 113 s median on the base commit; one run here took 261 s).
With masking the enumeration runs inside the plan's in-page call, and `observe()` has a deadline of
9 capture deadlines (180 s by default). Past it the observation is withheld: no screenshot, no
elements, no text. One run here finished in 171 s; another, taken while a test suite was running
on the same machine, hit the deadline and was withheld. So on a page this size the deadline, not
masking, decides whether an observation comes back.

The 5,000-row screenshot cost is the plan, the sheet check (computed styles of 5,000 marked cells,
their pseudo-elements and descendants), Playwright's element masks over 5,000 elements and the
verification. The DOM snapshot cost is the in-page masked copy and the matcher pass over the
markup. Without label rules both are within a few hundred ms. The base commit has no masking, so
there is nothing to compare these with.

## Limits

These are stated plainly, because they are where PII still gets through. The seeded leak fuzzer
(`screen-mask-fuzz.redteam.test.ts`) does not generate any of them; each item says what it would
take to.

1. **Rule-based masking catches only what the rules name.** PII in an unlabelled free-text note, in
   a label nobody wrote a rule for (whole-label matching means every variant must be listed:
   "Residence" is not "Address"), under a layout the label rules do not know, or in a shape no
   redaction pattern matches, is visible to the model and in evidence, in pixels and text. Inline
   "Label: value" separators other than `:`, `：` and `﹕` are deliberately not handled: `=`, `-`,
   `—`, `|`, a tab, `∶` (U+2236 RATIO), `꞉` (U+A789) and script-specific colons, and a label
   followed by its value with no separator at all ("Address 1 Main St"). The defaults are a
   starting point, not a classification of the page. (The fuzzer only places PII where a rule
   names it.)
2. **Pixels that are not DOM text are not masked.** A scanned document, a signature image, a chart
   on a canvas, a PDF or plugin have no text to match: they go out in screenshots unless a selector
   rule marks them. CSS generated content (`::before`/`::after`) is hidden on and inside marked
   elements, but generated content elsewhere that renders a value (`content: attr(data-x)`) is
   not. An `<img alt>` value is hidden in the text channel and the DOM snapshot, but the image's
   pixels are not. OCR-based pixel redaction is the fallback and is not built (no OCR dependency).
   (The fuzzer draws no text into images or generated content.)
3. **A value carried only by an attribute, outside any rule.** An `aria-label`, `alt` or `title`
   holding a bare value (`<span aria-label="1 Main St">●</span>` next to the word "Address") is
   not claimed by any rule: it reaches element names in the observation and the DOM snapshot. The
   rules do claim it inside a label-rule value cell, inside a marked element, as an inline
   `Address: ...` pair in the attribute itself, or when it matches a pattern or repeats a hidden
   text. (The fuzzer puts attribute values only in label-rule cells.)
4. **A native dialog is masked only by what the surface already knows.** Its message has no page
   to plan: it gets recently hidden texts, the run's values, the patterns and the "Label: value"
   line rule. A dialog that opens at load, before any capture of that page, and quotes a
   label-masked value in free text (`alert("Confirm mail to 1 Main St")`) goes out verbatim in the
   observation's `dialog`, an `unexpected_dialog` error and the DOM comment. Pinned as a limit,
   not fixed. (The fuzzer opens no dialogs.)
5. **Styles that out-rank the redaction after the check.** The sheet check runs just before the
   capture, and an inline `style` change on marked content is counted. A class toggle or a
   stylesheet change that activates an `@layer` `!important` rule beating the sheet between the
   check and the pixels is not counted; then only Playwright's element mask (a box measured just
   before the pixels) covers it. (The fuzzer's stylesheets never out-rank the sheet.)
6. **The page's own code runs in the same realm as the agent.** A page that overrides the DOM APIs
   the planner uses (`querySelectorAll`, `createTreeWalker`, `getComputedStyle`) can make the plan
   or the sheet check come back well-formed but wrong, and then label-masked values and echoed run
   values go out in pixels and text (values the surface typed are still marked through its own
   handles). In injected mode the agent's init script runs before page scripts in every frame and
   keeps its own copies of `MutationObserver` (constructor, `observe`, `takeRecords`), so
   replacing them later changes nothing. Where the agent arrives after the page's scripts
   (included mode, or a frame `ensureAgent` reaches late), a replaced observer goes unnoticed; the
   content fingerprint is plain DOM reads and still catches unmarked content that persists, but
   content flashed in and out during the capture can be captured. (The fuzzer's mutations are
   benign; the hostile-observer test patches after the agent.)
7. **Shadow DOM.** The stylesheet pierces shadow roots, but the rules do not walk into them, so
   nothing inside a shadow root is marked: its text is neither planned nor redacted. (The fuzzer
   generates no shadow roots.)
8. **Per-frame fail-closed is per frame for text.** When one frame cannot be planned, its own text
   is dropped, but another frame that repeats a value only the failed frame would have hidden (by
   propagation) still reports it. The screenshot is withheld in that case.
9. **URLs are not masked.** `Observation.url`, frame URLs and the URLs in navigation events go
   through the existing value scrubbers only. A query string that carries a member's address is
   visible.
10. **The kind names what was hidden.** `[MASKED:address]` tells the model an address is on the
    page.
11. **The model's own words persist.** A model-written condition is recorded as model output (see
    "Conditions"), and a step's name comes from the model's `why`. A free-text guess at a hidden
    value is in the transcript, the events and, through `why`, the capability, as written; it is
    never confirmed or refuted, but if the model already knew the value, it is there.
12. **Two bits the model can still learn.** `select` with a model-written option label succeeds or
    fails depending on whether a masked select has that option: whether an option exists, not
    which one is selected. `extract` with `parse: number` (or `currency`) on a masked value answers
    "Extracted ..." or "Could not parse ...": whether the hidden text is numeric, not what it is,
    and not steerable toward its content. The parse failure is not hidden, because a capability
    recorded with the wrong parse type would be broken.
13. **Default `maskInputs: all` costs the model state.** Every field is painted, every select with
    it (a select always has a value), and so are read-only and disabled display fields. The model
    loses the current selection and those values, which can make discovery of a form harder.
    `maskInputs: typed` trades that back for weaker handoff protection.
14. **Pixels over-mask, and busy pages lose screenshots.** A paint host is the innermost element
    holding the hidden range: the label in the same cell, or the rest of a paragraph whose value
    is a bare text node, is greyed with it. That cost is real for a mid-line label in long prose:
    the reviewer measured 67.9% of the viewport greyed for one long paragraph, and 100% for a
    value in a text node directly under `<body>` (the body is the paint host). Playwright's
    second-layer element mask paints each marked element's whole box, even the part a scroll or
    clip container hides, so grey boxes can spill over the content below a scroll container
    (cosmetic: nothing is revealed). A page that keeps re-rendering or editing unmarked content gets fewer screenshots
    (each such change discards the capture), and the model works from the masked text.
15. **A long control keeps the part of its name the observation shows.** The name of a long masked
    control is capped at 80 characters. The hidden part can lie beyond that, and then the name the
    model sees is unchanged, though the control is painted and flagged masked.

## Tests

| What | Where |
|---|---|
| Each in-page rule against fixture pages: whole-label matching (a label cell carrying data is no label; "Address book" is not "Address"), full-width colons, label/value cells with a spacer cell, header rows anywhere with rowspan/colspan, dt/dd, captions, `<label for>`, `<output>`, title/placeholder, one-cell "Label: value", "Label: value" anywhere in a line (long prose, several pairs, a body-level text node, `aria-label`; not a bare label word or a time), values split across spans, `alt`/`aria-label`-only cells, selectors, empty and filled fields under `all`, select options, patterns, propagation, controls, aria-labels, paint hosts, `maskObserve`, `maskSheetCheck` (inline `!important`, a descendant forced visible), invalid rules, `maskVerify` (style and scroll not counted; text, `value`, stripped marks and paint marks counted), the `maskKindOf` cache | `packages/browser-agent/test/mask.test.ts` |
| One page with every layout and rule: zero PII-coloured pixels over the whole PNG (control: many), no PII in elements, digest, title or DOM; controls keep their verb; `readText` and the masked condition view; nested frames; run values mid-run; learned values whole-token only; dialogs; `maskInputs`; omitted screenshots; defaults | `packages/adapter-playwright/src/screen-mask.test.ts`, `mask.test.ts` |
| Fail closed: sabotaged agent (top: title withheld; child frame), invalid selector, busy pages, mark stripping, overlapping captures, an endless loop, 25,000 blocks with a run value, a browser error quoting the page, a native dialog | `packages/adapter-playwright/src/screen-mask.redteam.test.ts` |
| The capture: full-width colons hide the value in pixels and text, and "Address book:", "Phone support hours:", "Address verified:" and a URL ending in `address:` keep theirs; layout shifts faster than a frame (7 ms class toggle, 3 ms and 7 ms stylesheet swaps, 5 ms rule insertion; 100 returned captures each, none leaked); an inline `!important` that out-ranks the sheet (withheld), set during the capture (discarded); overflow, `display: contents`, absolutely positioned and `text-shadow` values; a 50 ms ticker on unrelated and on masked content; infinite animations and transitions; a page replacing `MutationObserver` and flashing PII; a field filled after the plan; `alt`/`aria-label` values in the DOM snapshot; verb consistency between the observation and `describeRef`; the `CU_DEBUG` sink | `packages/adapter-playwright/src/screen-mask-capture.redteam.test.ts` |
| Seeded leak fuzzer, four seeds by default: generated pages (table label/value with `alt` values, one-cell and `<br>` "Label: value", prose with a mid-line label, split nodes, `dt`/`dd`, captions, header rows with `rowspan`, propagation into a heading, a run value, typed and late-filled fields, a scroll container, overflow, `display: contents`, absolute positioning, a child frame) under random benign mutations during capture (including in-place edits, re-renders with new values, `requestAnimationFrame` and Web Animations, sub-10 ms toggle bursts); a real capture at rest on every page; at rest, at least 90% of the non-PII marker pixels an unmasked screenshot shows (lowest measured: 96.2% over 60 pages), so a masker that greys the page fails; zero PII pixels and strings in every returned capture; withheld counts reported. `CU_MASK_FUZZ_SEED`, `CU_MASK_FUZZ_ITERATIONS`, `CU_MASK_FUZZ_CAPTURES` override the CI values | `packages/adapter-playwright/src/screen-mask-fuzz.redteam.test.ts` |
| Real surface + agent: extracting a notes block that holds masked values past the text cap is withheld and recorded sensitive; no oracle: a correct and a wrong guess of a hidden value are byte-identical apart from the guess, through `expect` on click/type/select/press/navigate, `done`, `declare_outcome` (with returns) and `dismiss_interstitial` | `packages/adapter-playwright/src/screen-mask-agent.redteam.test.ts` |
| Every condition discovery evaluates for model-written text, including the optimizer's vacuous-expectation pre-check before an action, goes to the surface with `{ view: 'masked' }` | `packages/core/src/agent/masked-view-conditions.redteam.test.ts` |
| The desktop surface's contract: the masked view for `check`/`waitFor`, `readText` flagging masked reads, `describeRef` with the masked view and `classifyName`/`classifyText` (a policy decision event never quotes a masked control), no screenshot in an observation that may not carry one, and the policy mapping (whole labels, `maskInputs: all`, run values) | `packages/adapter-desktop/src/screen-mask.redteam.test.ts`, `apps/cu/src/runtime/desktop.test.ts` |
| A masked control is still classified irreversible, and its decision event quotes only the masked view | `packages/core/src/policy/screen-mask-guard.redteam.test.ts` |
| Matcher (tokens, patterns, truncated tails, 5,000 texts), placeholders, element and descriptor masking, labelled lines, omitted placeholder | `packages/core/src/surface/mask.test.ts` |
| `FakeSurface` masked specs, masked `readText`, omitted screenshots | `packages/core/src/surface/fake-mask.test.ts` |
| The policy block: defaults, partial blocks, strictness, regex checks, the input-shaped JSON schema | `packages/core/src/schema/screen-mask-policy.test.ts` |
| A masked value never reaches the prompts, transcript, events, result or capability | `packages/core/src/agent/screen-mask-leak.redteam.test.ts` |
| A sensitive output never reaches any file in a replay run directory, including on a parse failure, and an unflagged output read from masked content is treated as sensitive | `packages/core/src/replay/sensitive-output.redteam.test.ts` |
| Real mock app: discovery extracts the balance through a masked field, the capability records it sensitive with no PII, and replay returns it with clean evidence | `tests/e2e/screen-mask.test.ts` |

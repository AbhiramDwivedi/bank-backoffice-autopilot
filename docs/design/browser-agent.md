# Browser agent: @cu/browser-agent

`@cu/browser-agent` is the accessible-naming, enumeration and human-action-capture code that runs
inside the target page, as a standalone, dependency-free browser package. The Playwright adapter
drives it (`packages/adapter-playwright/src/inpage.ts`, see [`docs/design/surface.md`](./surface.md)).
It has one codebase and two integration modes.

## Why one library for both modes

A driver injects the agent into any app, including ones nobody can modify: Playwright's
`addInitScript({ content: agentSource() })` for documents that have not loaded yet, plus
`frame.evaluate(agentSource())` for one that already has. An app can also include the agent itself,
as a `<script>` tag in `<head>`, the way a RUM or analytics tag ships. Both modes run the same
bundle, so naming, enumeration and selector output never diverge between an app that ships the tag
and one the driver injects cold. When the driver attaches to a page that already includes the tag,
it reuses the installed agent instead of injecting a second copy.

## Install, versioning and idempotency

The bundle installs `window.__cuAgent` once per document, as a non-enumerable property, so page
code that enumerates `window` does not see it. Install also sets `data-cu-agent="<version>"` on
`<html>`, so the agent's presence is detectable without running any JavaScript. Install inserts no
other DOM node.

Version compatibility follows semver majors:

- An installed agent with the same major version and the same or a newer minor/patch is reused
  as is.
- An installed agent with the same major but an older version is replaced silently.
- A different major is always replaced, whichever is newer: the last bundle to install wins. The
  conflict is logged with one `console.warn` per document.
- A replacement stops the old agent's capture first and restarts it on the new agent if it was
  active.

Driver detection reads `window.__cuAgent.version` and calls `isCurrentAgentVersion(v)` (exported
from `src/index.ts`): same major as the driver's copy and not older. The result is reported as
`compatible` in the agent detection. When the agent is absent, of another major, or older (an older
copy lacks API the driver calls, such as `lib.findAdjacentCellControls`), the driver evaluates its
own bundle, re-reads the version, and throws `AgentVersionError` if the page still holds an agent it
cannot use (for example a non-writable copy the page pinned). An app that ships a different major,
or an older copy of the same major, therefore gets the driver's own copy before any observation runs.

## Integration in this repo

Two consumers use the package, one per mode.

- **The mock app includes it** (`apps/mock-app`). The app depends on `@cu/browser-agent`, serves
  `agentSource()` at `GET /static/cu-agent.js` (unauthenticated, delayed by `slowMs` like any asset),
  and every view puts `<script src="/static/cu-agent.js">` first in `<head>` through
  `views/partials/cu-agent.ejs`, in every frame. The tag installs the agent and never starts capture
  or calls `enumerate()`. The app's hostile markup is unchanged (`docs/design/mock-app.md`).
- **The Playwright adapter injects or reuses it** (`packages/adapter-playwright/src/inpage.ts`; see
  `docs/design/surface.md`). The adapter carries no in-page library of its own.
  `createPlaywrightSurface` adds one init script per browser context, and `ensureAgent(frame)` covers a document that loaded before the surface attached, as
  described above. Enumeration calls `__cuAgent.enumerate()`, resolution calls `__cuAgent.lib`, and
  handoff capture calls `__cuAgent.capture.start()`/`stop()` in every frame, with records arriving
  through the `__cuHumanAction` binding.

The adapter does not inject `agentSource()` bare. It wraps the bundle in a marker
(`agentInjectionSource()`) that records, under `Symbol.for('cu-agent.driver')`, that the driver
installed this document's agent. The marker replaces `window.__cuAgent` with a non-enumerable getter
that returns the same object and notes a read made while a page `<script>` element is executing.
When the app's tag runs after the init script, its install reads the global, finds a same-major
agent and stops, and that read is what marks the document as app-included. `detectAgent(frame)`
reports `source: 'app'` (the tag ran, or the agent was there before the driver attached),
`'injected'` or `'none'`. The adapter runs it once per surface, on every frame after `ensureAgent`,
and hands `{ browserAgent: { source, present, version, compatible, replacedVersion, frames } }` to the
`onAgentDetected` option; `replacedVersion` names an app copy the driver's copy replaced. To put it
in a run's `events.jsonl`, the composition root passes that option and logs the detail as an
`observation` event. Like everything else the agent reports, `source` comes from the page and can be
spoofed: it is evidence of which mode ran, not a trust decision.

## What enumerate() lists

`enumerate()` returns three groups, in this order, each in document order:

1. **interactive**: native controls, links, `[onclick]`, `.btn`, `li[data-value]`, ARIA widget
   roles, editable regions.
2. **informative**: the legacy rules: headings, label/value table cells (a cell with a
   text-bearing sibling cell), `td.msg`-style message cells, short `<b>`/`<font>` texts, `<li>`
   inside `ul.errors`.
3. **text** (since 1.4.0, `src/leaves.ts`): every other leaf text block. Without it, a value on
   modern markup had no ref: on a storefront the model could read a product's price in the
   screenshot but had no element to extract it from, because the price is a `<div>` in a card and
   no legacy rule matches a `<div>`.

A **text leaf** is a visible element with a direct text node holding a letter or digit, so it
renders text itself instead of inheriting it. The rule is not a tag list: a `<div>`, `<span>`,
`<p>`, `<dd>`, `<li>`, `<time>`, `role=status` element or lone `<td>` qualifies the same way.
`<div><span>$5</span></div>` lists the span. `<p>Total: <b>$5</b></p>` lists the paragraph as
"Total: $5", and the `<b>` stays informative. A class-less, id-less inline child of a leaf
(`<em>`, `<span>`) is absorbed into its parent's sentence. One with a class is kept, because
authors style a value separately exactly when it is a value.

The following are left out:

- Text inside an interactive element (it is that control's name).
- Text inside an element a legacy rule already lists, as long as that element's name (capped at
  80 characters) can show all of it. Inside a longer legacy element, such as a `<font>` that
  wraps a whole sentence, the legacy element counts as the leaf's sentence: class-less inline text
  is absorbed and a marked-up value (`<span class="fee">$7.25</span>`) is listed.
- A listed control's label source: its `<label>`, its `aria-labelledby` target, or the adjacent
  cell that names it. Known gap: an `aria-labelledby` target that is itself a value (a button
  labelled by "title price") is left out too.
- Text a person cannot see: hidden or zero-size boxes, `opacity: 0` on the element or an ancestor,
  anything inside `aria-hidden="true"`, a box of 1px or less in either direction
  (screen-reader-only text), and anything placed off the page's top or left edge
  (`left: -9999px`). Non-text tags are left out too.
- Separators with no letter or digit.
- Text over 200 characters. A long paragraph is prose, not a value. It stays readable in
  `bodyText`. A value inside it that the author marked up is still listed on its own.

The text group comes last, so the interactive and informative entries, their order and their refs
are what they were before 1.4.0. The existing enumeration, self-consistency and e2e suites pass
unchanged, and shipped capabilities replay unchanged. Each entry does carry two new fields,
`containerAnchors` and `inViewport`.

### The cap

The Playwright surface lists at most 150 elements across all frames. The page applies the same
selection per frame (`src/cap.ts`, shared by the page and the driver) before it computes any
descriptor inputs. The selection works like this:

1. A third of the cap (or every text leaf, when there are fewer) is held for text leaves.
2. The rest goes to interactive entries, then informative ones.
3. What those two leave unused goes to more text leaves.

Within each tier, entries inside the viewport come first, because they are what the screenshot
shows. Text leaves then go by `priority`, then document order. The kept entries are listed in
frame and document order. The priorities are:

- **0**: a message (inside `role=alert`/`status` or an `aria-live` region), or a short value: a
  digit and at most 40 characters, such as a price, date, count or id.
- **1**: a short leaf (at most 80 characters) within three levels of a control.
- **2**: any other short leaf.
- **3**: a leaf of 81 to 200 characters.

The reserve exists because without it controls can fill the cap and list no text at all. On a
200-card list, the 400 links and buttons used to take all 150 slots and no price was listed. Now
the cap keeps 100 controls and 50 text leaves, with the on-screen cards' prices first.

The remaining limit is that a value on an off-screen card of a long list gets no ref. The agent
has no scroll tool, so the model reaches it through a page that shows that record on its own. The
observation reports the number of dropped elements as `elementsOmitted`. The prompt's list header
then says how many elements are listed, how many are not, and what that means for the model.

### Finding a text leaf again: exact, container-bounded anchors

A value in a card is identified by the record it belongs to. The text directly above a card's
price is the card's summary. A `relative` locator anchored on that summary finds the recorded
product's price for every input, and so does a structural CSS path. Each element without a row
anchor therefore gets `containerAnchors`.

The **container** is the nearest ancestor that holds, outside the element, a usable anchor and has
a stable class selector. The anchor must climb back to that ancestor as its nearest match for the
selector. A usable anchor is a visible element that meets all of these conditions:

- It renders its own text, at most 80 characters.
- Its text is unique in the document, counted the way the anchor lookup finds it: innermost
  elements, no climb to a clickable ancestor.
- It is not value-like. Value-like means at most 40 characters, with digits making up at least
  half of its letters and digits: "$29.99" and "Order 12345" are value-like, "Model 3 Charger" is
  not.

A level with no stable container selector, or with only value-like anchors, does not end the
climb. The climb stops at `<body>` or at a subtree of more than 400 elements. Anchors are
preferred in this order: a heading, a link's text, then document order. At most three are kept,
so that when the run's input is one of them, the recorder keeps that one.

Each anchor carries a relation from record-time geometry, a candidate filter (tag, real role, and a
class `selector` such as `div.product-cost`) and `within`, the container's class selector, such as
`div.product-info`. A class token slugged from the element's own text, or from the anchor's
(`state-in-transit`, `order-alpha`), is never used. Such a class matches only records holding the
same value.

The `relative` locator schema gained three optional fields (`packages/core/src/schema/locator.ts`).
Without them, it behaves as it always has:

- **`selector`**: every candidate must match it.
- **`within`**: only candidates inside `anchor.closest(within)` count. An anchor with no such
  ancestor finds nothing.
- **`anchor.exact`**: the anchor must be the one element whose whole text equals the anchor text,
  case-sensitive, with no contains fallback. The recorder sets it on every anchor bound to a run
  input, because the resolver cannot tell after binding.

Together, `exact` and `within` are what make a missing record fail. Before them, all ten of these
inputs returned another product's price as `success`:

- "Bike", a prefix of "Bike Light".
- "Backpack Pro", a suffix of "Canvas Backpack Pro".
- "Canvas Backpack" when only the Pro is listed.
- "Bike Light" when only "Mini Bike Light" is listed.
- A name that appears only in another product's summary.
- The shop's own name.
- A sold-out product with no price element, in three positions. The card below it in the column
  answered.
- A product that isn't listed at all.

`tests/e2e/discover-storefront.test.ts` pins every row. With the two fields disabled, 8 of the 10
rows return a wrong price; the last-card and unlisted rows fail either way.

The resolver adds two rules for a `within` locator:

- **Nested containers.** A candidate counts only if its own nearest container is the anchor's
  container. A card nested inside the anchor's card answers for itself, never for the outer card:
  a sold-out gift set must not return the price of the mug card inside it.
- **One candidate per container.** More than one candidate inside the container that fits the
  filter is a miss. With a struck-through list price above a sale price, both in the price class,
  the resolver cannot tell which one is meant, so it finds neither.

**What the page checks before it emits an anchor.** `resolvesTo` (`src/leaves.ts`) mirrors the
adapter's candidate filter, ancestor/descendant collapse, nested-container rule, geometry and 1px
tie rule. It checks less than the resolver in three ways:

- It sees only the light DOM.
- It approximates the anchor lookup with a case-insensitive uniqueness index instead of running
  Playwright's `getByText`.
- Inside a container it emits the anchor whenever the element is a candidate there, even when it
  is not the only one. That way the recorder learns which record the element belongs to. The
  resolver then misses on it, and record-time verification refuses the target. The alternative
  would be no anchor at all, which leaves the element with positional locators.

Nothing the page emits is trusted on its own word. The check that counts is record-time
verification with the real resolver, described next.

### The rule: a record's target keeps no positional locator

A target that belongs to a record named by a run input never keeps a positional locator. Its
input-bound chain is verified at record time. The code is in `packages/core/src/agent/recorder.ts`
(`scopeLocators`, `contentLocators`) and `packages/core/src/agent/tool-handlers.ts`
(`prepareTarget`).

**Positional** (`isPositional`, `packages/core/src/schema/positional.ts`, shared with replay and
the validator) covers:

- a `bbox`;
- a `css` selector with a structural pseudo-class (`:nth-of-type`, `:first-child`, ...), a sibling
  combinator (`+`, `~`), or a bare-tag step (`body > div > div`);
- a class or id that names a position (`.row-1`, `tr.odd`, `.even`, `.first`, `.last`, `#item-3`);
- an attribute value that is a number, or ends in one (`[data-index="0"]`). This also catches
  `a[href="/members/10009"]`, which pins one record.

An attribute that holds a run input is canonicalized to its placeholder first, so
`a[href="/members/{input.memberId}"]` is identity bound to the input. `#tabAccounts`,
`input[name="memberId"]` and `span.title` are identity.

A target is **record-scoped** in five cases. They are checked in this order:

1. **`own-input`**: its own name or text locator holds the input, as in a result row whose text is
   the member id.
2. **`anchor-input`**: it has no static identity and a *trusted* anchor on the input. That is a
   container-derived anchor, or one whose anchor text is the input and nothing else (a table cell
   right of "{input.orderId}"). An untrusted legacy above-anchor that merely contains the input,
   such as "Member: Jane Q. Sample (#{input.memberId})", does not count; it is dropped.
3. **`repeated-input`**: its static own name is not unique on the record-time page, which is
   checked live, and it has a trusted anchor on the input. This is the "Add to cart" button in
   every card.
4. **`content-input`**: no locator mentions the input, but the element's own text, its table
   row's other cells, or its record container's text hold a non-sensitive run input's value
   (whole token, 3+ characters). This is the case where the input was consumed by an earlier
   step: a "View" button in the row of the person searched for. The element's content comes from
   the page's `recordContext` field. The surface keeps it per ref and returns it only from
   `Surface.recordContextOf`. It is never part of an observation, so no prompt, log, transcript,
   escalation or artifact can carry it. The recorder builds input-bound locators from that
   content:
   - from the element's own text, a text locator on the placeholder;
   - from the input-holding cell, a relative anchored on it, filtered to the element's own column
     (`td:nth-child(3) button`). The anchor is looked up in the input cell's own column only
     (`anchor.selector`, `td:nth-child(1)`).

   The anchor never quotes record data. It has one of three forms:
   - **The cell is the input alone.** The anchor is `{input.x}`, `exact`.
   - **The input sits inside static text.** Every data cell of the column (three or more) shares
     the text around it, with no digits, and the cell is not masked: "Order " in "Order 2001",
     "Order 3005", "Order 4000". The anchor is that text with the placeholder, `exact`:
     `Order {input.orderNo}`. A date holding "2001", "Order A-1001-B" and "Order a-1001" never
     match it.
   - **Otherwise.** A contains match with `wholeWord`, case-sensitive, which must find exactly one
     cell in the column at replay.

   When only the container text holds the input, the element is a field of a one-record detail
   view: the member profile reached through a last-name search, whose URL holds no input. Nothing
   is built from the container. The element keeps its own label anchor ("Savings Balance"), and
   only when the page shows that label once (`labelUnique`). Discovery then verifies the anchor on
   the live page, and the anchor lookup misses on a label shown twice. So a page of cards, each
   with a "Savings Balance" row, stays refused or escalated rather than recorded by position.
5. **`page`**: its frame's URL holds the input. In a **path segment** (`/members/12345`, the
   record's own page, where nothing else is listed) the chain is kept. In the **query**
   (`/search?memberId=12345`, where other records are listed) positional locators are dropped.
   Content membership is not checked on the record's own page, where every block may show the
   input.

The first four scopes keep only input-bound, non-positional locators; `page` is as above.
Everything else keeps its chain, positional fallbacks included. In every scope a relative is kept
only if it is a trusted input anchor or the element's own label. A row anchor counts as a label
only when its cell reads as one (`rowAnchorIsLabel`): a `th`, a `<label>`, a colon, a two-cell
label/value row, or a column whose text is the same in every row. In a row of three or more data
cells, the cell to the left is the previous column's value, and the page does not emit an anchor
on it. Every contains match the recorder makes on a placeholder is `wholeWord`. The bound value
must appear as a whole token, case-sensitively, so "Lee" never matches "Bo Leeson" or "lee", and
"4512" never matches "Row for 45123". A hyphen, underscore, slash, at sign, apostrophe or dot
between two letters or digits does not end a word: "A-1001" does not match "A-1001-B", nor "Smith"
"Smith-Jones". At replay an exact cell is preferred: when a cell of the column equals the value,
it wins over cells that only hold it as a word, and two word matches with no exact one are
ambiguous. A cell recorded as the value alone is `exact` and never falls back to a word: a replay
that lists only "A-1001-B" or only "Lee Wong" fails typed. A word match does still match a
different record's value that holds it as a whole word: "Lee" recorded inside "Ann Lee" matches
"Lee Wong" when no cell is exactly "Lee". In a table that is limited to the input's column, and
to the exact static-text form when the column has one. What is left is a named limit (below).

A `role` locator has no whole-word form: the strategy matches a name exactly or as a substring.
So a role locator bound to an input is recorded `exact` or not at all:

- **The name is the input and nothing else** (a link named "Bolt"). The locator is
  `{input.productName}`, `exact`, whatever the surface said about exactness. One that then does
  not find the element alone is left out by verification, below.
- **The name holds the input among other text** ("Add Bolt to cart", "View details for Bolt"). No
  role locator is recorded. Narrowed to the placeholder it would be a substring match, and
  recorded for one product it would find "Add Bolt T-Shirt to cart" for the input "Bolt". The
  target is still `own-input`, so it keeps no positional locator either. It is found through its
  own text, as a whole word, or through its container's exact anchor. A control that only its
  role name identifies is refused.
- **The specific form** quotes the whole name with the placeholder, `exact`
  ("View details for {input.productName}"). It is used only as described under verification.

**Verification.** Before a record-scoped target is recorded, and before an action is performed,
discovery binds the kept chain with the run's own inputs and resolves it on the live surface, one
locator at a time. Each locator, alone, must find the very element acted on, checked with
`Surface.isSameElement`; a surface without that check cannot verify. A locator that misses, is
ambiguous or finds another element is left out of the recorded chain. The chain is verified when
at least one locator is left. When none is:

- An own-input or content text that is still ambiguous is retried in its specific form: the whole
  own text with the placeholder, exact. That form can carry the row's other text, so it is used
  only then.
- An extract or outcome return is refused ("could not record a reusable locator").
- An action is recorded with only its input-bound locators and `onFailure: escalate`, plus a
  provenance note.
- A record-scoped action with no input-bound locator at all is refused, with feedback.
- An unverified interstitial dismissal does not become a recovery rule.

**Why each locator alone.** Replay reports the depth of the locator that fired as drift, which is
supposed to mean the app changed. A locator that never found the element breaks that. On a shop,
a product's image link and its title link share one accessible name, so the title link's `role`
locator matched two elements at record time and at every replay. The chain was still verified as
a whole, because the `text` locator behind it found the link, and every replay of a capability
recorded a minute earlier reported drift. A locator that finds another element is worse: it
would act on that element as soon as the ones before it stop matching.

A target that belongs to no record is checked the same way, with two differences. It is never
refused. And when no locator finds the element (a surface that cannot compare elements, a ref
that went stale), nothing was learned, so its chain is recorded whole.

Each check is one resolution round with no waiting, so a dead locator costs one lookup, never a
timeout. Measured once, on a machine busy with other test runs, a target of two to five locators
took 40 to 200 ms in Chromium and 200 ms to 1.1 s through Windows UI Automation, where every
lookup takes a fresh snapshot of the window. The tests are `packages/core/src/agent/record-verify.test.ts` and
`tests/e2e/record-prune-storefront.test.ts`.

**A flow recorded through a search** whose target row does not show the input now fails or
escalates at replay rather than guessing. If the search lists no matching row, or several, nothing
is clicked.

#### What returns a typed failure, and what can still succeed silently

These are pinned as a typed failure, an escalation, or the right record, with server-side records
showing no wrong action:

- **Shop prices and buttons** (`tests/e2e/record-scope-storefront.test.ts`,
  `tests/e2e/discover-storefront.test.ts`): a prefix, a suffix or a substring name; the shop name;
  a sold-out card in any position; a nested card; a list price above a sale price; a repeated
  "Add to cart".
- **A button whose accessible name holds the product** (`tests/e2e/record-role-name.test.ts`):
  recorded on "Add Fleece Jacket to cart", a replay for "Bolt" where only "Bolt T-Shirt" is listed
  adds nothing to the cart. With the narrowed role locator it clicked "Add Bolt T-Shirt to cart".
- **Table rows**: a table cell; rows whose ids are prefixes of each other.
- **Searches** (`tests/e2e/record-membership.test.ts`):
  - a people search (GET and POST) for a name listing another person;
  - a search listing two people, where only one holds the name as a word: "Smith" opens Jane
    Smith, not Al Smithers;
  - a search listing several people, or none;
  - an order search where the id is a substring of another order's;
  - two identical rows.
- **Ids inside longer cells** (`tests/e2e/record-row-anchor.test.ts`): an order number that only a
  date holds; "Order A-1001-B" and "Order a-1001" for A-1001.
- **A cell that is the input alone** (`tests/e2e/record-row-anchor.test.ts`): "A-1001" recorded
  as the whole cell fails typed when only "A-1001-B" is listed, and "Lee" recorded as the whole
  cell fails typed when only "Lee Wong" is listed. A word-recorded anchor ("Lee" in "Ann Lee")
  takes an exact cell first, and "Lee-Wong" is not a word match.
- **A last-name lookup** (`tests/e2e/discover-lastname.test.ts`): discovered for Kowalczyk, the
  capability replays for other members with a unique last name. A last name that lists two
  members, or none, fails typed at the result click.
- **The mock app** (`tests/e2e/discover-mock-record-scope.test.ts`,
  `tests/e2e/discover-subaccount.test.ts`): the standard flow and the sub-account form on both
  tenants, including a missing member.
- **A read whose record container shows the input** (`tests/e2e/positional-fallback.redteam.test.ts`,
  see "A read's record identity" below): on a page that lists two records, when only the other
  record shows the "Savings Balance" label, replay fails with `checkpoint_failed` instead of
  returning the other record's balance. A name search with a detail panel, recorded for
  "Smithers", fails the same way for "Smith" (Jane Smith and Al Smithers listed, Al's panel open),
  and still reads the panel for "Smithers".

How this was measured: each test file was run against a copy of the recorder (and, for row
anchors, the adapter) with the new rule switched off. These cases fail there:

- 10 of the 14 tests in `record-scope-storefront.test.ts`. The switch kept every chain minus
  container anchors, approximating `main`'s recorder.
- In `record-membership.test.ts`, with content membership and the label check off, all of it
  fails. The people-search discoveries (GET and POST) fail outright, which skips their 10 tests,
  and 4 of the 5 order-search and duplicate-row tests fail.
- The sub-account discovery, with untrusted anchors counted as input anchors.

Each run used a temporary edit that was reverted afterwards.

This list used to name six cases. Two of them happened at replay, not at record time: the
recorder kept a positional fallback on purpose, and at replay a locator that named the target
matched several elements, so the chain fell through to the position. Replay now refuses that
([replay.md](replay.md#positional-fallbacks)): it never settles an ambiguity by position, and
never reads by position when the chain has a named way to find the value. Both cases are
reproduced end to end in `tests/e2e/positional-fallback.redteam.test.ts`.

Now a typed failure (`element_not_found`, saying how many candidates matched):

- **A control unique at record time but repeated at replay.** It is `static` and keeps its
  positional fallbacks. When its name now matches several controls, the fallback is not used and
  nothing is clicked. Before, a "View statement" button recorded on a one-holder page opened the
  other holder's statement on a two-holder page, and the run returned that holder's balance.
- **A record's own page** (input in the URL path) **that also lists other records.** Positions
  are kept there. When the value's label now appears once per listed record, the anchor is
  ambiguous and nothing is read. Before, the bbox returned the first listed holder's balance. A
  read there also fails typed when its label is simply gone: a read never falls back to a
  position.

What is left of those two cases:

- **An action whose naming locators all miss.** A click, type or select still falls back to a
  position when no naming locator matches and none was ambiguous. This keeps drift self-healing
  for actions: a control whose label was renamed is still found through its css fallback. A
  control that is both renamed and repeated at replay is clicked by position, and its checkpoint
  is the only guard.
- **A target recorded with positional locators only.** A control with no name, label or text, or
  a value with no label, has nothing that could be ambiguous. An action on it stays positional,
  guarded by its checkpoint. A read of it stays positional too: `cu validate` warns
  (`positional_only_target`), and `cu approve` refuses a capability with such a read unless
  `--force` is passed, so it cannot be approved and run unattended by accident. It can still run
  as a draft, or after a forced approval.

Two more cases are closed by the read identity check, when the record's container shows the input
at record time (next section): the other record being the only one that shows the label, and a
detail panel on a search page. The narrowed role locator case is closed as well (the role locator
is recorded only when it is whole-word safe). Four cases remain: the two bullets above and the two
below. The positional-only read is blocked at approval. `cu validate` warns about the e-mail
search; it does not warn about the other two.

- **A target whose record shows the input nowhere near it.** Membership cannot be seen, for
  example a search by e-mail whose result card shows only the name, so the target is `legacy` and
  keeps its fallbacks. The read gets no identity check, because there is nothing it could check
  against, and `cu validate` warns (`read_without_record_identity`). This case is warned, not
  closed. When several such records are listed and its label or name matches each, replay fails
  typed. When the page shows one record, or only one carries the label, it is read or clicked.
- **An input that is a whole word of another record's value in the same column**, with no static
  text around it in that column, when the recorded cell held the input among other words. For
  example, "Lee" recorded on "Ann Lee" opens "Lee Wong" when he is the only one listed and no
  cell is exactly "Lee". Pinned in `tests/e2e/record-row-anchor.test.ts`. The whole-word match
  keeps "Lee" from matching "Bo Leeson", "Lee-Wong" or "lee", and an exact cell wins over a word.
  It does not stop "Lee" matching "Lee Wong". A rule that also required the same word position in
  the cell ("last word") would close this example, and was left out: it would fail "Smith" on
  "Mary Jane Smith" after a recording on "Jane Smith", and "Park" on "Anna Maria Park". The "A-1001"
  / "A-1001-B" example is closed: a cell that is the id alone is `exact`, and a hyphen does not
  end a word. A read on that record's page passes the identity check too, since "Lee" is a whole word there.

The e-mail search is warned, not closed: the warning tells a reviewer the read cannot be
verified, but a replay that ignores it can still return another record's value.

The cases the replay rule cannot see have one thing in common: a locator that names the target
matches exactly one element, and that element belongs to another record. The replay rule acts only
when a naming locator is ambiguous, or when a read would come from a position. The read identity
check is the second layer for reads.

#### A read's record identity

When the recorder writes an `extract` step, it asks the surface for the text of the value's record
container (`Surface.readRecordText`, `within: 'container'`). The container is the smallest ancestor
that groups the element with at least two other text blocks: a card, a detail panel, a table, within
six levels and 60 elements. An element with no such ancestor gets the whole frame, which is what a
record's own page is. If the text shows a declared, non-sensitive input's value (three or more
characters, as a whole token, case-sensitive), the step records

```json
"identity": { "input": "memberId", "within": "container" }
```

It names the input and never quotes the value. When several inputs are shown, the one an earlier
step drove first wins. `within` is `container`, or `page` when the element had no container.

At replay, after the chain resolves and before the value is read, replay asks the surface for the
same text and checks that the bound input value is a whole token of it. If it is not, the step ends
as `hard_failure` `checkpoint_failed`. `expected` says the record container shows input "memberId",
and `message` says the value was found but belongs to another record and was not returned. Neither
carries the input's value; the comparison uses the real text and the real value and drops both. A
recorded `container` that is now a whole page also fails: the record can no longer be told apart.

What it does not do:

- It records nothing where the container does not show the input at record time. That is the
  e-mail search whose card shows only the name, and a record id that sits in a page header outside
  the value's table. Those reads are not closed. `cu validate` warns about every `extract` after an
  input-driven step that has no `identity` (`read_without_record_identity`), including every
  capability recorded before the check existed.
- It covers step extracts, not a business outcome's extracts and not a tenant override's.
- A surface without `readRecordText` skips the check. The Playwright surface and the Windows UI
  Automation surface both have it, and so does `FakeSurface`. On the desktop the container is the
  smallest ancestor in the UI Automation tree with the same rule; editable fields' values are never
  counted as text, because a search box that holds the typed value would show the input everywhere.
- On a one-record detail page the container may be the whole page. The check then only proves the
  input is on the page, which is all that page can show.

Tests: `tests/e2e/positional-fallback.redteam.test.ts` (the ledger: two holders, a name search with
a detail panel, a read that is warned), `packages/core/src/replay/replay-record-identity.test.ts`,
`packages/core/src/agent/record-identity.test.ts`, `packages/core/src/schema/read-identity.test.ts`.

The trade the replay rule makes: a read whose label moved or was renamed used to self-heal
through a structural css, and is now a typed `element_not_found`. It is fixed by recording
again, or by a tenant override that names the value.

A typed failure that is new with the column-bound row anchor: a table that gains or loses a
column to the left of the anchored one between recording and replay no longer resolves, where the
unbound anchor used to find the right row. It fails as `element_not_found`, and is fixed by
recording again.

#### What still persists by design

- A static control's own label and text.
- A value cell's own text in a static or legacy target's description. A record-scoped target's
  synthesized description is rebuilt from its kept locators.
- The specific form's row text, when the placeholder alone was ambiguous.
- Container anchors that are input-bound.
- The static text a column's cells share around the input ("Order " in "Order 2001"), quoted into
  the row anchor. It is inferred from three or more cells, so text that every listed row happens
  to share (a surname on a family's page, a city) is quoted as well. That is record data in the
  artifact, not a wrong record: another family's page fails typed.

These are fixed by the rules above:

- A last-name search's row click no longer records the member id as a text locator. The row is
  `content-input` and keeps the whole-word placeholder.
- A date cell is no longer anchored on the neighbouring value. That cell is not a label.

#### Under screen masking

Text leaves and container anchors are new places for page text to leave the surface, so they go
through the same masked view as every other element
([screen-masking.md](screen-masking.md)):

- **Text leaves.** A text leaf is masked like any element: a masked one shows the placeholder and
  is flagged `masked`. A leaf whose whole text masks to one placeholder counts as masked even
  without a mark of its own. An example is `<span>1 Main</span>`, one fragment of an address
  split across two spans.
- **Locators.** `maskDescriptor` drops any locator carrying masked text: an anchor (`exact` or
  not), a css selector, or a relative locator's `selector` or `within`. In selectors it compares
  letters and digits only, so a value slugged into a class or id (`div.customer-jane-q-sample`)
  is caught too.
- **Record context.** `recordContext` keeps the real text, because the recorder compares it with
  the run's own input. The surface flags `ownTextMasked` when the element's own text holds masked
  content. The specific form, the only locator that quotes own text, is then never built.
- **An input echoed in a masked cell.** A non-sensitive run input shown in a masked cell still
  anchors the target ("Smithers" in a masked Name column). The anchor is the placeholder, and
  replay binds it and resolves it against the real page.
- **The cap.** The adapter passes `maxElements` to `maskObserve`, so a masked observation is
  capped in the page, as an unmasked one is.

Fail closed: a product card whose own name is masked loses its container anchor before the
recorder sees it. The card text then holds the input, but nothing can be built from it, so a
price in that card is refused rather than recorded by position.

The tests:

- `packages/adapter-playwright/src/text-leaves-mask.redteam.test.ts` (real surface);
- `tests/e2e/record-scope-masked.redteam.test.ts` (discovery and replay with masked Name, E-mail and
  Customer columns);
- `packages/core/src/surface/mask.test.ts` (selectors, fragments);
- `packages/core/src/session/control.redteam.test.ts` (the operator's surface never exposes
  `recordContextOf`).

### Measured cost

These counts come from one `observe()` per page, Chromium 1280x800. The element list was
serialized as the discovery prompt renders it (`formatElementLine`), at about 4 characters per
token. "Before" is the legacy prefix, which is exactly the pre-1.4.0 list.

| Page | Elements before → after | Element-list chars before → after (~tokens) |
| --- | --- | --- |
| Mock app: login | 11 → 11 | 678 → 678 (~170) |
| Mock app: workstation with maintenance notice | 26 → 29 | 1166 → 1374 (~292 → ~344) |
| Mock app: search results | 34 → 36 | 1493 → 1583 (~373 → ~396) |
| Mock app: member page | 38 → 38 | 1607 → 1607 (~402) |
| Demo shop: sign-in | 3 → 4 | 117 → 155 (~29 → ~39) |
| Demo shop: product list (6 cards) | 21 → 35 | 757 → 1512 (~189 → ~378) |
| Demo shop: product page | 4 → 8 | 143 → 345 (~36 → ~86) |

The mock app's member page gains nothing, because its legacy cells already cover every value. The
new elements on the mock app are the maintenance notice's title and body, "Quick find:" and
"1 record(s) found". A product list roughly doubles: each card adds its summary and its price.
That is about 190 tokens per turn on a list of six, which is small next to the screenshot.

These are in-page median times on generated three-column card grids, with a name, a summary, a
price and a button per card:

| Page | Before (1.1.0, uncapped, as the adapter called it) | After (`maxElements: 150`) |
| --- | --- | --- |
| Demo shop product list, 6 cards | not measured | ~8 ms |
| 200 cards | ~340 ms | ~125 ms |
| 600 cards | ~4.3 s | ~0.76 s |

The machine was shared and loaded, so treat these as ratios, not absolutes. A direct
`enumerate()` call without `maxElements` still computes every entry and grows roughly
quadratically with the page. The bundle was 15,401 bytes at 1.1.0, and 26,440 with text leaves
alone. At 1.4.0, with screen masking's calls (1.3.0) and the column data for row anchors, it is
44,711, against a 48 KB budget.

### What genuinely remains

- **Silent success on another record.** See [What returns a typed failure, and what can still
  succeed silently](#what-returns-a-typed-failure-and-what-can-still-succeed-silently) for the
  cases.
- **Markup with no stable container selector.** With no class on any container, the page emits no
  container anchor. If the container's text holds the input, the target is `content-input` with
  nothing to build, and it is refused. If it doesn't, the target is `legacy`.
- **Labels.** A control's label comes from `aria-label`, `aria-labelledby`, a `<label>`, or the
  adjacent table cell when that cell reads as a label (`naming.ts` `labelFor`,
  `adjacentCellLabelInfo`; `leaves.ts` `rowAnchorIsLabel`). A visible label in a sibling `<div>`
  of a div-grid form names nothing.
- **Interactivity.** Interactivity is markup-based (`selectors.ts` `CLICKABLE_SEL`). A `<div>`
  clickable only through `addEventListener` is listed as a text leaf, not as a control.
- **The legacy lookups.** The non-exact anchor lookup keeps its unique-contains fallback, unless a
  locator says `exact` or `wholeWord`, and the legacy groups keep the legacy uniqueness map,
  because shipped artifacts depend on both.
- **Bbox fallback.** The adapter's bbox fallback (`resolve.ts` `hitTestBbox`) resolves only a
  control or a `td`/`th`/`label`.
- **Known over-exclusion.** An `aria-labelledby` target that is itself a value is left out of the
  text leaves.

## The sink model

Capture needs somewhere to send each `HumanActionRecord`. In order of preference:

1. `window.__cuHumanAction`, when the driver installed it as a function (Playwright
   `exposeBinding`). The sink calls it directly and buffers nothing.
2. Otherwise, `window.postMessage({ type: 'cu-agent:action', action }, '*')`, plus an append to a
   bounded in-memory buffer (`__cuAgent.events`, capacity 500, oldest dropped first) that a driver
   reads and empties with `drain()`.

The `postMessage` call targets the page's own window. It carries no values across an origin
boundary; it is a same-document notification, not network traffic. A production tag that ships
records to a real collector needs more than this sink; see below.

## Capture semantics, in brief

Capture is off by default. `start()` adds capture-phase listeners for click, focus-in, input,
change, keydown (Enter, Tab, Escape), submit and same-document navigation; `stop()` removes them.
Same-document navigation uses the Navigation API; without it, only `popstate` and `hashchange` are
seen, so a bare `pushState` is missed. The agent does not patch `history`.
Every record carries `valueRedacted: true` and never a value: capture does not read `.value`, and a
button-type input is labelled from its `value` attribute, not its `.value` property. A target that
is editable, or contains a select, textarea or editable region, reports no text. Capture
emits one input record per field per focus, not per keystroke. Each record's `frame` field is a hop
path from the top document, by frame name or index, truncated with `frameTruncated: true` at the
first cross-origin ancestor the capturing document cannot read. A full-document navigation is the
driver's responsibility: every new document starts with capture off.

## Security posture

Guaranteed: no `eval`, `new Function`, `innerHTML`/`outerHTML`/`insertAdjacentHTML`, and no
`document.write`; no DOM insertion beyond the single detection attribute; every emitted string
capped at 300 characters; capture never reads a field's value. Neither install nor a capture
listener throws into the page, even when a hostile script breaks a DOM built-in.

Not guaranteed, by design: the agent runs in the page's own JavaScript realm, so a hostile page can
replace or spoof `window.__cuAgent`, before or after install. The driver must treat everything the
agent returns as untrusted page data, including what `window.__cuAgent.lib` and `enumerate()`
return. The same holds for capture: page script can call the `__cuHumanAction` binding directly, so
the human actions Relay and the evidence show are page-reported, not tamper-proof.
`enumerate()` does report the live value of a non-password field to the driver: automation needs to
verify what it typed. Only a driver calls `enumerate()`; the included tag never does. A password field
is different: only its emptiness is tested, and a non-empty value reports `[REDACTED]`, never the
real string.

## What a production collector adds

An app that ships the agent as a real tag, sending records to a server, needs more than the sink:

- Endpoint authentication, so an arbitrary origin cannot post fake records.
- Batching, flushed with `navigator.sendBeacon` (or `fetch` with `keepalive`) on `pagehide`.
- Retry with backoff, and sampling so a high-volume page does not flood the collector.
- Consent gating, so capture runs only where the user has agreed to it.
- A `connect-src` entry in the page's CSP for the collector's origin.
- Subresource integrity, or a versioned CDN path, for the script tag itself.
- Server-side validation against the `HumanAction` schema; the wire format is never trusted as is.
- Rate limits per document or session, and a retention policy for stored records.

## Build and size

`build.mjs` bundles `src/entry.ts` with esbuild into a single minified IIFE, target `es2018`, with a
source map, kept under 48 KB (`test/package.test.ts`). The budget was 40 KB until text leaves and
screen masking both landed: it guards against accidental growth, since the bundle is injected into
every frame. `agentSource()` (`src/index.ts`) rebuilds `dist/` on demand, when it
is missing or older than `src/`, strips the trailing `sourceMappingURL` comment (an injected copy
runs at the page's own URL, where that relative map path does not resolve), and caches the result
for the life of the process.

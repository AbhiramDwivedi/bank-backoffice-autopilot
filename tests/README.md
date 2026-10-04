# tests

This folder holds the end-to-end tests that cross package boundaries. Unit tests live next to the code they test, in `packages/` and `apps/`.

- [`e2e/`](e2e/) runs the real mock app in-process on ephemeral ports and drives it through the `cu` CLI with a real headless Chromium. It covers discovery against a scripted model (including the built-in optimizer stage), replay for every result kind, handoff and resume, policy refusals, `--times` stability runs, the catalog, and approval. The suite needs no API key or network access. These files cover the newer pieces:
  - `replay-chaos.test.ts` replays the shipped capability under the mock app's seeded chaos and pins the results for fixed seeds, including the session-expiry cases that once reported a wrong `member_not_found`.
  - `optimize.test.ts` runs `cu optimize` on the shipped capability against the mock app, with and without `--read-only`.
  - `desktop.test.ts` discovers and replays against Teller Workstation through the real UI Automation bridge. It runs only on Windows and is skipped elsewhere, including CI.
  - `discover-storefront.test.ts` checks that discovery is not tailored to the mock app's tables. A price or an order status discovered for one record is returned for another record on replay. A name that is only a prefix, a suffix or a substring of a listed one, the shop name, a sold-out product with no price and an unlisted product all fail with `element_not_found`, never with a neighbour's value.
  - `record-scope-storefront.test.ts` pins the rule that a target belonging to a record named by an input keeps no positional locator. Its cases are a repeated "Add to cart", a table status cell, rows whose ids are prefixes of each other, a card nested in a card, and a list price above a sale price. The shop records cart adds and opened rows, so "nothing was clicked" is checked on the server.
  - `record-prune-storefront.test.ts` checks that a recorded chain holds only locators that found the element alone. A product's title link shares its accessible name with the image link beside it, so its role locator is not recorded, and replay finds every target with its first locator.
  - `record-role-name.test.ts` covers a button whose accessible name holds the product ("Add Fleece Jacket to cart"). No role locator is recorded for it, so a replay for "Bolt" where only "Bolt T-Shirt" is listed fails typed and adds nothing to the cart.
  - `record-membership.test.ts` covers targets whose input was consumed by an earlier step. A people search (GET and POST) and an order search are replayed for another record, for a record the search does not list, and for a name that lists several people. It also covers two identical rows. Each case must open the right record, fail as a typed result, or escalate, and the shop's server-side view log shows that no other record was opened.
  - `discover-mock-record-scope.test.ts` checks the same rule on a fresh discovery of the mock app's standard flow, on both tenants, with the shipped outcomes grafted on.
  - `record-row-anchor.test.ts` covers row anchors inside a longer cell ("Order 2001"). An order number only a date holds, "Order A-1001-B" and "Order a-1001" must fail typed. It also pins the named limit: "Lee" recorded on "Ann Lee" opens "Lee Wong" when only he is listed.
  - `discover-lastname.test.ts` discovers the mock app through the last-name search (Kowalczyk, then Sampson). It replays the capability for members with other last names, and fails typed for an ambiguous or unknown one.
  - `discover-subaccount.test.ts` discovers the mock app's sub-account flow through the account-type dropdown, both form fields and Continue, then replays it for another member and amount.
  - `discover-member-tabs.redteam.test.ts` discovers a tab flow on the two tenants, replays it for another member, and checks that no locator holds the recorded member's data.
- [`fixtures/`](fixtures/) holds inputs for those tests. `open-subaccount.draft.json` is a draft capability with an irreversible step. The tests use it to check that replay refuses the draft before the browser sends a single request. `storefront/server.ts` is a small div-and-flexbox web shop ("Demo Shop": a sign-in form, a grid of product cards, product pages, an orders page, a people directory and searches). It is served on an ephemeral port with a configurable catalogue, and can label each "Add to cart" button with its product's name.
- `video-mockapp.test.ts` checks the video recorder's fault helper against the real mock app. It lives here because `tools/video` has no test project of its own, and runs in the `e2e` project.

To run the tests, use one of these commands from the repo root:

```bash
npm run test:e2e   # only the end-to-end suite
npm test           # every test in the repo
```

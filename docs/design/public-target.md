# Public target

Every test and every committed evidence run drives `apps/mock-app`, an app written for this repo.
That leaves an obvious question open: does the runtime work on an app it was not written
alongside, or has it quietly learned the mock's markup? A run against a public site that nobody
here controls answers it. The site used is a demo storefront published for practising test
automation, `https://www.saucedemo.com`. It prints its own demo logins on its sign-in page.

This is an evidence run, done by hand. It is not a CI test.

## Rules

- **Only the credentials the site publishes.** Use the demo login printed on the site's own
  sign-in page. Never a real account, a real credential, or real personal data, on this site or
  any other public one.
- **A separate policy file.** [`policies/saucedemo.yaml`](../../policies/saucedemo.yaml) allows
  exactly `https://www.saucedemo.com` and nothing else. Pass it with `--policy`. Never add a public
  origin to `policies/default.yaml`: the default policy stays scoped to the mock app.
- **Small limits and a polite pace.** The policy caps a run at 20 steps, 30 model calls and five
  minutes. The optimizer stage of `discover` replays the capability against the site, so cap it
  (`--optimize-max-trials`, `--optimize-verify-runs`) or skip it (`--no-optimize`). `cu optimize`
  also takes `--trial-delay-ms` to space its trials out.
- **Read-only goals.** Read something off a page. The policy marks the storefront's order flow
  (`Finish`, `/checkout-complete` and similar) irreversible, so discovery hands those to a human
  and replay refuses them on an unapproved capability, but the goal should not go near them.

## Running it

Put the demo login in the environment under names of your choice (or in a git-ignored file read
with `--credentials file:<path>`), then name them with `--secret`:

```bash
export DEMO_USER=...        # the demo user name the site shows on its sign-in page
export DEMO_PASSWORD=...    # the password the site shows next to it

npm run --silent cli -- --policy policies/saucedemo.yaml --base-url https://www.saucedemo.com \
  discover --goal "Sign in and read the name and price of the first product on the inventory page." \
  --secret DEMO_USER --secret DEMO_PASSWORD --entry / --read-only \
  --output productName:string --output productPrice:number \
  --id read-first-product-price --vendor "Demo storefront" --product "Demo storefront" \
  --optimize-max-trials 5 --optimize-verify-runs 1 --out runs/public-target.json

npm run --silent cli -- --policy policies/saucedemo.yaml --base-url https://www.saucedemo.com \
  replay runs/public-target.json
```

`--secret` replaces the default `MOCK_USER`/`MOCK_PASSWORD` list, so the agent can bind only the
two names given. `--entry /` starts at the site's root, because the default entry is the mock's
`/login`. `--vendor` and `--product` are recorded as given; nothing checks them. `--out` keeps the
capability out of `artifacts/`, so the catalog never offers it.

On Windows in Git Bash, the shell rewrites an argument that starts with `/` into a Windows path
before Node sees it, so `--entry /` arrives as the Git install directory. Prefix the command with
`MSYS_NO_PATHCONV=1`, or run it from PowerShell (calling `npm.cmd`).

`--fault` does not apply: the site has no `/__faults` route, and the policy would not reach one.

## Why it is not a CI test

It needs the live site and a model key, and its outcome depends on a site that can change or go
away at any time. A CI test that fails because a third party changed its markup tells you nothing
about this repo. Instead, the run's command, its output and its run directory are kept as
evidence under [`evidence/`](../../evidence/README.md). Repeat the run by hand when the discovery
or enumeration code changes.

## What it found

The first run ended with status `max_steps` after 11 steps and 20 model calls. The cause was
real tailoring to the mock app. The browser agent's element enumeration
(`packages/browser-agent/src/enumerate.ts`) reported interactive controls plus a fixed set of
informative shapes: headings, label/value table cells, message cells, short bold or font texts,
and error-list items. Those are the shapes the mock app uses. The storefront shows a product's
price in a plain `<div>`, so the price had no element ref, the model could not `extract` it, and
the run hit its limit without reading it.

Enumeration now also lists leaf text blocks, and the recorder anchors each one on its record's
own name (`docs/design/browser-agent.md`).

## The result after the fix

Run again live on the merged code:

- **Discovery** succeeded in 6 steps and 7 model calls and read the price of the product named by
  the run input. The risk judge was asked about 2 committing actions and raised neither.
- **Replay**, with no model, returned the right price for the recorded product and for a different
  one, each in under 2 seconds.
- **A product the site does not list** failed as a typed `element_not_found` at the product link,
  not as another product's price.
- **The optimizer**, with `--trial-delay-ms 2000`, found nothing to remove.

Two things in the run were not clean. Both were faults in the recorder and the validator, not in
the site:

- The first locator recorded for the product link (a `role` locator) does not resolve at replay.
  Every replay uses the `text` fallback and reports it as locator drift. A product's image link
  and its title link share one accessible name ("View details for" and the product's name), so
  the `role` locator, narrowed to the product's name, matched two elements from the start. Two
  changes each remove it (`docs/design/browser-agent.md`). A role locator whose name holds the
  input among other text is no longer recorded, because it is a substring match. And discovery
  now tests each locator alone before recording it and leaves out one that does not find the
  element. The same shape replays at depth zero on the demo shop fixture
  (`tests/e2e/record-prune-storefront.test.ts`). The run above predates both changes and still
  shows the drift. A later live run with both changes (`after-pruning/`) recorded the product
  link with the `text` locator alone, and both of its successful replays reported no drift.
- `cu validate` warned that no checkpoint binds the input. That warning was false here: the
  price is read through a single locator anchored on the exact product name inside the product's
  own container, so it cannot be another product's. The validator now accepts a capability whose
  every `extract` reads through input-bound, non-positional locators (`docs/design/agent.md`),
  and `cu validate` on the committed capability prints no warning.

The commands, their captured output and the run directories, including the failed first run, are
in [`evidence/followups/public-target/`](../../evidence/followups/README.md). Screenshots and DOM
snapshots of the site are not kept in the repository.

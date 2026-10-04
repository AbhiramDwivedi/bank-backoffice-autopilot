# policies

This folder holds guardrail policies, one YAML file per policy. Every run loads one. To use a different policy, pass `--policy <file>`.

The demo uses [`default.yaml`](default.yaml). It sets the following rules:

| Rule | Setting in `default.yaml` |
|---|---|
| Where automation may go | Only the two mock-app origins: tenant A on port 4173 and tenant B on port 4174. The fault-injection routes are blocked. |
| What automation may do | The allowed action types, plus patterns that mark a control irreversible. During discovery, an irreversible action goes to a human (`discoveryMode: escalate`). During replay, only an approved capability can run one (`replayRequiresApproved: true`). |
| What a judgment may add | `risk.judge`: a judgment-based check of committing actions on top of the patterns, at discovery and in `cu audit`, never at replay. `mode: enforce` lets a judgment raise risk (never lower it), `advise` only logs it, `off` disables it. `irreversibleThreshold` (0.5) is the probability at which an action counts as irreversible; `onError: fail_closed` treats an unavailable judge as irreversible; `timeoutMs` (5000) bounds each judgment. The block is optional and these are its defaults. See [`docs/design/risk-judge.md`](../docs/design/risk-judge.md). |
| What never gets written down | Redaction patterns applied to logs, results, and model transcripts. |
| What never leaves the screen | `redaction.screen`: every form field, the values next to whole address, phone, SSN/tax id, date-of-birth and email labels (each pattern must match the whole label), and any text matching a redaction pattern or a run value are redacted in screenshots and replaced by `[MASKED:<kind>]` in DOM snapshots and in the text the model sees. `desktop.yaml` sets the same block for the desktop surface; `saucedemo.yaml` writes out the defaults. See [`docs/design/screen-masking.md`](../docs/design/screen-masking.md). |
| When to stop | Run limits. |

The CLI refuses to open a browser on an origin the policy doesn't allow, and it narrows each run to the origin of that run's base URL. To point automation at a different app, add the app's origin to the policy or pass your own policy file.

[`desktop.yaml`](desktop.yaml) is the policy for Teller Workstation, the mock desktop app. Its origin is `desktop://tellerworkstation`: a desktop origin names exactly one process (case-insensitive, no wildcards), path patterns match `/` plus the window title, and it allows nothing in a web run, as an http origin allows nothing in a desktop run. It adds the confirmation dialog's "Open Sub-Account" button to the irreversible patterns. For desktop locations, see [`docs/design/desktop.md`](../docs/design/desktop.md).

[`saucedemo.yaml`](saucedemo.yaml) is the policy for the public-target run against `https://www.saucedemo.com`, a demo storefront published for practising test automation. It allows only that origin, keeps the run limits small, and marks the storefront's order flow irreversible. It exists so that pointing `cu` at a site other than the mock app never means widening `default.yaml`. The rules for that run are in [`docs/design/public-target.md`](../docs/design/public-target.md).

For the schema and loading rules, see [`docs/design/policy.md`](../docs/design/policy.md).

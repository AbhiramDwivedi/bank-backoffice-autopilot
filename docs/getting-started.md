# Getting started

This page covers setup, the demo runs on the web and desktop mock apps, and the test suite. The root [README](../README.md#quickstart) has the shortest path. Every command, flag, exit code and setting is in the [command and configuration reference](reference.md).

## Setup

You need Node 22 and npm. Install dependencies and the Chromium build that Playwright drives:

```bash
npm install
npx playwright install chromium
```

Only three things call a model: `discover`, `cu audit` and `npm run judge:eval`. For those, copy `.env.example` to `.env` at the repo root and fill it in, or set the variables in the environment:

```
ANTHROPIC_API_KEY=...
ANTHROPIC_WORKSPACE_ID=...     # only if the key is not scoped to a workspace
ANTHROPIC_MODEL=claude-opus-5  # optional, this is the default
```

Without any key you can still run everything else: replay, validate, approve, optimize, the catalog, the handoff demo, and every test. Replay never calls a model, and the end-to-end tests drive the discovery agent with a scripted model. The next section includes a short keyless replay.

The desktop surface and Teller Workstation need Windows with Windows PowerShell 5.1 and .NET Framework 4.x. Both compile C# with PowerShell's `Add-Type` and cache what they build under `%LOCALAPPDATA%`. The bridge generates a UI Automation interop assembly on its first run and compiles itself at every start (about 6 seconds the first time, 2 after). Teller Workstation builds its exe once per source version.

**Windows PowerShell.** The commands below use bash quoting and bash line continuations (`\`). In PowerShell:

- Call `npm.cmd` instead of `npm`. The `npm.ps1` shim drops the `--`, and npm then takes the flags after it as its own.
- Join multi-line commands into one line.
- Escape the quotes inside JSON arguments: `'{\"failSearch\":true}'`.
- Set environment variables with `$env:NAME='value'`, as in `$env:MOCK_TENANT='b'; npm.cmd run mock-app`.

In Git Bash, an argument that starts with `/` (such as `--entry /login`) is rewritten into a Windows path unless `MSYS_NO_PATHCONV=1` is set.

## Run it

### Web: learn a task, then do it

Use two terminals.

1. Start the mock web app. Tenant A listens on port 4173.

   ```bash
   npm run mock-app
   ```

2. Let the model learn the task (needs `ANTHROPIC_API_KEY`), then replay what it recorded, with no model:

   ```bash
   npm run discover -- \
     --goal "Log in to the workstation, look up member {memberId} and read their current savings balance and member name." \
     --input memberId=12345 --output savingsBalance:number --output memberName:string \
     --id lookup-member-savings-balance --read-only --out artifacts/my-lookup.json

   npm run --silent replay -- artifacts/my-lookup.json --input memberId=12345
   npm run --silent replay -- artifacts/my-lookup.json --input memberId=10002
   ```

The goal is read-only, so it should need no confirmations. If the model does escalate, the run waits for you in Relay at `http://127.0.0.1:4300`. `--read-only` declares that replaying the capability changes nothing in the app. Nothing verifies that, and with it `discover` also runs the optimizer before writing the file. Without `--out`, `discover` writes `artifacts/<id>.json` and refuses to overwrite an existing file there; the example uses `--out` so it leaves the shipped capability alone.

Replay prints a one-line result ending with the locator drift summary, then the path of `result.json`. The console URL, the run directory and the final control state go to stderr. Add `--json` for the result as JSON only.

A fresh discovery declares no business outcomes, so an unknown member ends as a `hard_failure`. To add them, run extend mode on the draft:

```bash
npm run --silent cli -- discover --extend artifacts/my-lookup.json --out artifacts/my-lookup-extended.json \
  --goal "Log in to the workstation, look up member {memberId} and read their current savings balance and member name." \
  --id lookup-member-savings-balance --input memberId=99999 \
  --output savingsBalance:number --output memberName:string
```

Then validate, replay and approve it:

```bash
npm run --silent cli -- validate artifacts/my-lookup-extended.json
npm run --silent replay -- artifacts/my-lookup-extended.json --input memberId=12345
npm run --silent cli -- approve artifacts/my-lookup-extended.json --by "your name"
```

### Web: replay without a key

`artifacts/lookup-member-savings-balance.json` is an approved capability the model recorded earlier, so you can see every result kind without learning anything first. With the mock app running:

```bash
# success, exit 0
npm run --silent replay -- artifacts/lookup-member-savings-balance.json --input memberId=12345
# business_outcome member_not_found, exit 3
npm run --silent replay -- artifacts/lookup-member-savings-balance.json --input memberId=99999
# hard_failure app_error, exit 4, with a screenshot and a DOM snapshot
npm run --silent replay -- artifacts/lookup-member-savings-balance.json --input memberId=12345 --fault '{"failSearch":true}'
```

`--fault` asks the mock app to misbehave for that run and restores it afterwards. More scenarios (access denied, seeded chaos, the read-only retry, a scripted re-login, tenant B, stability runs) are in [the reference](reference.md#replay-scenarios-on-the-web-mock-app).

### Web: a real human handoff

Run the expired-session case with a visible browser and no scripted operator:

```bash
npm run --silent replay -- artifacts/examples/lookup-member-savings-balance.example.json \
  --input memberId=12345 --fault '{"expireSession":true}' --headed
```

The run pauses, and Relay serves the console at `http://127.0.0.1:4300`. Then:

1. In Relay, take control.
2. Sign in again in the Chromium window the run was driving, and leave the app on the screen shown right after sign-in.
3. In Relay, hand back with the default choice, "Start again after sign-in". It resumes at the first step after sign-in and lists the steps it will repeat. The other choice, "I completed this step, continue", is taken at its word: after only a sign-in it can report "member not found" for a member who exists.

The run resumes on the same session. Its run directory holds the intervention record and the captured actions, with no values. If port 4300 is busy, move the console with `--operator-port`. A person who stops responding loses control after a 15-minute lease, and an escalation nobody takes is aborted after the same period. `npm run operator` walks through the same handoff against an in-memory stand-in for the app.

### Desktop: the same, on Teller Workstation (Windows)

Replay the capability from the desktop evidence run. No key is needed; the run starts the app, drives it and closes it:

```bash
npm run --silent cli -- --policy policies/desktop.yaml --base-url desktop://tellerworkstation \
  --app-command "powershell.exe -NoProfile -ExecutionPolicy Bypass -File apps/mock-desktop/teller.ps1" \
  replay evidence/followups/discovery-desktop/capability.json --input memberId=10002
```

It succeeds in 7 steps, about 3 seconds. The summary line shows the masked balance as `<sensitive>`; add `--json` to see the value the caller gets. With `--input memberId=99999` it ends in `hard_failure` (exit 4). [The step-by-step walkthrough](windows-walkthrough.md) explains both.

To learn the task yourself (needs `ANTHROPIC_API_KEY`), then replay it:

```bash
npm run --silent cli -- --policy policies/desktop.yaml --base-url desktop://tellerworkstation \
  --app-command "powershell.exe -NoProfile -ExecutionPolicy Bypass -File apps/mock-desktop/teller.ps1" \
  discover --goal "Sign on to the Teller Workstation, look up member {memberId} and read their savings balance." \
  --input memberId=12345 --output savingsBalance:number \
  --id teller-lookup-savings-balance --read-only --out artifacts/my-teller-lookup.json

npm run --silent cli -- --policy policies/desktop.yaml --base-url desktop://tellerworkstation \
  --app-command "powershell.exe -NoProfile -ExecutionPolicy Bypass -File apps/mock-desktop/teller.ps1" \
  replay artifacts/my-teller-lookup.json --input memberId=10002
```

To drive a copy that is already running, start it with `npm run mock-desktop` and replace `--app-command ...` with `--attach-pid <pid>` (in PowerShell, `(Get-Process TellerWorkstation).Id`). An attached app is left running. `--fault` is web-only; Teller Workstation's own fault switches are in [`apps/mock-desktop/README.md`](../apps/mock-desktop/README.md#faults).

### More commands

The catalog, `audit`, `optimize`, the risk-judge eval, rebuilding the evidence folder, every global flag and every exit code are in [`docs/reference.md`](reference.md). For one command's options, run `npm run --silent cli -- <command> --help`.

## Tests

```bash
npm test            # everything: unit and end-to-end
npm run test:unit   # core, the five adapters, CLI, mock app, Relay, browser agent
npm run test:e2e    # discover, replay, handoff, chaos, optimize, catalog and CLI against the real mock app in Chromium
npm run typecheck
npm run lint        # includes the dependency-direction rules
```

Every test runs offline, with no key; the end-to-end suite drives the discovery agent with a scripted model. The desktop tests that open real windows (`tests/e2e/desktop.test.ts` and the adapter's integration test) run only on Windows. Elsewhere, including CI on Linux, the desktop adapter is tested against an in-process fake bridge. Tests that call a real model (`judge.live.test.ts` in the two judge adapters) are skipped unless their key is set. The vitest projects are `core`, `adapter-playwright`, `adapter-desktop`, `adapter-anthropic`, `adapter-jev`, `adapter-credentials`, `cli`, `mock-app`, `relay`, `browser-agent` and `e2e`; run one with `npx vitest run --project core`.

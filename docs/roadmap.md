# Roadmap

Everything in the root [README](../README.md) runs end to end on one machine. This page covers what running it for real institutions needs, the planned work, and a proposal for learning capabilities from people.

## Path to production

Running it for real institutions needs the following, roughly in this order.

1. **Relay off the machine, with sign-in.** Relay binds only to loopback and ships no operator sign-in: it accepts an `authenticate` middleware, but none ships and the CLI has no flag for one. The person must be at the machine running the browser or app. Stream the session to the operator over an authenticated channel (on the web, a Chromium DevTools screencast) and send their input back through it; the operator then need not sit at the machine, and Relay becomes the only way to act on the session. Put single sign-on behind the `authenticate` hook, check approval rights per escalation reason, and add server-side claims so two operators cannot both hold one intervention.
2. **Storage behind a port.** Runs and capabilities are files under `runs/` and `artifacts/`. Runs, screenshots and intervention records should go to a database and an object store. The broker already accepts an intervention store, but its interface is synchronous. The catalog needs a saved index: it reads every file on each call, which takes under a second at 200 capabilities, more than 2 seconds somewhere between 500 and 1,000, and several seconds at 2,000 ([measured](design/capability-selection.md#measured-scale)).
3. **Workers.** A run owns one live session. Scaling out means a pool of workers wired in at the composition root, each with one browser context or one Windows session, fed from a queue of invocations.
4. **A deployment model for desktop.** Runtime, bridge and app must share one machine, one signed-in session and one elevation level, so each concurrent desktop run needs its own Windows session, on a VM or a pooled workstation. Not yet tested: whether UI Automation and `PrintWindow` keep working on a locked screen or in a disconnected remote desktop session. The answer decides whether those sessions can run unattended.
5. **A signed, prebuilt bridge.** The bridge compiles C# with `Add-Type`, which PowerShell refuses in Constrained Language Mode, the locked-down mode that AppLocker and WDAC policies impose. A signed binary removes the compile step and the cache.
6. **Approvals tied to an identity.** `cu approve --by` records a typed name. Production needs the approver's signed-in identity on the record.
7. **Credentials for modern sign-in.** OAuth2 and SSO providers, and token refresh: today credentials load once per run, and the scripted re-login stops at multi-factor prompts. Vaults already work through an `exec:` helper ([credentials.md](design/credentials.md#oauth2-and-sso-later)).
8. **A choice of model provider.** `discover` is wired to Anthropic; adding another provider means editing the command. It needs a flag, with the no-LLM scan extended to the new vendor.
9. **Health over time.** Scheduled canary replays per capability and tenant, and a cross-tenant drift table built from the locator report every run already writes, feeding a confidence score that gates unattended replay.

## Planned work

Each item below names a gap in what is built and the work that closes it.

- **Learning from people**, as [proposed below](#proposed-learning-from-people-first).
- **A capability selector.** A small model call that reads the one-line briefs, picks an approved capability and fills its inputs, with a confirmation step before anything irreversible runs. Until it exists, a caller passes `catalog tools --approved-only` to keep drafts out ([design](design/capability-selection.md)).
- **Proving read-only.** A capability's `readOnly` flag is set by its author. Optimizer trials and the app-error retry rely on it, so a wrong flag could let them repeat a write. Checking the flag against what the app did during a verifying replay (requests on the web, changed controls on desktop) would remove that reliance.
- **Re-audit on drift.** The risk judge runs at record and audit time, not during replay, so a control whose meaning changes later is not judged again. A committing step that starts resolving through a fallback locator should send its capability back through `cu audit` before it runs unattended again.
- **Choosing the resume point in Relay.** Relay's API accepts a resume point on hand-back, and the rules that refuse an unsafe one are built. The console does not offer the choice yet.
- **Masking beyond the page structure.** Masking rules name elements, labels, patterns and known values. Text inside images, canvas or shadow DOM, and personal data under a label nobody listed, need OCR over the screenshot and a data-loss-prevention classifier ([limits](design/screen-masking.md#limits)).
- **Wider desktop reach.** UI Automation sees what a toolkit exposes. An MSAA fallback and OCR would reach older VB6, Delphi and PowerBuilder screens, and modifier key chords need adding ([limits](design/desktop.md#limits)). A macOS surface over the Accessibility API could use the same bridge protocol.
- **Reusable sub-capabilities**, such as a shared sign-in.
- **Model recovery for one failed step.** An explicit, policy-checked opt-in that lets a model repair one step and records what it did. That run gives up model-free replay.

## Proposed: learning from people first

*Not built. The parts listed under "what exists" are real; the rest is design.*

Today a model learns a capability by exploring the app. The alternative is to learn it from a person who already knows the task: they do it once while the runtime watches, and the recording becomes a capability through the same recorder, checks and approval as a model-learned one. One step further, the runtime could watch normal work passively across many desks to find out which tasks are worth automating at all.

**What exists that this would build on:**

- Value-free capture on both surfaces. During a handoff, the web surface records clicks, key presses, submits, navigations and which field was typed into, through listeners in every frame. The desktop surface records the same facts from UIA events on the app's windows. Neither reads a typed value. Today these records go into the intervention record and the run log; they are not turned into capability steps.
- Driving an app a person started. `--attach-pid` drives a desktop app that is already running and leaves it running. On the web, the runtime reuses [the in-page agent](design/browser-agent.md) when the app already ships it. That tag installs the agent but never starts capture, and captured actions reach the runtime only through a binding that the Playwright surface installs.
- The recorder's rules: each locator must find its element alone at record time, a target in an input's record keeps no positional locator, and input values become placeholders. They make a recording replayable instead of a macro, and a demonstration would go through them unchanged. The schema already allows `provenance.recordedBy: "human"`.

**What a demonstration mode needs:**

- A way to start capture without a run the runtime is driving: a `cu record` style command that opens or attaches to the app, starts capture, and lets the person work.
- Turning each captured action into a step through the recorder. A captured action carries a hint (role, name, text, a selector), not a verified locator chain, so the surface would have to build and check the chain from the live element at the moment the person acts.
- Inputs, outputs and checkpoints. Capture records no typed values, so it cannot tell that "12345" was the member id. Someone has to mark which fields are inputs, which values on screen are the outputs, and what the finished screen looks like. That can be the person who demonstrated, or a model reading the before-and-after screens. One option is to let the runtime read a field's value right after the person types into it and match it against declared input values, under the same masking rules.
- Business outcomes. A single demonstration shows one path. "Not found" and "access denied" need further demonstrations, or extend mode run by the model.
- A verifying replay before approval, as for any capability: the runtime replays the recording, and approval needs that replay on record.

The model still has a smaller role here: generalising one demonstration into a parameterised capability, proposing checkpoints, and labelling outcomes. The trade is model cost against people's time. Exploration costs model calls and can wander; a demonstration costs a skilled person's attention but follows the path the business actually uses.

**Passive task mining** would record what staff do day to day, collected centrally, to choose which workflows to automate and to give discovery or a demonstration a first path. Those traces would not replay as capabilities on their own: they have no per-step verification and no labelled outcome. Beyond the above, it needs:

- On the web, capture that starts without a driver and a channel to a collector, with endpoint authentication, batching, consent gating and server-side validation ([`docs/design/browser-agent.md`](design/browser-agent.md#what-a-production-collector-adds) lists what a production collector adds).
- On the desktop, an endpoint agent installed on each workstation (through Intune or SCCM) that watches for the app's process, attaches a bridge and streams its events. Attaching to an app a person launched already works; what is missing is a way onto every machine, which on the web the app's own tag provides.
- On both, splitting an all-day event stream into separate workflows, and a consent and employee-monitoring review before any of it is switched on. Desktop capture never reads typed values; a web collector would need the same rule.

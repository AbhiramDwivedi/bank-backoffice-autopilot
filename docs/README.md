# docs

These are the guides and design notes. For what the system does, start with the root [`README.md`](../README.md). For the reasoning behind it, read [`REPORT.md`](../REPORT.md). Come here when you want detail on one part.

The following table lists each document and what to read it for:

| File | Read it for |
|---|---|
| [`getting-started.md`](getting-started.md) | Setup, learning and replaying a task on the web mock app, a real human handoff, the desktop demo on Windows, Windows PowerShell quoting, and the tests. |
| [`windows-walkthrough.md`](windows-walkthrough.md) | One desktop discovery and its replays, turn by turn: the bridge protocol, what the model saw and called, the masked screenshots, the step it wrote, and how replay ends. |
| [`llm-risks.md`](llm-risks.md) | How the runtime handles the risks of using a model: hallucination, guardrails, token cost, retries and abuse, each with proof. |
| [`roadmap.md`](roadmap.md) | The path to production, planned work, and the proposal for learning capabilities from people. |
| [`repo-layout.md`](repo-layout.md) | Where the code lives, and what the committed run evidence and the explainer video hold. |
| [`design/architecture.md`](design/architecture.md) | Packages, ports, and which way dependencies point. Read this first. |
| [`reference.md`](reference.md) | Every `cu` command, the global flags, exit codes, policy fields, environment variables, and what a run writes. |
| [`contracts.md`](contracts.md) | Every type in one place: capability, conditions, policy, run events, replay result, stability summary, intervention, replay options, credentials and the risk judge, plus the mock app's routes, faults and seed data. |
| [`design/foundation.md`](design/foundation.md) | The shared base every module builds on: contract types, the `Surface` seam, and the evidence sink. |
| [`design/agent.md`](design/agent.md) | The LLM discovery loop and how a run becomes a capability. |
| [`design/replay.md`](design/replay.md) | Deterministic replay, its four result kinds (success, business outcome, hard failure, escalated), how mid-run recovery fits in, and resuming at another step. |
| [`design/surface.md`](design/surface.md) | The `Surface` port, locator fallback, and the Chromium adapter. |
| [`design/browser-agent.md`](design/browser-agent.md) | The in-page script: naming, enumeration, and value-free capture. |
| [`design/handoff.md`](design/handoff.md) | How control passes between automation and a human on the same session. |
| [`design/relay.md`](design/relay.md) | The operator console. |
| [`design/policy.md`](design/policy.md) | Guardrails: allowlists, risk classes, and redaction. |
| [`design/screen-masking.md`](design/screen-masking.md) | What the surfaces hide from the model, evidence and Relay before anything leaves them: the `redaction.screen` rules, CSS redaction in screenshots, the masked view for model-written conditions, sensitive outputs, failing closed, and the named limits. |
| [`design/mock-app.md`](design/mock-app.md) | Why the target app looks the way it does, which faults it can produce, seeded chaos, and what chaos found. |
| [`design/integration.md`](design/integration.md) | The `cu` command, the composition root that wires the pieces together, and the agent-facing catalog. |
| [`design/desktop.md`](design/desktop.md) | The Windows desktop surface over UI Automation: how the artifact vocabulary maps onto it, desktop locations in policy, and its limits. |
| [`design/risk-judge.md`](design/risk-judge.md) | The judgment-based check of committing actions at record and audit time, `cu audit`, and the eval set. |
| [`design/optimize.md`](design/optimize.md) | The model-free, replay-verified optimizer and the read-only boundary it runs behind. |
| [`design/credentials.md`](design/credentials.md) | The credential-provider port, the `file:` and `exec:` providers, the auth block, generic re-login, and operator authentication to Relay. |
| [`design/capability-selection.md`](design/capability-selection.md) | Catalog search and progressive listing as built, and the model-driven selector that is designed but not built. |
| [`design/public-target.md`](design/public-target.md) | Why and how the runtime is run against a public demo site, and what that run found. |
| [`design/security-review.md`](design/security-review.md) | Findings and fixes. A `*.redteam.test.ts` pins each one. |
| [`video/`](video/) | How the explainer video is built. |
| [`img/`](img/) | Diagrams the READMEs use. |

# Repo layout and evidence

Where the code lives, and what the committed run evidence holds. For how the pieces fit together, read the [architecture note](design/architecture.md).

## Repo layout

| Path | What it is |
|---|---|
| `apps/cu` | The `cu` CLI and the composition root that wires everything together (`src/runtime/compose.ts`), plus the capability catalog |
| `apps/relay` | Relay, the operator console, mounted in-process on a loopback port |
| `apps/mock-app`, `apps/mock-desktop` | The two targets: CU Core Workstation (web) and Teller Workstation (Windows Forms) |
| `packages/core` | The domain and its ports: capability schema, agent and recorder, replay, optimizer, policy, session and handoff, evidence |
| `packages/adapter-playwright`, `packages/adapter-desktop` | The two surfaces |
| `packages/browser-agent` | The in-page script the web surface uses |
| `packages/adapter-anthropic`, `packages/adapter-jev`, `packages/adapter-credentials` | The model client and risk judges, and the file and helper-process credential providers |
| `policies/`, `artifacts/`, `evidence/` | Policy files, capabilities, recorded runs |
| `docs/` | Type reference ([`docs/contracts.md`](contracts.md)), design notes per module including [the architecture](design/architecture.md), and the [command reference](reference.md) |
| `tests/e2e`, `tools/` | Cross-package end-to-end tests; the evidence and video builders |

[`docs/design/extending.md`](design/extending.md) covers adding a surface (macOS, a pixel-only remote desktop, a terminal emulator), a model provider, a risk judge, a credential source or a console, and says plainly where each seam is not clean yet.

## Evidence

[`evidence/`](../evidence/) holds real run directories copied from `runs/`: the discovery run that produced the shipped capability (with a screenshot per model turn and the redacted transcript), the two extend runs, and replays for success, both business outcomes, an injected app error, a session expiry handed to a person and resumed, and tenant B with and without its override. `npm run evidence` regenerates that top level with the mock app running. [`evidence/followups/`](../evidence/followups/README.md) holds live runs of the later features: the risk judge, the optimizer, seeded chaos, the app-error retry, discovery on the web and desktop mock apps, and a public demo site. Each run directory has `events.jsonl`, `result.json`, and where produced, `shots/`, `dom/` and `interventions/`. A test checks every run log for events in strict order, the finish event last, and every referenced screenshot on disk ([`evidence-integrity.redteam.test.ts`](../packages/core/src/evidence/evidence-integrity.redteam.test.ts)).

`evidence/explainer.mp4` is a five-minute narrated walkthrough. `npm run video:build` records it from real runs against the mock app and Relay and narrates it with Windows' built-in speech voices ([how](video/README.md)). It was recorded before the desktop surface and screen masking existed; where it says they were left out, both now exist.

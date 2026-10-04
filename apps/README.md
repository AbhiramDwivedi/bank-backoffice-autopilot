# apps

This folder holds the programs you run. Each one is an npm workspace with its own README.

| Folder | What it is | How to start it |
|---|---|---|
| [`cu/`](cu/) | The robot: the `cu` command. It discovers a task with an LLM, replays it without one, audits and optimizes capabilities, approves them, and serves the catalog an agent calls. It also holds the composition root that wires `core` to the adapters. | `npm run cli -- <command>` |
| [`relay/`](relay/) | The human console. Paused runs queue here, and a person takes control of the live browser and hands it back. The CLI mounts it in-process when a run needs a human. | Started by `discover`, `replay`, and `catalog invoke`; `npm run operator` for a walkthrough |
| [`mock-app/`](mock-app/) | The target: a deliberately legacy credit-union back-office app with fault injection and two tenants. | `npm run mock-app` |
| [`mock-desktop/`](mock-desktop/) | The desktop target: a dated Windows Forms teller workstation with the same members and credentials, and fault switches. Windows only. | `npm run mock-desktop` |

Apps depend on `packages/`, and packages never depend on apps. For the full dependency map, see the [architecture overview](../docs/design/architecture.md).

# packages

The apps build on these libraries. Each folder is an npm workspace with its own README, and the following table summarizes them.

| Folder | Contents |
|---|---|
| [`core/`](core/) | The domain: capability schema, discovery loop, deterministic replay, the optimizer, error taxonomy, policy guard, handoff session, credentials, run logging, and redaction. Defines the `Surface`, `LlmClient`, `RiskJudge` and `CredentialProvider` ports and imports no browser or LLM code. |
| [`adapter-playwright/`](adapter-playwright/) | The `Surface` port for Chromium through Playwright. Handles framesets, table layouts, div buttons, and span tabs. |
| [`adapter-desktop/`](adapter-desktop/) | The `Surface` port for native Windows apps through UI Automation, via a PowerShell-hosted bridge. Touches only the process tree it launched, and never synthesizes global input. |
| [`adapter-anthropic/`](adapter-anthropic/) | The `LlmClient` port for Claude, and a Claude-backed `RiskJudge`. The only package allowed to import `@anthropic-ai/*`; a test fails if any other package does. |
| [`adapter-jev/`](adapter-jev/) | The `RiskJudge` port (the judgment-based unsafe-action check, see [`docs/design/risk-judge.md`](../docs/design/risk-judge.md)) backed by Jev, TypeSafe's System One model. Raw `fetch`, no SDK. |
| [`adapter-credentials/`](adapter-credentials/) | The `CredentialProvider` port for sources other than the environment: a `file:` provider for a credentials file kept outside the repository, and an `exec:` provider that runs a credential-helper process (1Password, Vault, SSO token helpers through a wrapper script). |
| [`browser-agent/`](browser-agent/) | A small dependency-free script that runs inside the page. It names controls for automation and, during a handoff, records what a human clicks but never what they type. |

`core` knows nothing about Chromium, Windows or any model vendor; each of those is an adapter that implements one of its ports. For how the layers fit together, see [`docs/design/architecture.md`](../docs/design/architecture.md).

# Relay

Relay is the human-in-the-loop console. It shows a queue of paused runs, lets a person take control of the live browser, and hands control back to the run. The [Relay design doc](../../docs/design/relay.md) explains how it works.

To mount Relay, call `startRelayServer({ port, brokers, leaseMs })` from `src/server/index.ts`. To require operator authentication, also pass `authenticate`, an Express middleware that runs before every route; none ships. See "Operator authentication to Relay" in [`docs/design/credentials.md`](../../docs/design/credentials.md#operator-authentication-to-relay).

Run these commands from the repo root:

| Command | What it does |
|---|---|
| `npm --prefix apps/relay run build` | Bundles the UI into `apps/relay/dist/` with esbuild. |
| `npm --prefix apps/relay run dev` | Rebuilds on change and serves three simulated runs on http://127.0.0.1:4330. |
| `npm --prefix apps/relay test` | Runs the server, SSE, and Playwright UI tests (vitest). |
| `npm --prefix apps/relay run typecheck` | Runs `tsc --noEmit`. |

/**
 * Public entry for `@cu/relay` (see apps/relay/package.json `exports`). This is what the
 * composition root (scripts/dev.ts, scripts/build.ts, or another app embedding Relay) imports.
 */
export { createRelayApp, type RelayApp, type RelayAppOptions } from './app.js';
export { startRelayServer, type RelayServerHandle, type StartRelayServerOptions } from './start.js';
export {
  createSessionRegistry,
  fromSessionBroker,
  type BrokerAdapterOptions,
  type RelaySessionRegistry,
} from './broker-adapter.js';
export { createEventHub, type EventHub, type EventHubOptions } from './events.js';
export * from './ports.js';

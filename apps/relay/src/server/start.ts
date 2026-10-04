/**
 * Composition root for Relay: wires a set of live `SessionBroker`s to `createRelayApp` and starts
 * a listener. See docs/design/relay.md "Mounting in the composition root".
 */
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createRelayApp, type RelayAppOptions } from './app.js';
import { createSessionRegistry, type BrokerAdapterOptions, type RelaySessionRegistry } from './broker-adapter.js';
import { createRedactor, type SessionBroker } from './core.js';

export interface StartRelayServerOptions {
  /** Default 4330; 0 = OS-assigned ephemeral port. */
  port?: number;
  /** Default '127.0.0.1'. Must be a loopback host (127.0.0.1, ::1, localhost); remote access is out of scope -- this server has no auth of its own. */
  host?: string;
  brokers?: SessionBroker[];
  /** Passed to the broker adapter. */
  leaseMs?: number;
  /** Default: apps/relay/dist, resolved from this module. */
  staticDir?: string;
  /** Default `createRedactor()` (src/evidence). */
  redact?: RelayAppOptions['redact'];
  /**
   * Operator authentication middleware, passed to `createRelayApp`: runs before every route (see
   * `RelayAppOptions.authenticate`). Omitted: the console has no operator authentication, and any
   * local process that can reach the loopback port can use it.
   */
  authenticate?: RelayAppOptions['authenticate'];
  /** See `RelayAppOptions.onAuthError`: told the class name of an error the hook threw, never its message. */
  onAuthError?: RelayAppOptions['onAuthError'];
}

export interface RelayServerHandle {
  url: string;
  port: number;
  register(broker: SessionBroker, opts?: BrokerAdapterOptions): void;
  unregister(runId: string): void;
  /** Ends the relay app (SSE streams), disposes the broker registry, then closes the listener. Idempotent. */
  close(): Promise<void>;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

function urlFor(host: string, port: number): string {
  const hostForUrl = host === '::1' ? '[::1]' : host;
  return `http://${hostForUrl}:${port}`;
}

export async function startRelayServer(opts: StartRelayServerOptions = {}): Promise<RelayServerHandle> {
  const host = opts.host ?? '127.0.0.1';
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `startRelayServer: host '${host}' is not a loopback host (127.0.0.1, ::1, localhost); remote access is out of scope`,
    );
  }
  const port = opts.port ?? 4330;
  const staticDir = opts.staticDir ?? fileURLToPath(new URL('../../dist/', import.meta.url));
  const redact = opts.redact ?? createRedactor();

  const registry: RelaySessionRegistry = createSessionRegistry(opts.brokers, opts.leaseMs !== undefined ? { leaseMs: opts.leaseMs } : {});
  const relayApp = createRelayApp({
    port: registry,
    redact,
    staticDir,
    ...(opts.authenticate !== undefined ? { authenticate: opts.authenticate } : {}),
    ...(opts.onAuthError !== undefined ? { onAuthError: opts.onAuthError } : {}),
  });

  const server: Server = createServer(relayApp.app);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (err) {
    // Nothing is listening (e.g. EADDRINUSE): release the app's port subscription and the
    // registry's broker subscriptions before reporting the failure.
    await relayApp.close();
    registry.dispose();
    throw err;
  }

  const address = server.address();
  const actualPort = typeof address === 'object' && address !== null ? address.port : port;
  const url = urlFor(host, actualPort);

  let closed = false;
  return {
    url,
    port: actualPort,
    register: (broker, registerOpts) => registry.register(broker, registerOpts),
    unregister: (runId) => registry.unregister(runId),
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await relayApp.close();
      registry.dispose();
      server.closeIdleConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

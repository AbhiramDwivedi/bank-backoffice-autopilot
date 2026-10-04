import { createServer, type Server } from 'node:http';
import { createApp } from './app.js';
import { TENANTS, type TenantId } from './tenant.js';

const rawTenant = process.env.MOCK_TENANT ?? 'a';
let tenantId: TenantId;
if (rawTenant === 'a' || rawTenant === 'b') {
  tenantId = rawTenant;
} else {
  console.error(`MOCK_TENANT must be "a" or "b", got ${JSON.stringify(rawTenant)}`);
  process.exit(1);
}

const tenant = TENANTS[tenantId];

let port = tenant.defaultPort;
const rawPort = process.env.MOCK_PORT;
if (rawPort !== undefined) {
  const parsed = Number(rawPort);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    console.error(`MOCK_PORT must be a positive integer, got ${JSON.stringify(rawPort)}`);
    process.exit(1);
  }
  port = parsed;
}

// Loopback only by default: the app exposes /__faults and /__reset, which must not be reachable
// from the network. Both loopback families are bound, so http://localhost:<port> works whichever
// address a client resolves localhost to (Chromium, Node fetch, and plain 127.0.0.1 probes alike).
// MOCK_HOST binds exactly one address instead (e.g. 0.0.0.0 to expose the app deliberately).
const rawHost = process.env.MOCK_HOST;
if (rawHost !== undefined && rawHost.trim() === '') {
  console.error('MOCK_HOST must be a host name or IP address, got an empty string');
  process.exit(1);
}
const hosts = rawHost !== undefined ? [rawHost.trim()] : ['127.0.0.1', '::1'];

const app = createApp({ tenant: tenantId });

/** Listens on `host`; resolves false when that address family is unavailable on this machine (IPv6 disabled). */
function listenOn(host: string): Promise<boolean> {
  const server: Server = createServer(app);
  return new Promise((resolve, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      const optionalFamily = rawHost === undefined && host === '::1';
      if (optionalFamily && (err.code === 'EADDRNOTAVAIL' || err.code === 'EAFNOSUPPORT')) resolve(false);
      else reject(err);
    });
    server.listen(port, host, () => resolve(true));
  });
}

try {
  const bound: string[] = [];
  for (const host of hosts) {
    if (await listenOn(host)) bound.push(host.includes(':') ? `[${host}]` : host);
  }
  console.log(
    `CU Core Workstation (tenant ${tenantId}: ${tenant.institution}) listening on http://localhost:${port} (bound to ${bound.join(', ')})`,
  );
} catch (err) {
  console.error(`cannot listen on port ${port}: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

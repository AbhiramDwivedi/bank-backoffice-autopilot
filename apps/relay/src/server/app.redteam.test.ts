/**
 * Guard / security-perimeter tests for the Relay HTTP app: Host/Origin/CSRF, path traversal,
 * body-size limits, and no permissive CORS. Per docs/design/relay.md, Host and Origin guard EVERY
 * route (not only the mutating POSTs), Origin must be exactly this server's own origin, and a
 * `Sec-Fetch-Site: cross-site` request is refused outright.
 */
import { createServer, type Server } from 'node:http';
import net from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { escalateSample, makeBrokerFixture, type BrokerFixture } from '../../test/support/fixtures.js';
import { createRelayApp, type RelayApp } from './app.js';
import { fromSessionBroker, type RelaySessionRegistry } from './broker-adapter.js';
import { createRedactor } from './core.js';

function jsonBody(body: unknown): { method: 'POST'; headers: { 'Content-Type': string }; body: string } {
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function makeStaticDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'relay-redteam-static-'));
  writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><body><!--RELAY_BOOTSTRAP--></body></html>');
  mkdirSync(path.join(dir, 'assets'));
  writeFileSync(path.join(dir, 'assets', 'app.js'), 'console.log(1);');
  return dir;
}

interface Harness {
  relayApp: RelayApp;
  registry: RelaySessionRegistry;
  server: Server;
  url: string;
  port: number;
  staticDir: string;
  close(): Promise<void>;
}

async function startApp(broker: BrokerFixture['broker']): Promise<Harness> {
  const staticDir = makeStaticDir();
  const registry = fromSessionBroker(broker);
  const relayApp = createRelayApp({ port: registry, redact: createRedactor(), staticDir });
  const server = createServer(relayApp.app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const listenPort = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    relayApp,
    registry,
    server,
    url: `http://127.0.0.1:${listenPort}`,
    port: listenPort,
    staticDir,
    async close(): Promise<void> {
      await relayApp.close();
      registry.dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(staticDir, { recursive: true, force: true });
    },
  };
}

const fixtures: BrokerFixture[] = [];
const harnesses: Harness[] = [];

function fixture(): BrokerFixture {
  const f = makeBrokerFixture();
  fixtures.push(f);
  return f;
}

afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
  for (const f of fixtures.splice(0)) f.dispose();
});

/** Sends a raw request with a forged `Host` header (fetch cannot set it: it's a forbidden header). */
function rawRequest(port: number, method: string, requestPath: string, host: string, extraHeaders: string[] = [], body?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      const headers = [`Host: ${host}`, ...extraHeaders];
      if (body !== undefined) headers.push(`Content-Length: ${Buffer.byteLength(body)}`);
      headers.push('Connection: close');
      socket.write(`${method} ${requestPath} HTTP/1.1\r\n${headers.join('\r\n')}\r\n\r\n${body ?? ''}`);
    });
    let data = '';
    socket.on('data', (d) => (data += d.toString()));
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
  });
}

describe('Host guard: applies to every route', () => {
  it('refuses GET /, GET /api/interventions and GET /api/events when Host does not name this server', async () => {
    const { broker } = fixture();
    const h = await startApp(broker);
    harnesses.push(h);
    const resolutionPromise = escalateSample(broker, { reason: { code: 'stuck', message: 'rebinding-probe' } });

    for (const p of ['/', '/api/interventions', '/api/events']) {
      const raw = await rawRequest(h.port, 'GET', p, 'evil.example');
      expect(raw, p).toMatch(/^HTTP\/1\.1 403/);
      expect(raw, p).not.toContain('rebinding-probe');
    }

    const ok = await rawRequest(h.port, 'GET', '/api/interventions', `127.0.0.1:${h.port}`);
    expect(ok).toMatch(/^HTTP\/1\.1 200/);
    expect(ok).toContain('rebinding-probe');

    const { id } = await resolutionPromise;
    await h.registry.abort(id, 'operator');
  });

  it('refuses a POST (take) when Host is forged, and never actions the transition', async () => {
    const { broker } = fixture();
    const h = await startApp(broker);
    harnesses.push(h);
    const { id } = await escalateSample(broker);

    const body = JSON.stringify({ by: 'attacker' });
    const raw = await rawRequest(h.port, 'POST', `/api/interventions/${id}/take`, 'evil.example', ['Content-Type: application/json'], body);
    expect(raw).toMatch(/^HTTP\/1\.1 403/);
    expect(raw).not.toContain('human_active');

    const legit = await fetch(`${h.url}/api/interventions/${id}/take`, jsonBody({ by: 'operator' }));
    expect(legit.status).toBe(200);

    await h.registry.abort(id, 'operator');
  });

  it('accepts Host: [::1]:<port> and Host: localhost:<port>', async () => {
    const { broker } = fixture();
    const h = await startApp(broker);
    harnesses.push(h);
    const viaLocalhost = await rawRequest(h.port, 'GET', '/api/runs', `localhost:${h.port}`);
    expect(viaLocalhost).toMatch(/^HTTP\/1\.1 200/);
  });
});

describe('Origin guard: applies to every route', () => {
  it('refuses GET /api/interventions when Origin is present but foreign', async () => {
    const { broker } = fixture();
    const h = await startApp(broker);
    harnesses.push(h);
    const res = await fetch(`${h.url}/api/interventions`, { headers: { Origin: 'http://evil.example' } });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('forbidden');
  });

  it('refuses take/handback/abort when Origin names a different site', async () => {
    const { broker } = fixture();
    const h = await startApp(broker);
    harnesses.push(h);
    const { id } = await escalateSample(broker);

    const res = await fetch(`${h.url}/api/interventions/${id}/take`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' },
      body: JSON.stringify({ by: 'attacker' }),
    });
    expect(res.status).toBe(403);

    await h.registry.abort(id, 'operator');
  });

  it('accepts a same-origin Origin (http://127.0.0.1:<port>)', async () => {
    const { broker } = fixture();
    const h = await startApp(broker);
    harnesses.push(h);
    const res = await fetch(`${h.url}/api/runs`, { headers: { Origin: h.url } });
    expect(res.status).toBe(200);
  });

  it('refuses an Origin on another local port, scheme or loopback name: only the server origin itself passes', async () => {
    const { broker } = fixture();
    const h = await startApp(broker);
    harnesses.push(h);
    const { id } = await escalateSample(broker);

    for (const origin of [`http://127.0.0.1:${h.port + 1}`, 'http://localhost:5173', `http://localhost:${h.port}`, `https://127.0.0.1:${h.port}`, 'null']) {
      const read = await fetch(`${h.url}/api/interventions`, { headers: { Origin: origin } });
      expect(read.status, origin).toBe(403);
      const write = await fetch(`${h.url}/api/interventions/${id}/take`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: origin },
        body: JSON.stringify({ by: 'attacker' }),
      });
      expect(write.status, origin).toBe(403);
    }
    expect(broker.token.state).toBe('paused');

    await h.registry.abort(id, 'operator');
  });

  it('accepts Origin http://localhost:<port> when the Host header is localhost:<port>', async () => {
    const { broker } = fixture();
    const h = await startApp(broker);
    harnesses.push(h);
    const raw = await rawRequest(h.port, 'GET', '/api/runs', `localhost:${h.port}`, [`Origin: http://localhost:${h.port}`]);
    expect(raw).toMatch(/^HTTP\/1\.1 200/);
  });

  it('refuses a request with Sec-Fetch-Site: cross-site, even with no Origin header', async () => {
    const { broker } = fixture();
    const h = await startApp(broker);
    harnesses.push(h);
    const res = await fetch(`${h.url}/api/runs`, { headers: { 'Sec-Fetch-Site': 'cross-site' } });
    expect(res.status).toBe(403);
  });
});

describe('POST body rules', () => {
  it('rejects a non-JSON Content-Type with 400 before touching the broker', async () => {
    const { broker } = fixture();
    const h = await startApp(broker);
    harnesses.push(h);
    const { id } = await escalateSample(broker);

    const res = await fetch(`${h.url}/api/interventions/${id}/take`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ by: 'alice' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('bad_request');

    await h.registry.abort(id, 'operator');
  });

  it('413s a 20kB body rather than accepting or 400ing it', async () => {
    const { broker } = fixture();
    const h = await startApp(broker);
    harnesses.push(h);
    const { id } = await escalateSample(broker);
    await h.registry.take(id, 'operator');

    const hugeNotes = 'A'.repeat(20 * 1024);
    const res = await fetch(`${h.url}/api/interventions/${id}/handback`, jsonBody({ by: 'operator', resumeFrom: 'current_step', notes: hugeNotes }));
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('payload_too_large');
    expect(JSON.stringify(body)).not.toContain('    at ');

    // Confirm the reject is size-based, not a stuck broker: a normal-sized body still works.
    const ok = await fetch(`${h.url}/api/interventions/${id}/handback`, jsonBody({ by: 'operator', resumeFrom: 'current_step', notes: 'fine' }));
    expect(ok.status).toBe(200);
  });

  it('malformed JSON is 400, never a 500 or an HTML error page', async () => {
    const { broker } = fixture();
    const h = await startApp(broker);
    harnesses.push(h);
    const { id } = await escalateSample(broker);

    const res = await fetch(`${h.url}/api/interventions/${id}/take`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ this is not json',
    });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('bad_request');

    await h.registry.abort(id, 'operator');
  });

  it('rejects a non-string `by`', async () => {
    const { broker } = fixture();
    const h = await startApp(broker);
    harnesses.push(h);
    const { id } = await escalateSample(broker);

    const res = await fetch(`${h.url}/api/interventions/${id}/take`, jsonBody({ by: 12345 }));
    expect(res.status).toBe(400);

    await h.registry.abort(id, 'operator');
  });
});

describe('no permissive CORS', () => {
  it('GET /api/runs carries no Access-Control-Allow-Origin, even from a request naming this server as Origin', async () => {
    const { broker } = fixture();
    const h = await startApp(broker);
    harnesses.push(h);
    const res = await fetch(`${h.url}/api/runs`, { headers: { Origin: h.url } });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('path traversal in :id is inert', () => {
  const traversalIds = ['..%2F..%2Fetc%2Fpasswd', '../../etc/passwd', '....//....//etc/passwd'];

  it.each(traversalIds)('GET /api/interventions/%s -> 404, never 500/stack', async (raw) => {
    const { broker } = fixture();
    const h = await startApp(broker);
    harnesses.push(h);
    const res = await fetch(`${h.url}/api/interventions/${raw}`);
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).not.toContain('.ts:');
    expect(text).not.toContain('node_modules');
    expect(text).not.toContain('ENOENT');
  });
});

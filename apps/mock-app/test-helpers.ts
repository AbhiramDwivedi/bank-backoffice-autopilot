/**
 * Test harness for the mock-app vitest suite: starts a real HTTP server on an ephemeral port
 * and provides a tiny fetch-based client with a manual cookie jar (CUCWSESSID) and
 * `redirect: 'manual'` so tests can assert on 302 Location headers directly.
 *
 * No supertest: everything here is plain node http + global fetch (Node 22 / undici).
 */
import type { Express } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** The mock app's one seeded operator (apps/mock-app/routes/auth.ts): same defaults everywhere so
 *  the CLI, the discovery agent's demo credentials and every test suite agree without an .env. */
export const DEFAULT_USER_ID = 'operator1';
export const DEFAULT_PASSWORD = 'demo-pass-123';
export const SESSION_COOKIE = 'CUCWSESSID';

/** A fetch-based client with its own cookie jar, for driving one test app instance. */
export interface TestClient {
  readonly baseUrl: string;
  /** Raw fetch against baseUrl + path, sending jar cookies and applying any Set-Cookie back. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** GET convenience wrapper. */
  get(path: string, init?: RequestInit): Promise<Response>;
  /** Current value of a cookie in the jar, if any. */
  cookie(name: string): string | undefined;
}

/** A running test instance of the mock app, with a client bound to it. */
export interface TestServer {
  readonly baseUrl: string;
  readonly client: TestClient;
  close(): Promise<void>;
}

function getSetCookieValues(headers: Headers): string[] {
  const withGetSetCookie = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof withGetSetCookie.getSetCookie === 'function') {
    return withGetSetCookie.getSetCookie();
  }
  const single = headers.get('set-cookie');
  return single ? [single] : [];
}

function applySetCookies(headers: Headers, jar: Map<string, string>): void {
  for (const line of getSetCookieValues(headers)) {
    const segments = line.split(';').map((s) => s.trim());
    const pair = segments[0];
    if (!pair) continue;
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    const name = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    const attrs = segments.slice(1);
    const maxAgeZero = attrs.some((a) => /^max-age=0$/i.test(a));
    const expiresAttr = attrs.find((a) => /^expires=/i.test(a));
    let expired = maxAgeZero;
    if (!expired && expiresAttr) {
      const t = Date.parse(expiresAttr.slice('expires='.length));
      expired = Number.isFinite(t) && t < Date.now();
    }
    if (expired || value === '') {
      jar.delete(name);
    } else {
      jar.set(name, value);
    }
  }
}

/** A tiny cookie-jar client wrapping global fetch. Manual redirects: tests assert 302 + Location. */
export function createClient(baseUrl: string): TestClient {
  const jar = new Map<string, string>();

  async function doFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (jar.size > 0 && !headers.has('cookie')) {
      headers.set('cookie', [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; '));
    }
    const res = await fetch(`${baseUrl}${path}`, { ...init, headers, redirect: 'manual' });
    applySetCookies(res.headers, jar);
    return res;
  }

  return {
    baseUrl,
    fetch: doFetch,
    get: (path, init) => doFetch(path, { ...init, method: 'GET' }),
    cookie: (name) => jar.get(name),
  };
}

/** Starts `app` on 127.0.0.1 with an ephemeral port and returns a client + close(). */
export async function startTestApp(app: Express): Promise<TestServer> {
  const server: Server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', reject);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected server.address() to return an AddressInfo');
  }
  const baseUrl = `http://127.0.0.1:${(address as AddressInfo).port}`;
  const client = createClient(baseUrl);
  return {
    baseUrl,
    client,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/** POST an application/x-www-form-urlencoded body (what the real login/sub-account forms send). */
export function postForm(client: TestClient, path: string, data: Record<string, string>): Promise<Response> {
  return client.fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(data).toString(),
  });
}

/** POST a JSON body (used by the /__faults fault-injection endpoint). */
export function postJson(client: TestClient, path: string, data: unknown): Promise<Response> {
  return client.fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(data),
  });
}

/** Logs in as operator1 with the given (or default) password. Returns the raw login response. */
export function login(
  client: TestClient,
  opts: { userId?: string; password?: string } = {},
): Promise<Response> {
  return postForm(client, '/login', {
    userId: opts.userId ?? DEFAULT_USER_ID,
    password: opts.password ?? DEFAULT_PASSWORD,
  });
}

/** Convenience for tests: a fresh client, already logged in against `server`. */
export async function loginNewClient(
  server: TestServer,
  opts?: { userId?: string; password?: string },
): Promise<TestClient> {
  const client = createClient(server.baseUrl);
  const res = await login(client, opts);
  if (res.status !== 302 || res.headers.get('location') !== '/workstation') {
    throw new Error(`test setup: login failed (status ${String(res.status)})`);
  }
  return client;
}

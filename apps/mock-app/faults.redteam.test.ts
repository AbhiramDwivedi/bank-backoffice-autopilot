/**
 * Checks that the real mock-app server routes mangled paths to the fault-injection endpoints
 * (`/__faults`, `/__reset`) the same way the policy guard's URL check does. These endpoints are
 * unauthenticated and registered before every other middleware (see app.ts), so a 200 JSON
 * response means "reached the fault handler" and anything else (302 to /login, 404) means it
 * did not, regardless of whether the client is logged in.
 *
 * This is the live-server half of the allowlist check; `packages/core/src/policy/allowlist.redteam.test.ts`
 * checks what `PolicyGuard.checkUrl` decides for the same mangled paths. A path the guard would
 * allow through but that the real server still routes to `/__faults`/`/__reset` would be an
 * allowlist bypass. `client.get()` goes through the global `fetch` + WHATWG `URL` parser (the
 * same algorithm a real browser or Playwright uses), so what is sent on the wire here is what a
 * real navigation would send, not a raw unparsed string.
 *
 * For this app's Express version (5.2.1), there is no mismatch: Express's router does not
 * decode percent-encoding, collapse `//`, or match on anything but a byte-for-byte (though
 * case-insensitive) comparison against the literal path, so none of the mangled forms below
 * reach the fault routes. The one case that does match case-insensitively (`/__FAULTS`) is
 * exactly what the guard's case-insensitive deny regexes already catch.
 */
import type { Express } from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { createClient, startTestApp, type TestServer } from './test-helpers.js';

describe('mock-app route reality check: /__faults and /__reset against mangled paths', () => {
  let server: TestServer | undefined;

  afterEach(async () => {
    if (server) {
      await server.close();
      server = undefined;
    }
  });

  async function freshServer(): Promise<{ app: Express; server: TestServer }> {
    const app = createApp({ tenant: 'a' });
    const s = await startTestApp(app);
    server = s;
    return { app, server: s };
  }

  it('baseline: GET /__faults and /__reset reach the fault handler unauthenticated (200)', async () => {
    const { server: s } = await freshServer();
    const client = createClient(s.baseUrl);
    expect((await client.get('/__faults')).status).toBe(200);
    expect((await client.fetch('/__reset', { method: 'POST' })).status).toBe(200);
  });

  it('case variation DOES reach the fault handler (Express default case-insensitive routing) -- this is exactly why the guard\'s deny regexes must be (and are) compiled case-insensitively', async () => {
    const { server: s } = await freshServer();
    const client = createClient(s.baseUrl);
    const res = await client.get('/__FAULTS');
    expect(res.status).toBe(200);
    const flags = (await res.json()) as Record<string, unknown>;
    expect(flags).toHaveProperty('interstitial');
  });

  it('percent-encoded underscores ("/%5f%5ffaults", "/%5F%5Ffaults") do NOT reach the fault handler -- Express does not decode the path before matching, so this is not a decode-based bypass here', async () => {
    const { server: s } = await freshServer();
    const client = createClient(s.baseUrl);
    for (const path of ['/%5f%5ffaults', '/%5F%5Ffaults']) {
      const res = await client.get(path);
      expect(res.status).not.toBe(200);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/login'); // fell through to the auth gate, never matched /__faults
    }
  });

  it('a doubled leading slash ("//__faults") does NOT reach the fault handler -- Express does not collapse repeated slashes before matching', async () => {
    const { server: s } = await freshServer();
    const client = createClient(s.baseUrl);
    const res = await client.get('//__faults');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login');
  });

  it('dot-segment traversal ("/__faults/..") is normalized by the HTTP client\'s own URL parsing before the request is even sent -- the server receives "GET /", never "/__faults/.."; it does not reach the fault handler either way', async () => {
    const { server: s } = await freshServer();
    const client = createClient(s.baseUrl);
    const res = await client.get('/__faults/..');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login'); // "/" unauthenticated -> /login, not the fault handler
  });

  it('"/x/../__faults" normalizes (client-side, same as a real browser) to "/__faults" and DOES reach the fault handler -- consistent with the guard, which normalizes the same way and denies it', async () => {
    const { server: s } = await freshServer();
    const client = createClient(s.baseUrl);
    const res = await client.get('/x/../__faults');
    expect(res.status).toBe(200);
  });

  it('query string and fragment-adjacent forms still reach the fault handler (as expected; the guard\'s deny pattern is pathname-only and matches these too)', async () => {
    const { server: s } = await freshServer();
    const client = createClient(s.baseUrl);
    expect((await client.get('/__faults?x=1')).status).toBe(200);
  });

  describe('the chaos report route (/__faults/chaos) behaves like /__faults', () => {
    it('baseline: GET /__faults/chaos reaches the handler unauthenticated (200 JSON)', async () => {
      const { server: s } = await freshServer();
      const res = await createClient(s.baseUrl).get('/__faults/chaos');
      expect(res.status).toBe(200);
      expect(await res.json()).toHaveProperty('log');
    });

    it('case variation ("/__FAULTS/CHAOS") reaches it too -- covered by the case-insensitive ^/__faults deny in the guard', async () => {
      const { server: s } = await freshServer();
      expect((await createClient(s.baseUrl).get('/__FAULTS/CHAOS')).status).toBe(200);
    });

    it('percent-encoded and doubled-slash forms do NOT reach it (fall through to the auth gate)', async () => {
      const { server: s } = await freshServer();
      const client = createClient(s.baseUrl);
      for (const path of ['/%5f%5ffaults/chaos', '/__faults/%63haos', '//__faults/chaos']) {
        const res = await client.get(path);
        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toBe('/login');
      }
    });

    it('is read-only: POST /__faults/chaos is not a route and cannot set chaos', async () => {
      const { server: s } = await freshServer();
      const client = createClient(s.baseUrl);
      const res = await client.fetch('/__faults/chaos', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chaos: { seed: 1, failSearch: 1 } }),
      });
      expect(res.status).toBe(302);
      const flags = (await (await client.get('/__faults')).json()) as Record<string, unknown>;
      expect(flags.chaos).toBeNull();
    });
  });
});

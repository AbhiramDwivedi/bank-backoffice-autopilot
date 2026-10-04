/**
 * Seeded chaos over real HTTP: the `/__faults` contract for `chaos`, the `/__faults/chaos` report,
 * precedence of the explicit switches, reset, per-instance isolation, and reproducibility of the
 * injected faults for a fixed seed and request sequence. chaos.ts's own unit tests are in
 * chaos.test.ts.
 */
import type { Express } from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, getContext } from './app.js';
import type { ChaosReport } from './chaos.js';
import { createClient, loginNewClient, postJson, startTestApp, SESSION_COOKIE, type TestClient, type TestServer } from './test-helpers.js';

const servers: TestServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function fresh(tenant: 'a' | 'b' = 'a'): Promise<{ app: Express; server: TestServer }> {
  const app = createApp({ tenant });
  const server = await startTestApp(app);
  servers.push(server);
  return { app, server };
}

async function setFaults(client: TestClient, body: unknown): Promise<Record<string, unknown>> {
  const res = await postJson(client, '/__faults', body);
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

async function report(client: TestClient): Promise<ChaosReport> {
  const res = await client.get('/__faults/chaos');
  expect(res.status).toBe(200);
  return (await res.json()) as ChaosReport;
}

/** Status of each of `n` searches (200 or 500). The body is drained so the connection is reused. */
async function searchStatuses(client: TestClient, n: number): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const res = await client.get('/members/search?memberId=12345');
    await res.text();
    out.push(res.status);
  }
  return out;
}

describe('chaos: the /__faults contract', () => {
  it('POST sets a chaos config; GET /__faults returns it; GET /__faults/chaos starts with zeroed counters and an empty log', async () => {
    const { server } = await fresh();
    const config = { seed: 42, failSearch: 0.05, interstitial: 0.2, expireSession: 0.02, slowMs: { p: 0.1, minMs: 0, maxMs: 3000 } };
    const body = await setFaults(server.client, { chaos: config });
    expect(body.rejected).toEqual([]);
    expect(body.chaos).toEqual(config);

    const flags = (await (await server.client.get('/__faults')).json()) as Record<string, unknown>;
    expect(flags.chaos).toEqual(config);

    expect(await report(server.client)).toEqual({
      config,
      stats: {
        failSearch: { draws: 0, fired: 0 },
        slowMs: { draws: 0, fired: 0 },
        interstitial: { draws: 0, fired: 0 },
        expireSession: { draws: 0, fired: 0 },
      },
      log: [],
      logDropped: 0,
    });
  });

  it('a rejected chaos body is reported and leaves the previous chaos config, counters and log untouched', async () => {
    const { server } = await fresh();
    const client = await loginNewClient(server);
    await setFaults(client, { interstitial: false, chaos: { seed: 1, failSearch: 1 } });
    await searchStatuses(client, 2);

    const res = await setFaults(client, { chaos: { seed: 2, failSearch: 7, typo: 0.1 } });
    expect(res.rejected).toEqual(['chaos.failSearch', 'chaos.typo']);
    expect(res.chaos).toEqual({ seed: 1, failSearch: 1 });

    const r = await report(client);
    expect(r.config).toEqual({ seed: 1, failSearch: 1 });
    expect(r.stats.failSearch).toEqual({ draws: 2, fired: 2 });
    expect(r.log).toHaveLength(2);
  });

  it('a bad chaos value does not block the other top-level keys in the same body (same per-key rule as every other flag)', async () => {
    const { server } = await fresh();
    const res = await setFaults(server.client, { slowMs: 5, chaos: 'on' });
    expect(res.rejected).toEqual(['chaos (expected an object or null)']);
    expect(res.slowMs).toBe(5);
    expect(res.chaos).toBeNull();
  });

  it('GET /__faults round-trips: posting the snapshot back restores it exactly (what replay --fault relies on to restore)', async () => {
    const { server } = await fresh();
    const snapshotOff = await (await server.client.get('/__faults')).json();
    await setFaults(server.client, { failSearch: true, chaos: { seed: 9, interstitial: 0.5 } });
    const restored = await setFaults(server.client, snapshotOff);
    expect(restored.rejected).toEqual([]);
    expect(await (await server.client.get('/__faults')).json()).toEqual(snapshotOff);

    await setFaults(server.client, { chaos: { seed: 9, interstitial: 0.5 } });
    const snapshotOn = await (await server.client.get('/__faults')).json();
    const again = await setFaults(server.client, snapshotOn);
    expect(again.rejected).toEqual([]);
    expect(await (await server.client.get('/__faults')).json()).toEqual(snapshotOn);
  });

  it('a body without a chaos key (how replay --fault restores flags) leaves running chaos mid-sequence: no restart', async () => {
    const { server } = await fresh();
    const client = await loginNewClient(server);
    const chaos = { seed: 9, failSearch: 0.5 };
    await setFaults(client, { interstitial: false, chaos });
    const reference = await searchStatuses(client, 12);

    await setFaults(client, { chaos });
    const head = await searchStatuses(client, 4);
    const snapshot = (await (await client.get('/__faults')).json()) as Record<string, unknown>;
    await setFaults(client, { failSearch: true });
    const { chaos: _running, ...flagsOnly } = snapshot;
    expect(_running).toEqual(chaos);
    await setFaults(client, flagsOnly);

    expect((await report(client)).stats.failSearch).toEqual({ draws: 4, fired: reference.slice(0, 4).filter((s) => s === 500).length });
    expect([...head, ...(await searchStatuses(client, 8))]).toEqual(reference);
  });

  it('"chaos": null turns chaos off', async () => {
    const { server } = await fresh();
    const client = await loginNewClient(server);
    await setFaults(client, { interstitial: false, chaos: { seed: 1, failSearch: 1 } });
    expect(await searchStatuses(client, 1)).toEqual([500]);
    await setFaults(client, { chaos: null });
    expect(await searchStatuses(client, 3)).toEqual([200, 200, 200]);
    expect((await report(client)).config).toBeNull();
  });

  it('POST /__reset clears chaos, its counters and its log', async () => {
    const { server, app } = await fresh();
    const client = await loginNewClient(server);
    await setFaults(client, { chaos: { seed: 1, failSearch: 1 } });
    await searchStatuses(client, 2);
    expect((await postJson(client, '/__reset', {})).status).toBe(200);

    expect(((await (await client.get('/__faults')).json()) as Record<string, unknown>).chaos).toBeNull();
    expect(await report(client)).toEqual({ config: null, stats: {}, log: [], logDropped: 0 });
    expect(getContext(app).chaos).toBeNull();
    expect(await searchStatuses(client, 2)).toEqual([200, 200]);
  });

  it('re-posting a chaos config (even an identical one) restarts the sequence from the seed', async () => {
    const { server } = await fresh();
    const client = await loginNewClient(server);
    const chaos = { seed: 2024, failSearch: 0.5 };
    await setFaults(client, { interstitial: false, chaos });
    const first = await searchStatuses(client, 12);
    await setFaults(client, { chaos });
    expect((await report(client)).stats.failSearch).toEqual({ draws: 0, fired: 0 });
    expect(await searchStatuses(client, 12)).toEqual(first);
  });
});

describe('chaos: precedence of the explicit switches', () => {
  it('failSearch: true stays deterministic under chaos: every search fails and chaos never draws', async () => {
    const { server } = await fresh();
    const client = await loginNewClient(server);
    await setFaults(client, { failSearch: true, chaos: { seed: 1, failSearch: 0 } });
    expect(await searchStatuses(client, 5)).toEqual([500, 500, 500, 500, 500]);
    expect((await report(client)).stats.failSearch).toEqual({ draws: 0, fired: 0 });
  });

  it('slowMs > 0 is applied as-is and chaos slowMs never draws', async () => {
    const { server } = await fresh();
    const client = await loginNewClient(server);
    await setFaults(client, { slowMs: 1, chaos: { seed: 1, slowMs: { p: 1, minMs: 5000, maxMs: 5000 } } });
    const t0 = performance.now();
    await searchStatuses(client, 2);
    expect(performance.now() - t0).toBeLessThan(4000);
    expect((await report(client)).stats.slowMs).toEqual({ draws: 0, fired: 0 });
  });

  it('expireSession: true expires on the next request without a chaos draw, then chaos takes over', async () => {
    const { server } = await fresh();
    const client = await loginNewClient(server);
    await setFaults(client, { interstitial: false, expireSession: true, chaos: { seed: 1, expireSession: 0 } });
    const res = await client.get('/members/search');
    expect(res.headers.get('location')).toBe('/session-expired');
    expect((await report(client)).stats.expireSession).toEqual({ draws: 0, fired: 0 });

    const again = await loginNewClient(server);
    expect(await searchStatuses(again, 2)).toEqual([200, 200]);
    expect((await report(client)).stats.expireSession).toEqual({ draws: 2, fired: 0 });
  });

  it('the once-per-session interstitial shows without a draw; chaos draws only on the pages after it', async () => {
    const { server } = await fresh();
    const client = await loginNewClient(server);
    await setFaults(client, { chaos: { seed: 1, interstitial: 1 } });
    const first = await (await client.get('/members/search')).text();
    expect(first).toContain('System Maintenance Notice');
    expect((await report(client)).stats.interstitial).toEqual({ draws: 0, fired: 0 });

    const second = await (await client.get('/members/12345')).text();
    expect(second).toContain('System Maintenance Notice');
    expect((await report(client)).stats.interstitial).toEqual({ draws: 1, fired: 1 });
  });
});

describe('chaos: what each kind does', () => {
  it('failSearch returns the 500 Application Error page on the searches that drew it', async () => {
    const { server } = await fresh();
    const client = await loginNewClient(server);
    await setFaults(client, { interstitial: false, chaos: { seed: 1, failSearch: 1 } });
    const res = await client.get('/members/search?memberId=12345');
    expect(res.status).toBe(500);
    expect(await res.text()).toContain('ORA-01017');
    expect((await client.get('/members/12345')).status).toBe(200);
  });

  it('expireSession destroys the session and redirects to /session-expired, without touching the explicit flag', async () => {
    const { server } = await fresh();
    const client = await loginNewClient(server);
    await setFaults(client, { interstitial: false, chaos: { seed: 1, expireSession: 1 } });
    const res = await client.get('/members/12345');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/session-expired');
    expect(((await (await client.get('/__faults')).json()) as Record<string, unknown>).expireSession).toBe(false);
    const after = await client.get('/members/12345');
    expect(after.headers.get('location')).toBe('/login');
  });

  it('slowMs delays the requests that drew it by an amount in range', async () => {
    const { server } = await fresh();
    const client = await loginNewClient(server);
    await setFaults(client, { interstitial: false, chaos: { seed: 1, slowMs: { p: 1, minMs: 1200, maxMs: 1300 } } });
    const t0 = performance.now();
    await searchStatuses(client, 1);
    expect(performance.now() - t0).toBeGreaterThanOrEqual(1150);
    const r = await report(client);
    expect(r.log).toHaveLength(1);
    expect(r.log[0]!.delayMs).toBeGreaterThanOrEqual(1200);
    expect(r.log[0]!.delayMs).toBeLessThanOrEqual(1300);
  });

  it('a delayed request the client abandons is dropped: it never reaches the auth gate or the handler, so it draws nothing else', async () => {
    const { server } = await fresh();
    const client = await loginNewClient(server);
    await setFaults(client, { interstitial: false, chaos: { seed: 1, failSearch: 1, expireSession: 1, slowMs: { p: 1, minMs: 600, maxMs: 600 } } });
    const abort = new AbortController();
    const pending = client.get('/members/search?memberId=12345', { signal: abort.signal }).catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 100));
    abort.abort();
    await pending;
    await new Promise((r) => setTimeout(r, 900));
    const r = await report(client);
    expect(r.stats.slowMs).toEqual({ draws: 1, fired: 1 });
    expect(r.stats.expireSession).toEqual({ draws: 0, fired: 0 });
    expect(r.stats.failSearch).toEqual({ draws: 0, fired: 0 });
  });

  it('draws only on the member (transaction) routes: login, shell frames, static assets and /__ routes never draw', async () => {
    const { server } = await fresh();
    const client = createClient(server.baseUrl);
    await setFaults(client, {
      chaos: { seed: 1, failSearch: 1, interstitial: 1, expireSession: 1, slowMs: { p: 1, minMs: 0, maxMs: 0 } },
    });
    await (await client.get('/login')).text();
    const loggedIn = await loginNewClient(server);
    for (const p of ['/workstation', '/frames/banner', '/frames/nav', '/static/cu-agent.js', '/session-expired', '/__faults']) {
      await (await loggedIn.get(p)).text();
    }
    const r = await report(client);
    expect(r.stats).toEqual({
      failSearch: { draws: 0, fired: 0 },
      slowMs: { draws: 0, fired: 0 },
      interstitial: { draws: 0, fired: 0 },
      expireSession: { draws: 0, fired: 0 },
    });
  });
});

describe('chaos: observability', () => {
  it('the log records kind, method, path and draw index in injection order, and never the query string or the session cookie', async () => {
    const { server } = await fresh();
    const client = await loginNewClient(server);
    await setFaults(client, { interstitial: false, chaos: { seed: 1, failSearch: 1, interstitial: 1 } });
    await (await client.get('/members/search?memberId=12345&lastName=Sample')).text();
    await (await client.get('/members/12345?tab=accounts')).text();

    const res = await client.get('/__faults/chaos');
    const raw = await res.text();
    const r = JSON.parse(raw) as ChaosReport;
    expect(r.log).toEqual([
      { seq: 1, kind: 'failSearch', draw: 1, method: 'GET', path: '/members/search' },
      { seq: 2, kind: 'interstitial', draw: 1, method: 'GET', path: '/members/12345' },
    ]);
    const cookie = client.cookie(SESSION_COOKIE);
    expect(cookie).toBeDefined();
    expect(raw).not.toContain(cookie!);
    expect(raw).not.toContain('lastName');
    expect(raw).not.toContain('Sample');
    expect(raw).not.toContain('tab=');
  });
});

describe('chaos: reproducibility and isolation', () => {
  /** A mixed request sequence; returns what the client observed for each request. */
  async function observe(server: TestServer, seed: number): Promise<string[]> {
    let client = await loginNewClient(server);
    await setFaults(client, { interstitial: false, chaos: { seed, failSearch: 0.3, interstitial: 0.4, expireSession: 0.1 } });
    const seen: string[] = [];
    for (let i = 0; i < 30; i += 1) {
      const path = i % 2 === 0 ? '/members/search?memberId=12345' : '/members/12345';
      const res = await client.get(path);
      const body = await res.text();
      if (res.status === 302) {
        seen.push(`302 ${res.headers.get('location') ?? ''}`);
        // Expired: log in again and keep going.
        client = await loginNewClient(server);
      } else {
        seen.push(`${res.status}${body.includes('System Maintenance Notice') ? ' +notice' : ''}`);
      }
    }
    return seen;
  }

  it('the same seed and request sequence produce the same faults on two separate app instances', async () => {
    const a1 = (await fresh()).server;
    const a2 = (await fresh()).server;
    const first = await observe(a1, 77);
    const second = await observe(a2, 77);
    expect(second).toEqual(first);
    // The sequence actually exercised more than one kind of fault.
    expect(first.some((s) => s.startsWith('500'))).toBe(true);
    expect(first.some((s) => s.includes('+notice'))).toBe(true);
    expect(first.some((s) => s.startsWith('302'))).toBe(true);
    expect(await report(a2.client)).toEqual(await report(a1.client));
  });

  it('a different seed produces a different sequence', async () => {
    const a1 = (await fresh()).server;
    const a2 = (await fresh()).server;
    expect(await observe(a2, 78)).not.toEqual(await observe(a1, 77));
  });

  it('two instances in one process (tenant A and B) have fully independent chaos', async () => {
    const { server: a, app: appA } = await fresh('a');
    const { server: b, app: appB } = await fresh('b');
    const ca = await loginNewClient(a);
    const cb = await loginNewClient(b);
    await setFaults(ca, { interstitial: false, chaos: { seed: 5, failSearch: 0.5 } });
    await setFaults(cb, { interstitial: false });

    // B has no chaos at all while A's is running.
    expect(await searchStatuses(cb, 10)).toEqual(new Array(10).fill(200));
    const aStatuses = await searchStatuses(ca, 10);
    expect(aStatuses).toContain(500);
    expect((await report(cb)).config).toBeNull();
    expect(getContext(appB).chaos).toBeNull();

    // Same seed on B, interleaved with more draws on A: B's sequence is A's first ten, unshifted.
    await setFaults(ca, { chaos: { seed: 5, failSearch: 0.5 } });
    await setFaults(cb, { chaos: { seed: 5, failSearch: 0.5 } });
    const interleavedA: number[] = [];
    const interleavedB: number[] = [];
    for (let i = 0; i < 10; i += 1) {
      interleavedA.push(...(await searchStatuses(ca, 2)));
      interleavedB.push(...(await searchStatuses(cb, 1)));
    }
    expect(interleavedB).toEqual(aStatuses);
    expect(interleavedA.slice(0, 10)).toEqual(aStatuses);
    expect(getContext(appA).chaos).not.toBe(getContext(appB).chaos);
  });
});

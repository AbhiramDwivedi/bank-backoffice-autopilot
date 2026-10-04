import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { escalateSample, makeBrokerFixture, type BrokerFixture } from '../../test/support/fixtures.js';
import { startRelayServer, type RelayServerHandle } from './start.js';

function makeStaticDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'relay-start-static-'));
  writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><body><!--RELAY_BOOTSTRAP--></body></html>');
  mkdirSync(path.join(dir, 'assets'));
  return dir;
}

const fixtures: BrokerFixture[] = [];
const handles: RelayServerHandle[] = [];
const staticDirs: string[] = [];

function fixture(): BrokerFixture {
  const f = makeBrokerFixture();
  fixtures.push(f);
  return f;
}

afterEach(async () => {
  for (const h of handles.splice(0)) await h.close();
  for (const f of fixtures.splice(0)) f.dispose();
  for (const d of staticDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('startRelayServer', () => {
  it('starts on an ephemeral port (0) and serves the API', async () => {
    const { broker } = fixture();
    const staticDir = makeStaticDir();
    staticDirs.push(staticDir);
    const handle = await startRelayServer({ port: 0, brokers: [broker], staticDir });
    handles.push(handle);

    expect(handle.port).toBeGreaterThan(0);
    expect(handle.url).toBe(`http://127.0.0.1:${handle.port}`);

    const res = await fetch(`${handle.url}/api/runs`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runs: Array<{ runId: string }> };
    expect(body.runs[0]?.runId).toBe(broker.runId);
  });

  it('rejects a non-loopback host', async () => {
    await expect(startRelayServer({ port: 0, host: '0.0.0.0' })).rejects.toThrow(/loopback/);
    await expect(startRelayServer({ port: 0, host: 'evil.example' })).rejects.toThrow(/loopback/);
  });

  it('accepts every documented loopback host name', async () => {
    const staticDir = makeStaticDir();
    staticDirs.push(staticDir);
    for (const host of ['127.0.0.1', 'localhost']) {
      const handle = await startRelayServer({ port: 0, host, staticDir });
      handles.push(handle);
      expect(handle.url.startsWith('http://')).toBe(true);
    }
  });

  it('register()/unregister() reach the underlying registry', async () => {
    const { broker } = fixture();
    const staticDir = makeStaticDir();
    staticDirs.push(staticDir);
    const handle = await startRelayServer({ port: 0, staticDir });
    handles.push(handle);

    async function listedRuns(): Promise<Array<{ runId: string }>> {
      const body = (await (await fetch(`${handle.url}/api/runs`)).json()) as { runs: Array<{ runId: string }> };
      return body.runs;
    }

    expect(await listedRuns()).toHaveLength(0);

    handle.register(broker);
    const afterRegister = await listedRuns();
    expect(afterRegister).toHaveLength(1);
    expect(afterRegister[0]?.runId).toBe(broker.runId);

    handle.unregister(broker.runId);
    expect(await listedRuns()).toHaveLength(0);
  });

  it('close() ends an open SSE stream, is idempotent, and resolves promptly', async () => {
    const { broker } = fixture();
    const staticDir = makeStaticDir();
    staticDirs.push(staticDir);
    const handle = await startRelayServer({ port: 0, brokers: [broker], staticDir });

    // Resolves once the stream's response headers arrive (the server has registered the client),
    // and `ended` once the server closes it; a socket error rejects instead of hanging the test.
    let resolveEnded!: () => void;
    const ended = new Promise<void>((resolve) => {
      resolveEnded = resolve;
    });
    const connected = new Promise<void>((resolve, reject) => {
      const client = http.request(`${handle.url}/api/events`, (res) => {
        res.on('end', resolveEnded);
        res.on('close', resolveEnded);
        res.on('data', () => {});
        resolve();
      });
      client.on('error', reject);
      client.end();
    });
    await connected;

    const start = Date.now();
    await handle.close();
    expect(Date.now() - start).toBeLessThan(2000);
    await handle.close(); // idempotent
    await ended;
  });

  it('leaseMs is threaded through to the adapter (reflected in an intervention\'s lease)', async () => {
    const { broker } = fixture();
    const staticDir = makeStaticDir();
    staticDirs.push(staticDir);
    const handle = await startRelayServer({ port: 0, brokers: [broker], staticDir, leaseMs: 42_000 });
    handles.push(handle);

    const { id } = await escalateSample(broker);
    await fetch(`${handle.url}/api/interventions/${id}/take`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ by: 'alice' }),
    });
    const dto = (await (await fetch(`${handle.url}/api/interventions/${id}`)).json()) as { lease?: { ms: number } };
    expect(dto.lease?.ms).toBe(42_000);

    await fetch(`${handle.url}/api/interventions/${id}/abort`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ by: 'alice' }),
    });
  });

  it('a listen failure (EADDRINUSE) rejects and releases every broker subscription it took', async () => {
    const { broker } = fixture();
    let subscribed = 0;
    const subscribe = broker.interventions.subscribe.bind(broker.interventions);
    broker.interventions.subscribe = (cb) => {
      subscribed += 1;
      const off = subscribe(cb);
      return () => {
        subscribed -= 1;
        off();
      };
    };

    const blocker = net.createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen(4421, '127.0.0.1', () => resolve());
    });
    try {
      const staticDir = makeStaticDir();
      staticDirs.push(staticDir);
      await expect(startRelayServer({ port: 4421, brokers: [broker], staticDir })).rejects.toMatchObject({ code: 'EADDRINUSE' });
      expect(subscribed).toBe(0);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it("register(broker, { redact }): the run's redactor reaches the API and the inlined bootstrap", async () => {
    const { broker } = fixture();
    const staticDir = makeStaticDir();
    staticDirs.push(staticDir);
    const handle = await startRelayServer({ port: 0, staticDir });
    handles.push(handle);
    handle.register(broker, { redact: (v) => JSON.parse(JSON.stringify(v).replace(/MBR-[0-9]{4}/g, '[REDACTED:member]')) as unknown });

    const { id } = await escalateSample(broker, { reason: { code: 'unrecoverable_condition', message: 'member MBR-1234 is locked' } });
    for (const p of [`/api/interventions/${id}`, '/api/interventions', '/']) {
      const text = await (await fetch(`${handle.url}${p}`)).text();
      expect(text, p).toContain('[REDACTED:member]');
      expect(text, p).not.toContain('MBR-1234');
    }
    await broker.abort(id, 'alice');
  });
});

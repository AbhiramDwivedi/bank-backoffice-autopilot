import { createServer, type Server } from 'node:http';
import http from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { escalateSample, makeBrokerFixture, sampleAction, type BrokerFixture } from '../../test/support/fixtures.js';
import { createRelayApp, type RelayApp, type RelayAppOptions } from './app.js';
import { fromSessionBroker, type RelaySessionRegistry } from './broker-adapter.js';
import { createRedactor } from './core.js';
import { PortNotFoundError, type RelayBrokerPort } from './ports.js';
import type { InterventionDto, RunDto } from '../shared/api.js';

function jsonBody(body: unknown): { method: 'POST'; headers: { 'Content-Type': string }; body: string } {
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function makeStaticDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'relay-static-'));
  writeFileSync(
    path.join(dir, 'index.html'),
    '<!doctype html>\n<html><head><title>Relay</title></head><body><div id="app"></div><!--RELAY_BOOTSTRAP--></body></html>\n',
  );
  mkdirSync(path.join(dir, 'assets'));
  writeFileSync(path.join(dir, 'assets', 'app.js'), 'console.log("relay ui");\n');
  return dir;
}

/** A hand-rolled `RelayBrokerPort` fake for scenarios a real broker cannot easily produce
 *  on demand (an arbitrary internal failure, a capture that always fails). Every method not
 *  overridden throws, so a test only wires up what it actually exercises. */
function makeFakePort(overrides: Partial<RelayBrokerPort> = {}): RelayBrokerPort {
  const notImplemented = (name: string) => () => {
    throw new Error(`fake port: ${name} not implemented for this test`);
  };
  return {
    runs: overrides.runs ?? (() => []),
    controlToken: overrides.controlToken ?? (() => undefined),
    listInterventions: overrides.listInterventions ?? (() => []),
    getIntervention: overrides.getIntervention ?? (() => undefined),
    take: overrides.take ?? notImplemented('take'),
    handBack: overrides.handBack ?? notImplemented('handBack'),
    abort: overrides.abort ?? notImplemented('abort'),
    heartbeat: overrides.heartbeat ?? notImplemented('heartbeat'),
    subscribe: overrides.subscribe ?? (() => () => {}),
    escalationScreenshot: overrides.escalationScreenshot ?? (async () => undefined),
    liveScreenshot: overrides.liveScreenshot ?? (async () => { throw new PortNotFoundError('run', 'unused'); }),
  };
}

interface Harness {
  relayApp: RelayApp;
  server: Server;
  url: string;
  staticDir: string;
  close(): Promise<void>;
}

async function startAppWithPort(
  port: RelayBrokerPort,
  opts: Partial<Omit<RelayAppOptions, 'port' | 'staticDir'>> = {},
): Promise<Harness> {
  const staticDir = makeStaticDir();
  const relayApp = createRelayApp({
    port,
    redact: opts.redact ?? createRedactor(),
    staticDir,
    liveScreenshotMinIntervalMs: opts.liveScreenshotMinIntervalMs ?? 50,
    keepAliveMs: opts.keepAliveMs ?? 60_000,
    ...(opts.authenticate !== undefined ? { authenticate: opts.authenticate } : {}),
  });
  const server = createServer(relayApp.app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const listenPort = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    relayApp,
    server,
    url: `http://127.0.0.1:${listenPort}`,
    staticDir,
    async close(): Promise<void> {
      await relayApp.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(staticDir, { recursive: true, force: true });
    },
  };
}

interface BrokerHarness extends Harness {
  registry: RelaySessionRegistry;
}

async function startApp(
  broker: BrokerFixture['broker'],
  opts: Partial<Omit<RelayAppOptions, 'port' | 'staticDir'>> = {},
): Promise<BrokerHarness> {
  const registry = fromSessionBroker(broker, { leaseMs: 60_000 });
  const h = await startAppWithPort(registry, opts);
  const originalClose = h.close.bind(h);
  return {
    ...h,
    registry,
    close: async (): Promise<void> => {
      await originalClose();
      registry.dispose();
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


describe('createRelayApp: routes', () => {
  it('GET / injects the bootstrap and sets Cache-Control: no-store', async () => {
    const { broker } = fixture();
    const h = await startApp(broker);
    harnesses.push(h);

    const res = await fetch(h.url);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const text = await res.text();
    expect(text).toContain('<script id="relay-bootstrap" type="application/json">');
    const match = /<script id="relay-bootstrap" type="application\/json">(.*?)<\/script>/s.exec(text);
    const boot = JSON.parse(match![1] as string) as { runs: RunDto[]; interventions: InterventionDto[]; lastEventId: string; serverTime: string };
    expect(boot.runs).toHaveLength(1);
    expect(boot.interventions).toEqual([]);
    expect(typeof boot.lastEventId).toBe('string');
    expect(typeof boot.serverTime).toBe('string');
  });

  it('GET / returns 503 unavailable when the UI is not built', async () => {
    const { broker } = fixture();
    const h = await startApp(broker);
    harnesses.push(h);
    rmSync(path.join(h.staticDir, 'index.html'));

    const res = await fetch(h.url);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('unavailable');
    expect(body.error.message).toContain('npm --prefix apps/relay run build');
  });

  it('escapes a </script> payload in the bootstrap so a reason can never break out of the data island', async () => {
    const { broker } = fixture();
    const h = await startApp(broker);
    harnesses.push(h);
    const payload = '</script><script>alert(1)</script>';
    const { id } = await escalateSample(broker, { reason: { code: 'stuck', message: payload } });

    const text = await (await fetch(h.url)).text();
    expect(text).not.toContain('<script>alert(1)</script>');
    expect(text).toContain('\\u003c/script\\u003e\\u003cscript\\u003ealert(1)\\u003c/script\\u003e');

    await h.registry.abort(id, 'alice');
  });

  it('GET /assets/app.js is served with Cache-Control: no-cache; an unknown asset is 404 JSON', async () => {
    const { broker } = fixture();
    const h = await startApp(broker);
    harnesses.push(h);

    const res = await fetch(`${h.url}/assets/app.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(await res.text()).toContain('relay ui');

    const missing = await fetch(`${h.url}/assets/does-not-exist.js`);
    expect(missing.status).toBe(404);
    expect(missing.headers.get('content-type')).toContain('application/json');
  });

  it('GET /api/runs lists the registered run', async () => {
    const { broker } = fixture();
    const h = await startApp(broker);
    harnesses.push(h);
    const res = await fetch(`${h.url}/api/runs`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runs: RunDto[] };
    expect(body.runs).toEqual([expect.objectContaining({ runId: broker.runId, state: 'automation', holder: 'automation' })]);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('GET /api/interventions supports the status filter and rejects a bad one with 400', async () => {
    const { broker } = fixture();
    const h = await startApp(broker);
    harnesses.push(h);
    const { id } = await escalateSample(broker);

    const open = (await (await fetch(`${h.url}/api/interventions?status=open`)).json()) as { interventions: InterventionDto[]; lastEventId: string };
    expect(open.interventions.map((i) => i.id)).toEqual([id]);
    expect(typeof open.lastEventId).toBe('string');

    const resolved = (await (await fetch(`${h.url}/api/interventions?status=resolved`)).json()) as { interventions: InterventionDto[] };
    expect(resolved.interventions).toEqual([]);

    const bad = await fetch(`${h.url}/api/interventions?status=bogus`);
    expect(bad.status).toBe(400);
    const badBody = (await bad.json()) as { error: { code: string } };
    expect(badBody.error.code).toBe('bad_request');

    await h.registry.abort(id, 'alice');
  });

  it('GET /api/interventions/:id : 200 for a known id, 404 JSON for an unknown one', async () => {
    const { broker } = fixture();
    const h = await startApp(broker);
    harnesses.push(h);
    const { id } = await escalateSample(broker);

    const ok = await fetch(`${h.url}/api/interventions/${id}`);
    expect(ok.status).toBe(200);
    const dto = (await ok.json()) as InterventionDto;
    expect(dto.id).toBe(id);

    const notFound = await fetch(`${h.url}/api/interventions/does-not-exist`);
    expect(notFound.status).toBe(404);
    const body = (await notFound.json()) as { error: { code: string } };
    expect(body.error.code).toBe('not_found');

    await h.registry.abort(id, 'alice');
  });

  it('GET /api/interventions/:id/screenshot serves the PNG; 404 when there is none', async () => {
    const { broker } = fixture();
    const h = await startApp(broker);
    harnesses.push(h);
    const { id } = await escalateSample(broker);

    const res = await fetch(`${h.url}/api/interventions/${id}/screenshot`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('image/png');
    expect(res.headers.get('cache-control')).toBe('private, max-age=3600');
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

    const missing = await fetch(`${h.url}/api/interventions/does-not-exist/screenshot`);
    expect(missing.status).toBe(404);

    await h.registry.abort(id, 'alice');
  });

  it('GET /api/runs/:runId/screenshot serves a live PNG (no-store) and 404s for an unknown run', async () => {
    const { broker } = fixture();
    const h = await startApp(broker);
    harnesses.push(h);

    const res = await fetch(`${h.url}/api/runs/${broker.runId}/screenshot`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('image/png');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-relay-captured-at')).toBeTruthy();

    const missing = await fetch(`${h.url}/api/runs/does-not-exist/screenshot`);
    expect(missing.status).toBe(404);
  });

  it('take -> capture -> handback -> resumed, end to end over HTTP', async () => {
    const { broker, capture } = fixture();
    const h = await startApp(broker);
    harnesses.push(h);
    const resolutionPromise = escalateSample(broker).then((r) => r);
    const { id } = await resolutionPromise;

    const takeRes = await fetch(`${h.url}/api/interventions/${id}/take`, jsonBody({ by: 'alice' }));
    expect(takeRes.status).toBe(200);
    const takeBody = (await takeRes.json()) as InterventionDto;
    expect(takeBody.status).toBe('human_active');
    expect(takeBody.heldBy).toBe('alice');
    expect(takeBody.lease).toBeDefined();

    capture.emit(sampleAction());
    capture.emit(sampleAction({ type: 'input', target: { role: 'textbox', name: 'Member ID' } }));

    const getBody = (await (await fetch(`${h.url}/api/interventions/${id}`)).json()) as InterventionDto;
    expect(getBody.humanActions).toHaveLength(2);
    expect(getBody.humanActions[1]?.valueRedacted).toBe(true);

    const hbRes = await fetch(`${h.url}/api/interventions/${id}/heartbeat`, jsonBody({ by: 'alice' }));
    expect(hbRes.status).toBe(200);
    const hbBody = (await hbRes.json()) as { interventionId: string; at: string; lease: { anchorAt: string } };
    expect(hbBody.interventionId).toBe(id);
    expect(hbBody.lease.anchorAt).toBe(hbBody.at);

    const handbackRes = await fetch(`${h.url}/api/interventions/${id}/handback`, jsonBody({ by: 'alice', resumeFrom: 'next_step', notes: 'done' }));
    expect(handbackRes.status).toBe(200);
    const handbackBody = (await handbackRes.json()) as { resumeFrom: string; humanActions: unknown[] };
    expect(handbackBody.resumeFrom).toBe('next_step');
    expect(handbackBody.humanActions).toHaveLength(2);

    broker.resumed(id);
    const runsBody = (await (await fetch(`${h.url}/api/runs`)).json()) as { runs: RunDto[] };
    expect(runsBody.runs[0]?.state).toBe('automation');
  });

  it('aborts via the API and resolves escalate() with resumeFrom "abort"', async () => {
    const { broker } = fixture();
    const h = await startApp(broker);
    harnesses.push(h);
    const { id, resolution } = await escalateSample(broker);

    const res = await fetch(`${h.url}/api/interventions/${id}/abort`, jsonBody({ by: 'carol', notes: 'giving up' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resumeFrom: string };
    expect(body.resumeFrom).toBe('abort');
    const awaited = await resolution;
    expect(awaited.resumeFrom).toBe('abort');
  });

  it('409 with `state` when handing back an intervention that is still paused (never taken)', async () => {
    const { broker } = fixture();
    const h = await startApp(broker);
    harnesses.push(h);
    const { id } = await escalateSample(broker);

    const res = await fetch(`${h.url}/api/interventions/${id}/handback`, jsonBody({ by: 'alice', resumeFrom: 'current_step' }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; state?: string } };
    expect(body.error.code).toBe('conflict');
    expect(body.error.state).toBeTruthy();

    await h.registry.abort(id, 'alice');
  });

  it('validates POST bodies with zod: missing `by` and a bad `resumeFrom` are 400', async () => {
    const { broker } = fixture();
    const h = await startApp(broker);
    harnesses.push(h);
    const { id } = await escalateSample(broker);

    const missingBy = await fetch(`${h.url}/api/interventions/${id}/take`, jsonBody({}));
    expect(missingBy.status).toBe(400);

    await fetch(`${h.url}/api/interventions/${id}/take`, jsonBody({ by: 'alice' }));
    const badResumeFrom = await fetch(`${h.url}/api/interventions/${id}/handback`, jsonBody({ by: 'alice', resumeFrom: 'bogus' }));
    expect(badResumeFrom.status).toBe(400);

    await h.registry.abort(id, 'alice');
  });

  it('resumeAtStepId (API only): validated, passed to the run with current_step, and echoed in the resolution', async () => {
    const { broker } = fixture();
    const h = await startApp(broker);
    harnesses.push(h);
    const { id, resolution } = await escalateSample(broker);
    await fetch(`${h.url}/api/interventions/${id}/take`, jsonBody({ by: 'alice' }));

    for (const bad of [
      { by: 'alice', resumeFrom: 'next_step', resumeAtStepId: 's05' }, // only with current_step
      { by: 'alice', resumeFrom: 'current_step', resumeAtStepId: '' },
      { by: 'alice', resumeFrom: 'current_step', resumeAtStepId: 's05; drop' },
      { by: 'alice', resumeFrom: 'current_step', resumeAtStepId: 'x'.repeat(101) },
    ]) {
      const res = await fetch(`${h.url}/api/interventions/${id}/handback`, jsonBody(bad));
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    expect(broker.token.state).toBe('human');

    const ok = await fetch(`${h.url}/api/interventions/${id}/handback`, jsonBody({ by: 'alice', resumeFrom: 'current_step', resumeAtStepId: 's05' }));
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { resumeAtStepId?: string }).resumeAtStepId).toBe('s05');
    expect((await resolution).resumeAtStepId).toBe('s05');
    const dto = (await (await fetch(`${h.url}/api/interventions/${id}`)).json()) as { resolution?: { resumeAtStepId?: string } };
    expect(dto.resolution?.resumeAtStepId).toBe('s05');
    broker.resumed(id);
  });

  it('the identity seam: authenticate setting res.locals.operator overrides the body\'s `by`', async () => {
    const { broker } = fixture();
    const h = await startApp(broker, {
      authenticate: (_req, res, next) => {
        res.locals.operator = 'authenticated-operator';
        next();
      },
    });
    harnesses.push(h);
    const { id } = await escalateSample(broker);

    const res = await fetch(`${h.url}/api/interventions/${id}/take`, jsonBody({ by: 'someone-else' }));
    const body = (await res.json()) as InterventionDto;
    expect(body.heldBy).toBe('authenticated-operator');

    await h.registry.abort(id, 'authenticated-operator');
  });

  it('authenticate also guards GET / (the page inlines every intervention): a refusal serves no bootstrap', async () => {
    const { broker } = fixture();
    const h = await startApp(broker, {
      authenticate: (req, res, next) => {
        if (req.headers.authorization === 'Bearer ok') {
          next();
          return;
        }
        res.status(401).json({ error: { code: 'unauthorized', message: 'sign in' } });
      },
    });
    harnesses.push(h);
    const { id } = await escalateSample(broker);

    const refused = await fetch(`${h.url}/`);
    expect(refused.status).toBe(401);
    const refusedText = await refused.text();
    expect(refusedText).not.toContain(id);
    expect(refusedText).not.toContain('relay-bootstrap');

    const allowed = await fetch(`${h.url}/`, { headers: { Authorization: 'Bearer ok' } });
    expect(allowed.status).toBe(200);
    expect(await allowed.text()).toContain(id);

    await h.registry.abort(id, 'alice');
  });

  it('unknown routes are 404 JSON', async () => {
    const { broker } = fixture();
    const h = await startApp(broker);
    harnesses.push(h);
    const res = await fetch(`${h.url}/nope`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('security headers are present on every response', async () => {
    const { broker } = fixture();
    const h = await startApp(broker);
    harnesses.push(h);
    const res = await fetch(`${h.url}/api/runs`);
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(res.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(res.headers.get('x-powered-by')).toBeNull();
  });

  it('an unexpected error is 500 {code:"internal"}, its message redacted, and never a stack trace', async () => {
    const CARD = '4111111111111111';
    const port = makeFakePort({
      getIntervention: () => {
        throw new Error(`unexpected failure while looking up card ${CARD}`);
      },
    });
    const h = await startAppWithPort(port);
    harnesses.push(h);

    const res = await fetch(`${h.url}/api/interventions/anything`);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('internal');
    expect(body.error.message).not.toContain(CARD);
    expect(body.error.message).toContain('[REDACTED:card]');
    const text = JSON.stringify(body);
    expect(text).not.toContain('.ts:');
    expect(text).not.toMatch(/\bat \S+ \(/);
    expect(text).not.toContain('stack');
  });

  it('a live-screenshot capture failure is 503 {code:"unavailable"} with a redacted message, distinct from an unknown run', async () => {
    const CARD = '4111111111111111';
    const port = makeFakePort({
      liveScreenshot: async (runId) => {
        if (runId === 'unknown-run') throw new PortNotFoundError('run', runId);
        throw new Error(`capture failed: card ${CARD} on screen`);
      },
    });
    const h = await startAppWithPort(port);
    harnesses.push(h);

    const failed = await fetch(`${h.url}/api/runs/known-run/screenshot`);
    expect(failed.status).toBe(503);
    const failedBody = (await failed.json()) as { error: { code: string; message: string } };
    expect(failedBody.error.code).toBe('unavailable');
    expect(failedBody.error.message).not.toContain(CARD);

    const unknown = await fetch(`${h.url}/api/runs/unknown-run/screenshot`);
    expect(unknown.status).toBe(404);
  });
});

describe('createRelayApp: SSE integration', () => {
  it('a connected client sees intervention (created, WITH context), control (on take), heartbeat and actions events', async () => {
    const { broker, capture } = fixture();
    const h = await startApp(broker);
    harnesses.push(h);

    const chunks: string[] = [];
    const client = http.request(`${h.url}/api/events`, (res) => {
      res.setEncoding('utf8');
      res.on('data', (c: string) => chunks.push(c));
    });
    client.end();

    async function waitFor(predicate: (buf: string) => boolean, timeoutMs = 3000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (!predicate(chunks.join(''))) {
        if (Date.now() > deadline) throw new Error(`timed out; buffer:\n${chunks.join('')}`);
        await new Promise((r) => setTimeout(r, 10));
      }
    }
    await waitFor((b) => b.includes('retry:'));

    const { id } = await escalateSample(broker);
    await waitFor((b) => b.includes('event: intervention'));
    const createdChunk = chunks.join('');
    expect(createdChunk).toContain('"change":"created"');
    expect(createdChunk).toContain('"context":{');
    expect(createdChunk).toContain('"observed"');

    chunks.length = 0;
    await fetch(`${h.url}/api/interventions/${id}/take`, jsonBody({ by: 'alice' }));
    await waitFor((b) => b.includes('event: control'));
    expect(chunks.join('')).toContain('"to":"human"');

    chunks.length = 0;
    await fetch(`${h.url}/api/interventions/${id}/heartbeat`, jsonBody({ by: 'alice' }));
    await waitFor((b) => b.includes('event: heartbeat'));

    chunks.length = 0;
    capture.emit(sampleAction());
    await waitFor((b) => b.includes('"change":"actions"'), 3000);

    client.destroy();
    await h.registry.handBack(id, { by: 'alice', resumeFrom: 'current_step' });
    broker.resumed(id);
  });

  it('a client reconnecting with Last-Event-ID replays events it missed', async () => {
    const { broker } = fixture();
    const h = await startApp(broker);
    harnesses.push(h);

    const first: string[] = [];
    const firstClient = http.request(`${h.url}/api/events`, (res) => {
      res.setEncoding('utf8');
      res.on('data', (c: string) => first.push(c));
    });
    firstClient.end();
    async function waitFor(buf: () => string, predicate: (b: string) => boolean, timeoutMs = 2000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (!predicate(buf())) {
        if (Date.now() > deadline) throw new Error(`timed out; buffer:\n${buf()}`);
        await new Promise((r) => setTimeout(r, 10));
      }
    }
    await waitFor(() => first.join(''), (b) => b.includes('retry:'));

    const { id } = await escalateSample(broker);
    await waitFor(() => first.join(''), (b) => b.includes('event: intervention'));
    firstClient.destroy();

    const match = /^id: (\S+)$/m.exec(first.join(''));
    const lastEventId = match?.[1];
    expect(lastEventId).toBeTruthy();

    await fetch(`${h.url}/api/interventions/${id}/take`, jsonBody({ by: 'alice' }));

    const second: string[] = [];
    const secondClient = http.request(`${h.url}/api/events`, { headers: { 'Last-Event-ID': lastEventId as string } }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (c: string) => second.push(c));
    });
    secondClient.end();
    await waitFor(() => second.join(''), (b) => b.includes('event: control'));
    secondClient.destroy();

    await h.registry.handBack(id, { by: 'alice', resumeFrom: 'current_step' });
    broker.resumed(id);
  });

  it('close() ends open SSE streams and resolves', async () => {
    const { broker } = fixture();
    const h = await startApp(broker);
    // don't push h to harnesses: this test closes it itself

    let ended = false;
    const client = http.request(`${h.url}/api/events`, (res) => {
      res.on('end', () => {
        ended = true;
      });
      res.on('data', () => {});
    });
    client.end();
    await new Promise((r) => setTimeout(r, 100));

    await h.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(ended).toBe(true);
  });
});

describe('createRelayApp: redaction', () => {
  it('redacts an SSN-shaped context value in REST, bootstrap and SSE alike', async () => {
    const { broker } = fixture();
    const h = await startApp(broker);
    harnesses.push(h);

    const chunks: string[] = [];
    const client = http.request(`${h.url}/api/events`, (res) => {
      res.setEncoding('utf8');
      res.on('data', (c: string) => chunks.push(c));
    });
    client.end();
    async function waitFor(predicate: (buf: string) => boolean, timeoutMs = 2000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (!predicate(chunks.join(''))) {
        if (Date.now() > deadline) throw new Error(`timed out; buffer:\n${chunks.join('')}`);
        await new Promise((r) => setTimeout(r, 10));
      }
    }
    await waitFor((b) => b.includes('retry:'));

    const SSN = '123-45-6789';
    const CARD = '4111111111111111';
    const { id } = await escalateSample(broker, {
      context: { observed: `Account holder SSN on file: ${SSN}`, code: `card on file ${CARD}` },
    });
    await waitFor((b) => b.includes('event: intervention'));

    const sseText = chunks.join('');
    expect(sseText).not.toContain(SSN);
    expect(sseText).not.toContain(CARD);
    expect(sseText).toContain('[REDACTED:ssn]');
    expect(sseText).toContain('[REDACTED:card]');

    const getBody = await (await fetch(`${h.url}/api/interventions/${id}`)).text();
    expect(getBody).not.toContain(SSN);
    expect(getBody).not.toContain(CARD);
    expect(getBody).toContain('[REDACTED:ssn]');

    const listBody = await (await fetch(`${h.url}/api/interventions`)).text();
    expect(listBody).not.toContain(SSN);

    const bootText = await (await fetch(h.url)).text();
    expect(bootText).not.toContain(SSN);
    expect(bootText).not.toContain(CARD);

    client.destroy();
    await h.registry.abort(id, 'alice');
  });
});

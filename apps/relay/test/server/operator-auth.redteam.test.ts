/**
 * Red-team: operator authentication covers EVERY Relay route, end to end through a real
 * `startRelayServer` (real HTTP, real `SessionBroker` on a `FakeSurface`).
 *
 * The finding this pins: `createRelayApp` used to mount `authenticate` per route (on `GET /` and on
 * the `/api` router), so the static bundle (`/assets`) and the 404 fallback escaped it, and
 * `startRelayServer` (hence the CLI's `startRelayConsole`) had no way to pass the hook at all. Now
 * the hook is mounted app-wide after the Host/Origin guards and `startRelayServer({authenticate})`
 * forwards it. An unauthenticated caller gets the same refusal on every path, including the SSE
 * stream and every mutating POST, and the refusal carries no run or intervention data.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { RequestHandler } from 'express';
import { escalateSample, makeBrokerFixture, type BrokerFixture } from '../support/fixtures.js';
import type { RelayServerHandle } from '../../src/server/index.js';
import { jsonBody, startRealRelayServer } from './redteam-helpers.js';

const AUTH = { Authorization: 'Bearer ok' };

/** Lets a request through only with `Authorization: Bearer ok`; names the operator when it does. */
const authenticate: RequestHandler = (req, res, next) => {
  if (req.headers.authorization === 'Bearer ok') {
    res.locals.operator = 'authenticated-operator';
    next();
    return;
  }
  res.status(401).json({ error: { code: 'unauthorized', message: 'sign in' } });
};

const fixtures: BrokerFixture[] = [];
const servers: RelayServerHandle[] = [];

afterEach(async () => {
  for (const h of servers.splice(0)) await h.close();
  for (const f of fixtures.splice(0)) f.dispose();
});

async function setup(): Promise<{ f: BrokerFixture; h: RelayServerHandle; id: string }> {
  const f = makeBrokerFixture();
  fixtures.push(f);
  const h = await startRealRelayServer([f.broker], { authenticate });
  servers.push(h);
  const { id } = await escalateSample(f.broker);
  return { f, h, id };
}

/** GET routes, with the run/intervention ids filled in. */
function readRoutes(runId: string, id: string): string[] {
  return [
    '/',
    '/assets/app.js',
    '/api/runs',
    `/api/runs/${runId}/screenshot`,
    '/api/interventions',
    '/api/interventions?status=open',
    `/api/interventions/${id}`,
    `/api/interventions/${id}/screenshot`,
    '/no-such-route',
  ];
}

describe('operator authentication gates every Relay route (startRelayServer({authenticate}))', () => {
  it('refuses every GET route without credentials, and the refusal carries no run or intervention data', async () => {
    const { f, h, id } = await setup();
    for (const route of readRoutes(f.broker.runId, id)) {
      const res = await fetch(`${h.url}${route}`);
      const text = await res.text();
      expect(res.status, route).toBe(401);
      expect(text, route).not.toContain(id);
      expect(text, route).not.toContain(f.broker.runId);
      expect(text, route).not.toContain('console.log');
      expect(text, route).not.toContain('relay-bootstrap');
    }
  });

  it('refuses the SSE stream without credentials: a 401, never an event stream', async () => {
    const { f, h, id } = await setup();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    try {
      const res = await fetch(`${h.url}/api/events`, { signal: controller.signal });
      expect(res.status).toBe(401);
      expect(res.headers.get('content-type') ?? '').not.toContain('text/event-stream');
      const text = await res.text();
      expect(text).not.toContain(id);
      expect(text).not.toContain(f.broker.runId);
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  });

  it('refuses every mutating POST without credentials and leaves the intervention untouched', async () => {
    const { h, id } = await setup();
    const posts: [string, unknown][] = [
      [`/api/interventions/${id}/take`, { by: 'mallory' }],
      [`/api/interventions/${id}/heartbeat`, { by: 'mallory' }],
      [`/api/interventions/${id}/handback`, { by: 'mallory', resumeFrom: 'next_step' }],
      [`/api/interventions/${id}/abort`, { by: 'mallory' }],
    ];
    for (const [route, body] of posts) {
      const res = await fetch(`${h.url}${route}`, jsonBody(body));
      expect(res.status, route).toBe(401);
      expect(await res.text(), route).not.toContain(id);
    }
    const after = await fetch(`${h.url}/api/interventions/${id}`, { headers: AUTH });
    expect(after.status).toBe(200);
    const dto = (await after.json()) as { status: string; heldBy?: string };
    expect(dto.status).toBe('open');
    expect(dto.heldBy).toBeUndefined();
  });

  it('serves every route with credentials, and the authenticated identity wins over the body `by`', async () => {
    const { f, h, id } = await setup();
    for (const route of ['/', '/assets/app.js', '/api/runs', '/api/interventions', `/api/interventions/${id}`]) {
      const res = await fetch(`${h.url}${route}`, { headers: AUTH });
      expect(res.status, route).toBe(200);
      await res.text();
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    try {
      const sse = await fetch(`${h.url}/api/events`, { headers: AUTH, signal: controller.signal });
      expect(sse.status).toBe(200);
      expect(sse.headers.get('content-type') ?? '').toContain('text/event-stream');
    } finally {
      clearTimeout(timer);
      controller.abort();
    }

    const take = await fetch(`${h.url}/api/interventions/${id}/take`, { ...jsonBody({ by: 'someone-else' }), headers: { ...jsonBody({}).headers, ...AUTH } });
    expect(take.status).toBe(200);
    expect(((await take.json()) as { heldBy?: string }).heldBy).toBe('authenticated-operator');

    const abort = await fetch(`${h.url}/api/interventions/${id}/abort`, { ...jsonBody({ by: 'someone-else' }), headers: { ...jsonBody({}).headers, ...AUTH } });
    expect(abort.status).toBe(200);
    expect(f.broker.terminated).toBe(true);
  });
});

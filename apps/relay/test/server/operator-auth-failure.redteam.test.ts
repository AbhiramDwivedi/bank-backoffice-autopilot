/**
 * Red-team: an `authenticate` hook that FAILS (throws, rejects, or calls `next(err)`) must not leak
 * its error to an unauthenticated caller. The finding this pins: such a failure used to fall
 * through to the final error handler, which answered 500 with the error's message, e.g. an LDAP
 * bind error quoting the password it tried. Now every route answers a fixed 401 with nothing from
 * the error, and the failure is reported server-side by class name only.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { RequestHandler } from 'express';
import { escalateSample, makeBrokerFixture, type BrokerFixture } from '../support/fixtures.js';
import type { RelayServerHandle } from '../../src/server/index.js';
import { jsonBody, startRealRelayServer } from './redteam-helpers.js';

const SECRET = 'Hunter2Secret';
const leakyError = (): Error => new Error(`LDAP bind failed for cn=svc-relay with password ${SECRET}`);

const hooks: Record<string, RequestHandler> = {
  'throws synchronously': () => {
    throw leakyError();
  },
  'returns a rejected promise': (async () => {
    await Promise.resolve();
    throw leakyError();
  }) as RequestHandler,
  'calls next(err)': (_req, _res, next) => {
    next(leakyError());
  },
};

const fixtures: BrokerFixture[] = [];
const servers: RelayServerHandle[] = [];
afterEach(async () => {
  for (const h of servers.splice(0)) await h.close();
  for (const f of fixtures.splice(0)) f.dispose();
});

describe.each(Object.entries(hooks))('a failing authenticate hook (%s)', (_name, authenticate) => {
  it('answers a fixed 401 on every route with nothing from the error, and reports only its class name', async () => {
    const f = makeBrokerFixture();
    fixtures.push(f);
    const reported: string[] = [];
    const h = await startRealRelayServer([f.broker], { authenticate, onAuthError: (kind) => reported.push(kind) });
    servers.push(h);
    const { id } = await escalateSample(f.broker);

    const requests: [string, RequestInit | undefined][] = [
      ['/', undefined],
      ['/assets/app.js', undefined],
      ['/api/interventions', undefined],
      [`/api/interventions/${id}/take`, jsonBody({ by: 'mallory' })],
    ];
    for (const [route, init] of requests) {
      const res = await fetch(`${h.url}${route}`, init);
      const text = await res.text();
      expect(res.status, route).toBe(401);
      expect(JSON.parse(text), route).toEqual({ error: { code: 'unauthorized', message: 'authentication failed' } });
      expect(text, route).not.toContain(SECRET);
      expect(text, route).not.toContain('LDAP');
      expect(text, route).not.toMatch(/\bat \S+:\d+/); // no stack frame
    }

    // The SSE stream: a 401, never an event stream.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    try {
      const res = await fetch(`${h.url}/api/events`, { signal: controller.signal });
      expect(res.status).toBe(401);
      expect(res.headers.get('content-type') ?? '').not.toContain('text/event-stream');
      expect(await res.text()).not.toContain(SECRET);
    } finally {
      clearTimeout(timer);
    }

    expect(reported.length).toBe(requests.length + 1);
    expect(reported.every((k) => k === 'Error')).toBe(true);
    expect(f.broker.token.holder).toBe('none');
    await f.broker.abort(id, 'cleanup');
  });
});

describe('the auth guard leaves a normal hook alone', () => {
  it('a hook that refuses by responding keeps its own answer; a hook that calls next() lets the request through', async () => {
    const f = makeBrokerFixture();
    fixtures.push(f);
    const reported: string[] = [];
    const authenticate: RequestHandler = (req, res, next) => {
      if (req.headers.authorization === 'Bearer ok') {
        next();
        return;
      }
      res.status(401).json({ error: { code: 'unauthorized', message: 'sign in' } });
    };
    const h = await startRealRelayServer([f.broker], { authenticate, onAuthError: (kind) => reported.push(kind) });
    servers.push(h);

    const refused = await fetch(`${h.url}/api/runs`);
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual({ error: { code: 'unauthorized', message: 'sign in' } });
    const allowed = await fetch(`${h.url}/api/runs`, { headers: { Authorization: 'Bearer ok' } });
    expect(allowed.status).toBe(200);
    expect(reported).toEqual([]);
  });
});

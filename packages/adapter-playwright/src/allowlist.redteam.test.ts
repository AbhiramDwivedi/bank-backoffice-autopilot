/**
 * Adversarial probes for the allowlist and policy guarantees, run against the real Playwright
 * surface (see docs/design/policy.md's "Quarantine" section). Complements
 * `packages/core/src/policy/allowlist.redteam.test.ts` (FakeSurface + pure guard) with the two attacks that
 * need a real browser/network stack: an off-origin server-side redirect, and a link click whose
 * href leaves the allowlist. Also re-runs the scheme-based navigate attacks (`javascript:`,
 * `data:`, `file:`, protocol-relative, uppercase scheme) through a real browser to confirm the
 * FakeSurface-level guarantee holds end to end.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPolicyGuard } from '@cu/core/policy';
import { parsePolicy } from '@cu/core/policy';
import { withPolicy, type PolicyDecisionEvent, type PolicySurface } from '@cu/core/policy';
import { createPlaywrightSurface, type PlaywrightSurface } from './surface.js';

let browser: Browser;
const surfaces: PlaywrightSurface[] = [];

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser.close();
});

afterEach(async () => {
  while (surfaces.length > 0) {
    const s = surfaces.pop()!;
    await s.close().catch(() => undefined);
  }
});

/** A tiny raw HTTP server (no Express) standing in for "the allowed app origin" or "an evil
 * off-allowlist origin". `routes` maps exact pathnames to a responder. */
function startServer(routes: Record<string, (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void>): Promise<{ baseUrl: string; close: () => Promise<void>; server: Server }> {
  return new Promise((resolve) => {
    const server: Server = createServer((req, res) => {
      const pathname = (req.url ?? '/').split('?')[0]!;
      const handler = routes[pathname];
      if (handler) {
        handler(req, res);
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        server,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}

function html(body: string): (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void {
  return (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body);
  };
}

function testGuard(allowedOrigin: string) {
  return createPolicyGuard(
    parsePolicy(`
name: playwright-redteam
allowedOrigins: ['${allowedOrigin}']
allowedPathPatterns: []
deniedPathPatterns: ['^/__faults', '^/__reset']
allowedActions: [navigate, click, type, select, press, extract, wait, dismiss_dialog, switch_frame]
risk:
  irreversibleTextPatterns:
    - '^(submit|confirm|create|open account|transfer|delete|approve|post)\\b'
  irreversibleUrlPatterns: []
  discoveryMode: escalate
  replayRequiresApproved: true
redaction:
  patterns: []
limits: { maxSteps: 40, maxDurationMs: 600000, maxLlmCalls: 60 }
`),
  );
}

async function newPolicySurface(baseUrl: string, guard: ReturnType<typeof testGuard>): Promise<{ ps: PolicySurface; inner: PlaywrightSurface; events: PolicyDecisionEvent[] }> {
  const inner = await createPlaywrightSurface({ browser, baseUrl });
  surfaces.push(inner);
  const events: PolicyDecisionEvent[] = [];
  const ps = withPolicy(inner, guard, { onDecision: (e) => events.push(e) });
  return { ps, inner, events };
}

// ---------------------------------------------------------------------------------------------
// Off-origin server-side redirect triggers quarantine
// ---------------------------------------------------------------------------------------------

describe('off-origin 302 redirect (real Playwright browser)', () => {
  it('navigating to an allowed-origin URL that server-side 302s to a different, non-allowed origin quarantines the surface; a subsequent click never reaches the inner surface', async () => {
    const evil = await startServer({ '/': html('<html><body><h1>evil</h1></body></html>') });
    const allowed = await startServer({
      '/': html('<html><body><a id="home" href="/">home</a></body></html>'),
      '/redirect': (_req, res) => {
        res.writeHead(302, { location: `${evil.baseUrl}/` }).end();
      },
    });
    try {
      const guard = testGuard(allowed.baseUrl);
      const { ps, inner, events } = await newPolicySurface(allowed.baseUrl, guard);
      const actSpy = vi.spyOn(inner, 'act');

      expect(ps.quarantined).toBe(false);
      const navResult = await ps.act({ type: 'navigate', url: `${allowed.baseUrl}/redirect` }, 10_000);
      expect(navResult.ok).toBe(true); // the navigate action itself was to an allowed-origin URL and succeeded
      expect(await inner.currentUrl()).toBe(`${evil.baseUrl}/`); // ...but the server redirected off-origin
      expect(ps.quarantined).toBe(true);
      expect(events.some((e) => e.decision === 'quarantine')).toBe(true);

      const actsBeforeBlockedAttempt = actSpy.mock.calls.length;
      const blockedClick = await ps.act({ type: 'click', target: { ref: 'e1' } }, 1000);
      expect(blockedClick.ok).toBe(false);
      expect(blockedClick.error?.code).toBe('policy_violation');
      expect(actSpy.mock.calls.length).toBe(actsBeforeBlockedAttempt); // never reached the raw Playwright surface

      const blockedType = await ps.act({ type: 'type', target: { ref: 'e1' }, value: 'x' }, 1000);
      expect(blockedType.ok).toBe(false);
      expect(actSpy.mock.calls.length).toBe(actsBeforeBlockedAttempt);
    } finally {
      await allowed.close();
      await evil.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// A link click whose href leaves the allowlist quarantines from the post-click frame check
// ---------------------------------------------------------------------------------------------

describe('link click leaving the allowlist (real Playwright browser)', () => {
  it('clicking a same-origin-served link whose href points off-allowlist quarantines the surface after the click', async () => {
    const evil = await startServer({ '/': html('<html><body><h1>evil landing page</h1></body></html>') });
    const allowed = await startServer({}); // filled in once evil's URL is known
    try {
      // Re-register '/' now that evil.baseUrl is known.
      const server = allowed.server;
      server.removeAllListeners('request');
      server.on('request', (req, res) => {
        if ((req.url ?? '/').split('?')[0] === '/') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<html><body><a id="evilLink" href="${evil.baseUrl}/">go external</a></body></html>`);
          return;
        }
        res.writeHead(404).end('not found');
      });

      const guard = testGuard(allowed.baseUrl);
      const { ps, inner, events } = await newPolicySurface(allowed.baseUrl, guard);
      const actSpy = vi.spyOn(inner, 'act');

      const navHome = await ps.act({ type: 'navigate', url: `${allowed.baseUrl}/` }, 10_000);
      expect(navHome.ok).toBe(true);
      expect(ps.quarantined).toBe(false);

      const obs = await ps.observe();
      const link = obs.elements.find((e) => e.name.toLowerCase().includes('go external'));
      expect(link).toBeDefined();

      const clickResult = await ps.act({ type: 'click', target: link!.descriptor }, 10_000);
      expect(clickResult.ok).toBe(true); // the click itself is a reversible, allowed action
      expect(await inner.currentUrl()).toBe(`${evil.baseUrl}/`);
      expect(ps.quarantined).toBe(true);
      expect(events.some((e) => e.decision === 'quarantine')).toBe(true);

      const actsSoFar = actSpy.mock.calls.length;
      const blocked = await ps.act({ type: 'click', target: { ref: 'e1' } }, 1000);
      expect(blocked.ok).toBe(false);
      expect(actSpy.mock.calls.length).toBe(actsSoFar);
    } finally {
      await allowed.close();
      await evil.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Scheme-based navigate attacks, re-confirmed against a real browser
// ---------------------------------------------------------------------------------------------

describe('scheme-based navigate attacks, real browser -- confirmed refused before reaching Playwright at all', () => {
  it.each([
    ['javascript: URL', 'javascript:alert(1)'],
    ['data: URL', 'data:text/html,<h1>pwned</h1>'],
    ['file: URL', 'file:///etc/passwd'],
  ])('%s never reaches page.goto()', async (_label, url) => {
    const allowed = await startServer({ '/': html('<html><body>home</body></html>') });
    try {
      const guard = testGuard(allowed.baseUrl);
      const { ps, inner } = await newPolicySurface(allowed.baseUrl, guard);
      await ps.act({ type: 'navigate', url: `${allowed.baseUrl}/` }, 10_000);
      // Spy attached only AFTER the legitimate baseline navigation, so a 0-call assertion below
      // is about the malicious attempt specifically, not the setup navigation.
      const gotoSpy = vi.spyOn(inner.page, 'goto');

      const result = await ps.act({ type: 'navigate', url }, 5000);
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('policy_violation');
      expect(gotoSpy).not.toHaveBeenCalled();
      expect(await inner.currentUrl()).toBe(`${allowed.baseUrl}/`); // still on the allowed page, untouched
    } finally {
      await allowed.close();
    }
  });

  it('protocol-relative URL, resolved against the current allowed page, targets the real off-allowlist origin and is refused', async () => {
    const evil = await startServer({ '/': html('evil') });
    const allowed = await startServer({ '/': html('home') });
    try {
      const guard = testGuard(allowed.baseUrl);
      const { ps, inner } = await newPolicySurface(allowed.baseUrl, guard);
      await ps.act({ type: 'navigate', url: `${allowed.baseUrl}/` }, 10_000);

      const evilHost = new URL(evil.baseUrl).host; // "127.0.0.1:PORT"
      const gotoSpy = vi.spyOn(inner.page, 'goto');
      const result = await ps.act({ type: 'navigate', url: `//${evilHost}/` }, 5000);
      expect(result.ok).toBe(false);
      expect(gotoSpy).not.toHaveBeenCalled();
    } finally {
      await allowed.close();
      await evil.close();
    }
  });

  it('uppercased scheme/host resolves to the SAME allowed origin (not a bypass) and is allowed through', async () => {
    const allowed = await startServer({ '/': html('home') });
    try {
      const guard = testGuard(allowed.baseUrl);
      const { ps } = await newPolicySurface(allowed.baseUrl, guard);
      const upper = `HTTP://${new URL(allowed.baseUrl).host.toUpperCase()}/`;
      const result = await ps.act({ type: 'navigate', url: upper }, 10_000);
      expect(result.ok).toBe(true);
    } finally {
      await allowed.close();
    }
  });
});

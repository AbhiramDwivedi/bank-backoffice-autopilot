/**
 * Red-team suite for Relay's console, proven end to end through a real `startRelayServer` (real
 * HTTP, real `SessionBroker` on a `FakeSurface`) rather than a fake port -- see
 * docs/design/relay.md ("Security perimeter") and docs/design/security-review.md. Covers:
 * Host/Origin/Sec-Fetch-Site guarding every route (reads included, not just the mutating POSTs),
 * a `Sec-Fetch-Site: cross-site` request refused outright, the `GET /` bootstrap script-island
 * escaping (bootstrap.ts), the CSP/nosniff headers, and an unexpected 500's message never
 * carrying a stack trace.
 *
 * Not duplicated here: apps/relay/src/server/app.redteam.test.ts already covers Host/Origin/
 * Sec-Fetch-Site guards and basic body-size/content-type/malformed-JSON/non-string-`by` rejection
 * against a `BrokerFixture` (fake-port-adjacent) harness; this file re-proves the same perimeter
 * against the REAL composed stack (`startRelayServer`) and adds the attacks app.redteam.test.ts
 * does not cover: unregistered pattern-shaped-secret redaction, XSS/script-injection in
 * reason/context/notes, and unexpected-500 message hygiene.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { escalateSample, makeBrokerFixture, type BrokerFixture } from '../support/fixtures.js';
import type { SessionBroker } from '../support/core-testing.js';
import { createHarness, openRelay, waitFor } from '../ui/harness.js';
import { connectSse, jsonBody, rawRequest, startRealRelayServer } from './redteam-helpers.js';
import type { RelayServerHandle } from '../../src/server/index.js';

const SSN = '123-45-6789';
const CARD = '4111 1111 1111 1111';
const XSS_PAYLOAD = '</script><script>alert(1)</script><img src=x onerror=alert(1)>';

const fixtures: BrokerFixture[] = [];
const servers: RelayServerHandle[] = [];

function fixture(): BrokerFixture {
  const f = makeBrokerFixture();
  fixtures.push(f);
  return f;
}

async function server(brokers: SessionBroker[]): Promise<RelayServerHandle> {
  const h = await startRealRelayServer(brokers);
  servers.push(h);
  return h;
}

afterEach(async () => {
  for (const h of servers.splice(0)) await h.close();
  for (const f of fixtures.splice(0)) f.dispose();
});

// =================================================================================================
// Host / Origin / Sec-Fetch-Site: DNS rebinding + CSRF, on every route
// =================================================================================================

describe('Host/Origin/Sec-Fetch-Site guard every route, reads and writes', () => {
  it('refuses GET /, /api/interventions, /api/runs and /api/events with a forged Host, and leaves the broker untouched', async () => {
    const f = fixture();
    const h = await server([f.broker]);
    const { id, resolution } = await escalateSample(f.broker, { reason: { code: 'stuck', message: 'rebinding-probe' } });

    for (const p of ['/', '/api/interventions', '/api/runs', '/api/events']) {
      const raw = await rawRequest(h.port, 'GET', p, 'evil.example');
      expect(raw, p).toMatch(/^HTTP\/1\.1 403/);
      expect(raw, p).not.toContain('rebinding-probe');
    }
    expect(f.broker.token.state).toBe('paused');
    expect(f.broker.view(id).intervention.status).toBe('open');

    const legit = await rawRequest(h.port, 'GET', '/api/interventions', `127.0.0.1:${h.port}`);
    expect(legit).toMatch(/^HTTP\/1\.1 200/);
    expect(legit).toContain('rebinding-probe');

    await f.broker.abort(id, 'operator');
    await resolution;
  });

  it('refuses POST take with a forged Host and never actions the transition', async () => {
    const f = fixture();
    const h = await server([f.broker]);
    const { id, resolution } = await escalateSample(f.broker);

    const body = JSON.stringify({ by: 'attacker' });
    const raw = await rawRequest(h.port, 'POST', `/api/interventions/${id}/take`, 'evil.example', ['Content-Type: application/json'], body);
    expect(raw).toMatch(/^HTTP\/1\.1 403/);
    expect(raw).not.toContain('human_active');
    expect(f.broker.token.state).toBe('paused');
    expect(f.broker.view(id).intervention.status).toBe('open');

    const legit = await fetch(`${h.url}/api/interventions/${id}/take`, jsonBody({ by: 'operator' }));
    expect(legit.status).toBe(200);

    await f.broker.abort(id, 'operator');
    await resolution;
  });

  it('refuses POST handback with a forged Host and never actions the transition', async () => {
    const f = fixture();
    const h = await server([f.broker]);
    const { id, resolution } = await escalateSample(f.broker);
    const take = await fetch(`${h.url}/api/interventions/${id}/take`, jsonBody({ by: 'operator' }));
    expect(take.status).toBe(200);

    const body = JSON.stringify({ by: 'attacker', resumeFrom: 'current_step' });
    const raw = await rawRequest(h.port, 'POST', `/api/interventions/${id}/handback`, 'evil.example', ['Content-Type: application/json'], body);
    expect(raw).toMatch(/^HTTP\/1\.1 403/);
    expect(f.broker.token.state).toBe('human');
    expect(f.broker.view(id).intervention.status).toBe('human_active');

    const legit = await fetch(`${h.url}/api/interventions/${id}/handback`, jsonBody({ by: 'operator', resumeFrom: 'current_step' }));
    expect(legit.status).toBe(200);
    await resolution;
  });

  it('refuses POST abort with a forged Host and never actions the transition', async () => {
    const f = fixture();
    const h = await server([f.broker]);
    const { id, resolution } = await escalateSample(f.broker);

    const body = JSON.stringify({ by: 'attacker' });
    const raw = await rawRequest(h.port, 'POST', `/api/interventions/${id}/abort`, 'evil.example', ['Content-Type: application/json'], body);
    expect(raw).toMatch(/^HTTP\/1\.1 403/);
    expect(f.broker.view(id).intervention.status).toBe('open');

    const legit = await fetch(`${h.url}/api/interventions/${id}/abort`, jsonBody({ by: 'operator' }));
    expect(legit.status).toBe(200);
    await resolution;
  });

  it('refuses a foreign Origin on a read (GET /api/interventions) and a write (POST take)', async () => {
    const f = fixture();
    const h = await server([f.broker]);
    const { id, resolution } = await escalateSample(f.broker);

    const read = await fetch(`${h.url}/api/interventions`, { headers: { Origin: 'http://evil.example' } });
    expect(read.status).toBe(403);
    expect(((await read.json()) as { error: { code: string } }).error.code).toBe('forbidden');

    const write = await fetch(`${h.url}/api/interventions/${id}/take`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' },
      body: JSON.stringify({ by: 'attacker' }),
    });
    expect(write.status).toBe(403);
    expect(f.broker.token.state).toBe('paused');

    await f.broker.abort(id, 'operator');
    await resolution;
  });

  it('refuses Sec-Fetch-Site: cross-site on a read and a write, even with no Origin header', async () => {
    const f = fixture();
    const h = await server([f.broker]);
    const { id, resolution } = await escalateSample(f.broker);

    const read = await fetch(`${h.url}/api/runs`, { headers: { 'Sec-Fetch-Site': 'cross-site' } });
    expect(read.status).toBe(403);

    const write = await fetch(`${h.url}/api/interventions/${id}/take`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' },
      body: JSON.stringify({ by: 'attacker' }),
    });
    expect(write.status).toBe(403);
    expect(f.broker.token.state).toBe('paused');

    await f.broker.abort(id, 'operator');
    await resolution;
  });

  it('accepts same-origin Host and Origin', async () => {
    const f = fixture();
    const h = await server([f.broker]);
    const viaHost = await rawRequest(h.port, 'GET', '/api/runs', `127.0.0.1:${h.port}`);
    expect(viaHost).toMatch(/^HTTP\/1\.1 200/);

    const viaOrigin = await fetch(`${h.url}/api/runs`, { headers: { Origin: h.url } });
    expect(viaOrigin.status).toBe(200);
  });
});

// =================================================================================================
// Path traversal in :id
// =================================================================================================

describe('path-traversal ids are inert (Map lookup, never a filesystem path)', () => {
  const TRAVERSAL_IDS = ['..%2F..%2Fetc%2Fpasswd', '%2e%2e%2f%2e%2e%2fetc%2fpasswd', '..%5C..%5Cwindows%5Cwin.ini', 'C:%5CWindows%5Cwin.ini'];

  function assertInert(status: number, text: string): void {
    expect([400, 404]).toContain(status);
    expect(text).not.toContain('root:'); // /etc/passwd content marker
    expect(text).not.toContain('[fonts]'); // win.ini content marker
    expect(text).not.toContain('.ts:');
    expect(text).not.toContain('node_modules');
    expect(text).not.toContain('ENOENT');
  }

  it.each(TRAVERSAL_IDS)('GET /api/interventions/%s -> 404/400 JSON, never 200/500/file contents', async (raw) => {
    const f = fixture();
    const h = await server([f.broker]);
    const res = await fetch(`${h.url}/api/interventions/${raw}`);
    expect(res.headers.get('content-type')).toContain('application/json');
    assertInert(res.status, await res.text());
  });

  it.each(TRAVERSAL_IDS)('GET /api/interventions/%s/screenshot -> 404/400 JSON, never 200/500/file contents', async (raw) => {
    const f = fixture();
    const h = await server([f.broker]);
    const res = await fetch(`${h.url}/api/interventions/${raw}/screenshot`);
    expect(res.headers.get('content-type')).toContain('application/json');
    assertInert(res.status, await res.text());
  });

  it.each(TRAVERSAL_IDS)('POST /api/interventions/%s/take -> 404/400 JSON, never 200/500', async (raw) => {
    const f = fixture();
    const h = await server([f.broker]);
    const res = await fetch(`${h.url}/api/interventions/${raw}/take`, jsonBody({ by: 'attacker' }));
    expect(res.headers.get('content-type')).toContain('application/json');
    assertInert(res.status, await res.text());
  });
});

// =================================================================================================
// XSS in reason / context / notes
// =================================================================================================

describe('XSS in reason/context/notes never breaks out of JSON or the bootstrap script island', () => {
  it('reason.message and context.observed stay literal JSON, with a strict CSP and nosniff, on list and single', async () => {
    const f = fixture();
    const h = await server([f.broker]);
    const { id, resolution } = await escalateSample(f.broker, {
      reason: { code: 'stuck', message: XSS_PAYLOAD },
      context: { expected: 'ok', observed: XSS_PAYLOAD },
    });

    for (const url of [`${h.url}/api/interventions`, `${h.url}/api/interventions/${id}`]) {
      const res = await fetch(url);
      expect(res.headers.get('content-type'), url).toContain('application/json');
      expect(res.headers.get('x-content-type-options'), url).toBe('nosniff');
      const csp = res.headers.get('content-security-policy') ?? '';
      expect(csp, url).toContain("script-src 'self'");
      expect(csp, url).not.toContain('unsafe-inline');
      // Present verbatim -- it's inert JSON string data here, never parsed as markup.
      const text = await res.text();
      expect(text, url).toContain(XSS_PAYLOAD);
    }

    await f.broker.abort(id, 'operator');
    await resolution;
  });

  it('a hand-back note carrying the same payload comes back only as JSON data', async () => {
    const f = fixture();
    const h = await server([f.broker]);
    const { id, resolution } = await escalateSample(f.broker);
    await fetch(`${h.url}/api/interventions/${id}/take`, jsonBody({ by: 'operator' }));

    const res = await fetch(`${h.url}/api/interventions/${id}/handback`, jsonBody({ by: 'operator', resumeFrom: 'current_step', notes: XSS_PAYLOAD }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as { notes?: string };
    expect(body.notes).toBe(XSS_PAYLOAD);

    await resolution;
  });

  it('GET / inlines the snapshot with </script> escaped: the raw sequence never appears, and the page forbids inline script', async () => {
    const f = fixture();
    const h = await server([f.broker]);
    const { id, resolution } = await escalateSample(f.broker, { reason: { code: 'stuck', message: XSS_PAYLOAD } });

    const res = await fetch(`${h.url}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain('unsafe-inline');

    const html = await res.text();
    expect(html).toMatch(/<script id="relay-bootstrap" type="application\/json">/);
    // The raw payload (real '<'/'>') never appears -- bootstrap.ts's escapeForInlineScript ran.
    expect(html).not.toContain(XSS_PAYLOAD);
    expect(html).not.toContain('</script><script>alert(1)</script>');
    // ...but the escaped form is present, proving the reason message really was inlined.
    expect(html).toContain('\\u003c/script\\u003e\\u003cscript\\u003ealert(1)\\u003c/script\\u003e');

    await f.broker.abort(id, 'operator');
    await resolution;
  });
});

// ---- One real-browser check: the alert()-triggering variant never opens a dialog ---------------
//
// test/ui/relay.browser.test.ts ("XSS payloads render as inert text") already drives a real
// headless browser through onerror/onload-style payloads in reason/goal/context/notes and checks
// no page error and no raw img/svg/script element leaked into the rendered panes; it's read-only
// for this pass, so not duplicated. This adds the one check that file doesn't make: an
// alert()-triggering payload (this task's exact XSS_PAYLOAD, with a real <script> tag) opens no
// `dialog`, using the same harness (test/ui/harness.ts) since it makes this cheap (one more test,
// UI already built by its beforeAll).
let browser: Browser | undefined;
let browserLaunchError: string | undefined;
try {
  browser = await chromium.launch({ headless: true });
} catch (err) {
  browserLaunchError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

afterAll(async () => {
  await browser?.close();
});

const uiHarness = createHarness({ getBrowser: () => browser });

describe.skipIf(browser === undefined)('XSS (browser): the alert()-triggering payload fires no dialog', () => {
  it('shows the payload as literal text and never opens a dialog', async () => {
    const b = browser;
    if (b === undefined) throw new Error('unreachable: gated by describe.skipIf(browser === undefined)');
    const f = uiHarness.trackFixture(makeBrokerFixture({ sessionLabel: 'redteam xss' }));
    const relayServer = await uiHarness.startServer({ brokers: [f.broker] });
    const page = await uiHarness.newPage(b);
    let dialogFired = false;
    page.on('dialog', (d) => {
      dialogFired = true;
      void d.dismiss();
    });

    await openRelay(page, relayServer.url);
    const { id, resolution } = await escalateSample(f.broker, {
      reason: { code: 'stuck', message: XSS_PAYLOAD },
      context: { expected: 'a', observed: XSS_PAYLOAD },
    });

    await waitFor(async () => (await page.locator(`.qcard[data-intervention-id="${id}"]`).count()) > 0, 5000);
    await page.click(`.qcard[data-intervention-id="${id}"]`);
    await waitFor(async () => (await page.locator('#reason-message').count()) > 0, 3000);

    expect(await page.locator('#reason-message').textContent()).toContain('<script>alert(1)</script>');
    expect(dialogFired).toBe(false);

    await f.broker.abort(id, 'operator');
    await resolution;
  }, 20000);
});

if (browser === undefined) {
  console.warn(`console.redteam.test.ts: skipping the one Playwright XSS-dialog check -- chromium unavailable (${browserLaunchError}).`);
}

// =================================================================================================
// Oversized / malformed / mistyped POST bodies
// =================================================================================================

describe('POST body validation edge cases', () => {
  it('413s a 1MB notes field on handback, and the intervention is unchanged', async () => {
    const f = fixture();
    const h = await server([f.broker]);
    const { id, resolution } = await escalateSample(f.broker);
    await fetch(`${h.url}/api/interventions/${id}/take`, jsonBody({ by: 'operator' }));

    const huge = 'A'.repeat(1024 * 1024);
    const res = await fetch(`${h.url}/api/interventions/${id}/handback`, jsonBody({ by: 'operator', resumeFrom: 'current_step', notes: huge }));
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('payload_too_large');
    expect(JSON.stringify(body)).not.toContain('    at ');
    expect(f.broker.view(id).intervention.status).toBe('human_active');

    const ok = await fetch(`${h.url}/api/interventions/${id}/handback`, jsonBody({ by: 'operator', resumeFrom: 'current_step', notes: 'fine' }));
    expect(ok.status).toBe(200);
    await resolution;
  });

  it('rejects a non-string `by` with 400, never coerces it', async () => {
    const f = fixture();
    const h = await server([f.broker]);
    const { id, resolution } = await escalateSample(f.broker);

    const res = await fetch(`${h.url}/api/interventions/${id}/take`, jsonBody({ by: 12345 }));
    expect(res.status).toBe(400);
    expect(f.broker.token.state).toBe('paused');

    await f.broker.abort(id, 'operator');
    await resolution;
  });

  it('rejects a bad `resumeFrom` value on handback with 400', async () => {
    const f = fixture();
    const h = await server([f.broker]);
    const { id, resolution } = await escalateSample(f.broker);
    await fetch(`${h.url}/api/interventions/${id}/take`, jsonBody({ by: 'operator' }));

    const res = await fetch(`${h.url}/api/interventions/${id}/handback`, jsonBody({ by: 'operator', resumeFrom: 'abort' }));
    expect(res.status).toBe(400);
    expect(f.broker.view(id).intervention.status).toBe('human_active');

    await f.broker.abort(id, 'operator');
    await resolution;
  });

  it('rejects a non-JSON Content-Type with 400, before touching the broker', async () => {
    const f = fixture();
    const h = await server([f.broker]);
    const { id, resolution } = await escalateSample(f.broker);

    const res = await fetch(`${h.url}/api/interventions/${id}/take`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ by: 'attacker' }),
    });
    expect(res.status).toBe(400);
    expect(f.broker.token.state).toBe('paused');

    await f.broker.abort(id, 'operator');
    await resolution;
  });

  it('malformed JSON is 400, never a 500 or an HTML error page', async () => {
    const f = fixture();
    const h = await server([f.broker]);
    const { id, resolution } = await escalateSample(f.broker);

    const res = await fetch(`${h.url}/api/interventions/${id}/take`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ this is not json',
    });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('bad_request');

    await f.broker.abort(id, 'operator');
    await resolution;
  });
});

// =================================================================================================
// Redaction of pattern-shaped secrets nobody registered
// =================================================================================================

describe('a pattern-shaped secret in context is redacted everywhere the API sends it', () => {
  it('list, single, the SSE stream and the GET / snapshot all redact an SSN and a card number', async () => {
    const f = fixture();
    const h = await server([f.broker]);
    const sse = await connectSse(h.url);

    const { id, resolution } = await escalateSample(f.broker, {
      context: { expected: 'balance visible', observed: `Account holder SSN on file: ${SSN}, card ${CARD}` },
    });

    const list = (await (await fetch(`${h.url}/api/interventions`)).json()) as unknown;
    const listText = JSON.stringify(list);
    expect(listText).not.toContain(SSN);
    expect(listText).toContain('[REDACTED:ssn]');
    expect(listText).not.toContain(CARD);
    expect(listText).toContain('[REDACTED:card]');

    const single = (await (await fetch(`${h.url}/api/interventions/${id}`)).json()) as unknown;
    const singleText = JSON.stringify(single);
    expect(singleText).not.toContain(SSN);
    expect(singleText).not.toContain(CARD);

    await sse.waitFor((frames) => frames.some((fr) => fr.event === 'intervention' && JSON.stringify(fr.data).includes(id)), 3000);
    sse.close();
    expect(sse.raw()).not.toContain(SSN);
    expect(sse.raw()).not.toContain(CARD);
    expect(sse.raw()).toContain('[REDACTED:ssn]');

    const boot = await (await fetch(`${h.url}/`)).text();
    expect(boot).not.toContain(SSN);
    expect(boot).not.toContain(CARD);
    expect(boot).toContain('[REDACTED:ssn]');

    await f.broker.abort(id, 'operator');
    await resolution;
  });
});

// =================================================================================================
// Unexpected 500s
// =================================================================================================

describe('an unexpected error surfaces as a redacted 500 JSON, never a stack trace', () => {
  it('GET /api/interventions/:id: a broker throw becomes 500 JSON with the SSN redacted and no stack frame', async () => {
    const f = fixture();
    const h = await server([f.broker]);
    const { id, resolution } = await escalateSample(f.broker);

    const secretMessage = `read failed: SSN on file ${SSN} while loading C:\\Users\\redteam\\secret\\evidence.json`;
    const originalView = f.broker.view.bind(f.broker);
    (f.broker as unknown as { view: (vid: string) => unknown }).view = (vid: string) => {
      if (vid === id) throw new Error(secretMessage);
      return originalView(vid);
    };

    const res = await fetch(`${h.url}/api/interventions/${id}`);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('internal');
    expect(JSON.stringify(body)).not.toContain(SSN);
    expect(JSON.stringify(body)).toContain('[REDACTED:ssn]');
    expect(JSON.stringify(body)).not.toContain('    at ');

    (f.broker as unknown as { view: (vid: string) => unknown }).view = originalView;
    await f.broker.abort(id, 'operator');
    await resolution;
  });

  // An absolute filesystem path in an unexpected error's message (a real fs/ENOENT error, or a
  // Playwright error quoting a screenshot path) never reaches the client: errors.ts strips it
  // (`stripFilesystemPaths`), and the default redactor's `path` pattern backs that up.
  it('a Windows absolute path inside a 500 error message is redacted', async () => {
    const f = fixture();
    const h = await server([f.broker]);
    const { id, resolution } = await escalateSample(f.broker);

    const secretMessage = `read failed: SSN on file ${SSN} while loading C:\\Users\\redteam\\secret\\evidence.json`;
    const originalView = f.broker.view.bind(f.broker);
    (f.broker as unknown as { view: (vid: string) => unknown }).view = (vid: string) => {
      if (vid === id) throw new Error(secretMessage);
      return originalView(vid);
    };

    const res = await fetch(`${h.url}/api/interventions/${id}`);
    const text = await res.text();
    expect(text).not.toMatch(/[A-Za-z]:\\\\|\/Users\/|\/home\//);
    expect(text).not.toContain('node_modules');

    (f.broker as unknown as { view: (vid: string) => unknown }).view = originalView;
    await f.broker.abort(id, 'operator');
    await resolution;
  });

  it('a POSIX absolute path inside a 500 error message is redacted', async () => {
    const f = fixture();
    const h = await server([f.broker]);
    const { id, resolution } = await escalateSample(f.broker);

    const secretMessage = `read failed: SSN on file ${SSN} while loading /Users/redteam/secret/evidence.json`;
    const originalView = f.broker.view.bind(f.broker);
    (f.broker as unknown as { view: (vid: string) => unknown }).view = (vid: string) => {
      if (vid === id) throw new Error(secretMessage);
      return originalView(vid);
    };

    const res = await fetch(`${h.url}/api/interventions/${id}`);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(JSON.stringify(body)).not.toContain(SSN);
    expect(JSON.stringify(body)).not.toMatch(/\/Users\/|\/home\//);
    expect(body.error.message).toContain('[path]');

    (f.broker as unknown as { view: (vid: string) => unknown }).view = originalView;
    await f.broker.abort(id, 'operator');
    await resolution;
  });
});

// =================================================================================================
// No permissive CORS
// =================================================================================================

describe('no permissive CORS', () => {
  it('GET /api/runs and GET /api/interventions carry no Access-Control-Allow-Origin, even naming this server as Origin', async () => {
    const f = fixture();
    const h = await server([f.broker]);
    for (const p of ['/api/runs', '/api/interventions']) {
      const res = await fetch(`${h.url}${p}`, { headers: { Origin: h.url } });
      expect(res.status, p).toBe(200);
      expect(res.headers.get('access-control-allow-origin'), p).toBeNull();
    }
  });
});

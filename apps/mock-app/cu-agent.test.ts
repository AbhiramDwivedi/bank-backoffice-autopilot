/**
 * The mock app ships @cu/browser-agent as a plain script tag, the way a real institution adds a
 * monitoring/RUM tag (docs/design/browser-agent.md, docs/design/mock-app.md). This suite checks:
 *   - GET /static/cu-agent.js serves the bundle, unauthenticated, honouring slowMs.
 *   - Every rendered document includes the tag exactly once, as <head>'s first child.
 *   - The hostile-markup properties documented in docs/design/mock-app.md are unchanged.
 *   - In real Chromium, including the tag changes nothing observable except the detection
 *     attribute and window.__cuAgent itself.
 */
import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AGENT_GLOBAL, AGENT_VERSION, DETECT_ATTRIBUTE } from '@cu/browser-agent';
import { createApp } from './app.js';
import {
  DEFAULT_PASSWORD,
  DEFAULT_USER_ID,
  createClient,
  login,
  loginNewClient,
  postForm,
  postJson,
  startTestApp,
  type TestClient,
  type TestServer,
} from './test-helpers.js';

/** Number of times the agent tag's src attribute appears in a rendered document. */
function agentTagCount(body: string): number {
  return (body.match(/src="\/static\/cu-agent\.js"/g) ?? []).length;
}

/** True when the agent's <script> tag is the first element child of <head>. */
function agentTagIsFirstHeadChild(body: string): boolean {
  const headMatch = /<head[^>]*>([\s\S]*?)<\/head>/i.exec(body);
  if (!headMatch) return false;
  const inner = headMatch[1] ?? '';
  const firstTag = /<([a-zA-Z][\w-]*)\b[^>]*>/.exec(inner);
  const tagName = firstTag?.[1];
  if (!firstTag || !tagName) return false;
  if (tagName.toLowerCase() !== 'script') return false;
  return firstTag[0].includes('src="/static/cu-agent.js"');
}

/** The agent tag is present exactly once, and is the first thing inside <head>. */
function expectAgentTag(body: string): void {
  expect(agentTagCount(body)).toBe(1);
  expect(agentTagIsFirstHeadChild(body)).toBe(true);
}

describe('GET /static/cu-agent.js', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestApp(createApp({ tenant: 'a' }));
  });

  afterAll(async () => {
    await server.close();
  });

  it('200s as application/javascript, contains AGENT_VERSION and __cuAgent, with no session', async () => {
    const anon = createClient(server.baseUrl); // never logged in
    const res = await anon.get('/static/cu-agent.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^application\/javascript/);
    const body = await res.text();
    expect(body).toContain(AGENT_VERSION);
    expect(body).toContain(AGENT_GLOBAL);
  });

  it('honours slowMs like every other asset', async () => {
    const local = await startTestApp(createApp({ tenant: 'a' }));
    try {
      const client = createClient(local.baseUrl);
      const setRes = await postJson(client, '/__faults', { slowMs: 300 });
      expect(setRes.status).toBe(200);

      const t0 = performance.now();
      const res = await client.get('/static/cu-agent.js');
      const elapsed = performance.now() - t0;
      expect(res.status).toBe(200);
      expect(elapsed).toBeGreaterThanOrEqual(280);
    } finally {
      await local.close();
    }
  });
});

describe('cu-agent tag: every rendered document, tenant A (frameset)', () => {
  let server: TestServer;
  let client: TestClient;

  beforeAll(async () => {
    server = await startTestApp(createApp({ tenant: 'a' }));
    client = await loginNewClient(server);
  });

  afterAll(async () => {
    await server.close();
  });

  it('login page (no session)', async () => {
    const anon = createClient(server.baseUrl);
    const body = await (await anon.get('/login')).text();
    expectAgentTag(body);
  });

  it('login re-render on bad credentials', async () => {
    const anon = createClient(server.baseUrl);
    const res = await login(anon, { password: 'not-the-password' });
    expect(res.status).toBe(200);
    expectAgentTag(await res.text());
  });

  it('session-expired page', async () => {
    const anon = createClient(server.baseUrl);
    const body = await (await anon.get('/session-expired')).text();
    expectAgentTag(body);
  });

  it('workstation frameset shell', async () => {
    const body = await (await client.get('/workstation')).text();
    expectAgentTag(body);
  });

  it('banner frame', async () => {
    const body = await (await client.get('/frames/banner')).text();
    expectAgentTag(body);
  });

  it('nav frame', async () => {
    const body = await (await client.get('/frames/nav')).text();
    expectAgentTag(body);
  });

  it('search, no query yet', async () => {
    const body = await (await client.get('/members/search')).text();
    expectAgentTag(body);
  });

  it('search with results', async () => {
    const body = await (await client.get('/members/search?memberId=12345')).text();
    expectAgentTag(body);
  });

  it('search-error (failSearch fault)', async () => {
    const local = await startTestApp(createApp({ tenant: 'a' }));
    try {
      const c = await loginNewClient(local);
      await postJson(c, '/__faults', { failSearch: true });
      const res = await c.get('/members/search');
      expect(res.status).toBe(500);
      expectAgentTag(await res.text());
    } finally {
      await local.close();
    }
  });

  it('member detail', async () => {
    const body = await (await client.get('/members/12345')).text();
    expectAgentTag(body);
  });

  it('member-not-found', async () => {
    const res = await client.get('/members/99999');
    expect(res.status).toBe(404);
    expectAgentTag(await res.text());
  });

  it('access-denied', async () => {
    const res = await client.get('/members/90001');
    expect(res.status).toBe(403);
    expectAgentTag(await res.text());
  });

  it('sub-account form', async () => {
    const body = await (await client.get('/members/12345/subaccounts/new')).text();
    expectAgentTag(body);
  });

  it('sub-account form re-render with validation errors', async () => {
    const res = await postForm(client, '/members/12345/subaccounts', {
      accountType: '',
      nickname: '',
      initialDeposit: '',
    });
    expect(res.status).toBe(200);
    expectAgentTag(await res.text());
  });

  it('sub-account confirmation', async () => {
    const postRes = await postForm(client, '/members/12345/subaccounts', {
      accountType: 'SAV',
      nickname: 'Agent Tag Test',
      initialDeposit: '100.00',
    });
    expect(postRes.status).toBe(302);
    const location = postRes.headers.get('location') ?? '';
    const body = await (await client.get(location)).text();
    expectAgentTag(body);
  });

  it('sub-account confirmation for an unknown reference: the raw-HTML 404 also carries the tag', async () => {
    const res = await client.get('/members/12345/subaccounts/SA-9999999/confirmation');
    expect(res.status).toBe(404);
    expectAgentTag(await res.text());
  });
});

describe('cu-agent tag: representative documents, tenant B (iframe)', () => {
  let server: TestServer;
  let client: TestClient;

  beforeAll(async () => {
    server = await startTestApp(createApp({ tenant: 'b' }));
    client = await loginNewClient(server);
  });

  afterAll(async () => {
    await server.close();
  });

  it('login and session-expired pages', async () => {
    const anon = createClient(server.baseUrl);
    expectAgentTag(await (await anon.get('/login')).text());
    expectAgentTag(await (await anon.get('/session-expired')).text());
  });

  it('workstation iframe shell', async () => {
    expectAgentTag(await (await client.get('/workstation')).text());
  });

  it('banner and nav frames', async () => {
    expectAgentTag(await (await client.get('/frames/banner')).text());
    expectAgentTag(await (await client.get('/frames/nav')).text());
  });

  it('member search ("Member #" label)', async () => {
    const body = await (await client.get('/members/search?memberId=12345')).text();
    expect(body).toContain('Member #');
    expectAgentTag(body);
  });

  it('search-error (failSearch fault)', async () => {
    const local = await startTestApp(createApp({ tenant: 'b' }));
    try {
      const c = await loginNewClient(local);
      await postJson(c, '/__faults', { failSearch: true });
      const res = await c.get('/members/search');
      expect(res.status).toBe(500);
      expectAgentTag(await res.text());
    } finally {
      await local.close();
    }
  });

  it('member detail, member-not-found, access-denied', async () => {
    expectAgentTag(await (await client.get('/members/12345')).text());
    const notFound = await client.get('/members/99999');
    expect(notFound.status).toBe(404);
    expectAgentTag(await notFound.text());
    const denied = await client.get('/members/90001');
    expect(denied.status).toBe(403);
    expectAgentTag(await denied.text());
  });

  it('sub-account form (with required branch code)', async () => {
    expectAgentTag(await (await client.get('/members/12345/subaccounts/new')).text());
  });

  it('sub-account confirmation', async () => {
    const postRes = await postForm(client, '/members/12345/subaccounts', {
      accountType: 'SAV',
      nickname: 'Tenant B Tag Test',
      initialDeposit: '100.00',
      branchCode: '001',
    });
    expect(postRes.status).toBe(302);
    const body = await (await client.get(postRes.headers.get('location') ?? '')).text();
    expectAgentTag(body);
  });
});

describe('hostile-markup properties (docs/design/mock-app.md) are unchanged by the tag', () => {
  let server: TestServer;
  let client: TestClient;

  beforeAll(async () => {
    server = await startTestApp(createApp({ tenant: 'a' }));
    client = await loginNewClient(server);
  });

  afterAll(async () => {
    await server.close();
  });

  it('login (1998): no <label> anywhere; submit is <input type="image"> with no accessible name', async () => {
    const anon = createClient(server.baseUrl);
    const body = await (await anon.get('/login')).text();
    expect(body).not.toMatch(/<label/i);
    const match = /<input[^>]*type="image"[^>]*>/i.exec(body);
    expect(match).not.toBeNull();
    expect(match?.[0] ?? '').not.toMatch(/\balt\s*=|\baria-label\s*=|\btitle\s*=/i);
  });

  it('shell (2001): main content lives in a frame literally named "main"', async () => {
    const body = await (await client.get('/workstation')).text();
    expect(body).toMatch(/<frame name="main" src="\/members\/search"/i);
  });

  it('search (2005): no <thead>/<th>/<button>; Search is a div.btn; result rows are onclick with no anchor', async () => {
    const body = await (await client.get('/members/search?memberId=12345')).text();
    expect(body).not.toMatch(/<thead/i);
    expect(body).not.toMatch(/<th[ >]/i);
    expect(body).not.toMatch(/<button/i);
    expect(body).toMatch(/<div class="btn" onclick="doSearch\(\)">Search<\/div>/);
    expect(body).toMatch(/<tr bgcolor="[^"]*" style="cursor:pointer" onclick="\$\$go\('\/members\/12345'\)"/);
    expect(body).not.toMatch(/<a[^>]*href="\/members\/12345"/);
  });

  it('search: placeholder-only quick-find field, color-only invalid-memberId indication', async () => {
    const body = await (await client.get('/members/search?memberId=abc')).text();
    expect(body).toMatch(/placeholder="SSN last 4"/);
    expect(body).toMatch(/style="border:2px solid red;background:#FFE0E0"/);
  });

  it('detail (2008): tabs are bare <span onclick>, never role="tab"', async () => {
    const body = await (await client.get('/members/12345')).text();
    expect(body).toMatch(/<span[^>]*onclick="showTab\('profile'\)"[^>]*>Profile<\/span>/);
    expect(body).toMatch(/<span[^>]*onclick="showTab\('accounts'\)"[^>]*>Accounts<\/span>/);
    expect(body).not.toMatch(/role\s*=\s*"tab"/i);
  });

  it('sub-account form (2012): no <select>; custom dropdown writes a hidden accountType input', async () => {
    const body = await (await client.get('/members/12345/subaccounts/new')).text();
    const outsideStyle = body.replace(/<style[\s\S]*?<\/style>/gi, '');
    expect(outsideStyle).not.toMatch(/<select[ >]/i);
    expect(body).toMatch(/<input type="hidden" name="accountType" id="hidAcctType" value="[^"]*">/);
    expect(body).toContain('id="cfmBackdrop"');
    expect(body).toContain('id="cfmModal"');
  });

  it('confirmation (2012): reference number identifiable only by format, in a <b> inside a table cell', async () => {
    const postRes = await postForm(client, '/members/12345/subaccounts', {
      accountType: 'SAV',
      nickname: 'Hostility Check',
      initialDeposit: '100.00',
    });
    expect(postRes.status).toBe(302);
    const body = await (await client.get(postRes.headers.get('location') ?? '')).text();
    expect(body).toMatch(/<td><b>SA-\d{7}<\/b><\/td>/);
  });

  it('icon-only image buttons (banner power/help, search print) still have no alt/title/aria', async () => {
    const searchBody = await (await client.get('/members/search?memberId=12345')).text();
    const printImg = /<img src="\/static\/img\/ico_print\.png"[^>]*>/i.exec(searchBody);
    expect(printImg).not.toBeNull();
    expect(printImg?.[0] ?? '').not.toMatch(/\balt\s*=|\btitle\s*=|\baria-/i);

    const bannerBody = await (await client.get('/frames/banner')).text();
    const powerImg = /<img src="\/static\/img\/ico_power\.png"[^>]*>/i.exec(bannerBody);
    expect(powerImg).not.toBeNull();
    expect(powerImg?.[0] ?? '').not.toMatch(/\balt\s*=|\btitle\s*=|\baria-/i);
  });
});

describe('chromium: including the tag changes nothing observable except the detection attribute', () => {
  it('normal load vs. a blocked cu-agent.js: identical <body>, only data-cu-agent differs on <html>, __cuAgent present only when loaded and never enumerable', async () => {
    const server = await startTestApp(createApp({ tenant: 'a' }));
    const browser = await chromium.launch();
    try {
      async function loadSearchPage(blockAgent: boolean): Promise<{
        bodyHtml: string;
        htmlAttrs: [string, string][];
        hasAgent: boolean;
        enumerable: boolean;
      }> {
        const context = await browser.newContext();
        try {
          const page = await context.newPage();
          if (blockAgent) {
            await page.route('**/static/cu-agent.js', (route) =>
              route.fulfill({ contentType: 'application/javascript', body: '' }),
            );
          }
          await page.goto(`${server.baseUrl}/login`);
          await page.locator('input[name="userId"]').fill(DEFAULT_USER_ID);
          await page.locator('input[name="password"]').fill(DEFAULT_PASSWORD);
          await Promise.all([
            page.waitForURL(`${server.baseUrl}/workstation`),
            page.locator('input[type="image"]').click(),
          ]);
          // Navigate directly (not through the frameset) to a real main-content document.
          await page.goto(`${server.baseUrl}/members/search?memberId=12345`);

          const bodyHtml = await page.locator('body').evaluate((el) => el.outerHTML);
          const htmlAttrs = await page.evaluate(
            () =>
              Array.from(document.documentElement.attributes).map(
                (a) => [a.name, a.value] as [string, string],
              ),
          );
          const hasAgent = await page.evaluate(
            (key) => typeof (window as unknown as Record<string, unknown>)[key] !== 'undefined',
            AGENT_GLOBAL,
          );
          const enumerable = await page.evaluate((key) => Object.keys(window).includes(key), AGENT_GLOBAL);
          return { bodyHtml, htmlAttrs, hasAgent, enumerable };
        } finally {
          await context.close();
        }
      }

      const normal = await loadSearchPage(false);
      const blocked = await loadSearchPage(true);

      expect(normal.bodyHtml).toBe(blocked.bodyHtml);
      expect(normal.hasAgent).toBe(true);
      expect(blocked.hasAgent).toBe(false);
      // Non-enumerable either way: present-but-hidden in the normal load, simply absent when blocked.
      expect(normal.enumerable).toBe(false);
      expect(blocked.enumerable).toBe(false);

      const normalAttrs = new Map(normal.htmlAttrs);
      const blockedAttrs = new Map(blocked.htmlAttrs);
      const allKeys = new Set([...normalAttrs.keys(), ...blockedAttrs.keys()]);
      const differingKeys = [...allKeys].filter((k) => normalAttrs.get(k) !== blockedAttrs.get(k));
      expect(differingKeys).toEqual([DETECT_ATTRIBUTE]);
      expect(normalAttrs.get(DETECT_ATTRIBUTE)).toBe(AGENT_VERSION);
      expect(blockedAttrs.has(DETECT_ATTRIBUTE)).toBe(false);
    } finally {
      await browser.close();
      await server.close();
    }
  }, 45000);
});

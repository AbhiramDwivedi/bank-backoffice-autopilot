import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, getContext } from './app.js';
import type { Member } from './data/seed.js';
import { loginNewClient, postForm, startTestApp, type TestClient, type TestServer } from './test-helpers.js';

describe('member search', () => {
  let server: TestServer;
  let client: TestClient;

  beforeAll(async () => {
    server = await startTestApp(createApp({ tenant: 'a' }));
    client = await loginNewClient(server);
  });

  afterAll(async () => {
    await server.close();
  });

  it('exact memberId=12345 returns one row with onclick to /members/12345 and the full name', async () => {
    const res = await client.get('/members/search?memberId=12345');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('1 record(s) found');
    expect(body).toContain('Jane Q. Sample');
    expect(body).toMatch(/onclick="\$\$go\('\/members\/12345'\)"/);
  });

  it('lastName prefix match is case-insensitive: "sam" hits Sample/Sampson x2/Samuels but not Sanderling', async () => {
    const res = await client.get('/members/search?lastName=sam');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('4 record(s) found');
    expect(body).toContain('Jane Q. Sample');
    expect(body).toContain('Wendell P. Sampson');
    expect(body).toContain('Rosalind E. Sampson');
    expect(body).toContain('Priscilla O. Samuels');
    expect(body).not.toContain('Sanderling');
  });

  it('has no <thead>/<th>, and Search is a class="btn" div rather than a <button>', async () => {
    const res = await client.get('/members/search?memberId=12345');
    const body = await res.text();
    expect(body).not.toMatch(/<thead/i);
    expect(body).not.toMatch(/<th[ >]/i);
    expect(body).not.toMatch(/<button/i);
    expect(body).toMatch(/<div class="btn" onclick="doSearch\(\)">Search<\/div>/);
  });

  it('memberId=99999 (zero results) renders the exact "No records found." message', async () => {
    const res = await client.get('/members/search?memberId=99999');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('<td class="msg">No records found.</td>');
  });

  it('paginates lastName matches at 10 per page with a Next link, remainder on page 2', async () => {
    const app = createApp({ tenant: 'a' });
    const pgServer = await startTestApp(app);
    try {
      const pgClient = await loginNewClient(pgServer);
      const ctx = getContext(app);
      const ids: string[] = [];
      for (let i = 1; i <= 12; i++) {
        const id = `59${String(i).padStart(3, '0')}`;
        ids.push(id);
        const member: Member = {
          id,
          firstName: `Test${String(i)}`,
          lastName: 'Zzyzxville',
          joinDate: '01/01/2020',
          savingsCents: 0,
          checkingCents: 0,
          restricted: false,
          address: '1 Test St, Springfield, MA 01103',
          phone: '(413) 555-0199',
          accounts: [],
        };
        ctx.state.members.set(id, member);
      }

      const page1 = await pgClient.get('/members/search?lastName=Zzyzxville');
      const body1 = await page1.text();
      expect(body1).toContain('12 record(s) found');
      expect(body1).toMatch(/Next &gt;&gt;/);
      expect(body1).toMatch(/page=2/);
      const first = ids[0];
      const tenth = ids[9];
      const eleventh = ids[10];
      if (!first || !tenth || !eleventh) throw new Error('test setup: expected 12 generated ids');
      expect(body1).toContain(`/members/${first}`);
      expect(body1).toContain(`/members/${tenth}`);
      expect(body1).not.toContain(`/members/${eleventh}`);

      const page2 = await pgClient.get('/members/search?lastName=Zzyzxville&page=2');
      const body2 = await page2.text();
      expect(body2).toContain('12 record(s) found');
      expect(body2).not.toMatch(/Next &gt;&gt;/);
      expect(body2).toMatch(/&lt;&lt; Prev/);
      expect(body2).toContain(`/members/${eleventh}`);
      const twelfth = ids[11];
      if (!twelfth) throw new Error('test setup: expected 12th id');
      expect(body2).toContain(`/members/${twelfth}`);
    } finally {
      await pgServer.close();
    }
  });
});

describe('member detail', () => {
  let server: TestServer;
  let client: TestClient;

  beforeAll(async () => {
    server = await startTestApp(createApp({ tenant: 'a' }));
    client = await loginNewClient(server);
  });

  afterAll(async () => {
    await server.close();
  });

  it('shows Savings Balance $1,234.56 and Checking Balance $310.00 for member 12345', async () => {
    const res = await client.get('/members/12345');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toMatch(/Savings Balance[\s\S]{0,60}\$1,234\.56/);
    expect(body).toMatch(/Checking Balance[\s\S]{0,60}\$310\.00/);
  });

  it('tabs are bare <span onclick> elements with no role="tab"', async () => {
    const res = await client.get('/members/12345');
    const body = await res.text();
    expect(body).toMatch(/<span[^>]*onclick="showTab\('profile'\)"[^>]*>Profile<\/span>/);
    expect(body).toMatch(/<span[^>]*onclick="showTab\('accounts'\)"[^>]*>Accounts<\/span>/);
    expect(body).not.toMatch(/role\s*=\s*"tab"/i);
  });

  it('Accounts tab has an "Open New Sub-Account" link to the new sub-account form', async () => {
    const res = await client.get('/members/12345');
    const body = await res.text();
    expect(body).toContain('<a href="/members/12345/subaccounts/new">Open New Sub-Account</a>');
  });

  it('?warn=1 shows the session-expiry banner; without it, the banner is absent', async () => {
    const withWarn = await client.get('/members/12345?warn=1');
    expect(await withWarn.text()).toContain('Your session will expire in 5 minutes');

    const withoutWarn = await client.get('/members/12345');
    expect(await withoutWarn.text()).not.toContain('Your session will expire in 5 minutes');
  });

  it('member 90001 is restricted: 403 Access Denied', async () => {
    const res = await client.get('/members/90001');
    expect(res.status).toBe(403);
    const body = await res.text();
    expect(body).toContain('<title>Access Denied</title>');
    expect(body).toContain('Access Denied: your role does not permit viewing this member.');
  });

  it('member 99999 does not exist: 404', async () => {
    const res = await client.get('/members/99999');
    expect(res.status).toBe(404);
  });
});

describe('output escaping', () => {
  let server: TestServer;
  let client: TestClient;

  beforeAll(async () => {
    server = await startTestApp(createApp({ tenant: 'a', password: "x" }));
    client = await loginNewClient(server, { password: 'x' });
  });

  afterAll(async () => {
    await server.close();
  });

  it('search params are HTML-escaped when echoed back', async () => {
    const res = await client.get(`/members/search?lastName=${encodeURIComponent('<script>alert(1)</script>')}`);
    const body = await res.text();
    expect(body).not.toContain('<script>alert(1)</script>');
    expect(body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('nickname is HTML-escaped when the form re-renders after a validation error', async () => {
    const res = await postForm(client, '/members/12345/subaccounts', { nickname: '"><img src=x onerror=alert(1)>' });
    const body = await res.text();
    expect(body).toContain('<ul class="errors">');
    expect(body).not.toContain('<img src=x onerror=alert(1)>');
  });
});

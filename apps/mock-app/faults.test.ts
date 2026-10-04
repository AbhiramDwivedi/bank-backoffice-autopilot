import type { Express } from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, getContext } from './app.js';
import {
  createClient,
  loginNewClient,
  postForm,
  postJson,
  startTestApp,
  type TestServer,
} from './test-helpers.js';

describe('fault injection', () => {
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

  it('GET /__faults defaults to slowMs:0, failSearch:false, expireSession:false, interstitial:true, denyMember:"", chaos:null', async () => {
    const { server: s } = await freshServer();
    const client = createClient(s.baseUrl);
    const res = await client.get('/__faults');
    expect(res.status).toBe(200);
    const flags = (await res.json()) as Record<string, unknown>;
    expect(flags).toEqual({
      slowMs: 0,
      failSearch: false,
      expireSession: false,
      interstitial: true,
      denyMember: '',
      chaos: null,
    });
  });

  it('fault routes require no auth: GET /__faults, POST /__faults and POST /__reset all work with no session', async () => {
    const { server: s } = await freshServer();
    const client = createClient(s.baseUrl);
    expect((await client.get('/__faults')).status).toBe(200);
    expect((await postJson(client, '/__faults', { slowMs: 5 })).status).toBe(200);
    expect((await postJson(client, '/__reset', {})).status).toBe(200);
  });

  it('POST /__faults merges valid keys and reports rejected for bad types', async () => {
    const { server: s } = await freshServer();
    const client = createClient(s.baseUrl);
    const res = await postJson(client, '/__faults', {
      slowMs: 'nope',
      denyMember: 123,
      unknownFlag: 'x',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.rejected).toEqual(expect.arrayContaining(['slowMs', 'denyMember', 'unknownFlag']));
    // Rejected keys are left unchanged (still defaults).
    expect(body.slowMs).toBe(0);
    expect(body.denyMember).toBe('');
  });

  it('POST /__faults with a non-object or unparseable body is a 400, not a silent no-op', async () => {
    const { server: s } = await freshServer();
    const arr = await postJson(s.client, '/__faults', [1, 2, 3]);
    expect(arr.status).toBe(400);
    expect(((await arr.json()) as { rejected: string[] }).rejected).toHaveLength(1);
    const bad = await s.client.fetch('/__faults', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not valid json',
    });
    expect(bad.status).toBe(400);
    const text = await bad.text();
    expect(text).toContain('invalid request body');
    expect(text).not.toContain('node_modules');
  });

  it('POST /__faults merges valid keys and returns the new flags with an empty rejected list', async () => {
    const { server: s } = await freshServer();
    const client = createClient(s.baseUrl);
    const res = await postJson(client, '/__faults', { slowMs: 50, denyMember: '10001' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.slowMs).toBe(50);
    expect(body.denyMember).toBe('10001');
    expect(body.rejected).toEqual([]);
  });

  it('slowMs delays authenticated responses, but /__faults itself stays fast', async () => {
    const { server: s } = await freshServer();
    const client = await loginNewClient(s);
    // A wide gap between the injected delay and the fast-path bound, so a loaded machine cannot
    // close it: the delayed request takes 1.5 s, and /__faults only has to beat half of that.
    const setRes = await postJson(client, '/__faults', { slowMs: 1500 });
    expect(setRes.status).toBe(200);

    const t0 = performance.now();
    const res = await client.get('/members/search?memberId=12345');
    const elapsed = performance.now() - t0;
    expect(res.status).toBe(200);
    expect(elapsed).toBeGreaterThanOrEqual(1450);

    const t1 = performance.now();
    const faultsRes = await client.get('/__faults');
    const faultsElapsed = performance.now() - t1;
    expect(faultsRes.status).toBe(200);
    expect(faultsElapsed).toBeLessThan(750);
  });

  it('failSearch: GET /members/search returns 500 Application Error / ORA-01017; detail is unaffected', async () => {
    const { server: s } = await freshServer();
    const client = await loginNewClient(s);
    await postJson(client, '/__faults', { failSearch: true });

    const searchRes = await client.get('/members/search?memberId=12345');
    expect(searchRes.status).toBe(500);
    const searchBody = await searchRes.text();
    expect(searchBody).toContain('Application Error');
    expect(searchBody).toContain('ORA-01017');

    const detailRes = await client.get('/members/12345');
    expect(detailRes.status).toBe(200);
  });

  it('expireSession: next authenticated request redirects to /session-expired, clears the flag, and invalidates the session', async () => {
    const { server: s } = await freshServer();
    const client = await loginNewClient(s);
    await postJson(client, '/__faults', { expireSession: true });

    const res = await client.get('/workstation');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/session-expired');

    const flagsRes = await client.get('/__faults');
    const flags = (await flagsRes.json()) as Record<string, unknown>;
    expect(flags.expireSession).toBe(false);

    const afterRes = await client.get('/workstation');
    expect(afterRes.status).toBe(302);
    expect(afterRes.headers.get('location')).toBe('/login');
  });

  it('GET /session-expired shows the expiry text with a link to /login', async () => {
    const { server: s } = await freshServer();
    const client = createClient(s.baseUrl);
    const res = await client.get('/session-expired');
    expect(res.status).toBe(200);
    const body = await res.text();
    const stripped = body.replace(/<[^>]+>/g, '');
    expect(stripped).toContain('Your session has expired. Click here to log in.');
    expect(body).toMatch(/<a href="\/login"[^>]*>Click here<\/a>/);
  });

  it('denyMember: that id 403s on detail and sub-account-new; other members still 200; 99999 still 404', async () => {
    const { server: s } = await freshServer();
    const client = await loginNewClient(s);
    await postJson(client, '/__faults', { denyMember: '10001' });

    const deniedDetail = await client.get('/members/10001');
    expect(deniedDetail.status).toBe(403);
    expect(await deniedDetail.text()).toContain('Access Denied: your role does not permit viewing this member.');

    const deniedForm = await client.get('/members/10001/subaccounts/new');
    expect(deniedForm.status).toBe(403);

    const otherMember = await client.get('/members/10002');
    expect(otherMember.status).toBe(200);

    const notFound = await client.get('/members/99999');
    expect(notFound.status).toBe(404);
  });

  describe('maintenance interstitial', () => {
    it('shows once per session on the first main-content page, then not again', async () => {
      const { server: s } = await freshServer();
      const client = await loginNewClient(s);

      const first = await client.get('/members/search');
      const firstBody = await first.text();
      expect(firstBody).toContain('System Maintenance Notice');
      expect(firstBody).toContain('Scheduled maintenance Sunday 02:00');
      expect(firstBody).toMatch(/class="maint-ok"[^>]*>OK<\/div>/);

      const second = await client.get('/members/12345');
      const secondBody = await second.text();
      expect(secondBody).not.toContain('System Maintenance Notice');
    });

    it('a new login session sees the interstitial again', async () => {
      const { server: s } = await freshServer();
      const clientA = await loginNewClient(s);
      const firstBody = await (await clientA.get('/members/search')).text();
      expect(firstBody).toContain('System Maintenance Notice');

      const clientB = await loginNewClient(s);
      const secondSessionFirstPage = await (await clientB.get('/members/search')).text();
      expect(secondSessionFirstPage).toContain('System Maintenance Notice');
    });

    it('with interstitial:false, it never appears', async () => {
      const { server: s } = await freshServer();
      const client = await loginNewClient(s);
      await postJson(client, '/__faults', { interstitial: false });

      const body = await (await client.get('/members/search')).text();
      expect(body).not.toContain('System Maintenance Notice');
    });
  });

  it('POST /__reset restores default flags and a fresh seed (account gone, next ref back to SA-1000001)', async () => {
    const { server: s, app } = await freshServer();
    const client = await loginNewClient(s);
    await postJson(client, '/__faults', { slowMs: 20, denyMember: '10001', interstitial: false });

    const createRes = await postForm(client, '/members/12345/subaccounts', {
      accountType: 'SAV',
      nickname: 'Will Be Reset',
      initialDeposit: '100.00',
    });
    expect(createRes.status).toBe(302);
    expect(createRes.headers.get('location')).toBe('/members/12345/subaccounts/SA-1000001/confirmation');

    const resetRes = await postJson(client, '/__reset', {});
    expect(resetRes.status).toBe(200);

    const flagsRes = await client.get('/__faults');
    const flags = (await flagsRes.json()) as Record<string, unknown>;
    expect(flags).toEqual({
      slowMs: 0,
      failSearch: false,
      expireSession: false,
      interstitial: true,
      denyMember: '',
      chaos: null,
    });

    const ctx = getContext(app);
    const member = ctx.state.members.get('12345');
    if (!member) throw new Error('expected member 12345 to exist after reset');
    expect(member.accounts.some((a) => a.reference === 'SA-1000001' && a.nickname === 'Will Be Reset')).toBe(false);

    const recreateRes = await postForm(client, '/members/12345/subaccounts', {
      accountType: 'SAV',
      nickname: 'After Reset',
      initialDeposit: '100.00',
    });
    expect(recreateRes.status).toBe(302);
    expect(recreateRes.headers.get('location')).toBe('/members/12345/subaccounts/SA-1000001/confirmation');
  });
});

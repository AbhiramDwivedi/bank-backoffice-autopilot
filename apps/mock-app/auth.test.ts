import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import {
  DEFAULT_PASSWORD,
  SESSION_COOKIE,
  createClient,
  login,
  startTestApp,
  type TestServer,
} from './test-helpers.js';

describe('auth', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestApp(createApp({ tenant: 'a' }));
  });

  afterAll(async () => {
    await server.close();
  });

  it('POST /login with correct credentials sets the session cookie and redirects to /workstation', async () => {
    const client = createClient(server.baseUrl);
    const res = await login(client);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/workstation');
    expect(client.cookie(SESSION_COOKIE)).toBeTruthy();
  });

  it('POST /login with the wrong password re-renders login (200) with the error text', async () => {
    const client = createClient(server.baseUrl);
    const res = await login(client, { password: 'not-the-password' });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Invalid user ID or password.');
    expect(client.cookie(SESSION_COOKIE)).toBeUndefined();
  });

  it('POST /login with the wrong user ID also fails', async () => {
    const client = createClient(server.baseUrl);
    const res = await login(client, { userId: 'operator2' });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Invalid user ID or password.');
  });

  it('createApp({password}) overrides the default password', async () => {
    const overrideServer = await startTestApp(createApp({ tenant: 'a', password: 'custom-pass-999' }));
    try {
      const client = createClient(overrideServer.baseUrl);
      const withDefaultPassword = await login(client, { password: DEFAULT_PASSWORD });
      expect(withDefaultPassword.status).toBe(200);
      expect(await withDefaultPassword.text()).toContain('Invalid user ID or password.');

      const withOverridePassword = await login(client, { password: 'custom-pass-999' });
      expect(withOverridePassword.status).toBe(302);
      expect(withOverridePassword.headers.get('location')).toBe('/workstation');
    } finally {
      await overrideServer.close();
    }
  });

  it('GET / redirects to /login when logged out, and to /workstation once logged in', async () => {
    const client = createClient(server.baseUrl);

    const loggedOut = await client.get('/');
    expect(loggedOut.status).toBe(302);
    expect(loggedOut.headers.get('location')).toBe('/login');

    await login(client);

    const loggedIn = await client.get('/');
    expect(loggedIn.status).toBe(302);
    expect(loggedIn.headers.get('location')).toBe('/workstation');
  });

  it('GET /logout clears the session so the next request is gated back to /login', async () => {
    const client = createClient(server.baseUrl);
    await login(client);

    const logoutRes = await client.get('/logout');
    expect(logoutRes.status).toBe(302);
    expect(logoutRes.headers.get('location')).toBe('/login');

    const after = await client.get('/workstation');
    expect(after.status).toBe(302);
    expect(after.headers.get('location')).toBe('/login');
  });

  describe('auth gate: unauthenticated requests redirect to /login', () => {
    const protectedPaths = [
      '/members/search',
      '/members/12345',
      '/workstation',
      '/members/12345/subaccounts/new',
      '/frames/banner',
      '/frames/nav',
    ];

    for (const path of protectedPaths) {
      it(`GET ${path}`, async () => {
        const client = createClient(server.baseUrl);
        const res = await client.get(path);
        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toBe('/login');
      });
    }
  });

  describe('login page hostility (1998 era)', () => {
    it('has no <label> element anywhere', async () => {
      const client = createClient(server.baseUrl);
      const res = await client.get('/login');
      const body = await res.text();
      expect(body).not.toMatch(/<label/i);
    });

    it('submits via an <input type="image"> with no alt attribute', async () => {
      const client = createClient(server.baseUrl);
      const res = await client.get('/login');
      const body = await res.text();
      const match = /<input[^>]*type="image"[^>]*>/i.exec(body);
      expect(match).not.toBeNull();
      expect(match?.[0] ?? '').not.toMatch(/\balt\s*=/i);
    });
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { loginNewClient, startTestApp, type TestClient, type TestServer } from './test-helpers.js';

describe('workstation shell (tenant A: frameset)', () => {
  let server: TestServer;
  let client: TestClient;

  beforeAll(async () => {
    server = await startTestApp(createApp({ tenant: 'a' }));
    client = await loginNewClient(server);
  });

  afterAll(async () => {
    await server.close();
  });

  it('GET /workstation renders a <frameset> with banner, nav and main (main src /members/search)', async () => {
    const res = await client.get('/workstation');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toMatch(/<frameset/i);
    expect(body).toMatch(/<frame name="banner"/i);
    expect(body).toMatch(/<frame name="nav"/i);
    expect(body).toMatch(/<frame name="main" src="\/members\/search"/i);
  });

  it('GET /frames/banner shows the tenant institution name', async () => {
    const res = await client.get('/frames/banner');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Pioneer Valley Community CU');
  });

  it('GET /frames/nav is a table of links targeting main, with Member Search and Log Off (target _top)', async () => {
    const res = await client.get('/frames/nav');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toMatch(/<a href="\/members\/search" target="main">Member Search<\/a>/);
    expect(body).toMatch(/<a href="\/logout" target="_top">Log Off<\/a>/);
  });
});

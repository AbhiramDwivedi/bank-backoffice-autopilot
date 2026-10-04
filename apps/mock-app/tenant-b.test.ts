import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { loginNewClient, postForm, startTestApp, type TestClient, type TestServer } from './test-helpers.js';

describe('tenant B (Riverbend Federal Credit Union)', () => {
  let server: TestServer;
  let client: TestClient;

  beforeAll(async () => {
    server = await startTestApp(createApp({ tenant: 'b' }));
    client = await loginNewClient(server);
  });

  afterAll(async () => {
    await server.close();
  });

  it('search label is "Member #", not "Member ID"', async () => {
    const res = await client.get('/members/search?memberId=12345');
    const body = await res.text();
    expect(body).toContain('Member #');
    expect(body).not.toContain('Member ID');
  });

  it('/workstation uses an <iframe name="main"> inside a table, no <frameset>', async () => {
    const res = await client.get('/workstation');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toMatch(/<frameset/i);
    expect(body).toMatch(/<iframe name="main"/i);
  });

  it('banner shows "Riverbend Federal Credit Union"', async () => {
    const res = await client.get('/frames/banner');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Riverbend Federal Credit Union');
  });

  it('sub-account form has a branch code input labelled "Branch code"', async () => {
    const res = await client.get('/members/12345/subaccounts/new');
    const body = await res.text();
    expect(body).toMatch(/name="branchCode"/);
    expect(body).toContain('Branch code');
  });

  it('POST without branchCode: "Branch code is required."', async () => {
    const res = await postForm(client, '/members/12345/subaccounts', {
      accountType: 'SAV',
      nickname: 'No Branch',
      initialDeposit: '100.00',
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Branch code is required.');
  });

  it('POST with a malformed branchCode: "Branch code must be 3 digits."', async () => {
    const res = await postForm(client, '/members/12345/subaccounts', {
      accountType: 'SAV',
      nickname: 'Bad Branch',
      initialDeposit: '100.00',
      branchCode: '12',
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Branch code must be 3 digits.');
  });

  it('POST with branchCode 001: 302 to confirmation', async () => {
    const res = await postForm(client, '/members/12345/subaccounts', {
      accountType: 'SAV',
      nickname: 'With Branch',
      initialDeposit: '100.00',
      branchCode: '001',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toMatch(/^\/members\/12345\/subaccounts\/SA-\d{7}\/confirmation$/);
  });
});

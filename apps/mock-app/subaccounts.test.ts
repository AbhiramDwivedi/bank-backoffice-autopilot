import type { Express } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, getContext } from './app.js';
import { loginNewClient, postForm, startTestApp, type TestClient, type TestServer } from './test-helpers.js';

describe('sub-account form (tenant A, no branch code required)', () => {
  let app: Express;
  let server: TestServer;
  let client: TestClient;

  beforeAll(async () => {
    app = createApp({ tenant: 'a' });
    server = await startTestApp(app);
    client = await loginNewClient(server);
  });

  afterAll(async () => {
    await server.close();
  });

  it('GET form: no <select>, hidden accountType input, custom <ul><li data-value=> dropdown, modal ids, unsaved-changes text', async () => {
    const res = await client.get('/members/12345/subaccounts/new');
    expect(res.status).toBe(200);
    const body = await res.text();
    // Strip <style> blocks first: they contain a code comment that mentions "<select>" in
    // prose ("no <select> in this era"), which is not a real <select> element.
    const bodyOutsideStyle = body.replace(/<style[\s\S]*?<\/style>/gi, '');
    expect(bodyOutsideStyle).not.toMatch(/<select[ >]/i);
    expect(body).toMatch(/<input type="hidden" name="accountType" id="hidAcctType" value="[^"]*">/);
    expect(body).toMatch(/<ul[^>]*>/);
    expect(body).toMatch(/<li data-value="SAV"/);
    expect(body).toMatch(/<li data-value="CHK"/);
    expect(body).toContain('id="cfmBackdrop"');
    expect(body).toContain('id="cfmModal"');
    expect(body).toContain('You have unsaved changes. Leave this page?');
  });

  it('POST with nothing selected/entered: 200 + errors list for account type and deposit', async () => {
    const res = await postForm(client, '/members/12345/subaccounts', {
      accountType: '',
      nickname: '',
      initialDeposit: '',
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toMatch(/<ul class="errors">/);
    expect(body).toContain('Please select an account type.');
    expect(body).toContain('Initial deposit must be a number.');
  });

  it('POST with deposit "10" (below minimum): "Initial deposit must be at least $25.00"', async () => {
    const res = await postForm(client, '/members/12345/subaccounts', {
      accountType: 'SAV',
      nickname: 'Too Small',
      initialDeposit: '10',
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Initial deposit must be at least $25.00');
    expect(body).not.toContain('Please select an account type.');
  });

  it('POST with deposit "abc" (non-numeric): "Initial deposit must be a number."', async () => {
    const res = await postForm(client, '/members/12345/subaccounts', {
      accountType: 'SAV',
      nickname: 'Not A Number',
      initialDeposit: 'abc',
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Initial deposit must be a number.');
  });

  it('preserves submitted values in the re-rendered form', async () => {
    const res = await postForm(client, '/members/12345/subaccounts', {
      accountType: 'MMA',
      nickname: 'My Nickname',
      initialDeposit: '5',
    });
    const body = await res.text();
    expect(body).toContain('value="My Nickname"');
    expect(body).toContain('value="5"');
    expect(body).toMatch(/<input type="hidden" name="accountType" id="hidAcctType" value="MMA">/);
  });

  it('valid POST creates SA-1000001, redirects to confirmation, mutates state, and lists on Accounts tab', async () => {
    const postRes = await postForm(client, '/members/12345/subaccounts', {
      accountType: 'SAV',
      nickname: 'Vacation Fund',
      initialDeposit: '100.00',
    });
    expect(postRes.status).toBe(302);
    expect(postRes.headers.get('location')).toBe('/members/12345/subaccounts/SA-1000001/confirmation');

    const confirmRes = await client.get('/members/12345/subaccounts/SA-1000001/confirmation');
    expect(confirmRes.status).toBe(200);
    const confirmBody = await confirmRes.text();
    expect(confirmBody).toContain('Sub-account opened successfully.');
    expect(confirmBody).toMatch(/<td><b>SA-1000001<\/b><\/td>/);
    expect(confirmBody).toMatch(/SA-\d{7}/);
    expect(confirmBody).toContain('Return to member');

    const ctx = getContext(app);
    const member = ctx.state.members.get('12345');
    if (!member) throw new Error('expected member 12345 to exist');
    const created = member.accounts.find((a) => a.reference === 'SA-1000001');
    expect(created).toBeDefined();
    expect(created?.nickname).toBe('Vacation Fund');

    const detailRes = await client.get('/members/12345?tab=accounts');
    const detailBody = await detailRes.text();
    expect(detailBody).toContain('Vacation Fund');

    const secondPostRes = await postForm(client, '/members/12345/subaccounts', {
      accountType: 'CD',
      nickname: 'Second One',
      initialDeposit: '50.00',
    });
    expect(secondPostRes.status).toBe(302);
    expect(secondPostRes.headers.get('location')).toBe('/members/12345/subaccounts/SA-1000002/confirmation');
  });
});

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { expect, test } from '@playwright/test';
import { createApp } from '../app.js';

const USER_ID = 'operator1';
const PASSWORD = 'demo-pass-123';

let server: Server;
let baseUrl: string;

test.beforeAll(async () => {
  const app = createApp({ tenant: 'a' });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', reject);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected server.address() to return an AddressInfo');
  }
  baseUrl = `http://127.0.0.1:${(address as AddressInfo).port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

test('happy path through the frameset: login, search, detail, open sub-account, confirm', async ({ page }) => {
  await page.goto(`${baseUrl}/login`);
  await page.locator('input[name="userId"]').fill(USER_ID);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('input[type="image"]').click();
  await page.waitForURL(`${baseUrl}/workstation`);

  // The institution's monitoring tag (@cu/browser-agent) is installed on the logged-in shell.
  const agentVersion = await page.evaluate(
    () => (window as unknown as { __cuAgent?: { version: string } }).__cuAgent?.version,
  );
  expect(agentVersion).toBeTruthy();

  const main = page.frameLocator('frame[name="main"]');

  // Dismiss the maintenance interstitial (shown once per session, default ON).
  await main.locator('.maint-ok').click();

  // Search for member 12345.
  await main.locator('input[name="memberId"]').fill('12345');
  await main.locator('div.btn', { hasText: 'Search' }).click();

  // Click the result row (row onclick navigates; there's no anchor).
  await main.locator('tr[onclick*="/members/12345"]').click();

  // Profile tab: savings balance next to its label.
  const savingsRow = main.locator('tr', { hasText: 'Savings Balance' });
  await expect(savingsRow).toContainText('$1,234.56');

  // Accounts tab -> Open New Sub-Account.
  await main.locator('#tabAccounts').click();
  await main.locator('a', { hasText: 'Open New Sub-Account' }).click();

  // Custom dropdown (no <select>): open it, choose Share Savings.
  await main.locator('.cw-dd-toggle').click();
  await main.locator('li[data-value="SAV"]').click();

  await main.locator('input[name="nickname"]').fill('Vacation Fund');
  await main.locator('input[name="initialDeposit"]').fill('100.00');

  await main.locator('#btnContinue').click();
  await expect(main.locator('#cfmModal')).toBeVisible();
  await main.locator('#cfmOk').click();

  await expect(main.locator('body')).toContainText('Sub-account opened successfully.');
  const refLocator = main.locator('b').filter({ hasText: /^SA-\d{7}$/ });
  await expect(refLocator).toBeVisible();
  const refText = (await refLocator.innerText()).trim();
  expect(refText).toMatch(/^SA-\d{7}$/);
});

test('unsaved changes on the sub-account form triggers a native confirm dialog on nav away', async ({ page }) => {
  await page.goto(`${baseUrl}/login`);
  await page.locator('input[name="userId"]').fill(USER_ID);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('input[type="image"]').click();
  await page.waitForURL(`${baseUrl}/workstation`);

  const main = page.frameLocator('frame[name="main"]');
  await main.locator('.maint-ok').click();

  await main.locator('input[name="memberId"]').fill('12345');
  await main.locator('div.btn', { hasText: 'Search' }).click();
  await main.locator('tr[onclick*="/members/12345"]').click();
  await main.locator('#tabAccounts').click();
  await main.locator('a', { hasText: 'Open New Sub-Account' }).click();

  await main.locator('input[name="nickname"]').fill('Dirty Draft');

  // Dialogs raised from inside a frame are still emitted on the top-level page.
  let dialogMessage = '';
  page.once('dialog', (dialog) => {
    dialogMessage = dialog.message();
    void dialog.dismiss();
  });

  await main.locator('a', { hasText: 'Member Search' }).click();

  await expect.poll(() => dialogMessage).toBe('You have unsaved changes. Leave this page?');
  // Dismissed (Cancel) -> navigation was cancelled -> still on the form with the value intact.
  await expect(main.locator('input[name="nickname"]')).toHaveValue('Dirty Draft');
});

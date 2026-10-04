/**
 * Screenshot masking of typed values (`maskInputs: 'typed'`, mask.ts): a typed value is painted
 * over in every screenshot, including observe()'s, and after the page re-renders the field;
 * password fields always are; untouched fields are not. Pixels are counted over the whole PNG:
 * typed values and passwords are drawn in the PII colour, the untouched field in blue.
 */
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveScreenMask } from '@cu/core/schema';
import { createPlaywrightSurface, type PlaywrightSurface } from './surface.js';
import { countColor, startFixtureServer, type FixtureServer } from './test-helpers.js';

/** Today's typed-only behaviour: the default (`maskInputs: 'all'`) would also paint the pre-filled nickname. */
const TYPED_ONLY = { config: { ...resolveScreenMask(undefined), maskInputs: 'typed' as const }, textPatterns: [] };
const BLUE: readonly [number, number, number] = [0, 0, 255];

let browser: Browser;
let fixtures: FixtureServer;
let surface: PlaywrightSurface | undefined;
let decoder: Page;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  fixtures = await startFixtureServer();
  decoder = await (await browser.newContext()).newPage();
});

afterAll(async () => {
  await browser.close();
  await fixtures.close();
});

afterEach(async () => {
  await surface?.close();
  surface = undefined;
});

const typeUser = (s: PlaywrightSurface) =>
  s.act(
    { type: 'type', target: { description: 'user id', frame: [], locators: [{ strategy: { kind: 'css', selector: '#user' }, confidence: 0.3, source: 'recorded' }] }, value: 'MOCK_USER_SECRET_42' },
    5000,
  );

describe('screenshot masking of typed values', () => {
  it('paints over a typed field and the password field, leaves the untouched field, and leaves no mark in the page', async () => {
    surface = await createPlaywrightSurface({ browser, viewport: { width: 800, height: 600 }, screenMask: TYPED_ONLY });
    await surface.act({ type: 'navigate', url: fixtures.url('mask-fields.html') }, 5000);

    expect(await countColor(decoder, await surface.screenshot()), 'the password is never visible').toBe(0);
    // Control: typed into but captured by Playwright with no mask, the value shows.
    expect((await typeUser(surface)).ok).toBe(true);
    expect(await countColor(decoder, await surface.page.screenshot())).toBeGreaterThan(100);

    const after = await surface.screenshot();
    expect(await countColor(decoder, after)).toBe(0);
    expect(await countColor(decoder, after, BLUE), 'the untouched field stays visible').toBeGreaterThan(100);
    expect(await countColor(decoder, (await surface.observe()).screenshotPng!)).toBe(0);
    expect(await surface.page.evaluate(() => document.querySelectorAll('[data-cu-mask]').length)).toBe(0);
  });

  it('still masks the value after the page re-renders the field as a new element', async () => {
    surface = await createPlaywrightSurface({ browser, viewport: { width: 800, height: 600 }, screenMask: TYPED_ONLY });
    await surface.act({ type: 'navigate', url: fixtures.url('mask-fields.html') }, 5000);
    await typeUser(surface);
    await surface.page.evaluate(() => {
      const old = document.getElementById('user') as HTMLInputElement;
      const fresh = document.createElement('input');
      fresh.id = 'user';
      fresh.type = 'text';
      fresh.value = old.value;
      old.replaceWith(fresh);
    });
    expect(await countColor(decoder, await surface.screenshot())).toBe(0);
  });
});

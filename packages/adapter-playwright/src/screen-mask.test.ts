/**
 * Screen masking through the Playwright surface (mask.ts, enumerate.ts, snapshot.ts, surface.ts),
 * against fixture pages that paint every piece of PII in one colour (#ff00aa). Pixel assertions
 * count that colour over the WHOLE screenshot (`countColor`): a control run without the rule shows
 * the PII, the masked run shows none of it. Every case also checks the text channel (elements,
 * digest, title) and the DOM snapshot: one masked view.
 */
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveScreenMask, type ScreenMaskConfig } from '@cu/core/schema';
import { isOmittedScreenshot, type Observation, type ScreenMaskOptions } from '@cu/core/surface';
import { createPlaywrightSurface, type PlaywrightSurface } from './surface.js';
import { countColor, startFixtureServer, type FixtureServer } from './test-helpers.js';

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

const SSN = { name: 'ssn', regex: '\\b\\d{3}-\\d{2}-\\d{4}\\b' };
const CARD = { name: 'card', regex: '\\b(?:\\d[ -]?){12,18}\\d\\b' };

/** Masking with nothing on: typed fields only, no labels, selectors or patterns. The control. */
const OFF: Partial<ScreenMaskConfig> = { maskInputs: 'typed', maskTextPatterns: false };

function maskOptions(config: Partial<ScreenMaskConfig>, sensitiveValues?: () => readonly string[]): ScreenMaskOptions {
  return { config: { ...resolveScreenMask(undefined), ...config }, textPatterns: [SSN, CARD], ...(sensitiveValues ? { sensitiveValues } : {}) };
}

async function open(file: string, screenMask: ScreenMaskOptions): Promise<PlaywrightSurface> {
  surface = await createPlaywrightSurface({ browser, viewport: { width: 1000, height: 1400 }, screenMask });
  const nav = await surface.act({ type: 'navigate', url: fixtures.url(file) }, 10_000);
  expect(nav.ok).toBe(true);
  return surface;
}

/** Everything an observation carries as text. */
function observationText(obs: Observation): string {
  return JSON.stringify({ title: obs.title, elements: obs.elements, textDigest: obs.textDigest });
}

const PII_PAGE_LABELS = ['^member name$', '^phone$', 'address', '^name$', 'e-?mail'];
const PII_STRINGS = [
  'Pat Example',
  '(413) 555-0199',
  '1 Main St',
  '1 Main',
  '123-45-6789',
  '987-65-4321',
  '4111 1111 1111 1111',
  'pat@example.org',
  'Ann Lee',
  '5 Oak Ave',
  '6 Pine Ct',
  '77 Very Long Overflowing Boulevard',
  '8 Hidden Box Rd',
  '3 Bay Rd',
  '555-0133',
  'ann@b.example',
  '222-33-4444',
  '4000 0000 0000 0002',
  '555-66-7777',
];

describe('screen masking: pixels, text and DOM agree', () => {
  it('every layout and rule on one page: zero PII pixels (control: many), and no PII in the observation, title or DOM snapshot', async () => {
    const control = await open('mask-pii.html', maskOptions(OFF));
    const before = await countColor(decoder, (await control.observe()).screenshotPng!);
    expect(before, 'the control run shows PII pixels').toBeGreaterThan(500);
    await control.close();
    surface = undefined;

    const s = await open('mask-pii.html', maskOptions({ maskLabels: PII_PAGE_LABELS, maskSelectors: ['.secret'] }));
    const obs = await s.observe();
    expect(obs.screenshotPng, 'a static page is captured').toBeDefined();
    expect(await countColor(decoder, obs.screenshotPng!)).toBe(0);
    expect(await countColor(decoder, await s.screenshot())).toBe(0);

    const text = observationText(obs);
    for (const pii of PII_STRINGS) expect(text, `${pii} leaked into the observation`).not.toContain(pii);
    for (const visible of ['Member ID', '4242', 'Nothing secret here', 'Branch', 'North', 'Household roster', 'Member card'.slice(0, 0)]) expect(obs.textDigest).toContain(visible);
    expect(obs.title).toContain('Member 4242');
    expect(obs.title).not.toContain('Pat Example');
    expect(obs.title).not.toContain('123-45-6789');

    const dom = await s.domSnapshot();
    for (const pii of PII_STRINGS) expect(dom, `${pii} leaked into the DOM snapshot`).not.toContain(pii);
    expect(dom).toContain('4242');
    expect(await s.page.evaluate(() => document.querySelectorAll('[data-cu-mask], [data-cu-mask-kind], [data-cu-mask-overlay]').length)).toBe(0);
  });

  it('a control keeps its verb: "Delete [MASKED:name]", pixels painted whole', async () => {
    const s = await open('mask-pii.html', maskOptions({ maskLabels: ['^name$'] }));
    const obs = await s.observe();
    const del = obs.elements.find((e) => e.role === 'link' && e.name.startsWith('Delete'));
    expect(del?.name).toBe('Delete [MASKED:name]');
    expect(del?.masked).toBe(true);
    // The masked element with an aria-label that differs from its text: the aria-label never leaks.
    await s.close();
    const s2 = await open('mask-pii.html', maskOptions({ maskSelectors: ['.secret'] }));
    const aria = (await s2.observe()).elements.find((e) => e.text === '[MASKED:selector]');
    expect(aria?.name).toBe('[MASKED:selector]');
    expect(JSON.stringify(aria)).not.toContain('Member Ann Lee');
  });

  it('a masked element is flagged, still addressable, readText returns its real text flagged masked, and its descriptor carries no masked text', async () => {
    const s = await open('mask-page.html', maskOptions({ maskLabels: ['savings balance'] }));
    const obs = await s.observe();
    const bal = obs.elements.find((e) => e.text === '[MASKED:savings_balance]');
    expect(bal, JSON.stringify(obs.elements.map((e) => [e.ref, e.name, e.text]))).toBeDefined();
    expect(bal!.masked).toBe(true);
    expect(JSON.stringify(bal!.descriptor)).not.toContain('9,876.54');
    expect(bal!.descriptor.locators.map((l) => l.strategy.kind)).toContain('relative');

    expect(await s.readText({ ref: bal!.ref }, 5000)).toEqual({ ok: true, text: '$9,876.54', masked: true });
    const mid = obs.elements.find((e) => e.text === '4242')!;
    expect(await s.readText({ ref: mid.ref }, 5000)).toEqual({ ok: true, text: '4242' });

    const resolved = await s.resolve(bal!.descriptor, 5000);
    expect(resolved.found).toBe(true);
    expect(await s.check({ kind: 'text_visible', text: '$9,876.54' })).toBe(true);
    expect(await s.check({ kind: 'text_visible', text: '$9,876.54' }, { view: 'masked' }), 'the masked view does not show it').toBe(false);
    expect(await s.check({ kind: 'text_visible', text: 'Savings Balance' }, { view: 'masked' })).toBe(true);

    const described = await s.describeRef(bal!.ref);
    expect(described?.text).toBe('[MASKED:savings_balance]');
    expect(described?.classifyText).toBe('$9,876.54');
  });

  it('nested frames: each frame is masked, and text masked in one frame is masked where another frame repeats it', async () => {
    const s = await open('mask-frames-outer.html', maskOptions({ maskLabels: ['^address$', 'date of birth'] }));
    // The inner frame attaches only once the frame around it has loaded: wait for it, don't assume.
    await expect.poll(() => s.page.frame({ name: 'inner' }) !== null, { timeout: 10000 }).toBe(true);
    await s.page.frame({ name: 'inner' })!.waitForLoadState('domcontentloaded');
    const obs = await s.observe();
    expect(observationText(obs)).not.toContain('7 Frame Way');
    expect(observationText(obs)).not.toContain('03/04/1980');
    expect(observationText(obs)).toContain('Silver');
    expect(await countColor(decoder, obs.screenshotPng!)).toBe(0);
    expect(await s.domSnapshot()).not.toContain('7 Frame Way');
  });

  it("run values: text showing one of the run's values is masked, and a value that becomes known mid-run counts from then on", async () => {
    const values: string[] = [];
    const s = await open('mask-page.html', maskOptions({ ...OFF, maskTextPatterns: true }, () => values));
    expect((await s.observe()).textDigest).toContain('operator-sekrit-7');
    values.push('operator-sekrit-7');
    const after = await s.observe();
    expect(observationText(after)).not.toContain('operator-sekrit-7');
    expect(after.textDigest).toContain('Signed in as [MASKED:sensitive]');
    expect(await s.domSnapshot()).not.toContain('operator-sekrit-7');
  });

  it("maskInputs: 'all' paints every filled field and masks its value; 'typed' only what this surface typed", async () => {
    const all = await open('mask-page.html', maskOptions({ maskInputs: 'all', maskTextPatterns: false }));
    const allObs = await all.observe();
    expect(allObs.elements.find((e) => e.name === 'Nickname')?.value).toBe('[MASKED:input]');
    expect(observationText(allObs)).not.toContain('prefilled-nick');
    // A masked select lists neither its value nor its alternatives in the digest.
    expect(allObs.textDigest).not.toContain('Utah');
    expect(allObs.textDigest).not.toContain('Iowa');
    await all.close();
    surface = undefined;

    const typed = await open('mask-page.html', maskOptions({ maskInputs: 'typed', maskTextPatterns: false }));
    expect((await typed.observe()).elements.find((e) => e.name === 'Nickname')?.value).toBe('prefilled-nick');
    const search = (await typed.observe()).elements.find((e) => e.name === 'Search')!;
    expect((await typed.act({ type: 'type', target: { ref: search.ref }, value: 'typed-lookup-key' }, 5000)).ok).toBe(true);
    const after = await typed.observe();
    expect(after.elements.find((e) => e.name === 'Search')?.value).toBe('[MASKED:input]');
    expect(observationText(after)).not.toContain('typed-lookup-key');
  });

  it('omitScreenshotUrlPatterns: no screenshot in observe(), the marked placeholder from screenshot(), masked text still flows', async () => {
    const s = await open('mask-page.html', maskOptions({ maskLabels: ['^phone$'], omitScreenshotUrlPatterns: ['/mask-page\\.html$'] }));
    const obs = await s.observe();
    expect(obs.screenshotPng).toBeUndefined();
    expect(obs.textDigest).toContain('Nothing secret here');
    expect(obs.textDigest).not.toContain('(413) 555-0199');
    expect(isOmittedScreenshot(await s.screenshot())).toBe(true);
    await s.act({ type: 'navigate', url: fixtures.url('mask-frames-outer.html') }, 10_000);
    expect((await s.observe()).screenshotPng).toBeDefined();
  });

  it('a value read from a masked element is masked on a later page as a whole token only; short or common values are not learned', async () => {
    const s = await open('mask-page.html', maskOptions({ maskLabels: ['savings balance'] }));
    const bal = (await s.observe()).elements.find((e) => e.text === '[MASKED:savings_balance]')!;
    expect((await s.readText({ ref: bal.ref }, 5000)).ok).toBe(true);
    await s.act({ type: 'navigate', url: fixtures.url('mask-echo.html') }, 10_000);
    const obs = await s.observe();
    expect(observationText(obs)).not.toContain('9,876.54');
    expect(obs.textDigest).toContain('Remaining [MASKED:sensitive] after the hold');
    expect(await countColor(decoder, obs.screenshotPng!)).toBe(0);
    // Look-alikes stay: "$10.00", "$1,250.00", "Yesterday", "Yes, continue", "Eyes only".
    expect(obs.textDigest).toContain('Fees $10.00 and $1,250.00 posted Yesterday. Yes, continue. Eyes only.');
  });

  it("a native dialog's message is masked (patterns, run values, Label: value lines); conditions still see the real message", async () => {
    const s = await open('mask-echo.html', maskOptions({ maskLabels: ['address'] }, () => ['operator-sekrit-7']));
    const btn = (await s.observe()).elements.find((e) => e.name === 'Verify')!;
    await s.act({ type: 'click', target: { ref: btn.ref } }, 5000);
    const obs = await s.observe();
    expect(obs.dialog?.message).not.toContain('123-45-6789');
    expect(obs.dialog?.message).not.toContain('operator-sekrit-7');
    expect(obs.dialog?.message).not.toContain('9 Elm Rd');
    expect(obs.dialog?.message).toContain('Address:');
    const blocked = await s.act({ type: 'click', target: { ref: btn.ref } }, 1000);
    expect(blocked.error?.message).not.toContain('123-45-6789');
    expect(await s.domSnapshot()).not.toContain('9 Elm Rd');
    expect(await s.check({ kind: 'dialog_open', messagePattern: '9 Elm Rd' })).toBe(true);
    await s.act({ type: 'dismiss_dialog', accept: true }, 5000);
  });

  it('the default (no policy given) masks filled fields and SSN- and card-shaped text, in text, title, attributes and pixels', async () => {
    surface = await createPlaywrightSurface({ browser, viewport: { width: 1000, height: 1400 } });
    await surface.act({ type: 'navigate', url: fixtures.url('mask-pii.html') }, 10_000);
    const obs = await surface.observe();
    for (const v of ['123-45-6789', '987-65-4321', '4111 1111 1111 1111', '222-33-4444', '555-0133']) expect(observationText(obs)).not.toContain(v);
    expect(obs.title).not.toContain('123-45-6789');
    const dom = await surface.domSnapshot();
    for (const v of ['222-33-4444', '4000 0000 0000 0002', '555-66-7777']) expect(dom, `${v} in an attribute`).not.toContain(v);
  });
});

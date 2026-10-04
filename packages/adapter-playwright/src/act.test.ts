import { chromium, type Browser } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { TargetDescriptor } from '@cu/core/schema';
import { createPlaywrightSurface, type PlaywrightSurface } from './surface.js';
import { startFixtureServer, type FixtureServer } from './test-helpers.js';

let browser: Browser;
let fixtures: FixtureServer;
const surfaces: PlaywrightSurface[] = [];

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  fixtures = await startFixtureServer();
});

afterAll(async () => {
  await browser.close();
  await fixtures.close();
});

afterEach(async () => {
  while (surfaces.length > 0) {
    const s = surfaces.pop()!;
    await s.close().catch(() => undefined);
  }
});

async function newSurface(path: string): Promise<PlaywrightSurface> {
  const surface = await createPlaywrightSurface({ browser, baseUrl: fixtures.baseUrl });
  surfaces.push(surface);
  const nav = await surface.act({ type: 'navigate', url: fixtures.url(path) }, 5000);
  if (!nav.ok) throw new Error(`fixture navigation failed: ${JSON.stringify(nav.error)}`);
  return surface;
}

function target(locators: TargetDescriptor['locators'], frame: TargetDescriptor['frame'] = []): TargetDescriptor {
  return { description: 'test target', frame, locators };
}

describe('act() via PlaywrightSurface', () => {
  it('types into an adjacent-cell label field via a resolved ref, then reads it back', async () => {
    const surface = await newSurface('resolve-search.html');
    const t = target([{ strategy: { kind: 'label', label: 'Member ID' }, confidence: 0.8, source: 'inferred' }]);
    const resolved = await surface.resolve(t, 10_000);
    expect(resolved.found).toBe(true);
    if (!resolved.found) return;
    expect(resolved.strategyKind).toBe('label');

    const typed = await surface.act({ type: 'type', target: { ref: resolved.ref }, value: '12345', clear: true }, 10_000);
    expect(typed.ok).toBe(true);

    const read = await surface.readText({ ref: resolved.ref }, 10_000);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.text).toBe('12345');
  });

  it('clicks a tr[onclick] row found via the text strategy (climbing from the td) and reports navigation', async () => {
    const surface = await newSurface('resolve-search.html');
    const t = target([{ strategy: { kind: 'text', text: '12345' }, confidence: 0.6, source: 'recorded' }]);
    const result = await surface.act({ type: 'click', target: t }, 10_000);
    expect(result.ok).toBe(true);
    expect(result.navigated).toBe(true);
    expect(await surface.currentUrl()).toMatch(/resolve-detail\.html$/);
  });

  it('clicks a div.btn found via the text strategy and observes the effect', async () => {
    const surface = await newSurface('resolve-search.html');
    const t = target([{ strategy: { kind: 'text', text: 'Search', tag: 'div' }, confidence: 0.6, source: 'recorded' }]);
    const result = await surface.act({ type: 'click', target: t }, 10_000);
    expect(result.ok).toBe(true);
    const status = await surface.page.locator('#searchStatus').innerText();
    expect(status).toBe('searched');
  });

  it('clicks a span tab found via the text strategy and observes the panel switch', async () => {
    const surface = await newSurface('resolve-detail.html');
    const t = target([{ strategy: { kind: 'text', text: 'Accounts', tag: 'span' }, confidence: 0.6, source: 'recorded' }]);
    const result = await surface.act({ type: 'click', target: t }, 10_000);
    expect(result.ok).toBe(true);
    const display = await surface.page.locator('#pnlAccounts').evaluate((el) => (el as HTMLElement).style.display);
    expect(display).toBe('');
    const cls = await surface.page.locator('#tabAccounts').getAttribute('class');
    expect(cls).toContain('tab-on');
  });

  it('picks a custom <ul><li data-value> dropdown option and writes the hidden input', async () => {
    const surface = await newSurface('resolve-dropdown.html');
    const t = target([{ strategy: { kind: 'css', selector: '#ddToggle' }, confidence: 0.4, source: 'recorded' }]);
    const result = await surface.act({ type: 'select', target: t, value: 'Checking' }, 10_000);
    expect(result.ok).toBe(true);
    const value = await surface.page.locator('#hidAcctType').inputValue();
    expect(value).toBe('CHK');
  });

  it('selects a native <select> option by label', async () => {
    const surface = await newSurface('resolve-dropdown.html');
    const t = target([{ strategy: { kind: 'css', selector: '#nativeSelect' }, confidence: 0.4, source: 'recorded' }]);
    const result = await surface.act({ type: 'select', target: t, value: 'Checking' }, 10_000);
    expect(result.ok).toBe(true);
    const value = await surface.page.locator('#nativeSelect').inputValue();
    expect(value).toBe('CHK');
  });

  it('reads a label/value cell resolved via the relative strategy', async () => {
    const surface = await newSurface('resolve-detail.html');
    const t = target([
      { strategy: { kind: 'relative', anchor: { text: 'Savings Balance' }, relation: 'right-of', tag: 'td' }, confidence: 0.5, source: 'inferred' },
    ]);
    const read = await surface.readText(t, 10_000);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.text).toBe('$1,234.56');
  });

  it('reads a plain text input', async () => {
    const surface = await newSurface('resolve-detail.html');
    const t = target([{ strategy: { kind: 'css', selector: '#nicknameInput' }, confidence: 0.4, source: 'recorded' }]);
    const read = await surface.readText(t, 10_000);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.text).toBe("Jane's Savings");
  });

  it('refuses to read a password field', async () => {
    const surface = await newSurface('resolve-detail.html');
    const t = target([{ strategy: { kind: 'css', selector: '#pinInput' }, confidence: 0.4, source: 'recorded' }]);
    const read = await surface.readText(t, 10_000);
    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(read.error.code).toBe('input_validation');
      expect(read.error.message).not.toMatch(/secret123/);
    }
  });

  it('maps a not-found target to element_not_found', async () => {
    const surface = await newSurface('resolve-search.html');
    const t = target([{ strategy: { kind: 'css', selector: '#does-not-exist' }, confidence: 0.3, source: 'recorded' }]);
    const result = await surface.act({ type: 'click', target: t }, 300);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error?.code).toBe('element_not_found');
  });
});

describe('readRecordText() via PlaywrightSurface', () => {
  const css = (selector: string): TargetDescriptor => target([{ strategy: { kind: 'css', selector }, confidence: 0.5, source: 'inferred' }]);

  it("reads the card that holds the value: its own numbers, not the other card's, and no typed field value", async () => {
    const surface = await newSurface('record-text.html');
    const a = await surface.readRecordText(css('#bal-a'), 'container', 5000);
    expect(a).toMatchObject({ ok: true, scope: 'container' });
    if (!a.ok) return;
    expect(a.text).toContain('1001');
    expect(a.text).toContain('Jane Smith');
    expect(a.text).not.toContain('2002');
    expect(a.text).not.toContain('77777');

    const b = await surface.readRecordText(css('#bal-b'), 'container', 5000);
    expect(b.ok && b.text).toContain('2002');
    expect(b.ok && b.text).not.toContain('1001');
  });

  it("'page' and an element with no container read the whole frame, as scope 'page'", async () => {
    const surface = await newSurface('record-text.html');
    const page = await surface.readRecordText(css('#bal-a'), 'page', 5000);
    expect(page).toMatchObject({ ok: true, scope: 'page' });
    if (!page.ok) return;
    for (const text of ['77777', '1001', '2002', 'Alone']) expect(page.text).toContain(text);
    expect(page.text).not.toContain('typed-value'); // a field's value is not visible text

    const lonely = await surface.readRecordText(css('#lonely'), 'container', 5000);
    expect(lonely).toMatchObject({ ok: true, scope: 'page' });
  });

  it('accepts a resolution ref and reports a missing target as element_not_found', async () => {
    const surface = await newSurface('record-text.html');
    const resolved = await surface.resolve(css('#bal-b'), 5000);
    if (!resolved.found) throw new Error('fixture target not found');
    expect(await surface.readRecordText({ ref: resolved.ref }, 'container', 5000)).toMatchObject({ ok: true, scope: 'container' });
    expect(await surface.readRecordText(css('#nope'), 'container', 500)).toMatchObject({ ok: false, error: { code: 'element_not_found' } });
  });
});

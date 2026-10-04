import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createPlaywrightSurface, type PlaywrightSurface } from './surface.js';
import { MAX_SNAPSHOT_BYTES, SNAPSHOT_CSP_META, stripActiveTags } from './snapshot.js';
import { startFixtureServer, type FixtureServer } from './test-helpers.js';

describe('snapshotDom', () => {
  let fixtures: FixtureServer;
  let surface: PlaywrightSurface;

  beforeAll(async () => {
    fixtures = await startFixtureServer();
  });

  afterAll(async () => {
    await fixtures.close();
  });

  afterEach(async () => {
    await surface?.close();
  });

  it('redacts server-rendered value attributes and textarea contents across frames, never a typed value', async () => {
    surface = await createPlaywrightSurface({ headless: true });
    await surface.page.goto(fixtures.url('snapshot-main.html'));

    // A human types into the password field; the typed value must never leak either.
    await surface.page.fill('input[name=password]', 'typedSecretXYZ');

    const snap = await surface.domSnapshot();

    // Frame markers, top and iframe, in listFrames() order.
    expect(snap).toContain('<!-- frame: top ');
    expect(snap).toContain('snapshot-main.html -->');
    expect(snap).toContain('<!-- frame: child ');
    expect(snap).toContain('snapshot-child.html -->');

    // Content is still there...
    expect(snap).toContain('Login');
    expect(snap).toContain('Child frame');

    // ...but no server-rendered value attribute, textarea seed content, or typed value survives.
    expect(snap).not.toContain('hunter2');
    expect(snap).not.toContain('childsecret');
    expect(snap).not.toContain('should-not-appear-plain');
    expect(snap).not.toContain('seed-content-xyz');
    expect(snap).not.toContain('typedSecretXYZ');
  });

  it('truncates at MAX_SNAPSHOT_BYTES with a trailing marker', async () => {
    surface = await createPlaywrightSurface({ headless: true });
    await surface.page.goto(fixtures.url('snapshot-main.html'));

    await surface.page.evaluate(() => {
      const div = document.createElement('div');
      div.id = 'huge';
      div.textContent = 'x'.repeat(2_000_000);
      document.body.appendChild(div);
    });

    const snap = await surface.domSnapshot();
    const bytes = Buffer.byteLength(snap, 'utf-8');
    expect(bytes).toBeLessThanOrEqual(MAX_SNAPSHOT_BYTES);
    expect(snap.endsWith('<!-- truncated -->')).toBe(true);
  });

  it('is inert on disk: CSP meta first, no scripts, no on* handlers, no javascript: URLs', async () => {
    surface = await createPlaywrightSurface({ headless: true });
    await surface.page.goto(fixtures.url('snapshot-scripts.html'));
    const snap = await surface.domSnapshot();

    expect(snap.startsWith(`${SNAPSHOT_CSP_META}\n`)).toBe(true);
    expect(snap).not.toMatch(/<script/i);
    expect(snap).not.toMatch(/\son[a-z]+=/i);
    expect(snap).not.toMatch(/javascript:/i);
    expect(snap).not.toMatch(/http-equiv="refresh"/i);
    for (const marker of ['inline-script-body-marker', 'onclick-handler-marker', 'onerror-marker', 'svg-script-marker']) {
      expect(snap).not.toContain(marker);
    }
    // Ordinary content, safe links and inline styles survive.
    expect(snap).toContain('Scripts fixture');
    expect(snap).toContain('href="/safe-page.html"');
    expect(snap).toContain('style="color: red"');
    // The live page is untouched.
    expect(await surface.page.evaluate(() => document.querySelectorAll('script').length)).toBe(3);

    // Loaded as a document, the snapshot runs nothing: even a script that survived the serializer
    // is blocked by the CSP. The same injected script without the CSP line does run (control).
    const injected = '\n<script>window.__ran = true;</script>';
    const ranAfterLoading = async (html: string): Promise<boolean> => {
      const page = await surface.page.context().newPage();
      try {
        await page.setContent(html);
        return await page.evaluate(() => (window as unknown as { __ran?: boolean }).__ran === true);
      } finally {
        await page.close();
      }
    };
    expect(await ranAfterLoading(snap.slice(SNAPSHOT_CSP_META.length) + injected)).toBe(true);
    expect(await ranAfterLoading(snap + injected)).toBe(false);
  });

  it('forbids <base> URLs and form submission in the CSP', () => {
    expect(SNAPSHOT_CSP_META).toContain("base-uri 'none'");
    expect(SNAPSHOT_CSP_META).toContain("form-action 'none'");
  });
});

describe('stripActiveTags', () => {
  it.each([
    ['unquoted', '<meta http-equiv=refresh content=0;url=https://example.invalid/>'],
    ['upper case, single quotes', "<META HTTP-EQUIV='Refresh' CONTENT='0;url=https://example.invalid/'>"],
    ['a ">" inside a quoted value', '<meta content="0;url=https://example.invalid/?a>b" http-equiv="refresh">'],
    ['slash instead of space', '<meta/http-equiv=refresh/content=0>'],
    ['newline and tab separators', '<meta\n\thttp-equiv\n=\n"refresh"\tcontent="0">'],
    ['an entity-encoded value', '<meta http-equiv="&#114;efresh" content="0">'],
    ['a competing CSP', `<meta http-equiv="Content-Security-Policy" content="script-src *">`],
    ['base with href', '<base href="https://example.invalid/">'],
    ['base, upper case, self-closing', '<BASE TARGET=_blank />'],
  ])('removes %s', (_label, tag) => {
    expect(stripActiveTags(`<p>before</p>${tag}<p>after</p>`)).toBe('<p>before</p><p>after</p>');
  });

  it('removes a tag that never closes, through the end of the text', () => {
    // The quote never closes, so everything after it is still inside the tag.
    expect(stripActiveTags('<p>before</p><meta http-equiv=refresh content="0;url=x <p>after</p>')).toBe('<p>before</p>');
    // A "<" inside a tag is an attribute-name character, not a new tag: the tag ends at the next ">".
    expect(stripActiveTags('<p>before</p><meta http-equiv=refresh content=0 <p>after</p>')).toBe('<p>before</p>after</p>');
  });

  it('keeps <meta> without http-equiv and tags that only start with the same letters', () => {
    const html = '<meta charset="utf-8"><meta name="viewport" content="width=device-width"><metadata>x</metadata><basefont size=3><p>base</p>';
    expect(stripActiveTags(html)).toBe(html);
  });

  it('does not let a removal splice a new tag together', () => {
    expect(stripActiveTags('<me<meta http-equiv=x>ta http-equiv=refresh content=0>')).toBe('');
  });

  it('escapes every remaining tag start when nesting outlasts the removal passes', () => {
    // Each pass removes the innermost tag, which joins the next "<me" + "ta ..." into a new one.
    let nested = '<meta http-equiv=refresh content=0>';
    for (let i = 0; i < 20; i++) nested = `<me${nested}ta http-equiv=refresh content=0>`;
    const out = stripActiveTags(nested);
    expect(out).not.toMatch(/<(meta|base)[\t\n\f\r />]/i);
    expect(out).toContain('&lt;meta');
  });
});
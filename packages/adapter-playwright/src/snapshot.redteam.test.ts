/**
 * Playwright `domSnapshot()` password/secret blanking across every frame.
 *
 * Extends snapshot.test.ts's coverage (top + one same-origin child frame) with:
 *   - a same-origin `src` iframe nested two levels deep (child -> grandchild),
 *   - a `srcdoc` iframe nested two levels deep,
 *   - a `type="text"` field marked as a password only via `autocomplete="current-password"`
 *     (never `type="password"`),
 *   - a field whose value is set via the JS `.value` property rather than the `value` attribute.
 *
 * Every password-shaped field is exercised in both forms: a server-rendered `value` attribute
 * (the fixture's `*-attr-SEED` values) and a runtime-typed value (via `page.fill`/`frame.fill`,
 * the `*-typed-SEED` values below), and every field's value should end up blanked (attribute
 * removed, or, for a typed value, was never serializable as an attribute in the first place).
 *
 * Guarantee under test (docs/design/foundation.md's "Redaction at the sink" design note: "a DOM
 * snapshot is an unstructured string, so ... Surface.domSnapshot() must blank password-field
 * values ... the Playwright surface must too").
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SNAPSHOT_CSP_META } from './snapshot.js';
import { createPlaywrightSurface, type PlaywrightSurface } from './surface.js';
import { startFixtureServer, type FixtureServer } from './test-helpers.js';

const TYPED = {
  top: 'topPw-typed-SEED',
  child: 'childPw-typed-SEED',
  grandchild: 'grandchildPw-typed-SEED',
  srcdoc1: 'srcdocPw1-typed-SEED',
  srcdoc2: 'srcdocPw2-typed-SEED',
  autoComplete: 'autoCompletePw-typed-SEED',
};

const ATTR_SEEDS = [
  'toppw-attr-SEED',
  'autocpw-attr-SEED',
  'childpw-attr-SEED',
  'grandchildpw-attr-SEED',
  'srcdocpw1-attr-SEED',
  'srcdocpw2-attr-SEED',
];

const JS_PROPERTY_SECRET = 'jsPropSecretXYZ';

describe('snapshotDom: password blanking in every frame, including nested src/srcdoc iframes', () => {
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

  it('blanks server-rendered AND typed password values in the top frame, a same-origin src iframe nested two levels deep, and a srcdoc iframe nested two levels deep; a text+autocomplete=current-password field and a JS-property-set field never leak either', async () => {
    surface = await createPlaywrightSurface({ headless: true });
    const page = surface.page;
    await page.goto(fixtures.url('snapshot-redteam-main.html'));

    // Let the two srcdoc iframes finish building themselves (chained fetch + onload), and the
    // fetched JS-property value finish landing.
    await page.waitForFunction(() => {
      const level1 = document.getElementsByName('srcdocLevel1')[0] as HTMLIFrameElement | undefined;
      const doc1 = level1?.contentDocument;
      const level2 = doc1?.getElementById('srcdocLevel2') as HTMLIFrameElement | null | undefined;
      const doc2 = level2?.contentDocument;
      const jsProp = document.getElementById('jsPropField') as HTMLInputElement | null;
      return !!doc2 && doc2.getElementsByName('srcdocPw2').length > 0 && !!jsProp && jsProp.value.length > 0;
    });

    const childFrame = page.frame({ name: 'child' });
    const grandchildFrame = page.frames().find((f) => f.name() === 'grandchild');
    const srcdoc1Frame = page.frames().find((f) => f.url().startsWith('about:srcdoc') && f.name() === 'srcdocLevel1');
    const srcdoc2Frame = page.frames().find((f) => f.url().startsWith('about:srcdoc') && f.name() === 'srcdocLevel2');
    expect(childFrame, 'expected the same-origin src child frame to be attached').toBeTruthy();
    expect(grandchildFrame, 'expected the nested (2-level) same-origin src grandchild frame to be attached').toBeTruthy();
    expect(srcdoc1Frame, 'expected the first srcdoc frame to be attached').toBeTruthy();
    expect(srcdoc2Frame, 'expected the nested (2-level) srcdoc frame to be attached').toBeTruthy();

    // Type into every password-shaped field, in every frame depth and both nesting mechanisms.
    await page.fill('input[name=topPw]', TYPED.top);
    await page.fill('input[name=autoCompletePw]', TYPED.autoComplete);
    await childFrame!.fill('input[name=childPw]', TYPED.child);
    await grandchildFrame!.fill('input[name=grandchildPw]', TYPED.grandchild);
    await srcdoc1Frame!.fill('input[name=srcdocPw1]', TYPED.srcdoc1);
    await srcdoc2Frame!.fill('input[name=srcdocPw2]', TYPED.srcdoc2);

    const snap = await surface.domSnapshot();

    // Sanity: every frame was actually walked (content is present), so an absence of the secret
    // below is not a vacuous pass from a frame silently failing to be captured at all.
    expect(snap).toContain('Redteam snapshot fixture');
    expect(snap).toContain('Child frame (same-origin src, 1 level deep)');
    expect(snap).toContain('Grandchild frame (same-origin src, 2 levels deep)');
    expect(snap).toContain('srcdoc frame (1 level deep)');
    expect(snap).toContain('Nested srcdoc frame (2 levels deep)');

    // Server-rendered `value` attributes must be blanked.
    for (const seed of ATTR_SEEDS) expect(snap, `attribute-seeded value "${seed}" must be blanked`).not.toContain(seed);

    // Typed values must never appear (outerHTML only serializes the `value` CONTENT ATTRIBUTE,
    // which typing never sets -- see file header; this asserts that empirically).
    for (const [label, value] of Object.entries(TYPED)) expect(snap, `typed value "${label}" must not leak`).not.toContain(value);

    // A value set via the JS `.value` PROPERTY (never the attribute) must not leak either.
    expect(snap, 'JS-property-set value must not leak').not.toContain(JS_PROPERTY_SECRET);
  });

  it('a page that subverts the in-page serializer still cannot make the snapshot redirect, rebase or submit when opened', async () => {
    surface = await createPlaywrightSurface({ headless: true });
    const page = surface.page;
    await page.setContent('<!doctype html><html><head><title>t</title></head><body><p>Hostile serializer</p></body></html>');
    // The serializer runs in the page's own world: this page makes `outerHTML` return markup the
    // live document never had, past every in-page removal step.
    await page.evaluate(() => {
      const real = Object.getOwnPropertyDescriptor(Element.prototype, 'outerHTML')!;
      Object.defineProperty(Element.prototype, 'outerHTML', {
        configurable: true,
        get(this: Element) {
          const html = real.get!.call(this) as string;
          return html.replace(
            '</head>',
            '<META HTTP-EQUIV=Refresh CONTENT="0;url=https://example.invalid/?a>b"><meta content=\'0\' http-equiv=\'refresh\'>' +
              '<base href=https://example.invalid/></head>',
          ).replace(
            '</body>',
            '<form id="f" action="https://example.invalid/submit"><button id="b">go</button></form><a id="rel" href="rel.html">rel</a></body>',
          );
        },
      });
    });

    const snap = await surface.domSnapshot();
    expect(snap).toContain('Hostile serializer');
    expect(snap).not.toMatch(/http-equiv\s*=\s*["']?refresh/i);
    expect(snap).not.toMatch(/<base[\t\n\f\r />]/i);

    // Opened as a document: nothing navigates, the relative link is not rebased, and the form
    // cannot submit anywhere. The same markup without the CSP line does submit (control).
    const openAndSubmit = async (html: string): Promise<{ activeTags: number; relHref: string; outbound: string[] }> => {
      const viewer = await page.context().newPage();
      try {
        const outbound: string[] = [];
        viewer.on('request', (r) => {
          if (r.url().includes('example.invalid')) outbound.push(r.url());
        });
        await viewer.setContent(html);
        const activeTags = await viewer.evaluate(() => document.querySelectorAll('meta[http-equiv="refresh" i], base').length);
        const relHref = await viewer.evaluate(() => (document.getElementById('rel') as HTMLAnchorElement).href);
        // Clicked from Node: the page's own scripts are blocked by the CSP, and Playwright's click
        // would wait on a submission the CSP cancels.
        await viewer.evaluate(() => (document.getElementById('b') as HTMLButtonElement).click());
        await new Promise((r) => setTimeout(r, 500));
        return { activeTags, relHref, outbound };
      } finally {
        await viewer.close();
      }
    };
    const opened = await openAndSubmit(snap);
    expect(opened.activeTags).toBe(0);
    expect(opened.relHref).not.toContain('example.invalid');
    expect(opened.outbound).toEqual([]);
    expect((await openAndSubmit(snap.slice(SNAPSHOT_CSP_META.length))).outbound.length).toBeGreaterThan(0);
  });
});

/**
 * Cross-mode parity: for every fixture this port owns, and every one of its frames,
 * `window.__cuAgent.enumerate()` must return exactly the same JSON whether the agent arrived via
 * a driver's `addInitScript` ('injected' mode) or the app's own `<script src>` tag ('included'
 * mode) -- see helpers.ts. A `<script>` element has no layout box (isVisible() excludes it) and
 * lives in `<head>`, outside `document.body`, so the extra included-mode tag should never change
 * what enumerate() reports.
 *
 * Fixtures skipped (not top-level pages -- their content is exercised as a frame of the fixture
 * that loads them):
 *   - enum-frame-left.html, enum-frame-main.html, enum-frame-inner.html: frames of enum-frameset.html
 *   - resolve-frame-inner.html: a frame of resolve-frame-outer.html
 *   - snapshot-child.html: a frame of snapshot-main.html
 *   - snapshot-redteam-child.html, -grandchild.html, -srcdoc1.html, -srcdoc2.html: frames of
 *     snapshot-redteam-main.html (the srcdoc ones are never navigated to directly; their markup is
 *     fetched as text and assigned to a `.srcdoc` property at runtime)
 *   - snapshot-redteam-jsprop-secret.txt: not an HTML page
 * Fixtures out of this port's scope (added by other engineers working the same package
 * concurrently, not copied by this port, and not touched by it): capture-*.html, frames-*.html,
 * install-*.html, sink-click.html, cap-submit.html, cap-xss.html.
 */
import type { Browser, Frame, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enumerateJson, launchBrowser, openPage, startServer, type TestServer } from './helpers.js';

let browser: Browser;
let server: TestServer;

beforeAll(async () => {
  browser = await launchBrowser();
  server = await startServer();
});

afterAll(async () => {
  await browser.close();
  await server.close();
});

interface FixtureCase {
  file: string;
  /** Extra readiness wait beyond page.goto()'s default 'load', for frames/content built
   * asynchronously after load (srcdoc iframes chained through fetch()). */
  ready?: (page: Page) => Promise<unknown>;
}

const TOP_LEVEL_FIXTURES: FixtureCase[] = [
  { file: 'dialog-fixture.html' },
  { file: 'enum-cap.html' },
  { file: 'enum-cells.html' },
  { file: 'enum-frameset.html' },
  { file: 'enum-login.html' },
  { file: 'enum-nested-leaf-anchor.html' },
  { file: 'resolve-detail.html' },
  { file: 'resolve-dropdown.html' },
  { file: 'resolve-frame-outer.html', ready: (page) => page.waitForSelector('iframe[name="x"]') },
  { file: 'resolve-relative-clickable-ancestor.html' },
  { file: 'resolve-relative-wrapper.html' },
  { file: 'resolve-search.html' },
  { file: 'snapshot-main.html' },
  {
    file: 'snapshot-redteam-main.html',
    ready: (page) =>
      page.waitForFunction(() => {
        const level1 = document.getElementsByName('srcdocLevel1')[0] as HTMLIFrameElement | undefined;
        const doc1 = level1?.contentDocument;
        const level2 = doc1?.getElementById('srcdocLevel2') as HTMLIFrameElement | null | undefined;
        const doc2 = level2?.contentDocument;
        const jsProp = document.getElementById('jsPropField') as HTMLInputElement | null;
        return !!doc2 && doc2.getElementsByName('srcdocPw2').length > 0 && !!jsProp && jsProp.value.length > 0;
      }),
  },
  { file: 'xss.html' },
];

/** All non-detached frames of `page`, keyed by name (the un-named root frame is keyed 'top').
 * Every frame across these fixtures has a distinct `name`, so the key is unambiguous. */
function frameMap(page: Page): Map<string, Frame> {
  const m = new Map<string, Frame>();
  for (const f of page.frames()) {
    if (f.isDetached()) continue;
    m.set(f.name() || 'top', f);
  }
  return m;
}

describe('injected mode == included mode', () => {
  for (const { file, ready } of TOP_LEVEL_FIXTURES) {
    it(file, async () => {
      const injected = await openPage(browser, server, 'injected', file);
      const included = await openPage(browser, server, 'included', file);
      try {
        if (ready) {
          await ready(injected.page);
          await ready(included.page);
        }
        const injectedFrames = frameMap(injected.page);
        const includedFrames = frameMap(included.page);
        expect([...includedFrames.keys()].sort(), file).toEqual([...injectedFrames.keys()].sort());

        for (const [key, frame] of injectedFrames) {
          const otherFrame = includedFrames.get(key);
          expect(otherFrame, `included mode is missing frame '${key}' of ${file}`).toBeTruthy();
          const a = await enumerateJson(frame);
          const b = await enumerateJson(otherFrame!);
          expect(b, `frame '${key}' of ${file}`).toEqual(a);
        }
      } finally {
        await injected.context.close();
        await included.context.close();
      }
    });
  }
});

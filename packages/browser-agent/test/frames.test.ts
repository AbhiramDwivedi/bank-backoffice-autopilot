import type { Browser, Frame, Page } from 'playwright';
import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest';
import type { FrameHop, HumanActionRecord } from '../src/types.js';
import { launchBrowser, MODES, openPage, startServer, type Mode, type Opened, type TestServer } from './helpers.js';

/** The driver's own view of a frame's path (Playwright semantics: `frame.name()` is the `name`
 * attribute, or the `id` when `name` is absent; else the frame's index among its parent's children). */
function playwrightHop(frame: Frame): FrameHop {
  const parent = frame.parentFrame();
  const name = frame.name();
  if (name) return { name };
  return { index: parent ? parent.childFrames().indexOf(frame) : 0 };
}

function playwrightFramePath(frame: Frame): FrameHop[] {
  const hops: FrameHop[] = [];
  let f: Frame | null = frame;
  while (f && f.parentFrame()) {
    hops.unshift(playwrightHop(f));
    f = f.parentFrame();
  }
  return hops;
}

async function startCaptureIn(target: Frame | Page): Promise<void> {
  await target.evaluate(() => {
    window.__cuAgent!.capture.start();
  });
}

/** Starts capture, clicks '#btn', and returns the last record from THAT frame's own agent (each
 * document/frame installs its own `window.__cuAgent`, with its own event buffer). */
async function clickAndGetRecord(frame: Frame): Promise<HumanActionRecord> {
  await startCaptureIn(frame);
  await frame.click('#btn');
  return frame.evaluate(() => {
    const events = window.__cuAgent!.events;
    return events[events.length - 1] as HumanActionRecord;
  });
}

/** Appends an iframe (via evaluateHandle, no named inner function reaching into page context) and
 * returns its content Frame once attached. */
async function attachIframe(parent: Page | Frame, src: string): Promise<Frame> {
  const handle = await parent.evaluateHandle((s) => {
    const f = document.createElement('iframe');
    f.src = s;
    document.body.appendChild(f);
    return f;
  }, src);
  const el = handle.asElement();
  if (!el) throw new Error('iframe element handle missing');
  const frame = await el.contentFrame();
  if (!frame) throw new Error('iframe contentFrame missing');
  await frame.waitForLoadState('domcontentloaded');
  return frame;
}

describe.each(MODES)('frames (mode=%s)', (mode: Mode) => {
  let server: TestServer;
  let browser: Browser;
  let opened: Opened | undefined;

  beforeAll(async () => {
    server = await startServer();
    browser = await launchBrowser();
  });

  afterAll(async () => {
    await browser.close();
    await server.close();
  });

  afterEach(async () => {
    await opened?.context.close();
    opened = undefined;
  });

  it('named outer frame + unnamed inner frame -> [{name:"outer"},{index:0}]', async () => {
    opened = await openPage(browser, server, mode, 'frames-outer.html');
    const page = opened.page;
    const outer = page.frame({ name: 'outer' });
    if (!outer) throw new Error('outer frame not found');
    const inner = outer.childFrames()[0];
    if (!inner) throw new Error('inner frame not found');

    const record = await clickAndGetRecord(inner);
    expect(record.frameTruncated).toBeUndefined();
    expect(record.frame).toEqual(playwrightFramePath(inner));
    expect(record.frame).toEqual([{ name: 'outer' }, { index: 0 }]);
  });

  it('an iframe with only an id reports {name: id} (Playwright semantics)', async () => {
    opened = await openPage(browser, server, mode, 'frames-idonly.html');
    const page = opened.page;
    const side = page.frames().find((f) => f.parentFrame() === page.mainFrame());
    if (!side) throw new Error('side frame not found');

    const record = await clickAndGetRecord(side);
    expect(record.frameTruncated).toBeUndefined();
    expect(record.frame).toEqual(playwrightFramePath(side));
    expect(record.frame).toEqual([{ name: 'side' }]);
  });

  it('cross-origin: a click in the innermost of two nested cross-origin frames is truncated with a partial path', async () => {
    opened = await openPage(browser, server, mode, 'frames-empty.html');
    const page = opened.page;

    const midUrl = server.url(mode, 'frames-empty.html', true);
    const mid = await attachIframe(page, midUrl);
    const innerUrl = server.url(mode, 'frames-button.html', false);
    const inner = await attachIframe(mid, innerUrl);

    const record = await clickAndGetRecord(inner);
    expect(record.frameTruncated).toBe(true);
    expect(record.frame).toEqual([{ index: 0 }]);
  });

  it('cross-origin: a click in a cross-origin frame directly under top yields a complete path, no truncation', async () => {
    opened = await openPage(browser, server, mode, 'frames-empty.html');
    const page = opened.page;

    const altUrl = server.url(mode, 'frames-button.html', true);
    const altFrame = await attachIframe(page, altUrl);

    const record = await clickAndGetRecord(altFrame);
    expect(record.frameTruncated).toBeUndefined();
    expect(record.frame).toEqual([{ index: 0 }]);
  });
});

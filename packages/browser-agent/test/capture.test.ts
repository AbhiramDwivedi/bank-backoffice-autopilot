import type { Browser, Frame, Page } from 'playwright';
import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest';
import type { HumanActionRecord } from '../src/types.js';
import { launchBrowser, MODES, openPage, startServer, type Mode, type Opened, type TestServer } from './helpers.js';

/** Starts capture in a frame/page without any named helper function reaching into page context. */
function startCaptureIn(target: Frame | Page): Promise<void> {
  return target.evaluate(() => {
    window.__cuAgent!.capture.start();
  });
}

function stopCaptureIn(target: Frame | Page): Promise<void> {
  return target.evaluate(() => {
    window.__cuAgent!.capture.stop();
  });
}

/** True when `x` (or anything nested inside it) has an own property literally named `value`. */
function hasValueKeyDeep(x: unknown): boolean {
  if (Array.isArray(x)) return x.some(hasValueKeyDeep);
  if (x && typeof x === 'object') {
    for (const [k, v] of Object.entries(x as Record<string, unknown>)) {
      if (k === 'value') return true;
      if (hasValueKeyDeep(v)) return true;
    }
  }
  return false;
}

function collectStrings(x: unknown, out: string[]): void {
  if (typeof x === 'string') {
    out.push(x);
  } else if (Array.isArray(x)) {
    for (const v of x) collectStrings(v, out);
  } else if (x && typeof x === 'object') {
    for (const v of Object.values(x as Record<string, unknown>)) collectStrings(v, out);
  }
}

const ALLOWED_RECORD_KEYS = new Set(['ts', 'type', 'frame', 'target', 'valueRedacted', 'key', 'url', 'frameTruncated']);
const ALLOWED_TARGET_KEYS = new Set(['tag', 'role', 'name', 'text', 'selector']);

function assertWellFormed(record: HumanActionRecord): void {
  expect(hasValueKeyDeep(record)).toBe(false);
  expect(record.valueRedacted).toBe(true);
  for (const k of Object.keys(record)) expect(ALLOWED_RECORD_KEYS.has(k)).toBe(true);
  for (const k of Object.keys(record.target)) expect(ALLOWED_TARGET_KEYS.has(k)).toBe(true);
  const strings: string[] = [];
  collectStrings(record, strings);
  for (const s of strings) expect(s.length).toBeLessThanOrEqual(300);
}

describe.each(MODES)('capture (mode=%s)', (mode: Mode) => {
  let server: TestServer;
  let browser: Browser;

  beforeAll(async () => {
    server = await startServer();
    browser = await launchBrowser();
  });

  afterAll(async () => {
    await browser.close();
    await server.close();
  });

  describe.each([false, true] as const)('binding present=%s', (useBinding: boolean) => {
    let opened: Opened | undefined;
    let bound: HumanActionRecord[];

    async function open(file: string): Promise<Page> {
      bound = [];
      opened = await openPage(browser, server, mode, file, useBinding ? { binding: (a) => bound.push(a as HumanActionRecord) } : {});
      return opened.page;
    }

    /** Non-destructively reads whatever the sink currently holds. With a binding, every frame in
     * this context shares the one `bound` array. Without one, each frame has its own agent and
     * buffer, so the caller must read from the same frame the action happened in. */
    async function readActions(target: Frame | Page): Promise<HumanActionRecord[]> {
      if (useBinding) return bound;
      return target.evaluate(() => window.__cuAgent!.events as unknown as HumanActionRecord[]);
    }

    afterEach(async () => {
      await opened?.context.close();
      opened = undefined;
    });

    it('captures click, input, keypress; never leaks the typed value; stop() silences; start() after stop() resumes', async () => {
      const page = await open('capture-outer.html');
      const main = page.frame({ name: 'main' });
      if (!main) throw new Error('main frame not found');
      await startCaptureIn(main);

      await main.click('#btn');
      await expect.poll(async () => (await readActions(main)).some((a) => a.type === 'click')).toBe(true);
      const click = (await readActions(main)).find((a) => a.type === 'click');
      expect(click?.frame).toEqual([{ name: 'main' }]);
      expect(click?.target.name).toBe('Click me');
      expect(click?.target.text).toBe('Click me');
      assertWellFormed(click!);

      await main.fill('#field', 'secret123');
      await expect.poll(async () => (await readActions(main)).filter((a) => a.type === 'input').length).toBeGreaterThan(0);
      const afterFill = await readActions(main);
      const inputRecords = afterFill.filter((a) => a.type === 'input');
      expect(inputRecords.length).toBe(1);
      expect(inputRecords[0]?.valueRedacted).toBe(true);
      expect(inputRecords[0]?.target.text).toBeUndefined();
      expect(JSON.stringify(afterFill)).not.toContain('secret123');
      assertWellFormed(inputRecords[0]!);

      await main.press('#field', 'Enter');
      await expect.poll(async () => (await readActions(main)).some((a) => a.type === 'keypress')).toBe(true);
      const keypress = (await readActions(main)).find((a) => a.type === 'keypress');
      expect(keypress?.key).toBe('Enter');
      // The key travels only in `key`, never in `target.text` -- #field is an editable input, so
      // its target reports no text at all (same as the `input` record above).
      expect(keypress?.target.text).toBeUndefined();
      expect(keypress?.frame).toEqual([{ name: 'main' }]);
      assertWellFormed(keypress!);

      // secret never appears anywhere, even after everything above
      expect(JSON.stringify(await readActions(main))).not.toContain('secret123');

      // stop(): further interaction produces no new records
      await stopCaptureIn(main);
      const countBeforeStop = (await readActions(main)).length;
      await main.click('#btn');
      await page.waitForTimeout(300);
      expect((await readActions(main)).length).toBe(countBeforeStop);

      // start() after stop() captures again
      await startCaptureIn(main);
      await main.click('#btn');
      await expect.poll(async () => (await readActions(main)).length).toBeGreaterThan(countBeforeStop);
    });

    it('captures a submit record (target tag "form") and a click record for the submit input', async () => {
      const page = await open('cap-submit.html');
      await startCaptureIn(page);

      await page.click('#submit-btn');
      await expect.poll(async () => (await readActions(page)).some((a) => a.type === 'submit')).toBe(true);
      const actions = await readActions(page);
      const submit = actions.find((a) => a.type === 'submit');
      expect(submit?.target.tag).toBe('form');
      assertWellFormed(submit!);

      const click = actions.find((a) => a.type === 'click');
      expect(click?.target.name).toBe('Go');
      expect(click?.target.text).toBe('Go');
      assertWellFormed(click!);
    });

    it('same-document navigation: pushState and a hash change each produce exactly one navigate record', async () => {
      const page = await open('capture-outer.html');
      const main = page.frame({ name: 'main' });
      if (!main) throw new Error('main frame not found');
      await startCaptureIn(main);

      await main.evaluate(() => {
        history.pushState({}, '', location.pathname + '?pushed=1');
      });
      await expect.poll(async () => (await readActions(main)).filter((a) => a.type === 'navigate').length).toBe(1);

      await main.evaluate(() => {
        location.hash = 'section-2';
      });
      await expect.poll(async () => (await readActions(main)).filter((a) => a.type === 'navigate').length).toBe(2);

      const navigations = (await readActions(main)).filter((a) => a.type === 'navigate');
      for (const n of navigations) {
        expect(n.target).toEqual({});
        assertWellFormed(n);
      }
    });

    it('never reports what the user typed into a contenteditable region (click or keypress)', async () => {
      const page = await open('cap-editable.html');
      await startCaptureIn(page);

      await page.click('#editor');
      await page.keyboard.type('typed-secret-42');
      await page.keyboard.press('Enter');
      await page.click('#editor');
      await expect.poll(async () => (await readActions(page)).filter((a) => a.type === 'click').length).toBeGreaterThanOrEqual(2);
      await expect.poll(async () => (await readActions(page)).some((a) => a.type === 'keypress')).toBe(true);

      const actions = await readActions(page);
      expect(JSON.stringify(actions)).not.toContain('typed-secret-42');
      const keypress = actions.find((a) => a.type === 'keypress');
      expect(keypress?.key).toBe('Enter');
      for (const a of actions) assertWellFormed(a);
    });

    it('a submitted form holding a select and a contenteditable reports neither option labels nor typed text', async () => {
      const page = await open('cap-form-editable.html');
      await startCaptureIn(page);

      await page.click('#notes');
      await page.keyboard.type('typed-note-77');
      await page.click('#go');
      await expect.poll(async () => (await readActions(page)).some((a) => a.type === 'submit')).toBe(true);

      const actions = await readActions(page);
      const json = JSON.stringify(actions);
      expect(json).not.toContain('typed-note-77');
      expect(json).not.toContain('SECRET_OPTION_B');
      const submit = actions.find((a) => a.type === 'submit');
      expect(submit?.target.tag).toBe('form');
      expect(submit?.target.name).toBe('payee-form'); // falls back to the form's name attribute
      for (const a of actions) assertWellFormed(a);
    });

    it('never throws into the page when a hostile script breaks a DOM built-in', async () => {
      const page = await open('cap-editable.html');
      const pageErrors: string[] = [];
      page.on('pageerror', (err) => pageErrors.push(err.message));
      await startCaptureIn(page);
      await page.evaluate(() => {
        (window as unknown as { __pageClicks: number }).__pageClicks = 0;
        document.getElementById('after')!.addEventListener('click', () => {
          (window as unknown as { __pageClicks: number }).__pageClicks++;
        });
        Element.prototype.getAttribute = () => {
          throw new Error('hostile getAttribute');
        };
      });

      await page.click('#after');
      await expect.poll(() => page.evaluate(() => (window as unknown as { __pageClicks: number }).__pageClicks)).toBe(1);
      await new Promise((r) => setTimeout(r, 200));
      expect(pageErrors).toEqual([]);
    });

    it('reports XSS-hostile attribute values verbatim-but-capped, and never executes them', async () => {
      const page = await open('cap-xss.html');
      await startCaptureIn(page);

      await page.click('#xss-btn');
      await page.fill('#xss-input', 'x');
      await expect.poll(async () => (await readActions(page)).length).toBeGreaterThan(0);

      const pwned = await page.evaluate(() => (window as unknown as { __pwned?: unknown }).__pwned);
      expect(pwned).toBeUndefined();

      const actions = await readActions(page);
      const click = actions.find((a) => a.type === 'click');
      expect(click?.target.name).toContain('<img src=x onerror=');
      assertWellFormed(click!);

      const input = actions.find((a) => a.type === 'input');
      expect(input?.target.name).toContain('<img src=x onerror=');
      expect(input?.target.text).toBeUndefined();
      assertWellFormed(input!);

      for (const a of actions) assertWellFormed(a);
    });
  });
});

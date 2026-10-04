/**
 * Red team: the capture itself, on the real surface. Pixels are redacted by a stylesheet laid out
 * with the content, so moving content cannot escape its mask; what matters is content the plan
 * never marked, and styles that out-rank the sheet:
 *  - layout shifts faster than a frame (7 ms class toggle, 3 ms and 7 ms `adoptedStyleSheets`
 *    swaps, 5 ms `insertRule`/`deleteRule`): at least 100 captures go out for each, none leaks;
 *  - an inline `!important` that out-ranks the sheet: withheld at load, discarded when set during
 *    the capture;
 *  - overflowing, `display: contents`, absolutely positioned and `text-shadow` values: redacted;
 *  - a 50 ms `style.left` ticker on unrelated content must not starve capture; one that moves the
 *    masked content itself must not leak;
 *  - an infinite CSS animation and a running transition on masked content: clean captures;
 *  - a page that replaces `window.MutationObserver` and patches its prototype, then flashes PII
 *    rows in and out: never captured;
 *  - a field filled by a script after the plan (`maskInputs: all` marks it while empty);
 *  - values carried by `aria-label` on a plain span and `<img alt>` in a value cell never reach the
 *    DOM snapshot;
 *  - a masked control is named the same way by the observation and by a policy event (`describeRef`);
 *  - the raw browser message of a failed action goes to the local debug sink only.
 * Pixel checks count the PII colour over the whole PNG (`countColor`).
 */
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveScreenMask, type ScreenMaskConfig } from '@cu/core/schema';
import { isOmittedScreenshot, type Observation } from '@cu/core/surface';
import { createPlaywrightSurface, type PlaywrightSurface } from './surface.js';
import { countColor } from './test-helpers.js';

let browser: Browser;
let decoder: Page;
let surface: PlaywrightSurface | undefined;
const logs: string[] = [];
const ORIGIN = 'http://capture.test';

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  decoder = await (await browser.newContext()).newPage();
});
afterAll(async () => {
  await browser.close();
});
afterEach(async () => {
  await surface?.close();
  surface = undefined;
  logs.length = 0;
});

const STYLE = `<style>body { margin: 0; font: bold 22px Arial, sans-serif; color: #000; background: #fff; } .pii { color: #ff00aa; } td { padding: 2px 10px; }</style>`;

async function openHtml(body: string, config: Partial<ScreenMaskConfig> = {}): Promise<PlaywrightSurface> {
  surface = await createPlaywrightSurface({
    browser,
    viewport: { width: 900, height: 700 },
    log: (m) => logs.push(m),
    screenMask: { config: { ...resolveScreenMask(undefined), maskLabels: ['^address$', '^phone$'], ...config }, textPatterns: [] },
  });
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Capture</title>${STYLE}</head><body>${body}</body></html>`;
  await surface.page.context().route(`${ORIGIN}/**`, (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html }));
  expect((await surface.act({ type: 'navigate', url: `${ORIGIN}/page.html` }, 10_000)).ok).toBe(true);
  return surface;
}

const TABLE = `<table id="t"><tr><td>Address</td><td class="pii">12 Harbor Rd</td></tr><tr><td>Phone</td><td class="pii">413-555-0142</td></tr></table>`;

/** Takes `n` screenshots through both paths; returns how many went out and the PII pixels across them. */
async function captures(s: PlaywrightSurface, n: number): Promise<{ returned: number; withheld: number; pixels: number }> {
  let returned = 0;
  let withheld = 0;
  let pixels = 0;
  for (let i = 0; i < n; i++) {
    const shot = i % 2 === 0 ? (await s.observe()).screenshotPng : await s.screenshot();
    if (!shot || isOmittedScreenshot(shot)) {
      withheld++;
      continue;
    }
    returned++;
    pixels += await countColor(decoder, shot);
  }
  return { returned, withheld, pixels };
}

describe('screen masking: the capture', () => {
  // --- Layout shifts faster than a frame (the reviewer's table) -------------------------------------
  // The redaction is CSS laid out with the content, so a shift between any two steps of the capture
  // moves both. At least 100 captures must go out for each, none with a PII pixel.

  const SHIFTING = `<div id="shift">${TABLE}<p>Ship to: 7 Frame Way</p><p>Notes for today. Address: <span class="pii">9 Elm Rd</span></p></div>`;

  async function shiftedCaptures(s: PlaywrightSurface, want: number): Promise<{ returned: number; withheld: number; leaked: number }> {
    let returned = 0;
    let withheld = 0;
    let leaked = 0;
    for (let i = 0; returned < want && i < want * 3; i++) {
      const shot = await s.screenshot();
      if (isOmittedScreenshot(shot)) {
        withheld++;
        continue;
      }
      returned++;
      if ((await countColor(decoder, shot)) > 0) leaked++;
    }
    return { returned, withheld, leaked };
  }

  const SHIFTS: Record<string, string> = {
    '7 ms class toggle shifting a margin': `
      const st = document.createElement('style'); st.textContent = '.shifted { margin-left: 17px; margin-top: 11px; }'; document.head.appendChild(st);
      setInterval(() => document.getElementById('shift').classList.toggle('shifted'), 7);`,
    '3 ms adoptedStyleSheets swap': `
      const a = new CSSStyleSheet(); a.replaceSync('#shift { margin-left: 13px; padding-top: 9px; }');
      setInterval(() => { document.adoptedStyleSheets = document.adoptedStyleSheets.length ? [] : [a]; }, 3);`,
    '7 ms adoptedStyleSheets swap': `
      const a = new CSSStyleSheet(); a.replaceSync('#shift { margin-left: 19px; }');
      setInterval(() => { document.adoptedStyleSheets = document.adoptedStyleSheets.length ? [] : [a]; }, 7);`,
    '5 ms insertRule/deleteRule': `
      const st = document.createElement('style'); document.head.appendChild(st);
      setInterval(() => { const sh = st.sheet; if (sh.cssRules.length) sh.deleteRule(0); else sh.insertRule('#shift td, #shift p { padding-left: 15px; }', 0); }, 5);`,
  };

  for (const [name, script] of Object.entries(SHIFTS)) {
    it(`${name}: at least 100 captures go out, none leaks`, async () => {
      const s = await openHtml(SHIFTING);
      await s.page.evaluate(script);
      const r = await shiftedCaptures(s, 100);
      console.log(`[capture] ${name}: returned ${r.returned}, withheld ${r.withheld}, leaked ${r.leaked}`);
      expect(r.leaked).toBe(0);
      expect(r.returned).toBeGreaterThanOrEqual(100);
    }, 300_000);
  }

  it("a page whose inline !important style out-ranks the redaction: the sheet check withholds the screenshot", async () => {
    const s = await openHtml(`<table><tr><td>Address</td><td style="color: #ff00aa !important">12 Harbor Rd</td></tr></table><p>Plain</p>`);
    const shot = await s.screenshot();
    expect(isOmittedScreenshot(shot)).toBe(true);
    expect(logs.join('\n')).toMatch(/does not win on 1 element/);
    // Text still flows, masked.
    const obs = await s.observe();
    expect(obs.textDigest).toContain('[MASKED:address]');
    expect(obs.textDigest).not.toContain('12 Harbor Rd');
  });

  it('a script that sets an out-ranking inline style on masked content during the capture: never captured (the change is counted, and the element mask is the second layer)', async () => {
    const s = await openHtml(TABLE);
    await s.page.evaluate(() => {
      const cell = document.querySelectorAll('td')[1] as HTMLElement;
      setInterval(() => {
        if (cell.style.getPropertyValue('color')) cell.style.removeProperty('color');
        else cell.style.setProperty('color', '#ff00aa', 'important');
      }, 4);
    });
    const r = await shiftedCaptures(s, 20);
    console.log(`[capture] inline !important toggled every 4 ms: returned ${r.returned}, withheld ${r.withheld}, leaked ${r.leaked}`);
    expect(r.leaked).toBe(0);
  }, 120_000);

  it('full-width colons hide the value in pixels and text; labels that only contain a label word leave theirs visible', async () => {
    const s = await openHtml(
      `<p>Address：<span class="pii">1 Wide St</span></p><p>Phone﹕ <span class="pii">413-555-0188</span></p>
       <p>Address book: 12 entries</p><p>Phone support hours: 9 to 5 weekdays</p><p>Address verified: yes</p><p>See https://intranet/address: details here</p>`,
      // Unanchored sources: a rule still has to match the whole label.
      { maskLabels: ['address', 'phone'] },
    );
    const shot = await s.screenshot();
    expect(isOmittedScreenshot(shot)).toBe(false);
    expect(await countColor(decoder, shot)).toBe(0);
    const digest = (await s.observe()).textDigest;
    expect(digest).not.toContain('1 Wide St');
    expect(digest).not.toContain('413-555-0188');
    for (const visible of ['12 entries', '9 to 5 weekdays', 'Address verified: yes', 'details here']) expect(digest).toContain(visible);
  });

  it('text that overflows its box, a display:contents value and an absolutely positioned value are redacted where they are painted, and the screenshot goes out', async () => {
    const s = await openHtml(
      `<table><tr><td>Address</td><td style="width:40px;max-width:40px;white-space:nowrap;overflow:visible" class="pii">77 Very Long Overflowing Boulevard Apt 9</td></tr>
       <tr><td>Address</td><td><span style="display:contents" class="pii">8 Hidden Box Rd</span></td></tr></table>
       <div style="position:relative;height:40px"><p style="position:absolute;left:300px;top:0;margin:0">Note. Address: <span class="pii">3 Absolute Pl</span></p></div>
       <p style="text-shadow: 30px 0 #0000ff">Address: <span class="pii" style="text-shadow: 40px 0 #ff00aa">5 Shadow St</span></p>`,
    );
    const shot = await s.screenshot();
    expect(isOmittedScreenshot(shot)).toBe(false);
    expect(await countColor(decoder, shot)).toBe(0);
  });

  it('a 50 ms style.left ticker on unrelated content does not starve capture; one moving the masked content never leaks', async () => {
    const s = await openHtml(`${TABLE}<div id="tick" style="position:relative;left:0">Clock</div><div id="mover" style="position:relative;left:0">${TABLE.replace('id="t"', 'id="t2"')}</div>`);
    await s.page.evaluate(() => {
      let x = 0;
      setInterval(() => {
        x = (x + 7) % 200;
        (document.getElementById('tick') as HTMLElement).style.left = `${x}px`;
      }, 50);
    });
    const unrelated = await captures(s, 10);
    expect(unrelated.pixels).toBe(0);
    expect(unrelated.returned, `withheld ${unrelated.withheld} of 10 with an unrelated ticker`).toBeGreaterThanOrEqual(9);

    await s.page.evaluate(() => {
      let x = 0;
      setInterval(() => {
        x = (x + 5) % 120;
        (document.getElementById('mover') as HTMLElement).style.left = `${x}px`;
      }, 50);
    });
    const moving = await captures(s, 10);
    expect(moving.pixels, 'masked content moving every 50 ms').toBe(0);
    console.log(`[capture] 50 ms ticker: unrelated returned ${unrelated.returned}/10, masked content moving returned ${moving.returned}/10`);
  }, 120_000);

  it('an infinite CSS animation and a transition on masked content: captured clean (animations settled for the capture)', async () => {
    const s = await openHtml(
      `<style>@keyframes slide { from { transform: translateX(0); } to { transform: translateX(80px); } } .spin { animation: slide 0.3s infinite alternate; } .slow { transition: transform 2s linear; }</style>
       <div class="spin">${TABLE}</div><div id="tr" class="slow">${TABLE.replace('id="t"', 'id="t3"')}</div>`,
    );
    await s.page.evaluate(() => {
      // A transition that is running during every capture.
      let on = false;
      setInterval(() => {
        on = !on;
        (document.getElementById('tr') as HTMLElement).style.transform = on ? 'translateX(90px)' : 'translateX(0)';
      }, 700);
    });
    const r = await captures(s, 8);
    expect(r.pixels).toBe(0);
    expect(r.returned, 'animations are settled for the capture, so it is not withheld every time').toBeGreaterThan(0);
  }, 120_000);

  it('a page that replaces MutationObserver and patches its prototype, then flashes PII rows in and out: never captured', async () => {
    const s = await openHtml(TABLE);
    await s.page.evaluate(() => {
      const noop = function () {
        return { observe() {}, disconnect() {}, takeRecords: () => [] };
      };
      MutationObserver.prototype.observe = function () {};
      MutationObserver.prototype.takeRecords = function () {
        return [];
      };
      (window as unknown as { MutationObserver: unknown }).MutationObserver = noop;
      setInterval(() => {
        // Out of the flow: nothing masked moves, so only change detection can catch it.
        const p = document.createElement('p');
        p.className = 'pii';
        p.style.cssText = 'position:fixed;left:20px;top:300px;margin:0';
        p.textContent = 'Flash 77 Ghost Ln';
        document.body.appendChild(p);
        setTimeout(() => p.remove(), 15);
      }, 40);
    });
    const r = await captures(s, 12);
    expect(r.pixels).toBe(0);
  }, 120_000);

  it("a field a script fills after the plan is already under its mask ('all' marks it while empty)", async () => {
    const s = await openHtml(`<input id="late" class="pii" style="font: bold 22px Arial; color: #ff00aa; width: 300px" value="">`);
    const obs = await s.observe();
    const field = obs.elements.find((e) => e.tag === 'input')!;
    expect(field.masked).toBe(true);
    expect(field.value, 'an empty field stays empty in the text channel').toBe('');
    await s.page.evaluate(() => {
      setInterval(() => {
        const f = document.getElementById('late') as HTMLInputElement;
        f.value = f.value ? '' : '99 Latecomer Rd';
      }, 10);
    });
    const r = await captures(s, 8);
    expect(r.pixels).toBe(0);
  }, 120_000);

  it('values carried by aria-label on a plain span and by <img alt> in a value cell never reach the DOM snapshot', async () => {
    const s = await openHtml(
      `<table><tr><td>Address</td><td><img alt="31 Alder Ct" width="8" height="8" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></td></tr>
       <tr><td>Phone</td><td><span aria-label="413-555-0177" title="413-555-0177">call</span></td></tr></table>
       <p><span aria-label="SSN 123-45-6789">id</span></p>`,
    );
    const dom = await s.domSnapshot();
    expect(dom).not.toContain('31 Alder Ct');
    expect(dom).not.toContain('413-555-0177');
    expect(dom).not.toContain('123-45-6789');
    const text = JSON.stringify({ ...(await s.observe()), screenshotPng: undefined } satisfies Partial<Observation>);
    expect(text).not.toContain('31 Alder Ct');
    expect(text).not.toContain('413-555-0177');
  });

  it('a masked control keeps its verb, and the observation and describeRef (a policy event) name it the same way', async () => {
    // "Ann Lee" is hidden in the roster (Name column); the link elsewhere repeats it.
    const s = await openHtml(
      `<table><tr><th>Name</th><th>Branch</th></tr><tr><td class="pii">Ann Lee</td><td>North</td></tr></table><p><a href="#x" onclick="return false">Delete <span class="pii">Ann Lee</span></a></p>`,
      { maskLabels: ['^name$'] },
    );
    const obs = await s.observe();
    const link = obs.elements.find((e) => e.role === 'link' && e.name.startsWith('Delete'))!;
    expect(link.name).toMatch(/^Delete \[MASKED:/);
    const described = await s.describeRef(link.ref);
    expect(described?.name).toBe(link.name);
    expect(described?.classifyName).toContain('Ann Lee'); // classification only; never quoted
  });

  it('the raw browser message of a failed action goes to the local debug sink (CU_DEBUG) only', async () => {
    const s = await openHtml(`<button id="go">Go</button><div style="position:fixed;left:0;top:0;width:300px;height:200px">Member 5 Secret Way</div>`);
    const go = (await s.observe()).elements.find((e) => e.name === 'Go')!;
    const written: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.env['CU_DEBUG'] = '1';
    (process.stderr as unknown as { write: (c: string) => boolean }).write = (c: string) => {
      written.push(String(c));
      return true;
    };
    try {
      const r = await s.act({ type: 'click', target: { ref: go.ref } }, 1200);
      expect(r.ok).toBe(false);
      expect(r.error?.message).not.toContain('Secret Way');
    } finally {
      (process.stderr as unknown as { write: typeof original }).write = original;
      delete process.env['CU_DEBUG'];
    }
    expect(written.join('')).toMatch(/\[cu-debug\] act: /);
    expect(logs.join('\n')).not.toContain('Secret Way');
  });
});

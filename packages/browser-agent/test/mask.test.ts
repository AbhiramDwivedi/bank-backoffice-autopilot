/**
 * Screen-mask planning (src/mask.ts), exercised through `window.__cuAgent.lib` against a fixture
 * page with every layout the label rule covers (label/value cells with a spacer cell, a header
 * row over a data grid, dt/dd, bold captions followed by bare text, `<label for>`), plus the
 * selector, input, text-pattern and propagation rules, in both integration modes.
 */
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MaskPlanOptions, MaskPlanResult } from '../src/types.js';
import { launchBrowser, MODES, type Mode, openPage, startServer, type TestServer } from './helpers.js';

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

const ATTR = 'data-cu-mask';

function options(overrides: Partial<MaskPlanOptions> = {}): MaskPlanOptions {
  return {
    attr: ATTR,
    nonce: 'n1',
    maskInputs: 'typed',
    selectors: [],
    labels: [],
    textPatterns: [],
    ...overrides,
  };
}

function touches(page: Page, nonce: string, id: string): Promise<boolean> {
  return page.evaluate(([n, i]) => window.__cuAgent!.lib.maskTouches(n, document.getElementById(i)!), [nonce, id] as const);
}

function plan(page: Page, opts: MaskPlanOptions): Promise<MaskPlanResult> {
  return page.evaluate((o) => window.__cuAgent!.lib.maskPlan(o), opts);
}

/** id -> mask kind of every element marked with `nonce`; ids of the elements painted for it. */
function marks(page: Page, nonce: string): Promise<{ byId: Record<string, string>; painted: string[] }> {
  return page.evaluate(
    ([attr, n]) => {
      const byId: Record<string, string> = {};
      for (const el of Array.from(document.querySelectorAll(`[${attr}="${n}"]`))) {
        if (el.id) byId[el.id] = el.getAttribute('data-cu-mask-kind') ?? '';
      }
      const painted = Array.from(document.querySelectorAll(`[data-cu-mask-paint="${n}"]`)).map((e) => e.id || e.tagName.toLowerCase());
      return { byId, painted };
    },
    [ATTR, nonce] as const,
  );
}

describe.each(MODES)('maskPlan() [%s mode]', (mode: Mode) => {
  it('label rule: label/value cells (spacer cell skipped), header-row columns, dt/dd, bold captions, <label for>; labels stay visible', async () => {
    const { context, page } = await openPage(browser, server, mode, 'mask-rules.html');
    try {
      const r = await plan(page, options({ labels: ['^address$', 'savings balance', '^ssn$', 'date of birth', '^phone$', 'e-?mail'] }));
      expect(r.errors).toEqual([]);
      const { byId, painted } = await marks(page, 'n1');
      expect(byId.addr).toBe('address');
      expect(byId.bal).toBe('savings_balance');
      expect(byId.gridssn).toBe('ssn');
      expect(byId.dob).toBe('date_of_birth');
      expect(byId.em).toBe('e_mail');
      expect(byId.hiddenaddr, 'a hidden tab is in the DOM snapshot, so it is masked too').toBe('address');
      // The caption's value is a bare text node: its block (the paragraph) is painted, an element mask.
      expect(painted).toContain('captions');
      expect(r.texts.map((t) => t.text)).toContain('(413) 555-0100');
      // Labels, neighbours and other columns are untouched.
      for (const id of ['name', 'mid', 'sfx', 'opened', 'plan', 'branch', 'q', 'heading']) expect(byId[id], id).toBeUndefined();
      expect(r.texts.map((t) => t.text)).toEqual(expect.arrayContaining(['101 Elm St, Springfield, MA 01103', '$1,234.56', '111-22-3333', '01/02/1970']));
      // Field values are never reported as masked text (they are not propagated either).
      expect(r.texts.map((t) => t.text)).not.toContain('jane@example.com');
    } finally {
      await context.close();
    }
  });

  it('a th+td first row is a label/value row, colspans map header columns; a rule matches the whole label, so a label cell carrying data is no label', async () => {
    const { context, page } = await openPage(browser, server, mode, 'mask-rules.html');
    try {
      await plan(page, options({ labels: ['(tax )?ssn', '^phone$'] }));
      const { byId } = await marks(page, 'n1');
      expect(byId.thssn).toBe('tax_ssn');
      expect(byId.verified, '"SSN 555-66-7777" is not the whole of a label').toBeUndefined();
      expect(byId.spanphone).toBe('phone');
      expect(byId.first).toBeUndefined();
      expect(byId.last).toBeUndefined();
      const kinds = await page.evaluate(() => Array.from(document.querySelectorAll('[data-cu-mask-kind]')).map((e) => e.getAttribute('data-cu-mask-kind')));
      expect(kinds.join(' ')).not.toMatch(/\d/);
    } finally {
      await context.close();
    }
  });

  it('propagation: text hidden by its label is hidden wherever the page repeats it', async () => {
    const { context, page } = await openPage(browser, server, mode, 'mask-rules.html');
    try {
      await plan(page, options({ labels: ['member name'] }));
      const { byId } = await marks(page, 'n1');
      expect(byId.name).toBe('member_name');
      // The heading and the sentence repeat it inside other text: a range is hidden, not the whole element.
      expect(byId.heading).toBeUndefined();
      expect(await touches(page, 'n1', 'heading')).toBe(true);
      expect(await touches(page, 'n1', 'echo')).toBe(true);
      expect(await touches(page, 'n1', 'plain')).toBe(false);
    } finally {
      await context.close();
    }
  });

  it("maskInputs: 'all' hides every text field, select and textarea, empty or not; 'typed' hides none of them", async () => {
    const { context, page } = await openPage(browser, server, mode, 'mask-rules.html');
    try {
      await page.fill('#empty', '');
      const all = await plan(page, options({ maskInputs: 'all', nonce: 'all' }));
      const allMarks = (await marks(page, 'all')).byId;
      for (const id of ['em', 'q', 'pw', 'sel', 'ta']) expect(allMarks[id], id).toBe('input');
      expect(allMarks.btn).toBeUndefined();
      expect(allMarks.empty, 'an empty field too: a value can arrive after the plan').toBe('input');
      expect(all.fields, 'nothing left visible to compare').toEqual([]);

      const typed = await plan(page, options({ maskInputs: 'typed', nonce: 'typed' }));
      const typedMarks = (await marks(page, 'typed')).byId;
      for (const id of ['em', 'q', 'sel', 'ta']) expect(typedMarks[id], id).toBeUndefined();
      expect(typed.fields).toEqual(expect.arrayContaining(['jane@example.com', 'search text', 'Checking', 'notes typed']));
    } finally {
      await context.close();
    }
  });

  it('selector rule hides the element and reports its text and its inner texts', async () => {
    const { context, page } = await openPage(browser, server, mode, 'mask-rules.html');
    try {
      const r = await plan(page, options({ selectors: ['.secret-box'] }));
      const { byId } = await marks(page, 'n1');
      expect(byId.box).toBe('selector');
      expect(r.texts.map((t) => t.text)).toEqual(expect.arrayContaining(['Top secret block inner words', 'inner words']));
    } finally {
      await context.close();
    }
  });

  it("text-pattern rule hides an element whose own text matches, named after the pattern", async () => {
    const { context, page } = await openPage(browser, server, mode, 'mask-rules.html');
    try {
      const r = await plan(page, options({ textPatterns: [{ name: 'ssn', regex: '\\b\\d{3}-\\d{2}-\\d{4}\\b' }] }));
      const { byId } = await marks(page, 'n1');
      expect(byId.gridssn, 'a cell that is only the match is hidden whole').toBe('ssn');
      expect(byId.note, 'a sentence holding a match gets a range').toBeUndefined();
      expect(await touches(page, 'n1', 'note')).toBe(true);
      expect(r.texts).toEqual(expect.arrayContaining([{ text: '987-65-4321', kind: 'ssn' }]));
      expect(await touches(page, 'n1', 'plain')).toBe(false);
    } finally {
      await context.close();
    }
  });

  it('blocks are reported for the driver, maskMark hides the ranges it matched, maskClear removes every mark and paint mark', async () => {
    const { context, page } = await openPage(browser, server, mode, 'mask-rules.html');
    try {
      const r = await plan(page, options({ labels: ['^phone$'] }));
      const idx = r.blocks.indexOf('Nothing to see here');
      expect(idx).toBeGreaterThanOrEqual(0);
      const added = await page.evaluate(([i]) => window.__cuAgent!.lib.maskMark('n1', [{ block: i, start: 11, end: 14 }], [], 'Sensitive'), [idx] as const);
      expect(added?.texts).toEqual([{ text: 'see', kind: 'sensitive' }]);
      expect((await marks(page, 'n1')).painted, 'the range paints its block').toContain('plain');
      expect(await touches(page, 'n1', 'plain')).toBe(true);
      expect(await page.evaluate(() => window.__cuAgent!.lib.maskMark('no-such-plan', [], [], 'x'))).toBeNull();

      await page.evaluate(([a]) => window.__cuAgent!.lib.maskClear(a, 'n1'), [ATTR] as const);
      const after = await page.evaluate(() => document.querySelectorAll('[data-cu-mask], [data-cu-mask-kind], [data-cu-mask-paint]').length);
      expect(after).toBe(0);
    } finally {
      await context.close();
    }
  });

  it('an invalid selector or regex is an error (the driver fails closed), not a silently skipped rule', async () => {
    const { context, page } = await openPage(browser, server, mode, 'mask-rules.html');
    try {
      const r = await plan(page, options({ selectors: ['td[['], labels: ['('], textPatterns: [{ name: 'bad', regex: '[' }] }));
      expect(r.errors).toHaveLength(3);
      const kind = await page.evaluate(
        ([a]) => window.__cuAgent!.lib.maskKindOf(document.getElementById('plain')!, { attr: a, maskInputs: 'typed', selectors: ['td[['], labels: [], textPatterns: [] }),
        [ATTR] as const,
      );
      expect(kind).toBe('masked');
    } finally {
      await context.close();
    }
  });

  it('maskKindOf answers for one element with the same rules and leaves no marks behind', async () => {
    const { context, page } = await openPage(browser, server, mode, 'mask-rules.html');
    try {
      const kinds = await page.evaluate(
        ([a]) => {
          const opts = { attr: a, maskInputs: 'typed' as const, selectors: [], labels: ['savings balance'], textPatterns: [] };
          return {
            bal: window.__cuAgent!.lib.maskKindOf(document.getElementById('bal')!, opts),
            mid: window.__cuAgent!.lib.maskKindOf(document.getElementById('mid')!, opts),
            left: document.querySelectorAll('[data-cu-mask-kind]').length,
          };
        },
        [ATTR] as const,
      );
      expect(kinds).toEqual({ bal: 'savings_balance', mid: '', left: 0 });
    } finally {
      await context.close();
    }
  });

  it('a value split across spans or bold runs is matched over the block text, and the hidden range spans the nodes', async () => {
    const { context, page } = await openPage(browser, server, mode, 'mask-layouts.html');
    try {
      const r = await plan(
        page,
        options({
          labels: ['address'],
          textPatterns: [
            { name: 'ssn', regex: '\\b\\d{3}-\\d{2}-\\d{4}\\b' },
            { name: 'card', regex: '\\b(?:\\d[ -]?){12,18}\\d\\b' },
          ],
        }),
      );
      const texts = r.texts.map((t) => t.text);
      expect(texts).toEqual(expect.arrayContaining(['123-45-6789', '987-65-4321', '4111 1111 1111 1111']));
      expect(await touches(page, 'n1', 'splitssn')).toBe(true);
      expect(await touches(page, 'n1', 'cards')).toBe(true);
      // Every range paints the innermost element holding it.
      expect(
        await page.evaluate(() =>
          ['splitssn', 'cards'].every((id) => !!document.getElementById(id)!.closest('[data-cu-mask-paint="n1"]') || !!document.getElementById(id)!.querySelector('[data-cu-mask-paint="n1"]')),
        ),
      ).toBe(true);
    } finally {
      await context.close();
    }
  });

  it('label and value in one block: "Address: 1 Main St" in one cell, and "Label: value" lines split by <br>', async () => {
    const { context, page } = await openPage(browser, server, mode, 'mask-layouts.html');
    try {
      const r = await plan(page, options({ labels: ['address', 'phone'] }));
      const texts = r.texts.map((t) => t.text);
      expect(texts).toEqual(expect.arrayContaining(['1 Main St', '413-555-0100', '9 Elm Rd']));
      expect(texts).not.toContain('South');
      expect(texts).not.toContain('North');
      // Propagation then hides the same address where the page repeats it.
      expect(await touches(page, 'n1', 'split')).toBe(true);
      expect(await touches(page, 'n1', 'plaincell')).toBe(false);
    } finally {
      await context.close();
    }
  });

  it('a header row that is not the first row labels the rows below it; rowspans shift the columns', async () => {
    const { context, page } = await openPage(browser, server, mode, 'mask-layouts.html');
    try {
      await plan(page, options({ labels: ['^address$', '^phone$'] }));
      const { byId } = await marks(page, 'n1');
      expect(byId.r1addr).toBe('address');
      expect(byId.r2addr).toBe('address');
      expect(byId.r1name).toBeUndefined();
      expect(byId.rsphone1).toBe('phone');
      expect(byId.rsphone2, 'second row starts one column late under the rowspan').toBe('phone');
      expect(byId.rsname2).toBeUndefined();
    } finally {
      await context.close();
    }
  });

  it('<output> by its label, inputs by title or placeholder, and a masked select reports its option texts', async () => {
    const { context, page } = await openPage(browser, server, mode, 'mask-layouts.html');
    try {
      const r = await plan(page, options({ labels: ['^address$', '^phone$', '^email$'], selectors: ['#statesel'] }));
      const { byId } = await marks(page, 'n1');
      expect(byId.out).toBe('address');
      expect(byId.titled).toBe('phone');
      expect(byId.placeheld).toBe('email');
      expect(r.texts.map((t) => t.text)).toEqual(expect.arrayContaining(['Ohio Utah Iowa']));
    } finally {
      await context.close();
    }
  });

  it("a range inside an interactive control marks the whole control; a masked element's differing aria-label is reported too", async () => {
    const { context, page } = await openPage(browser, server, mode, 'mask-layouts.html');
    try {
      const r = await plan(page, options({ labels: ['^name$'], selectors: ['.secret'] }));
      const { byId } = await marks(page, 'n1');
      expect(byId.delete).toBe('name');
      expect(r.texts.map((t) => t.text)).toEqual(expect.arrayContaining(['Member Ann Lee']));
    } finally {
      await context.close();
    }
  });

  it('maskVerify: unchanged document passes; a text or value change, a stripped mark or paint mark, a replaced document fail; style and scroll do not count', async () => {
    const { context, page } = await openPage(browser, server, mode, 'mask-layouts.html');
    try {
      const verify = (n: string) => page.evaluate((x) => window.__cuAgent!.lib.maskVerify(x), n);
      await plan(page, options({ labels: ['^address$'], nonce: 'v1' }));
      expect(await verify('v1')).toBe(true);
      // Restyling cannot un-mask an element mask: not counted (a 50 ms ticker must not starve capture).
      await page.evaluate(() => {
        const el = document.getElementById('plain') as HTMLElement;
        el.style.position = 'relative';
        el.style.left = '7px';
        el.className = 'moved';
        window.scrollTo(0, 5);
      });
      expect(await verify('v1')).toBe(true);
      await page.evaluate(() => (document.getElementById('plain')!.textContent = 'changed'));
      expect(await verify('v1')).toBe(false);

      await plan(page, options({ labels: ['^address$'], nonce: 'v2' }));
      await page.evaluate(() => document.getElementById('r1addr')!.removeAttribute('data-cu-mask'));
      expect(await verify('v2')).toBe(false);

      await plan(page, options({ labels: ['^address$'], nonce: 'v3' }));
      await page.evaluate(() => document.querySelector('[data-cu-mask-paint="v3"]')!.removeAttribute('data-cu-mask-paint'));
      expect(await verify('v3'), 'a stripped paint mark').toBe(false);

      await plan(page, options({ labels: ['^address$'], nonce: 'v4' }));
      await page.evaluate(() => document.querySelector('input')?.setAttribute('value', 'x'));
      expect(await verify('v4'), 'a value attribute change').toBe(false);

      await page.reload();
      expect(await verify('v4')).toBeNull();
    } finally {
      await context.close();
    }
  });

  it("maskInputs 'all' marks every text-like field, empty or not; not buttons, checkboxes or hidden inputs", async () => {
    const { context, page } = await openPage(browser, server, mode, 'mask-layouts.html');
    try {
      await page.evaluate(() => {
        const host = document.createElement('div');
        host.innerHTML =
          '<input id="f-empty"><input id="f-full" value="x1"><textarea id="f-ta"></textarea><select id="f-sel"><option>a</option></select>' +
          '<div id="f-ce" contenteditable="true"></div><input id="f-btn" type="button" value="Go"><input id="f-cb" type="checkbox"><input id="f-hid" type="hidden" value="h">';
        document.body.appendChild(host);
      });
      await plan(page, options({ maskInputs: 'all' }));
      const { byId } = await marks(page, 'n1');
      for (const id of ['f-empty', 'f-full', 'f-ta', 'f-sel', 'f-ce']) expect(byId[id], id).toBe('input');
      for (const id of ['f-btn', 'f-cb', 'f-hid']) expect(byId[id], id).toBeUndefined();
    } finally {
      await context.close();
    }
  });

  it('paint hosts: a range paints the innermost element holding it, wherever it is laid out (display:contents, overflow, off-screen)', async () => {
    const { context, page } = await openPage(browser, server, mode, 'mask-layouts.html');
    try {
      await page.evaluate(() => {
        const host = document.createElement('div');
        host.innerHTML =
          '<div id="pc-outer">Ref <span id="pc-contents" style="display:contents">SSN 123-45-6789</span></div>' +
          '<div id="pc-wrap" style="width:300px"><div id="pc-narrow" style="width:20px;white-space:nowrap">card 4111 1111 1111 1111</div></div>' +
          '<div id="pc-fixed" style="position:fixed;left:-500px;top:0;width:50px;overflow:visible;white-space:nowrap">999-88-7777 is off the page edge</div>';
        document.body.appendChild(host);
      });
      await plan(
        page,
        options({
          textPatterns: [
            { name: 'ssn', regex: '\\b\\d{3}-\\d{2}-\\d{4}\\b' },
            { name: 'card', regex: '\\b(?:\\d[ -]?){12,18}\\d\\b' },
          ],
        }),
      );
      const { painted } = await marks(page, 'n1');
      expect(painted, 'the display:contents element itself (CSS redaction needs no box)').toContain('pc-contents');
      expect(painted, 'the narrow box the text overflows').toContain('pc-narrow');
      expect(painted).not.toContain('pc-wrap');
      expect(painted, 'off-screen content is painted too').toContain('pc-fixed');
    } finally {
      await context.close();
    }
  });

  it('"Label: value" anywhere in a line: long prose, several pairs on one line, sentence ends; a label word without a colon and a time are not labels', async () => {
    const { context, page } = await openPage(browser, server, mode, 'mask-layouts.html');
    try {
      await page.evaluate(() => {
        const host = document.createElement('div');
        host.innerHTML =
          '<p id="lp-short">Called member re payment plan. Address: 1 Main St</p>' +
          '<p id="lp-long">Called member about the overdue payment plan and the new schedule. Address: 2 Long Rd</p>' +
          '<p id="lp-pairs">Phone: 413-555-0177 Address: 3 Pair Ave Branch: North</p>' +
          '<p id="lp-multi">Mailing address: 4 Multi Way; Status: open</p>' +
          '<p id="lp-word">The address on file was confirmed at 10:30 today and the phone works.</p>' +
          '<p id="lp-time">Callback at 10:30: confirmed</p>' +
          '<span id="lp-aria" aria-label="Address: 5 Aria Ct">home</span>';
        document.body.appendChild(host);
        document.body.appendChild(document.createTextNode('Body level note about the member account status. Address: 6 Body St'));
      });
      const r = await plan(page, options({ labels: ['^address$', '^phone$', 'mailing address'] }));
      const texts = r.texts.map((t) => t.text);
      expect(texts).toEqual(expect.arrayContaining(['1 Main St', '2 Long Rd', '413-555-0177', '3 Pair Ave', '4 Multi Way', '5 Aria Ct', '6 Body St']));
      expect(texts, 'the next pair is not part of the value').not.toContain('413-555-0177 Address: 3 Pair Ave Branch: North');
      expect(texts.some((t) => t.includes('Branch')), 'an unmatched label after the value stays visible').toBe(false);
      expect(texts.some((t) => t.includes('confirmed')), 'no colon after a label word, and a time, are not labels').toBe(false);
      const { painted } = await marks(page, 'n1');
      expect(painted).toEqual(expect.arrayContaining(['lp-short', 'lp-long', 'lp-pairs', 'lp-multi']));
      expect(painted).not.toContain('lp-word');
      expect(painted).not.toContain('lp-time');
    } finally {
      await context.close();
    }
  });

  it('"Label: value" with full-width colons, and labels that only contain a label word stay visible (whole-label match)', async () => {
    const { context, page } = await openPage(browser, server, mode, 'mask-layouts.html');
    try {
      await page.evaluate(() => {
        const host = document.createElement('div');
        host.innerHTML =
          '<p id="fw-ff1a">Address：1 Wide St</p>' +
          '<p id="fw-fe55">Phone﹕ 413-555-0188</p>' +
          '<p id="fp-book">Address book: 12 entries</p>' +
          '<p id="fp-hours">Phone support hours: 9 to 5 weekdays</p>' +
          '<p id="fp-verified">Address verified: yes</p>' +
          '<p id="fp-url">See https://intranet/address: details here</p>' +
          '<p id="sx-mailing">Mailing address: 7 Mail Rd</p>' +
          '<p id="sx-prose">Please confirm the following address: 8 Prose Ave</p>' +
          '<table><tr><td>Address book</td><td id="fp-cell">12 entries</td></tr></table>';
        document.body.appendChild(host);
      });
      const r = await plan(page, options({ labels: ['address', 'phone'] }));
      const texts = r.texts.map((t) => t.text);
      expect(texts).toEqual(expect.arrayContaining(['1 Wide St', '413-555-0188', '7 Mail Rd', '8 Prose Ave']));
      for (const visible of ['12 entries', '9 to 5 weekdays', 'yes', 'details here']) expect(texts, visible).not.toContain(visible);
      const { byId, painted } = await marks(page, 'n1');
      expect(painted).toEqual(expect.arrayContaining(['fw-ff1a', 'fw-fe55', 'sx-mailing', 'sx-prose']));
      for (const id of ['fp-book', 'fp-hours', 'fp-verified', 'fp-url']) expect(painted, id).not.toContain(id);
      expect(byId['fp-cell'], 'a cell next to "Address book"').toBeUndefined();
    } finally {
      await context.close();
    }
  });

  it('maskSheetCheck: the redaction stylesheet wins on marked content, and an inline !important style or a descendant forced visible is reported', async () => {
    const { context, page } = await openPage(browser, server, mode, 'mask-layouts.html');
    try {
      await plan(page, options({ labels: ['^address$'], nonce: 's1' }));
      const S = (n: string): string =>
        `[data-cu-mask="${n}"]:not(#x1):not(#x2):not(#x3):not(#x4), [data-cu-mask-paint="${n}"]:not(#x1):not(#x2):not(#x3):not(#x4)`;
      const css = (n: string): string =>
        `/*cu-mask:${n}*/ ${S(n)} { color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: none !important; } ` +
        S(n).split(', ').map((x) => `${x} *, ${x}::before, ${x}::after`).join(', ') + ' { visibility: hidden !important; }';
      const check = (): Promise<number | null> => page.evaluate(([n, c]) => window.__cuAgent!.lib.maskSheetCheck(n, c), ['s1', css('s1')] as const);
      expect(await check()).toBe(0);
      await page.evaluate(() => (document.getElementById('r1addr') as HTMLElement).style.setProperty('color', 'red', 'important'));
      expect(await check()).toBe(1);
      await page.evaluate(() => {
        (document.getElementById('r1addr') as HTMLElement).style.removeProperty('color');
        const b = document.createElement('b');
        b.textContent = 'x';
        b.style.setProperty('visibility', 'visible', 'important');
        document.getElementById('r2addr')!.appendChild(b);
      });
      expect(await check()).toBe(1);
      expect(await page.evaluate(() => window.__cuAgent!.lib.maskSheetCheck('gone', ''))).toBeNull();
    } finally {
      await context.close();
    }
  });

  it('no page-settable attribute exempts content from the rules (an element claiming to be a driver overlay is planned like any other)', async () => {
    const { context, page } = await openPage(browser, server, mode, 'mask-layouts.html');
    try {
      await page.evaluate(() => {
        const t = document.createElement('table');
        t.setAttribute('data-cu-mask-overlay', 'n1');
        t.innerHTML = '<tr><td>Address</td><td id="ov-addr" data-cu-mask-overlay="n1">88 Decoy Ave</td></tr>';
        document.body.appendChild(t);
      });
      const r = await plan(page, options({ labels: ['^address$'] }));
      expect((await marks(page, 'n1')).byId['ov-addr']).toBe('address');
      expect(r.texts.map((t) => t.text)).toContain('88 Decoy Ave');
    } finally {
      await context.close();
    }
  });

  it('maskObserve: plan, enumerate and the kinds of the enumerated elements in one call', async () => {
    const { context, page } = await openPage(browser, server, mode, 'mask-layouts.html');
    try {
      const out = await page.evaluate((o) => {
        const r = window.__cuAgent!.lib.maskObserve(o);
        const i = r.enumeration.els.findIndex((e) => e.id === 'r1addr');
        return { kinds: r.kinds, at: i >= 0 ? r.kinds[i] : 'not enumerated', errors: r.plan.errors, n: r.enumeration.els.length };
      }, options({ labels: ['^address$'] }));
      expect(out.errors).toEqual([]);
      expect(out.kinds.length).toBe(out.n);
      expect(out.at === 'address' || out.at === 'not enumerated').toBe(true);
      expect(out.kinds.some((k) => k === 'address')).toBe(true);
    } finally {
      await context.close();
    }
  });

  it("maskObserve with enumerate options: the page's cap applies, `omitted` counts the rest, and the kinds stay parallel to `els`", async () => {
    const { context, page } = await openPage(browser, server, mode, 'mask-layouts.html');
    try {
      const out = await page.evaluate((o) => {
        const full = window.__cuAgent!.lib.maskObserve(o);
        const capped = window.__cuAgent!.lib.maskObserve({ ...o, nonce: 'n2' }, { maxElements: 5 });
        return { full: full.enumeration.els.length, n: capped.enumeration.els.length, data: capped.enumeration.data.length, kinds: capped.kinds.length, omitted: capped.enumeration.omitted };
      }, options({ labels: ['^address$'] }));
      expect(out.full).toBeGreaterThan(5);
      expect(out.n).toBe(5);
      expect(out.data).toBe(5);
      expect(out.kinds).toBe(5);
      expect(out.omitted).toBe(out.full - 5);
    } finally {
      await context.close();
    }
  });

  it('values carried by alt / aria-label / title: a label-rule cell with only an image is masked, and the DOM copy blanks the attributes', async () => {
    const { context, page } = await openPage(browser, server, mode, 'mask-layouts.html');
    try {
      await page.evaluate(() => {
        const t = document.createElement('table');
        t.innerHTML =
          '<tr><td>Address</td><td id="ac-img"><img alt="12 Oak Ln" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></td></tr>' +
          '<tr><td>Address</td><td id="ac-span"><span aria-label="34 Pine Ct">*</span></td></tr>';
        document.body.appendChild(t);
      });
      const r = await plan(page, options({ labels: ['^address$'] }));
      const { byId } = await marks(page, 'n1');
      expect(byId['ac-img']).toBe('address');
      expect(byId['ac-span']).toBe('address');
      expect(r.texts.map((t) => t.text)).toEqual(expect.arrayContaining(['12 Oak Ln', '34 Pine Ct']));
      const html = await page.evaluate(() => window.__cuAgent!.lib.maskClone('n1')!.outerHTML);
      expect(html).not.toContain('12 Oak Ln');
      expect(html).not.toContain('34 Pine Ct');
    } finally {
      await context.close();
    }
  });

  it('maskKindOf is cached until the document changes', async () => {
    const { context, page } = await openPage(browser, server, mode, 'mask-layouts.html');
    try {
      const kind = (id: string) =>
        page.evaluate(
          ([i, a]) => window.__cuAgent!.lib.maskKindOf(document.getElementById(i)!, { attr: a, maskInputs: 'typed', selectors: [], labels: ['^address$'], textPatterns: [] }),
          [id, ATTR] as const,
        );
      expect(await kind('r1addr')).toBe('address');
      expect(await kind('plain')).toBe('');
      // A new row under the header: the cache is invalidated by the change, and the new cell is answered.
      await page.evaluate(() => {
        const row = (document.querySelector('#latehead tbody') as HTMLTableSectionElement).insertRow();
        row.insertCell().textContent = 'Ed';
        const c = row.insertCell();
        c.id = 'r3addr';
        c.textContent = '7 Fir St';
      });
      expect(await kind('r3addr')).toBe('address');
    } finally {
      await context.close();
    }
  });
});

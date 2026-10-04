/**
 * In-page-level port of the driver's legacy enumerate.test.ts (plus the in-page-semantics
 * assertions from resolve.test.ts that apply without the Playwright-side resolver): naming,
 * selection, descriptor-synthesis inputs and structural selectors, exercised directly through
 * `window.__cuAgent` (enumerate/describe/closestClickable/structuralSelector), in both integration
 * modes (`injected` and `included`; see helpers.ts).
 */
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enumerateJson, launchBrowser, MODES, type Mode, openPage, startServer, type TestServer } from './helpers.js';

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

describe.each(MODES)('enumerate() [%s mode]', (mode: Mode) => {
  it('enum-login: adjacent-cell names, password redaction, image-submit button role, non-generated-id css selector', async () => {
    const { context, page } = await openPage(browser, server, mode, 'enum-login.html');
    try {
      const before = await enumerateJson(page);
      const userId = before.data.find((d) => d.name === 'User ID');
      const password = before.data.find((d) => d.name === 'Password');
      expect(userId, JSON.stringify(before.data, null, 2)).toBeDefined();
      expect(password, JSON.stringify(before.data, null, 2)).toBeDefined();
      expect(userId!.nameSource).toBe('adjacent-cell');
      expect(userId!.labelKind).toBe('adjacent-cell');
      expect(password!.nameSource).toBe('adjacent-cell');
      expect(password!.labelKind).toBe('adjacent-cell');
      expect(password!.value, 'nothing typed yet').toBeUndefined();

      // Type into the password field directly (bypassing any capture/act layer); enumerate() must
      // still report it redacted, and the secret must never appear in the JSON.
      await page.fill('input[name=password]', 'super-secret-1');
      const after = await enumerateJson(page);
      const password2 = after.data.find((d) => d.name === 'Password');
      expect(password2, JSON.stringify(after.data, null, 2)).toBeDefined();
      expect(password2!.value).toBe('[REDACTED]');
      expect(JSON.stringify(after)).not.toContain('super-secret-1');

      // input[type=image] -> role 'button'
      const submit = after.data.find((d) => d.tag === 'input' && d.inputType === 'image');
      expect(submit, JSON.stringify(after.data, null, 2)).toBeDefined();
      expect(submit!.role).toBe('button');

      for (const el of [userId!, password2!]) {
        expect(el.cssSelector, `${el.name} should have a non-empty css selector`).not.toBe('');
        expect(el.cssSelector, `${el.name}'s selector must never be a generated id`).not.toMatch(/#/);
      }
    } finally {
      await context.close();
    }
  });

  it('enum-cells: value-cell right-of anchor, clickable-row text locator, message cell, error list, bodyText digest', async () => {
    const { context, page } = await openPage(browser, server, mode, 'enum-cells.html');
    try {
      const r = await enumerateJson(page);

      const valueCell = r.data.find((d) => d.tag === 'td' && d.text === '$1,234.56');
      expect(valueCell, JSON.stringify(r.data, null, 2)).toBeDefined();
      expect(valueCell!.role).toBe('cell');
      expect(valueCell!.rowAnchorText).toBe('Savings Balance');

      const row = r.data.find((d) => d.tag === 'tr' && d.role === 'clickable');
      expect(row, JSON.stringify(r.data, null, 2)).toBeDefined();
      expect(row!.textLocatorCandidate).toBe('12345');
      expect(row!.textLocatorTagOmit).toBe(true);
      expect(row!.textUnique).toBe(true);

      const msg = r.data.find((d) => d.text === 'No records found.');
      expect(msg, JSON.stringify(r.data, null, 2)).toBeDefined();

      const errorItems = r.data.filter((d) => d.tag === 'li');
      expect(errorItems.length).toBeGreaterThanOrEqual(2);

      expect(r.bodyText).toContain('Savings Balance');
      expect(r.bodyText).toContain('12345');
    } finally {
      await context.close();
    }
  });

  it('enum-frameset: enumerate() inside each frame; inner button rect matches its own getBoundingClientRect within 2px; bodyText per frame', async () => {
    const { context, page } = await openPage(browser, server, mode, 'enum-frameset.html');
    try {
      const leftFrame = page.frame({ name: 'left' });
      const mainFrame = page.frame({ name: 'main' });
      const innerFrame = page.frame({ name: 'inner' });
      expect(leftFrame, 'left frame should be attached').toBeTruthy();
      expect(mainFrame, 'main frame should be attached').toBeTruthy();
      expect(innerFrame, 'inner frame should be attached').toBeTruthy();

      const leftR = await enumerateJson(leftFrame!);
      const mainR = await enumerateJson(mainFrame!);
      const innerR = await enumerateJson(innerFrame!);

      expect(leftR.bodyText).toContain('Left Nav');
      expect(mainR.bodyText).toContain('Main Frame Heading');
      expect(innerR.bodyText).toContain('Inner Button');

      const innerBtn = innerR.data.find((d) => d.tag === 'button');
      expect(innerBtn, JSON.stringify(innerR.data, null, 2)).toBeDefined();
      expect(innerBtn!.name).toBe('Inner Button');

      const ownRect = await innerFrame!.evaluate(() => {
        const el = document.getElementById('innerBtn')!;
        const r = el.getBoundingClientRect();
        return { x: r.left, y: r.top, w: r.width, h: r.height };
      });
      expect(Math.abs(innerBtn!.rect.x - ownRect.x)).toBeLessThanOrEqual(2);
      expect(Math.abs(innerBtn!.rect.y - ownRect.y)).toBeLessThanOrEqual(2);
      expect(Math.abs(innerBtn!.rect.w - ownRect.w)).toBeLessThanOrEqual(2);
      expect(Math.abs(innerBtn!.rect.h - ownRect.h)).toBeLessThanOrEqual(2);
    } finally {
      await context.close();
    }
  });

  it('enum-cap: default returns every button; maxElements:150 returns exactly 150, all buttons, interactive-first prefix of the uncapped list', async () => {
    const { context, page } = await openPage(browser, server, mode, 'enum-cap.html');
    try {
      const full = await enumerateJson(page);
      expect(full.data.length).toBe(300);
      expect(full.data.every((d) => d.tag === 'button')).toBe(true);

      const capped = await enumerateJson(page, { maxElements: 150 });
      expect(capped.data.length).toBe(150);
      expect(capped.data.every((d) => d.tag === 'button')).toBe(true);
      expect(capped.data.every((d) => d.group === 'interactive')).toBe(true);
      expect(capped.data).toEqual(full.data.slice(0, 150));
    } finally {
      await context.close();
    }
  });

  it("enum-nested-leaf-anchor: a wrapping <tr>/<td> that only inherits its label text via innerText must not be picked as the 'above' anchor (isTextLeaf)", async () => {
    // Without isTextLeaf, the <tr> wrapping the label cell has the SAME collapsed own-text
    // ('Label:') as the leaf <font> that actually renders it, but a much wider bounding box (the
    // whole row, both cells) -- wide enough to horizontally overlap the offset button below,
    // where the narrow <font> box does not. That made the row's own text look, incorrectly, like
    // it was directly above the button. isTextLeaf excludes non-leaf wrappers like that <tr> (and
    // its <td>) from the anchor-candidate set, so only true text leaves are considered.
    const { context, page } = await openPage(browser, server, mode, 'enum-nested-leaf-anchor.html');
    try {
      const r = await enumerateJson(page);
      const ctrl = r.data.find((d) => d.tag === 'button');
      expect(ctrl, JSON.stringify(r.data, null, 2)).toBeDefined();
      expect(ctrl!.name).toBe('Control');
      expect(ctrl!.aboveAnchorText).not.toBe('Label:');
    } finally {
      await context.close();
    }
  });

  it('closestClickable(): a td inside tr[onclick] resolves to the tr; body/html resolve to null', async () => {
    const { context, page } = await openPage(browser, server, mode, 'resolve-search.html');
    try {
      const result = await page.evaluate(() => {
        const agent = window.__cuAgent;
        if (!agent) throw new Error('window.__cuAgent is not installed');
        const row = document.getElementById('rowMember12345')!;
        const td = row.querySelector('td')!;
        return {
          fromTdIsRow: agent.closestClickable(td) === row,
          fromBody: agent.closestClickable(document.body),
          fromHtml: agent.closestClickable(document.documentElement),
        };
      });
      expect(result.fromTdIsRow).toBe(true);
      expect(result.fromBody).toBeNull();
      expect(result.fromHtml).toBeNull();
    } finally {
      await context.close();
    }
  });

  it('structuralSelector(): result matches exactly the one element it was computed for (resolve-search.html)', async () => {
    const { context, page } = await openPage(browser, server, mode, 'resolve-search.html');
    try {
      const ids = ['txtMbrId', 'txtLName', 'btnSearch', 'rowMember12345', 'rowMember10002', 'edit1', 'edit2'];
      const results = await page.evaluate((elementIds: string[]) => {
        const agent = window.__cuAgent;
        if (!agent) throw new Error('window.__cuAgent is not installed');
        return elementIds.map((id) => {
          const el = document.getElementById(id)!;
          const sel = agent.structuralSelector(el);
          if (!sel) return { id, sel, matchCount: 0, isSame: false };
          const matches = document.querySelectorAll(sel);
          return { id, sel, matchCount: matches.length, isSame: matches.length === 1 && matches[0] === el };
        });
      }, ids);
      for (const r of results) {
        expect(r.sel, `${r.id} should have a non-empty structural selector`).not.toBe('');
        expect(r.matchCount, `${r.id}: selector "${r.sel}"`).toBe(1);
        expect(r.isSame, `${r.id}: selector "${r.sel}" did not resolve back to the same element`).toBe(true);
      }
    } finally {
      await context.close();
    }
  });

  it('describe()/labelFor: adjacent-cell labels, colon stripped, on resolve-search.html', async () => {
    const { context, page } = await openPage(browser, server, mode, 'resolve-search.html');
    try {
      const result = await page.evaluate(() => {
        const agent = window.__cuAgent;
        if (!agent) throw new Error('window.__cuAgent is not installed');
        const mbrId = agent.describe(document.getElementById('txtMbrId')!);
        const lName = agent.describe(document.getElementById('txtLName')!);
        const search = agent.describe(document.getElementById('btnSearch')!);
        return { mbrId, lName, search };
      });
      expect(result.mbrId.label).toBe('Member ID');
      expect(result.mbrId.labelKind).toBe('adjacent-cell');
      // 'Last Name:' in the markup -- the trailing colon must be stripped.
      expect(result.lName.label).toBe('Last Name');
      expect(result.lName.labelKind).toBe('adjacent-cell');
      expect(result.search.role).toBe('clickable');
      expect(result.search.name).toBe('Search');
    } finally {
      await context.close();
    }
  });

  it('describe()/adjacentCellLabel: right-of row anchor on resolve-detail.html', async () => {
    const { context, page } = await openPage(browser, server, mode, 'resolve-detail.html');
    try {
      const result = await page.evaluate(() => {
        const agent = window.__cuAgent;
        if (!agent) throw new Error('window.__cuAgent is not installed');
        const cell = document.getElementById('savingsCell')!;
        return {
          describe: agent.describe(cell),
          anchor: agent.lib.adjacentCellLabel(cell),
        };
      });
      expect(result.describe.role).toBe('cell');
      expect(result.anchor).toBe('Savings Balance');
    } finally {
      await context.close();
    }
  });

  it('inferRole(): li[data-value] is clickable, native <select> is combobox (resolve-dropdown.html)', async () => {
    const { context, page } = await openPage(browser, server, mode, 'resolve-dropdown.html');
    try {
      const result = await page.evaluate(() => {
        const agent = window.__cuAgent;
        if (!agent) throw new Error('window.__cuAgent is not installed');
        const li = document.querySelector('li[data-value="SAV"]')!;
        const select = document.getElementById('nativeSelect')!;
        return { li: agent.describe(li), select: agent.describe(select) };
      });
      expect(result.li.role).toBe('clickable');
      expect(result.li.name).toBe('Savings');
      expect(result.select.role).toBe('combobox');
    } finally {
      await context.close();
    }
  });

  it('enumerate() is document-scoped: bodyText and uniqueness are computed per-frame, independent of a same-named frame elsewhere (resolve-frame-outer.html)', async () => {
    // resolve.test.ts's driver-level equivalent ("scopes resolution to the named frame when the
    // same text appears in more than one frame") tests resolveDescriptor()'s frame-path scoping,
    // which lives entirely in the driver, not in enumerate()/naming/selectors -- 'Duplicate Text'
    // here is a plain <p>, not selected by enumerate() at all (see its selection rules), so there
    // is no per-element assertion to port. What *does* apply without the driver: each frame's own
    // enumerate() only ever looks at its own document, so its bodyText and any uniqueness verdict
    // are unaffected by an identically-named frame elsewhere.
    const { context, page } = await openPage(browser, server, mode, 'resolve-frame-outer.html');
    try {
      await page.waitForSelector('iframe[name="x"]');
      const innerFrame = page.frame({ name: 'x' });
      expect(innerFrame, 'inner frame should be attached').toBeTruthy();

      const outerR = await enumerateJson(page);
      const innerR = await enumerateJson(innerFrame!);
      expect(outerR.bodyText).toContain('Duplicate Text');
      expect(innerR.bodyText).toContain('Duplicate Text');
    } finally {
      await context.close();
    }
  });
  it('resolve-adjacent-cells: findAdjacentCellControls is the exact inverse of the adjacent-cell label', async () => {
    const { context, page } = await openPage(browser, server, mode, 'resolve-adjacent-cells.html');
    try {
      const r = await enumerateJson(page);
      const inputs = r.data.filter((d) => d.tag === 'input');
      expect(inputs.map((d) => [d.labelKind, d.labelText, d.labelTruncated])).toEqual([
        ['adjacent-cell', 'Member ID', false],
        ['adjacent-cell', 'BRANCH CODE', false],
        ['adjacent-cell', 'Primary mailing address for all statements, notices and year-end tax documents s', true],
      ]);
      const found = await page.evaluate((labels) => {
        const lib = window.__cuAgent!.lib;
        return labels.map(([label, exact]) => lib.findAdjacentCellControls(label as string, exact as boolean).map((el) => el.id));
      }, [
        ['Member ID', true],
        ['Member ID:', true],
        ['member id', true],
        ['member id', false],
        ['BRANCH CODE', true],
        ['Branch code', true],
        ['Primary mailing address for all statements, notices and year-end tax documents s', false],
        ['Primary mailing address for all statements, notices and year-end tax documents s', true],
        ['', false],
      ]);
      expect(found).toEqual([['member-id'], ['member-id'], [], ['member-id'], ['branch'], [], ['mailing'], ['mailing'], []]);
    } finally {
      await context.close();
    }
  });
});

/**
 * enumeratePage() / observe() tests, run against real Chromium (headless) over fixtures/*.html
 * served by startFixtureServer().
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LocatorStrategy } from '@cu/core/schema';
import type { ObservedElement } from '@cu/core/surface';
import { createPlaywrightSurface, type PlaywrightSurface } from './surface.js';
import { type FixtureServer, startFixtureServer } from './test-helpers.js';

let server: FixtureServer;

beforeAll(async () => {
  server = await startFixtureServer();
});

afterAll(async () => {
  await server.close();
});

async function openSurface(file: string): Promise<PlaywrightSurface> {
  const surface = await createPlaywrightSurface({ headless: true });
  await surface.page.goto(server.url(file));
  return surface;
}

function locatorsOf<K extends LocatorStrategy['kind']>(el: ObservedElement, kind: K): Extract<LocatorStrategy, { kind: K }>[] {
  return el.descriptor.locators.map((l) => l.strategy).filter((s): s is Extract<LocatorStrategy, { kind: K }> => s.kind === kind);
}

function byName(els: ObservedElement[], name: string): ObservedElement | undefined {
  return els.find((e) => e.name === name);
}

describe('enumeratePage via PlaywrightSurface.observe()', () => {
  // ---------------------------------------------------------------------------------------
  // Legacy login table
  // ---------------------------------------------------------------------------------------
  describe('legacy login table (adjacent-cell labels, input[type=image] submit)', () => {
    it('names inputs from the adjacent <td>, redacts the typed password, and infers a button role for the image submit', async () => {
      const surface = await openSurface('enum-login.html');
      try {
        const obs1 = await surface.observe();
        const userId = byName(obs1.elements, 'User ID');
        const password = byName(obs1.elements, 'Password');
        expect(userId, JSON.stringify(obs1.elements, null, 2)).toBeDefined();
        expect(password).toBeDefined();
        expect(userId!.tag).toBe('input');
        expect(password!.tag).toBe('input');
        expect(password!.value).toBeUndefined(); // nothing typed yet

        // Type into the password field directly, bypassing act.ts; observe() must still report
        // it redacted.
        await surface.page.fill('input[name=password]', 'super-secret-1');
        const obs2 = await surface.observe();
        const password2 = byName(obs2.elements, 'Password');
        expect(password2).toBeDefined();
        expect(password2!.value).toBe('[REDACTED]');
        expect(JSON.stringify(obs2)).not.toContain('super-secret-1');

        // input[type=image] -> role 'button'
        const submit = obs2.elements.find((e) => e.tag === 'input' && e.role === 'button');
        expect(submit, JSON.stringify(obs2.elements, null, 2)).toBeDefined();

        // Descriptor checks for the adjacent-cell-labelled inputs.
        for (const el of [userId!, password2!]) {
          expect(locatorsOf(el, 'role'), `${el.name} should have no role locator`).toHaveLength(0);
          const labelLocators = el.descriptor.locators.filter((l) => l.strategy.kind === 'label');
          expect(labelLocators.length, `${el.name} should have a label locator`).toBeGreaterThan(0);
          expect(labelLocators[0]!.confidence).toBeCloseTo(0.8, 5);
          const cssLocators = locatorsOf(el, 'css');
          expect(cssLocators.length, `${el.name} should have a css locator`).toBeGreaterThan(0);
          for (const c of cssLocators) {
            expect(c.selector).not.toMatch(/#/); // never a generated id
          }
        }
      } finally {
        await surface.close();
      }
    });
  });

  // ---------------------------------------------------------------------------------------
  // Label/value cells + clickable rows
  // ---------------------------------------------------------------------------------------
  describe('label/value cells and onclick rows', () => {
    it('anchors a value cell on its label via a relative locator, and gives a clickable row a text locator', async () => {
      const surface = await openSurface('enum-cells.html');
      try {
        const obs = await surface.observe();

        const valueCell = obs.elements.find((e) => e.tag === 'td' && e.text === '$1,234.56');
        expect(valueCell, JSON.stringify(obs.elements, null, 2)).toBeDefined();
        expect(valueCell!.role).toBe('cell');
        const relLocators = locatorsOf(valueCell!, 'relative');
        expect(relLocators.length).toBeGreaterThan(0);
        expect(relLocators[0]!.anchor.text).toBe('Savings Balance');
        expect(relLocators[0]!.relation).toBe('right-of');
        expect(relLocators[0]!.tag).toBe('td');

        const row = obs.elements.find((e) => e.tag === 'tr' && e.role === 'clickable');
        expect(row, JSON.stringify(obs.elements, null, 2)).toBeDefined();
        const textLocators = locatorsOf(row!, 'text');
        expect(textLocators.length, JSON.stringify(row!.descriptor, null, 2)).toBeGreaterThan(0);
        expect(textLocators[0]!.text).toBe('12345');
        expect(textLocators[0]!.tag).toBeUndefined(); // resolver climbs from the matched <td> to the row

        // message cell and error list items are picked up as informative text.
        const msg = obs.elements.find((e) => e.text === 'No records found.');
        expect(msg).toBeDefined();
        const errorItems = obs.elements.filter((e) => e.tag === 'li');
        expect(errorItems.length).toBeGreaterThanOrEqual(2);

        expect(obs.textDigest).toContain('Savings Balance');
        expect(obs.textDigest).toContain('12345');
      } finally {
        await surface.close();
      }
    });
  });

  // ---------------------------------------------------------------------------------------
  // Nested-leaf anchor: a <tr><td><font>Label:</font></td></tr> row anchor whose leaf text
  // element (the <font>) is much narrower than the row/cell that contains it.
  // ---------------------------------------------------------------------------------------
  describe('nested-leaf anchor (leaf vs. container text)', () => {
    it("measures a 'below' anchor's geometry against the text-bearing leaf, not an enclosing td/tr that merely inherits it via innerText", async () => {
      const surface = await openSurface('enum-nested-leaf-anchor.html');
      try {
        const obs = await surface.observe();
        const ctrl = obs.elements.find((e) => e.tag === 'button');
        expect(ctrl, JSON.stringify(obs.elements, null, 2)).toBeDefined();

        // The control sits under the row's full width (a colspan=2 <td>) but well to the right of
        // the <font>Label:</font> leaf; only the wider enclosing <td>/<tr> x-overlap it. Anchor
        // candidates must be leaves (the same element resolve()'s findAnchor would bind to via
        // getByText), so synthesis must not manufacture a 'below' locator anchored on "Label:" --
        // one that can never resolve, since the leaf's x-band excludes the control.
        const relLocators = locatorsOf(ctrl!, 'relative');
        expect(relLocators.find((l) => l.anchor.text === 'Label:'), JSON.stringify(ctrl!.descriptor, null, 2)).toBeUndefined();
      } finally {
        await surface.close();
      }
    });
  });

  // ---------------------------------------------------------------------------------------
  // Frameset with nested frames
  // ---------------------------------------------------------------------------------------
  describe('frameset with a nested iframe', () => {
    it('reports correct FramePaths, frame list, digest and top-viewport bbox for a deeply nested element', async () => {
      const surface = await openSurface('enum-frameset.html');
      try {
        const obs = await surface.observe();

        const paths = obs.frames.map((f) => JSON.stringify(f.path));
        expect(paths).toContain(JSON.stringify([]));
        expect(paths).toContain(JSON.stringify([{ name: 'left' }]));
        expect(paths).toContain(JSON.stringify([{ name: 'main' }]));
        expect(paths).toContain(JSON.stringify([{ name: 'main' }, { name: 'inner' }]));
        for (const f of obs.frames) expect(f.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);

        const mainEl = obs.elements.find((e) => JSON.stringify(e.frame) === JSON.stringify([{ name: 'main' }]));
        expect(mainEl, JSON.stringify(obs.elements, null, 2)).toBeDefined();

        const innerEl = obs.elements.find((e) => JSON.stringify(e.frame) === JSON.stringify([{ name: 'main' }, { name: 'inner' }]));
        expect(innerEl, JSON.stringify(obs.elements, null, 2)).toBeDefined();
        expect(innerEl!.tag).toBe('button');
        expect(innerEl!.name).toBe('Inner Button');

        // Ground truth from Playwright itself: find the innermost frame named 'inner' and its button.
        const innerFrame = surface.page.frame({ name: 'inner' });
        expect(innerFrame).toBeTruthy();
        const innerHandle = await innerFrame!.$('#innerBtn');
        expect(innerHandle).toBeTruthy();
        const box = await innerHandle!.boundingBox();
        expect(box).toBeTruthy();
        expect(innerEl!.bbox.x).toBeCloseTo(box!.x, 0);
        expect(innerEl!.bbox.y).toBeCloseTo(box!.y, 0);
        expect(Math.abs(innerEl!.bbox.x - box!.x)).toBeLessThanOrEqual(2);
        expect(Math.abs(innerEl!.bbox.y - box!.y)).toBeLessThanOrEqual(2);
        expect(Math.abs(innerEl!.bbox.w - box!.width)).toBeLessThanOrEqual(2);
        expect(Math.abs(innerEl!.bbox.h - box!.height)).toBeLessThanOrEqual(2);
        await innerHandle!.dispose();

        // bbox locator normalized to the frame's own viewport (0..1).
        const bboxLocators = locatorsOf(innerEl!, 'bbox');
        expect(bboxLocators.length).toBeGreaterThan(0);
        for (const b of bboxLocators) {
          expect(b.x).toBeGreaterThanOrEqual(0);
          expect(b.x).toBeLessThanOrEqual(1);
          expect(b.y).toBeGreaterThanOrEqual(0);
          expect(b.y).toBeLessThanOrEqual(1);
          expect(b.w).toBeGreaterThan(0);
          expect(b.h).toBeGreaterThan(0);
        }

        expect(obs.textDigest).toContain('Left Nav');
        expect(obs.textDigest).toContain('Main Frame Heading');
        expect(obs.textDigest).toContain('Inner Button');
      } finally {
        await surface.close();
      }
    });
  });

  // ---------------------------------------------------------------------------------------
  // Cap
  // ---------------------------------------------------------------------------------------
  describe('element cap', () => {
    it('caps at maxElements (150 by default) with interactive elements prioritized', async () => {
      const surface = await openSurface('enum-cap.html');
      try {
        const obs = await surface.observe();
        expect(obs.elements.length).toBeLessThanOrEqual(150);
        expect(obs.elements.length).toBe(150);
        for (const el of obs.elements) expect(el.tag).toBe('button');
      } finally {
        await surface.close();
      }
    });
  });
});

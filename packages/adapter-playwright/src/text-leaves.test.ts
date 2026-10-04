/**
 * Text leaves through the adapter: descriptor synthesis for a generic leaf (a price <div> in a
 * product card), resolution of its container-anchored relative locator (including for another
 * card's anchor, the way a replay with another input binds it), the CSS candidate filter, the
 * three-tier cap and the omitted count. Fixtures are shared with @cu/browser-agent's tests.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LocatorStrategy, TargetDescriptor } from '@cu/core/schema';
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

function only(strategy: LocatorStrategy): TargetDescriptor {
  return { description: 'test target', frame: [], locators: [{ strategy, confidence: 0.5, source: 'inferred' }] };
}

const PRICE_BY_NAME = (name: string, exact?: true): LocatorStrategy => ({
  kind: 'relative',
  anchor: { text: name, ...(exact ? { exact } : {}) },
  relation: 'below',
  tag: 'div',
  selector: 'div.price',
  within: 'div.card',
});

async function readVia(surface: PlaywrightSurface, d: TargetDescriptor): Promise<string | undefined> {
  const r = await surface.readText(d, 2_000);
  return r.ok ? r.text : undefined;
}

describe('text leaves via PlaywrightSurface', () => {
  it("synthesizes a generic leaf's descriptor: unique text, then the container-anchored relative, then css and bbox", async () => {
    const surface = await openSurface('enum-leaves.html');
    try {
      const obs = await surface.observe();
      const price = obs.elements.find((e) => e.name === '$29.99')!;
      expect(price.role).toBe('generic');
      expect(price.tag).toBe('div');
      const kinds = price.descriptor.locators.map((l) => l.strategy.kind);
      expect(kinds[0]).toBe('text'); // no role locator: 'generic' is not a real role
      expect(price.descriptor.locators[1]!.strategy).toEqual(PRICE_BY_NAME('Canvas Backpack'));
      expect(kinds.slice(-2)).toEqual(['css', 'bbox']);
      // The descriptor finds this very element at strategy 0, and also through the anchor alone.
      const own = await surface.resolve(price.descriptor, 2_000);
      expect(own.found && own.strategyIndex).toBe(0);
      if (own.found) expect(await surface.isSameElement(price.ref, own.ref)).toBe(true);
      const viaAnchor = await surface.resolve(only(PRICE_BY_NAME('Canvas Backpack')), 2_000);
      expect(viaAnchor.found).toBe(true);
      if (viaAnchor.found) expect(await surface.isSameElement(price.ref, viaAnchor.ref)).toBe(true);
    } finally {
      await surface.close();
    }
  });

  it('keeps the legacy order for a control: its container anchor follows the above anchor', async () => {
    const surface = await openSurface('enum-leaves.html');
    try {
      const obs = await surface.observe();
      const button = obs.elements.find((e) => e.role === 'button' && e.name === 'Add to cart')!;
      const strategies = button.descriptor.locators.map((l) => l.strategy);
      expect(strategies[0]).toMatchObject({ kind: 'role', role: 'button', name: 'Add to cart' });
      const container = strategies.findIndex((s) => s.kind === 'relative' && s.anchor.text === 'Canvas Backpack' && s.selector === 'button.btn.add' && s.within === 'div.card');
      expect(container).toBeGreaterThan(0);
      const plainRelative = strategies.findIndex((s) => s.kind === 'relative' && s.selector === undefined);
      if (plainRelative !== -1) expect(plainRelative).toBeLessThan(container);
      // That anchor picks the first card's button out of three identical ones.
      const r = await surface.resolve(only(strategies[container]!), 2_000);
      expect(r.found).toBe(true);
      if (r.found) expect(await surface.isSameElement(button.ref, r.ref)).toBe(true);
    } finally {
      await surface.close();
    }
  });

  it("resolves another card's price through that card's name, and nothing for a name that is not there", async () => {
    const surface = await openSurface('enum-leaves.html');
    try {
      expect(await readVia(surface, only(PRICE_BY_NAME('Canvas Backpack')))).toBe('$29.99');
      expect(await readVia(surface, only(PRICE_BY_NAME('Fleece Jacket')))).toBe('$49.99');
      expect(await readVia(surface, only(PRICE_BY_NAME('Bike Light')))).toBe('$9.99');
      expect(await readVia(surface, only(PRICE_BY_NAME('Titanium Spork')))).toBeUndefined();
    } finally {
      await surface.close();
    }
  });

  it('needs the selector: without it the nearest <div> below the name is the description', async () => {
    const surface = await openSurface('enum-leaves.html');
    try {
      const tagOnly: LocatorStrategy = { kind: 'relative', anchor: { text: 'Canvas Backpack' }, relation: 'below', tag: 'div' };
      expect(await readVia(surface, only(tagOnly))).toBe('Water-resistant canvas pack.');
      // An invalid selector matches nothing: a miss, never an exception.
      const broken: LocatorStrategy = { kind: 'relative', anchor: { text: 'Canvas Backpack' }, relation: 'below', tag: 'div', selector: 'div[[' };
      const r = await surface.resolve(only(broken), 0);
      expect(r.found).toBe(false);
    } finally {
      await surface.close();
    }
  });

  it('an exact anchor never falls back to a containing text: "Bike" does not find "Bike Light"', async () => {
    const surface = await openSurface('enum-leaves.html');
    try {
      expect(await readVia(surface, only(PRICE_BY_NAME('Bike')))).toBe('$9.99'); // the old contains fallback
      expect(await readVia(surface, only(PRICE_BY_NAME('Bike', true)))).toBeUndefined();
      expect(await readVia(surface, only(PRICE_BY_NAME('bike light', true)))).toBeUndefined(); // case-sensitive
      expect(await readVia(surface, only(PRICE_BY_NAME('Bike Light', true)))).toBe('$9.99');
    } finally {
      await surface.close();
    }
  });

  it("bounds candidates to the anchor's own container: an anchor outside any card finds no price", async () => {
    const surface = await openSurface('enum-leaves.html');
    try {
      // The shop-name heading sits above every card: unbounded, "below" accepts any price under it.
      const unbounded: LocatorStrategy = { kind: 'relative', anchor: { text: 'Catalog', exact: true }, relation: 'below', tag: 'div', selector: 'div.price' };
      expect(await readVia(surface, only({ ...unbounded, within: 'div.card' }))).toBeUndefined();
      // A card's own name stays inside its card.
      expect(await readVia(surface, only(PRICE_BY_NAME('Fleece Jacket', true)))).toBe('$49.99');
      expect(await readVia(surface, only({ ...unbounded, within: 'div[[' }))).toBeUndefined(); // invalid: a miss
    } finally {
      await surface.close();
    }
  });

  it("counts only candidates whose nearest container is the anchor's own: a set's nested mug does not answer for the set", async () => {
    const surface = await openSurface('enum-leaves.html');
    try {
      expect(await readVia(surface, only(PRICE_BY_NAME('Gift Set', true)))).toBeUndefined();
      expect(await readVia(surface, only(PRICE_BY_NAME('Mini Mug', true)))).toBe('$3.00');
    } finally {
      await surface.close();
    }
  });

  it('misses when two candidates in the container fit the filter (a list price above the sale price)', async () => {
    const surface = await openSurface('enum-leaves.html');
    try {
      const r = await surface.resolve(only(PRICE_BY_NAME('Trail Tent', true)), 0);
      expect(r.found).toBe(false);
      if (!r.found) expect(r.tried[0]!.error).toMatch(/2 candidates in the anchor's container/);
      // The page still emits the anchor (it tells the recorder whose record the price is), so
      // record-time verification is what refuses it.
      const obs = await surface.observe();
      const sale = obs.elements.find((e) => e.name === '$80.00')!;
      expect(sale.descriptor.locators.some((l) => l.strategy.kind === 'relative' && l.strategy.anchor.text === 'Trail Tent' && l.strategy.within === 'div.card')).toBe(true);
    } finally {
      await surface.close();
    }
  });

  it('wholeWord: a contains match needs the text as a whole token ("Smith" never finds "Al Smithers")', async () => {
    const surface = await openSurface('enum-leaves.html');
    try {
      const anchored = (wholeWord: boolean, text = 'Smith'): LocatorStrategy => ({
        kind: 'relative',
        anchor: { text, exact: false, ...(wholeWord ? { wholeWord } : {}) },
        relation: 'right-of',
        tag: 'button',
        role: 'button',
        selector: 'td:nth-child(3) button',
      });
      expect((await surface.resolve(only(anchored(false)), 0)).found).toBe(true); // the plain contains fallback
      expect((await surface.resolve(only(anchored(true)), 0)).found).toBe(false);
      expect((await surface.resolve(only(anchored(true, 'Smithers')), 0)).found).toBe(true);
      expect(await readVia(surface, only({ kind: 'text', text: 'Smith', exact: false }))).toBe('Al Smithers');
      expect(await readVia(surface, only({ kind: 'text', text: 'Smith', exact: false, wholeWord: true }))).toBeUndefined();
    } finally {
      await surface.close();
    }
  });

  it("emits a row anchor only when the cell is a label: never the previous column's value", async () => {
    const surface = await openSurface('enum-leaves.html');
    try {
      const obs = await surface.observe();
      const view = obs.elements.find((e) => e.role === 'button' && e.name === 'View')!;
      expect(JSON.stringify(view.descriptor)).not.toContain('al.sm@example.test');
      // The recorder-only context is held by the surface, never part of the observation.
      expect(JSON.stringify(obs)).not.toContain('recordContext');
      const context = surface.recordContextOf(view.ref);
      expect(context?.rowCells.map((c) => c.text)).toEqual(['Al Smithers', 'al.sm@example.test']);
      expect(context?.tag).toBe('button');
      expect(context?.role).toBe('button');
      expect(surface.recordContextOf('r1')).toBeUndefined();
      const gold = obs.elements.find((e) => e.tag === 'td' && e.text === 'Gold')!;
      expect(gold.descriptor.locators.some((l) => l.strategy.kind === 'relative' && l.strategy.anchor.text === 'Plan' && l.strategy.relation === 'right-of')).toBe(true);
    } finally {
      await surface.close();
    }
  });

  it('caps with a share held for text, on-screen first, and reports how many it dropped', async () => {
    const surface = await openSurface('enum-leaves-cap.html');
    try {
      const obs = await surface.observe();
      expect(obs.elements).toHaveLength(150);
      expect(obs.elementsOmitted).toBe(204 - 150);
      expect(obs.elements[0]!.name).toBe('Continue');
      const names = obs.elements.map((e: ObservedElement) => e.name);
      expect(names).toContain('$42.00');
      expect(names).toContain('Payment declined');
    } finally {
      await surface.close();
    }
  });

  it.each([200, 600])('on a %i-card list, controls do not crowd out the prices of the cards on screen', async (n) => {
    const surface = await createPlaywrightSurface({ headless: true, viewport: { width: 1280, height: 800 } });
    try {
      const cards = Array.from({ length: n }, (_, i) =>
        `<div class="tile"><a href="#p${i}"><div class="tile-name">Item ${i} model</div></a><div class="tile-note">Notes for item ${i}.</div>` +
        `<div class="tile-foot"><div class="tile-cost">$${(i + 1).toFixed(2)}</div><button class="tile-add">Add</button></div></div>`,
      ).join('');
      await surface.page.setContent(`<style>.grid{display:grid;grid-template-columns:repeat(3,300px);gap:8px}.tile{display:flex;flex-direction:column;border:1px solid #ccc}.tile-foot{display:flex;justify-content:space-between}</style><div class="grid">${cards}</div>`);
      const obs = await surface.observe();
      expect(obs.elements).toHaveLength(150);
      expect(obs.elementsOmitted).toBe(4 * n - 150); // a link, a button, a note and a price per card
      const prices = obs.elements.filter((e) => e.name.startsWith('$')).map((e) => e.name);
      expect(prices.length).toBeGreaterThan(0);
      // The first row of cards is on screen: its prices are listed.
      for (const p of ['$1.00', '$2.00', '$3.00']) expect(prices).toContain(p);
      expect(obs.elements.filter((e) => e.role === 'generic').length).toBeGreaterThanOrEqual(50);
    } finally {
      await surface.close();
    }
  });

  it('reports no omitted count when nothing was dropped', async () => {
    const surface = await openSurface('enum-leaves.html');
    try {
      const obs = await surface.observe();
      expect(obs.elementsOmitted).toBeUndefined();
    } finally {
      await surface.close();
    }
  });

  it('a row anchor is looked up in its own column, case-sensitively; a label repeated on the page is ambiguous (a miss)', async () => {
    const surface = await createPlaywrightSurface({ headless: true });
    try {
      // A replay page where the recorded order 2001 is not listed, but a date holds "2001".
      await surface.page.setContent(
        '<table border="1"><tr><th>Order</th><th>Placed</th><th>Status</th></tr>' +
          '<tr><td>Order 3005</td><td>3 Feb 2001</td><td>Pending</td></tr>' +
          '<tr><td>Order a-1001</td><td>06/04/2019</td><td>Lowercase</td></tr>' +
          '<tr><td>Order A-1001-B</td><td>06/04/2019</td><td>Returned</td></tr></table>' +
          '<table><tr><td>Balance</td><td>$1.00</td></tr></table><table><tr><td>Balance</td><td>$2.00</td></tr></table>',
      );
      const status = (anchor: { text: string; exact?: boolean; wholeWord?: boolean; selector?: string }): LocatorStrategy => ({ kind: 'relative', anchor, relation: 'right-of', tag: 'td', selector: 'td:nth-child(3)' });
      // Without the column bound, the whole word "2001" anchors on the date: the wrong row's status.
      expect(await readVia(surface, only(status({ text: '2001', wholeWord: true })))).toBe('Pending');
      expect(await readVia(surface, only(status({ text: '2001', wholeWord: true, selector: 'td:nth-child(1)' })))).toBeUndefined();
      expect(await readVia(surface, only(status({ text: 'Order 2001', exact: true, selector: 'td:nth-child(1)' })))).toBeUndefined();
      // Case-sensitive: "A-1001" is not "a-1001"; exact: "Order A-1001" is not "Order A-1001-B".
      expect(await readVia(surface, only(status({ text: 'Order A-1001', exact: true, selector: 'td:nth-child(1)' })))).toBeUndefined();
      expect(await readVia(surface, only(status({ text: 'a-1001', wholeWord: true, selector: 'td:nth-child(1)' })))).toBe('Lowercase');
      // A joiner does not end a word: "A-1001" is not a whole word of "Order A-1001-B" (this was the named limit).
      expect(await readVia(surface, only(status({ text: 'A-1001', wholeWord: true, selector: 'td:nth-child(1)' })))).toBeUndefined();
      // A label anchor shown twice cannot tell which record is meant.
      const balance = await surface.resolve(only({ kind: 'relative', anchor: { text: 'Balance' }, relation: 'right-of', tag: 'td' }), 0);
      expect(balance.found).toBe(false);
      if (!balance.found) expect(JSON.stringify(balance.tried)).toContain('ambiguous anchor');
    } finally {
      await surface.close();
    }
  });
});

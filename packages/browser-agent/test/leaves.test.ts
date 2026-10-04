/**
 * The 'text' group (src/leaves.ts): which leaf text blocks enumerate() lists, what it leaves out,
 * how the cap prioritises them, and the container anchors that make a value in a card findable
 * again. Run in both integration modes, like enumerate.test.ts.
 */
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ElementData } from '../src/types.js';
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

const names = (data: ElementData[], group: ElementData['group']): string[] => data.filter((d) => d.group === group).map((d) => d.name);

describe.each(MODES)('text leaves [%s mode]', (mode: Mode) => {
  it('lists leaf text blocks of any tag, after every interactive and informative entry', async () => {
    const { context, page } = await openPage(browser, server, mode, 'enum-leaves.html');
    try {
      const { data } = await enumerateJson(page);
      const text = names(data, 'text');
      for (const expected of [
        '$29.99', // a price <div> in a card
        'Water-resistant canvas pack.',
        'Total: $88.97', // own text plus a legacy <b> child: the whole rendered text
        'Ships in two days.', // the class-less <em> is absorbed into the sentence
        'Balance $12.00',
        '$12.00', // a classed <span> is a value of its own
        'Wrapped text', // the <span>, not the wrapper <div> that only inherits it
        'Status', // <dt>
        'Shipped', // <dd>
        'Outdoor', // <li> outside ul.errors
        'Sep 30, 2026', // <time>
        'Saved your changes', // role=status
      ]) {
        expect(text, `${expected} should be a text leaf; got ${JSON.stringify(text)}`).toContain(expected);
      }
      // The legacy rules are untouched: the <b> and the headings stay informative.
      expect(names(data, 'informative')).toEqual(expect.arrayContaining(['Catalog', '$88.97', 'Inside heading']));
      // Group order: every interactive entry, then every informative one, then the text leaves.
      const groups = data.map((d) => d.group);
      const rank = { interactive: 0, informative: 1, text: 2 } as const;
      expect(groups.map((g) => rank[g])).toEqual([...groups.map((g) => rank[g])].sort((a, b) => a - b));
      for (const d of data.filter((x) => x.group === 'text')) expect(d.role).not.toBe('');
      expect(data.find((d) => d.name === '$29.99')!.role).toBe('generic');
    } finally {
      await context.close();
    }
  });

  it('leaves out control names, hidden or zero-size text, separators, labels of listed controls, long prose and non-text tags', async () => {
    const { context, page } = await openPage(browser, server, mode, 'enum-leaves.html');
    try {
      const { data, bodyText } = await enumerateJson(page);
      const text = names(data, 'text');
      for (const absent of [
        'Canvas Backpack', // the link's name: listed once, as the link
        'Add to cart', // the button's name
        'two', // absorbed inline formatting
        '|', // no letter or digit
        'Hidden text',
        'Zero size',
        'Inside heading', // inside a legacy heading
        'Quantity', // the input's <label>, i.e. its name
        'Account no.', // the adjacent cell that names the input beside it
        'Coupon code', // the aria-labelledby target of an input
        'No script text',
        'Script text',
        'Transparent text', // opacity: 0
        'Hidden from readers', // inside aria-hidden="true"
        'Off page text', // left: -9999px
        'Screen reader only', // a 1px clipped box
        'more', // class-less inline inside a long legacy <font>: part of its sentence
      ]) {
        expect(text, `${absent} must not be a text leaf`).not.toContain(absent);
      }
      expect(text.some((t) => t.startsWith('This paragraph is deliberately long'))).toBe(false);
      expect(bodyText).toContain('This paragraph is deliberately long prose'); // still readable as page text

      // No duplicates: no text leaf repeats an interactive element's name.
      const interactiveNames = new Set(names(data, 'interactive').filter(Boolean));
      for (const t of text) expect(interactiveNames.has(t), `text leaf "${t}" duplicates a control's name`).toBe(false);
      // And each listed element appears once.
      const keys = data.map((d) => `${d.group}|${d.cssSelector}|${d.name}|${d.rect.x}|${d.rect.y}`);
      expect(new Set(keys).size).toBe(keys.length);
    } finally {
      await context.close();
    }
  });

  it('prioritises messages and short values, then short leaves near a control', async () => {
    const { context, page } = await openPage(browser, server, mode, 'enum-leaves.html');
    try {
      const { data } = await enumerateJson(page);
      const p = (name: string): number => data.find((d) => d.group === 'text' && d.name === name)!.priority;
      expect(p('$29.99')).toBe(0);
      expect(p('Saved your changes')).toBe(0);
      expect(p('Sep 30, 2026')).toBe(0);
      expect(p('Water-resistant canvas pack.')).toBe(1); // in a card with a link and a button
      for (const d of data.filter((x) => x.group !== 'text')) expect(d.priority).toBe(0);
    } finally {
      await context.close();
    }
  });

  it('under a tight cap holds a share for text, prefers what is on screen, then priority, and keeps document order', async () => {
    const { context, page } = await openPage(browser, server, mode, 'enum-leaves-cap.html');
    try {
      const all = await enumerateJson(page);
      expect(all.data.filter((d) => d.group === 'text')).toHaveLength(203);
      const capped = await enumerateJson(page, { maxElements: 3 });
      expect(capped.data.map((d) => d.name)).toEqual(['Continue', '$42.00', 'Payment declined']);
      expect(capped.omitted).toBe(201);
      // The fourth slot goes to on-screen prose, not to the off-screen value at the very end.
      const four = await enumerateJson(page, { maxElements: 4 });
      expect(four.data.map((d) => d.name)).toEqual(['Continue', '$42.00', 'Payment declined', 'amber amber amber trail notes']);
      expect(four.data.every((d) => d.inViewport)).toBe(true);
      expect(all.data.find((d) => d.name === '$99.00')!.inViewport).toBe(false);
    } finally {
      await context.close();
    }
  });

  it('never lets controls crowd every text leaf out of the cap', async () => {
    const { context, page } = await openPage(browser, server, mode, 'enum-cap.html');
    try {
      // enum-cap.html is all buttons: with no text leaves, the cap is all controls, as before.
      const capped = await enumerateJson(page, { maxElements: 150 });
      expect(capped.data).toHaveLength(150);
      expect(capped.data.every((d) => d.group === 'interactive')).toBe(true);
    } finally {
      await context.close();
    }
  });

  it("anchors a card's price on the card's name, through a class filter, not on the description right above it", async () => {
    const { context, page } = await openPage(browser, server, mode, 'enum-leaves.html');
    try {
      const { data } = await enumerateJson(page);
      const price = data.find((d) => d.name === '$29.99')!;
      expect(price.containerAnchors[0]).toEqual({ text: 'Canvas Backpack', relation: 'below', selector: 'div.price', within: 'div.card' });
      expect(price.containerAnchors.length).toBeLessThanOrEqual(3);
      expect(data.find((d) => d.name === '$49.99')!.containerAnchors[0]).toEqual({ text: 'Fleece Jacket', relation: 'below', selector: 'div.price', within: 'div.card' });
      expect(price.textUnique).toBe(true);
      // The class selector is shared by every card's price, so the css candidate stays structural.
      expect(price.cssSelector).not.toBe('div.price');
      // A value with a unique class gets that class as its css selector.
      expect(data.find((d) => d.group === 'text' && d.name === '$12.00')!.cssSelector).toBe('span.amount');

      // The first "Add to cart" button: its container anchor is its card's name too (the price
      // beside it is record data, so it comes after the name).
      const button = data.find((d) => d.group === 'interactive' && d.name === 'Add to cart')!;
      expect(button.containerAnchors[0]).toEqual({ text: 'Canvas Backpack', relation: 'below', selector: 'button.btn.add', within: 'div.card' });
      const priceAnchor = button.containerAnchors.findIndex((a) => a.text === '$29.99');
      if (priceAnchor !== -1) expect(priceAnchor).toBeGreaterThan(0);
    } finally {
      await context.close();
    }
  });

  it('lists a marked-up value inside a legacy element whose name cannot show it all', async () => {
    const { context, page } = await openPage(browser, server, mode, 'enum-leaves.html');
    try {
      const { data } = await enumerateJson(page);
      expect(data.find((d) => d.group === 'informative' && d.name.startsWith('This long legacy sentence'))).toBeDefined();
      expect(names(data, 'text')).toContain('$7.25');
    } finally {
      await context.close();
    }
  });

  it("never builds a selector from a class slugged out of the element's own text, and bounds every anchor to a container", async () => {
    const { context, page } = await openPage(browser, server, mode, 'enum-leaves.html');
    try {
      const { data } = await enumerateJson(page);
      const status = data.find((d) => d.group === 'text' && d.name === 'In transit')!;
      expect(status.containerAnchors[0]).toEqual({ text: 'Ref ALPHA', relation: 'below', selector: 'span.state', within: 'div.order' });
      expect(JSON.stringify(status)).not.toContain('state-in-transit');
      for (const d of data) for (const a of d.containerAnchors) expect(a.within, `${d.name}: ${JSON.stringify(a)}`).not.toBe('');
    } finally {
      await context.close();
    }
  });

  it('never anchors on text the anchor lookup would find twice, even inside one clickable', async () => {
    const { context, page } = await openPage(browser, server, mode, 'enum-leaves.html');
    try {
      const { data } = await enumerateJson(page);
      const price = data.find((d) => d.group === 'text' && d.name === '$1.00')!;
      expect(price.containerAnchors.map((a) => a.text)).not.toContain('Twin');
    } finally {
      await context.close();
    }
  });

  it("reports a column's static text (three or more data cells, no digits) and whether a label repeats", async () => {
    const { context, page } = await openPage(browser, server, mode, 'enum-leaves.html');
    try {
      await page.evaluate(() => {
        const t = document.createElement('table');
        t.innerHTML =
          '<tr><th>Order</th><th>Placed</th><th>Status</th></tr>' +
          '<tr><td>Order 3005</td><td>07/04/2019</td><td>Open</td></tr>' +
          '<tr><td>Order 4000</td><td>08/04/2019</td><td>Closed</td></tr>' +
          '<tr><td>Order 2001</td><td>05/04/2019</td><td>Shipped</td></tr>';
        document.body.appendChild(t);
        // Two cards, each with a "Balance" label/value row.
        for (const v of ['$1.00', '$2.00']) {
          const k = document.createElement('table');
          k.innerHTML = `<tr><td>Balance</td><td>${v}</td></tr>`;
          document.body.appendChild(k);
        }
      });
      const { data } = await enumerateJson(page);
      const shipped = data.find((d) => d.tag === 'td' && d.text === 'Shipped')!;
      expect(shipped.recordContext.rowCells).toEqual([
        { text: 'Order 2001', relation: 'right-of', tag: 'td', index: 0, shared: { prefix: 'Order ', suffix: '' } },
        { text: '05/04/2019', relation: 'right-of', tag: 'td', index: 1 }, // the shared "/04/2019" holds digits: no static text
      ]);
      const balance = data.find((d) => d.tag === 'td' && d.text === '$1.00')!;
      expect(balance.rowAnchorIsLabel).toBe(true);
      expect(balance.recordContext.labelUnique).toBe(false);
    } finally {
      await context.close();
    }
  });

  it("tells a label cell from the previous column's value, and reports the row it sits in", async () => {
    const { context, page } = await openPage(browser, server, mode, 'enum-leaves.html');
    try {
      const { data } = await enumerateJson(page);
      const view = data.find((d) => d.tag === 'button' && d.name === 'View')!;
      expect(view.rowAnchorText).toBe('al.sm@example.test');
      expect(view.rowAnchorIsLabel).toBe(false); // a value, in a row of three data cells
      // Two data rows: too few for a column's shared text to count as static.
      expect(view.recordContext.rowCells).toEqual([
        { text: 'Al Smithers', relation: 'right-of', tag: 'td', index: 0 },
        { text: 'al.sm@example.test', relation: 'right-of', tag: 'td', index: 1 },
      ]);
      expect(view.recordContext.cell).toEqual({ tag: 'td', index: 2 });
      expect(view.recordContext.ownText).toBe('View');
      const gold = data.find((d) => d.tag === 'td' && d.text === 'Gold')!;
      expect(gold.rowAnchorIsLabel).toBe(true); // a two-cell label/value row
      expect(gold.recordContext.labelUnique).toBe(true); // "Plan" anchors once in the document
      const annual = data.find((d) => d.tag === 'td' && d.text === 'Annual')!;
      expect(annual.rowAnchorIsLabel).toBe(true); // "Renewal:" ends in a colon
      // The price in a card: its container text names its product (used by the recorder only).
      expect(data.find((d) => d.name === '$29.99')!.recordContext.containerText).toContain('Canvas Backpack');
    } finally {
      await context.close();
    }
  });

  it('gives a legacy label/value cell no container anchors: its row anchor already names it', async () => {
    const { context, page } = await openPage(browser, server, mode, 'enum-cells.html');
    try {
      const { data } = await enumerateJson(page);
      const cell = data.find((d) => d.tag === 'td' && d.text === '$1,234.56')!;
      expect(cell.rowAnchorText).toBe('Savings Balance');
      expect(cell.containerAnchors).toEqual([]);
      // Legacy entries still precede every text leaf.
      const firstText = data.findIndex((d) => d.group === 'text');
      if (firstText !== -1) expect(data.slice(firstText).every((d) => d.group === 'text')).toBe(true);
    } finally {
      await context.close();
    }
  });
});

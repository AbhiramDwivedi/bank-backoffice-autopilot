/**
 * End-to-end, on the demo shop: the rule that a target belonging to a record named by a run input
 * never keeps a positional locator, and that its input-bound chain is verified at record time.
 * Each case below returned or acted on ANOTHER record as `success` while positional fallbacks
 * were kept:
 *  1. a repeated control ("Add to cart" in every card) clicked the recorded card's button for any
 *     product, and for an unlisted product it clicked before failing;
 *  2. a status cell in a plain table, found right of "{input.orderId}", fell back to its row
 *     position and read another order's status;
 *  3. a row click whose input-bound text is a substring of another row's ("4512" in "45123")
 *     fell back to the recorded row;
 *  4. a card nested in the anchor's card (a gift set holding a mug) answered for a sold-out set;
 *  5. a struck-through list price above the sale price, both in the price class, returned the
 *     list price.
 * The shop records what was added to the cart and which rows were opened, so "nothing was
 * clicked" is checked on the server, not inferred.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { launchBrowser, policyFor, replayOnce, tempRunsDir, type MockServer } from './harness.js';
import { runDiscover, type RunDiscoverResult } from '@cu/cli/commands/discover';
import { createScriptedLlm, isPositional, requestText, type ScriptedTurn } from '@cu/core/agent';
import { findRef } from '@cu/core/agent/test-helpers';
import type { Capability, Locator, ReplayResult, Step } from '@cu/core/schema';
import { DEFAULT_POLICY_FILE } from '@cu/cli/runtime';
import { startStorefront, STORE_PASSWORD, STORE_PRODUCTS, STORE_TABLE_ORDERS, STORE_USER, type StoreProduct, type Storefront } from '../fixtures/storefront/server.js';

const byName = (name: string): StoreProduct => STORE_PRODUCTS.find((p) => p.name === name)!;

function signIn(): ScriptedTurn[] {
  return [
    (req) => ({ tool: 'type', input: { ref: findRef(requestText(req), { role: 'textbox', nameIncludes: 'Username' }), source: 'secret', value: 'SHOP_USER', why: 'Enter the username', expect: '' } }),
    (req) => ({ tool: 'type', input: { ref: findRef(requestText(req), { role: 'textbox', nameIncludes: 'Password' }), source: 'secret', value: 'SHOP_PASSWORD', why: 'Enter the password', expect: '' } }),
    (req) => ({ tool: 'click', input: { ref: findRef(requestText(req), { role: 'button', nameIncludes: 'Sign in' }), why: 'Sign in', expect: 'Add to cart' } }),
  ];
}

const cartScript = (): ScriptedTurn[] => [
  ...signIn(),
  // The first "Add to cart" in document order is Canvas Backpack's.
  (req) => ({ tool: 'click', input: { ref: findRef(requestText(req), { role: 'button', nameIncludes: 'Add to cart' }), why: 'Add the product to the cart', expect: '' } }),
  (req) => ({ tool: 'extract', input: { ref: findRef(requestText(req), { role: 'generic', nameIncludes: '$29.99' }), output: 'price', parse: 'currency', why: 'Read its price' } }),
  { tool: 'done', input: { success_text: 'Add to cart', summary: 'Added it and read its price.' } },
];

const tableScript = (): ScriptedTurn[] => [
  ...signIn(),
  (req) => ({ tool: 'click', input: { ref: findRef(requestText(req), { role: 'link', nameIncludes: 'Order table' }), why: 'Open the order table', expect: 'Status' } }),
  (req) => ({ tool: 'extract', input: { ref: findRef(requestText(req), { role: 'cell', nameIncludes: 'Shipped' }), output: 'status', parse: 'text', why: 'Read the order status' } }),
  { tool: 'done', input: { success_text: 'Order table', summary: 'Read the status.' } },
];

const rowsScript = (): ScriptedTurn[] => [
  ...signIn(),
  (req) => ({ tool: 'click', input: { ref: findRef(requestText(req), { role: 'link', nameIncludes: 'Rows' }), why: 'Open the rows', expect: 'Row for' } }),
  // nameIncludes 'Row for 4512' matches both rows; the first is 4512's.
  (req) => ({ tool: 'click', input: { ref: findRef(requestText(req), { role: 'clickable', nameIncludes: 'Row for 4512' }), why: 'Open the row', expect: 'details' } }),
  (req) => ({ tool: 'extract', input: { ref: findRef(requestText(req), { role: 'generic', nameIncludes: 'details' }), output: 'heading', parse: 'text', why: 'Read the heading' } }),
  { tool: 'done', input: { success_text: 'details', summary: 'Opened the row.' } },
];

const priceScript = (priceText: string): ScriptedTurn[] => [
  ...signIn(),
  (req) => ({ tool: 'extract', input: { ref: findRef(requestText(req), { role: 'generic', nameIncludes: priceText }), output: 'price', parse: 'currency', why: 'Read the product price' } }),
  { tool: 'done', input: { success_text: 'Add to cart', summary: 'Read the price.' } },
];

function asTarget(shop: Storefront): MockServer {
  return { tenant: 'a', baseUrl: shop.baseUrl, requests: shop.requests, setFaults: async () => undefined, reset: async () => undefined, close: () => shop.close() };
}

async function discoverOn(browser: Browser, shop: Storefront, id: string, input: string, output: string, script: ScriptedTurn[], autoOperator: 'none' | 'abort' = 'none'): Promise<{ outcome: RunDiscoverResult; progress: string[]; artifactPath: string }> {
  const runsDir = tempRunsDir('record-scope-discover-');
  const artifactPath = path.join(runsDir, `${id}.json`);
  const progress: string[] = [];
  const outcome = await runDiscover(
    {
      goal: `Do ${id} for ${input}.`,
      input: [input],
      sensitive: [],
      output: [output],
      secret: ['SHOP_USER', 'SHOP_PASSWORD'],
      id,
      out: artifactPath,
      entry: '/login',
      vendor: 'Demo vendor',
      product: 'Demo Shop',
      operatorPort: 0,
      autoOperator,
      policy: DEFAULT_POLICY_FILE,
      runsDir,
      headless: true,
      baseUrl: shop.baseUrl,
    },
    { llm: createScriptedLlm(script), browser, policy: policyFor(shop.baseUrl), print: (l) => progress.push(l) },
  );
  return { outcome, progress, artifactPath };
}

async function discovered(browser: Browser, shop: Storefront, id: string, input: string, output: string, script: ScriptedTurn[]): Promise<Capability> {
  const { outcome, progress, artifactPath } = await discoverOn(browser, shop, id, input, output, script);
  expect(outcome.exitCode, `discover did not succeed:\n${progress.join('\n')}`).toBe(0);
  return JSON.parse(readFileSync(artifactPath, 'utf8')) as Capability;
}

const locatorsOf = (step: Step | undefined): Locator[] => (step && 'target' in step.action ? step.action.target.locators : []);
const stepNamed = (cap: Capability, name: string): Step | undefined => cap.steps.find((s) => s.name === name);

const TABLE_WITHOUT_A = STORE_TABLE_ORDERS.filter((o) => o.id !== 'A-1001');
const GIFT_SET: StoreProduct = {
  id: 7,
  name: 'Gift Set',
  description: 'A boxed set with a mug inside.',
  price: null,
  inner: { id: 8, name: 'Mini Mug', description: 'A small enamel mug.', price: 3 },
};
const NESTED = [...STORE_PRODUCTS, GIFT_SET];
const TWO_PRICES = STORE_PRODUCTS.map((p) => (p.name === 'Fleece Jacket' ? { ...p, listPrice: 120, price: 80 } : p));
const TWO_PRICES_A = STORE_PRODUCTS.map((p) => (p.name === 'Canvas Backpack' ? { ...p, listPrice: 45, price: 29.99 } : p));

describe('record-scoped targets keep no positional locator (demo shop, scripted LLM, no network)', () => {
  let browser: Browser;
  const shops: Storefront[] = [];
  let standard: Storefront;
  let cartCap: Capability;
  let tableCap: Capability;
  let rowsCap: Capability;
  let priceCap: Capability;

  async function shop(opts?: Parameters<typeof startStorefront>[0]): Promise<Storefront> {
    const s = await startStorefront(opts);
    shops.push(s);
    return s;
  }
  async function replay(cap: Capability, on: Storefront, inputs: Record<string, string>): Promise<ReplayResult> {
    const run = await replayOnce({ browser, mock: asTarget(on), capability: cap, inputs, runsDir: tempRunsDir('record-scope-replay-'), autoOperator: 'abort', stepTimeoutMs: 3_000 });
    return run.result;
  }

  beforeAll(async () => {
    process.env.SHOP_USER = STORE_USER;
    process.env.SHOP_PASSWORD = STORE_PASSWORD;
    browser = await launchBrowser();
    standard = await shop();
    cartCap = await discovered(browser, standard, 'add-to-cart-and-price', 'productName=Canvas Backpack', 'price:number', cartScript());
    tableCap = await discovered(browser, standard, 'read-table-status', 'orderId=A-1001', 'status:string', tableScript());
    rowsCap = await discovered(browser, standard, 'open-row', 'id=4512', 'heading:string', rowsScript());
    priceCap = await discovered(browser, standard, 'read-price', 'productName=Canvas Backpack', 'price:number', priceScript('$29.99'));
  }, 240_000);

  afterAll(async () => {
    for (const s of shops) await s.close();
    await browser?.close();
  });

  describe('1. a control repeated in every card', () => {
    it('records the "Add to cart" click only through the card named by the input', () => {
      const click = stepNamed(cartCap, 'Add the product to the cart');
      expect(locatorsOf(click).map((l) => l.strategy)).toEqual([
        {
          kind: 'relative',
          anchor: { text: '{input.productName}', exact: true },
          relation: 'below',
          tag: 'button',
          role: 'button',
          selector: 'button.add-button',
          within: 'div.product-info',
        },
      ]);
    });

    it("replays for another product: that product's button is clicked and its price read", async () => {
      const s = await shop();
      const result = await replay(cartCap, s, { productName: 'Fleece Jacket' });
      expect(result.kind, JSON.stringify(result)).toBe('success');
      if (result.kind === 'success') expect(result.outputs.price).toBe(49.99);
      expect(s.cart).toEqual([byName('Fleece Jacket').id]);
    }, 60_000);

    it('replays for an unlisted product: a typed failure before anything is added to the cart', async () => {
      const s = await shop();
      const result = await replay(cartCap, s, { productName: 'Titanium Spork' });
      expect(result.kind, JSON.stringify(result)).toBe('hard_failure');
      if (result.kind === 'hard_failure') expect(result.code).toBe('element_not_found');
      expect(s.cart).toEqual([]);
    }, 60_000);
  });

  describe('2. a status cell in a plain table', () => {
    it('records the cell only right of the exact order id', () => {
      expect(locatorsOf(stepNamed(tableCap, 'Read the order status')).map((l) => l.strategy)).toEqual([
        { kind: 'relative', anchor: { text: '{input.orderId}', exact: true }, relation: 'right-of', tag: 'td' },
      ]);
    });

    it("replays for another order and returns that order's status", async () => {
      const result = await replay(tableCap, standard, { orderId: 'B-2002' });
      expect(result.kind, JSON.stringify(result)).toBe('success');
      if (result.kind === 'success') expect(result.outputs.status).toBe('Pending');
    }, 60_000);

    it('fails as a typed result for an order that is not listed, or a page without the recorded order', async () => {
      for (const [on, id] of [
        [standard, 'Z-9999'],
        [await shop({ tableOrders: TABLE_WITHOUT_A }), 'A-1001'],
      ] as const) {
        const result = await replay(tableCap, on, { orderId: id });
        expect(result.kind, `${id}: ${JSON.stringify(result)}`).toBe('hard_failure');
        if (result.kind === 'hard_failure') expect(result.code).toBe('element_not_found');
      }
    }, 120_000);
  });

  describe('3. a row whose id is a prefix of another row\'s', () => {
    it('records the row click as a whole-word match on the id ("4512" is not a word of "Row for 45123")', () => {
      const click = stepNamed(rowsCap, 'Open the row');
      expect(locatorsOf(click).map((l) => l.strategy)).toEqual([{ kind: 'text', text: '{input.id}', exact: false, wholeWord: true }]);
    });

    it.each(['4512', '45123'])('replays for %s and opens that row', async (id) => {
      const s = await shop();
      const result = await replay(rowsCap, s, { id });
      expect(result.kind, JSON.stringify(result)).toBe('success');
      if (result.kind === 'success') expect(result.outputs.heading).toBe(`Row ${id} details`);
      expect(s.rowVisits).toEqual([id]);
    }, 60_000);

    it('replays for an id with no row: a typed failure, no row opened', async () => {
      const s = await shop();
      const result = await replay(rowsCap, s, { id: '7777' });
      expect(['hard_failure', 'escalated'], JSON.stringify(result)).toContain(result.kind);
      expect(s.rowVisits).toEqual([]);
    }, 60_000);
  });

  describe('4. a card nested inside the anchor\'s card', () => {
    it("a sold-out set does not answer with the price of the mug inside it; the mug answers with its own", async () => {
      const nested = await shop({ products: NESTED });
      const set = await replay(priceCap, nested, { productName: 'Gift Set' });
      expect(set.kind, JSON.stringify(set)).toBe('hard_failure');
      const mug = await replay(priceCap, nested, { productName: 'Mini Mug' });
      expect(mug.kind, JSON.stringify(mug)).toBe('success');
      if (mug.kind === 'success') expect(mug.outputs.price).toBe(3);
    }, 120_000);
  });

  describe('5. two prices in one card', () => {
    it('replay misses rather than returning the struck-through list price', async () => {
      const result = await replay(priceCap, await shop({ products: TWO_PRICES }), { productName: 'Fleece Jacket' });
      expect(result.kind, JSON.stringify(result)).toBe('hard_failure');
      expect(JSON.stringify(result)).not.toContain('120');
    }, 60_000);

    it('discovery refuses to record a price it cannot tell from a list price in the same card', async () => {
      const { outcome } = await discoverOn(browser, await shop({ products: TWO_PRICES_A }), 'read-price-two', 'productName=Canvas Backpack', 'price:number', [
        ...signIn(),
        (req) => ({ tool: 'extract', input: { ref: findRef(requestText(req), { role: 'generic', nameIncludes: '$29.99' }), output: 'price', parse: 'currency', why: 'Read the product price' } }),
        { tool: 'stuck', input: { reason: 'no reusable locator for the price' } },
      ], 'abort');
      expect(outcome.exitCode).not.toBe(0);
      expect(outcome.result?.outputs?.price).toBeUndefined();
    }, 60_000);
  });

  it('no record-scoped target in any of these capabilities holds a positional locator', () => {
    for (const cap of [cartCap, tableCap, rowsCap, priceCap]) {
      for (const step of cap.steps) {
        const locs = locatorsOf(step);
        if (!JSON.stringify(locs).includes('{input.')) continue;
        expect(locs.filter(isPositional), `${cap.id} ${step.id} ${step.name}`).toEqual([]);
      }
    }
  });
});

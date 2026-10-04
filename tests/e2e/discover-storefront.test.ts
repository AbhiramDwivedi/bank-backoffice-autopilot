/**
 * End-to-end: discovery and replay on markup that is not the mock app's. The target is a
 * div-and-flexbox shop (tests/fixtures/storefront/server.ts) served on an ephemeral port: a
 * placeholder-labelled sign-in form, a grid of product cards (title in a <div> inside a link, a
 * summary <div>, a price <div>, a button), an orders page, no tables, no frames.
 *
 * Two capabilities are discovered with a scripted model: the price of one product, and the status
 * of one order. Each must hold no recorded value and find its value only through the run input,
 * so that a replay for another record returns THAT record's value -- and a replay for a record
 * that is not there, or is there without the value, fails as a typed result rather than returning
 * a neighbour's value. The table of adversarial catalogues below is exactly the set of inputs
 * that returned another record's value as `success` before anchors were exact and
 * container-bounded.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { launchBrowser, policyFor, readRunText, replayOnce, tempRunsDir, type MockServer } from './harness.js';
import { runDiscover } from '@cu/cli/commands/discover';
import { createScriptedLlm, requestText, type ScriptedTurn } from '@cu/core/agent';
import { findRef } from '@cu/core/agent/test-helpers';
import { validateCapability, type Capability, type Locator, type ReplayResult } from '@cu/core/schema';
import { DEFAULT_POLICY_FILE } from '@cu/cli/runtime';
import {
  startStorefront,
  STORE_NAME,
  STORE_ORDERS,
  STORE_PASSWORD,
  STORE_PRODUCTS,
  STORE_USER,
  type StoreProduct,
  type Storefront,
} from '../fixtures/storefront/server.js';

const byName = (name: string): StoreProduct => STORE_PRODUCTS.find((p) => p.name === name)!;
const PRODUCT_A = byName('Canvas Backpack');

function signIn(): ScriptedTurn[] {
  return [
    (req) => ({
      tool: 'type',
      input: { ref: findRef(requestText(req), { role: 'textbox', nameIncludes: 'Username' }), source: 'secret', value: 'SHOP_USER', why: 'Enter the username', expect: '' },
    }),
    (req) => ({
      tool: 'type',
      input: { ref: findRef(requestText(req), { role: 'textbox', nameIncludes: 'Password' }), source: 'secret', value: 'SHOP_PASSWORD', why: 'Enter the password', expect: '' },
    }),
    (req) => ({ tool: 'click', input: { ref: findRef(requestText(req), { role: 'button', nameIncludes: 'Sign in' }), why: 'Sign in', expect: 'Add to cart' } }),
  ];
}

function priceScript(priceText: string): ScriptedTurn[] {
  return [
    ...signIn(),
    // A plain <div> in a card: before leaf text blocks were enumerated there was no ref for it.
    (req) => ({
      tool: 'extract',
      input: { ref: findRef(requestText(req), { role: 'generic', nameIncludes: priceText }), output: 'price', parse: 'currency', why: 'Read the product price' },
    }),
    { tool: 'done', input: { success_text: 'Add to cart', summary: 'Read the price of the product.' } },
  ];
}

function statusScript(): ScriptedTurn[] {
  return [
    ...signIn(),
    (req) => ({ tool: 'click', input: { ref: findRef(requestText(req), { role: 'link', nameIncludes: 'Your orders' }), why: 'Open the orders', expect: 'Placed on' } }),
    // The first "In transit" in document order is ALPHA's.
    (req) => ({
      tool: 'extract',
      input: { ref: findRef(requestText(req), { role: 'generic', nameIncludes: 'In transit' }), output: 'status', parse: 'text', why: 'Read the order status' },
    }),
    { tool: 'done', input: { success_text: 'Placed on', summary: 'Read the status of the order.' } },
  ];
}

/** The shop in the shape the shared replay harness expects of a target app. */
function asTarget(shop: Storefront): MockServer {
  return { tenant: 'a', baseUrl: shop.baseUrl, requests: shop.requests, setFaults: async () => undefined, reset: async () => undefined, close: () => shop.close() };
}

function extractLocators(cap: Capability): Locator[] {
  const step = cap.steps.find((s) => s.action.type === 'extract');
  if (!step || step.action.type !== 'extract') throw new Error('no extract step in the capability');
  return step.action.target.locators;
}

/** Variant catalogues: each is a shop where the input names no listed, priced product. */
function withProducts(products: StoreProduct[]): StoreProduct[] {
  return products.map((p, i) => ({ ...p, id: i + 1 }));
}
const LANTERN: StoreProduct = { id: 0, name: 'Lantern Kit', description: 'A folding lantern with a spare wick.', price: null };
const VARIANTS = {
  standard: STORE_PRODUCTS.slice(),
  plusPro: withProducts([...STORE_PRODUCTS, { id: 0, name: 'Canvas Backpack Pro', description: 'The larger pack.', price: 89.99 }]),
  onlyPro: withProducts(STORE_PRODUCTS.map((p) => (p.name === 'Canvas Backpack' ? { ...p, name: 'Canvas Backpack Pro', price: 89.99 } : p))),
  miniBike: withProducts(STORE_PRODUCTS.map((p) => (p.name === 'Bike Light' ? { ...p, name: 'Mini Bike Light', price: 4.99 } : p))),
  soldOutFirst: withProducts([LANTERN, ...STORE_PRODUCTS]),
  soldOutMiddle: withProducts([...STORE_PRODUCTS.slice(0, 2), LANTERN, ...STORE_PRODUCTS.slice(2)]),
  soldOutLast: withProducts([...STORE_PRODUCTS, LANTERN]),
} satisfies Record<string, StoreProduct[]>;
type Variant = keyof typeof VARIANTS;

async function discoverWith(browser: Browser, shop: Storefront, id: string, input: string, output: string, script: ScriptedTurn[]): Promise<{ capability: Capability; outputs: Record<string, unknown> }> {
  const runsDir = tempRunsDir('storefront-discover-');
  const artifactPath = path.join(runsDir, `${id}.json`);
  const progress: string[] = [];
  const outcome = await runDiscover(
    {
      goal: `Sign in and read ${output} for ${input}.`,
      input: [input],
      sensitive: [],
      output: [`${output}:${output === 'price' ? 'number' : 'string'}`],
      secret: ['SHOP_USER', 'SHOP_PASSWORD'],
      id,
      out: artifactPath,
      entry: '/login',
      vendor: 'Demo vendor',
      product: 'Demo Shop',
      operatorPort: 0,
      autoOperator: 'none',
      policy: DEFAULT_POLICY_FILE, // unused: deps.policy wins
      runsDir,
      headless: true,
      baseUrl: shop.baseUrl,
    },
    { llm: createScriptedLlm(script), browser, policy: policyFor(shop.baseUrl), print: (l) => progress.push(l) },
  );
  expect(outcome.exitCode, `discover did not succeed:\n${progress.join('\n')}`).toBe(0);
  expect(readRunText(outcome.runDir)).not.toContain(STORE_PASSWORD);
  return { capability: JSON.parse(readFileSync(artifactPath, 'utf8')) as Capability, outputs: outcome.result?.outputs ?? {} };
}

describe('discover + replay on a div-and-flexbox shop (scripted LLM, no network)', () => {
  let browser: Browser;
  const shops = new Map<Variant, Storefront>();
  let priceCap: Capability;
  let statusCap: Capability;

  async function replay(cap: Capability, variant: Variant, inputs: Record<string, string>): Promise<ReplayResult> {
    const shop = shops.get(variant)!;
    const run = await replayOnce({ browser, mock: asTarget(shop), capability: cap, inputs, runsDir: tempRunsDir('storefront-replay-'), autoOperator: 'abort', stepTimeoutMs: 3_000 });
    return run.result;
  }

  beforeAll(async () => {
    process.env.SHOP_USER = STORE_USER;
    process.env.SHOP_PASSWORD = STORE_PASSWORD;
    browser = await launchBrowser();
    for (const [variant, products] of Object.entries(VARIANTS)) shops.set(variant as Variant, await startStorefront({ products }));
    const standard = shops.get('standard')!;
    const price = await discoverWith(browser, standard, 'read-product-price', `productName=${PRODUCT_A.name}`, 'price', priceScript(`$${PRODUCT_A.price!.toFixed(2)}`));
    expect(price.outputs.price).toBe(PRODUCT_A.price);
    priceCap = price.capability;
    const status = await discoverWith(browser, standard, 'read-order-status', 'orderRef=ALPHA', 'status', statusScript());
    expect(status.outputs.status).toBe('In transit');
    statusCap = status.capability;
  }, 180_000);

  afterAll(async () => {
    for (const shop of shops.values()) await shop.close();
    await browser?.close();
  });

  it('writes a price capability that finds the price only through an exact, container-bounded anchor on the product name', () => {
    const validated = validateCapability(priceCap);
    expect(validated.ok, JSON.stringify(!validated.ok && validated.issues)).toBe(true);
    const text = JSON.stringify(priceCap);
    expect(text).not.toContain(PRODUCT_A.price!.toFixed(2));
    expect(text).not.toContain(STORE_PASSWORD);
    expect(text).not.toContain(PRODUCT_A.name); // canonicalized to {input.productName}
    expect(extractLocators(priceCap).map((l) => l.strategy)).toEqual([
      { kind: 'relative', anchor: { text: '{input.productName}', exact: true }, relation: 'below', tag: 'div', selector: 'div.product-cost', within: 'div.product-info' },
    ]);
  });

  it.each([
    ['Fleece Jacket', 'standard', 49.99],
    ['Canvas Backpack', 'standard', 29.99],
    ['Camp Mug {12 oz} (2-pack) [v2] *', 'standard', 18.5], // CSS, regex and template characters
    ['Canvas Backpack', 'plusPro', 29.99], // the exact name wins over a longer one
    ['Canvas Backpack Pro', 'plusPro', 89.99],
  ] as const)('replays for %s (%s catalogue) and returns that product\'s price', async (name, variant, expected) => {
    const result = await replay(priceCap, variant, { productName: name });
    expect(result.kind, JSON.stringify(result)).toBe('success');
    if (result.kind === 'success') expect(result.outputs.price).toBe(expected);
  }, 60_000);

  it.each([
    ['Bike', 'standard', 'a prefix of a listed product'],
    ['Backpack Pro', 'plusPro', 'a suffix of a listed product'],
    ['Canvas Backpack', 'onlyPro', 'only a longer name is listed'],
    ['Bike Light', 'miniBike', 'only a longer name is listed'],
    ['Trail Lamp', 'standard', 'appears only inside another product\'s summary'],
    [STORE_NAME, 'standard', 'the shop name: an exact match outside any card'],
    ['Lantern Kit', 'soldOutFirst', 'listed, sold out, first card'],
    ['Lantern Kit', 'soldOutMiddle', 'listed, sold out, in the middle'],
    ['Lantern Kit', 'soldOutLast', 'listed, sold out, last card'],
    ['Titanium Spork', 'standard', 'not listed at all'],
  ] as const)('fails as a typed result, never with a price, for "%s" (%s: %s)', async (name, variant, _why) => {
    // Each of these returned another product's price as success before anchors were exact and
    // bounded to their card.
    const result = await replay(priceCap, variant, { productName: name });
    expect(result.kind, JSON.stringify(result)).toBe('hard_failure');
    if (result.kind === 'hard_failure') {
      expect(result.code).toBe('element_not_found');
      expect(result.stepName).toBe('Read the product price');
    }
    expect(JSON.stringify(result)).not.toMatch(/"price"/);
  }, 60_000);

  it('writes a status capability whose selector does not encode the recorded status', () => {
    expect(validateCapability(statusCap).ok).toBe(true);
    const text = JSON.stringify(statusCap);
    expect(text.toLowerCase()).not.toContain('transit');
    expect(extractLocators(statusCap).map((l) => l.strategy)).toEqual([
      { kind: 'relative', anchor: { text: '{input.orderRef}', exact: true }, relation: 'below', tag: 'span', selector: 'span.state', within: 'div.order-card' },
    ]);
  });

  it.each(STORE_ORDERS.map((o) => [o.ref, o.status] as const))('replays the status for order %s: %s', async (ref, status) => {
    const result = await replay(statusCap, 'standard', { orderRef: ref });
    expect(result.kind, JSON.stringify(result)).toBe('success');
    if (result.kind === 'success') expect(result.outputs.status).toBe(status);
  }, 60_000);

  it('fails as a typed result for an order that is not listed', async () => {
    const result = await replay(statusCap, 'standard', { orderRef: 'DELTA' });
    expect(result.kind, JSON.stringify(result)).toBe('hard_failure');
    if (result.kind === 'hard_failure') expect(result.code).toBe('element_not_found');
  }, 60_000);
});

/**
 * End-to-end, on the demo shop: a role locator bound to a run input is exact or it is not recorded.
 *
 * Here every "Add to cart" button carries an accessible name holding its product ("Add Fleece
 * Jacket to cart"). The recorder used to narrow that name to the input and keep it as a role
 * locator, which is a substring match: recorded for "Fleece Jacket", a replay for "Bolt" found
 * the one button whose name contains "Bolt", clicked "Add Bolt T-Shirt to cart" and finished as a
 * success, with another product in the cart. Now no role locator is recorded for such a name; the
 * button is found through its card's exact anchor on the product name, and "Bolt" fails typed.
 * The shop records every add, so "nothing was added" is checked on the server.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { launchBrowser, policyFor, replayOnce, tempRunsDir, type MockServer } from './harness.js';
import { runDiscover } from '@cu/cli/commands/discover';
import { createScriptedLlm, requestText, type ScriptedTurn } from '@cu/core/agent';
import { findRef } from '@cu/core/agent/test-helpers';
import type { Capability, Locator, ReplayResult, Step } from '@cu/core/schema';
import { DEFAULT_POLICY_FILE } from '@cu/cli/runtime';
import { startStorefront, STORE_PASSWORD, STORE_PRODUCTS, STORE_USER, type StoreProduct, type Storefront } from '../fixtures/storefront/server.js';

const BOLT_TEE: StoreProduct = { id: 7, name: 'Bolt T-Shirt', description: 'Grey tee with a red bolt.', price: 15.99 };
/** The standard catalogue plus "Bolt T-Shirt". No product is named "Bolt". */
const PRODUCTS: readonly StoreProduct[] = [...STORE_PRODUCTS, BOLT_TEE];
const JACKET = STORE_PRODUCTS.find((p) => p.name === 'Fleece Jacket')!;

const script = (): ScriptedTurn[] => [
  (req) => ({ tool: 'type', input: { ref: findRef(requestText(req), { role: 'textbox', nameIncludes: 'Username' }), source: 'secret', value: 'SHOP_USER', why: 'Enter the username', expect: '' } }),
  (req) => ({ tool: 'type', input: { ref: findRef(requestText(req), { role: 'textbox', nameIncludes: 'Password' }), source: 'secret', value: 'SHOP_PASSWORD', why: 'Enter the password', expect: '' } }),
  (req) => ({ tool: 'click', input: { ref: findRef(requestText(req), { role: 'button', nameIncludes: 'Sign in' }), why: 'Sign in', expect: 'Add to cart' } }),
  (req) => ({ tool: 'click', input: { ref: findRef(requestText(req), { role: 'button', nameIncludes: `Add ${JACKET.name} to cart` }), why: 'Add the product to the cart', expect: '' } }),
  (req) => ({ tool: 'extract', input: { ref: findRef(requestText(req), { role: 'generic', nameIncludes: '$49.99' }), output: 'price', parse: 'currency', why: 'Read its price' } }),
  { tool: 'done', input: { success_text: 'Add to cart', summary: 'Added it and read its price.' } },
];

function asTarget(shop: Storefront): MockServer {
  return { tenant: 'a', baseUrl: shop.baseUrl, requests: shop.requests, setFaults: async () => undefined, reset: async () => undefined, close: () => shop.close() };
}

const locatorsOf = (step: Step | undefined): Locator[] => (step && 'target' in step.action ? step.action.target.locators : []);

describe('a role name holding the input among other text is not recorded as a substring match (demo shop, scripted LLM, no network)', () => {
  let browser: Browser;
  const shops: Storefront[] = [];
  let cap: Capability;

  async function shop(): Promise<Storefront> {
    const s = await startStorefront({ products: PRODUCTS, namedAddButtons: true });
    shops.push(s);
    return s;
  }
  async function replay(on: Storefront, productName: string): Promise<ReplayResult> {
    const run = await replayOnce({ browser, mock: asTarget(on), capability: cap, inputs: { productName }, runsDir: tempRunsDir('record-role-replay-'), autoOperator: 'abort', stepTimeoutMs: 3_000 });
    return run.result;
  }

  beforeAll(async () => {
    process.env.SHOP_USER = STORE_USER;
    process.env.SHOP_PASSWORD = STORE_PASSWORD;
    browser = await launchBrowser();
    const s = await shop();
    const runsDir = tempRunsDir('record-role-discover-');
    const artifactPath = path.join(runsDir, 'add-named.json');
    const progress: string[] = [];
    const outcome = await runDiscover(
      {
        goal: `Add ${JACKET.name} to the cart and read its price.`,
        input: [`productName=${JACKET.name}`],
        sensitive: [],
        output: ['price:number'],
        secret: ['SHOP_USER', 'SHOP_PASSWORD'],
        id: 'add-named',
        out: artifactPath,
        entry: '/login',
        vendor: 'Demo vendor',
        product: 'Demo Shop',
        operatorPort: 0,
        autoOperator: 'none',
        policy: DEFAULT_POLICY_FILE,
        runsDir,
        headless: true,
        baseUrl: s.baseUrl,
      },
      { llm: createScriptedLlm(script()), browser, policy: policyFor(s.baseUrl), print: (l) => progress.push(l) },
    );
    expect(outcome.exitCode, `discover did not succeed:\n${progress.join('\n')}`).toBe(0);
    expect(s.cart).toEqual([JACKET.id]);
    cap = JSON.parse(readFileSync(artifactPath, 'utf8')) as Capability;
  }, 120_000);

  afterAll(async () => {
    for (const s of shops) await s.close();
    await browser?.close();
  });

  it('records the named button through its card only: no role locator, and none of the name\'s other words', () => {
    const click = cap.steps.find((s) => s.name === 'Add the product to the cart');
    expect(locatorsOf(click).map((l) => l.strategy)).toEqual([
      { kind: 'relative', anchor: { text: '{input.productName}', exact: true }, relation: 'below', tag: 'button', role: 'button', selector: 'button.add-button', within: 'div.product-info' },
    ]);
    expect(JSON.stringify(cap.steps)).not.toContain(JACKET.name);
  });

  it('replays for "Bolt" where only "Bolt T-Shirt" is listed: a typed failure, nothing added to the cart', async () => {
    const s = await shop();
    const result = await replay(s, 'Bolt');
    expect(result.kind, JSON.stringify(result)).toBe('hard_failure');
    if (result.kind === 'hard_failure') {
      expect(result.code).toBe('element_not_found');
      expect(result.stepName).toBe('Add the product to the cart');
    }
    expect(s.cart).toEqual([]);
  }, 60_000);

  it.each([
    [BOLT_TEE.name, BOLT_TEE.id, 15.99],
    [JACKET.name, JACKET.id, 49.99],
  ] as const)('replays for %s: that product is added, at depth zero', async (productName, id, price) => {
    const s = await shop();
    const result = await replay(s, productName);
    expect(result.kind, JSON.stringify(result)).toBe('success');
    if (result.kind === 'success') expect(result.outputs.price).toBe(price);
    expect(s.cart).toEqual([id]);
    expect(result.locatorReport.filter((e) => e.fallbackDepth > 0)).toEqual([]);
  }, 60_000);
});

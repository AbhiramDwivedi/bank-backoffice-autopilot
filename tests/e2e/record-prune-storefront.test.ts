/**
 * End-to-end, on the demo shop: a recorded locator chain holds only locators that found the element
 * on their own at record time, so a fresh recording replays at depth zero and "locator drift" means
 * the app changed.
 *
 * Each product card has two links named after the product: the image link (its image's alt text)
 * and the title link (its text). A role locator on that name matches both, so it never resolves.
 * While it was kept at the head of the title link's chain, every replay fell through to the text
 * locator behind it and reported drift on a capability recorded a minute earlier.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { launchBrowser, policyFor, replayOnce, tempRunsDir, type MockServer } from './harness.js';
import { runDiscover } from '@cu/cli/commands/discover';
import { createScriptedLlm, requestText, type ScriptedTurn } from '@cu/core/agent';
import { findRef } from '@cu/core/agent/test-helpers';
import { summarizeLocatorDrift } from '@cu/core/replay';
import type { Capability, Locator, ReplayResult, Step } from '@cu/core/schema';
import { DEFAULT_POLICY_FILE } from '@cu/cli/runtime';
import { startStorefront, STORE_PASSWORD, STORE_USER, type Storefront } from '../fixtures/storefront/server.js';

const PRODUCT = 'Canvas Backpack';

const script = (): ScriptedTurn[] => [
  (req) => ({ tool: 'type', input: { ref: findRef(requestText(req), { role: 'textbox', nameIncludes: 'Username' }), source: 'secret', value: 'SHOP_USER', why: 'Enter the username', expect: '' } }),
  (req) => ({ tool: 'type', input: { ref: findRef(requestText(req), { role: 'textbox', nameIncludes: 'Password' }), source: 'secret', value: 'SHOP_PASSWORD', why: 'Enter the password', expect: '' } }),
  (req) => ({ tool: 'click', input: { ref: findRef(requestText(req), { role: 'button', nameIncludes: 'Sign in' }), why: 'Sign in', expect: 'Add to cart' } }),
  // The title link. The image link is listed without a name: the page's own naming takes none from
  // an image's alt text, while the role lookup at replay does, which is how the two come to share one.
  (req) => ({ tool: 'click', input: { ref: findRef(requestText(req), { role: 'link', nameIncludes: PRODUCT }), why: 'Open the product page', expect: '' } }),
  (req) => ({ tool: 'extract', input: { ref: findRef(requestText(req), { role: 'generic', nameIncludes: '$29.99' }), output: 'price', parse: 'currency', why: 'Read the product price' } }),
  { tool: 'done', input: { success_text: 'Add to cart', summary: 'Opened the product page and read its price.' } },
];

function asTarget(shop: Storefront): MockServer {
  return { tenant: 'a', baseUrl: shop.baseUrl, requests: shop.requests, setFaults: async () => undefined, reset: async () => undefined, close: () => shop.close() };
}

const locatorsOf = (step: Step | undefined): Locator[] => (step && 'target' in step.action ? step.action.target.locators : []);

describe('a recorded chain holds only locators that found the element alone (demo shop, scripted LLM, no network)', () => {
  let browser: Browser;
  let shop: Storefront;
  let cap: Capability;

  async function replay(productName: string): Promise<ReplayResult> {
    const run = await replayOnce({ browser, mock: asTarget(shop), capability: cap, inputs: { productName }, runsDir: tempRunsDir('record-prune-replay-'), autoOperator: 'abort', stepTimeoutMs: 3_000 });
    return run.result;
  }

  beforeAll(async () => {
    process.env.SHOP_USER = STORE_USER;
    process.env.SHOP_PASSWORD = STORE_PASSWORD;
    browser = await launchBrowser();
    shop = await startStorefront();
    const runsDir = tempRunsDir('record-prune-discover-');
    const artifactPath = path.join(runsDir, 'open-product.json');
    const progress: string[] = [];
    const outcome = await runDiscover(
      {
        goal: `Open the product page of ${PRODUCT} and read its price.`,
        input: [`productName=${PRODUCT}`],
        sensitive: [],
        output: ['price:number'],
        secret: ['SHOP_USER', 'SHOP_PASSWORD'],
        id: 'open-product',
        out: artifactPath,
        entry: '/login',
        vendor: 'Demo vendor',
        product: 'Demo Shop',
        operatorPort: 0,
        autoOperator: 'none',
        policy: DEFAULT_POLICY_FILE,
        runsDir,
        headless: true,
        baseUrl: shop.baseUrl,
      },
      { llm: createScriptedLlm(script()), browser, policy: policyFor(shop.baseUrl), print: (l) => progress.push(l) },
    );
    expect(outcome.exitCode, `discover did not succeed:\n${progress.join('\n')}`).toBe(0);
    cap = JSON.parse(readFileSync(artifactPath, 'utf8')) as Capability;
  }, 120_000);

  afterAll(async () => {
    await shop?.close();
    await browser?.close();
  });

  it('records the title link without the role locator it shares with the image link', () => {
    const click = cap.steps.find((s) => s.name === 'Open the product page');
    expect(locatorsOf(click).map((l) => l.strategy)).toEqual([{ kind: 'text', text: '{input.productName}', exact: true, tag: 'a' }]);
    expect(click?.onFailure).toBeUndefined();
  });

  it.each([
    [PRODUCT, 29.99],
    ['Fleece Jacket', 49.99],
  ] as const)('replays for %s with every target found by its first locator: no drift on a fresh recording', async (productName, price) => {
    const result = await replay(productName);
    expect(result.kind, JSON.stringify(result)).toBe('success');
    if (result.kind === 'success') expect(result.outputs.price).toBe(price);
    expect(result.locatorReport.length).toBeGreaterThan(0);
    expect(result.locatorReport.filter((e) => e.fallbackDepth > 0)).toEqual([]);
    expect(summarizeLocatorDrift(result.locatorReport).drifted).toBe(0);
  }, 60_000);

  it('replays for a product that is not listed: a typed failure at the link, nothing opened', async () => {
    const before = shop.requests.length;
    const result = await replay('Titanium Spork');
    expect(result.kind, JSON.stringify(result)).toBe('hard_failure');
    if (result.kind === 'hard_failure') {
      expect(result.code).toBe('element_not_found');
      expect(result.stepName).toBe('Open the product page');
    }
    expect(shop.requests.slice(before).filter((r) => /^\/products\/\d+$/.test(r.path))).toEqual([]);
  }, 60_000);
});

/**
 * End-to-end, on the demo shop: record membership decided from content, and row anchors only
 * from cells that read as labels.
 *
 * The run input is consumed by a search; the element acted on sits in a result row whose
 * locators never mention it. Before: a people search recorded with "Smithers" kept the View
 * button's anchor on the e-mail cell beside it, so a replay for "Smith" (Jane Smith, Al Smithers)
 * opened Al Smithers; a replay for "Jones" (five rows) clicked the first row by its bbox; an order
 * search recorded with A-10010 read the status right of "Jane Roe" and returned A-10010's status
 * for A-1001; two identical rows were recorded as a css position. All also persisted another
 * person's name or e-mail. Now the target is record-scoped from its row's content, keeps only
 * locators bound to the input (anchored on the input-holding cell, looked up in that cell's column,
 * acting in its own column), and a search that lists no row, or several whose cells hold the input
 * as a word, fails or escalates without clicking anything -- checked on the server, which records
 * every person and row opened. "Smith" opens Jane Smith: the one name holding "Smith" as a word.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { launchBrowser, policyFor, replayOnce, tempRunsDir, type MockServer } from './harness.js';
import { runDiscover } from '@cu/cli/commands/discover';
import { createScriptedLlm, isPositional, requestText, type ScriptedTurn } from '@cu/core/agent';
import { findRef } from '@cu/core/agent/test-helpers';
import type { Capability, Locator, ReplayResult, Step } from '@cu/core/schema';
import { DEFAULT_POLICY_FILE } from '@cu/cli/runtime';
import { startStorefront, STORE_PASSWORD, STORE_PEOPLE, STORE_USER, type Storefront, type StorefrontOptions } from '../fixtures/storefront/server.js';

const person = (name: string) => STORE_PEOPLE.find((p) => p.name === name)!;

function signIn(): ScriptedTurn[] {
  return [
    (req) => ({ tool: 'type', input: { ref: findRef(requestText(req), { role: 'textbox', nameIncludes: 'Username' }), source: 'secret', value: 'SHOP_USER', why: 'Enter the username', expect: '' } }),
    (req) => ({ tool: 'type', input: { ref: findRef(requestText(req), { role: 'textbox', nameIncludes: 'Password' }), source: 'secret', value: 'SHOP_PASSWORD', why: 'Enter the password', expect: '' } }),
    (req) => ({ tool: 'click', input: { ref: findRef(requestText(req), { role: 'button', nameIncludes: 'Sign in' }), why: 'Sign in', expect: 'Add to cart' } }),
  ];
}

const peopleScript = (): ScriptedTurn[] => [
  ...signIn(),
  (req) => ({ tool: 'click', input: { ref: findRef(requestText(req), { role: 'link', nameIncludes: 'People' }), why: 'Open the people search', expect: '' } }),
  (req) => ({ tool: 'type', input: { ref: findRef(requestText(req), { role: 'textbox', nameIncludes: 'Name' }), source: 'input', value: 'q', why: 'Enter the name', expect: '' } }),
  (req) => ({ tool: 'click', input: { ref: findRef(requestText(req), { role: 'button', nameIncludes: 'Search' }), why: 'Search for the person', expect: 'View' } }),
  (req) => ({ tool: 'click', input: { ref: findRef(requestText(req), { role: 'button', nameIncludes: 'View' }), why: 'Open the person', expect: 'Contact' } }),
  (req) => ({ tool: 'extract', input: { ref: findRef(requestText(req), { role: 'generic', nameIncludes: '@' }), output: 'email', parse: 'text', why: 'Read the e-mail' } }),
  { tool: 'done', input: { success_text: 'Contact', summary: 'Read the e-mail.' } },
];

const orderSearchScript = (): ScriptedTurn[] => [
  ...signIn(),
  (req) => ({ tool: 'click', input: { ref: findRef(requestText(req), { role: 'link', nameIncludes: 'Order search' }), why: 'Open the order search', expect: '' } }),
  (req) => ({ tool: 'type', input: { ref: findRef(requestText(req), { role: 'textbox', nameIncludes: 'Order id' }), source: 'input', value: 'q', why: 'Enter the order id', expect: '' } }),
  (req) => ({ tool: 'click', input: { ref: findRef(requestText(req), { role: 'button', nameIncludes: 'Find' }), why: 'Find the order', expect: 'Customer' } }),
  (req) => ({ tool: 'extract', input: { ref: findRef(requestText(req), { role: 'cell', nameIncludes: 'Shipped' }), output: 'status', parse: 'text', why: 'Read the order status' } }),
  { tool: 'done', input: { success_text: 'Customer', summary: 'Read the status.' } },
];

const duplicateRowsScript = (): ScriptedTurn[] => [
  ...signIn(),
  (req) => ({ tool: 'click', input: { ref: findRef(requestText(req), { role: 'link', nameIncludes: 'Rows' }), why: 'Open the rows', expect: 'Row for' } }),
  (req) => ({ tool: 'click', input: { ref: findRef(requestText(req), { role: 'clickable', nameIncludes: 'Row for 4512' }), why: 'Open the row', expect: 'details' } }),
  (req) => ({ tool: 'extract', input: { ref: findRef(requestText(req), { role: 'generic', nameIncludes: 'details' }), output: 'heading', parse: 'text', why: 'Read the heading' } }),
  { tool: 'done', input: { success_text: 'details', summary: 'Opened the row.' } },
];

function asTarget(shop: Storefront): MockServer {
  return { tenant: 'a', baseUrl: shop.baseUrl, requests: shop.requests, setFaults: async () => undefined, reset: async () => undefined, close: () => shop.close() };
}

async function discovered(browser: Browser, shop: Storefront, id: string, input: string, output: string, script: ScriptedTurn[]): Promise<Capability> {
  const runsDir = tempRunsDir('membership-discover-');
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
      autoOperator: 'none',
      policy: DEFAULT_POLICY_FILE,
      runsDir,
      headless: true,
      baseUrl: shop.baseUrl,
    },
    { llm: createScriptedLlm(script), browser, policy: policyFor(shop.baseUrl), print: (l) => progress.push(l) },
  );
  expect(outcome.exitCode, `discover did not succeed:\n${progress.join('\n')}`).toBe(0);
  return JSON.parse(readFileSync(artifactPath, 'utf8')) as Capability;
}

const stepNamed = (cap: Capability, name: string): Step => {
  const s = cap.steps.find((x) => x.name === name);
  if (!s) throw new Error(`no step "${name}" in ${cap.steps.map((x) => x.name).join(', ')}`);
  return s;
};
const locatorsOf = (s: Step): Locator[] => ('target' in s.action ? s.action.target.locators : []);

describe('record membership from content (demo shop, scripted LLM, no network)', () => {
  let browser: Browser;
  const shops: Storefront[] = [];
  async function shop(opts?: StorefrontOptions): Promise<Storefront> {
    const s = await startStorefront(opts);
    shops.push(s);
    return s;
  }
  async function replay(cap: Capability, on: Storefront, inputs: Record<string, string>): Promise<ReplayResult> {
    return (await replayOnce({ browser, mock: asTarget(on), capability: cap, inputs, runsDir: tempRunsDir('membership-replay-'), autoOperator: 'abort', stepTimeoutMs: 3_000 })).result;
  }

  beforeAll(async () => {
    process.env.SHOP_USER = STORE_USER;
    process.env.SHOP_PASSWORD = STORE_PASSWORD;
    browser = await launchBrowser();
  });

  afterAll(async () => {
    for (const s of shops) await s.close();
    await browser?.close();
  });

  describe.each(['get', 'post'] as const)('people search (%s)', (variant) => {
    let cap: Capability;
    beforeAll(async () => {
      cap = await discovered(browser, await shop({ peopleSearch: variant }), `open-person-${variant}`, 'q=Smithers', 'email:string', peopleScript());
    }, 120_000);

    it("records the View click only through the searched name's cell, in its own column, with no one's data", () => {
      const locs = locatorsOf(stepNamed(cap, 'Open the person'));
      expect(locs.map((l) => l.strategy)).toEqual([
        { kind: 'relative', anchor: { text: '{input.q}', exact: false, wholeWord: true, selector: 'td:nth-child(1)' }, relation: 'right-of', tag: 'button', role: 'button', selector: 'td:nth-child(3) button' },
      ]);
      const text = JSON.stringify(cap.steps);
      for (const data of ['al.sm@', 'Smithers', 'Jane Smith']) expect(text).not.toContain(data);
    });

    it('replays for a name listing one other person: that person is opened', async () => {
      const s = await shop({ peopleSearch: variant });
      const result = await replay(cap, s, { q: 'Lee' });
      expect(result.kind, JSON.stringify(result)).toBe('success');
      if (result.kind === 'success') expect(result.outputs.email).toBe(person('Bo Lee').email);
      expect(s.peopleViews).toEqual([person('Bo Lee').id]);
    }, 60_000);

    it('replays for "Smith" (Jane Smith, Al Smithers listed): the one whose name holds "Smith" as a word, in the name column', async () => {
      const s = await shop({ peopleSearch: variant });
      const result = await replay(cap, s, { q: 'Smith' });
      expect(result.kind, JSON.stringify(result)).toBe('success');
      expect(s.peopleViews).toEqual([person('Jane Smith').id]);
    }, 60_000);

    it.each(['Jones', 'Nobody'])('replays for "%s" (several rows, or none): fails or escalates, opens no one', async (q) => {
      const s = await shop({ peopleSearch: variant });
      const result = await replay(cap, s, { q });
      expect(['hard_failure', 'escalated'], JSON.stringify(result)).toContain(result.kind);
      expect(s.peopleViews).toEqual([]);
    }, 60_000);
  });

  describe('order search', () => {
    let cap: Capability;
    let s: Storefront;
    beforeAll(async () => {
      s = await shop();
      cap = await discovered(browser, s, 'search-order-status', 'q=A-10010', 'status:string', orderSearchScript());
    }, 120_000);

    it("records the status only through the order id's cell, in the status column, with no customer's name", () => {
      expect(locatorsOf(stepNamed(cap, 'Read the order status')).map((l) => l.strategy)).toEqual([
        { kind: 'relative', anchor: { text: '{input.q}', exact: true, selector: 'td:nth-child(1)' }, relation: 'right-of', tag: 'td', selector: 'td:nth-child(3)' },
      ]);
      expect(JSON.stringify(cap)).not.toContain('Jane Roe');
    });

    it.each([
      ['A-1001', 'Pending'], // the search also lists A-10010
      ['B-2002', 'Cancelled'],
    ])('replays for %s and returns %s', async (q, status) => {
      const result = await replay(cap, s, { q });
      expect(result.kind, JSON.stringify(result)).toBe('success');
      if (result.kind === 'success') expect(result.outputs.status).toBe(status);
    }, 60_000);

    it('fails as a typed result for an order the search does not list', async () => {
      const result = await replay(cap, s, { q: 'Z-9' });
      expect(result.kind, JSON.stringify(result)).toBe('hard_failure');
    }, 60_000);
  });

  describe('two identical rows', () => {
    it('records no position: the click escalates at replay instead of opening a row', async () => {
      const dup = await shop({ rowIds: ['4512', '4512'] });
      const cap = await discovered(browser, dup, 'open-duplicate-row', 'id=4512', 'heading:string', duplicateRowsScript());
      const click = stepNamed(cap, 'Open the row');
      expect(locatorsOf(click).filter(isPositional)).toEqual([]);
      expect(click.onFailure).toBe('escalate');
      const s = await shop({ rowIds: ['4512', '4512'] });
      const result = await replay(cap, s, { id: '4512' });
      expect(['escalated', 'hard_failure'], JSON.stringify(result)).toContain(result.kind);
      expect(s.rowVisits).toEqual([]);
    }, 120_000);
  });
});

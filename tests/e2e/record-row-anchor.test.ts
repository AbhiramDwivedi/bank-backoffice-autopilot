/**
 * End-to-end on the demo shop: the row anchor of a record-scoped target whose input sits inside a
 * longer cell ("Order 2001"). Before, the anchor was `{input.orderNo}` as a whole word anywhere on
 * the page, so a replay for 2001 on a list without it read the status of the row whose DATE holds
 * 2001 ("Order 3005 | 03/02/2001"), and "A-1001" anchored on "Order A-1001-B" and on "Order a-1001".
 * Now:
 *  - when every cell of the column shares static text ("Order "), the anchor is that text with the
 *    placeholder, exact: `Order {input.orderNo}`;
 *  - the anchor is looked up in the input cell's own column only;
 *  - a whole-word anchor is case-sensitive.
 *  - a cell that is the input alone is recorded `exact`: a replay that lists only "A-1001-B" (or
 *    only "Lee Wong") fails typed, with no whole-word fallback;
 *  - a cell recorded as a word match ("Ann Lee") resolves an exact cell first, then a whole word,
 *    and a hyphen does not end a word ("Lee-Wong" is not "Lee").
 * What remains, pinned here so the docs cannot drift from it: an input recorded as a word of a
 * longer cell ("Lee" in "Ann Lee") still anchors on another record that holds it as a word
 * ("Lee Wong") when no cell is exactly "Lee" and only that one is listed.
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
import { startStorefront, STORE_PASSWORD, STORE_USER, type ListedOrder, type StorefrontOptions, type StorePerson, type Storefront } from '../fixtures/storefront/server.js';

function signIn(): ScriptedTurn[] {
  return [
    (req) => ({ tool: 'type', input: { ref: findRef(requestText(req), { role: 'textbox', nameIncludes: 'Username' }), source: 'secret', value: 'SHOP_USER', why: 'Enter the username', expect: '' } }),
    (req) => ({ tool: 'type', input: { ref: findRef(requestText(req), { role: 'textbox', nameIncludes: 'Password' }), source: 'secret', value: 'SHOP_PASSWORD', why: 'Enter the password', expect: '' } }),
    (req) => ({ tool: 'click', input: { ref: findRef(requestText(req), { role: 'button', nameIncludes: 'Sign in' }), why: 'Sign in', expect: 'Add to cart' } }),
  ];
}

const orderListScript = (status: string): ScriptedTurn[] => [
  ...signIn(),
  (req) => ({ tool: 'click', input: { ref: findRef(requestText(req), { role: 'link', nameIncludes: 'Order list' }), why: 'Open the order list', expect: 'Placed' } }),
  (req) => ({ tool: 'extract', input: { ref: findRef(requestText(req), { role: 'cell', nameIncludes: status }), output: 'status', parse: 'text', why: 'Read the order status' } }),
  { tool: 'done', input: { success_text: 'Placed', summary: 'Read the status.' } },
];

const peopleScript = (): ScriptedTurn[] => [
  ...signIn(),
  (req) => ({ tool: 'click', input: { ref: findRef(requestText(req), { role: 'link', nameIncludes: 'People' }), why: 'Open the people search', expect: '' } }),
  (req) => ({ tool: 'type', input: { ref: findRef(requestText(req), { role: 'textbox', nameIncludes: 'Name' }), source: 'input', value: 'q', why: 'Enter the name', expect: '' } }),
  (req) => ({ tool: 'click', input: { ref: findRef(requestText(req), { role: 'button', nameIncludes: 'Search' }), why: 'Search for the person', expect: 'View' } }),
  (req) => ({ tool: 'click', input: { ref: findRef(requestText(req), { role: 'button', nameIncludes: 'View' }), why: 'Open the person', expect: 'Contact' } }),
  (req) => ({ tool: 'extract', input: { ref: findRef(requestText(req), { role: 'generic', nameIncludes: '@' }), output: 'email', parse: 'text', why: 'Read the e-mail' } }),
  { tool: 'done', input: { success_text: 'Contact', summary: 'Read the e-mail.' } },
];

const list = (...rows: [string, string, string][]): ListedOrder[] => rows.map(([order, placed, status]) => ({ order, placed, status }));
const stepNamed = (cap: Capability, name: string): Step => {
  const s = cap.steps.find((x) => x.name === name);
  if (!s) throw new Error(`no step "${name}" in ${cap.steps.map((x) => x.name).join(', ')}`);
  return s;
};
const locatorsOf = (s: Step): Locator[] => ('target' in s.action ? s.action.target.locators : []);
function asTarget(shop: Storefront): MockServer {
  return { tenant: 'a', baseUrl: shop.baseUrl, requests: shop.requests, setFaults: async () => undefined, reset: async () => undefined, close: () => shop.close() };
}

describe('row anchors inside a longer cell (demo shop, scripted LLM, no network)', () => {
  let browser: Browser;
  const shops: Storefront[] = [];
  async function shop(opts?: StorefrontOptions): Promise<Storefront> {
    const s = await startStorefront(opts);
    shops.push(s);
    return s;
  }
  async function discovered(opts: StorefrontOptions, id: string, input: string, output: string, script: ScriptedTurn[]): Promise<Capability> {
    const on = await shop(opts);
    const runsDir = tempRunsDir('row-anchor-discover-');
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
        autoOperator: 'abort',
        policy: DEFAULT_POLICY_FILE,
        runsDir,
        headless: true,
        baseUrl: on.baseUrl,
      },
      { llm: createScriptedLlm(script), browser, policy: policyFor(on.baseUrl), print: (l) => progress.push(l) },
    );
    expect(outcome.exitCode, `discover did not succeed:\n${progress.join('\n')}`).toBe(0);
    return JSON.parse(readFileSync(artifactPath, 'utf8')) as Capability;
  }
  async function replay(cap: Capability, opts: StorefrontOptions, inputs: Record<string, string>): Promise<{ result: ReplayResult; on: Storefront }> {
    const on = await shop(opts);
    const { result } = await replayOnce({ browser, mock: asTarget(on), capability: cap, inputs, runsDir: tempRunsDir('row-anchor-replay-'), autoOperator: 'abort', stepTimeoutMs: 3_000 });
    return { result, on };
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

  it('order 2001: anchored on "Order {input.orderNo}" in the order column; a list where only a date holds 2001 fails typed', async () => {
    const recorded = list(['Order 3005', '07/04/2019', 'Open'], ['Order 4000', '08/04/2019', 'Closed'], ['Order 2001', '05/04/2019', 'Shipped']);
    const cap = await discovered({ orderList: recorded }, 'order-2001', 'orderNo=2001', 'status:string', orderListScript('Shipped'));
    expect(locatorsOf(stepNamed(cap, 'Read the order status')).map((l) => l.strategy)).toEqual([
      { kind: 'relative', anchor: { text: 'Order {input.orderNo}', exact: true, selector: 'td:nth-child(1)' }, relation: 'right-of', tag: 'td', selector: 'td:nth-child(3)' },
    ]);
    const dateOnly = await replay(cap, { orderList: list(['Order 3005', '03/02/2001', 'Pending'], ['Order 4000', '07/04/2019', 'Open']) }, { orderNo: '2001' });
    expect(dateOnly.result.kind, JSON.stringify(dateOnly.result)).toBe('hard_failure');
    if (dateOnly.result.kind === 'hard_failure') expect(dateOnly.result.code).toBe('element_not_found');
    const both = await replay(cap, { orderList: list(['Order 3005', '03/02/2001', 'Pending'], ['Order 2001', '05/04/2019', 'Shipped']) }, { orderNo: '2001' });
    expect(both.result.kind).toBe('success');
    if (both.result.kind === 'success') expect(both.result.outputs.status).toBe('Shipped');
  }, 180_000);

  it('order A-1001: "Order A-1001-B" and "Order a-1001" fail typed; the listed order is read for another number', async () => {
    const cap = await discovered({}, 'order-a1001', 'orderNo=A-1001', 'status:string', orderListScript('Held'));
    expect(locatorsOf(stepNamed(cap, 'Read the order status'))[0]!.strategy).toMatchObject({ anchor: { text: 'Order {input.orderNo}', exact: true, selector: 'td:nth-child(1)' } });
    for (const rows of [list(['Order A-1001-B', '06/04/2019', 'Returned'], ['Order 3005', '07/04/2019', 'Open']), list(['Order a-1001', '06/04/2019', 'Lowercase'], ['Order 3005', '07/04/2019', 'Open'])]) {
      const r = await replay(cap, { orderList: rows }, { orderNo: 'A-1001' });
      expect(r.result.kind, JSON.stringify(r.result)).toBe('hard_failure');
    }
    const other = await replay(cap, {}, { orderNo: '4000' });
    expect(other.result.kind).toBe('success');
    if (other.result.kind === 'success') expect(other.result.outputs.status).toBe('Closed');
  }, 180_000);

  it('a cell that is the input alone is recorded exact: only "A-1001-B" or only "Lee Wong" listed fails typed', async () => {
    const cellOnly = async (id: string, q: string, name: string): Promise<Capability> => {
      const cap = await discovered(
        { people: [{ id: 1, name, email: 'x.y@example.test' }, { id: 2, name: 'Bo Kim', email: 'bo.k@example.test' }] },
        id,
        `q=${q}`,
        'email:string',
        peopleScript(),
      );
      expect(locatorsOf(stepNamed(cap, 'Open the person'))[0]!.strategy).toMatchObject({ anchor: { text: '{input.q}', exact: true, selector: 'td:nth-child(1)' } });
      return cap;
    };
    for (const [id, input, other] of [['open-person-a1001', 'A-1001', 'A-1001-B'], ['open-person-lee-alone', 'Lee', 'Lee Wong']] as const) {
      const cap = await cellOnly(id, input, input);
      const only = await replay(cap, { people: [{ id: 11, name: other, email: 'o.t@example.test' }, { id: 2, name: 'Bo Kim', email: 'bo.k@example.test' }] }, { q: input });
      expect(['hard_failure', 'escalated'], JSON.stringify(only.result)).toContain(only.result.kind);
      expect(only.on.peopleViews).toEqual([]);
      const both = await replay(cap, { people: [{ id: 11, name: other, email: 'o.t@example.test' }, { id: 12, name: input, email: 'me@example.test' }] }, { q: input });
      expect(both.result.kind, JSON.stringify(both.result)).toBe('success');
      expect(both.on.peopleViews).toEqual([12]);
    }
  }, 240_000);

  it('a word-recorded anchor takes an exact cell first, and a hyphen does not end a word', async () => {
    const cap = await discovered(
      { people: [{ id: 1, name: 'Ann Lee', email: 'ann.l@example.test' }, { id: 2, name: 'Bo Kim', email: 'bo.k@example.test' }] },
      'open-person-lee-word',
      'q=Lee',
      'email:string',
      peopleScript(),
    );
    const exactFirst = await replay(cap, { people: [{ id: 11, name: 'Lee Wong', email: 'lee.w@example.test' }, { id: 12, name: 'Lee', email: 'lee@example.test' }] }, { q: 'Lee' });
    expect(exactFirst.result.kind, JSON.stringify(exactFirst.result)).toBe('success');
    expect(exactFirst.on.peopleViews).toEqual([12]);
    const hyphen = await replay(cap, { people: [{ id: 11, name: 'Lee-Wong', email: 'lee.w@example.test' }, { id: 2, name: 'Bo Kim', email: 'bo.k@example.test' }] }, { q: 'Lee' });
    expect(['hard_failure', 'escalated'], JSON.stringify(hyphen.result)).toContain(hyphen.result.kind);
    expect(hyphen.on.peopleViews).toEqual([]);
  }, 180_000);

  it('the named limit, pinned: "Lee" recorded inside "Ann Lee" still opens "Lee Wong" when only he is listed; "lee" (another case) opens no one', async () => {
    const recorded: StorePerson[] = [
      { id: 1, name: 'Ann Lee', email: 'ann.l@example.test' },
      { id: 2, name: 'Bo Kim', email: 'bo.k@example.test' },
    ];
    const cap = await discovered({ people: recorded }, 'open-person-lee', 'q=Lee', 'email:string', peopleScript());
    expect(locatorsOf(stepNamed(cap, 'Open the person')).map((l) => l.strategy)).toEqual([
      { kind: 'relative', anchor: { text: '{input.q}', exact: false, wholeWord: true, selector: 'td:nth-child(1)' }, relation: 'right-of', tag: 'button', role: 'button', selector: 'td:nth-child(3) button' },
    ]);
    const replayed: StorePerson[] = [
      { id: 11, name: 'Lee Wong', email: 'lee.w@example.test' },
      { id: 2, name: 'Bo Kim', email: 'bo.k@example.test' },
    ];
    const lee = await replay(cap, { people: replayed }, { q: 'Lee' });
    expect(lee.result.kind, JSON.stringify(lee.result)).toBe('success'); // the limit: another person's record
    expect(lee.on.peopleViews).toEqual([11]);
    const lower = await replay(cap, { people: replayed }, { q: 'lee' });
    expect(['hard_failure', 'escalated'], JSON.stringify(lower.result)).toContain(lower.result.kind);
    expect(lower.on.peopleViews).toEqual([]);
  }, 180_000);
});

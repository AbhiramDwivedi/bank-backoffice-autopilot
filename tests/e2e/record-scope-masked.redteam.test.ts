/**
 * Red team, end to end on the demo shop: the record rule under screen masking.
 *
 * Content membership reads an element's real row and container text (`Surface.recordContextOf`),
 * because it compares that text with the run's own input. That text must never leave: the policy
 * here masks the people search's Name and E-mail columns, the contact card's e-mail and the order
 * search's Customer column. So:
 *  - a masked anchor candidate (the customer's name beside an order's status, the e-mail beside a
 *    person's View button) is in no prompt, no locator of the recorded capability, no
 *    transcript.jsonl and no events.jsonl;
 *  - the masked row data the recorder decided membership from is in none of those either, nor in
 *    a replay's run directory, including the escalation a replay for an ambiguous name raises;
 *  - the run's own (non-sensitive) input echoed inside a MASKED cell ("Smithers" in the masked Name
 *    column) still anchors the click: the anchor is the input placeholder, bound and resolved on
 *    the real page, and a replay for another name opens that person -- checked on the server.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { launchBrowser, policyFor, readRunText, replayOnce, tempRunsDir, type MockServer } from './harness.js';
import { runDiscover } from '@cu/cli/commands/discover';
import { createScriptedLlm, requestText, type ScriptedTurn } from '@cu/core/agent';
import { findRef } from '@cu/core/agent/test-helpers';
import { resolveScreenMask, type Capability, type Locator, type Policy, type Step } from '@cu/core/schema';
import { DEFAULT_POLICY_FILE } from '@cu/cli/runtime';
import { startStorefront, STORE_PASSWORD, STORE_PEOPLE, STORE_USER, type Storefront } from '../fixtures/storefront/server.js';

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
  // The contact card's e-mail is masked too: the model extracts it by its placeholder.
  (req) => ({ tool: 'extract', input: { ref: findRef(requestText(req), { role: 'generic', nameIncludes: '[MASKED' }), output: 'email', parse: 'text', why: 'Read the e-mail' } }),
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

/** The default policy for the shop, plus the people search's Name column, the order search's
 *  Customer column and the contact card's e-mail (the E-mail column is masked by default). */
function maskingPolicy(baseUrl: string): Policy {
  const base = policyFor(baseUrl);
  const screen = resolveScreenMask(base.redaction.screen);
  return {
    ...base,
    redaction: { ...base.redaction, screen: { ...screen, maskLabels: [...screen.maskLabels, 'name', 'customer'], maskSelectors: [...screen.maskSelectors, '.contact-email'] } },
  };
}

function asTarget(shop: Storefront): MockServer {
  return { tenant: 'a', baseUrl: shop.baseUrl, requests: shop.requests, setFaults: async () => undefined, reset: async () => undefined, close: () => shop.close() };
}

const stepNamed = (cap: Capability, name: string): Step => {
  const s = cap.steps.find((x) => x.name === name);
  if (!s) throw new Error(`no step "${name}" in ${cap.steps.map((x) => x.name).join(', ')}`);
  return s;
};
const locatorsOf = (s: Step): Locator[] => ('target' in s.action ? s.action.target.locators : []);

describe('the record rule under screen masking (demo shop, scripted LLM, no network)', () => {
  let browser: Browser;
  const shops: Storefront[] = [];
  async function shop(): Promise<Storefront> {
    const s = await startStorefront();
    shops.push(s);
    return s;
  }

  async function discover(on: Storefront, id: string, input: string, output: string[], script: ScriptedTurn[]) {
    const runsDir = tempRunsDir('masked-record-discover-');
    const artifactPath = path.join(runsDir, `${id}.json`);
    const llm = createScriptedLlm(script);
    const progress: string[] = [];
    const outcome = await runDiscover(
      {
        goal: `Do ${id} for ${input}.`,
        input: [input],
        sensitive: [],
        output,
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
        baseUrl: on.baseUrl,
      },
      { llm, browser, policy: maskingPolicy(on.baseUrl), print: (l) => progress.push(l) },
    );
    expect(outcome.exitCode, `discover did not succeed:\n${progress.join('\n')}`).toBe(0);
    const raw = readFileSync(artifactPath, 'utf8');
    return { cap: JSON.parse(raw) as Capability, raw, prompts: llm.requests.map((r) => requestText(r)), runText: readRunText(outcome.runDir) };
  }

  async function replay(cap: Capability, on: Storefront, inputs: Record<string, string>) {
    const { result, runDir } = await replayOnce({ browser, mock: asTarget(on), capability: cap, inputs, runsDir: tempRunsDir('masked-record-replay-'), autoOperator: 'abort', stepTimeoutMs: 3_000, policy: maskingPolicy(on.baseUrl) });
    return { result, runText: readRunText(runDir) };
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

  it("people search: the masked row the click was scoped from is nowhere; the input echoed in the masked Name cell still anchors it", async () => {
    const al = person('Al Smithers');
    const hidden = [al.name, al.email];
    const { cap, raw, prompts, runText } = await discover(await shop(), 'open-person-masked', 'q=Smithers', ['email:string'], peopleScript());

    // The masking really ran: the model saw the row only as placeholders.
    expect(prompts.some((p) => p.includes('[MASKED:name]') && p.includes('[MASKED:e_mail]'))).toBe(true);
    for (const [i, p] of prompts.entries()) for (const v of hidden) expect(p, `LLM request #${i} carries ${v}`).not.toContain(v);
    for (const v of hidden) {
      expect(raw, `capability carries ${v}`).not.toContain(v);
      expect(runText, `discovery run dir (events, transcript, result) carries ${v}`).not.toContain(v);
    }

    // Content membership still decided the click from the real (masked) row: it is anchored on the
    // input's cell, in its own column, and nothing positional.
    expect(locatorsOf(stepNamed(cap, 'Open the person')).map((l) => l.strategy)).toEqual([
      { kind: 'relative', anchor: { text: '{input.q}', exact: false, wholeWord: true, selector: 'td:nth-child(1)' }, relation: 'right-of', tag: 'button', role: 'button', selector: 'td:nth-child(3) button' },
    ]);

    // Replay for another name opens that person, and its run directory holds no masked row value.
    const s = await shop();
    const lee = await replay(cap, s, { q: 'Lee' });
    expect(lee.result.kind, JSON.stringify(lee.result)).toBe('success');
    if (lee.result.kind === 'success') expect(lee.result.outputs.email).toBe(person('Bo Lee').email); // the caller gets the real value
    expect(s.peopleViews).toEqual([person('Bo Lee').id]);
    expect(lee.runText).not.toContain(person('Bo Lee').email); // a sensitive output: redacted in the evidence

    // An ambiguous name (five Joneses) escalates (or fails); neither the escalation nor the evidence names anyone.
    const s2 = await shop();
    const jones = await replay(cap, s2, { q: 'Jones' });
    expect(['escalated', 'hard_failure'], JSON.stringify(jones.result)).toContain(jones.result.kind);
    expect(s2.peopleViews).toEqual([]);
    const joneses = STORE_PEOPLE.filter((p) => p.name.endsWith(' Jones'));
    for (const v of [...joneses.map((p) => p.email), ...joneses.map((p) => p.name), al.email, al.name]) expect(jones.runText, `replay evidence carries ${v}`).not.toContain(v);
  }, 180_000);

  it("order search: the masked customer beside the status is in no prompt, locator, transcript or event, and the status is still read for another order", async () => {
    const hidden = ['Jane Roe'];
    const s = await shop();
    const { cap, raw, prompts, runText } = await discover(s, 'search-order-status-masked', 'q=A-10010', ['status:string'], orderSearchScript());
    expect(prompts.some((p) => p.includes('[MASKED:customer]'))).toBe(true);
    for (const [i, p] of prompts.entries()) for (const v of hidden) expect(p, `LLM request #${i} carries ${v}`).not.toContain(v);
    for (const v of hidden) {
      expect(raw, `capability carries ${v}`).not.toContain(v);
      expect(runText, `discovery run dir carries ${v}`).not.toContain(v);
    }
    expect(locatorsOf(stepNamed(cap, 'Read the order status')).map((l) => l.strategy)).toEqual([
      { kind: 'relative', anchor: { text: '{input.q}', exact: true, selector: 'td:nth-child(1)' }, relation: 'right-of', tag: 'td', selector: 'td:nth-child(3)' },
    ]);
    const r = await replay(cap, s, { q: 'A-1001' }); // the search also lists A-10010
    expect(r.result.kind, JSON.stringify(r.result)).toBe('success');
    if (r.result.kind === 'success') expect(r.result.outputs.status).toBe('Pending');
    for (const v of ['Bo Lee', 'Jane Roe']) expect(r.runText, `replay evidence carries ${v}`).not.toContain(v);
  }, 180_000);
});

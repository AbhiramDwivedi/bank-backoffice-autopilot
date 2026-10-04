/**
 * End-to-end on the real mock app, both tenants: a FRESH discovery of the standard flow (sign
 * on, dismiss the notice, search the member, open the result row, read name and savings balance)
 * records the result-row click (on the search page, where other members are listed) without a
 * positional locator, keeps the member's own page's chains, and the capability still replays:
 *  - for another member: that member's name and balance;
 *  - for a member that does not exist: a typed failure, not a wrong record;
 *  - with the shipped artifact's business outcomes grafted on: `member_not_found` and
 *    `member_access_denied`.
 * The shipped artifacts themselves are not touched: they were recorded under the old rules, carry
 * positional fallbacks, and the resolver still resolves them as before (the other e2e files
 * replay them).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { launchBrowser, policyFor, replayOnce, startMock, tempRunsDir, PASSWORD, USER, type MockServer } from './harness.js';
import { runDiscover } from '@cu/cli/commands/discover';
import { createScriptedLlm, isPositional, requestText, type ScriptedTurn } from '@cu/core/agent';
import { findRef } from '@cu/core/agent/test-helpers';
import { validateCapability, type BusinessOutcome, type Capability, type Step } from '@cu/core/schema';
import { DEFAULT_POLICY_FILE } from '@cu/cli/runtime';
import type { TenantId } from '@cu/mock-app/tenant';

const NOTICE_TEXT = 'System Maintenance Notice';
const RECORDED = { id: '12345', name: 'Jane Q. Sample', balanceText: '$1,234.56' };
const OTHER = { id: '10002', name: 'Denise M. Kowalczyk', balance: 12500 };
const SHIPPED = path.resolve('artifacts/lookup-member-savings-balance.json');

function script(memberLabel: string): ScriptedTurn[] {
  return [
    (req) => ({ tool: 'type', input: { ref: findRef(requestText(req), { role: 'textbox', nameIncludes: 'User ID' }), source: 'secret', value: 'MOCK_USER', why: 'Enter the user ID', expect: '' } }),
    (req) => ({ tool: 'type', input: { ref: findRef(requestText(req), { role: 'textbox', nameIncludes: 'Password' }), source: 'secret', value: 'MOCK_PASSWORD', why: 'Enter the password', expect: '' } }),
    (req) => ({ tool: 'click', input: { ref: findRef(requestText(req), { role: 'button', nameIncludes: 'login' }), why: 'Sign on', expect: NOTICE_TEXT } }),
    (req) => ({
      tool: 'dismiss_interstitial',
      input: { ref: findRef(requestText(req), { role: 'clickable', nameIncludes: 'OK' }), trigger_text: NOTICE_TEXT, title: NOTICE_TEXT, why: 'Dismiss the maintenance notice' },
    }),
    (req) => ({ tool: 'type', input: { ref: findRef(requestText(req), { role: 'textbox', nameIncludes: memberLabel }), source: 'input', value: 'memberId', why: 'Enter the member ID', expect: '' } }),
    (req) => ({ tool: 'click', input: { ref: findRef(requestText(req), { role: 'clickable', nameIncludes: 'Search' }), why: 'Search for the member', expect: 'record(s) found' } }),
    (req) => ({ tool: 'click', input: { ref: findRef(requestText(req), { role: 'clickable', nameIncludes: RECORDED.id }), why: 'Open the matching result', expect: 'Savings Balance' } }),
    (req) => ({ tool: 'extract', input: { ref: findRef(requestText(req), { role: 'cell', nameIncludes: RECORDED.name }), output: 'memberName', parse: 'text', why: 'Read the member name' } }),
    (req) => ({ tool: 'extract', input: { ref: findRef(requestText(req), { role: 'cell', nameIncludes: RECORDED.balanceText }), output: 'savingsBalance', parse: 'currency', why: 'Read the savings balance' } }),
    { tool: 'done', input: { success_text: 'Savings Balance', summary: "Read the member's name and savings balance." } },
  ];
}

const stepNamed = (cap: Capability, name: string): Step => {
  const s = cap.steps.find((x) => x.name === name);
  if (!s) throw new Error(`no step "${name}" in ${cap.steps.map((x) => x.name).join(', ')}`);
  return s;
};

/** The fresh capability with the shipped artifact's business outcomes, their `afterSteps`
 *  re-pointed from the shipped step ids to the fresh steps that do the same thing. */
function withShippedOutcomes(cap: Capability): Capability {
  const shipped = JSON.parse(readFileSync(SHIPPED, 'utf8')) as Capability;
  const map: Record<string, string> = {};
  for (const [shippedName, freshName] of [
    ['Search for the member by ID', 'Search for the member'],
    ['Open the member record for the searched member', 'Open the matching result'],
  ] as const) {
    const from = shipped.steps.find((s) => s.name === shippedName)!.id;
    map[from] = stepNamed(cap, freshName).id;
  }
  const outcomes: BusinessOutcome[] = shipped.businessOutcomes.map((o) => ({ ...o, ...(o.afterSteps ? { afterSteps: o.afterSteps.map((id) => map[id] ?? id) } : {}) }));
  const grafted: Capability = { ...cap, businessOutcomes: outcomes };
  const v = validateCapability(grafted);
  if (!v.ok) throw new Error(JSON.stringify(v.issues));
  return grafted;
}

describe.each([
  ['a', 'Member ID'],
  ['b', 'Member #'],
] as const)('tenant %s: fresh discovery records the member record without positional locators', (tenant: TenantId, memberLabel) => {
  let browser: Browser;
  let mock: MockServer;
  let capability: Capability;

  beforeAll(async () => {
    process.env.MOCK_USER ??= USER;
    process.env.MOCK_PASSWORD ??= PASSWORD;
    browser = await launchBrowser();
    mock = await startMock(tenant);
    const runsDir = tempRunsDir(`record-scope-mock-${tenant}-`);
    const artifactPath = path.join(runsDir, 'lookup-member.json');
    const progress: string[] = [];
    const outcome = await runDiscover(
      {
        goal: `Log in, look up member ${RECORDED.id} and read their name and savings balance.`,
        input: [`memberId=${RECORDED.id}`],
        sensitive: [],
        output: ['savingsBalance:number', 'memberName:string'],
        id: 'lookup-member',
        out: artifactPath,
        entry: '/login',
        vendor: 'Acme Core Systems',
        product: 'CU Core Workstation',
        operatorPort: 0,
        autoOperator: 'none',
        policy: DEFAULT_POLICY_FILE,
        runsDir,
        headless: true,
        baseUrl: mock.baseUrl,
      },
      { llm: createScriptedLlm(script(memberLabel)), browser, policy: policyFor(mock.baseUrl), print: (l) => progress.push(l) },
    );
    expect(outcome.exitCode, progress.join('\n')).toBe(0);
    capability = JSON.parse(readFileSync(artifactPath, 'utf8')) as Capability;
  }, 120_000);

  afterAll(async () => {
    await mock?.close();
    await browser?.close();
  });

  it("records the result-row click (a list page) with no positional locator; the extracts on the member's own page keep their label anchor first", () => {
    const row = stepNamed(capability, 'Open the matching result');
    if (!('target' in row.action)) throw new Error('row click has no target');
    expect(row.action.target.locators.length).toBeGreaterThan(0);
    expect(row.action.target.locators.filter(isPositional), JSON.stringify(row.action.target.locators)).toEqual([]);
    // The member's page has the input in its URL path: nothing else is listed there, so its
    // targets keep their chains (positional fallbacks included), led by the label anchor.
    for (const [name, label] of [
      ['Read the member name', 'Member Name'],
      ['Read the savings balance', 'Savings Balance'],
    ] as const) {
      const step = stepNamed(capability, name);
      if (!('target' in step.action)) throw new Error(`${name} has no target`);
      expect(step.action.target.locators[0]!.strategy).toMatchObject({ kind: 'relative', anchor: { text: label }, relation: 'right-of' });
    }
  });

  it("persists none of the recorded member's data (name, address, phone, join date) in any locator, recovery rules included", () => {
    const targets = [
      ...capability.steps.flatMap((s) => ('target' in s.action ? [s.action.target] : [])),
      ...capability.recoveryRules.flatMap((r) => r.actions.flatMap((a) => ('target' in a ? [a.target] : []))),
      ...capability.businessOutcomes.flatMap((o) => (o.extract ?? []).map((e) => e.target)),
    ];
    const locators = JSON.stringify(targets.map((t) => t.locators));
    for (const value of ['Jane', 'Sample', '282 Mill St', '555-0126', '08/15/2004']) expect(locators, value).not.toContain(value);
  });

  it("replays for another member and returns that member's name and balance", async () => {
    const run = await replayOnce({ browser, mock, capability, inputs: { memberId: OTHER.id }, runsDir: tempRunsDir(`record-scope-mock-${tenant}-r-`), autoOperator: 'abort' });
    expect(run.result.kind, JSON.stringify(run.result)).toBe('success');
    if (run.result.kind === 'success') {
      expect(run.result.outputs.savingsBalance).toBe(OTHER.balance);
      expect(run.result.outputs.memberName).toBe(OTHER.name);
    }
  }, 60_000);

  it('fails as a typed result for a member that does not exist', async () => {
    const run = await replayOnce({ browser, mock, capability, inputs: { memberId: '99999' }, runsDir: tempRunsDir(`record-scope-mock-${tenant}-m-`), autoOperator: 'abort', stepTimeoutMs: 3_000 });
    expect(['hard_failure', 'escalated'], JSON.stringify(run.result)).toContain(run.result.kind);
    expect(JSON.stringify(run.result)).not.toContain(RECORDED.name);
  }, 60_000);

  it.each([
    ['99999', 'member_not_found'],
    ['90001', 'member_access_denied'],
  ])('with the shipped outcomes grafted on, member %s ends as %s', async (id, outcomeName) => {
    const run = await replayOnce({ browser, mock, capability: withShippedOutcomes(capability), inputs: { memberId: id }, runsDir: tempRunsDir(`record-scope-mock-${tenant}-o-`), autoOperator: 'abort', stepTimeoutMs: 3_000 });
    expect(run.result.kind, JSON.stringify(run.result)).toBe('business_outcome');
    if (run.result.kind === 'business_outcome') expect(run.result.name).toBe(outcomeName);
  }, 60_000);
});

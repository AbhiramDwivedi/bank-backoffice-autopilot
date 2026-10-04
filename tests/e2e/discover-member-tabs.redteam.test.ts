/**
 * End-to-end on the real mock app, both tenants: discover "look up a member, click Accounts,
 * click Profile, read the savings balance", then replay it for a DIFFERENT member.
 *
 * Pins two findings:
 *  - A statically named control keeps its own locators. The member page's tabs sit under the
 *    heading "Member: <name> (#<id>)", which holds the run input; a rule that kept only
 *    input-bound locators for any target near the input recorded the tabs as nothing but a
 *    relative locator on that heading, which never resolves (three tabs tie under it), so the
 *    capability failed for every member, the recorded one included.
 *  - Neighbouring record data is never persisted in a locator. Container anchors are the
 *    neighbouring fields of a record (a member's name, address, phone); only one bound to a run
 *    input may be recorded.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { launchBrowser, policyFor, replayOnce, startMock, tempRunsDir, PASSWORD, USER, type MockServer } from './harness.js';
import { runDiscover } from '@cu/cli/commands/discover';
import { createScriptedLlm, requestText, type ScriptedTurn } from '@cu/core/agent';
import { findRef } from '@cu/core/agent/test-helpers';
import type { Capability, TargetDescriptor } from '@cu/core/schema';
import { DEFAULT_POLICY_FILE } from '@cu/cli/runtime';
import type { TenantId } from '@cu/mock-app/tenant';

const NOTICE_TEXT = 'System Maintenance Notice';
const RECORDED = { id: '12345', balanceText: '$1,234.56' };
const OTHER = { id: '10002', balance: 12500 };
/** Member 12345's own record data, shown on the pages the run passes through. */
const RECORD_DATA = ['Jane', 'Sample', 'Mill St', '555-0126', '08/15/2004'];

function script(memberLabel: string): ScriptedTurn[] {
  const t = (fn: ScriptedTurn): ScriptedTurn => fn;
  return [
    t((req) => ({ tool: 'type', input: { ref: findRef(requestText(req), { role: 'textbox', nameIncludes: 'User ID' }), source: 'secret', value: 'MOCK_USER', why: 'Enter the user ID', expect: '' } })),
    t((req) => ({ tool: 'type', input: { ref: findRef(requestText(req), { role: 'textbox', nameIncludes: 'Password' }), source: 'secret', value: 'MOCK_PASSWORD', why: 'Enter the password', expect: '' } })),
    t((req) => ({ tool: 'click', input: { ref: findRef(requestText(req), { role: 'button', nameIncludes: 'login' }), why: 'Sign on', expect: NOTICE_TEXT } })),
    t((req) => ({
      tool: 'dismiss_interstitial',
      input: { ref: findRef(requestText(req), { role: 'clickable', nameIncludes: 'OK' }), trigger_text: NOTICE_TEXT, title: NOTICE_TEXT, why: 'Dismiss the maintenance notice' },
    })),
    t((req) => ({ tool: 'type', input: { ref: findRef(requestText(req), { role: 'textbox', nameIncludes: memberLabel }), source: 'input', value: 'memberId', why: 'Enter the member ID', expect: '' } })),
    t((req) => ({ tool: 'click', input: { ref: findRef(requestText(req), { role: 'clickable', nameIncludes: 'Search' }), why: 'Search for the member', expect: 'record(s) found' } })),
    t((req) => ({ tool: 'click', input: { ref: findRef(requestText(req), { role: 'clickable', nameIncludes: RECORDED.id }), why: 'Open the matching result', expect: 'Savings Balance' } })),
    t((req) => ({ tool: 'click', input: { ref: findRef(requestText(req), { role: 'clickable', nameIncludes: 'Accounts' }), why: 'Open the Accounts tab', expect: '' } })),
    t((req) => ({ tool: 'click', input: { ref: findRef(requestText(req), { role: 'clickable', nameIncludes: 'Profile' }), why: 'Back to the Profile tab', expect: '' } })),
    t((req) => ({ tool: 'extract', input: { ref: findRef(requestText(req), { role: 'cell', nameIncludes: RECORDED.balanceText }), output: 'savingsBalance', parse: 'currency', why: 'Read the savings balance' } })),
    { tool: 'done', input: { success_text: 'Savings Balance', summary: 'Read the savings balance.' } },
  ];
}

function allTargets(cap: Capability): TargetDescriptor[] {
  const out: TargetDescriptor[] = [];
  for (const s of cap.steps) if ('target' in s.action) out.push(s.action.target);
  for (const o of cap.businessOutcomes) for (const e of o.extract ?? []) out.push(e.target);
  for (const r of cap.recoveryRules) for (const a of r.actions) if ('target' in a) out.push(a.target);
  return out;
}

describe.each([
  ['a', 'Member ID'],
  ['b', 'Member #'],
] as const)('tenant %s: tabs recorded by their own names, replayed for another member', (tenant: TenantId, memberLabel) => {
  let browser: Browser;
  let mock: MockServer;
  let capability: Capability;

  beforeAll(async () => {
    process.env.MOCK_USER ??= USER;
    process.env.MOCK_PASSWORD ??= PASSWORD;
    browser = await launchBrowser();
    mock = await startMock(tenant);
    const runsDir = tempRunsDir(`tabs-discover-${tenant}-`);
    const artifactPath = path.join(runsDir, 'member-balance-via-tabs.json');
    const progress: string[] = [];
    const outcome = await runDiscover(
      {
        goal: `Log in, look up member ${RECORDED.id}, open Accounts then Profile, and read the savings balance.`,
        input: [`memberId=${RECORDED.id}`],
        sensitive: [],
        output: ['savingsBalance:number'],
        id: 'member-balance-via-tabs',
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

  it('records each tab by its own text, not by a relative on the input-bearing heading', () => {
    for (const name of ['Accounts', 'Profile']) {
      const step = capability.steps.find((s) => s.action.type === 'click' && JSON.stringify(s.action.target.locators).includes(`"${name}"`));
      expect(step, `no click step names the ${name} tab`).toBeDefined();
      if (step?.action.type !== 'click') continue;
      expect(step.action.target.locators[0]!.strategy).toMatchObject({ kind: 'text', text: name });
      expect(JSON.stringify(step.action.target.locators)).not.toContain('{input.memberId}');
    }
  });

  it('replays for a different member and returns that member\'s balance', async () => {
    const run = await replayOnce({ browser, mock, capability, inputs: { memberId: OTHER.id }, runsDir: tempRunsDir(`tabs-replay-${tenant}-`), autoOperator: 'abort' });
    expect(run.result.kind, JSON.stringify(run.result)).toBe('success');
    if (run.result.kind === 'success') expect(run.result.outputs.savingsBalance).toBe(OTHER.balance);
  }, 60_000);

  it('persists none of the recorded member\'s record data in any locator of any target', () => {
    const locators = JSON.stringify(allTargets(capability).map((t) => t.locators));
    for (const value of RECORD_DATA) expect(locators, value).not.toContain(value);
  });
});

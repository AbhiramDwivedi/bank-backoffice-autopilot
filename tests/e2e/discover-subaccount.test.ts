/**
 * End-to-end on the real mock app: the open-sub-account form, discovered with the scripted LLM up
 * to the confirmation modal (the confirm itself is irreversible and stays out of this run), then
 * replayed for another member.
 *
 * Pins a regression: the account-type dropdown ("-- Select --", a clickable div with no identity
 * of its own) sits under "Member: Jane Q. Sample (#12345)". That legacy above-anchor merely
 * contains the input; it once made the dropdown count as anchored on the input, the same anchor
 * was then dropped as untrusted, no locator was left, and the click was refused, so the flow
 * could not be discovered. The form is the member's own page (the input is in the URL path), so
 * its controls keep their chains.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { launchBrowser, policyFor, replayOnce, startMock, tempRunsDir, PASSWORD, USER, type MockServer } from './harness.js';
import { runDiscover } from '@cu/cli/commands/discover';
import { createScriptedLlm, requestText, type ScriptedTurn } from '@cu/core/agent';
import { findRef } from '@cu/core/agent/test-helpers';
import type { Capability } from '@cu/core/schema';
import { DEFAULT_POLICY_FILE } from '@cu/cli/runtime';

const NOTICE_TEXT = 'System Maintenance Notice';

function script(): ScriptedTurn[] {
  return [
    (req) => ({ tool: 'type', input: { ref: findRef(requestText(req), { role: 'textbox', nameIncludes: 'User ID' }), source: 'secret', value: 'MOCK_USER', why: 'Enter the user ID', expect: '' } }),
    (req) => ({ tool: 'type', input: { ref: findRef(requestText(req), { role: 'textbox', nameIncludes: 'Password' }), source: 'secret', value: 'MOCK_PASSWORD', why: 'Enter the password', expect: '' } }),
    (req) => ({ tool: 'click', input: { ref: findRef(requestText(req), { role: 'button', nameIncludes: 'login' }), why: 'Sign on', expect: NOTICE_TEXT } }),
    (req) => ({
      tool: 'dismiss_interstitial',
      input: { ref: findRef(requestText(req), { role: 'clickable', nameIncludes: 'OK' }), trigger_text: NOTICE_TEXT, title: NOTICE_TEXT, why: 'Dismiss the maintenance notice' },
    }),
    (req) => ({ tool: 'type', input: { ref: findRef(requestText(req), { role: 'textbox', nameIncludes: 'Member ID' }), source: 'input', value: 'memberId', why: 'Enter the member ID', expect: '' } }),
    (req) => ({ tool: 'click', input: { ref: findRef(requestText(req), { role: 'clickable', nameIncludes: 'Search' }), why: 'Search for the member', expect: 'record(s) found' } }),
    (req) => ({ tool: 'click', input: { ref: findRef(requestText(req), { role: 'clickable', nameIncludes: '12345' }), why: 'Open the matching result', expect: 'Savings Balance' } }),
    (req) => ({ tool: 'click', input: { ref: findRef(requestText(req), { role: 'clickable', nameIncludes: 'Accounts' }), why: 'Open the Accounts tab', expect: 'Open New Sub-Account' } }),
    (req) => ({ tool: 'click', input: { ref: findRef(requestText(req), { role: 'link', nameIncludes: 'Open New Sub-Account' }), why: 'Open the new sub-account form', expect: 'Initial Deposit' } }),
    (req) => ({ tool: 'click', input: { ref: findRef(requestText(req), { role: 'clickable', nameIncludes: '-- Select --' }), why: 'Open the account type list', expect: 'Money Market' } }),
    (req) => ({ tool: 'click', input: { ref: findRef(requestText(req), { role: 'clickable', nameIncludes: 'Share Savings' }), why: 'Pick Share Savings', expect: '' } }),
    (req) => ({ tool: 'type', input: { ref: findRef(requestText(req), { role: 'textbox', nameIncludes: 'nickname' }), source: 'literal', value: 'Rainy day', why: 'Enter the nickname', expect: '' } }),
    (req) => ({ tool: 'type', input: { ref: findRef(requestText(req), { role: 'textbox', nameIncludes: 'initialDeposit' }), source: 'input', value: 'amount', why: 'Enter the initial deposit', expect: '' } }),
    (req) => ({ tool: 'click', input: { ref: findRef(requestText(req), { nameIncludes: 'Continue' }), why: 'Continue to the confirmation', expect: 'Confirm New Sub-Account' } }),
    (req) => ({ tool: 'extract', input: { ref: findRef(requestText(req), { nameIncludes: '$100' }), output: 'depositShown', parse: 'currency', why: 'Read the deposit shown for confirmation' } }),
    { tool: 'done', input: { success_text: 'Confirm New Sub-Account', summary: 'Filled the form up to the confirmation.' } },
  ];
}

describe('discover the open-sub-account form through its custom dropdown (tenant A, scripted LLM)', () => {
  let browser: Browser;
  let mock: MockServer;
  let capability: Capability;
  let progress: string[];

  beforeAll(async () => {
    process.env.MOCK_USER ??= USER;
    process.env.MOCK_PASSWORD ??= PASSWORD;
    browser = await launchBrowser();
    mock = await startMock('a');
    const runsDir = tempRunsDir('subaccount-discover-');
    const artifactPath = path.join(runsDir, 'fill-subaccount-form.json');
    progress = [];
    const outcome = await runDiscover(
      {
        goal: 'Look up member 12345 and fill a Share Savings sub-account form with an initial deposit, up to the confirmation.',
        input: ['memberId=12345', 'amount=100'],
        sensitive: [],
        output: ['depositShown:number'],
        id: 'fill-subaccount-form',
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
      { llm: createScriptedLlm(script()), browser, policy: policyFor(mock.baseUrl), print: (l) => progress.push(l) },
    );
    expect(outcome.exitCode, progress.join('\n')).toBe(0);
    capability = JSON.parse(readFileSync(artifactPath, 'utf8')) as Capability;
  }, 120_000);

  afterAll(async () => {
    await mock?.close();
    await browser?.close();
  });

  it('records the dropdown, the picked type, both fields and Continue', () => {
    for (const name of ['Open the account type list', 'Pick Share Savings', 'Enter the nickname', 'Enter the initial deposit', 'Continue to the confirmation']) {
      const step = capability.steps.find((s) => s.name === name);
      expect(step, `${name} not recorded; steps: ${capability.steps.map((s) => s.name).join(', ')}`).toBeDefined();
      if (step && 'target' in step.action) expect(step.action.target.locators.length, name).toBeGreaterThan(0);
    }
  });

  it('replays for another member and amount up to the confirmation', async () => {
    const run = await replayOnce({ browser, mock, capability, inputs: { memberId: '10002', amount: '250' }, runsDir: tempRunsDir('subaccount-replay-'), autoOperator: 'abort' });
    expect(run.result.kind, JSON.stringify(run.result)).toBe('success');
    if (run.result.kind === 'success') expect(run.result.outputs.depositShown).toBe(250);
  }, 60_000);
});

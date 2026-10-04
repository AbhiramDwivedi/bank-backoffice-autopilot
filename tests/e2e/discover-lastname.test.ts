/**
 * End-to-end on the real mock app (tenant A): look up a member by LAST NAME and read the savings
 * balance. The member's own page (/members/10002) carries no input in its URL, and the profile
 * table's text holds the last name searched for, so the balance cell belongs to the record only
 * through its container. It is a field of a one-record detail view: it keeps its own label anchor
 * ("Savings Balance", the only one on the page), verified on the live page, and nothing positional.
 *  - Recorded for Kowalczyk (one result), the capability replays for another member with a unique
 *    last name and returns that member's balance; a last name that lists two members (Brennan,
 *    Sampson) or none fails typed at the result click, never guessing a row.
 *  - Recorded for Sampson (two results; the first is opened), the result click is recorded in its
 *    specific form, and the balance the same way.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { launchBrowser, policyFor, replayOnce, startMock, tempRunsDir, PASSWORD, USER, type MockServer } from './harness.js';
import { runDiscover } from '@cu/cli/commands/discover';
import { createScriptedLlm, isPositional, requestText, type ScriptedTurn } from '@cu/core/agent';
import { findRef } from '@cu/core/agent/test-helpers';
import type { Capability, Locator, Step } from '@cu/core/schema';
import { DEFAULT_POLICY_FILE } from '@cu/cli/runtime';

const NOTICE_TEXT = 'System Maintenance Notice';

function script(rowPick: string, balanceText: string): ScriptedTurn[] {
  return [
    (req) => ({ tool: 'type', input: { ref: findRef(requestText(req), { role: 'textbox', nameIncludes: 'User ID' }), source: 'secret', value: 'MOCK_USER', why: 'Enter the user ID', expect: '' } }),
    (req) => ({ tool: 'type', input: { ref: findRef(requestText(req), { role: 'textbox', nameIncludes: 'Password' }), source: 'secret', value: 'MOCK_PASSWORD', why: 'Enter the password', expect: '' } }),
    (req) => ({ tool: 'click', input: { ref: findRef(requestText(req), { role: 'button', nameIncludes: 'login' }), why: 'Sign on', expect: NOTICE_TEXT } }),
    (req) => ({
      tool: 'dismiss_interstitial',
      input: { ref: findRef(requestText(req), { role: 'clickable', nameIncludes: 'OK' }), trigger_text: NOTICE_TEXT, title: NOTICE_TEXT, why: 'Dismiss the maintenance notice' },
    }),
    (req) => ({ tool: 'type', input: { ref: findRef(requestText(req), { role: 'textbox', nameIncludes: 'Last Name' }), source: 'input', value: 'lastName', why: 'Enter the last name', expect: '' } }),
    (req) => ({ tool: 'click', input: { ref: findRef(requestText(req), { role: 'clickable', nameIncludes: 'Search' }), why: 'Search for the member', expect: 'record(s) found' } }),
    (req) => ({ tool: 'click', input: { ref: findRef(requestText(req), { role: 'clickable', nameIncludes: rowPick }), why: 'Open the matching result', expect: 'Savings Balance' } }),
    (req) => ({ tool: 'extract', input: { ref: findRef(requestText(req), { role: 'cell', nameIncludes: balanceText }), output: 'savingsBalance', parse: 'currency', why: 'Read the savings balance' } }),
    { tool: 'done', input: { success_text: 'Savings Balance', summary: "Read the member's savings balance." } },
  ];
}

const stepNamed = (cap: Capability, name: string): Step => {
  const s = cap.steps.find((x) => x.name === name);
  if (!s) throw new Error(`no step "${name}" in ${cap.steps.map((x) => x.name).join(', ')}`);
  return s;
};
const locatorsOf = (s: Step): Locator[] => ('target' in s.action ? s.action.target.locators : []);

describe('discover the mock app through the last-name search, then replay', () => {
  let browser: Browser;
  let mock: MockServer;

  beforeAll(async () => {
    process.env.MOCK_USER ??= USER;
    process.env.MOCK_PASSWORD ??= PASSWORD;
    browser = await launchBrowser();
    mock = await startMock('a');
  });

  afterAll(async () => {
    await mock?.close();
    await browser?.close();
  });

  async function discover(lastName: string, rowPick: string, balanceText: string): Promise<Capability> {
    const runsDir = tempRunsDir('lastname-discover-');
    const artifactPath = path.join(runsDir, 'lookup-by-last-name.json');
    const progress: string[] = [];
    const outcome = await runDiscover(
      {
        goal: `Log in, look up the member with last name ${lastName} and read their savings balance.`,
        input: [`lastName=${lastName}`],
        sensitive: [],
        output: ['savingsBalance:number'],
        id: 'lookup-by-last-name',
        out: artifactPath,
        entry: '/login',
        vendor: 'Acme Core Systems',
        product: 'CU Core Workstation',
        operatorPort: 0,
        autoOperator: 'abort', // a stuck discovery ends instead of waiting for a human
        policy: DEFAULT_POLICY_FILE,
        runsDir,
        headless: true,
        baseUrl: mock.baseUrl,
      },
      { llm: createScriptedLlm(script(rowPick, balanceText)), browser, policy: policyFor(mock.baseUrl), print: (l) => progress.push(l) },
    );
    expect(outcome.exitCode, progress.join('\n')).toBe(0);
    return JSON.parse(readFileSync(artifactPath, 'utf8')) as Capability;
  }

  async function replay(cap: Capability, lastName: string) {
    await mock.reset();
    return (await replayOnce({ browser, mock, capability: cap, inputs: { lastName }, runsDir: tempRunsDir('lastname-replay-'), autoOperator: 'abort', stepTimeoutMs: 3_000 })).result;
  }

  it('recorded for Kowalczyk: the balance keeps only its label anchor; a unique other last name returns that member, an ambiguous or unknown one fails typed', async () => {
    const cap = await discover('Kowalczyk', 'Kowalczyk', '$12,500.00');
    expect(locatorsOf(stepNamed(cap, 'Read the savings balance')).map((l) => l.strategy)).toEqual([{ kind: 'relative', anchor: { text: 'Savings Balance' }, relation: 'right-of', tag: 'td' }]);
    const click = locatorsOf(stepNamed(cap, 'Open the matching result'));
    expect(click.filter(isPositional)).toEqual([]);
    expect(JSON.stringify(cap.steps)).not.toContain('Kowalczyk');

    for (const [lastName, balance] of [
      ['Pfeiffer', 9155.6],
      ['Nakamura', 50123.3],
      ['Kowalczyk', 12500],
    ] as const) {
      const r = await replay(cap, lastName);
      expect(r.kind, `${lastName}: ${JSON.stringify(r)}`).toBe('success');
      if (r.kind === 'success') expect(r.outputs.savingsBalance).toBe(balance);
    }
    for (const lastName of ['Brennan', 'Sampson', 'Zzyzx']) {
      const r = await replay(cap, lastName);
      expect(r.kind, `${lastName}: ${JSON.stringify(r)}`).toBe('hard_failure');
      if (r.kind === 'hard_failure') expect(r.code).toBe('element_not_found');
    }
  }, 180_000);

  it('recorded for Sampson (two results, the first opened): the balance keeps its label anchor, and the capability reads that member again', async () => {
    const cap = await discover('Sampson', '10009', '$1,500.25');
    expect(locatorsOf(stepNamed(cap, 'Read the savings balance')).map((l) => l.strategy)).toEqual([{ kind: 'relative', anchor: { text: 'Savings Balance' }, relation: 'right-of', tag: 'td' }]);
    expect(locatorsOf(stepNamed(cap, 'Open the matching result')).filter(isPositional)).toEqual([]);
    const again = await replay(cap, 'Sampson');
    expect(again.kind, JSON.stringify(again)).toBe('success');
    if (again.kind === 'success') expect(again.outputs.savingsBalance).toBe(1500.25);
    // Another last name: the click recorded for the first of two Sampsons cannot pick a row by position.
    const other = await replay(cap, 'Kowalczyk');
    expect(['hard_failure', 'escalated'], JSON.stringify(other)).toContain(other.kind);
  }, 180_000);
});

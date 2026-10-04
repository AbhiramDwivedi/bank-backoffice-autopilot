/**
 * End-to-end: screen masking against the real mock app (tenant A), with a policy that ALSO masks
 * the savings balance's label (the shipped default leaves balances visible). Discovery runs through
 * `runDiscover` (so compose() builds the Playwright surface from the policy), driven by a scripted
 * LLM that, like a real model, can only address the balance by its `[MASKED:savings_balance]`
 * placeholder. Proves:
 *  - discovery still extracts the correct balance through the masked field, and returns it;
 *  - the capability records it as a sensitive output, with no PII in any locator (nor the
 *    member's address or phone, which the default labels mask);
 *  - no model request, and no file in the discovery run directory, carries any of those values;
 *  - replay returns the right value while its evidence holds none of it.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { startMock, policyFor, launchBrowser, tempRunsDir, readRunText, replayOnce, PASSWORD, USER, type MockServer } from './harness.js';
import { runDiscover } from '@cu/cli/commands/discover';
import { createScriptedLlm, requestText, type ScriptedTurn } from '@cu/core/agent';
import { findRef } from '@cu/core/agent/test-helpers';
import { resolveScreenMask, validateCapability, type Policy } from '@cu/core/schema';
import { DEFAULT_POLICY_FILE } from '@cu/cli/runtime';

const MEMBER_ID = '12345';
const MEMBER_NAME = 'Jane Q. Sample';
const NOTICE_TEXT = 'System Maintenance Notice';
// Member 12345 in apps/mock-app/data/seed.ts: savings 123456 cents; address and phone from id % 97 = 26.
const BALANCE_FORMS = ['$1,234.56', '1,234.56', '1234.56'];
const ADDRESS = '282 Mill St, Springfield, MA 01103';
const PHONE = '(413) 555-0126';
const SECRETS = [...BALANCE_FORMS, ADDRESS, PHONE];

const turn =
  (tool: string, input: (text: string) => Record<string, unknown>): ScriptedTurn =>
  (req) => ({ tool, input: input(requestText(req)) });

function script(): ScriptedTurn[] {
  return [
    turn('type', (t) => ({ ref: findRef(t, { role: 'textbox', nameIncludes: 'User ID' }), source: 'secret', value: 'MOCK_USER', why: 'Enter the user ID', expect: '' })),
    turn('type', (t) => ({ ref: findRef(t, { role: 'textbox', nameIncludes: 'Password' }), source: 'secret', value: 'MOCK_PASSWORD', why: 'Enter the password', expect: '' })),
    turn('click', (t) => ({ ref: findRef(t, { role: 'button', nameIncludes: 'login' }), why: 'Sign on', expect: NOTICE_TEXT })),
    turn('dismiss_interstitial', (t) => ({ ref: findRef(t, { role: 'clickable', nameIncludes: 'OK' }), trigger_text: NOTICE_TEXT, title: NOTICE_TEXT, why: 'Dismiss the maintenance notice' })),
    turn('type', (t) => ({ ref: findRef(t, { role: 'textbox', nameIncludes: 'Member ID' }), source: 'input', value: 'memberId', why: 'Enter the member ID', expect: '' })),
    turn('click', (t) => ({ ref: findRef(t, { role: 'clickable', nameIncludes: 'Search' }), why: 'Search for the member', expect: 'record(s) found' })),
    turn('click', (t) => ({ ref: findRef(t, { role: 'clickable', nameIncludes: MEMBER_ID }), why: 'Open the matching result', expect: 'Savings Balance' })),
    turn('extract', (t) => ({ ref: findRef(t, { role: 'cell', nameIncludes: MEMBER_NAME }), output: 'memberName', parse: 'text', why: 'Read the member name' })),
    // The balance is masked: the model sees only the placeholder, and extracts that cell.
    turn('extract', (t) => ({ ref: findRef(t, { role: 'cell', nameIncludes: '[MASKED:savings_balance]' }), output: 'savingsBalance', parse: 'currency', why: 'Read the savings balance' })),
    { tool: 'done', input: { success_text: 'Savings Balance', summary: "Read the member's name and current savings balance." } },
  ];
}

/** The default policy for this mock, plus the savings balance's label in `maskLabels`. */
function maskingPolicy(baseUrl: string): Policy {
  const base = policyFor(baseUrl);
  const screen = resolveScreenMask(base.redaction.screen);
  return { ...base, redaction: { ...base.redaction, screen: { ...screen, maskLabels: [...screen.maskLabels, 'savings balance'] } } };
}

describe('screen masking end to end: discover through a masked field, replay with clean evidence', () => {
  let browser: Browser;
  let mock: MockServer;

  beforeAll(async () => {
    process.env.MOCK_USER ??= USER;
    process.env.MOCK_PASSWORD ??= PASSWORD;
    browser = await launchBrowser();
    mock = await startMock('a');
  });

  afterAll(async () => {
    await mock.close();
    await browser.close();
  });

  it('extracts the masked balance, records it sensitive with no PII in the capability, and keeps every value out of prompts and evidence', async () => {
    const runsDir = tempRunsDir('screen-mask-e2e-');
    const artifactPath = path.join(runsDir, 'lookup-member-savings-balance.masked.json');
    const llm = createScriptedLlm(script());
    const progress: string[] = [];
    const policy = maskingPolicy(mock.baseUrl);

    const outcome = await runDiscover(
      {
        goal: 'Log in, look up member 12345 and read their name and current savings balance.',
        input: [`memberId=${MEMBER_ID}`],
        sensitive: [],
        output: ['savingsBalance:number', 'memberName:string'],
        id: 'lookup-member-savings-balance',
        out: artifactPath,
        entry: '/login',
        vendor: 'Acme Core Systems',
        product: 'CU Core Workstation',
        operatorPort: 0,
        autoOperator: 'none',
        policy: DEFAULT_POLICY_FILE, // unused: deps.policy wins
        runsDir,
        headless: true,
        baseUrl: mock.baseUrl,
      },
      { llm, browser, policy, print: (l) => progress.push(l) },
    );

    expect(outcome.exitCode, `discover did not succeed; progress:\n${progress.join('\n')}`).toBe(0);
    // The caller gets the real value, read locally through the masked field.
    expect(outcome.result?.outputs?.savingsBalance).toBe(1234.56);
    expect(outcome.result?.outputs?.memberName).toBe(MEMBER_NAME);

    // The model saw the placeholders (the masking really ran) and never a value.
    const prompts = llm.requests.map((r) => requestText(r));
    expect(prompts.some((p) => p.includes('[MASKED:savings_balance]'))).toBe(true);
    expect(prompts.some((p) => p.includes('[MASKED:address]') && p.includes('[MASKED:phone]'))).toBe(true);
    expect(prompts.some((p) => p.includes('the value is withheld because the field is masked'))).toBe(true);
    for (const [i, p] of prompts.entries()) for (const v of SECRETS) expect(p, `LLM request #${i} carries ${v}`).not.toContain(v);

    // The capability: valid, the balance a sensitive output, no value anywhere in it.
    const written = JSON.parse(readFileSync(artifactPath, 'utf8')) as Record<string, unknown>;
    const validated = validateCapability(written);
    expect(validated.ok, JSON.stringify(!validated.ok && validated.issues)).toBe(true);
    if (!validated.ok) return;
    expect(validated.capability.outputs.savingsBalance).toMatchObject({ type: 'number', sensitive: true });
    expect(validated.capability.outputs.memberName?.sensitive).toBeUndefined();
    for (const v of SECRETS) expect(JSON.stringify(written), `capability carries ${v}`).not.toContain(v);

    // No file in the discovery run directory (events, transcript, result) carries a value.
    const runText = readRunText(outcome.runDir);
    for (const v of SECRETS) expect(runText, `discovery run dir carries ${v}`).not.toContain(v);

    // Replay: no model; the right value comes back; its evidence holds none of it.
    const replay = await replayOnce({ browser, mock, capability: written, inputs: { memberId: MEMBER_ID }, runsDir: tempRunsDir('screen-mask-e2e-replay-'), policy });
    expect(replay.result.kind).toBe('success');
    if (replay.result.kind === 'success') {
      expect(replay.result.outputs.savingsBalance).toBe(1234.56);
      expect(replay.result.outputs.memberName).toBe(MEMBER_NAME);
    }
    const persisted = JSON.parse(readFileSync(path.join(replay.runDir, 'result.json'), 'utf8')) as { outputs: Record<string, unknown> };
    expect(persisted.outputs.savingsBalance).toBe('[REDACTED]');
    const replayText = readRunText(replay.runDir);
    for (const v of SECRETS) expect(replayText, `replay run dir carries ${v}`).not.toContain(v);
  }, 90_000);
});

/**
 * End-to-end: `discover` (apps/cu/src/commands/discover.ts) against the real mock app (tenant A),
 * with a scripted LLM (no network) driving the goal "Log in, look up member {memberId} and read
 * their current savings balance." The written artifact is then replayed through the real mock
 * app with no LLM at all, proving discover -> artifact -> replay end to end.
 *
 * Each scripted turn is a function that reads the current turn's element list (via
 * `requestText`/`findRef`, packages/core/src/agent/test-helpers.ts) and finds its own ref by role and
 * accessible-name substring, since refs are positional per observation and none may be
 * hardcoded. The role/name vocabulary below was derived from the real markup
 * (apps/mock-app/views/*.ejs) and the enumeration heuristic that assigns roles and names to it
 * (packages/browser-agent/src/naming.ts).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { startMock, policyFor, launchBrowser, tempRunsDir, readRunText, readEvents, replayOnce, PASSWORD, USER, type MockServer } from './harness.js';
import { runDiscover } from '@cu/cli/commands/discover';
import { createScriptedLlm, requestText, type ScriptedTurn } from '@cu/core/agent';
import { findRef } from '@cu/core/agent/test-helpers';
import { validateCapability } from '@cu/core/schema';
import { DEFAULT_POLICY_FILE } from '@cu/cli/runtime';

const MEMBER_ID = '12345';
const MEMBER_NAME = 'Jane Q. Sample';
const SAVINGS_BALANCE_TEXT = '$1,234.56';
const NOTICE_TEXT = 'System Maintenance Notice';

// ---------------------------------------------------------------------------------------------
// Scripted turns: each reads the CURRENT turn's element list off the request text and resolves
// its own ref, so it never depends on a previous turn's ref numbering.
// ---------------------------------------------------------------------------------------------

function typeSecret(nameIncludes: string, env: string, why: string): ScriptedTurn {
  return (req) => ({
    tool: 'type',
    input: { ref: findRef(requestText(req), { role: 'textbox', nameIncludes }), source: 'secret', value: env, why, expect: '' },
  });
}

function typeInput(nameIncludes: string, inputName: string, why: string): ScriptedTurn {
  return (req) => ({
    tool: 'type',
    input: { ref: findRef(requestText(req), { role: 'textbox', nameIncludes }), source: 'input', value: inputName, why, expect: '' },
  });
}

function clickByRoleName(role: string, nameIncludes: string, why: string, expect = ''): ScriptedTurn {
  return (req) => ({ tool: 'click', input: { ref: findRef(requestText(req), { role, nameIncludes }), why, expect } });
}

function dismissInterstitial(triggerText: string, why: string, title: string = triggerText): ScriptedTurn {
  return (req) => ({
    tool: 'dismiss_interstitial',
    input: { ref: findRef(requestText(req), { role: 'clickable', nameIncludes: 'OK' }), trigger_text: triggerText, title, why },
  });
}

function extractField(nameIncludes: string, output: string, parse: 'text' | 'number' | 'currency', why: string): ScriptedTurn {
  return (req) => ({ tool: 'extract', input: { ref: findRef(requestText(req), { role: 'cell', nameIncludes }), output, parse, why } });
}

function doneTurn(successText: string, summary: string): ScriptedTurn {
  return { tool: 'done', input: { success_text: successText, summary } };
}

/** Log in, search, open the member, read name and balance. */
function g1Script(): ScriptedTurn[] {
  return [
    typeSecret('User ID', 'MOCK_USER', 'Enter the user ID'),
    typeSecret('Password', 'MOCK_PASSWORD', 'Enter the password'),
    clickByRoleName('button', 'login', 'Sign on', NOTICE_TEXT),
    dismissInterstitial(NOTICE_TEXT, 'Dismiss the maintenance notice'),
    typeInput('Member ID', 'memberId', 'Enter the member ID'),
    clickByRoleName('clickable', 'Search', 'Search for the member', 'record(s) found'),
    clickByRoleName('clickable', MEMBER_ID, 'Open the matching result', 'Savings Balance'),
    extractField(MEMBER_NAME, 'memberName', 'text', 'Read the member name'),
    extractField(SAVINGS_BALANCE_TEXT, 'savingsBalance', 'currency', 'Read the savings balance'),
    doneTurn('Savings Balance', "Read the member's name and current savings balance."),
  ];
}

describe('discover: G1 against the real mock app (tenant A), scripted LLM, no network', () => {
  let browser: Browser;
  let mock: MockServer;

  beforeAll(async () => {
    // runDiscover's default credential provider is the environment (no .env loader runs in tests --
    // that's apps/cu/src/env.ts, only wired into apps/cu/src/index.ts's real CLI entry point).
    process.env.MOCK_USER ??= USER;
    process.env.MOCK_PASSWORD ??= PASSWORD;
    browser = await launchBrowser();
    mock = await startMock('a');
  });

  afterAll(async () => {
    await mock.close();
    await browser.close();
  });

  it('discovers a valid, leak-free capability, then replays it with no LLM (savingsBalance 1234.56)', async () => {
    const runsDir = tempRunsDir('discover-e2e-runs-');
    const artifactPath = path.join(runsDir, 'lookup-member-savings-balance.discovered.json');
    const llm = createScriptedLlm(g1Script());
    const progressLines: string[] = [];

    const outcome = await runDiscover(
      {
        goal: 'Log in, look up member 12345 and read their current savings balance.',
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
        policy: DEFAULT_POLICY_FILE, // unused: deps.policy below wins
        runsDir,
        headless: true,
        baseUrl: mock.baseUrl,
        // No --read-only: the built-in optimization stage only analyses (no trial replays).
        // tests/e2e/optimize.test.ts covers the replay-backed optimizer against this app.
      },
      { llm, browser, policy: policyFor(mock.baseUrl), print: (l) => progressLines.push(l) },
    );

    expect(outcome.exitCode, `discover did not succeed; progress:\n${progressLines.join('\n')}`).toBe(0);
    expect(outcome.optimize?.report?.analysisReason, progressLines.join('\n')).toBe('not_read_only');
    expect(outcome.result?.status).toBe('success');
    expect(outcome.result?.stepsRecorded).toBeGreaterThan(0);
    expect(outcome.artifactPath).toBe(artifactPath);
    expect(outcome.result?.outputs?.memberName).toBe(MEMBER_NAME);
    expect(outcome.result?.outputs?.savingsBalance).toBe(1234.56);

    // The artifact is schema- and cross-field-valid.
    const written = JSON.parse(readFileSync(artifactPath, 'utf8')) as Record<string, unknown>;
    const validated = validateCapability(written);
    expect(validated.ok, `validateCapability issues: ${JSON.stringify(!validated.ok && validated.issues)}`).toBe(true);
    expect(written.id).toBe('lookup-member-savings-balance');
    // NOT 'read': packages/core/src/policy/guard.ts's classifyRisk() calls every click/type at least
    // 'reversible' (only navigate/extract/wait/press-without-Enter/dismiss_dialog-cancel are
    // 'read'), unlike the hand-curated artifacts/examples/*.example.json, which asserts 'read'
    // throughout, and unlike packages/core/src/agent/discover.test.ts's FakeSurface suite, whose stub guard
    // hardcodes risk:'read' for every allowed action.
    expect(written.riskLevel).toBe('reversible');

    // No password anywhere: not in the artifact, not in any evidence file under the run dir.
    const artifactText = JSON.stringify(written);
    expect(artifactText).not.toContain(PASSWORD);
    const runText = readRunText(outcome.runDir);
    expect(runText).not.toContain(PASSWORD);

    // Policy decisions of the enforcing surface are 'policy' events (docs/design/integration.md).
    const events = readEvents(outcome.runDir);
    const enforcingPolicyEvents = events.filter((e) => e.kind === 'policy' && (e.data as { source?: string }).source === 'enforcing-surface');
    expect(enforcingPolicyEvents.length).toBeGreaterThan(0);
    // Every enforcing-surface decision on this happy path was an allow.
    expect(enforcingPolicyEvents.every((e) => (e.data as { decision?: string }).decision === 'allow')).toBe(true);

    // discover -> artifact -> replay, end to end, no LLM in the replay half at all.
    const replay = await replayOnce({
      browser,
      mock,
      capability: written,
      inputs: { memberId: MEMBER_ID },
      runsDir: tempRunsDir('discover-e2e-replay-'),
    });
    expect(replay.result.kind).toBe('success');
    if (replay.result.kind === 'success') {
      expect(replay.result.outputs.savingsBalance).toBe(1234.56);
      expect(replay.result.outputs.memberName).toBe(MEMBER_NAME);
    }
  }, 60_000);

  it('discover --read-only runs the optimization trials against the real app and writes a verified draft with readOnly: true', async () => {
    const runsDir = tempRunsDir('discover-e2e-ro-runs-');
    const artifactPath = path.join(runsDir, 'lookup-member-savings-balance.read-only.json');
    const progressLines: string[] = [];
    const outcome = await runDiscover(
      {
        goal: 'Log in, look up member 12345 and read their current savings balance.',
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
        policy: DEFAULT_POLICY_FILE,
        runsDir,
        headless: true,
        baseUrl: mock.baseUrl,
        readOnly: true,
        // Small budgets keep this fast: one removal trial, one verification replay.
        optimizeMaxTrials: 1,
        optimizeVerifyRuns: 1,
      },
      { llm: createScriptedLlm(g1Script()), browser, policy: policyFor(mock.baseUrl), print: (l) => progressLines.push(l) },
    );
    expect(outcome.exitCode, progressLines.join('\n')).toBe(0);
    const report = outcome.optimize?.report;
    expect(report?.stop, progressLines.join('\n')).toBe('completed');
    expect(report?.baseline?.kind).toBe('success');
    expect(report!.trialsUsed).toBeGreaterThanOrEqual(2);
    expect(report!.removalTrialsUsed).toBe(1);
    expect(['search', 'start', 'unchanged']).toContain(report!.verification?.kept);

    const written = JSON.parse(readFileSync(artifactPath, 'utf8')) as Record<string, unknown>;
    expect(written.readOnly).toBe(true);
    expect(written.status).toBe('draft');
    expect(validateCapability(written).ok).toBe(true);
    // Every trial ran as a draft prerelease, never as the written version.
    for (const t of report!.trials) {
      const r = JSON.parse(readFileSync(path.join(runsDir, t.runId!, 'result.json'), 'utf8')) as { capabilityVersion: string };
      expect(r.capabilityVersion).toMatch(/^1\.0\.0-optimize\.\d+$/);
    }
  }, 120_000);
});

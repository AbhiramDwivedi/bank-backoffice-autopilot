/**
 * End to end on the desktop surface (Windows only; skipped elsewhere, CI is Linux): the real UIA
 * bridge, the real Teller Workstation (apps/mock-desktop), the CLI's own wiring (`runDiscover`,
 * `runReplay`, `compose` choosing the surface from the desktop:// base URL), and a scripted LLM.
 *
 *   1. discover "look up a member's savings balance" -> a capability with app.surface 'desktop'
 *   2. replay it with no model -> success, savingsBalance 1234.56
 *   3. replay for a member that does not exist -> business_outcome member_not_found
 *   4. replay with the lookup fault on -> hard_failure app_error
 *   5. discover "open a sub-account": the irreversible confirmation escalates, and the scripted
 *      operator approves it on the live session
 *
 * Every run launches its own app instance (small, non-activating, bottom-right of the screen) and
 * ends it; nothing depends on which window has focus.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runDiscover } from '@cu/cli/commands/discover';
import { compose, runReplay } from '@cu/cli/runtime';
import { createScriptedLlm, requestText, type ScriptedTurn } from '@cu/core/agent';
import { findRef } from '@cu/core/agent/test-helpers';
import { loadPolicy } from '@cu/core/policy';
import { validateCapability, type Capability } from '@cu/core/schema';
import { createFaultFile, tellerLaunch, TELLER_PASSWORD, TELLER_USER, type FaultFile } from '@cu/mock-desktop/launch';
import { readEvents, readRunText, tempRunsDir } from './harness.js';

const ON_WINDOWS = process.platform === 'win32';
const BASE_URL = 'desktop://tellerworkstation';
const POLICY_FILE = path.resolve('policies/desktop.yaml');

function typeSecret(nameIncludes: string, env: string, why: string): ScriptedTurn {
  return (req) => ({ tool: 'type', input: { ref: findRef(requestText(req), { role: 'textbox', nameIncludes }), source: 'secret', value: env, why, expect: '' } });
}
function typeInput(nameIncludes: string, input: string, why: string): ScriptedTurn {
  return (req) => ({ tool: 'type', input: { ref: findRef(requestText(req), { role: 'textbox', nameIncludes }), source: 'input', value: input, why, expect: '' } });
}
function click(role: string, nameIncludes: string, why: string, expect = ''): ScriptedTurn {
  return (req) => ({ tool: 'click', input: { ref: findRef(requestText(req), { role, nameIncludes }), why, expect } });
}
function extract(role: string, nameIncludes: string, output: string, parse: 'text' | 'currency', why: string): ScriptedTurn {
  return (req) => ({ tool: 'extract', input: { ref: findRef(requestText(req), { role, nameIncludes }), output, parse, why } });
}

const signOnTurns = (): ScriptedTurn[] => [
  typeSecret('User ID', 'MOCK_USER', 'Enter the user ID'),
  typeSecret('Password', 'MOCK_PASSWORD', 'Enter the password'),
  click('button', 'Sign On', 'Sign on', 'MEMBER LOOKUP'),
  typeInput('Member ID', 'memberId', 'Enter the member ID'),
  click('button', 'Find', 'Find the member', 'Savings Balance'),
];

describe.skipIf(!ON_WINDOWS)('desktop: discover -> capability -> replay against the real Teller Workstation', () => {
  let faults: FaultFile;
  let capability: Capability;
  const policy = loadPolicy(POLICY_FILE);

  beforeAll(() => {
    process.env.MOCK_USER = TELLER_USER;
    process.env.MOCK_PASSWORD = TELLER_PASSWORD;
    faults = createFaultFile();
  });
  afterEach(() => faults.clear());

  const desktop = (): { launch: ReturnType<typeof tellerLaunch> } => ({ launch: tellerLaunch({ faultFile: faults }) });

  it('discovers the balance lookup as a desktop capability, the model told it sees a desktop app', async () => {
    const runsDir = tempRunsDir('desktop-discover-');
    const out = path.join(runsDir, 'teller-savings-balance.json');
    const llm = createScriptedLlm([
      ...signOnTurns(),
      extract('textbox', 'Savings Balance', 'savingsBalance', 'currency', 'Read the savings balance'),
      extract('textbox', 'Name', 'memberName', 'text', 'Read the member name'),
      { tool: 'done', input: { success_text: 'Savings Balance', summary: "Read the member's savings balance." } },
    ]);
    const progress: string[] = [];
    const outcome = await runDiscover(
      {
        goal: 'Sign on, look up member 12345 and read their savings balance.',
        input: ['memberId=12345'],
        sensitive: [],
        output: ['savingsBalance:number', 'memberName:string'],
        id: 'teller-savings-balance',
        out,
        vendor: 'Example Teller Systems',
        product: 'Teller Workstation',
        operatorPort: 0,
        autoOperator: 'none',
        policy: POLICY_FILE,
        runsDir,
        headless: true,
        baseUrl: BASE_URL,
        desktop: desktop(),
      },
      { llm, policy, print: (l) => progress.push(l) },
    );
    expect(outcome.exitCode, `discover failed:\n${progress.join('\n')}`).toBe(0);
    expect(outcome.result?.outputs).toMatchObject({ savingsBalance: 1234.56, memberName: 'Jane Q. Sample' });

    const written = JSON.parse(readFileSync(out, 'utf8')) as unknown;
    const validated = validateCapability(written);
    expect(validated.ok, JSON.stringify(!validated.ok && validated.issues)).toBe(true);
    if (!validated.ok) return;
    capability = validated.capability;
    expect(capability.app.surface).toBe('desktop');
    expect(capability.app.entryUrl).toBe('{baseUrl}');
    expect(capability.steps[0]!.action).toEqual({ type: 'navigate', url: '{baseUrl}' });
    // Locators are UIA ones: AutomationIds and labels, no css.
    const kinds = capability.steps.flatMap((s) => ('target' in s.action ? s.action.target.locators.map((l) => l.strategy.kind) : []));
    expect(kinds).toContain('automation_id');
    expect(kinds).not.toContain('css');
    // The model was told the truth about what it was looking at.
    expect(llm.requests[0]!.system).toContain('Windows desktop back-office application');
    expect(requestText(llm.requests[0]!)).toContain('url: desktop://tellerworkstation/');
    // No credential in the artifact or the evidence.
    expect(JSON.stringify(written)).not.toContain(TELLER_PASSWORD);
    expect(readRunText(outcome.runDir)).not.toContain(TELLER_PASSWORD);
  }, 180_000);

  it('replays it with no model: success, the balance read off the desktop app', async () => {
    expect(capability, 'the discovery test must pass first').toBeDefined();
    const { result } = await runReplay({
      capability,
      inputs: { memberId: '12345' },
      policy,
      runsDir: tempRunsDir('desktop-replay-'),
      baseUrl: BASE_URL,
      headless: true,
      autoOperator: 'none',
      desktop: desktop(),
    });
    expect(result.kind, JSON.stringify(result)).toBe('success');
    if (result.kind === 'success') expect(result.outputs.savingsBalance).toBe(1234.56);
    expect(result.locatorReport.every((e) => e.fallbackDepth === 0)).toBe(true);
  }, 120_000);

  it('a member that does not exist is a business outcome, not a failure', async () => {
    expect(capability).toBeDefined();
    // The outcome an extend run (`discover --extend`) records for this capability, written directly.
    const withOutcome: Capability = {
      ...capability,
      businessOutcomes: [
        {
          name: 'member_not_found',
          description: 'No member has this ID.',
          detector: { kind: 'text_visible', text: 'No member found with ID' },
          returns: {},
        },
      ],
    };
    const { result } = await runReplay({
      capability: withOutcome,
      inputs: { memberId: '99999' },
      policy,
      runsDir: tempRunsDir('desktop-replay-nf-'),
      baseUrl: BASE_URL,
      headless: true,
      autoOperator: 'none',
      desktop: desktop(),
    });
    expect(result.kind, JSON.stringify(result)).toBe('business_outcome');
    if (result.kind === 'business_outcome') expect(result.name).toBe('member_not_found');
  }, 120_000);

  it('an application error during lookup is a hard failure classified app_error', async () => {
    expect(capability).toBeDefined();
    faults.set({ failLookup: true });
    const { result } = await runReplay({
      capability,
      inputs: { memberId: '12345' },
      policy,
      runsDir: tempRunsDir('desktop-replay-err-'),
      baseUrl: BASE_URL,
      headless: true,
      autoOperator: 'none',
      desktop: desktop(),
    });
    expect(result.kind, JSON.stringify(result)).toBe('hard_failure');
    if (result.kind === 'hard_failure') expect(result.code).toBe('app_error');
  }, 120_000);

  it("Relay's live screenshot works unchanged on a desktop run: it only asks the Surface", async () => {
    const c = await compose({ runKind: 'replay', policy, runsDir: tempRunsDir('desktop-relay-'), baseUrl: BASE_URL, operator: { port: 0 }, desktop: desktop() });
    try {
      const res = await fetch(`${c.operator!.url}/api/runs/${c.runId}/screenshot`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('image/png');
      const png = Buffer.from(await res.arrayBuffer());
      expect(png.readUInt32BE(0)).toBe(0x89504e47);
      expect(png.readUInt32BE(16)).toBe(440); // IHDR width: the app's own window, not the desktop
    } finally {
      await c.close();
    }
  }, 120_000);

  it('an irreversible confirmation escalates during discovery and the scripted operator approves it on the live app', async () => {
    const runsDir = tempRunsDir('desktop-discover-esc-');
    const llm = createScriptedLlm([
      ...signOnTurns(),
      click('button', 'Open Sub-Account...', 'Start opening a sub-account', 'Confirm'),
      click('button', 'Open Sub-Account', 'Confirm opening the sub-account', 'opened for member'),
      extract('text', 'Sub-account SA-', 'confirmation', 'text', 'Read the confirmation'),
      { tool: 'done', input: { success_text: 'MEMBER DETAIL', summary: 'Opened a sub-account.' } },
    ]);
    const progress: string[] = [];
    const outcome = await runDiscover(
      {
        goal: 'Sign on, look up member 12345 and open a share savings sub-account.',
        input: ['memberId=12345'],
        sensitive: [],
        output: ['confirmation:string'],
        id: 'teller-open-sub-account',
        out: path.join(runsDir, 'teller-open-sub-account.json'),
        vendor: 'Example Teller Systems',
        product: 'Teller Workstation',
        operatorPort: 0,
        autoOperator: 'approve',
        allowUnattendedIrreversible: true,
        policy: POLICY_FILE,
        runsDir,
        headless: true,
        baseUrl: BASE_URL,
        desktop: desktop(),
      },
      { llm, policy, print: (l) => progress.push(l) },
    );
    expect(outcome.exitCode, `discover failed:\n${progress.join('\n')}`).toBe(0);
    expect(String(outcome.result?.outputs?.confirmation)).toMatch(/^Sub-account SA-\d{7} opened for member 12345\.$/);
    // The confirmation click was flagged irreversible and escalated, then approved.
    const events = readEvents(outcome.runDir);
    const flagged = events.filter((e) => e.kind === 'policy' && /irreversible/.test(JSON.stringify(e.data)));
    expect(flagged.length).toBeGreaterThan(0);
    expect(readRunText(outcome.runDir)).toContain('risky_action_confirmation');
    const cap = JSON.parse(readFileSync(outcome.artifactPath!, 'utf8')) as Capability;
    expect(cap.riskLevel).toBe('irreversible');
  }, 180_000);
});

/**
 * Red team: the optimizer's own sinks -- `optimize.json`, `cu optimize --json` stdout, the text
 * summary, and the provenance note written into the optimized draft -- never carry a caller output
 * value, a sensitive input value, or a policy-pattern-shaped value (an SSN), even when the trial
 * replays return them in their outputs and failure messages. The replay's own `result.json` is
 * redacted at the run logger; these sinks are written by the optimizer and the CLI, so they must
 * not hold values at all (output NAMES and verdicts only) and must redact what failure text they do
 * keep.
 *
 * Also pins the trial-safety wiring that behaviour alone cannot fully distinguish: replay never
 * raises a risky-action escalation, so an `approve` operator would also abort every trial
 * escalation. Every trial must be called with the aborting operator, no console, and the forced
 * approval gate -- and a caller's pass-through options cannot override them.
 *
 * `runReplay` is mocked: nothing here launches a browser.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Capability, ReplayResult } from '@cu/core/schema';
import { DEFAULT_POLICY_PATH, loadPolicy } from '@cu/core/policy';
import { credentialSet, type CredentialProvider } from '@cu/core/credentials';
import type { RunReplayOptions, RunReplayResult } from '../runtime/run-replay.js';

const SSN = '123-45-6789';
const OTHER_SSN = '987-65-4321';
const PIN = '97531';
const NAME = 'Jane Q. Sample';

const runReplayMock = vi.hoisted(() => vi.fn());
vi.mock('../runtime/run-replay.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runtime/run-replay.js')>();
  return { ...actual, runReplay: runReplayMock };
});

const { runOptimizeCommand } = await import('./optimize.js');

const dirs: string[] = [];
afterEach(() => {
  runReplayMock.mockReset();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const t = (description: string, text: string) => ({
  description,
  frame: [],
  locators: [{ strategy: { kind: 'text' as const, text, exact: true }, confidence: 0.7, source: 'inferred' as const }],
});

function capability(): Capability {
  return {
    schemaVersion: '1.0',
    id: 'read-member-ssn',
    version: '1.0.0',
    name: 'Read Member SSN',
    description: 'Read a member record.',
    app: { vendor: 'Acme Core Systems', product: 'CU Core Workstation', surface: 'web', entryUrl: '{baseUrl}/login' },
    status: 'approved',
    riskLevel: 'reversible',
    readOnly: true,
    inputs: {
      memberId: { type: 'string', description: 'member id', required: true, sensitive: false },
      pin: { type: 'string', description: 'operator PIN', required: true, sensitive: true },
    },
    outputs: { ssn: { type: 'string', description: 'ssn' }, memberName: { type: 'string', description: 'name' } },
    steps: [
      { id: 's01', name: 'Open the member', action: { type: 'navigate', url: '{baseUrl}/members/{input.memberId}' }, risk: 'read' },
      { id: 's02', name: 'Enter the PIN', action: { type: 'type', target: t('PIN field', 'PIN'), value: { kind: 'input', name: 'pin' }, clear: true }, risk: 'reversible' },
      { id: 's03', name: 'Open the Notes tab', action: { type: 'click', target: t('tab "Notes"', 'Notes') }, risk: 'reversible' },
      { id: 's06', name: 'Open the Profile tab', action: { type: 'click', target: t('tab "Profile"', 'Profile') }, risk: 'reversible' },
      { id: 's04', name: 'Read the SSN', action: { type: 'extract', target: t('ssn cell', 'SSN'), output: 'ssn', parse: 'text' }, risk: 'read' },
      { id: 's05', name: 'Read the name', action: { type: 'extract', target: t('name cell', 'Name'), output: 'memberName', parse: 'text' }, risk: 'read' },
    ],
    success: { condition: { kind: 'url_matches', pattern: '/members/{input.memberId}' }, description: 'on the member' },
    businessOutcomes: [],
    recoveryRules: [],
    provenance: { discoveredAt: '2026-09-26T00:00:00.000Z', discoveryRunId: 'run_x', recordedBy: 'llm' },
  };
}

function base(runId: string, cap: Capability): Omit<ReplayResult, 'kind'> {
  return { runId, capabilityId: cap.id, capabilityVersion: cap.version, stepsExecuted: 1, durationMs: 1, locatorReport: [], recoveries: [] } as never;
}

/** Fake trials: the full capability (and one without the Notes click) returns the SSN and name;
 *  without the Profile click (s06) the "app" fails with a message quoting the SSN and the PIN. */
function installFakeReplay(): void {
  let n = 0;
  runReplayMock.mockImplementation(async (o: RunReplayOptions): Promise<RunReplayResult> => {
    n += 1;
    const cap = o.capability as Capability;
    const ids = new Set(cap.steps.map((s) => s.id));
    const runId = `run_fake_${n}`;
    let result: ReplayResult;
    if (!ids.has('s06')) {
      result = {
        ...base(runId, cap),
        kind: 'hard_failure',
        stepId: 's02',
        code: 'app_error',
        expected: 'x',
        observed: `SSN ${SSN} for PIN ${PIN}`,
        message: `Application Error: record ${SSN} rejected PIN ${PIN}`,
        evidence: {},
      } as ReplayResult;
    } else {
      result = { ...base(runId, cap), kind: 'success', outputs: { ssn: ids.has('s02') ? SSN : OTHER_SSN, memberName: NAME } } as ReplayResult;
    }
    return { result, runDir: path.join(os.tmpdir(), runId), controlState: 'automation' };
  });
}

function setup(): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'optimize-leak-'));
  dirs.push(dir);
  const file = path.join(dir, 'read-member-ssn.json');
  fs.writeFileSync(file, JSON.stringify(capability(), null, 2));
  return { dir, file };
}

describe('optimizer sinks never carry values', () => {
  for (const json of [false, true]) {
    it(`optimize.json, ${json ? '--json stdout' : 'the text summary'} and the provenance note hold no output, sensitive or SSN-shaped value`, async () => {
      installFakeReplay();
      const { dir, file } = setup();
      const out: string[] = [];
      const progress: string[] = [];
      const res = await runOptimizeCommand(
        { artifactPath: file, input: ['memberId=12345', `pin=${PIN}`], policy: DEFAULT_POLICY_PATH, runsDir: path.join(dir, 'runs'), headless: true, baseUrl: 'http://localhost:4173', verifyRuns: 1, json },
        { policy: loadPolicy(DEFAULT_POLICY_PATH), progress: (l) => progress.push(l), stdout: (l) => out.push(l) },
      );
      expect(res.exitCode, progress.join('\n')).toBe(0);
      // The search really ran: s03 (the wrong turn) was removed, s06's removal failed with the leaky message.
      expect(res.report!.changes.map((c) => c.stepId)).toContain('s03');
      expect(res.report!.rejected.find((r) => r.stepId === 's06')!.reason).toContain('[REDACTED:ssn]');

      const sinks = {
        'optimize.json': fs.readFileSync(res.reportPath!, 'utf8'),
        stdout: out.join('\n'),
        progress: progress.join('\n'),
        artifact: fs.readFileSync(res.outPath!, 'utf8'),
      };
      for (const [sink, text] of Object.entries(sinks)) {
        for (const value of [SSN, OTHER_SSN, PIN, NAME]) expect(text, `${sink} leaks ${value}`).not.toContain(value);
      }
      // Output names, not values.
      expect(JSON.parse(sinks['optimize.json']).baseline).toMatchObject({ kind: 'success', outputNames: ['ssn', 'memberName'] });
    });
  }
});

describe('trial-safety wiring', () => {
  it('every trial runs the runner-owned capability copy, inputs, policy, runs dir, browser and tenant, with the aborting operator, no console and the forced approval gate -- the pass-through carries credentials and nothing else', async () => {
    installFakeReplay();
    const { dir } = setup();
    const { runOptimize } = await import('../runtime/run-optimize.js');
    const policy = loadPolicy(DEFAULT_POLICY_PATH);
    const browser = { ownBrowser: true } as never;
    const inputs = { memberId: '12345', pin: PIN };
    const runsDir = path.join(dir, 'runs');
    // Answers whatever names the capability binds; its id must survive into every trial's provider.
    const callerCredentials: CredentialProvider = {
      id: 'the-credentials-provider',
      load: (names) => Promise.resolve({ ok: true, set: credentialSet(Object.fromEntries(names.map((n) => [n, 'value-of-' + n.toLowerCase()]))) }),
    };
    const result = await runOptimize({
      capability: capability(),
      inputs,
      policy,
      runsDir,
      baseUrl: 'http://localhost:4173',
      headless: true,
      verifyRuns: 1,
      browser,
      // A caller trying to loosen the trial wiring through the pass-through.
      replayPassThrough: {
        credentials: callerCredentials,
        surface: { shared: true },
        browser: { otherBrowser: true },
        tenant: 'hostile-tenant',
        capability: { id: 'something-else' },
        inputs: { memberId: '99999' },
        policy: { name: 'permissive' },
        policyPath: 'policies/permissive.yaml',
        runsDir: '/elsewhere',
        autoOperator: 'approve',
        operator: { port: 0 },
        replayExtras: { requireApproved: false },
      } as never,
    });
    expect(runReplayMock.mock.calls.length).toBeGreaterThan(2);
    for (const [o] of runReplayMock.mock.calls as [RunReplayOptions & { credentials?: unknown }][]) {
      // The caller's provider is loaded once; every trial gets a provider backed by that one set.
      expect((o.credentials as CredentialProvider).id).toBe('the-credentials-provider');
      expect(o.surface).toBeUndefined();
      expect(o.browser).toBe(browser);
      expect(o.tenant).toBeUndefined();
      expect((o.capability as Capability).id).toBe('read-member-ssn');
      expect((o.capability as Capability).status).toBe('draft');
      expect((o.capability as Capability).version).toMatch(/-optimize\.\d+$/);
      expect(o.inputs).toEqual(inputs);
      expect(o.policy).toBe(policy);
      expect(o.policyPath).toBeUndefined();
      expect(o.runsDir).toBe(runsDir);
      expect(o.autoOperator).toBe('abort');
      expect(o.operator).toBeUndefined();
      expect(o.replayExtras?.requireApproved).toBe(true);
    }
    expect(result.report.probedTenant).toBe('base');
  });
});

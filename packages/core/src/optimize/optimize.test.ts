/**
 * The optimizer's search, pass by pass, against a FAKE trial runner: each test describes which
 * steps a successful run needs, what it outputs, and which checkpoints already hold before their
 * step, and the fake "replays" a candidate by those rules (calling the probe hook the way replay
 * would). No surface, no browser, no replay engine -- that is optimize.replay.test.ts.
 *
 * The boundary comes first: without the operator's read-only declaration, or with any veto, the
 * optimizer never calls the trial runner and never rewrites anything.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateCapability, type Capability, type Condition, type Step, type TargetDescriptor } from '../schema/index.js';
import { optimizeCapability } from './optimize.js';
import { summarizeOptimization } from './report.js';
import type { OutputMap, RunTrial, TrialOutcome, TrialRequest } from './types.js';

const SHIPPED_URL = new URL('../../../../artifacts/lookup-member-savings-balance.json', import.meta.url);

function validateOrThrow(raw: unknown): Capability {
  const res = validateCapability(raw);
  if (!res.ok) throw new Error(JSON.stringify(res.issues));
  return res.capability;
}

/** The shipped artifact as it is on disk: NOT declared read-only. */
function loadShipped(): Capability {
  return validateOrThrow(JSON.parse(readFileSync(SHIPPED_URL, 'utf8')));
}

/** The shipped artifact with the operator's read-only declaration added. */
function readOnlyShipped(edit?: (cap: Capability) => void): Capability {
  const cap: Capability = { ...loadShipped(), readOnly: true };
  edit?.(cap);
  return validateOrThrow(cap);
}

interface FakeRules {
  /** Step ids a run needs to succeed. */
  required: string[];
  /** Outputs of a successful run; a function of the present step ids when they vary. */
  outputs: OutputMap | ((present: Set<string>) => OutputMap);
  /** Step id -> whether its probed condition holds before it acts (default false). */
  preHeld?: Record<string, boolean | ((call: number) => boolean)>;
  /** Override the outcome of the n-th call (1-based), e.g. to inject a flaky failure. */
  outcomeOf?: (call: number, req: TrialRequest, present: Set<string>) => TrialOutcome | undefined;
}

function fakeTrial(rules: FakeRules): { runTrial: RunTrial; calls: TrialRequest[] } {
  const calls: TrialRequest[] = [];
  const runTrial: RunTrial = async (req) => {
    calls.push(req);
    const call = calls.length;
    const present = new Set(req.capability.steps.map((s) => s.id));
    for (const step of req.capability.steps) {
      const rule = rules.preHeld?.[step.id];
      const held = typeof rule === 'function' ? rule(call) : rule === true;
      await req.beforeStep?.({ step, check: async (_c: Condition) => held });
    }
    const injected = rules.outcomeOf?.(call, req, present);
    if (injected) return injected;
    const missing = rules.required.filter((id) => !present.has(id));
    if (missing.length > 0) return { kind: 'hard_failure', detail: `element_not_found after removing ${missing.join(',')}`, runId: `run_${call}` };
    const outputs = typeof rules.outputs === 'function' ? rules.outputs(present) : rules.outputs;
    return { kind: 'success', outputs: { ...outputs }, runId: `run_${call}` };
  };
  return { runTrial, calls };
}

const SHIPPED_OUTPUTS: OutputMap = { savingsBalance: 1234.56, memberName: 'Jane Q. Sample' };
const SHIPPED_REQUIRED = ['s01', 's02', 's03', 's05', 's06', 's07', 's08', 's09', 's10'];

function target(description: string, text: string): TargetDescriptor {
  return { description, frame: [], locators: [{ strategy: { kind: 'text', text, exact: true }, confidence: 0.7, source: 'inferred' }] };
}

/** A small capability declared read-only: open the page, click a WRONG tab, click the right tab, read a value. */
function wrongTurnCapability(edit?: (cap: Record<string, unknown> & { steps: Step[] }) => void): Capability {
  const steps: Step[] = [
    { id: 's01', name: 'Open the member page', action: { type: 'navigate', url: '{baseUrl}/members/1' }, risk: 'read' },
    { id: 's02', name: 'Open the Notes tab', action: { type: 'click', target: target('tab "Notes"', 'Notes') }, risk: 'reversible' },
    { id: 's03', name: 'Open the Accounts tab', action: { type: 'click', target: target('tab "Accounts"', 'Accounts') }, risk: 'reversible' },
    {
      id: 's04',
      name: 'Read the balance',
      action: { type: 'extract', target: target('balance cell', 'Balance'), output: 'balance', parse: 'currency' },
      risk: 'read',
    },
  ];
  const cap = {
    schemaVersion: '1.0',
    id: 'read-balance',
    version: '1.0.0',
    name: 'Read Balance',
    description: 'Read a balance.',
    app: { vendor: 'Acme Core Systems', product: 'CU Core Workstation', surface: 'web', entryUrl: '{baseUrl}/login' },
    status: 'approved',
    riskLevel: 'reversible',
    readOnly: true,
    inputs: {},
    outputs: { balance: { type: 'number', description: 'balance' } },
    steps,
    success: { condition: { kind: 'text_visible', text: 'Balance' }, description: 'read the balance' },
    businessOutcomes: [],
    recoveryRules: [],
    provenance: { discoveredAt: '2026-09-26T00:00:00.000Z', discoveryRunId: 'run_x', recordedBy: 'llm' },
  };
  edit?.(cap as unknown as Record<string, unknown> & { steps: Step[] });
  return validateOrThrow(cap);
}

describe('optimizeCapability: the read-only boundary', () => {
  it('without the read-only declaration, never replays and rewrites nothing -- not even the exact repeat', async () => {
    const cap = loadShipped();
    const { runTrial, calls } = fakeTrial({ required: SHIPPED_REQUIRED, outputs: SHIPPED_OUTPUTS });
    const { capability, report } = await optimizeCapability(cap, { runTrial });

    expect(calls).toHaveLength(0);
    expect(capability).toBe(cap);
    expect(report.changed).toBe(false);
    expect(report.stop).toBe('analysis_only');
    expect(report.analysisReason).toBe('not_read_only');
    expect(report.stopDetail).toContain('--read-only');
    // ...but it says what it would look at.
    expect(report.analysis.redundantRepeats).toEqual([{ stepId: 's04', repeatOf: 's03' }]);
    expect(report.analysis.checkpointsToProbe).toEqual(['s02', 's04', 's07', 's08']);
    expect(report.analysis.removalCandidates).not.toContain('s06'); // override-referenced
  });

  it('--analyze-only rewrites nothing even when the capability is read-only', async () => {
    const { runTrial, calls } = fakeTrial({ required: SHIPPED_REQUIRED, outputs: SHIPPED_OUTPUTS });
    const { report } = await optimizeCapability(readOnlyShipped(), { runTrial, analyzeOnly: true });
    expect(calls).toHaveLength(0);
    expect(report.analysisReason).toBe('requested');
  });

  it('a declared irreversible step vetoes trials', async () => {
    const cap = validateOrThrow({ ...loadShipped(), riskLevel: 'irreversible', steps: loadShipped().steps.map((s) => (s.id === 's05' ? { ...s, risk: 'irreversible' } : s)) });
    const { runTrial, calls } = fakeTrial({ required: SHIPPED_REQUIRED, outputs: SHIPPED_OUTPUTS });
    // (readOnly cannot sit on an irreversible capability -- the validator refuses it -- so the
    // veto is exercised the way the CLI asserts it: on a policy-classified step below.)
    const { report } = await optimizeCapability({ ...cap, readOnly: true }, { runTrial });
    expect(calls).toHaveLength(0);
    expect(report.analysisReason).toBe('irreversible_steps');
    expect(report.irreversibleSteps).toEqual(['s05']);
  });

  it('a step the injected policy classifies irreversible vetoes trials', async () => {
    const { runTrial, calls } = fakeTrial({ required: ['s01', 's03', 's04'], outputs: { balance: 310 } });
    const { report } = await optimizeCapability(wrongTurnCapability(), { runTrial, isIrreversible: (s) => s.id === 's03' });
    expect(calls).toHaveLength(0);
    expect(report.analysisReason).toBe('irreversible_steps');
  });

  it('classifies recovery actions and the trialled tenant override extra steps too', async () => {
    const { runTrial, calls } = fakeTrial({ required: SHIPPED_REQUIRED, outputs: SHIPPED_OUTPUTS });
    // The shipped artifact's recovery rule clicks "OK"; a policy that calls it irreversible vetoes.
    const flagRecovery = await optimizeCapability(readOnlyShipped(), { runTrial, isIrreversible: (s) => s.id.startsWith('recovery:') });
    expect(flagRecovery.report.analysisReason).toBe('irreversible_steps');
    expect(flagRecovery.report.irreversibleSteps).toEqual(['recovery:dismiss_system_maintenance_notice[0]', 'recovery:dismiss_system_maintenance_notice[1]']);

    const withExtra = readOnlyShipped((c) => {
      c.overrides![0]!.extraSteps = [{ afterStepId: 's05', step: { id: 's05b', name: 'Acknowledge the banner', action: { type: 'click', target: target('banner', 'Acknowledge') }, risk: 'reversible' } }];
    });
    const flagExtra = (s: Step): boolean => s.id === 'override:riverbend-fcu:s05b';
    // Classified when that tenant is the one trialled...
    const tenantB = await optimizeCapability(withExtra, { runTrial, tenant: 'riverbend-fcu', isIrreversible: flagExtra });
    expect(tenantB.report.irreversibleSteps).toEqual(['override:riverbend-fcu:s05b']);
    // ...not for a trial of the base capability, which never runs it.
    const base = await optimizeCapability(withExtra, { runTrial, verifyRuns: 1, maxTrials: 0, isIrreversible: flagExtra });
    expect(base.report.irreversibleSteps).toEqual([]);
    expect(calls.filter((c) => c.purpose === 'baseline')).toHaveLength(1);
  });

  it('by default classifies a "Confirm"-like click irreversible even when the step says reversible', async () => {
    const cap = wrongTurnCapability((c) => {
      c.steps[2] = { ...c.steps[2]!, action: { type: 'click', target: target('button "Confirm transfer"', 'Confirm transfer') } };
    });
    const { runTrial, calls } = fakeTrial({ required: [], outputs: { balance: 1 } });
    const { report } = await optimizeCapability(cap, { runTrial });
    expect(calls).toHaveLength(0);
    expect(report.analysisReason).toBe('irreversible_steps');
  });

  it('a capability with no declared outputs is refused: output equality would compare nothing', async () => {
    // The reviewer's "update mobile phone" shape: select a slot, type, Save -- no outputs.
    const cap = wrongTurnCapability((c) => {
      c.outputs = {};
      c.steps = c.steps.slice(0, 3);
    });
    const { runTrial, calls } = fakeTrial({ required: ['s01'], outputs: {} });
    const { capability, report } = await optimizeCapability(cap, { runTrial });
    expect(calls).toHaveLength(0);
    expect(capability).toBe(cap);
    expect(report.analysisReason).toBe('no_outputs');
  });

  it('a caller veto (e.g. a risk-judge raise) downgrades to analysis-only', async () => {
    const { runTrial, calls } = fakeTrial({ required: ['s01', 's03', 's04'], outputs: { balance: 310 } });
    const { report } = await optimizeCapability(wrongTurnCapability(), { runTrial, vetoStep: (s) => (s.id === 's02' ? 'risk raised by the risk judge' : undefined) });
    expect(calls).toHaveLength(0);
    expect(report.analysisReason).toBe('vetoed');
    expect(report.vetoes).toEqual([{ stepId: 's02', reason: 'risk raised by the risk judge' }]);
  });
});

describe('optimizeCapability: collapse (replay-verified)', () => {
  it('collapses s04 into s03 on the read-only shipped artifact, keeping the checkpoint and the ids, once replays confirm it', async () => {
    const { runTrial } = fakeTrial({ required: SHIPPED_REQUIRED, outputs: SHIPPED_OUTPUTS });
    const cap = readOnlyShipped();
    const { capability, report } = await optimizeCapability(cap, { runTrial, verifyRuns: 2, maxTrials: 0 });

    expect(report.stop).toBe('completed');
    expect(report.changes).toEqual([{ kind: 'collapsed_repeat', stepId: 's04', into: 's03', name: 'Enter the operator password' }]);
    expect(capability.steps.map((s) => s.id)).toEqual(['s01', 's02', 's03', 's05', 's06', 's07', 's08', 's09', 's10']);
    expect(capability.steps.find((s) => s.id === 's03')!.postcondition).toEqual(cap.steps.find((s) => s.id === 's04')!.postcondition);
    expect(capability.status).toBe('draft');
    expect(capability.readOnly).toBe(true);
    expect(capability.provenance.notes).toContain('collapsed s04 into s03');
    expect(validateCapability(capability).ok).toBe(true);
    expect(cap.steps).toHaveLength(10);
  });

  it('does not keep a collapse the replays contradict (the first write did not stick)', async () => {
    const { runTrial } = fakeTrial({ required: ['s04', ...SHIPPED_REQUIRED], outputs: SHIPPED_OUTPUTS });
    const { capability, report } = await optimizeCapability(readOnlyShipped(), { runTrial, verifyRuns: 1, maxTrials: 0 });
    expect(report.changed).toBe(false);
    expect(capability.steps.some((s) => s.id === 's04')).toBe(true);
    expect(report.notes.join('\n')).toContain('collapse rewrite did not reproduce the baseline');
  });

  it('bumps the patch version only when asked', async () => {
    const make = () => fakeTrial({ required: SHIPPED_REQUIRED, outputs: SHIPPED_OUTPUTS }).runTrial;
    expect((await optimizeCapability(readOnlyShipped(), { runTrial: make(), verifyRuns: 1, maxTrials: 0 })).capability.version).toBe('1.2.2');
    expect((await optimizeCapability(readOnlyShipped(), { runTrial: make(), verifyRuns: 1, maxTrials: 0, bumpVersion: true })).capability.version).toBe('1.2.3');
  });

  it('never proposes collapsing a click, a type without clear, or a type that presses Enter', async () => {
    const cap = wrongTurnCapability();
    const dupClick = { ...cap, steps: [cap.steps[0]!, cap.steps[2]!, { ...cap.steps[2]!, id: 's05' }, cap.steps[3]!] };
    expect((await optimizeCapability(validateOrThrow(dupClick), { analyzeOnly: true })).report.analysis.redundantRepeats).toEqual([]);

    const typeStep = (id: string, extra: Record<string, unknown>): Step =>
      ({ id, name: 'Type', action: { type: 'type', target: target('field', 'Field'), value: { kind: 'literal', value: 'x' }, ...extra }, risk: 'reversible' }) as Step;
    for (const extra of [{}, { clear: false }, { clear: true, pressEnter: true }]) {
      const c = { ...cap, steps: [cap.steps[0]!, typeStep('s05', extra), typeStep('s06', extra), cap.steps[3]!] };
      expect((await optimizeCapability(validateOrThrow(c), { analyzeOnly: true })).report.analysis.redundantRepeats, JSON.stringify(extra)).toEqual([]);
    }
    const ok = { ...cap, steps: [cap.steps[0]!, typeStep('s05', { clear: true }), typeStep('s06', { clear: true }), cap.steps[3]!] };
    expect((await optimizeCapability(validateOrThrow(ok), { analyzeOnly: true })).report.analysis.redundantRepeats).toHaveLength(1);
  });

  it('does not collapse a repeat whose step a tenant override references', async () => {
    const { runTrial } = fakeTrial({ required: SHIPPED_REQUIRED, outputs: SHIPPED_OUTPUTS });
    const cap = readOnlyShipped((c) => c.overrides![0]!.stepPatches.push({ stepId: 's04' }));
    const { report } = await optimizeCapability(cap, { runTrial, verifyRuns: 1, maxTrials: 0 });
    expect(report.changes.filter((c) => c.kind === 'collapsed_repeat')).toEqual([]);
  });
});

describe('optimizeCapability: vacuity probe', () => {
  it('drops the postconditions that already held before their step (s02, merged s03) and reports the tenant probed', async () => {
    const { runTrial } = fakeTrial({ required: SHIPPED_REQUIRED, outputs: SHIPPED_OUTPUTS, preHeld: { s02: true, s03: true } });
    const { capability, report } = await optimizeCapability(readOnlyShipped(), { runTrial, verifyRuns: 2 });

    expect(report.stop).toBe('completed');
    expect(report.changes.filter((c) => c.kind === 'dropped_vacuous_postcondition').map((c) => c.stepId)).toEqual(['s02', 's03']);
    for (const id of ['s02', 's03']) expect(capability.steps.find((s) => s.id === id)!.postcondition).toBeUndefined();
    expect(capability.steps.some((s) => s.id === 's04')).toBe(false);
    expect(capability.steps.find((s) => s.id === 's07')!.postcondition).toBeDefined();
    expect(capability.steps.find((s) => s.id === 's08')!.postcondition).toBeDefined();
    expect(report.probedTenant).toBe('base');
    expect(capability.provenance.notes).toContain('tenant: base');
  });

  it('never drops a vacuous checkpoint on a step a tenant override references', async () => {
    const cap = readOnlyShipped((c) => {
      c.steps.find((s) => s.id === 's06')!.postcondition = { kind: 'text_visible', text: 'Member', frame: [{ name: 'main' }] };
    });
    const { runTrial } = fakeTrial({ required: SHIPPED_REQUIRED, outputs: SHIPPED_OUTPUTS, preHeld: { s06: true } });
    const { capability, report } = await optimizeCapability(cap, { runTrial, verifyRuns: 1, tenant: 'riverbend-fcu' });
    expect(capability.steps.find((s) => s.id === 's06')!.postcondition).toBeDefined();
    expect(report.kept).toContainEqual({ stepId: 's06', reason: 'override_reference', what: 'postcondition' });
    expect(report.probedTenant).toBe('riverbend-fcu');
  });

  it('keeps a vacuous checkpoint whose removal would add a validator warning (the only input-bound check)', async () => {
    const cap = readOnlyShipped((c) => {
      c.success.condition = { kind: 'text_visible', text: 'Savings Balance', frame: [{ name: 'main' }] };
    });
    const { runTrial } = fakeTrial({ required: SHIPPED_REQUIRED, outputs: SHIPPED_OUTPUTS, preHeld: { s08: true } });
    const { capability, report } = await optimizeCapability(cap, { runTrial, verifyRuns: 1 });
    expect(capability.steps.find((s) => s.id === 's08')!.postcondition).toBeDefined();
    expect(report.kept).toContainEqual({ stepId: 's08', reason: 'weakens_validation', what: 'postcondition' });
  });

  it('falls back to the unchanged input when a dropped checkpoint turns out not to hold before its step on a verification run', async () => {
    const { runTrial } = fakeTrial({ required: SHIPPED_REQUIRED, outputs: SHIPPED_OUTPUTS, preHeld: { s02: (call) => call === 1 } });
    const cap = readOnlyShipped();
    const { capability, report } = await optimizeCapability(cap, { runTrial, verifyRuns: 2, maxTrials: 0 });
    expect(report.verification!.attempts[0]!.failure).toContain('s02');
    expect(report.verification!.kept).toBe('unchanged');
    expect(capability).toBe(cap);
  });
});

describe('optimizeCapability: replay-verified removal', () => {
  it('removes a successful wrong turn (a click on the wrong tab) and keeps the steps the outputs depend on', async () => {
    const { runTrial } = fakeTrial({ required: ['s01', 's03', 's04'], outputs: { balance: 310 } });
    const { capability, report } = await optimizeCapability(wrongTurnCapability(), { runTrial, verifyRuns: 3 });
    expect(capability.steps.map((s) => s.id)).toEqual(['s01', 's03', 's04']);
    expect(report.changes).toEqual([{ kind: 'removed_step', stepId: 's02', name: 'Open the Notes tab', actionType: 'click' }]);
    expect(report.verification!.kept).toBe('search');
    expect(report.verification!.attempts).toEqual([{ candidate: 'search', passed: 3 }]);
    expect(capability.status).toBe('draft');
    expect(capability.provenance.notes).toContain('removed s02');
    expect(capability.provenance.notes).toContain(`${report.trialsUsed} trial replay(s). Steps 4 -> 3.`);
    expect(capability.provenance.notes).toContain('Verified by 3/3 consecutive replays');
  });

  it('rejects a removal that still succeeds but changes the outputs', async () => {
    const { runTrial } = fakeTrial({ required: ['s01', 's04'], outputs: (p) => ({ balance: p.has('s03') ? 310 : 99 }) });
    const { capability, report } = await optimizeCapability(wrongTurnCapability(), { runTrial, verifyRuns: 1 });
    expect(capability.steps.some((s) => s.id === 's03')).toBe(true);
    expect(report.rejected.find((r) => r.stepId === 's03')!.reason).toContain('outputs differ');
    expect(report.trials.find((t) => t.label === 'remove s03')!.outputsMatch).toBe(false);
  });

  it('never tries to remove the extract that produces an output', async () => {
    const { runTrial, calls } = fakeTrial({ required: ['s01', 's03', 's04'], outputs: { balance: 310 } });
    const { capability, report } = await optimizeCapability(wrongTurnCapability(), { runTrial, verifyRuns: 1 });
    expect(capability.steps.some((s) => s.id === 's04')).toBe(true);
    expect(report.kept).toContainEqual({ stepId: 's04', reason: 'last_extract', what: 'step' });
    expect(calls.some((c) => c.label === 'remove s04')).toBe(false);
  });

  it('never tries to remove the last step that consumes a declared input', async () => {
    // s02 types the member id, but the fake says the run does not need it: output equality on one
    // input set cannot see that the capability would stop looking the input up at all.
    const cap = wrongTurnCapability((c) => {
      c.inputs = { memberId: { type: 'string', description: 'id', required: true, sensitive: false } };
      c.steps[1] = { id: 's02', name: 'Enter the member id', action: { type: 'type', target: target('field', 'Member ID'), value: { kind: 'input', name: 'memberId' }, clear: true }, risk: 'reversible' };
      c.success = { condition: { kind: 'url_matches', pattern: '/members/{input.memberId}' }, description: 'on the member' };
    });
    const { runTrial, calls } = fakeTrial({ required: ['s01', 's03', 's04'], outputs: { balance: 310 } });
    const { capability, report } = await optimizeCapability(cap, { runTrial, verifyRuns: 1 });
    expect(capability.steps.some((s) => s.id === 's02')).toBe(true);
    expect(report.kept).toContainEqual({ stepId: 's02', reason: 'last_input_use', what: 'step' });
    expect(calls.some((c) => c.label === 'remove s02')).toBe(false);
  });

  it('never removes a step a tenant override or a business outcome references, and says overrides were not trialled', async () => {
    const { runTrial, calls } = fakeTrial({ required: SHIPPED_REQUIRED, outputs: SHIPPED_OUTPUTS });
    const { capability, report } = await optimizeCapability(readOnlyShipped(), { runTrial, verifyRuns: 1 });
    for (const id of ['s06', 's07', 's08']) expect(capability.steps.some((s) => s.id === id)).toBe(true);
    expect(report.kept).toContainEqual({ stepId: 's06', reason: 'override_reference', what: 'step' });
    expect(report.kept).toContainEqual({ stepId: 's07', reason: 'outcome_reference', what: 'step' });
    for (const id of ['s06', 's07', 's08']) expect(calls.some((c) => c.label === `remove ${id}`)).toBe(false);
    expect(report.notes.join('\n')).toContain('riverbend-fcu');
  });

  it('respects maxTrials', async () => {
    const { runTrial, calls } = fakeTrial({ required: ['s01', 's04'], outputs: { balance: 310 } });
    const { report } = await optimizeCapability(wrongTurnCapability(), { runTrial, maxTrials: 1, verifyRuns: 1 });
    expect(report.removalTrialsUsed).toBe(1);
    expect(report.budgetExhausted).toBe(true);
    expect(calls.filter((c) => c.purpose === 'removal')).toHaveLength(1);
  });

  it('iterates to a fixpoint: a step that only becomes removable after another removal is retried', async () => {
    // Removing s02 fails while s03 is still there; s03 is removable. Pass 1 rejects s02 and then
    // removes s03; pass 2 retries s02 (something changed since it failed) and removes it.
    const { runTrial } = fakeTrial({
      required: ['s01', 's04'],
      outputs: { balance: 310 },
      outcomeOf: (_call, req, present) => (req.purpose === 'removal' && !present.has('s02') && present.has('s03') ? { kind: 'hard_failure', detail: 'needs s03 gone first' } : undefined),
    });
    const { capability, report } = await optimizeCapability(wrongTurnCapability(), { runTrial, verifyRuns: 1 });
    expect(capability.steps.map((s) => s.id)).toEqual(['s01', 's04']);
    expect(report.trials.filter((t) => t.label === 'remove s02')).toHaveLength(2);
  });
});

describe('optimizeCapability: trial safety and reporting', () => {
  it('replays only draft trial copies with a prerelease version, never the real version', async () => {
    const { runTrial, calls } = fakeTrial({ required: ['s01', 's03', 's04'], outputs: { balance: 310 } });
    await optimizeCapability(wrongTurnCapability(), { runTrial, verifyRuns: 1 });
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.capability.status).toBe('draft');
      expect(c.capability.version).toMatch(/^1\.0\.0-optimize\.\d+$/);
    }
  });

  it('counts an escalated trial as a failed trial', async () => {
    const { runTrial } = fakeTrial({
      required: ['s01', 's04'],
      outputs: { balance: 310 },
      outcomeOf: (_c, req) => (req.label === 'remove s02' ? { kind: 'escalated', detail: 'unexpected_dialog' } : undefined),
    });
    const { capability, report } = await optimizeCapability(wrongTurnCapability(), { runTrial, verifyRuns: 1 });
    expect(capability.steps.some((s) => s.id === 's02')).toBe(true);
    expect(report.rejected.find((r) => r.stepId === 's02')!.reason).toContain('escalated');
  });

  it('stops after the baseline when the unmodified capability does not succeed, rewriting nothing', async () => {
    const { runTrial, calls } = fakeTrial({ required: ['nope'], outputs: SHIPPED_OUTPUTS });
    const cap = readOnlyShipped();
    const { capability, report } = await optimizeCapability(cap, { runTrial });
    expect(calls).toHaveLength(1);
    expect(report.stop).toBe('baseline_failed');
    expect(capability).toBe(cap);
  });

  it('stops after the baseline when it disagrees with the reference (discovery) outputs', async () => {
    const { runTrial, calls } = fakeTrial({ required: SHIPPED_REQUIRED, outputs: SHIPPED_OUTPUTS });
    const { report } = await optimizeCapability(readOnlyShipped(), { runTrial, referenceOutputs: { ...SHIPPED_OUTPUTS, savingsBalance: 1 } });
    expect(calls).toHaveLength(1);
    expect(report.stop).toBe('baseline_mismatch');
    expect(report.baseline!.matchesReference).toBe(false);
    expect(report.stopDetail).toContain('savingsBalance');
  });

  it('the report holds output NAMES and verdicts, never output values; the values come back only in memory', async () => {
    const { runTrial } = fakeTrial({ required: SHIPPED_REQUIRED, outputs: SHIPPED_OUTPUTS, preHeld: { s02: true } });
    const result = await optimizeCapability(readOnlyShipped(), { runTrial, verifyRuns: 1, referenceOutputs: SHIPPED_OUTPUTS });
    const text = JSON.stringify(result.report) + (result.capability.provenance.notes ?? '');
    expect(text).not.toContain('Jane Q. Sample');
    expect(text).not.toContain('1234.56');
    expect(result.report.baseline).toMatchObject({ kind: 'success', outputNames: ['savingsBalance', 'memberName'], matchesReference: true, runId: 'run_1' });
    expect(result.baselineOutputs).toEqual(SHIPPED_OUTPUTS);
  });

  it('pauses trialDelayMs between trials (not before the first)', async () => {
    const sleeps: number[] = [];
    const { runTrial, calls } = fakeTrial({ required: ['s01', 's03', 's04'], outputs: { balance: 310 } });
    await optimizeCapability(wrongTurnCapability(), {
      runTrial,
      verifyRuns: 1,
      trialDelayMs: 250,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(sleeps).toHaveLength(calls.length - 1);
    expect(sleeps.every((ms) => ms === 250)).toBe(true);
  });

  it('stops starting trials once the abort signal fires, and returns the input unchanged', async () => {
    const controller = new AbortController();
    const { runTrial: inner, calls } = fakeTrial({ required: ['s01', 's03', 's04'], outputs: { balance: 310 } });
    const runTrial: RunTrial = async (req) => {
      const out = await inner(req);
      if (calls.length === 2) controller.abort();
      return out;
    };
    const cap = wrongTurnCapability();
    const { capability, report } = await optimizeCapability(cap, { runTrial, verifyRuns: 3, signal: controller.signal });
    expect(calls).toHaveLength(2);
    expect(report.stop).toBe('aborted');
    expect(capability).toBe(cap);
  });
});

describe('optimizeCapability: verification and fallback', () => {
  it('falls back to the starting point when the search result does not verify', async () => {
    const { runTrial } = fakeTrial({
      required: ['s01', 's03', 's04'],
      outputs: { balance: 310 },
      outcomeOf: (_c, req, present) => (req.label === 'verify search 2/3' && !present.has('s02') ? { kind: 'hard_failure', detail: 'timeout' } : undefined),
    });
    const w: Step = {
      id: 's05',
      name: 'Type note',
      action: { type: 'type', target: target('note', 'Note'), value: { kind: 'literal', value: 'x' }, clear: true },
      risk: 'reversible',
    };
    const cap = wrongTurnCapability((c) => {
      c.steps = [c.steps[0]!, c.steps[1]!, w, { ...w, id: 's06' }, c.steps[2]!, c.steps[3]!];
    });
    const { capability, report } = await optimizeCapability(cap, { runTrial, verifyRuns: 3 });
    expect(report.verification!.attempts.map((a) => [a.candidate, a.passed])).toEqual([
      ['search', 1],
      ['start', 3],
    ]);
    expect(report.verification!.kept).toBe('start');
    expect(capability.steps.map((s) => s.id)).toEqual(['s01', 's02', 's05', 's03', 's04']);
  });

  it('returns the input unchanged when nothing verifies (no unverified floor)', async () => {
    const { runTrial } = fakeTrial({
      required: SHIPPED_REQUIRED,
      outputs: SHIPPED_OUTPUTS,
      preHeld: { s02: true, s03: true },
      outcomeOf: (_c, req) => (req.purpose === 'verify' ? { kind: 'hard_failure', detail: 'flaky' } : undefined),
    });
    const cap = readOnlyShipped();
    const { capability, report } = await optimizeCapability(cap, { runTrial, verifyRuns: 2 });
    expect(report.verification!.kept).toBe('unchanged');
    expect(report.changed).toBe(false);
    expect(capability).toBe(cap);
  });

  it('returns the input untouched when there is nothing to change', async () => {
    const cap = wrongTurnCapability();
    const { runTrial } = fakeTrial({ required: ['s01', 's02', 's03', 's04'], outputs: { balance: 310 } });
    const { capability, report } = await optimizeCapability(cap, { runTrial, bumpVersion: true });
    expect(report.changed).toBe(false);
    expect(capability).toBe(cap);
    expect(report.versionAfter).toBe('1.0.0');
  });
});

describe('optimizeCapability: the stop detail is the report\'s line, printed once', () => {
  // A caller prints two things: the optimizer's progress (`log`) and the summary of its report
  // (`summarizeOptimization`). The stop detail used to be in both, so `cu optimize` and the
  // optimizer stage of `discover` printed it twice.
  const succeeding = (): ReturnType<typeof fakeTrial> => fakeTrial({ required: SHIPPED_REQUIRED, outputs: SHIPPED_OUTPUTS });
  const failing = (): ReturnType<typeof fakeTrial> => fakeTrial({ required: SHIPPED_REQUIRED, outputs: SHIPPED_OUTPUTS, outcomeOf: () => ({ kind: 'hard_failure', detail: 'element_not_found at s06' }) });
  const abortedSignal = (): AbortSignal => {
    const controller = new AbortController();
    controller.abort();
    return controller.signal;
  };

  it.each([
    ['analysis_only', (): Capability => loadShipped(), succeeding, {}],
    ['baseline_failed', (): Capability => readOnlyShipped(), failing, {}],
    ['baseline_mismatch', (): Capability => readOnlyShipped(), succeeding, { referenceOutputs: { ...SHIPPED_OUTPUTS, savingsBalance: 1 } }],
    ['aborted', (): Capability => readOnlyShipped(), succeeding, { signal: abortedSignal() }],
  ] as const)('%s: not logged, and in the summary exactly once', async (stop, cap, trials, extra) => {
    const logged: string[] = [];
    const { report } = await optimizeCapability(cap(), { runTrial: trials().runTrial, log: (l) => logged.push(l), ...extra });
    expect(report.stop).toBe(stop);
    expect(report.stopDetail).toBeDefined();
    const line = `optimize: ${report.stopDetail}`;
    expect(logged).not.toContain(line);
    const printed = [...logged, ...summarizeOptimization(report)];
    expect(printed.filter((l) => l === line)).toHaveLength(1);
    expect(new Set(printed).size).toBe(printed.length);
  });
});

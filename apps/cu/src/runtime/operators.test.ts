/**
 * The relogin operator's hand-back rule (decideReloginHandBack): after re-login it asks replay to
 * resume at the first step after the sign-in, wherever the expiry surfaced. The e2e counterparts
 * are tests/e2e/replay-handoff-policy.test.ts and tests/e2e/replay-chaos.test.ts; the refusal path
 * is in operators.relogin.test.ts. Also: the approve-mode operator's answer to a
 * risky_action_confirmation, with and without `approveRiskyActions`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeSurface, scenario } from '@cu/core/surface';
import { createRunLogger, newRunId } from '@cu/core/evidence';
import { createSessionBroker } from '@cu/core/session';
import { resolveAuth, type Capability, type Step } from '@cu/core/schema';
import { attachAutoOperator, decideReloginHandBack, effectiveCapability } from './operators.js';

const BASE = 'http://localhost:4173';
const EXAMPLE: unknown = JSON.parse(fs.readFileSync('artifacts/examples/lookup-member-savings-balance.example.json', 'utf8'));
const RECORDED: unknown = JSON.parse(fs.readFileSync('artifacts/lookup-member-savings-balance.json', 'utf8'));

/** A FakeSurface parked on one page at `path` (no elements: only url checkpoints are evaluated here). */
function surfaceAt(path: string): FakeSurface {
  return new FakeSurface(scenario().screen('page', { url: `${BASE}${path}`, title: 'page', elements: [] }).build());
}

/** The capability as the run sees it and its sign-in steps (explicit block or derived). */
function signInOf(capability: unknown): { cap: Capability; signIn: Step[] } {
  const cap = effectiveCapability({ capability, inputs: {} });
  if (!cap) throw new Error('capability does not validate');
  const auth = resolveAuth(cap);
  if (!auth) throw new Error('capability has no sign-in');
  return { cap, signIn: auth.steps };
}

/** Every note the rule can write names step ids only: nothing typed, no input, no credential. */
function expectValueFree(reason: string): void {
  expect(reason).not.toMatch(/12345|operator1|demo-pass|MOCK_/);
}

describe('decideReloginHandBack: resume at the first step after the sign-in', () => {
  it('failing step inside the sign-in (the example\'s expiry on its sign-on click, s04): continues after it, at s05', () => {
    const { cap, signIn } = signInOf(EXAMPLE);
    expect(signIn.map((s) => s.id)).toEqual(['s01', 's02', 's03', 's04']);
    const d = decideReloginHandBack(cap, signIn, 's04');
    expect(d).toMatchObject({ resumeFrom: 'current_step', resumeAtStepId: 's05' });
    expect(d.reason).toContain('sign-in step s04');
    expectValueFree(d.reason);
    // Earlier in the sign-in too: the re-login re-ran all of it, so the rest is not re-run.
    expect(decideReloginHandBack(cap, signIn, 's02')).toMatchObject({ resumeFrom: 'current_step', resumeAtStepId: 's05' });
  });

  it('failing step after the sign-in (the recorded artifact\'s expiry on typing the member id, or on the search click): rewinds to the first step after the sign-in', () => {
    const { cap, signIn } = signInOf(RECORDED);
    expect(signIn.map((s) => s.id)).toEqual(['s01', 's02', 's03', 's04', 's05']);
    const typing = cap.steps.find((st) => st.action.type === 'type' && st.action.value.kind === 'input' && st.action.value.name === 'memberId');
    expect(typing?.id).toBe('s06');
    // Typing the member id: the resume point is the failing step itself.
    expect(decideReloginHandBack(cap, signIn, 's06')).toMatchObject({ resumeFrom: 'current_step', resumeAtStepId: 's06' });
    // The search click (the chaos repro): NOT a retry of s07, whose member id went with the expired page.
    const d = decideReloginHandBack(cap, signIn, 's07');
    expect(d).toMatchObject({ resumeFrom: 'current_step', resumeAtStepId: 's06' });
    expect(d.reason).toContain('the expiry hit s07');
    expectValueFree(d.reason);
  });

  it('a stepless escalation (the final success check): the same rewind', () => {
    const { cap, signIn } = signInOf(RECORDED);
    const d = decideReloginHandBack(cap, signIn, undefined);
    expect(d).toMatchObject({ resumeFrom: 'current_step', resumeAtStepId: 's06' });
    expect(d.reason).toContain('final success check');
  });

  it('the tenant override\'s capability: the resume point is a step of the run as the tenant executes it', () => {
    const raw = structuredClone(RECORDED) as { overrides: { tenant: string; extraSteps?: { afterStepId: string; step: Step }[] }[] };
    const extra: Step = { id: 's05b', name: 'wait for the workstation', action: { type: 'wait', condition: { kind: 'url_matches', pattern: '/workstation' } }, risk: 'read' };
    raw.overrides[0]!.extraSteps = [{ afterStepId: 's05', step: extra }];
    const cap = effectiveCapability({ capability: raw, inputs: {}, tenant: raw.overrides[0]!.tenant })!;
    const auth = resolveAuth(cap)!;
    expect(decideReloginHandBack(cap, auth.steps, 's07').resumeAtStepId).toBe('s05b');
  });

  it('a capability that only signs in: nothing to resume at, next_step', () => {
    const { cap, signIn } = signInOf(EXAMPLE);
    const only = { steps: cap.steps.slice(0, signIn.length) };
    expect(decideReloginHandBack(only, signIn, 's04')).toEqual({ resumeFrom: 'next_step', reason: 'no step follows the sign-in' });
  });
});

describe('effectiveCapability', () => {
  it('is undefined without a replay or a valid artifact', () => {
    expect(effectiveCapability(undefined)).toBeUndefined();
    expect(effectiveCapability({ capability: { not: 'a capability' }, inputs: {} })).toBeUndefined();
  });

  it("holds a tenant override's extra step only when that tenant is applied", () => {
    const cap = structuredClone(RECORDED) as { overrides: { tenant: string; extraSteps?: { afterStepId: string; step: Step }[] }[] };
    const extra: Step = { id: 's04b', name: 'dismiss the banner', action: { type: 'wait', condition: { kind: 'url_matches', pattern: '/workstation$' } }, risk: 'read' };
    cap.overrides[0]!.extraSteps = [{ afterStepId: 's04', step: extra }];
    expect(effectiveCapability({ capability: cap, inputs: {}, tenant: cap.overrides[0]!.tenant })?.steps.some((s) => s.id === 's04b')).toBe(true);
    expect(effectiveCapability({ capability: cap, inputs: {} })?.steps.some((s) => s.id === 's04b')).toBe(false);
  });
});

describe('attachAutoOperator: approve mode and risky_action_confirmation', () => {
  async function resolveRiskyEscalation(approveRiskyActions: boolean | undefined): Promise<string> {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'operators-test-'));
    const runId = newRunId();
    const logger = createRunLogger({ runId, runKind: 'discovery', rootDir });
    const broker = createSessionBroker({ surface: surfaceAt('/transfer'), logger, runId, runKind: 'discovery' });
    const op = attachAutoOperator(broker, 'approve', { baseUrl: BASE, ...(approveRiskyActions !== undefined ? { approveRiskyActions } : {}) });
    try {
      const resolution = await broker.escalate({
        runId,
        runKind: 'discovery',
        stepId: 's01',
        reason: { code: 'risky_action_confirmation', message: 'click on "Confirm Transfer"' },
        screenshotPng: Buffer.alloc(0),
        currentUrl: `${BASE}/transfer`,
      });
      return resolution.resumeFrom;
    } finally {
      op?.stop();
      await op?.idle();
      broker.dispose();
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  }

  it('approves it (next_step) by default', async () => {
    expect(await resolveRiskyEscalation(undefined)).toBe('next_step');
  });

  it('aborts it when approveRiskyActions is false', async () => {
    expect(await resolveRiskyEscalation(false)).toBe('abort');
  });
});

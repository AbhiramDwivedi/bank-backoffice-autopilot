/**
 * A template that cannot be bound at run time (an optional input the caller left out, referenced
 * from a detector, a recovery trigger, an outcome extract target or the success condition) ends
 * the run as a step-level `internal` failure with evidence, never as an escaped exception; and a
 * deprecated capability never runs at all.
 */
import { describe, expect, it } from 'vitest';
import { validateCapability, type Capability } from '../schema/index.js';
import { loadExample, runReplay, wrapSurface } from './test-helpers.js';
import { createCuCoreSurface } from '../surface/fake-scenarios/cu-core.js';

/** The example capability with an optional `branch` input declared, after `mutate` has placed a
 *  `{input.branch}` placeholder somewhere; validated, so the placeholder is a declared one. */
function withOptionalBranch(mutate: (cap: Capability) => void): Capability {
  const cap = structuredClone(loadExample());
  cap.inputs.branch = { type: 'string', description: 'Optional branch code.', required: false, sensitive: false };
  mutate(cap);
  const validated = validateCapability(cap);
  if (!validated.ok) throw new Error(JSON.stringify(validated.issues));
  return validated.capability;
}

describe('replay: unbound placeholders fail the step, with evidence', () => {
  it('a business-outcome detector referencing an omitted optional input fails that step as internal', async () => {
    const capability = withOptionalBranch((cap) => {
      const outcome = cap.businessOutcomes.find((o) => o.name === 'member_not_found')!;
      outcome.detector = { kind: 'text_visible', text: 'No records found for {input.branch}.' };
    });

    const { result, events } = await runReplay({ capability });

    expect(result.kind).toBe('hard_failure');
    if (result.kind !== 'hard_failure') throw new Error('expected hard_failure');
    expect(result.code).toBe('internal');
    expect(result.stepId).toBe('s06');
    expect(result.message).toContain('{input.branch}');
    expect(result.expected).toContain('fully bindable');
    expect(result.evidence.screenshot).toBeDefined();
    expect(events.some((e) => e.kind === 'error' && e.stepId === 's06')).toBe(true);
  });

  it('a recovery trigger referencing an omitted optional input fails the first step as internal', async () => {
    const capability = withOptionalBranch((cap) => {
      cap.recoveryRules[0]!.trigger = { kind: 'text_visible', text: 'Notice for {input.branch}' };
    });

    const { result } = await runReplay({ capability });

    expect(result.kind).toBe('hard_failure');
    if (result.kind !== 'hard_failure') throw new Error('expected hard_failure');
    expect(result.code).toBe('internal');
    expect(result.stepId).toBe('s01');
    expect(result.message).toContain('{input.branch}');
    expect(result.evidence.screenshot).toBeDefined();
  });

  it('an outcome extract target referencing an omitted optional input is reported as missing, not thrown', async () => {
    const capability = withOptionalBranch((cap) => {
      const outcome = cap.businessOutcomes.find((o) => o.name === 'access_denied')!;
      outcome.extract![0]!.target = { ...outcome.extract![0]!.target, description: 'Denied message for {input.branch}' };
    });

    const { result, events } = await runReplay({ capability, inputs: { memberId: '90001' } });

    expect(result.kind).toBe('business_outcome');
    if (result.kind !== 'business_outcome') throw new Error('expected business_outcome');
    expect(result.name).toBe('access_denied');
    expect(result.missing).toEqual(['message']);
    expect(events.some((e) => e.kind === 'error' && e.data.outcome === 'access_denied' && e.data.code === 'internal')).toBe(true);
  });

  it('a success condition referencing an omitted optional input fails as internal with no stepId', async () => {
    const capability = withOptionalBranch((cap) => {
      cap.success = { ...cap.success, condition: { kind: 'text_visible', text: 'Branch {input.branch}' } };
    });

    const { result } = await runReplay({ capability });

    expect(result.kind).toBe('hard_failure');
    if (result.kind !== 'hard_failure') throw new Error('expected hard_failure');
    expect(result.code).toBe('internal');
    expect(result.stepId).toBeUndefined();
    expect(result.message).toContain('{input.branch}');
    expect(result.stepsExecuted).toBe(capability.steps.length);
    expect(result.evidence.screenshot).toBeDefined();
  });

  it('the same capability succeeds once the optional input is supplied', async () => {
    const capability = withOptionalBranch((cap) => {
      const outcome = cap.businessOutcomes.find((o) => o.name === 'member_not_found')!;
      outcome.detector = { kind: 'text_visible', text: 'No records found for {input.branch}.' };
    });
    const { result } = await runReplay({ capability, inputs: { memberId: '12345', branch: 'B01' } });
    expect(result.kind).toBe('success');
  });
});

describe('replay: capability status', () => {
  it('refuses a deprecated capability before any surface action', async () => {
    const capability = structuredClone(loadExample());
    capability.status = 'deprecated';
    const wrapped = wrapSurface(createCuCoreSurface());

    const { result, events } = await runReplay({ capability, surface: wrapped.surface });

    expect(result.kind).toBe('hard_failure');
    if (result.kind !== 'hard_failure') throw new Error('expected hard_failure');
    expect(result.code).toBe('policy_violation');
    expect(result.observed).toContain('deprecated');
    expect(result.stepsExecuted).toBe(0);
    expect(result.stepId).toBeUndefined();
    expect(wrapped.totalCalls()).toBe(0);
    expect(events.some((e) => e.kind === 'policy' && e.data.gate === 'status')).toBe(true);
  });

  it('refuses a deprecated capability even when approval is not required', async () => {
    const capability = structuredClone(loadExample());
    capability.status = 'deprecated';
    const { result } = await runReplay({ capability, replayRequiresApproved: false });
    expect(result.kind).toBe('hard_failure');
    if (result.kind === 'hard_failure') expect(result.code).toBe('policy_violation');
  });
});

/** Declared-output-missing after a human next_step, and describeResult. */
import { describe, expect, it } from 'vitest';
import { createCuCoreSurface } from '../surface/fake-scenarios/cu-core.js';
import { describeResult } from './index.js';
import { loadExample, makeFakeClock, makeScriptedEscalationHandler, runReplay } from './test-helpers.js';

describe('replay: declared output never extracted', () => {
  // validateCapability guarantees every declared output has a producing extract step, so on a
  // straight run this branch cannot fire. It CAN fire after a human-in-the-loop `next_step`: the
  // operator claims the extract step is done, replay skips it, and the output is missing at the
  // end. That must be a failure, not a success with a hole in `outputs`.
  it('next_step past an extract step ends resumed_failed with "declared output ... was never extracted"', async () => {
    const clock = makeFakeClock();
    const surface = createCuCoreSurface({ clock });
    surface.inject({ kind: 'hide_element', elementId: 'savingsBalance' });
    const cap = loadExample();
    const s09 = cap.steps.find((st) => st.id === 's09')!;
    s09.onFailure = 'escalate';
    const handler = makeScriptedEscalationHandler(undefined, { resumeFrom: 'next_step' });
    const { result, events } = await runReplay({ capability: cap, surface, clock, escalate: handler.escalate });
    expect(handler.requests).toHaveLength(1);
    expect(handler.requests[0]!.stepId).toBe('s09');
    expect(result).toMatchObject({ kind: 'escalated', resolution: 'resumed_failed' });
    const underlying = events.find((e) => e.kind === 'outcome' && 'underlying' in e.data)?.data.underlying as
      | { kind: string; code?: string; message?: string }
      | undefined;
    expect(underlying).toMatchObject({ kind: 'hard_failure', code: 'checkpoint_failed' });
    expect(underlying?.message).toMatch(/declared output "savingsBalance" was never extracted/);

    // The result's own `outcome` (not just the logged event) carries the same hard failure.
    if (result.kind === 'escalated') {
      expect(result.outcome).toMatchObject({ kind: 'hard_failure', code: 'checkpoint_failed' });
      expect((result.outcome as { message?: string } | undefined)?.message).toMatch(/declared output "savingsBalance" was never extracted/);
    }
  });
});

describe('replay: describeResult / summarizeLocatorDrift', () => {
  it('describes a success result mentioning outputs and the capability id', async () => {
    const { result } = await runReplay();
    const text = describeResult(result);
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain(result.capabilityId);
    expect(text).toMatch(/succeeded/);
    expect(text).toContain('Jane Q. Sample');
  });

  it('describes a business_outcome result mentioning the outcome name', async () => {
    const { result } = await runReplay({ inputs: { memberId: '99999' } });
    const text = describeResult(result);
    expect(text).toMatch(/member_not_found/);
  });

  it('describes a hard_failure result mentioning the failure code and step', async () => {
    const clock = makeFakeClock();
    const surface = createCuCoreSurface({ clock });
    surface.inject({ kind: 'hide_element', elementId: 'search' });
    const { result } = await runReplay({ surface, clock });
    const text = describeResult(result);
    expect(text).toMatch(/element_not_found/);
    expect(text).toMatch(/s06/);
  });

  it('describes an escalated result mentioning the resolution', async () => {
    const clock = makeFakeClock();
    const surface = createCuCoreSurface({ clock });
    surface.inject({ kind: 'hide_element', elementId: 'search' });
    const scripted = makeScriptedEscalationHandler(undefined, { resumeFrom: 'abort' });
    const { result } = await runReplay({ surface, clock, escalate: scripted.escalate, escalateOn: ['element_not_found'] });
    const text = describeResult(result);
    expect(text).toMatch(/escalated/);
    expect(text).toMatch(/abandoned/);
  });
});

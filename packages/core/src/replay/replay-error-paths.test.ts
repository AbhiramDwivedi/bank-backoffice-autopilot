/**
 * Replay error paths: the final success-condition check failing (with and without escalation), an
 * escalation handler that throws or rejects, and the maxEscalations cap.
 */
import { describe, expect, it } from 'vitest';
import { validateCapability, type Capability } from '../schema/index.js';
import type { EscalationHandler, EscalationResolution } from '../session/index.js';
import { createCuCoreSurface } from '../surface/fake-scenarios/cu-core.js';
import { loadExample, makeFakeClock, makeScriptedEscalationHandler, runReplay } from './test-helpers.js';
import { DEFAULT_MAX_ESCALATIONS } from './types.js';

/** The example capability with a success condition that never holds on any screen; every step
 *  still passes. */
function capabilityWithUnreachableSuccess(): Capability {
  const cap = structuredClone(loadExample());
  cap.success = {
    ...cap.success,
    condition: { kind: 'text_visible', text: 'This Text Never Appears On Any Screen', frame: [{ name: 'main' }] },
  };
  const validated = validateCapability(cap);
  if (!validated.ok) throw new Error(JSON.stringify(validated.issues));
  return validated.capability;
}

/** A surface on which s06's Search element is hidden for good, so s06 fails with
 *  element_not_found on every attempt. */
function surfaceWithSearchHidden(): { clock: ReturnType<typeof makeFakeClock>; surface: ReturnType<typeof createCuCoreSurface> } {
  const clock = makeFakeClock();
  const surface = createCuCoreSurface({ clock });
  surface.inject({ kind: 'hide_element', elementId: 'search' });
  return { clock, surface };
}

describe('replay: success condition never holds', () => {
  it('without a handler: hard_failure checkpoint_failed with no stepId', async () => {
    const { result, resultJson } = await runReplay({ capability: capabilityWithUnreachableSuccess() });

    expect(result.kind).toBe('hard_failure');
    if (result.kind !== 'hard_failure') throw new Error('expected hard_failure');
    expect(result.code).toBe('checkpoint_failed');
    expect(result).not.toHaveProperty('stepId');
    expect(result.message).toMatch(/success condition not met/);
    expect(result.stepsExecuted).toBe(loadExample().steps.length);
    expect(resultJson).toEqual(result);
  });

  it('with a handler that resumes (next_step) and then aborts: escalated/abandoned with a checkpoint_failed outcome', async () => {
    const scripted = makeScriptedEscalationHandler(undefined, (_req, index) => ({ resumeFrom: index === 0 ? 'next_step' : 'abort' }));

    const { result } = await runReplay({
      capability: capabilityWithUnreachableSuccess(),
      escalate: scripted.escalate,
      escalateOn: ['checkpoint_failed'],
    });

    expect(scripted.requests).toHaveLength(2);
    for (const req of scripted.requests) {
      expect(req).not.toHaveProperty('stepId');
      expect((req.context as { code?: string } | undefined)?.code).toBe('checkpoint_failed');
    }

    expect(result.kind).toBe('escalated');
    if (result.kind !== 'escalated') throw new Error('expected escalated');
    expect(result.resolution).toBe('abandoned');
    expect(result.interventionId).toBe('intv-2');
    expect(result).not.toHaveProperty('stepId');
    expect(result.outcome).toMatchObject({ kind: 'hard_failure', code: 'checkpoint_failed' });
    expect(result.outcome).not.toHaveProperty('stepId');
  });

  it('checkpoint_failed on the success check does not escalate unless it is in escalateOn', async () => {
    const scripted = makeScriptedEscalationHandler(undefined, { resumeFrom: 'next_step' });

    const { result } = await runReplay({ capability: capabilityWithUnreachableSuccess(), escalate: scripted.escalate });

    expect(scripted.requests).toHaveLength(0);
    expect(result.kind).toBe('hard_failure');
    if (result.kind !== 'hard_failure') throw new Error('expected hard_failure');
    expect(result.code).toBe('checkpoint_failed');
  });
});

describe('replay: escalation handler failures', () => {
  it('a handler that throws synchronously ends the run as hard_failure internal', async () => {
    const { clock, surface } = surfaceWithSearchHidden();
    let calls = 0;
    const escalate: EscalationHandler = () => {
      calls += 1;
      throw new Error('handler exploded');
    };

    const { result } = await runReplay({ surface, clock, escalate, escalateOn: ['element_not_found'] });

    expect(calls).toBe(1);
    expect(result.kind).toBe('hard_failure');
    if (result.kind !== 'hard_failure') throw new Error('expected hard_failure');
    expect(result.code).toBe('internal');
    expect(result.stepId).toBe('s06');
    expect(result.message).toBe('handler exploded');
    expect(result.observed).toBe('handler exploded');
    expect(result.expected).toBe('the escalation handler to resolve');
  });

  it('a handler that returns a rejected promise ends the run as hard_failure internal', async () => {
    const { clock, surface } = surfaceWithSearchHidden();
    let calls = 0;
    const escalate: EscalationHandler = () => {
      calls += 1;
      return Promise.reject(new Error('handler rejected'));
    };

    const { result } = await runReplay({ surface, clock, escalate, escalateOn: ['element_not_found'] });

    expect(calls).toBe(1);
    expect(result.kind).toBe('hard_failure');
    if (result.kind !== 'hard_failure') throw new Error('expected hard_failure');
    expect(result.code).toBe('internal');
    expect(result.stepId).toBe('s06');
    expect(result.message).toBe('handler rejected');
  });

  it('a handler that rejects with a non-Error value carries its string form as the message', async () => {
    const { clock, surface } = surfaceWithSearchHidden();
    const escalate: EscalationHandler = () => Promise.reject('operator console offline');

    const { result } = await runReplay({ surface, clock, escalate, escalateOn: ['element_not_found'] });

    expect(result.kind).toBe('hard_failure');
    if (result.kind !== 'hard_failure') throw new Error('expected hard_failure');
    expect(result.code).toBe('internal');
    expect(result.message).toBe('operator console offline');
  });

  it('a handler that throws on the success-condition escalation ends as hard_failure internal with no stepId', async () => {
    const escalate: EscalationHandler = (): Promise<EscalationResolution> => Promise.reject(new Error('handler exploded'));

    const { result } = await runReplay({ capability: capabilityWithUnreachableSuccess(), escalate, escalateOn: ['checkpoint_failed'] });

    expect(result.kind).toBe('hard_failure');
    if (result.kind !== 'hard_failure') throw new Error('expected hard_failure');
    expect(result.code).toBe('internal');
    expect(result).not.toHaveProperty('stepId');
  });
});

describe('replay: maxEscalations', () => {
  it('DEFAULT_MAX_ESCALATIONS is 3', () => {
    expect(DEFAULT_MAX_ESCALATIONS).toBe(3);
  });

  it('default cap: a step that keeps failing escalates DEFAULT_MAX_ESCALATIONS times, then the next failure hard-fails', async () => {
    const { clock, surface } = surfaceWithSearchHidden();
    const scripted = makeScriptedEscalationHandler(undefined, { resumeFrom: 'current_step' });

    const { result, events } = await runReplay({ surface, clock, escalate: scripted.escalate, escalateOn: ['element_not_found'] });

    expect(scripted.requests).toHaveLength(DEFAULT_MAX_ESCALATIONS);
    expect(scripted.requests.every((req) => req.stepId === 's06')).toBe(true);

    const raised = events.filter((e) => e.kind === 'escalation' && (e.data as { phase?: string }).phase === 'raised');
    expect(raised).toHaveLength(DEFAULT_MAX_ESCALATIONS);

    expect(result.kind).toBe('escalated');
    if (result.kind !== 'escalated') throw new Error('expected escalated');
    expect(result.resolution).toBe('resumed_failed');
    expect(result.interventionId).toBe(`intv-${DEFAULT_MAX_ESCALATIONS}`);
    expect(result.stepId).toBe('s06');
    expect(result.outcome).toMatchObject({ kind: 'hard_failure', code: 'element_not_found', stepId: 's06' });
  });

  it('maxEscalations: 1 escalates once, then the repeated failure hard-fails', async () => {
    const { clock, surface } = surfaceWithSearchHidden();
    const scripted = makeScriptedEscalationHandler(undefined, { resumeFrom: 'current_step' });

    const { result } = await runReplay({ surface, clock, escalate: scripted.escalate, escalateOn: ['element_not_found'], maxEscalations: 1 });

    expect(scripted.requests).toHaveLength(1);
    expect(result.kind).toBe('escalated');
    if (result.kind !== 'escalated') throw new Error('expected escalated');
    expect(result.resolution).toBe('resumed_failed');
    expect(result.outcome).toMatchObject({ kind: 'hard_failure', code: 'element_not_found', stepId: 's06' });
  });

  it('maxEscalations: 1 on the success check: one next_step re-check, then hard_failure checkpoint_failed', async () => {
    const scripted = makeScriptedEscalationHandler(undefined, { resumeFrom: 'next_step' });

    const { result } = await runReplay({
      capability: capabilityWithUnreachableSuccess(),
      escalate: scripted.escalate,
      escalateOn: ['checkpoint_failed'],
      maxEscalations: 1,
    });

    expect(scripted.requests).toHaveLength(1);
    expect(result.kind).toBe('escalated');
    if (result.kind !== 'escalated') throw new Error('expected escalated');
    expect(result.resolution).toBe('resumed_failed');
    expect(result).not.toHaveProperty('stepId');
    expect(result.outcome).toMatchObject({ kind: 'hard_failure', code: 'checkpoint_failed' });
    expect(result.outcome).not.toHaveProperty('stepId');
  });

  it('maxEscalations: 0 never calls the handler and returns a plain hard_failure', async () => {
    const { clock, surface } = surfaceWithSearchHidden();
    const scripted = makeScriptedEscalationHandler(undefined, { resumeFrom: 'current_step' });

    const { result } = await runReplay({ surface, clock, escalate: scripted.escalate, escalateOn: ['element_not_found'], maxEscalations: 0 });

    expect(scripted.requests).toHaveLength(0);
    expect(result.kind).toBe('hard_failure');
    if (result.kind !== 'hard_failure') throw new Error('expected hard_failure');
    expect(result.code).toBe('element_not_found');
    expect(result.stepId).toBe('s06');
  });
});

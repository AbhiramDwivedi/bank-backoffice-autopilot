/**
 * Input validation, a broken artifact ("internal"), the approval gate, and a PolicyGuardLike
 * stub's deny / flag_irreversible decisions.
 */
import { describe, expect, it } from 'vitest';
import { createCuCoreSurface } from '../surface/fake-scenarios/cu-core.js';
import { validateCapability } from '../schema/index.js';
import { loadExample, makeFakeClock, runReplay, wrapSurface } from './test-helpers.js';
import type { PolicyGuardLike } from './types.js';

describe('replay: input validation', () => {
  it('missing required memberId -> hard_failure input_validation, zero surface calls', async () => {
    const clock = makeFakeClock();
    const surface = createCuCoreSurface({ clock });

    const { result } = await runReplay({ surface, clock, inputs: {} });

    expect(result.kind).toBe('hard_failure');
    if (result.kind === 'hard_failure') {
      expect(result.code).toBe('input_validation');
      // Never touched the surface at all, so no blank screenshot/DOM is attached either.
      expect(result.evidence).toEqual({});
    }
    expect(surface.actionLog()).toEqual([]);
  });

  it('memberId not matching its pattern -> hard_failure input_validation, zero surface calls', async () => {
    const clock = makeFakeClock();
    const surface = createCuCoreSurface({ clock });

    const { result } = await runReplay({ surface, clock, inputs: { memberId: 'abc' } });

    expect(result.kind).toBe('hard_failure');
    if (result.kind === 'hard_failure') {
      expect(result.code).toBe('input_validation');
      expect(result.evidence).toEqual({});
    }
    expect(surface.actionLog()).toEqual([]);
  });

  it('an invalid sensitive input value never reaches the message, observed, events or result.json', async () => {
    const cap = structuredClone(loadExample());
    cap.inputs.pin = { type: 'string', description: 'A PIN, sensitive test input.', required: true, sensitive: true, pattern: '^[0-9]{4}$' };
    const validated = validateCapability(cap);
    if (!validated.ok) throw new Error(JSON.stringify(validated.issues));

    const clock = makeFakeClock();
    const surface = createCuCoreSurface({ clock });
    const INVALID_PIN = 'abcd';

    const { result, events, resultJson } = await runReplay({
      capability: validated.capability,
      inputs: { memberId: '12345', pin: INVALID_PIN },
      surface,
      clock,
    });

    expect(result.kind).toBe('hard_failure');
    if (result.kind === 'hard_failure') {
      expect(result.code).toBe('input_validation');
      expect(result.message).not.toContain(INVALID_PIN);
      expect(result.observed).not.toContain(INVALID_PIN);
    }
    expect(JSON.stringify(events)).not.toContain(INVALID_PIN);
    expect(JSON.stringify(resultJson)).not.toContain(INVALID_PIN);
    expect(surface.actionLog()).toEqual([]);
  });
});

describe('replay: internal', () => {
  it('an invalid capability artifact -> hard_failure internal, issues in observed, zero surface calls', async () => {
    const clock = makeFakeClock();
    const surface = createCuCoreSurface({ clock });

    const { result } = await runReplay({ surface, clock, capability: {} });

    expect(result.kind).toBe('hard_failure');
    if (result.kind === 'hard_failure') {
      expect(result.code).toBe('internal');
      expect(result.observed.length).toBeGreaterThan(0);
      expect(result.evidence).toEqual({});
    }
    expect(surface.actionLog()).toEqual([]);
  });
});

describe('replay: approval gate', () => {
  it('a draft capability with an irreversible step is refused before any surface call', async () => {
    const cap = structuredClone(loadExample());
    cap.status = 'draft';
    cap.riskLevel = 'irreversible';
    const s04 = cap.steps.find((s) => s.id === 's04')!;
    s04.risk = 'irreversible';
    // s04 is the example's sign-on, inside its `auth` block, which may not hold an irreversible
    // step (invalid_auth). This test is about the approval gate, so drop the block.
    delete cap.auth;
    const validated = validateCapability(cap);
    if (!validated.ok) throw new Error(JSON.stringify(validated.issues));

    const clock = makeFakeClock();
    const surface = createCuCoreSurface({ clock });
    const wrapper = wrapSurface(surface);

    const { result } = await runReplay({ capability: validated.capability, surface: wrapper.surface, clock });

    expect(result.kind).toBe('hard_failure');
    if (result.kind === 'hard_failure') {
      expect(result.code).toBe('policy_violation');
      // Refused before compose even builds a RunState, let alone calls screenshot()/domSnapshot().
      expect(result.evidence).toEqual({});
    }
    expect(surface.actionLog()).toEqual([]);
    expect(wrapper.totalCalls()).toBe(0);
  });
});

describe('replay: policy guard', () => {
  it('a policy that denies navigate to /login ends in policy_violation with a policy event', async () => {
    const clock = makeFakeClock();
    const surface = createCuCoreSurface({ clock });
    const policy: PolicyGuardLike = {
      checkAction(action) {
        if (action.type === 'navigate' && action.url.endsWith('/login')) {
          return { decision: 'deny', reason: 'navigate to /login denied by test policy' };
        }
        return { decision: 'allow', reason: 'allowed' };
      },
    };

    const { result, events } = await runReplay({ surface, clock, policy });

    expect(result.kind).toBe('hard_failure');
    if (result.kind === 'hard_failure') {
      expect(result.code).toBe('policy_violation');
      expect(result.stepId).toBe('s01');
      // s01 is the capability's very first step (its own navigate is what got denied): nothing has
      // navigated yet, so a screenshot/DOM snapshot here would be blank, not evidence. `evidence`
      // stays exactly `{}`, never `{screenshot: undefined, dom: undefined}` or similar.
      expect(result.evidence).toEqual({});
    }
    const policyEvents = events.filter((e) => e.kind === 'policy');
    expect(policyEvents.length).toBeGreaterThan(0);
    expect(policyEvents[0]?.data.decision).toBe('deny');
  });

  it('flag_irreversible on an approved capability is allowed, and act() receives allowIrreversible:true', async () => {
    const clock = makeFakeClock();
    const surface = createCuCoreSurface({ clock });
    const wrapper = wrapSurface(surface);
    const policy: PolicyGuardLike = {
      checkAction(action, ctx) {
        if (action.type === 'click' && ctx.stepId === 's04') {
          return { decision: 'flag_irreversible', reason: 'test: treat sign-on as irreversible' };
        }
        return { decision: 'allow', reason: 'allowed' };
      },
    };

    const { result } = await runReplay({ surface: wrapper.surface, clock, policy });

    expect(result.kind).toBe('success');
    const flagged = wrapper.actCalls().find((c) => c.action.type === 'click' && c.opts?.allowIrreversible === true);
    expect(flagged).toBeDefined();
  });

  it('flag_irreversible on a draft capability with no irreversible-declared steps is a policy_violation', async () => {
    const cap = structuredClone(loadExample());
    cap.status = 'draft';
    const validated = validateCapability(cap);
    if (!validated.ok) throw new Error(JSON.stringify(validated.issues));

    const clock = makeFakeClock();
    const surface = createCuCoreSurface({ clock });
    const policy: PolicyGuardLike = {
      checkAction(action, ctx) {
        if (action.type === 'click' && ctx.stepId === 's04') {
          return { decision: 'flag_irreversible', reason: 'test: treat sign-on as irreversible' };
        }
        return { decision: 'allow', reason: 'allowed' };
      },
    };

    const { result } = await runReplay({ capability: validated.capability, surface, clock, policy });

    expect(result.kind).toBe('hard_failure');
    if (result.kind === 'hard_failure') {
      expect(result.code).toBe('policy_violation');
      expect(result.stepId).toBe('s04');
      // Unlike the s01 case above, s01-s03 already completed (real navigation/typing happened),
      // so the surface holds real page content here -- this policy_violation keeps its evidence.
      expect(result.evidence.screenshot).toBeDefined();
      expect(result.evidence.dom).toBeDefined();
    }
  });
});

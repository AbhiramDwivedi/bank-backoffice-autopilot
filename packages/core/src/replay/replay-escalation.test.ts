/**
 * Escalation flows: session expired, abort, next_step, and unexpected dialog.
 */
import { describe, expect, it } from 'vitest';
import { createCuCoreSurface } from '../surface/fake-scenarios/cu-core.js';
import { isRefTarget } from '../surface/types.js';
import {
  BASE_A,
  humanReLogin,
  makeFakeClock,
  makeScriptedEscalationHandler,
  runReplay,
  wrapSurface,
} from './test-helpers.js';

describe('replay: session expired', () => {
  it('without a handler: hard_failure session_expired', async () => {
    const clock = makeFakeClock();
    const rawSurface = createCuCoreSurface({ clock });
    let armed = false;
    const { surface } = wrapSurface(rawSurface, {
      beforeAct: async (action) => {
        if (armed || action.type !== 'click' || !isRefTarget(action.target)) return;
        const desc = await rawSurface.describeRef(action.target.ref);
        if (desc?.name === 'Search') {
          armed = true;
          rawSurface.inject({ kind: 'expire_session' });
        }
      },
    });

    const { result } = await runReplay({ surface, clock });

    expect(result.kind).toBe('hard_failure');
    if (result.kind !== 'hard_failure') throw new Error('expected hard_failure');
    expect(result.code).toBe('session_expired');
    expect(result.stepId).toBe('s06');
  });

  it('with a handler: escalates, the human re-logs in on the raw session, and the run resumes to success', async () => {
    const clock = makeFakeClock();
    const rawSurface = createCuCoreSurface({ clock });
    let armed = false;
    const wrapper = wrapSurface(rawSurface, {
      beforeAct: async (action) => {
        if (armed || action.type !== 'click' || !isRefTarget(action.target)) return;
        const desc = await rawSurface.describeRef(action.target.ref);
        if (desc?.name === 'Search') {
          armed = true;
          rawSurface.inject({ kind: 'expire_session' });
        }
      },
    });

    const scripted = makeScriptedEscalationHandler(wrapper.pending, {
      resumeFrom: 'current_step',
      humanActions: [
        { ts: new Date().toISOString(), type: 'navigate', frame: [], target: {}, url: `${BASE_A}/login` },
      ],
      human: async (req) => {
        expect(req.screenshotPng).toBeInstanceOf(Buffer);
        expect(req.currentUrl).toBeDefined();
        expect(req.reason.code).toBe('unrecoverable_condition');
        expect((req.context as { code?: string } | undefined)?.code).toBe('session_expired');

        // The human re-authenticates on the SAME (raw, unwrapped) session, dismisses the
        // interstitial, and retypes the member id as needed.
        await humanReLogin(rawSurface, { baseUrl: BASE_A, user: 'operator1', password: 'demo-pass-123', memberId: '12345' });
      },
    });

    const { result, events } = await runReplay({ surface: wrapper.surface, clock, escalate: scripted.escalate });

    expect(result.kind).toBe('escalated');
    if (result.kind === 'escalated') expect(result.resolution).toBe('resumed_success');
    expect(wrapper.callsWhilePending()).toBe(0);

    const escalationEvents = events.filter((e) => e.kind === 'escalation');
    expect(escalationEvents.some((e) => (e.data as { phase?: string }).phase === 'raised')).toBe(true);
    expect(escalationEvents.some((e) => (e.data as { phase?: string }).phase === 'resolved')).toBe(true);
    expect(events.some((e) => e.kind === 'human_action')).toBe(true);

    const outcomeEvent = [...events].reverse().find((e) => e.kind === 'outcome');
    const underlying = (outcomeEvent?.data as { underlying?: { kind?: string; outputs?: unknown } } | undefined)?.underlying;
    expect(underlying?.kind).toBe('success');
    expect(underlying?.outputs).toEqual({ memberName: 'Jane Q. Sample', savingsBalance: 1234.56 });

    // The result itself (not just the log event) carries the caller's real answer.
    if (result.kind === 'escalated') {
      expect(result.outcome).toEqual({ kind: 'success', outputs: { memberName: 'Jane Q. Sample', savingsBalance: 1234.56 } });
    }

    expect(events.some((e) => e.kind === 'run_finished')).toBe(true);
  });
});

describe('replay: escalation resolutions', () => {
  it('abort resolution ends the run as escalated/abandoned', async () => {
    const clock = makeFakeClock();
    const surface = createCuCoreSurface({ clock });
    surface.inject({ kind: 'hide_element', elementId: 'search' });

    const scripted = makeScriptedEscalationHandler(undefined, { resumeFrom: 'abort' });
    const { result } = await runReplay({ surface, clock, escalate: scripted.escalate, escalateOn: ['element_not_found'] });

    expect(result.kind).toBe('escalated');
    if (result.kind === 'escalated') {
      expect(result.resolution).toBe('abandoned');
      // `abandoned` still carries the underlying hard_failure the human walked away from.
      expect(result.outcome).toMatchObject({ kind: 'hard_failure', code: 'element_not_found' });
    }
    expect(scripted.requests).toHaveLength(1);
  });

  it('next_step resolution continues after the human performs the step themselves', async () => {
    const clock = makeFakeClock();
    const rawSurface = createCuCoreSurface({ clock });
    // The Search div is hidden for good (times: Infinity default) -- not even the human can click
    // it through its usual locator -- so the human instead performs the equivalent action
    // directly: pressing Enter also triggers the search per the scenario's own transition rules.
    rawSurface.inject({ kind: 'hide_element', elementId: 'search' });

    const scripted = makeScriptedEscalationHandler(undefined, {
      resumeFrom: 'next_step',
      human: async () => {
        await rawSurface.act({ type: 'press', key: 'Enter' }, 2000);
      },
    });

    const { result } = await runReplay({ surface: rawSurface, clock, escalate: scripted.escalate, escalateOn: ['element_not_found'] });

    expect(result.kind).toBe('escalated');
    if (result.kind === 'escalated') expect(result.resolution).toBe('resumed_success');
  });
});

describe('replay: unexpected dialog', () => {
  it('without a handler: hard_failure unexpected_dialog', async () => {
    const clock = makeFakeClock();
    const surface = createCuCoreSurface({ clock });
    surface.inject({ kind: 'dialog', dialog: { type: 'alert', message: 'Unexpected!' } });

    const { result } = await runReplay({ surface, clock });

    expect(result.kind).toBe('hard_failure');
    if (result.kind !== 'hard_failure') throw new Error('expected hard_failure');
    expect(result.code).toBe('unexpected_dialog');
  });

  it('with a handler: the escalation reason code is unexpected_dialog, and the run resumes once the human dismisses it', async () => {
    const clock = makeFakeClock();
    const rawSurface = createCuCoreSurface({ clock });
    rawSurface.inject({ kind: 'dialog', dialog: { type: 'alert', message: 'Unexpected!' } });

    const scripted = makeScriptedEscalationHandler(undefined, {
      resumeFrom: 'current_step',
      human: async (req) => {
        expect(req.reason.code).toBe('unexpected_dialog');
        await rawSurface.act({ type: 'dismiss_dialog', accept: true }, 2000);
      },
    });

    const { result } = await runReplay({ surface: rawSurface, clock, escalate: scripted.escalate });

    expect(result.kind).toBe('escalated');
    if (result.kind === 'escalated') expect(result.resolution).toBe('resumed_success');
    expect(scripted.requests[0]?.reason.code).toBe('unexpected_dialog');
  });
});

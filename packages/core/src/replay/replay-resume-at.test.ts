/**
 * Resume points (`EscalationResolution.resumeAtStepId`, rewind.ts): a resolution that names the
 * step to resume at instead of re-running the failing one.
 *
 * The scenario every test starts from is the one chaos found against the real mock app: the session
 * expires on the search click (s06 in the example), after s05 typed the member id. A real browser
 * loses the typed id with the expired page; the in-memory surface keeps typed values across
 * screens, so the scripted "human" empties the field after re-logging in to model that loss.
 */
import { describe, expect, it } from 'vitest';
import type { Capability, Condition, RunEvent, Step } from '../schema/index.js';
import type { EscalationRequest } from '../session/index.js';
import { createCuCoreSurface } from '../surface/fake-scenarios/cu-core.js';
import { isRefTarget, type Surface } from '../surface/index.js';
import type { PolicyGuardLike } from './types.js';
import {
  BASE_A,
  MOCK_PASSWORD,
  MOCK_USER,
  humanReLogin,
  loadExample,
  makeFakeClock,
  makeScriptedEscalationHandler,
  runReplay,
  wrapSurface,
  type ScriptedHandlerOptions,
} from './test-helpers.js';

/** A fresh fake session whose next click on the target named `expireOn` (default the Search
 *  button) lands on the session-expired page instead, exactly once. */
function expiringSurface(expireOn = 'Search') {
  const clock = makeFakeClock();
  const raw = createCuCoreSurface({ clock });
  let armed = false;
  const wrapper = wrapSurface(raw, {
    beforeAct: async (action) => {
      if (armed || action.type !== 'click' || !isRefTarget(action.target)) return;
      const desc = await raw.describeRef(action.target.ref);
      if (desc?.name === expireOn) {
        armed = true;
        raw.inject({ kind: 'expire_session' });
      }
    },
  });
  return { clock, raw, wrapper };
}

/** The human signs back in on the raw session; the search form comes back EMPTY, as it does in a
 *  real browser after a lost session. */
function reLoginEmptyForm(raw: Surface): () => Promise<void> {
  return () => humanReLogin(raw, { baseUrl: BASE_A, user: MOCK_USER, password: MOCK_PASSWORD, memberId: '' });
}

function withRisk(cap: Capability, stepId: string, risk: Step['risk']): Capability {
  const copy = structuredClone(cap);
  copy.steps.find((s) => s.id === stepId)!.risk = risk;
  if (risk === 'irreversible' || (risk === 'reversible' && copy.riskLevel === 'read')) copy.riskLevel = risk;
  return copy;
}

const escalationPhases = (events: RunEvent[]) => events.filter((e) => e.kind === 'escalation').map((e) => e.data);

const OUTPUTS = { memberName: 'Jane Q. Sample', savingsBalance: 1234.56 };

/**
 * What a human in the operator console can send: "retry this step" is a plain `current_step`, with
 * no resume point (the console never names one). Before the engine defaulted the resume point, this
 * re-ran only the failing search on the emptied form and reported `member_not_found` for a member
 * who exists.
 */
describe('replay: a plain current_step after a lost session resumes after the sign-in (the engine default)', () => {
  it('expiry on the search step: the member id is typed again and the real balance comes back, never member_not_found', async () => {
    const { clock, raw, wrapper } = expiringSurface();
    const scripted = makeScriptedEscalationHandler(wrapper.pending, { resumeFrom: 'current_step', human: reLoginEmptyForm(raw) });

    const { result, events } = await runReplay({ surface: wrapper.surface, clock, escalate: scripted.escalate });

    expect(result.kind).toBe('escalated');
    if (result.kind !== 'escalated') throw new Error('expected escalated');
    expect(result.stepId).toBe('s06');
    expect(result.resolution).toBe('resumed_success');
    expect(result.outcome).toEqual({ kind: 'success', outputs: OUTPUTS });
    expect(scripted.requests).toHaveLength(1);
    expect(wrapper.callsWhilePending()).toBe(0);

    // The resolution named no resume point; the resume_at event says the engine chose it.
    const phases = escalationPhases(events);
    expect(phases[1]).toMatchObject({ phase: 'resolved', resumeFrom: 'current_step' });
    expect(phases[1]).not.toHaveProperty('resumeAtStepId');
    expect(phases[2]).toEqual({ phase: 'resume_at', to: 's05', defaulted: true, recoveryBudgetsReset: true });
    // The member id was typed twice: by the first pass, and again after the rewind.
    expect(result.locatorReport.map((e) => e.stepId).filter((id) => id === 's05' || id === 's06')).toEqual(['s05', 's05', 's06', 's05', 's06']);
  });

  it('tells the operator console, in the request context, where a retry will resume', async () => {
    const { clock, raw, wrapper } = expiringSurface();
    const scripted = makeScriptedEscalationHandler(wrapper.pending, { resumeFrom: 'current_step', human: reLoginEmptyForm(raw) });
    await runReplay({ surface: wrapper.surface, clock, escalate: scripted.escalate });
    expect(scripted.requests[0]?.context?.retryResume).toEqual({ stepId: 's05', stepName: 'Enter the member ID' });
  });

  it('names the completed steps in the rewind window that are not read and so will run again', async () => {
    const { clock, raw, wrapper } = expiringSurface();
    const scripted = makeScriptedEscalationHandler(wrapper.pending, { resumeFrom: 'current_step', human: reLoginEmptyForm(raw) });
    await runReplay({ capability: withRisk(loadExample(), 's05', 'reversible'), surface: wrapper.surface, clock, escalate: scripted.escalate });
    // s06 is the failing step (it has not completed); s01..s04 lie before the resume point.
    expect(scripted.requests[0]?.context?.retryResume).toEqual({
      stepId: 's05',
      stepName: 'Enter the member ID',
      repeats: [{ stepId: 's05', stepName: 'Enter the member ID' }],
    });
  });

  it('expiry on a sign-in step: the human signed in, so the run continues at the first step after the sign-in', async () => {
    const { clock, raw, wrapper } = expiringSurface('login');
    const scripted = makeScriptedEscalationHandler(wrapper.pending, { resumeFrom: 'current_step', human: reLoginEmptyForm(raw) });

    const { result, events } = await runReplay({ surface: wrapper.surface, clock, escalate: scripted.escalate });

    expect(result.kind).toBe('escalated');
    if (result.kind !== 'escalated') throw new Error('expected escalated');
    expect(result.stepId).toBe('s04');
    expect(result.outcome).toEqual({ kind: 'success', outputs: OUTPUTS });
    expect(escalationPhases(events)).toContainEqual({ phase: 'resume_at', to: 's05', defaulted: true, recoveryBudgetsReset: true });
  });

  it('expiry found by the final success check: the same rewind, and outputs read before it are read again', async () => {
    const clock = makeFakeClock();
    const raw = createCuCoreSurface({ clock });
    const wrapper = wrapSurface(raw);
    // The session is lost right before the first success check: the page is the expired-session
    // page, so the check fails and is classified session_expired.
    let successChecks = 0;
    const surface = new Proxy(wrapper.surface, {
      get(target, prop, receiver) {
        if (prop !== 'waitFor') return Reflect.get(target, prop, receiver) as unknown;
        return async (condition: Condition, timeoutMs: number) => {
          const isSuccess = condition.kind === 'all' && JSON.stringify(condition).includes('Member Name');
          if (isSuccess && (successChecks += 1) === 1) await raw.act({ type: 'navigate', url: `${BASE_A}/session-expired` }, 2000);
          return target.waitFor(condition, timeoutMs);
        };
      },
    });
    const scripted = makeScriptedEscalationHandler(wrapper.pending, { resumeFrom: 'current_step', human: reLoginEmptyForm(raw) });

    const { result, events } = await runReplay({ surface, clock, escalate: scripted.escalate });

    expect(result.kind).toBe('escalated');
    if (result.kind !== 'escalated') throw new Error('expected escalated');
    expect(result.stepId).toBeUndefined();
    expect(scripted.requests[0]?.context?.code).toBe('session_expired');
    expect(result.outcome).toEqual({ kind: 'success', outputs: OUTPUTS });
    expect(escalationPhases(events)).toContainEqual({
      phase: 'resume_at',
      to: 's05',
      defaulted: true,
      clearedOutputs: ['memberName', 'savingsBalance'],
      recoveryBudgetsReset: true,
    });
  });

  it('next_step is unchanged: the failing step is verified, nothing is rewound', async () => {
    const { clock, raw, wrapper } = expiringSurface();
    const scripted = makeScriptedEscalationHandler(wrapper.pending, {
      resumeFrom: 'next_step',
      human: async () => {
        await humanReLogin(raw, { baseUrl: BASE_A, user: MOCK_USER, password: MOCK_PASSWORD, memberId: '12345' });
        await raw.act({ type: 'press', key: 'Enter' }, 2000);
      },
    });
    const { result, events } = await runReplay({ surface: wrapper.surface, clock, escalate: scripted.escalate });
    expect(result.kind === 'escalated' ? result.outcome : undefined).toEqual({ kind: 'success', outputs: OUTPUTS });
    expect(escalationPhases(events).some((d) => d.phase === 'resume_at' || d.phase === 'resume_at_refused')).toBe(false);
  });

  it('a failure that is not a lost session keeps the old meaning of current_step: only the failing step runs again', async () => {
    const clock = makeFakeClock();
    const raw = createCuCoreSurface({ clock });
    raw.inject({ kind: 'act_error', match: { actionType: 'click', targetName: 'Search' }, code: 'navigation_failed', message: 'injected' });
    const wrapper = wrapSurface(raw);
    const scripted = makeScriptedEscalationHandler(wrapper.pending, { resumeFrom: 'current_step' });

    const { result, events } = await runReplay({ surface: wrapper.surface, clock, escalate: scripted.escalate, escalateOn: ['navigation_failed'] });

    expect(result.kind === 'escalated' ? result.outcome : undefined).toEqual({ kind: 'success', outputs: OUTPUTS });
    expect(scripted.requests[0]?.context).not.toHaveProperty('retryResume');
    expect(escalationPhases(events).some((d) => d.phase === 'resume_at')).toBe(false);
    expect(result.locatorReport.map((e) => e.stepId).filter((id) => id === 's05' || id === 's06')).toEqual(['s05', 's05', 's06', 's06']);
  });

  /** The example with its sign-in typed from run inputs instead of credentials: no `auth` block, and
   *  none can be derived, so the engine does not know where the sign-in ends. */
  function withoutSignIn(): Capability {
    const cap = loadExample();
    delete cap.auth;
    cap.inputs.operatorId = { type: 'string', description: 'operator id', required: true, sensitive: true };
    cap.inputs.operatorPassword = { type: 'string', description: 'operator password', required: true, sensitive: true };
    for (const [stepId, name] of [['s02', 'operatorId'], ['s03', 'operatorPassword']] as const) {
      const action = cap.steps.find((s) => s.id === stepId)!.action;
      if (action.type !== 'type') throw new Error(`${stepId} is not a type step`);
      action.value = { kind: 'input', name };
    }
    return cap;
  }

  it('a capability with no sign-in steps is unchanged: there is no point to resume at, so only the failing step runs again', async () => {
    const { clock, raw, wrapper } = expiringSurface();
    const scripted = makeScriptedEscalationHandler(wrapper.pending, { resumeFrom: 'current_step', human: reLoginEmptyForm(raw) });

    const { result, events } = await runReplay({
      capability: withoutSignIn(),
      inputs: { memberId: '12345', operatorId: MOCK_USER, operatorPassword: MOCK_PASSWORD },
      surface: wrapper.surface,
      clock,
      escalate: scripted.escalate,
    });

    expect(scripted.requests[0]?.context).not.toHaveProperty('retryResume');
    expect(escalationPhases(events).some((d) => d.phase === 'resume_at')).toBe(false);
    // The known limit this leaves: the search re-runs on the emptied form.
    expect(result.kind).toBe('escalated');
    if (result.kind === 'escalated') expect(result.outcome).toMatchObject({ kind: 'business_outcome', name: 'member_not_found' });
  });

  describe('refused: a step in the rewind window already had its irreversible action dispatched', () => {
    it('re-asks with policy_block, saying what a human can do; the irreversible step is never run again', async () => {
      const { clock, raw, wrapper } = expiringSurface();
      const scripted = makeScriptedEscalationHandler(wrapper.pending, (_req, index) =>
        index === 0 ? { resumeFrom: 'current_step', human: reLoginEmptyForm(raw) } : { resumeFrom: 'abort' },
      );

      const { result, events } = await runReplay({ capability: withRisk(loadExample(), 's06', 'irreversible'), surface: wrapper.surface, clock, escalate: scripted.escalate });

      // The console is told up front that a retry will be refused, and why.
      // s06 is also the failing step, so there is nothing a retry could run instead: no retryRuns.
      expect(scripted.requests[0]?.context?.retryResume).toEqual({
        stepId: 's05',
        stepName: 'Enter the member ID',
        refused: 'resuming at "s05" would run irreversible step "s06" again: its action has already been carried out in this run',
        blockedBy: { stepId: 's06', stepName: 'Search for the member' },
      });
      expect(scripted.requests).toHaveLength(2);
      const reask = scripted.requests[1]!;
      expect(reask.reason.code).toBe('policy_block');
      expect(reask.stepId).toBe('s06');
      expect(reask.reason.message).toContain('would run irreversible step "s06" again');
      expect(reask.reason.message).toContain('hand back "next step"');
      expect(reask.reason.message).toContain('abort');
      expect(reask.reason.message).toContain('session expired'); // the failure still being resolved
      expect(escalationPhases(events)).toContainEqual({ phase: 'resume_at_refused', to: 's05', reason: 'would_repeat_irreversible', blockingStepId: 's06', defaulted: true });
      expect(escalationPhases(events).some((d) => d.phase === 'resume_at')).toBe(false);

      expect(result.kind).toBe('escalated');
      if (result.kind !== 'escalated') throw new Error('expected escalated');
      expect(result.resolution).toBe('abandoned');
      expect(result.outcome).toMatchObject({ kind: 'hard_failure', code: 'session_expired', stepId: 's06' });
      // The irreversible Search click was dispatched exactly once: by the run, before the expiry.
      expect(wrapper.actCalls().filter((c) => c.action.type === 'click' && c.opts?.allowIrreversible === true)).toHaveLength(1);
    });

    it('the re-asked human who did the step by hand answers next_step, and the run continues', async () => {
      const { clock, raw, wrapper } = expiringSurface();
      const scripted = makeScriptedEscalationHandler(wrapper.pending, (_req, index) =>
        index === 0
          ? { resumeFrom: 'current_step', human: reLoginEmptyForm(raw) }
          : {
              resumeFrom: 'next_step',
              human: async () => {
                await humanReLogin(raw, { baseUrl: BASE_A, user: MOCK_USER, password: MOCK_PASSWORD, memberId: '12345' });
                await raw.act({ type: 'press', key: 'Enter' }, 2000);
              },
            },
      );

      const { result } = await runReplay({ capability: withRisk(loadExample(), 's06', 'irreversible'), surface: wrapper.surface, clock, escalate: scripted.escalate });

      expect(scripted.requests).toHaveLength(2);
      expect(result.kind === 'escalated' ? result.outcome : undefined).toEqual({ kind: 'success', outputs: OUTPUTS });
      expect(wrapper.actCalls().filter((c) => c.action.type === 'click' && c.opts?.allowIrreversible === true)).toHaveLength(1);
    });

    it('asking for the same retry again and again ends at maxEscalations with the page\'s own failure', async () => {
      const { clock, wrapper } = expiringSurface();
      const scripted = makeScriptedEscalationHandler(wrapper.pending, { resumeFrom: 'current_step' });
      const { result } = await runReplay({ capability: withRisk(loadExample(), 's06', 'irreversible'), surface: wrapper.surface, clock, escalate: scripted.escalate, maxEscalations: 3 });
      expect(scripted.requests).toHaveLength(3);
      expect(scripted.requests.map((r) => r.reason.code)).toEqual(['unrecoverable_condition', 'policy_block', 'policy_block']);
      expect(result.kind === 'escalated' ? result.outcome : undefined).toMatchObject({ kind: 'hard_failure', code: 'session_expired' });
    });
  });
});

/** A policy guard that flags the Search click (s06) irreversible, though the artifact says `read`. */
const FLAG_SEARCH: PolicyGuardLike = {
  checkAction: (_action, ctx) => (ctx.stepId === 's06' ? { decision: 'flag_irreversible', reason: 'test: the search writes an audit record', risk: 'irreversible' } : { decision: 'allow', reason: 'ok' }),
};

/** The human's own search, on the raw surface, with the member id already typed. */
const humanSearch = (raw: Surface) => async (): Promise<void> => {
  await raw.act({ type: 'press', key: 'Enter' }, 2000);
};

/** The human signs in again, searches, and opens the member: the screen s08 (an extract) expects. */
function humanBackToMember(raw: Surface): () => Promise<void> {
  return async () => {
    await humanReLogin(raw, { baseUrl: BASE_A, user: MOCK_USER, password: MOCK_PASSWORD, memberId: '12345' });
    await raw.act({ type: 'press', key: 'Enter' }, 2000);
    const s07 = loadExample().steps.find((st) => st.id === 's07')!.action;
    if (s07.type !== 'click') throw new Error('s07 is not a click');
    const target = JSON.parse(JSON.stringify(s07.target).replaceAll('{input.memberId}', '12345')) as typeof s07.target;
    const resolved = await raw.resolve(target, 2000);
    if (!resolved.found) throw new Error('the result row is not on the page');
    await raw.act({ type: 'click', target: { ref: resolved.ref } }, 2000);
  };
}

/** Expires the session right before the first extract of the member name (s08). */
function expireBeforeMemberName(raw: Surface, wrapped: Surface): Surface {
  let armed = false;
  return new Proxy(wrapped, {
    get(target, prop, receiver) {
      if (prop !== 'resolve') return Reflect.get(target, prop, receiver) as unknown;
      return async (descriptor: { description: string }, timeoutMs: number) => {
        if (!armed && descriptor.description.startsWith("Value cell for the 'Member Name'")) {
          armed = true;
          await raw.act({ type: 'navigate', url: `${BASE_A}/session-expired` }, 2000);
        }
        return (target.resolve as (d: unknown, t: number) => Promise<unknown>)(descriptor, timeoutMs);
      };
    },
  }) as Surface;
}

describe('replay: a refused default resume point falls back to re-running the failing step alone', () => {
  it('the failing step is an extract after an irreversible step: s08 alone runs again, with no re-ask, and the run returns the real balance', async () => {
    const clock = makeFakeClock();
    const raw = createCuCoreSurface({ clock });
    const wrapper = wrapSurface(raw);
    const surface = expireBeforeMemberName(raw, wrapper.surface);
    const scripted = makeScriptedEscalationHandler(wrapper.pending, { resumeFrom: 'current_step', human: humanBackToMember(raw) });

    const { result, events } = await runReplay({ capability: withRisk(loadExample(), 's06', 'irreversible'), surface, clock, escalate: scripted.escalate });

    expect(scripted.requests).toHaveLength(1);
    expect(scripted.requests[0]?.stepId).toBe('s08');
    expect(scripted.requests[0]?.context?.retryResume).toMatchObject({ stepId: 's05', blockedBy: { stepId: 's06' }, retryRuns: 'failing_step' });
    expect(escalationPhases(events)).toContainEqual({
      phase: 'resume_at_refused',
      to: 's05',
      reason: 'would_repeat_irreversible',
      blockingStepId: 's06',
      defaulted: true,
      rerun: 'failing_step',
    });
    expect(escalationPhases(events).some((d) => d.phase === 'resume_at')).toBe(false);
    expect(result.kind === 'escalated' ? result.outcome : undefined).toEqual({ kind: 'success', outputs: OUTPUTS });
    // The irreversible Search click went out once, before the expiry, and never again.
    expect(wrapper.actCalls().filter((c) => c.action.type === 'click' && c.opts?.allowIrreversible === true)).toHaveLength(1);
  });

  it('a step only the policy guard flags, completed by a human (next_step), counts as carried out: the later default resume does not send it again', async () => {
    const clock = makeFakeClock();
    const raw = createCuCoreSurface({ clock });
    const wrapper = wrapSurface(raw);
    const surface = expireBeforeMemberName(raw, wrapper.surface);
    // The guard flags the Search click, then the button cannot be found: nothing was dispatched,
    // and the human runs the search by hand. Later the session is lost at s08, and the human retries.
    raw.inject({ kind: 'hide_element', elementId: 'search' });
    const scripted = makeScriptedEscalationHandler(wrapper.pending, (_req, index) =>
      index === 0 ? { resumeFrom: 'next_step', human: humanSearch(raw) } : { resumeFrom: 'current_step', human: humanBackToMember(raw) },
    );

    const { result, events } = await runReplay({ surface, clock, escalate: scripted.escalate, policy: FLAG_SEARCH, escalateOn: ['element_not_found', 'session_expired'] });

    expect(scripted.requests.map((r) => r.stepId)).toEqual(['s06', 's08']);
    expect(events.filter((e) => e.kind === 'policy' && e.data.gate === 'next_step').map((e) => ({ stepId: e.stepId, decision: e.data.decision }))).toEqual([
      { stepId: 's06', decision: 'flag_irreversible' },
    ]);
    expect(escalationPhases(events)).toContainEqual(expect.objectContaining({ phase: 'resume_at_refused', to: 's05', blockingStepId: 's06', defaulted: true, rerun: 'failing_step' }));
    expect(result.kind === 'escalated' ? result.outcome : undefined).toEqual({ kind: 'success', outputs: OUTPUTS });
    // Automation never sent the Search click at all: it could not find the button, and the human searched.
    expect(wrapper.actCalls().filter((c) => c.action.type === 'press' || (c.action.type === 'click' && c.opts?.allowIrreversible === true))).toHaveLength(0);
  });
});

describe('replay: resuming at an earlier step after a lost session', () => {
  it('resumeAtStepId s05: the member id is typed again, and the run returns the real balance', async () => {
    const { clock, raw, wrapper } = expiringSurface();
    const scripted = makeScriptedEscalationHandler(wrapper.pending, { resumeFrom: 'current_step', resumeAtStepId: 's05', human: reLoginEmptyForm(raw) });

    const { result, events } = await runReplay({ surface: wrapper.surface, clock, escalate: scripted.escalate });

    expect(result.kind).toBe('escalated');
    if (result.kind !== 'escalated') throw new Error('expected escalated');
    expect(result.resolution).toBe('resumed_success');
    expect(result.stepId).toBe('s06');
    expect(result.outcome).toEqual({ kind: 'success', outputs: OUTPUTS });
    expect(scripted.requests).toHaveLength(1);
    expect(wrapper.callsWhilePending()).toBe(0);

    expect(escalationPhases(events)).toEqual([
      expect.objectContaining({ phase: 'raised', code: 'session_expired' }),
      expect.objectContaining({ phase: 'resolved', resumeFrom: 'current_step', resumeAtStepId: 's05' }),
      { phase: 'resume_at', to: 's05', recoveryBudgetsReset: true },
    ]);

    // The report records what the run did, re-runs included, in order: the maintenance-notice
    // recovery that fired at s05 on the first pass, then s05 and s06 (s06 resolved its target
    // before the click hit the expired session), then both again after the rewind (the human
    // dismissed the notice while signing in, so no recovery this time).
    expect(result.locatorReport.map((e) => e.stepId).filter((id) => id === 's05' || id === 's06')).toEqual(['s05', 's05', 's06', 's05', 's06']);
    expect(result.recoveries).toEqual(['dismiss_maintenance_notice']);
    // 9 steps, s05 completed twice; s06 completed once (its first attempt failed).
    expect(result.stepsExecuted).toBe(10);
  });

  it('a stepless escalation (the final success check) can rewind too; outputs read before it are dropped and read again', async () => {
    const clock = makeFakeClock();
    const raw = createCuCoreSurface({ clock });
    const wrapper = wrapSurface(raw);
    // The success condition fails once (as if the member page vanished); everything else is real.
    let successChecks = 0;
    const surface = new Proxy(wrapper.surface, {
      get(target, prop, receiver) {
        if (prop !== 'waitFor') return Reflect.get(target, prop, receiver) as unknown;
        return async (condition: Condition, timeoutMs: number) => {
          const isSuccess = condition.kind === 'all' && JSON.stringify(condition).includes('Member Name');
          if (isSuccess && (successChecks += 1) === 1) return false;
          return target.waitFor(condition, timeoutMs);
        };
      },
    });
    const scripted = makeScriptedEscalationHandler(wrapper.pending, {
      resumeFrom: 'current_step',
      resumeAtStepId: 's05',
      human: async () => {
        await raw.act({ type: 'navigate', url: `${BASE_A}/workstation` }, 2000);
      },
    });

    const { result, events } = await runReplay({ surface, clock, escalate: scripted.escalate, escalateOn: ['checkpoint_failed'] });

    expect(result.kind).toBe('escalated');
    if (result.kind !== 'escalated') throw new Error('expected escalated');
    expect(result.stepId).toBeUndefined();
    expect(result.outcome).toEqual({ kind: 'success', outputs: OUTPUTS });
    expect(escalationPhases(events)).toContainEqual({ phase: 'resume_at', to: 's05', clearedOutputs: ['memberName', 'savingsBalance'] });
    const reads = events.filter((e) => e.kind === 'action_result' && typeof e.data.output === 'string').map((e) => e.data.output);
    expect(reads).toEqual(['memberName', 'savingsBalance', 'memberName', 'savingsBalance']);
  });

  it('a resume point AFTER the failing step: the expiry hit the sign-on, the human signed in, the run continues at s05', async () => {
    const { clock, raw, wrapper } = expiringSurface('login');
    const scripted = makeScriptedEscalationHandler(wrapper.pending, { resumeFrom: 'current_step', resumeAtStepId: 's05', human: reLoginEmptyForm(raw) });

    const { result } = await runReplay({ surface: wrapper.surface, clock, escalate: scripted.escalate });

    expect(result.kind).toBe('escalated');
    if (result.kind !== 'escalated') throw new Error('expected escalated');
    expect(result.stepId).toBe('s04');
    expect(result.outcome).toEqual({ kind: 'success', outputs: OUTPUTS });
  });

  it("names a step of the run as the tenant executes it: an override's extra step is a valid resume point only with that tenant applied", async () => {
    const cap = loadExample();
    cap.overrides = [
      {
        tenant: 'with-extra-step',
        stepPatches: [],
        extraSteps: [{ afterStepId: 's04', step: { id: 's04b', name: 'wait for the workstation', action: { type: 'wait', condition: { kind: 'url_matches', pattern: '/workstation' } }, risk: 'read' } }],
      },
    ];
    for (const tenant of ['with-extra-step', undefined]) {
      const { clock, raw, wrapper } = expiringSurface();
      const scripted = makeScriptedEscalationHandler(wrapper.pending, (_req, index) =>
        index === 0 ? { resumeFrom: 'current_step', resumeAtStepId: 's04b', human: reLoginEmptyForm(raw) } : { resumeFrom: 'abort' },
      );
      const { result } = await runReplay({ capability: cap, surface: wrapper.surface, clock, escalate: scripted.escalate, ...(tenant !== undefined ? { tenant } : {}) });
      expect(result.kind).toBe('escalated');
      if (result.kind !== 'escalated') throw new Error('expected escalated');
      if (tenant !== undefined) {
        expect(result.outcome).toEqual({ kind: 'success', outputs: OUTPUTS });
      } else {
        expect(result.resolution).toBe('abandoned');
        expect(scripted.requests[1]?.reason.message).toContain('"s04b" is not a step of this capability as this run executes it');
      }
    }
  });
});

describe('replay: refused resume points are asked again (policy_block), never silently replaced', () => {
  /** Runs the expiry-on-search scenario: the first resolution asks for `resumeAtStepId`, the
   *  second (the re-ask after a refusal) does `second`. */
  async function refusedRun(cap: Capability, resumeAtStepId: string, second: ScriptedHandlerOptions = { resumeFrom: 'abort' }, expireOn?: string) {
    const { clock, raw, wrapper } = expiringSurface(expireOn);
    const scripted = makeScriptedEscalationHandler(wrapper.pending, (_req: EscalationRequest, index) =>
      index === 0 ? { resumeFrom: 'current_step', resumeAtStepId, human: reLoginEmptyForm(raw) } : second,
    );
    const run = await runReplay({ capability: cap, surface: wrapper.surface, clock, escalate: scripted.escalate });
    return { ...run, scripted, wrapper };
  }

  it.each([
    {
      name: 'the failing step itself is irreversible and its action was dispatched (it failed only afterwards: the click may have gone through)',
      irreversible: 's06',
      blocking: 's06',
    },
    { name: 'an irreversible step between the resume point and the failing step completed', irreversible: 's05', blocking: 's05' },
  ])('would repeat an irreversible step: $name', async ({ irreversible, blocking }) => {
    const { result, events, scripted } = await refusedRun(withRisk(loadExample(), irreversible, 'irreversible'), 's05');

    expect(scripted.requests).toHaveLength(2);
    const reask = scripted.requests[1]!;
    expect(reask.reason.code).toBe('policy_block');
    expect(reask.stepId).toBe('s06');
    expect(reask.reason.message).toContain(`would run irreversible step "${blocking}" again`);
    expect(reask.reason.message).toContain('session expired'); // the failure still being resolved
    expect(escalationPhases(events)).toContainEqual({ phase: 'resume_at_refused', to: 's05', reason: 'would_repeat_irreversible', blockingStepId: blocking });
    expect(escalationPhases(events).some((d) => d.phase === 'resume_at')).toBe(false);

    // The human aborted the re-ask: a typed hard failure that says what was refused, keeping the
    // page's own failure code.
    expect(result.kind).toBe('escalated');
    if (result.kind !== 'escalated') throw new Error('expected escalated');
    expect(result.resolution).toBe('abandoned');
    expect(result.outcome).toMatchObject({ kind: 'hard_failure', code: 'session_expired', stepId: 's06' });
    if (result.outcome?.kind === 'hard_failure') expect(result.outcome.message).toContain('replay refused the resume point');
  });

  it('an irreversible step that has not run yet does not block the rewind', async () => {
    const { result } = await refusedRun(withRisk(loadExample(), 's07', 'irreversible'), 's05');
    expect(result.kind === 'escalated' ? result.outcome : undefined).toEqual({ kind: 'success', outputs: OUTPUTS });
  });

  it('would skip an irreversible step: a forward resume point over one is refused', async () => {
    const { scripted, events } = await refusedRun(withRisk(loadExample(), 's05', 'irreversible'), 's06', { resumeFrom: 'abort' }, 'login');
    expect(scripted.requests[1]?.reason.code).toBe('policy_block');
    expect(scripted.requests[1]?.reason.message).toContain('would skip irreversible step "s05"');
    expect(escalationPhases(events)).toContainEqual({ phase: 'resume_at_refused', to: 's06', reason: 'would_skip_irreversible', blockingStepId: 's05' });
  });

  it('an unknown step id is refused, and the re-asked human can still resume another way', async () => {
    const { result, scripted, events } = await refusedRun(loadExample(), 's99', { resumeFrom: 'current_step', resumeAtStepId: 's05' });
    expect(scripted.requests).toHaveLength(2);
    expect(scripted.requests[1]?.reason.code).toBe('policy_block');
    expect(escalationPhases(events)).toContainEqual({ phase: 'resume_at_refused', to: 's99', reason: 'unknown_step' });
    expect(result.kind === 'escalated' ? result.outcome : undefined).toEqual({ kind: 'success', outputs: OUTPUTS });
  });

  it('a resume point that cannot be honoured never falls back to re-running the failing step', async () => {
    const { wrapper, scripted } = await refusedRun(withRisk(loadExample(), 's06', 'irreversible'), 's05');
    expect(scripted.requests).toHaveLength(2);
    // s06 (the irreversible Search click) was dispatched exactly once: by the run, before the expiry.
    const clicks = wrapper.actCalls().filter((c) => c.action.type === 'click' && c.opts?.allowIrreversible === true);
    expect(clicks).toHaveLength(1);
  });
});

describe('replay: resume points are bounded by maxEscalations', () => {
  it.each([
    { name: 'an accepted rewind that never fixes the page', resumeAtStepId: 's05' },
    { name: 'a refused resume point asked for again and again', resumeAtStepId: 's99' },
  ])('$name: exactly maxEscalations requests, then a hard failure', async ({ resumeAtStepId }) => {
    const { clock, wrapper } = expiringSurface();
    const scripted = makeScriptedEscalationHandler(wrapper.pending, { resumeFrom: 'current_step', resumeAtStepId });

    const { result } = await runReplay({ surface: wrapper.surface, clock, escalate: scripted.escalate, maxEscalations: 3 });

    expect(scripted.requests).toHaveLength(3);
    expect(result.kind).toBe('escalated');
    if (result.kind !== 'escalated') throw new Error('expected escalated');
    expect(result.resolution).toBe('resumed_failed');
    expect(result.outcome).toMatchObject({ kind: 'hard_failure', code: 'session_expired' });
  });
});

describe('replay: a resume point only means something with current_step', () => {
  it('next_step with a resumeAtStepId is a plain next_step (verify the failing step), not a jump', async () => {
    const { clock, raw, wrapper } = expiringSurface();
    // The human signs in and searches themselves (so s06's checkpoint holds), then says next_step.
    const scripted = makeScriptedEscalationHandler(wrapper.pending, {
      resumeFrom: 'next_step',
      resumeAtStepId: 's01',
      human: async () => {
        await humanReLogin(raw, { baseUrl: BASE_A, user: MOCK_USER, password: MOCK_PASSWORD, memberId: '12345' });
        await raw.act({ type: 'press', key: 'Enter' }, 2000);
      },
    });
    const { result, events } = await runReplay({ surface: wrapper.surface, clock, escalate: scripted.escalate });
    expect(result.kind === 'escalated' ? result.outcome : undefined).toEqual({ kind: 'success', outputs: OUTPUTS });
    expect(escalationPhases(events).some((d) => d.phase === 'resume_at' || d.phase === 'resume_at_refused')).toBe(false);
  });
});

describe('replay: recovery budgets and resume points', () => {
  /** The example with its maintenance-notice rule limited to ONE dismissal per budget, so a second
   *  notice in the run is only dismissed if the budget was reset. */
  function oneDismissal(): Capability {
    const cap = loadExample();
    cap.recoveryRules[0]!.maxAttempts = 1;
    return cap;
  }

  /** The human signs back in on the raw session and leaves the new session's maintenance notice
   *  up (the fake shows it after every sign-on), with the search form empty. */
  function signInLeavingNotice(raw: Surface, cap: Capability): () => Promise<void> {
    const targetOf = (id: string) => {
      const a = cap.steps.find((s) => s.id === id)!.action;
      if (!('target' in a)) throw new Error(`${id} has no target`);
      return a.target;
    };
    const act = async (id: string, action: (ref: string) => Parameters<Surface['act']>[0]) => {
      const r = await raw.resolve(targetOf(id), 2000);
      if (!r.found) throw new Error(`cannot resolve ${id}`);
      const res = await raw.act(action(r.ref), 2000);
      if (!res.ok) throw new Error(`${id} failed`);
    };
    return async () => {
      await raw.act({ type: 'navigate', url: `${BASE_A}/login` }, 2000);
      await act('s02', (ref) => ({ type: 'type', target: { ref }, value: MOCK_USER, clear: true }));
      await act('s03', (ref) => ({ type: 'type', target: { ref }, value: MOCK_PASSWORD, clear: true }));
      await act('s04', (ref) => ({ type: 'click', target: { ref } }));
      expect(await raw.check({ kind: 'text_visible', text: 'System Maintenance Notice', frame: [{ name: 'main' }] })).toBe(true);
    };
  }

  it("after a lost session, an accepted resume resets the budget: the new session's notice is dismissed again", async () => {
    const cap = oneDismissal();
    const { clock, raw, wrapper } = expiringSurface();
    const scripted = makeScriptedEscalationHandler(wrapper.pending, { resumeFrom: 'current_step', resumeAtStepId: 's05', human: signInLeavingNotice(raw, cap) });

    const { result, events } = await runReplay({ capability: cap, surface: wrapper.surface, clock, escalate: scripted.escalate });

    expect(result.kind === 'escalated' ? result.outcome : undefined).toEqual({ kind: 'success', outputs: OUTPUTS });
    // One dismissal per session, two sessions: past the rule's maxAttempts (1) only because of the reset.
    expect(result.recoveries).toEqual(['dismiss_maintenance_notice', 'dismiss_maintenance_notice']);
    expect(escalationPhases(events)).toContainEqual({ phase: 'resume_at', to: 's05', recoveryBudgetsReset: true });
  });

  it('a refused resume point resets nothing: the second notice stays up', async () => {
    const cap = oneDismissal();
    const { clock, raw, wrapper } = expiringSurface();
    // The re-ask is answered next_step: the failing search is only verified, and it never ran,
    // because its Search button is behind the notice nobody dismissed.
    const scripted = makeScriptedEscalationHandler(wrapper.pending, (_req, index) =>
      index === 0 ? { resumeFrom: 'current_step', resumeAtStepId: 's99', human: signInLeavingNotice(raw, cap) } : { resumeFrom: 'next_step' },
    );

    const { result, events } = await runReplay({ capability: cap, surface: wrapper.surface, clock, escalate: scripted.escalate, maxEscalations: 2 });

    expect(scripted.requests).toHaveLength(2); // the refusal's re-ask
    expect(result.recoveries).toEqual(['dismiss_maintenance_notice']);
    expect(result.kind).toBe('escalated');
    if (result.kind !== 'escalated') throw new Error('expected escalated');
    expect(result.outcome?.kind).toBe('hard_failure');
    expect(escalationPhases(events).some((d) => d.recoveryBudgetsReset === true)).toBe(false);
  });

  it('a plain current_step answering that re-ask is the engine default after a lost session: an accepted resume, so the budget is reset', async () => {
    const cap = oneDismissal();
    const { clock, raw, wrapper } = expiringSurface();
    const scripted = makeScriptedEscalationHandler(wrapper.pending, (_req, index) =>
      index === 0 ? { resumeFrom: 'current_step', resumeAtStepId: 's99', human: signInLeavingNotice(raw, cap) } : { resumeFrom: 'current_step' },
    );

    const { result, events } = await runReplay({ capability: cap, surface: wrapper.surface, clock, escalate: scripted.escalate });

    expect(scripted.requests).toHaveLength(2);
    expect(escalationPhases(events)).toContainEqual({ phase: 'resume_at_refused', to: 's99', reason: 'unknown_step' });
    expect(escalationPhases(events)).toContainEqual({ phase: 'resume_at', to: 's05', defaulted: true, recoveryBudgetsReset: true });
    expect(result.recoveries).toEqual(['dismiss_maintenance_notice', 'dismiss_maintenance_notice']);
    expect(result.kind === 'escalated' ? result.outcome : undefined).toEqual({ kind: 'success', outputs: OUTPUTS });
  });

  it('a resume without a lost session keeps the budget: a rule that keeps firing still stops at maxAttempts', async () => {
    const cap = oneDismissal();
    const clock = makeFakeClock();
    const raw = createCuCoreSurface({ clock });
    // The Search click fails once for a reason that is not a lost session; the human signs in again
    // anyway (a new notice) and rewinds.
    raw.inject({ kind: 'act_error', match: { actionType: 'click', targetName: 'Search' }, code: 'navigation_failed', message: 'injected' });
    const wrapper = wrapSurface(raw);
    const scripted = makeScriptedEscalationHandler(wrapper.pending, { resumeFrom: 'current_step', resumeAtStepId: 's05', human: signInLeavingNotice(raw, cap) });

    const { result, events } = await runReplay({ capability: cap, surface: wrapper.surface, clock, escalate: scripted.escalate, escalateOn: ['navigation_failed'] });

    expect(escalationPhases(events)).toContainEqual({ phase: 'resume_at', to: 's05' });
    expect(result.recoveries).toEqual(['dismiss_maintenance_notice']);
    expect(result.kind === 'escalated' ? result.outcome?.kind : undefined).toBe('hard_failure');
  });
});

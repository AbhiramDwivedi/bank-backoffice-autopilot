/**
 * The bounded retry of a transient `app_error` (replay.ts `retryAppError`, rewind.ts
 * `appErrorRetryIndex`): only on a run asserted read-only, by restarting the steps from one that
 * can run from any page, after a backoff on the injected clock.
 *
 * The scenario mirrors the mock app: the member search answers with the "Application Error" page,
 * which replaces the frame that holds the search form. Re-running the failing step, or resuming at
 * the member-id step, would find nothing to act on; the retry restarts at the entry navigation.
 */
import { describe, expect, it } from 'vitest';
import { validateCapability, type Capability, type Condition, type RunEvent, type Step } from '../schema/index.js';
import { createCuCoreScenario, createCuCoreSurface } from '../surface/fake-scenarios/cu-core.js';
import { FakeSurface } from '../surface/fake/index.js';
import { appErrorRetryIndex, indexAfterSignIn } from './rewind.js';
import { isRefTarget } from '../surface/index.js';
import { BASE_A, MOCK_PASSWORD, MOCK_USER, humanReLogin, loadExample, makeFakeClock, makeScriptedEscalationHandler, runReplay, wrapSurface } from './test-helpers.js';
import { APP_ERROR_RETRY, type PolicyGuardLike, type ReplayClock } from './types.js';

const OUTPUTS = { memberName: 'Jane Q. Sample', savingsBalance: 1234.56 };
const NOTICE = 'dismiss_maintenance_notice';

/** A fake clock that also records every sleep, to show the backoff ran on it and not on a real timer. */
function recordingClock(): { clock: ReplayClock; sleeps: number[] } {
  const inner = makeFakeClock();
  const sleeps: number[] = [];
  return {
    sleeps,
    clock: {
      now: () => inner.now(),
      sleep: (ms) => {
        sleeps.push(ms);
        return inner.sleep(ms);
      },
    },
  };
}

/**
 * The CU Core fake whose member search lands on the Application Error page the first `failures`
 * times and works after that. `onFailure` runs each time a search fails. Navigating to `/boom`
 * shows the same error page from anywhere.
 */
function flakySearchSurface(clock: ReplayClock, failures: number, onFailure?: (surface: FakeSurface) => void): { surface: FakeSurface; searches: () => number } {
  const scenario = createCuCoreScenario();
  let searches = 0;
  // The rules are wired before the surface exists; they reach it through this holder.
  const built: { surface?: FakeSurface } = {};
  for (const rule of scenario.rules) {
    const isSearch = rule.from === 'workstation' && (rule.match.targetId === 'search' || rule.match.key === 'Enter');
    if (!isSearch) continue;
    const real = rule.to;
    rule.to = (ctx) => {
      searches += 1;
      if (searches <= failures) {
        if (built.surface !== undefined) onFailure?.(built.surface);
        return 'app_error';
      }
      return typeof real === 'function' ? real(ctx) : real;
    };
  }
  scenario.rules.unshift({ from: '*', match: { actionType: 'navigate', url: `${BASE_A}/boom` }, to: 'app_error' });
  const surface = new FakeSurface(scenario, { clock });
  built.surface = surface;
  return { surface, searches: () => searches };
}

function readOnlyExample(): Capability {
  const cap = loadExample();
  cap.readOnly = true;
  return cap;
}

/** A policy guard that flags the Search click (s06) irreversible, though the artifact says `read`. */
const FLAG_SEARCH: PolicyGuardLike = {
  checkAction: (_action, ctx) => (ctx.stepId === 's06' ? { decision: 'flag_irreversible', reason: 'test: the search writes an audit record', risk: 'irreversible' } : { decision: 'allow', reason: 'ok' }),
};

const retryEvents = (events: RunEvent[]) => events.filter((e) => e.kind === 'recovery' && e.data.rule === APP_ERROR_RETRY).map((e) => ({ stepId: e.stepId, ...e.data }));
const stepRuns = (events: RunEvent[], stepId: string) => events.filter((e) => e.kind === 'action' && e.stepId === stepId).length;

describe('replay: a transient app_error on a read-only capability is retried', () => {
  it('the search fails once: the run waits, restarts at the entry step, and succeeds, with retry_app_error among its recoveries', async () => {
    const { clock, sleeps } = recordingClock();
    const { surface, searches } = flakySearchSurface(clock, 1);

    const { result, events } = await runReplay({ capability: readOnlyExample(), surface, clock });

    expect(result.kind).toBe('success');
    if (result.kind !== 'success') throw new Error('expected success');
    expect(result.outputs).toEqual(OUTPUTS);
    // One notice per sign-in (the retry signs in again), with the retry between them.
    expect(result.recoveries).toEqual([NOTICE, APP_ERROR_RETRY, NOTICE]);
    expect(retryEvents(events)).toEqual([{ stepId: 's06', rule: APP_ERROR_RETRY, attempt: 1, of: 2, backoffMs: 1000, restartAt: 's01', recoveryBudgetsReset: true }]);
    expect(sleeps).toContain(1000);
    expect(searches()).toBe(2);
    // Every step ran again from s01: nothing was retried in place.
    expect(stepRuns(events, 's01')).toBe(2);
    expect(stepRuns(events, 's06')).toBe(2);
    // 5 steps completed before the failing search, then all 9.
    expect(result.stepsExecuted).toBe(14);
  });

  it('the run-level assertion (ReplayOptions.readOnly) does the same for a capability that does not carry readOnly', async () => {
    const clock = makeFakeClock();
    const { surface } = flakySearchSurface(clock, 1);

    const { result } = await runReplay({ surface, clock, readOnly: true });

    expect(result.kind).toBe('success');
    expect(result.recoveries).toContain(APP_ERROR_RETRY);
  });

  it('budget spent: two retries with a growing backoff, then hard_failure app_error with the attempts in recoveries', async () => {
    const { clock, sleeps } = recordingClock();
    const surface = createCuCoreSurface({ clock, failSearch: true });

    const { result, events } = await runReplay({ capability: readOnlyExample(), surface, clock });

    expect(result.kind).toBe('hard_failure');
    if (result.kind !== 'hard_failure') throw new Error('expected hard_failure');
    expect(result.code).toBe('app_error');
    expect(result.stepId).toBe('s06');
    expect(result.observed).toMatch(/Application Error/);
    // Three sign-ins, three notices: past the rule's maxAttempts (2) only because a restart that
    // signs in again resets the recovery budgets, as a re-login after a lost session does.
    expect(result.recoveries).toEqual([NOTICE, APP_ERROR_RETRY, NOTICE, APP_ERROR_RETRY, NOTICE]);
    expect(retryEvents(events)).toEqual([
      expect.objectContaining({ attempt: 1, of: 2, backoffMs: 1000, restartAt: 's01' }),
      expect.objectContaining({ attempt: 2, of: 2, backoffMs: 2000, restartAt: 's01' }),
      { stepId: 's06', rule: APP_ERROR_RETRY, skipped: true, reason: 'the retry budget is spent (2 of 2)' },
    ]);
    expect(sleeps.filter((ms) => ms === 1000 || ms === 2000)).toEqual([1000, 2000]);
  });

  it('maxAppErrorRetries is the budget: 1 retries once, 0 disables the retry and logs nothing', async () => {
    const once = makeFakeClock();
    const one = await runReplay({ capability: readOnlyExample(), surface: createCuCoreSurface({ clock: once, failSearch: true }), clock: once, maxAppErrorRetries: 1 });
    expect(one.result.recoveries.filter((r) => r === APP_ERROR_RETRY)).toHaveLength(1);
    expect(one.result.kind === 'hard_failure' ? one.result.code : undefined).toBe('app_error');

    const never = makeFakeClock();
    const zero = await runReplay({ capability: readOnlyExample(), surface: flakySearchSurface(never, 1).surface, clock: never, maxAppErrorRetries: 0 });
    expect(zero.result.kind === 'hard_failure' ? zero.result.code : undefined).toBe('app_error');
    expect(zero.result.recoveries).toEqual([NOTICE]);
    expect(retryEvents(zero.events)).toEqual([]);
  });

  it('the budget and the backoff are clamped to non-negative integers: a negative budget is 0, NaN is the default, a negative or fractional backoff is 0 or rounded down', async () => {
    const neg = makeFakeClock();
    const none = await runReplay({ capability: readOnlyExample(), surface: flakySearchSurface(neg, 1).surface, clock: neg, maxAppErrorRetries: -1 });
    expect(none.result.kind === 'hard_failure' ? none.result.code : undefined).toBe('app_error');
    expect(retryEvents(none.events)).toEqual([]);

    const nan = recordingClock();
    const dflt = await runReplay({ capability: readOnlyExample(), surface: createCuCoreSurface({ clock: nan.clock, failSearch: true }), clock: nan.clock, maxAppErrorRetries: Number.NaN, appErrorRetryBackoffMs: -5 });
    expect(dflt.result.recoveries.filter((r) => r === APP_ERROR_RETRY)).toHaveLength(2);
    expect(dflt.events.filter((e) => e.kind === 'recovery' && e.data.rule === APP_ERROR_RETRY && e.data.skipped !== true).map((e) => e.data.backoffMs)).toEqual([0, 0]);

    const frac = recordingClock();
    const f = await runReplay({ capability: readOnlyExample(), surface: flakySearchSurface(frac.clock, 1).surface, clock: frac.clock, maxAppErrorRetries: 1.9, appErrorRetryBackoffMs: 2.7 });
    expect(retryEvents(f.events)).toEqual([expect.objectContaining({ attempt: 1, of: 1, backoffMs: 2 })]);
  });

  it('bounded by the run deadline: a backoff the time budget cannot cover is not taken', async () => {
    const { clock, sleeps } = recordingClock();
    const { surface } = flakySearchSurface(clock, 1);

    const { result, events } = await runReplay({ capability: readOnlyExample(), surface, clock, appErrorRetryBackoffMs: 3_600_000 });

    expect(result.kind === 'hard_failure' ? result.code : undefined).toBe('app_error');
    expect(result.recoveries).toEqual([NOTICE]);
    expect(retryEvents(events)).toEqual([expect.objectContaining({ skipped: true, reason: expect.stringContaining('maxDurationMs') as unknown })]);
    expect(sleeps).not.toContain(3_600_000);
  });
});

describe('replay: without the read-only assertion nothing is retried', () => {
  it('the same transient failure is a hard_failure app_error, exactly as before', async () => {
    const clock = makeFakeClock();
    const { surface, searches } = flakySearchSurface(clock, 1);

    const { result, events } = await runReplay({ surface, clock });

    expect(result.kind).toBe('hard_failure');
    if (result.kind !== 'hard_failure') throw new Error('expected hard_failure');
    expect(result.code).toBe('app_error');
    expect(result.stepId).toBe('s06');
    expect(result.recoveries).toEqual([NOTICE]);
    expect(retryEvents(events)).toEqual([]);
    expect(searches()).toBe(1);
  });

  it('an app_error the surface reports for a control it could not operate is not an error page, and is not retried', async () => {
    const clock = makeFakeClock();
    const surface = createCuCoreSurface({ clock });
    // The page is the ordinary search form; only the click itself is refused.
    surface.inject({ kind: 'act_error', match: { actionType: 'click', targetName: 'Search' }, code: 'app_error', message: "element 'Search' is disabled" });

    const { result, events } = await runReplay({ capability: readOnlyExample(), surface, clock });

    expect(result.kind).toBe('hard_failure');
    if (result.kind !== 'hard_failure') throw new Error('expected hard_failure');
    expect(result.code).toBe('app_error');
    expect(result.message).toContain('is disabled');
    expect(result.recoveries).toEqual([NOTICE]);
    expect(retryEvents(events)).toEqual([]);
  });

  it('a failure that is not app_error is never retried, read-only or not', async () => {
    const clock = makeFakeClock();
    const surface = createCuCoreSurface({ clock });
    surface.inject({ kind: 'hide_element', elementId: 'search' });

    const { result, events } = await runReplay({ capability: readOnlyExample(), surface, clock });

    expect(result.kind === 'hard_failure' ? result.code : undefined).toBe('element_not_found');
    expect(retryEvents(events)).toEqual([]);
  });
});

describe('replay: the read-only assertion is refused on anything irreversible', () => {
  it('ReplayOptions.readOnly on a capability with an irreversible step: policy_violation before any surface call', async () => {
    const cap = loadExample();
    cap.steps.find((s) => s.id === 's06')!.risk = 'irreversible';
    cap.riskLevel = 'irreversible';
    const clock = makeFakeClock();
    const wrapper = wrapSurface(createCuCoreSurface({ clock }));

    const { result, events } = await runReplay({ capability: cap, surface: wrapper.surface, clock, readOnly: true });

    expect(result.kind).toBe('hard_failure');
    if (result.kind !== 'hard_failure') throw new Error('expected hard_failure');
    expect(result.code).toBe('policy_violation');
    expect(result.observed).toContain('read_only_irreversible');
    expect(result.stepsExecuted).toBe(0);
    expect(wrapper.totalCalls()).toBe(0);
    expect(events.filter((e) => e.kind === 'policy').map((e) => e.data)).toContainEqual({ gate: 'read_only', decision: 'deny' });
  });

  it('ReplayOptions.readOnly with a tenant override whose extra step is irreversible: refused before any surface call', async () => {
    const cap = loadExample();
    cap.overrides = [
      {
        tenant: 'b',
        stepPatches: [],
        extraSteps: [{ afterStepId: 's06', step: { id: 'sX', name: 'Post a note', risk: 'irreversible', action: { type: 'press', key: 'F9' } } }],
      },
    ];
    // What the run-level gate holds the run to: the extra step alone makes `readOnly: true` invalid.
    const declared = validateCapability({ ...cap, readOnly: true });
    expect(!declared.ok && declared.issues.find((i) => i.code === 'read_only_irreversible')?.message).toContain('override b extra step "sX" is irreversible');

    const clock = makeFakeClock();
    const wrapper = wrapSurface(createCuCoreSurface({ clock }));
    const { result } = await runReplay({ capability: cap, tenant: 'b', surface: wrapper.surface, clock, readOnly: true });

    // The artifact check already refuses a tenant override that introduces an irreversible step
    // (override_irreversible_change), so the run never reaches the read-only gate; either way,
    // nothing touches the surface and nothing is retried.
    expect(result.kind).toBe('hard_failure');
    expect(result.kind === 'hard_failure' ? result.observed : '').toContain('override_irreversible_change');
    expect(result.stepsExecuted).toBe(0);
    expect(wrapper.totalCalls()).toBe(0);
  });

  it('a step the policy guard flagged irreversible at act time was dispatched: no retry, and it is never clicked twice', async () => {
    const clock = makeFakeClock();
    const { surface, searches } = flakySearchSurface(clock, 1);
    const wrapper = wrapSurface(surface);
    // Nothing in the artifact is irreversible, so the run-level assertion is accepted; the live
    // policy still flags the Search click when it is about to act.
    const policy: PolicyGuardLike = {
      checkAction: (_action, ctx) => (ctx.stepId === 's06' ? { decision: 'flag_irreversible', reason: 'test: the search writes an audit record', risk: 'irreversible' } : { decision: 'allow', reason: 'ok' }),
    };

    const { result, events } = await runReplay({ surface: wrapper.surface, clock, readOnly: true, policy });

    expect(result.kind === 'hard_failure' ? result.code : undefined).toBe('app_error');
    expect(result.recoveries).toEqual([NOTICE]);
    expect(retryEvents(events)).toEqual([
      { stepId: 's06', rule: APP_ERROR_RETRY, skipped: true, reason: 'resuming at "s01" would run irreversible step "s06" again: its action has already been carried out in this run' },
    ]);
    expect(searches()).toBe(1);
    expect(wrapper.actCalls().filter((c) => c.opts?.allowIrreversible === true)).toHaveLength(1);
  });
});

describe('replay: what an app-error retry resets, and where it restarts', () => {
  it('the success-check path: an app error found by the final success check restarts the run, and outputs read before it are read again, not kept', async () => {
    const clock = makeFakeClock();
    const { surface: raw } = flakySearchSurface(clock, 0);
    // The app error replaces the member page right before the first success check.
    let successChecks = 0;
    const surface = new Proxy(raw, {
      get(target, prop, receiver) {
        if (prop !== 'waitFor') return Reflect.get(target, prop, receiver) as unknown;
        return async (condition: Condition, timeoutMs: number) => {
          const isSuccess = condition.kind === 'all' && JSON.stringify(condition).includes('Member Name');
          if (isSuccess && (successChecks += 1) === 1) await raw.act({ type: 'navigate', url: `${BASE_A}/boom` }, 2000);
          return target.waitFor(condition, timeoutMs);
        };
      },
    });

    const { result, events } = await runReplay({ capability: readOnlyExample(), surface, clock });

    expect(result.kind).toBe('success');
    if (result.kind !== 'success') throw new Error('expected success');
    expect(result.outputs).toEqual(OUTPUTS);
    // The retry is logged against no step (the success check has none) and drops both outputs.
    expect(retryEvents(events)).toEqual([
      { stepId: undefined, rule: APP_ERROR_RETRY, attempt: 1, of: 2, backoffMs: 1000, restartAt: 's01', clearedOutputs: ['memberName', 'savingsBalance'], recoveryBudgetsReset: true },
    ]);
    const reads = events.filter((e) => e.kind === 'action_result' && typeof e.data.output === 'string').map((e) => e.data.output);
    expect(reads).toEqual(['memberName', 'savingsBalance', 'memberName', 'savingsBalance']);
  });

  it('a run that cannot finish after the retry reports the outputs it dropped as missing, never the values read before it', async () => {
    const clock = makeFakeClock();
    // The first success check finds the app error (outputs were already read); after the restart
    // the search itself fails for good, so the run never reads them again.
    let successChecks = 0;
    let failSearches = false;
    const scenario = createCuCoreScenario();
    for (const rule of scenario.rules) {
      if (rule.from !== 'workstation' || (rule.match.targetId !== 'search' && rule.match.key !== 'Enter')) continue;
      const real = rule.to;
      rule.to = (ctx) => (failSearches ? 'app_error' : typeof real === 'function' ? real(ctx) : real);
    }
    scenario.rules.unshift({ from: '*', match: { actionType: 'navigate', url: `${BASE_A}/boom` }, to: 'app_error' });
    const raw = new FakeSurface(scenario, { clock });
    const surface = new Proxy(raw, {
      get(target, prop, receiver) {
        if (prop !== 'waitFor') return Reflect.get(target, prop, receiver) as unknown;
        return async (condition: Condition, timeoutMs: number) => {
          const isSuccess = condition.kind === 'all' && JSON.stringify(condition).includes('Member Name');
          if (isSuccess && (successChecks += 1) === 1) {
            failSearches = true;
            await raw.act({ type: 'navigate', url: `${BASE_A}/boom` }, 2000);
          }
          return target.waitFor(condition, timeoutMs);
        };
      },
    });

    const { result, resultJson } = await runReplay({ capability: readOnlyExample(), surface, clock });

    expect(result.kind).toBe('hard_failure');
    if (result.kind !== 'hard_failure') throw new Error('expected hard_failure');
    expect(result.code).toBe('app_error');
    expect(JSON.stringify(resultJson)).not.toContain('Jane Q. Sample');
    expect(JSON.stringify(resultJson)).not.toContain('1234.56');
  });

  /** The example with a navigation right after its sign-in: a step that can run from any page. */
  function withNavigateAfterSignIn(): Capability {
    const cap = readOnlyExample();
    const nav: Step = { id: 's04b', name: 'Open the workstation', action: { type: 'navigate', url: '{baseUrl}/workstation' }, risk: 'read' };
    cap.steps.splice(4, 0, nav);
    return cap;
  }

  it('restarts at the first step after the sign-in when that step is a navigation: the session is kept and nobody signs in again', async () => {
    const clock = makeFakeClock();
    const { surface } = flakySearchSurface(clock, 1);

    const { result, events } = await runReplay({ capability: withNavigateAfterSignIn(), surface, clock });

    expect(result.kind).toBe('success');
    if (result.kind !== 'success') throw new Error('expected success');
    expect(result.outputs).toEqual(OUTPUTS);
    // No new session, so no recovery-budget reset.
    expect(retryEvents(events)).toEqual([{ stepId: 's06', rule: APP_ERROR_RETRY, attempt: 1, of: 2, backoffMs: 1000, restartAt: 's04b' }]);
    expect(stepRuns(events, 's02')).toBe(1);
    expect(stepRuns(events, 's04b')).toBe(2);
    expect(stepRuns(events, 's05')).toBe(2);
  });

  it('why the restart is not simply the first step after the sign-in: on the error page that step has nothing to act on, while the entry step runs from anywhere', async () => {
    const clock = makeFakeClock();
    const { surface } = flakySearchSurface(clock, 1);
    const example = loadExample();
    // No read-only assertion: the run stops on the error page and leaves the surface there.
    const { result } = await runReplay({ capability: example, surface, clock });
    expect(result.kind === 'hard_failure' ? result.code : undefined).toBe('app_error');

    const afterSignIn = example.steps[indexAfterSignIn(example)!]!;
    expect(afterSignIn.id).toBe('s05');
    if (afterSignIn.action.type !== 'type') throw new Error('expected s05 to type the member id');
    // The member-id field went with the search form the error page replaced.
    expect((await surface.resolve(afterSignIn.action.target, 100)).found).toBe(false);
    // The entry navigation does not depend on the page it starts from.
    expect((await surface.act({ type: 'navigate', url: `${BASE_A}/login` }, 2000)).ok).toBe(true);
    expect(await surface.check({ kind: 'url_matches', pattern: '/login$' })).toBe(true);
  });

  it('appErrorRetryIndex: the first step after the sign-in only when it is a navigation and the failure is past the sign-in; otherwise step 0', () => {
    const example = loadExample(); // sign-in s01..s04, then s05 types the member id
    expect(indexAfterSignIn(example)).toBe(4);
    expect(appErrorRetryIndex(example, 5)).toBe(0);
    expect(appErrorRetryIndex(example, example.steps.length)).toBe(0);

    const nav = withNavigateAfterSignIn(); // sign-in s01..s04, then s04b navigates
    expect(appErrorRetryIndex(nav, 6)).toBe(4);
    expect(appErrorRetryIndex(nav, 4)).toBe(4); // the navigation itself hit the error: it runs again
    expect(appErrorRetryIndex(nav, nav.steps.length)).toBe(4);
    expect(appErrorRetryIndex(nav, 2)).toBe(0); // the error is inside the sign-in: start over

    const noSignIn = loadExample();
    delete noSignIn.auth;
    noSignIn.steps = noSignIn.steps.slice(4);
    expect(indexAfterSignIn(noSignIn)).toBeUndefined();
    // Its first step types into a form: nothing to restart from on an error page.
    expect(appErrorRetryIndex(noSignIn, 1)).toBeUndefined();
  });

  it('a capability whose restart step would not be a navigation is not retried: a skipped recovery event says why', async () => {
    const clock = makeFakeClock();
    const { surface, searches } = flakySearchSurface(clock, 1);
    // Signed in already, as a desktop flow starts on a window that is open: the capability begins
    // by typing the member id.
    await humanReLogin(surface, { baseUrl: BASE_A, user: MOCK_USER, password: MOCK_PASSWORD });
    const cap = readOnlyExample();
    delete cap.auth;
    cap.steps = cap.steps.slice(4);

    const { result, events } = await runReplay({ capability: cap, surface, clock });

    expect(result.kind === 'hard_failure' ? result.code : undefined).toBe('app_error');
    expect(retryEvents(events)).toEqual([
      {
        stepId: 's06',
        rule: APP_ERROR_RETRY,
        skipped: true,
        reason: 'the capability has no navigation step to restart from: its first step is not a navigate, and only a navigation can run from an error page',
      },
    ]);
    expect(result.recoveries).not.toContain(APP_ERROR_RETRY);
    expect(searches()).toBe(1);
  });

  it('a restart that cannot get back to the failing step reports the app error it was retrying, with the retry\'s own failure in the message, and does not retry again', async () => {
    const clock = makeFakeClock();
    // When the search fails, the login page stops showing its user-id field: the restart's first
    // step (open the login page, user-id field visible) can no longer pass.
    const { surface } = flakySearchSurface(clock, 1, (s) => s.inject({ kind: 'hide_element', elementId: 'userId' }));

    const { result, events } = await runReplay({ capability: readOnlyExample(), surface, clock });

    expect(result.kind).toBe('hard_failure');
    if (result.kind !== 'hard_failure') throw new Error('expected hard_failure');
    expect(result.code).toBe('app_error');
    expect(result.stepId).toBe('s06');
    expect(result.observed).toMatch(/Application Error/);
    expect(result.message).toContain('retry_app_error restarted the run at step "s01" but it could not get back to the failing step (checkpoint_failed at step "s01"');
    expect(result.recoveries).toEqual([NOTICE, APP_ERROR_RETRY]);
    // The retry's own failure is in the log as what it was.
    expect(events.filter((e) => e.kind === 'error').map((e) => [e.stepId, e.data.code])).toEqual([
      ['s06', 'app_error'],
      ['s01', 'checkpoint_failed'],
    ]);
  });
});

describe('replay: the app-error retry and escalation', () => {
  it('a step only the policy guard flags, completed by a human (next_step), is never re-dispatched by a later retry', async () => {
    const clock = makeFakeClock();
    const { surface: raw } = flakySearchSurface(clock, 0);
    const wrapper = wrapSurface(raw);
    // The app error replaces the member page right before the first success check.
    let successChecks = 0;
    const surface = new Proxy(wrapper.surface, {
      get(target, prop, receiver) {
        if (prop !== 'waitFor') return Reflect.get(target, prop, receiver) as unknown;
        return async (condition: Condition, timeoutMs: number) => {
          const isSuccess = condition.kind === 'all' && JSON.stringify(condition).includes('Member Name');
          if (isSuccess && (successChecks += 1) === 1) await raw.act({ type: 'navigate', url: `${BASE_A}/boom` }, 2000);
          return target.waitFor(condition, timeoutMs);
        };
      },
    });
    // The guard flags the Search click, then the button cannot be found: nothing was dispatched,
    // and the human runs the search by hand.
    raw.inject({ kind: 'hide_element', elementId: 'search' });
    const scripted = makeScriptedEscalationHandler(wrapper.pending, {
      resumeFrom: 'next_step',
      human: async () => {
        await raw.act({ type: 'press', key: 'Enter' }, 2000);
      },
    });

    const { result, events } = await runReplay({ capability: readOnlyExample(), surface, clock, policy: FLAG_SEARCH, escalate: scripted.escalate, escalateOn: ['element_not_found'] });

    expect(scripted.requests.map((r) => r.stepId)).toEqual(['s06']);
    expect(retryEvents(events)).toEqual([
      { stepId: undefined, rule: APP_ERROR_RETRY, skipped: true, reason: 'resuming at "s01" would run irreversible step "s06" again: its action has already been carried out in this run' },
    ]);
    expect(result.kind === 'escalated' ? result.outcome : undefined).toMatchObject({ kind: 'hard_failure', code: 'app_error' });
    expect(wrapper.actCalls().filter((c) => c.action.type === 'press' || c.opts?.allowIrreversible === true)).toHaveLength(0);
  });

  it('after a retry got past the failing step, a later human resume and an unrelated failure are reported as what they are, not as the old app error', async () => {
    const clock = makeFakeClock();
    const { surface: flaky } = flakySearchSurface(clock, 1);
    let expired = false;
    const wrapper = wrapSurface(flaky, {
      // The session is lost on the first click of the result row (s07), after the retry.
      beforeAct: async (action) => {
        if (expired || action.type !== 'click' || !isRefTarget(action.target)) return;
        const desc = await flaky.describeRef(action.target.ref);
        if (desc?.name?.startsWith('12345 ') === true) {
          expired = true;
          flaky.inject({ kind: 'expire_session' });
        }
      },
    });
    // The human signs in again and hands back "retry": the engine resumes at s05, whose field the
    // page no longer shows. That failure is the page's, not the retry's.
    const scripted = makeScriptedEscalationHandler(wrapper.pending, {
      resumeFrom: 'current_step',
      human: async () => {
        await humanReLogin(flaky, { baseUrl: BASE_A, user: MOCK_USER, password: MOCK_PASSWORD });
        flaky.inject({ kind: 'hide_element', elementId: 'memberId' });
      },
    });

    const { result, events } = await runReplay({ capability: readOnlyExample(), surface: wrapper.surface, clock, escalate: scripted.escalate, maxEscalations: 1 });

    expect(result.recoveries).toContain(APP_ERROR_RETRY);
    expect(events.filter((e) => e.kind === 'escalation').map((e) => e.data)).toContainEqual(expect.objectContaining({ phase: 'resume_at', to: 's05', defaulted: true }));
    expect(result.kind).toBe('escalated');
    if (result.kind !== 'escalated') throw new Error('expected escalated');
    expect(result.outcome).toMatchObject({ kind: 'hard_failure', code: 'precondition_failed', stepId: 's05' });
    if (result.outcome?.kind === 'hard_failure') expect(result.outcome.message).not.toContain('could not get back');
  });

  it('retries come first and have their own budget; when it is spent, an app_error that is set to escalate still does', async () => {
    const clock = makeFakeClock();
    const surface = createCuCoreSurface({ clock, failSearch: true });
    const scripted = makeScriptedEscalationHandler(undefined, { resumeFrom: 'abort' });

    const { result } = await runReplay({ capability: readOnlyExample(), surface, clock, escalate: scripted.escalate, escalateOn: ['app_error'], maxEscalations: 1 });

    expect(scripted.requests).toHaveLength(1);
    expect(result.kind).toBe('escalated');
    if (result.kind !== 'escalated') throw new Error('expected escalated');
    expect(result.resolution).toBe('abandoned');
    expect(result.outcome).toMatchObject({ kind: 'hard_failure', code: 'app_error', stepId: 's06' });
    expect(result.recoveries.filter((r) => r === APP_ERROR_RETRY)).toHaveLength(2);
  });
});

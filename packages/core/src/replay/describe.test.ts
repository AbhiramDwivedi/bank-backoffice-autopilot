import { describe, expect, it } from 'vitest';
import type { FailureCode, LocatorReportEntry, ReplayResult } from '../schema/index.js';
import { describeResult, summarizeLocatorDrift, summarizeStability } from './describe.js';

const BASE = {
  runId: 'run-1',
  capabilityId: 'lookup-member-savings-balance',
  capabilityVersion: '1.0.0',
};

describe('summarizeLocatorDrift', () => {
  it('counts total, drifted, maxDepth, per-strategy buckets and unique drifted steps in order', () => {
    const report: LocatorReportEntry[] = [
      { stepId: 's01', strategyKind: 'role', fallbackDepth: 0 },
      { stepId: 's02', strategyKind: 'css', fallbackDepth: 2 },
      { stepId: 's03', strategyKind: 'label', fallbackDepth: 0 },
      { stepId: 's04', strategyKind: 'css', fallbackDepth: 1 },
      { stepId: 's04', strategyKind: 'bbox', fallbackDepth: 3 }, // same step, second entry -> unique step count stays
    ];
    const summary = summarizeLocatorDrift(report);
    expect(summary.total).toBe(5);
    expect(summary.drifted).toBe(3);
    expect(summary.maxDepth).toBe(3);
    expect(summary.byStrategy.role).toEqual({ resolved: 1, drifted: 0 });
    expect(summary.byStrategy.label).toEqual({ resolved: 1, drifted: 0 });
    expect(summary.byStrategy.css).toEqual({ resolved: 2, drifted: 2 });
    expect(summary.byStrategy.bbox).toEqual({ resolved: 1, drifted: 1 });
    expect(summary.driftedSteps).toEqual(['s02', 's04']);
  });

  it('is all-zero for an empty report', () => {
    const summary = summarizeLocatorDrift([]);
    expect(summary).toEqual({ total: 0, drifted: 0, maxDepth: 0, byStrategy: {}, driftedSteps: [] });
  });
});

describe('describeResult', () => {
  it('success: matches the spec example verbatim', () => {
    const result: ReplayResult = {
      ...BASE,
      kind: 'success',
      stepsExecuted: 9,
      durationMs: 1200,
      locatorReport: [
        { stepId: 's01', strategyKind: 'role', fallbackDepth: 0 },
        { stepId: 's02', strategyKind: 'label', fallbackDepth: 0 },
      ],
      recoveries: ['dismiss_maintenance_notice'],
      outputs: { memberName: 'Jane Q. Sample', savingsBalance: 1234.56 },
    };
    expect(describeResult(result)).toBe(
      'Capability lookup-member-savings-balance@1.0.0 succeeded in 9 steps (1.2s): ' +
        'memberName="Jane Q. Sample", savingsBalance=1234.56. Recoveries: dismiss_maintenance_notice. Locator drift: none.',
    );
  });

  it('success: no outputs omits the trailing colon clause; no recoveries says none', () => {
    const result: ReplayResult = {
      ...BASE,
      kind: 'success',
      stepsExecuted: 3,
      durationMs: 500,
      locatorReport: [],
      recoveries: [],
      outputs: {},
    };
    expect(describeResult(result)).toBe(
      'Capability lookup-member-savings-balance@1.0.0 succeeded in 3 steps (0.5s). Recoveries: none. Locator drift: none.',
    );
  });

  it('business_outcome: names the outcome and reports data', () => {
    const result: ReplayResult = {
      ...BASE,
      kind: 'business_outcome',
      stepsExecuted: 6,
      durationMs: 800,
      locatorReport: [],
      recoveries: [],
      name: 'member_not_found',
      data: { memberId: '99999' },
    };
    expect(describeResult(result)).toBe(
      'Capability lookup-member-savings-balance@1.0.0 ended with business outcome "member_not_found" after 6 steps (not a failure). ' +
        'Data: {memberId="99999"}. Recoveries: none. Locator drift: none.',
    );
  });

  it('business_outcome: mentions missing returns when an extract failed', () => {
    const result: ReplayResult = {
      ...BASE,
      kind: 'business_outcome',
      stepsExecuted: 7,
      durationMs: 900,
      locatorReport: [],
      recoveries: [],
      name: 'access_denied',
      data: {},
      missing: ['message'],
    };
    expect(describeResult(result)).toBe(
      'Capability lookup-member-savings-balance@1.0.0 ended with business outcome "access_denied" after 7 steps (not a failure). ' +
        'Data: {}. Missing returns: message. Recoveries: none. Locator drift: none.',
    );
  });

  it('hard_failure: names the step, code, message, expected/observed and evidence paths', () => {
    const result: ReplayResult = {
      ...BASE,
      kind: 'hard_failure',
      stepsExecuted: 7,
      durationMs: 4300,
      locatorReport: [],
      recoveries: [],
      stepId: 's07',
      stepName: 'Open the matching result',
      code: 'checkpoint_failed',
      expected: 'the member detail screen to load',
      observed: 'still on the results table',
      message: 'postcondition not met within timeout',
      evidence: { screenshot: 'shots/12.png', dom: 'dom/12.html' },
    };
    expect(describeResult(result)).toBe(
      'Capability lookup-member-savings-balance@1.0.0 FAILED at step s07 ("Open the matching result") with checkpoint_failed: ' +
        'postcondition not met within timeout. Expected: the member detail screen to load. Observed: still on the results table. ' +
        'Evidence: shots/12.png, dom/12.html. Recoveries: none. Locator drift: none.',
    );
  });

  it('hard_failure: no stepId (e.g. input_validation/internal) omits the "at step" clause and evidence when absent', () => {
    const result: ReplayResult = {
      ...BASE,
      kind: 'hard_failure',
      stepsExecuted: 0,
      durationMs: 10,
      locatorReport: [],
      recoveries: [],
      code: 'input_validation',
      expected: 'memberId to be provided',
      observed: '',
      message: "input 'memberId' is required",
      evidence: {},
    };
    expect(describeResult(result)).toBe(
      'Capability lookup-member-savings-balance@1.0.0 FAILED with input_validation: ' +
        "input 'memberId' is required. Expected: memberId to be provided. Observed: . Recoveries: none. Locator drift: none.",
    );
  });

  it('hard_failure: expected/observed are truncated to ~300 chars', () => {
    const long = 'x'.repeat(400);
    const result: ReplayResult = {
      ...BASE,
      kind: 'hard_failure',
      stepsExecuted: 1,
      durationMs: 10,
      locatorReport: [],
      recoveries: [],
      stepId: 's01',
      code: 'checkpoint_failed',
      expected: long,
      observed: long,
      message: 'm',
      evidence: {},
    };
    const text = describeResult(result);
    expect(text).toContain(`Expected: ${'x'.repeat(297)}...`);
    expect(text).toContain(`Observed: ${'x'.repeat(297)}...`);
  });

  it('escalated: names the intervention, reason and resolution', () => {
    const result: ReplayResult = {
      ...BASE,
      kind: 'escalated',
      stepsExecuted: 6,
      durationMs: 60_000,
      locatorReport: [],
      recoveries: [],
      interventionId: 'int_abc123',
      stepId: 's06',
      reason: 'a native dialog is open',
      resolution: 'resumed_success',
    };
    expect(describeResult(result)).toBe(
      'Capability lookup-member-savings-balance@1.0.0 escalated to a human at step s06 (intervention int_abc123): ' +
        'a native dialog is open. Resolution: resumed_success. Recoveries: none. Locator drift: none.',
    );
  });

  it('escalated: an undefined resolution renders as pending', () => {
    const result: ReplayResult = {
      ...BASE,
      kind: 'escalated',
      stepsExecuted: 2,
      durationMs: 100,
      locatorReport: [],
      recoveries: [],
      interventionId: 'int_xyz',
      reason: 'session expired',
    };
    expect(describeResult(result)).toContain('Resolution: pending.');
    expect(describeResult(result)).not.toContain('at step');
  });

  it('includes the detailed drift sentence when any locator entry has fallbackDepth > 0', () => {
    const result: ReplayResult = {
      ...BASE,
      kind: 'success',
      stepsExecuted: 9,
      durationMs: 1000,
      recoveries: [],
      outputs: {},
      locatorReport: [
        { stepId: 's01', strategyKind: 'role', fallbackDepth: 0 },
        { stepId: 's02', strategyKind: 'css', fallbackDepth: 1 },
        { stepId: 's03', strategyKind: 'css', fallbackDepth: 2 },
      ],
    };
    expect(describeResult(result)).toContain('Locator drift: 2 of 3 targets resolved by a fallback (css x2); review these locators.');
  });
});

describe('summarizeStability', () => {
  type SuccessFields = Omit<Extract<ReplayResult, { kind: 'success' }>, 'kind'>;
  function successResult(overrides: Partial<SuccessFields> = {}): ReplayResult {
    return { ...BASE, kind: 'success', stepsExecuted: 9, durationMs: 1000, locatorReport: [], recoveries: [], outputs: {}, ...overrides };
  }

  it('is all-zero for an empty series', () => {
    const summary = summarizeStability([]);
    expect(summary).toEqual({
      runs: 0,
      successes: 0,
      businessOutcomes: {},
      failures: {},
      escalations: 0,
      meanDurationMs: 0,
      drift: { total: 0, drifted: 0, maxDepth: 0, byStrategy: {}, driftedSteps: [] },
      byKind: { success: 0, business_outcome: 0, hard_failure: 0, escalated: 0 },
      escalationBreakdown: { reason: {}, resolution: {}, outcome: {} },
      recoveries: {},
      fallbackDepths: {},
      minDurationMs: 0,
      maxDurationMs: 0,
    });
  });

  it('counts every result kind, zero included, and reports min/max duration', () => {
    const failure: ReplayResult = {
      ...BASE,
      kind: 'hard_failure',
      stepsExecuted: 2,
      durationMs: 300,
      locatorReport: [],
      recoveries: [],
      code: 'app_error',
      expected: 'e',
      observed: 'o',
      message: 'm',
      evidence: {},
    };
    const summary = summarizeStability([successResult({ durationMs: 1000 }), failure, successResult({ durationMs: 2000 })]);
    expect(summary.byKind).toEqual({ success: 2, business_outcome: 0, hard_failure: 1, escalated: 0 });
    expect(summary.minDurationMs).toBe(300);
    expect(summary.maxDurationMs).toBe(2000);
  });

  it('breaks escalations down by reason, resolution and underlying outcome; each breakdown sums to the escalation count', () => {
    const esc = (fields: Partial<Extract<ReplayResult, { kind: 'escalated' }>>): ReplayResult => ({
      ...BASE,
      kind: 'escalated',
      stepsExecuted: 4,
      durationMs: 10,
      locatorReport: [],
      recoveries: [],
      interventionId: 'i1',
      reason: 'unrecoverable_condition',
      ...fields,
    });
    const summary = summarizeStability([
      esc({ resolution: 'resumed_success', outcome: { kind: 'success', outputs: {} } }),
      esc({ resolution: 'resumed_success', outcome: { kind: 'success', outputs: {} } }),
      esc({ resolution: 'abandoned', outcome: { kind: 'hard_failure', code: 'session_expired', message: 'm' } }),
      esc({ reason: 'unexpected_dialog', resolution: 'resumed_success', outcome: { kind: 'business_outcome', name: 'member_not_found', data: {} } }),
      esc({ reason: 'unexpected_dialog' }),
    ]);
    expect(summary.escalations).toBe(5);
    expect(summary.escalationBreakdown).toEqual({
      reason: { unrecoverable_condition: 3, unexpected_dialog: 2 },
      resolution: { resumed_success: 3, abandoned: 1, pending: 1 },
      outcome: { success: 2, 'hard_failure:session_expired': 1, 'business_outcome:member_not_found': 1, none: 1 },
    });
  });

  it('counts recovery rules: total firings and the number of runs each fired in', () => {
    const summary = summarizeStability([
      successResult({ recoveries: ['dismiss_notice', 'dismiss_notice'] }),
      successResult({ recoveries: ['dismiss_notice', 'wait_for_slow_page'] }),
      successResult({ recoveries: [] }),
    ]);
    expect(summary.recoveries).toEqual({
      dismiss_notice: { fired: 3, runs: 2 },
      wait_for_slow_page: { fired: 1, runs: 1 },
    });
  });

  it('counts every locator resolution by fallback depth', () => {
    const summary = summarizeStability([
      successResult({
        locatorReport: [
          { stepId: 's01', strategyKind: 'label', fallbackDepth: 0 },
          { stepId: 's02', strategyKind: 'css', fallbackDepth: 2 },
        ],
      }),
      successResult({ locatorReport: [{ stepId: 's01', strategyKind: 'label', fallbackDepth: 0 }] }),
    ]);
    expect(summary.fallbackDepths).toEqual({ '0': 2, '2': 1 });
  });

  it('counts runs and successes, and averages durationMs', () => {
    const summary = summarizeStability([successResult({ durationMs: 1000 }), successResult({ durationMs: 2000 })]);
    expect(summary.runs).toBe(2);
    expect(summary.successes).toBe(2);
    expect(summary.meanDurationMs).toBe(1500);
  });

  it('counts business outcomes by name', () => {
    const bo = (name: string): ReplayResult => ({ ...BASE, kind: 'business_outcome', stepsExecuted: 3, durationMs: 100, locatorReport: [], recoveries: [], name, data: {} });
    const summary = summarizeStability([bo('member_not_found'), bo('member_not_found'), bo('access_denied')]);
    expect(summary.businessOutcomes).toEqual({ member_not_found: 2, access_denied: 1 });
    expect(summary.successes).toBe(0);
  });

  it('counts hard failures by code', () => {
    const failure = (code: FailureCode): ReplayResult => ({
      ...BASE,
      kind: 'hard_failure',
      stepsExecuted: 2,
      durationMs: 50,
      locatorReport: [],
      recoveries: [],
      code,
      expected: 'e',
      observed: 'o',
      message: 'm',
      evidence: {},
    });
    const summary = summarizeStability([failure('timeout'), failure('timeout'), failure('checkpoint_failed')]);
    expect(summary.failures).toEqual({ timeout: 2, checkpoint_failed: 1 });
  });

  it('counts escalations', () => {
    const escalated: ReplayResult = { ...BASE, kind: 'escalated', stepsExecuted: 1, durationMs: 10, locatorReport: [], recoveries: [], interventionId: 'i1', reason: 'stuck' };
    const summary = summarizeStability([escalated, escalated]);
    expect(summary.escalations).toBe(2);
  });

  it('unions locator drift across every run (targets that drifted in ANY run), reusing summarizeLocatorDrift', () => {
    const runA = successResult({
      locatorReport: [
        { stepId: 's01', strategyKind: 'role', fallbackDepth: 0 },
        { stepId: 's02', strategyKind: 'css', fallbackDepth: 1 },
      ],
    });
    const runB = successResult({
      locatorReport: [
        { stepId: 's01', strategyKind: 'role', fallbackDepth: 0 },
        { stepId: 's03', strategyKind: 'css', fallbackDepth: 2 },
      ],
    });
    const summary = summarizeStability([runA, runB]);
    expect(summary.drift.driftedSteps).toEqual(['s02', 's03']);
    expect(summary.drift.maxDepth).toBe(2);
    expect(summary.drift.total).toBe(4);
    expect(summary.drift.drifted).toBe(2);
  });
});

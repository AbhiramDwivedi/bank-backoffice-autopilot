/**
 * `printReplayResult` prints each fact about a run exactly once: no separate "locator drift" line
 * (`describeResult` already ends with one) and no "run dir: ..." line (`runWithShutdown`,
 * apps/cu/src/runtime/lifecycle.ts, already announces that path), on top of stdout getting
 * `describeResult(result)` itself.
 */
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ReplayResult } from '@cu/core/schema';
import { summarizeStability } from '@cu/core/replay';
import { printReplayResult, printStabilitySummary, stabilitySummaryLines } from './print-result.js';

const BASE_SUCCESS: ReplayResult = {
  runId: 'run-1',
  capabilityId: 'lookup-member-savings-balance',
  capabilityVersion: '1.0.0',
  stepsExecuted: 3,
  durationMs: 500,
  locatorReport: [{ stepId: 's01', strategyKind: 'css', fallbackDepth: 1 }],
  recoveries: [],
  kind: 'success',
  outputs: { savingsBalance: 1234.56 },
};

describe('printReplayResult (non-json)', () => {
  it('prints describeResult once (already carrying its own drift sentence) and the result.json path, and nothing separately labelled "locator drift" or "run dir"', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    let lines: string[];
    try {
      printReplayResult(BASE_SUCCESS, '/tmp/run-1', { json: false });
      // Read the recorded calls BEFORE mockRestore(), which also clears mock.calls.
      lines = logSpy.mock.calls.map((args) => String(args[0]));
    } finally {
      logSpy.mockRestore();
    }

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('Locator drift:'); // from describeResult itself
    expect(lines[1]).toBe(`result: ${path.join('/tmp/run-1', 'result.json')}`);

    // No second, separately-labelled drift line, and no "run dir:" line at all (that is
    // runWithShutdown's job, exactly once, on stderr).
    expect(lines.filter((l) => l.toLowerCase().includes('locator drift'))).toHaveLength(1);
    expect(lines.some((l) => l.includes('run dir:'))).toBe(false);
  });
});

describe('printReplayResult (json)', () => {
  it('prints ONLY the JSON to stdout -- no drift line, no run dir line, no result path', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    let calls: unknown[][];
    try {
      printReplayResult(BASE_SUCCESS, '/tmp/run-1', { json: true });
      calls = logSpy.mock.calls;
    } finally {
      logSpy.mockRestore();
    }

    expect(calls).toHaveLength(1);
    const parsed = JSON.parse(String(calls[0]?.[0])) as ReplayResult;
    expect(parsed).toEqual(BASE_SUCCESS);
  });
});

describe('printReplayResult: sensitive outputs (screen masking)', () => {
  function printed(result: ReplayResult, opts: { json: boolean; sensitiveOutputs?: readonly string[] }): string {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      printReplayResult(result, '/tmp/run-1', opts);
      return logSpy.mock.calls.map((args) => String(args[0])).join('\n');
    } finally {
      logSpy.mockRestore();
    }
  }

  it('the human summary shows <sensitive> for a sensitive output; --json keeps the value for the caller', () => {
    const human = printed(BASE_SUCCESS, { json: false, sensitiveOutputs: ['savingsBalance'] });
    expect(human).toContain('<sensitive>');
    expect(human).not.toContain('1234.56');
    expect(printed(BASE_SUCCESS, { json: true, sensitiveOutputs: ['savingsBalance'] })).toContain('1234.56');
    expect(printed(BASE_SUCCESS, { json: false })).toContain('1234.56');
  });
});

describe('printStabilitySummary', () => {
  const failure = {
    ...BASE_SUCCESS,
    runId: 'run-2',
    kind: 'hard_failure',
    durationMs: 1500,
    recoveries: ['dismiss_notice'],
    code: 'app_error',
    expected: 'e',
    observed: 'o',
    message: 'm',
    evidence: {},
  } as ReplayResult;
  const escalated = {
    ...BASE_SUCCESS,
    runId: 'run-3',
    kind: 'escalated',
    durationMs: 2500,
    recoveries: ['dismiss_notice', 'dismiss_notice'],
    interventionId: 'i1',
    reason: 'unrecoverable_condition',
    resolution: 'resumed_success',
    outcome: { kind: 'success', outputs: {} },
  } as ReplayResult;
  const runs = [BASE_SUCCESS, failure, escalated];

  function capture(fn: () => void): { out: string[]; err: string[] } {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      fn();
      return { out: logSpy.mock.calls.map((a) => String(a[0])), err: errSpy.mock.calls.map((a) => String(a[0])) };
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
    }
  }

  it('prints a table by result kind with each breakdown, recoveries, fallback depths and durations', () => {
    const lines = stabilitySummaryLines(summarizeStability(runs));
    expect(lines[0]).toBe('3 run(s); duration mean 1.5s, min 0.5s, max 2.5s');
    expect(lines).toEqual([
      '3 run(s); duration mean 1.5s, min 0.5s, max 2.5s',
      'result kind',
      '  success                              1',
      '  business_outcome                     0',
      '  hard_failure                         1',
      '    app_error                          1',
      '  escalated                            1',
      '    reason unrecoverable_condition     1',
      '    resolution resumed_success         1',
      '    then success                       1',
      'recoveries fired (times, in how many runs)',
      '  dismiss_notice     3  in 2 run(s)',
      'locator fallback depth: 1=3 (0 = first locator)',
      'locator drift (union across all runs): 3/3 target(s) resolved by a fallback (max fallback depth 1; steps: s01)',
    ]);
  });

  it('truncates a long escalation reason in the table (the JSON keeps it whole)', () => {
    const reason = `session expired (page shows "Your session has expired") while step s07 postcondition not met`;
    const summary = summarizeStability([{ ...escalated, reason } as ReplayResult]);
    const line = stabilitySummaryLines(summary).find((l) => l.includes('reason session expired'));
    expect(line).toBeDefined();
    expect(line).toContain('...');
    expect(line!.length).toBeLessThan(90);
    expect(Object.keys(summary.escalationBreakdown.reason)).toEqual([reason]);
  });

  it('non-json: everything on stdout, including the chaos seed and re-run flags when given', () => {
    const chaos = { seed: 42, fault: { chaos: { seed: 42 } }, report: { config: { seed: 42 }, stats: {}, log: [], logDropped: 0 } };
    const { out, err } = capture(() => printStabilitySummary(runs, summarizeStability(runs), { json: false, chaos }));
    expect(err).toEqual([]);
    expect(out).toContain('chaos seed: 42');
    expect(out.at(-1)).toBe(`re-run this exact series: the same replay command (artifact, --input and other flags unchanged) with --times 3 --fault '{"chaos":{"seed":42}}'`);
  });

  it('json: stdout is ONLY { runs, stability, chaos }; the table goes to stderr', () => {
    const chaos = { seed: 7, fault: { chaos: { seed: 7 } }, reportError: 'HTTP 404' };
    const summary = summarizeStability(runs);
    const { out, err } = capture(() => printStabilitySummary(runs, summary, { json: true, chaos }));
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0]!)).toEqual({ runs, stability: summary, chaos });
    expect(err).toContain('chaos seed: 7');
  });

  it('json without chaos has no chaos key (unchanged shape for an ordinary series)', () => {
    const { out } = capture(() => printStabilitySummary(runs, summarizeStability(runs), { json: true }));
    expect(Object.keys(JSON.parse(out[0]!) as object)).toEqual(['runs', 'stability']);
  });
});

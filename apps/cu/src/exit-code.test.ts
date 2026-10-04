/** ReplayResult -> process exit code mapping (apps/cu/src/exit-code.ts). */
import { describe, expect, it } from 'vitest';
import type { ReplayResult } from '@cu/core/schema';
import { CRASH_EXIT_CODE, exitCodeForResult } from './exit-code.js';

const base = { runId: 'r1', capabilityId: 'c1', capabilityVersion: '1.0.0', stepsExecuted: 1, durationMs: 1, locatorReport: [], recoveries: [] };

describe('exitCodeForResult', () => {
  it('success -> 0', () => {
    const result: ReplayResult = { ...base, kind: 'success', outputs: {} };
    expect(exitCodeForResult(result)).toBe(0);
  });

  it('business_outcome -> 3', () => {
    const result: ReplayResult = { ...base, kind: 'business_outcome', name: 'member_not_found', data: {} };
    expect(exitCodeForResult(result)).toBe(3);
  });

  it('hard_failure -> 4', () => {
    const result: ReplayResult = {
      ...base,
      kind: 'hard_failure',
      code: 'checkpoint_failed',
      expected: 'x',
      observed: 'y',
      message: 'z',
      evidence: {},
    };
    expect(exitCodeForResult(result)).toBe(4);
  });

  it('escalated -> 5, regardless of resolution', () => {
    const escalated = (resolution: 'resumed_success' | 'resumed_failed' | 'abandoned'): ReplayResult => ({
      ...base,
      kind: 'escalated',
      interventionId: 'i1',
      reason: 'stuck',
      resolution,
    });
    expect(exitCodeForResult(escalated('resumed_success'))).toBe(5);
    expect(exitCodeForResult(escalated('resumed_failed'))).toBe(5);
    expect(exitCodeForResult(escalated('abandoned'))).toBe(5);
  });

  it('CRASH_EXIT_CODE is 1 (uncaught top-level errors)', () => {
    expect(CRASH_EXIT_CODE).toBe(1);
  });
});

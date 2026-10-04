import { describe, expect, it } from 'vitest';
import { actionSignatureTarget, resolveLimits, StuckRepeatDetector } from './limits.js';
import type { Policy } from '../schema/index.js';

const POLICY_LIMITS: Policy['limits'] = { maxSteps: 40, maxDurationMs: 600_000, maxLlmCalls: 60 };

describe('resolveLimits', () => {
  it('uses the caller-supplied values when all three are finite positive integers', () => {
    expect(resolveLimits({ maxSteps: 5, maxLlmCalls: 6, maxDurationMs: 7000 }, POLICY_LIMITS)).toEqual({
      maxSteps: 5,
      maxLlmCalls: 6,
      maxDurationMs: 7000,
    });
  });

  it('floors a non-integer override', () => {
    expect(resolveLimits({ maxSteps: 5.9 }, POLICY_LIMITS).maxSteps).toBe(5);
  });

  it('falls back to policy.limits when no override is supplied', () => {
    expect(resolveLimits({}, POLICY_LIMITS)).toEqual(POLICY_LIMITS);
  });

  it.each([
    ['Infinity', Infinity],
    ['NaN', Number.NaN],
    ['zero', 0],
    ['negative', -1],
    ['-Infinity', -Infinity],
  ])('falls back to the policy value for maxSteps: %s', (_label, value) => {
    expect(resolveLimits({ maxSteps: value }, POLICY_LIMITS).maxSteps).toBe(POLICY_LIMITS.maxSteps);
  });

  it('falls back for maxLlmCalls and maxDurationMs the same way', () => {
    const resolved = resolveLimits({ maxLlmCalls: Infinity, maxDurationMs: Number.NaN }, POLICY_LIMITS);
    expect(resolved.maxLlmCalls).toBe(POLICY_LIMITS.maxLlmCalls);
    expect(resolved.maxDurationMs).toBe(POLICY_LIMITS.maxDurationMs);
  });

  it('treats a non-number value the same as an invalid one', () => {
    expect(resolveLimits({ maxSteps: '5' as unknown as number }, POLICY_LIMITS).maxSteps).toBe(POLICY_LIMITS.maxSteps);
  });
});

describe('actionSignatureTarget', () => {
  it('returns the target descriptor description for click/type/select/extract', () => {
    const target = { description: 'Search button', frame: [], locators: [{ strategy: { kind: 'text' as const, text: 'Search' }, confidence: 1, source: 'recorded' as const }] };
    expect(actionSignatureTarget({ type: 'click', target })).toBe('Search button');
    expect(actionSignatureTarget({ type: 'extract', target, output: 'o', parse: 'text' })).toBe('Search button');
  });

  it('returns the URL for navigate and the key for press', () => {
    expect(actionSignatureTarget({ type: 'navigate', url: 'http://x/y' })).toBe('http://x/y');
    expect(actionSignatureTarget({ type: 'press', key: 'Enter' })).toBe('Enter');
  });
});

describe('StuckRepeatDetector', () => {
  it('reports stuck once the identical action fails its expectation 3 times in a row', () => {
    const d = new StuckRepeatDetector();
    const sig = { tool: 'click', target: 'Search button', expect: 'Results' };
    expect(d.record(sig, false)).toBe(false);
    expect(d.record(sig, false)).toBe(false);
    expect(d.record(sig, false)).toBe(true);
  });

  it('never counts a call with no expect', () => {
    const d = new StuckRepeatDetector();
    const sig = { tool: 'press', target: 'Escape', expect: '' };
    for (let i = 0; i < 10; i++) expect(d.record(sig, undefined)).toBe(false);
  });

  it('resets the streak once the expectation is met', () => {
    const d = new StuckRepeatDetector();
    const sig = { tool: 'click', target: 'Search button', expect: 'Results' };
    expect(d.record(sig, false)).toBe(false);
    expect(d.record(sig, false)).toBe(false);
    expect(d.record(sig, true)).toBe(false);
    expect(d.record(sig, false)).toBe(false);
    expect(d.record(sig, false)).toBe(false);
    expect(d.record(sig, false)).toBe(true);
  });

  it('resets the streak when the action changes (different target, tool, or expect)', () => {
    const d = new StuckRepeatDetector();
    expect(d.record({ tool: 'click', target: 'A', expect: 'x' }, false)).toBe(false);
    expect(d.record({ tool: 'click', target: 'A', expect: 'x' }, false)).toBe(false);
    expect(d.record({ tool: 'click', target: 'B', expect: 'x' }, false)).toBe(false);
    expect(d.record({ tool: 'click', target: 'B', expect: 'x' }, false)).toBe(false);
    expect(d.record({ tool: 'click', target: 'B', expect: 'x' }, false)).toBe(true);
  });
});

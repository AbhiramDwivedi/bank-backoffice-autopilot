/**
 * `summarizeStability` keys its counters by strings that come from the artifact and from result
 * text: business-outcome names and recovery rule names (schema `Identifier`s, where `__proto__`
 * and `constructor` are legal), failure codes, escalation reasons. On plain `{}` counters a
 * `__proto__` key rewrote the counter's prototype (and could leave `({}).runs` reading NaN for the
 * whole process) and silently dropped the count; `constructor` read an inherited function. Every
 * keyed counter must be prototype-free.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { ReplayResult } from '../schema/index.js';
import { summarizeStability } from './describe.js';

const BASE = { runId: 'r', capabilityId: 'c', capabilityVersion: '1.0.0', stepsExecuted: 1, durationMs: 10, locatorReport: [] };

function bo(name: string, recoveries: string[]): ReplayResult {
  return { ...BASE, kind: 'business_outcome', name, data: {}, recoveries };
}

function escalated(reason: string): ReplayResult {
  return { ...BASE, kind: 'escalated', interventionId: 'i', reason, recoveries: [], outcome: { kind: 'business_outcome', name: '__proto__', data: {} } };
}

const PLAIN = {} as Record<string, unknown>;

afterEach(() => {
  // Nothing may have leaked onto Object.prototype.
  expect(Object.getPrototypeOf(PLAIN)).toBe(Object.prototype);
  expect('runs' in PLAIN).toBe(false);
  expect('fired' in PLAIN).toBe(false);
});

describe('summarizeStability: prototype-named keys', () => {
  it.each(['__proto__', 'constructor', 'toString', 'hasOwnProperty'])('counts a business outcome and a recovery rule named %s as ordinary keys', (key) => {
    const summary = summarizeStability([bo(key, [key, key]), bo(key, [key])]);
    expect(Object.keys(summary.businessOutcomes)).toEqual([key]);
    expect(summary.businessOutcomes[key]).toBe(2);
    expect(Object.keys(summary.recoveries)).toEqual([key]);
    expect(summary.recoveries[key]).toEqual({ fired: 3, runs: 2 });
    expect(summary.byKind.business_outcome).toBe(2);
  });

  it('escalation reasons and outcome names cannot pollute either', () => {
    const summary = summarizeStability([escalated('__proto__'), escalated('constructor')]);
    expect(summary.escalationBreakdown.reason.__proto__).toBe(1);
    expect(summary.escalationBreakdown.reason.constructor).toBe(1);
    expect(summary.escalationBreakdown.outcome['business_outcome:__proto__']).toBe(2);
    expect(Object.keys(summary.escalationBreakdown.reason).sort()).toEqual(['__proto__', 'constructor']);
  });

  it('every keyed counter is prototype-free and survives a JSON round trip with the key intact', () => {
    const summary = summarizeStability([bo('__proto__', ['__proto__'])]);
    for (const counts of [
      summary.businessOutcomes,
      summary.failures,
      summary.recoveries,
      summary.fallbackDepths,
      summary.escalationBreakdown.reason,
      summary.escalationBreakdown.resolution,
      summary.escalationBreakdown.outcome,
    ]) {
      expect(Object.getPrototypeOf(counts)).toBeNull();
    }
    expect(JSON.stringify(summary.businessOutcomes)).toBe('{"__proto__":1}');
  });
});

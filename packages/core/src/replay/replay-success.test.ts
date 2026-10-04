/**
 * The happy path, and the maintenance-notice recovery rule.
 */
import { describe, expect, it } from 'vitest';
import { createCuCoreSurface } from '../surface/fake-scenarios/cu-core.js';
import { makeFakeClock, runReplay } from './test-helpers.js';

describe('replay: success', () => {
  it('happy path: extracts typed outputs, every locator at depth 0, and logs the interstitial recovery', async () => {
    const { result, events, resultJson } = await runReplay();

    expect(result.kind).toBe('success');
    if (result.kind !== 'success') throw new Error('expected success');
    expect(result.outputs).toEqual({ memberName: 'Jane Q. Sample', savingsBalance: 1234.56 });
    expect(typeof result.outputs.savingsBalance).toBe('number');

    expect(result.locatorReport.length).toBeGreaterThan(0);
    expect(result.locatorReport.every((e) => e.fallbackDepth === 0)).toBe(true);

    expect(result.recoveries).toEqual(['dismiss_maintenance_notice']);

    const kinds = new Set(events.map((e) => e.kind));
    const expectedKinds = ['action', 'locator_resolved', 'checkpoint', 'recovery', 'run_finished'] as const;
    for (const expectedKind of expectedKinds) {
      expect(kinds.has(expectedKind)).toBe(true);
    }

    // result.json (redacted, but nothing here is a secret) must match the returned result exactly.
    expect(resultJson).toEqual(result);
  });

  it('the maintenance-notice recovery rule fires and is logged as a recovery event', async () => {
    const { events, result } = await runReplay();

    const recoveryEvents = events.filter((e) => e.kind === 'recovery');
    expect(recoveryEvents.length).toBeGreaterThan(0);
    expect(recoveryEvents[0]?.data.rule).toBe('dismiss_maintenance_notice');
    expect(recoveryEvents[0]?.data.ok).toBe(true);

    expect(result.kind).toBe('success');
    if (result.kind === 'success') expect(result.recoveries).toContain('dismiss_maintenance_notice');
  });

  it('recoveries is empty and no recovery event is logged when the interstitial is disabled', async () => {
    const clock = makeFakeClock();
    const surface = createCuCoreSurface({ clock, interstitial: false });
    const { result, events } = await runReplay({ surface, clock });

    expect(result.kind).toBe('success');
    if (result.kind === 'success') expect(result.recoveries).toEqual([]);
    expect(events.some((e) => e.kind === 'recovery')).toBe(false);
  });
});

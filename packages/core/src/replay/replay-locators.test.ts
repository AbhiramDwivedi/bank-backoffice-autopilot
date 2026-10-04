/** Locator drift (a fallback still resolves, but at depth > 0) and tenant B. */
import { describe, expect, it } from 'vitest';
import { createCuCoreSurface } from '../surface/fake-scenarios/cu-core.js';
import { describeResult, summarizeLocatorDrift } from './index.js';
import { BASE_B, makeFakeClock, runReplay } from './test-helpers.js';

describe('replay: locator drift', () => {
  it('a drifted label still resolves via a fallback locator: success with fallbackDepth > 0', async () => {
    const clock = makeFakeClock();
    const surface = createCuCoreSurface({ clock });
    // Drift the member-id field's label so the type step's top ('label') locator misses; the css
    // fallback still finds it, so the target resolves, just at a deeper strategy index. (s05 leads
    // with `label` since the example artifact was re-ordered to match what the real Playwright
    // surface resolves: see docs/design/integration.md, "Locator drift on the example".)
    surface.inject({ kind: 'drift', elementId: 'memberId', patch: { label: 'Member Number' } });

    const { result } = await runReplay({ surface, clock });

    expect(result.kind).toBe('success');
    if (result.kind !== 'success') throw new Error('expected success');

    const s05Entries = result.locatorReport.filter((e) => e.stepId === 's05');
    expect(s05Entries.length).toBeGreaterThan(0);
    expect(s05Entries.some((e) => e.fallbackDepth > 0)).toBe(true);

    const summary = summarizeLocatorDrift(result.locatorReport);
    expect(summary.drifted).toBeGreaterThan(0);
    expect(summary.driftedSteps).toContain('s05');
    expect(describeResult(result)).toMatch(/drift/i);
  });

  it('tenant B without the tenant override: the base capability still resolves the member-id field, but at fallbackDepth > 0', async () => {
    const clock = makeFakeClock();
    const surface = createCuCoreSurface({ tenant: 'b', interstitial: false, clock });

    const { result } = await runReplay({ surface, clock, baseUrl: BASE_B });

    expect(result.kind).toBe('success');
    if (result.kind !== 'success') throw new Error('expected success');
    const s05Entries = result.locatorReport.filter((e) => e.stepId === 's05');
    expect(s05Entries.length).toBeGreaterThan(0);
    expect(s05Entries.some((e) => e.fallbackDepth > 0)).toBe(true);
  });

  it('tenant B with the riverbend-fcu override: the patched target resolves at depth 0, and the override is logged', async () => {
    const clock = makeFakeClock();
    const surface = createCuCoreSurface({ tenant: 'b', interstitial: false, clock });

    const { result, events } = await runReplay({ surface, clock, baseUrl: BASE_B, tenant: 'riverbend-fcu' });

    expect(result.kind).toBe('success');
    if (result.kind !== 'success') throw new Error('expected success');
    const s05Entries = result.locatorReport.filter((e) => e.stepId === 's05');
    expect(s05Entries.length).toBeGreaterThan(0);
    expect(s05Entries.every((e) => e.fallbackDepth === 0)).toBe(true);

    const overrideEvent = events.find((e) => e.kind === 'observation' && (e.data as { override?: unknown }).override !== undefined);
    expect(overrideEvent).toBeDefined();
    const applied = (overrideEvent?.data as { override: { tenant: string; patchedSteps: string[] } }).override;
    expect(applied.tenant).toBe('riverbend-fcu');
    expect(applied.patchedSteps).toContain('s05');
  });
});

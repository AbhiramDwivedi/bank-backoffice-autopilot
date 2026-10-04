/**
 * Hard-failure codes that arise purely from the page or surface: element_not_found,
 * checkpoint_failed, app_error, navigation_failed, timeout, precondition_failed.
 */
import { describe, expect, it } from 'vitest';
import { createCuCoreSurface } from '../surface/fake-scenarios/cu-core.js';
import { validateCapability } from '../schema/index.js';
import { evidencePath, loadExample, makeFakeClock, runReplay } from './test-helpers.js';

describe('replay: element_not_found', () => {
  it('reports every tried locator strategy, with evidence written to disk', async () => {
    const clock = makeFakeClock();
    const surface = createCuCoreSurface({ clock });
    surface.inject({ kind: 'hide_element', elementId: 'search' });

    const { result, runDir } = await runReplay({ surface, clock });

    expect(result.kind).toBe('hard_failure');
    if (result.kind !== 'hard_failure') throw new Error('expected hard_failure');
    expect(result.code).toBe('element_not_found');
    expect(result.stepId).toBe('s06');
    expect(result.observed.toLowerCase()).toContain('no match');

    expect(result.evidence.screenshot).toBeDefined();
    expect(result.evidence.dom).toBeDefined();
    evidencePath(runDir, result.evidence.screenshot!);
    evidencePath(runDir, result.evidence.dom!);
  });
});

describe('replay: checkpoint_failed', () => {
  it('carries a page-text excerpt in `observed` when the postcondition text goes missing', async () => {
    const clock = makeFakeClock();
    const surface = createCuCoreSurface({ clock });
    // Removes the only element whose text is literally "Savings Balance" from the member detail
    // page, so s07's postcondition (text_visible "Savings Balance") fails -- with no business
    // outcome matching (no "Access Denied"/"No records found." text anywhere on this page).
    surface.inject({ kind: 'drift', elementId: 'savingsBalanceLabel', patch: { name: 'Balance Info', text: 'Balance Info' } });

    const { result } = await runReplay({ surface, clock });

    expect(result.kind).toBe('hard_failure');
    if (result.kind !== 'hard_failure') throw new Error('expected hard_failure');
    expect(result.code).toBe('checkpoint_failed');
    expect(result.stepId).toBe('s07');
    expect(result.observed.length).toBeGreaterThan(0);
    expect(result.observed).toMatch(/member/i);
  });
});

describe('replay: app_error', () => {
  it('the search step fails because of the "Application Error" page text', async () => {
    const clock = makeFakeClock();
    const surface = createCuCoreSurface({ clock, failSearch: true });

    const { result } = await runReplay({ surface, clock });

    expect(result.kind).toBe('hard_failure');
    if (result.kind !== 'hard_failure') throw new Error('expected hard_failure');
    expect(result.code).toBe('app_error');
    expect(result.stepId).toBe('s06');
    expect(result.observed).toMatch(/Application Error/);
  });
});

describe('replay: navigation_failed', () => {
  it('an injected navigation error fails s01 with code navigation_failed', async () => {
    const clock = makeFakeClock();
    const surface = createCuCoreSurface({ clock });
    surface.inject({ kind: 'act_error', match: { actionType: 'navigate' }, code: 'navigation_failed' });

    const { result } = await runReplay({ surface, clock });

    expect(result.kind).toBe('hard_failure');
    if (result.kind !== 'hard_failure') throw new Error('expected hard_failure');
    expect(result.code).toBe('navigation_failed');
    expect(result.stepId).toBe('s01');
  });
});

describe('replay: timeout', () => {
  it('(a) the overall maxDurationMs budget expiring mid-run is a hard_failure timeout with a stepId', async () => {
    const clock = makeFakeClock();
    const surface = createCuCoreSurface({ clock });
    // Consumed by s01's navigate act() call: totalLatency (1000ms) does not exceed that call's
    // own (budget-capped) timeout, so s01 itself succeeds, but the whole 1000ms maxDurationMs
    // budget is now spent -- s02 finds the automation deadline already passed before it can start.
    surface.inject({ kind: 'delay', ms: 1000 });

    const { result } = await runReplay({ surface, clock, maxDurationMs: 1000, stepTimeoutMs: 5000 });

    expect(result.kind).toBe('hard_failure');
    if (result.kind !== 'hard_failure') throw new Error('expected hard_failure');
    expect(result.code).toBe('timeout');
    expect(result.stepId).toBe('s02');
    expect(result.message).toMatch(/maxDurationMs/);
  });

  it('(b) a wait action whose condition never holds times out on its own step timeout', async () => {
    const cap = structuredClone(loadExample());
    const s04Index = cap.steps.findIndex((s) => s.id === 's04');
    cap.steps.splice(s04Index + 1, 0, {
      id: 'sWait',
      name: 'Wait for text that will never appear (test only)',
      risk: 'read',
      timeoutMs: 150,
      action: { type: 'wait', condition: { kind: 'text_visible', text: 'This Text Never Appears On Any Screen' } },
    });
    const validated = validateCapability(cap);
    if (!validated.ok) throw new Error(JSON.stringify(validated.issues));

    const { result } = await runReplay({ capability: validated.capability });

    expect(result.kind).toBe('hard_failure');
    if (result.kind !== 'hard_failure') throw new Error('expected hard_failure');
    expect(result.code).toBe('timeout');
    expect(result.stepId).toBe('sWait');
  });
});

describe('replay: precondition_failed', () => {
  it('hiding the member-id field fails s05 with precondition_failed (checked before the action)', async () => {
    const clock = makeFakeClock();
    const surface = createCuCoreSurface({ clock, interstitial: false });
    surface.inject({ kind: 'hide_element', elementId: 'memberId' });

    const { result } = await runReplay({ surface, clock });

    expect(result.kind).toBe('hard_failure');
    if (result.kind !== 'hard_failure') throw new Error('expected hard_failure');
    expect(result.code).toBe('precondition_failed');
    expect(result.stepId).toBe('s05');
  });
});

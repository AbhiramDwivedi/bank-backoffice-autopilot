/**
 * Replay never settles an ambiguity by position, and never reads by position when the chain has a
 * named way to find the value (docs/design/replay.md, "Positional fallbacks";
 * surface/positional-fallback.ts). Before this rule, each "refused" case below ended in `success`
 * with whatever sat at the fallback's position: on a page listing two records, the other record's
 * value.
 *
 * Runs the example capability on the in-memory cu-core scenario, drifted so that a locator that
 * names its target is ambiguous or misses while a positional one still matches.
 */
import { describe, expect, it } from 'vitest';
import type { Capability, Condition, Locator, TargetDescriptor } from '../schema/index.js';
import { createCuCoreSurface } from '../surface/fake-scenarios/cu-core.js';
import { loadExample, makeFakeClock, runReplay } from './test-helpers.js';

const SAVINGS_CSS = '#pnlProfile tr:nth-child(6) td.val';
const SEARCH_POSITION_CSS = 'td:nth-of-type(2) > div:nth-of-type(1)';
const loc = (strategy: Locator['strategy'], confidence = 0.5): Locator => ({ strategy, confidence, source: 'recorded' });

/** The example, with one step's target chain replaced. */
function withChain(stepId: string, locators: Locator[]): Capability {
  const cap = structuredClone(loadExample());
  const step = cap.steps.find((s) => s.id === stepId);
  if (!step || !('target' in step.action)) throw new Error(`no target on ${stepId}`);
  step.action.target = { ...step.action.target, locators };
  return cap;
}

/** A member page that shows a second "Savings Balance" label: the label of the checking row now
 *  reads the same, and the checking VALUE sits where the recorded structural css points. */
function twoSavingsLabels(): ReturnType<typeof createCuCoreSurface> {
  const clock = makeFakeClock();
  const surface = createCuCoreSurface({ clock });
  surface.inject({ kind: 'drift', elementId: 'checkingBalanceLabel', patch: { name: 'Savings Balance', text: 'Savings Balance' } });
  surface.inject({ kind: 'drift', elementId: 'checkingBalance', patch: { css: [SAVINGS_CSS] } });
  return surface;
}

describe('replay: a positional fallback never settles an ambiguity (rule a)', () => {
  it('extract: two "Savings Balance" labels, a structural css still matches one cell -> element_not_found naming the 2 candidates, no value returned', async () => {
    const { result, events } = await runReplay({ surface: twoSavingsLabels() });

    expect(result.kind).toBe('hard_failure');
    if (result.kind !== 'hard_failure') throw new Error('expected hard_failure');
    expect(result.code).toBe('element_not_found');
    expect(result.stepId).toBe('s09');
    expect(result.message).toMatch(/2 candidates matched the relative locator/);
    expect(result.message).toMatch(/does not settle an ambiguity by position/);
    expect(result.observed).toMatch(/relative: ambiguous anchor: 2 matches/);
    expect(result.observed).toMatch(/positional css locator at depth 1 matched and was not used/);
    // The refused resolution is not reported as a used locator, and nothing was read through it.
    expect(result.locatorReport.some((e) => e.stepId === 's09')).toBe(false);
    expect(events.some((e) => e.kind === 'locator_resolved' && e.stepId === 's09')).toBe(false);
    expect(events.some((e) => e.kind === 'action_result' && e.stepId === 's09')).toBe(false);
  });

  it('click: an ambiguous text locator is not settled by a structural css', async () => {
    const clock = makeFakeClock();
    const surface = createCuCoreSurface({ clock });
    // A second control reads "Search" (as a list page repeating a control per row would), and the
    // recorded structural css still matches exactly one of them.
    surface.inject({ kind: 'drift', elementId: 'lastNameLabel', patch: { name: 'Search', text: 'Search', tag: 'div' } });
    surface.inject({ kind: 'drift', elementId: 'search', patch: { css: [SEARCH_POSITION_CSS] } });
    const capability = withChain('s06', [loc({ kind: 'text', text: 'Search', tag: 'div' }, 0.75), loc({ kind: 'css', selector: SEARCH_POSITION_CSS }, 0.3)]);

    const { result, events } = await runReplay({ surface, clock, capability });

    expect(result.kind).toBe('hard_failure');
    if (result.kind !== 'hard_failure') throw new Error('expected hard_failure');
    expect(result.code).toBe('element_not_found');
    expect(result.stepId).toBe('s06');
    expect(result.message).toMatch(/2 candidates matched the text locator/);
    // Nothing was clicked for s06: no action result, and the search was never submitted.
    expect(events.some((e) => e.kind === 'action_result' && e.stepId === 's06')).toBe(false);
    expect(surface.currentScreenId()).toBe('workstation');
  });

  it('click: an ambiguous text locator followed by an IDENTITY css still resolves (not positional)', async () => {
    const clock = makeFakeClock();
    const surface = createCuCoreSurface({ clock });
    surface.inject({ kind: 'drift', elementId: 'lastNameLabel', patch: { name: 'Search', text: 'Search', tag: 'div' } });

    const { result } = await runReplay({ surface, clock });

    expect(result.kind).toBe('success');
    if (result.kind !== 'success') throw new Error('expected success');
    expect(result.locatorReport.find((e) => e.stepId === 's06')).toMatchObject({ strategyKind: 'css', fallbackDepth: 1 });
  });

  it('click: a naming locator that simply MISSES still self-heals through a structural css (an action keeps its positional fallback)', async () => {
    const clock = makeFakeClock();
    const surface = createCuCoreSurface({ clock });
    surface.inject({ kind: 'drift', elementId: 'search', patch: { name: 'Find', text: 'Find', css: [SEARCH_POSITION_CSS] } });
    const capability = withChain('s06', [loc({ kind: 'text', text: 'Search', tag: 'div' }, 0.75), loc({ kind: 'css', selector: SEARCH_POSITION_CSS }, 0.3)]);

    const { result } = await runReplay({ surface, clock, capability });

    expect(result.kind).toBe('success');
    if (result.kind !== 'success') throw new Error('expected success');
    expect(result.locatorReport.find((e) => e.stepId === 's06')).toMatchObject({ strategyKind: 'css', fallbackDepth: 1 });
  });
});

describe('replay: a read never falls back to a position the chain could have named (rule b)', () => {
  it('extract: the naming locator misses, a structural css still matches a cell -> element_not_found, no value returned', async () => {
    const clock = makeFakeClock();
    const surface = createCuCoreSurface({ clock });
    // The savings value is no longer a <td> (the relative locator filters on tag td, so it misses),
    // and the recorded structural css now points at the checking value.
    surface.inject({ kind: 'drift', elementId: 'savingsBalance', patch: { tag: 'span' } });
    surface.inject({ kind: 'drift', elementId: 'checkingBalance', patch: { css: [SAVINGS_CSS] } });

    const { result } = await runReplay({ surface, clock });

    expect(result.kind).toBe('hard_failure');
    if (result.kind !== 'hard_failure') throw new Error('expected hard_failure');
    expect(result.code).toBe('element_not_found');
    expect(result.stepId).toBe('s09');
    expect(result.message).toMatch(/a positional fallback \(css at depth 1\) was not used for a read/);
    expect(result.observed).toMatch(/no locator that names it matched \(relative: no match\)/);
    expect(result.locatorReport.some((e) => e.stepId === 's09')).toBe(false);
  });

  it('extract: a chain of positional locators only is still read by position (nothing names the value; the validator warns)', async () => {
    const clock = makeFakeClock();
    const surface = createCuCoreSurface({ clock });
    surface.inject({ kind: 'drift', elementId: 'savingsBalance', patch: { css: [SAVINGS_CSS] } });
    const capability = withChain('s09', [loc({ kind: 'css', selector: SAVINGS_CSS }, 0.4)]);

    const { result } = await runReplay({ surface, clock, capability });

    expect(result.kind).toBe('success');
    if (result.kind !== 'success') throw new Error('expected success');
    expect(result.outputs.savingsBalance).toBe(1234.56);
  });

  it('extract: an identity css fallback (not positional) still reads', async () => {
    const clock = makeFakeClock();
    const surface = createCuCoreSurface({ clock });
    surface.inject({ kind: 'drift', elementId: 'savingsBalance', patch: { tag: 'span', css: ['span#savingsBalance'] } });
    const capability = withChain('s09', [
      loc({ kind: 'relative', anchor: { text: 'Savings Balance' }, relation: 'right-of', tag: 'td' }, 0.75),
      loc({ kind: 'css', selector: 'span#savingsBalance' }, 0.4),
    ]);

    const { result } = await runReplay({ surface, clock, capability });

    expect(result.kind).toBe('success');
    if (result.kind !== 'success') throw new Error('expected success');
    expect(result.outputs.savingsBalance).toBe(1234.56);
    expect(result.locatorReport.find((e) => e.stepId === 's09')).toMatchObject({ strategyKind: 'css', fallbackDepth: 1 });
  });

  it('business outcome extract: read only through a naming locator; a bbox fallback leaves the key missing', async () => {
    const clock = makeFakeClock();
    const surface = createCuCoreSurface({ clock });
    // The denied message is no longer a <p class="denied"> (text tag=p and css both miss), but it
    // still sits where the recorded bbox points.
    const cap = loadExample();
    const bbox = cap.businessOutcomes.find((b) => b.name === 'access_denied')!.extract![0]!.target.locators.find((l) => l.strategy.kind === 'bbox')!.strategy;
    if (bbox.kind !== 'bbox') throw new Error('expected a bbox');
    surface.inject({
      kind: 'drift',
      elementId: 'deniedMsg',
      patch: { tag: 'span', css: ['span.msg'], bbox: { x: bbox.x * 1280, y: bbox.y * 800, w: bbox.w * 1280, h: bbox.h * 800 } },
    });

    const { result, events } = await runReplay({ surface, clock, inputs: { memberId: '90001' } });

    expect(result.kind).toBe('business_outcome');
    if (result.kind !== 'business_outcome') throw new Error('expected business_outcome');
    expect(result.name).toBe('access_denied');
    expect(result.data.message).toBeUndefined();
    expect(result.missing).toEqual(['message']);
    const refused = events.find((e) => e.kind === 'error' && e.data.outcome === 'access_denied' && e.data.output === 'message');
    expect(refused?.data.code).toBe('element_not_found');
    expect(String(refused?.data.message)).toMatch(/a positional fallback \(bbox at depth 2\) was not used for a read/);
  });
});

describe('replay: recovery actions and element conditions follow rule (a)', () => {
  const okTarget = (cap: Capability): TargetDescriptor => {
    const action = cap.recoveryRules[0]!.actions[0]!;
    if (action.type !== 'click') throw new Error('expected a click');
    return action.target;
  };

  it('a recovery click is not performed through a positional css after an ambiguous text locator', async () => {
    const clock = makeFakeClock();
    const surface = createCuCoreSurface({ clock });
    surface.inject({ kind: 'drift', elementId: 'maintTitle', patch: { name: 'System Maintenance Notice OK', text: 'System Maintenance Notice OK', tag: 'div' } });
    surface.inject({ kind: 'drift', elementId: 'maintOk', patch: { css: ['div:nth-of-type(3) > div'] } });
    const capability = structuredClone(loadExample());
    okTarget(capability).locators = [loc({ kind: 'text', text: 'OK', tag: 'div' }, 0.75), loc({ kind: 'css', selector: 'div:nth-of-type(3) > div' }, 0.3)];

    const { result, events } = await runReplay({ surface, clock, capability });

    // The notice stays up, so the step behind it fails on its own merits; the recovery reports ok:false.
    expect(result.kind).toBe('hard_failure');
    const recoveries = events.filter((e) => e.kind === 'recovery');
    expect(recoveries.length).toBeGreaterThan(0);
    expect(recoveries.every((e) => e.data.ok === false)).toBe(true);
    expect(events.some((e) => e.kind === 'error' && /recovery action not performed: 2 candidates matched the text locator/.test(String(e.data.message)))).toBe(true);
    // The notice was never dismissed.
    expect(surface.currentScreenId()).toBe('workstation_notice');
  });

  it('element_visible does not hold through a positional locator after an ambiguity; a plain miss still falls back', async () => {
    const savingsCell = (cap: Capability): TargetDescriptor => {
      const s09 = cap.steps.find((s) => s.id === 's09')!;
      if (s09.action.type !== 'extract') throw new Error('expected an extract');
      return s09.action.target;
    };
    const withPrecondition = (): Capability => {
      const cap = structuredClone(loadExample());
      const s09 = cap.steps.find((s) => s.id === 's09')!;
      const precondition: Condition = { kind: 'element_visible', target: structuredClone(savingsCell(cap)) };
      s09.precondition = precondition;
      return cap;
    };

    const ambiguous = await runReplay({ surface: twoSavingsLabels(), capability: withPrecondition() });
    expect(ambiguous.result.kind).toBe('hard_failure');
    if (ambiguous.result.kind !== 'hard_failure') throw new Error('expected hard_failure');
    expect(ambiguous.result.code).toBe('precondition_failed');
    expect(ambiguous.result.stepId).toBe('s09');

    // The naming locator merely misses (no ambiguity): the checkpoint still holds through the css,
    // as before. The extract behind it is then refused by rule (b).
    const clock = makeFakeClock();
    const surface = createCuCoreSurface({ clock });
    surface.inject({ kind: 'drift', elementId: 'savingsBalance', patch: { tag: 'span', css: [SAVINGS_CSS] } });
    const missed = await runReplay({ surface, clock, capability: withPrecondition() });
    expect(missed.result.kind).toBe('hard_failure');
    if (missed.result.kind !== 'hard_failure') throw new Error('expected hard_failure');
    expect(missed.events.some((e) => e.kind === 'checkpoint' && e.stepId === 's09' && e.data.phase === 'pre' && e.data.ok === true)).toBe(true);
    expect(missed.result.code).toBe('element_not_found');
    expect(missed.result.message).toMatch(/was not used for a read/);
  });
});

describe('replay: positional-ness is judged on the target as recorded, before binding', () => {
  it('a css bound to the input ("tr[onclick*=/members/{input.memberId}]") is identity, although its bound form ends in a number', async () => {
    const clock = makeFakeClock();
    const surface = createCuCoreSurface({ clock });
    // Two rows read the member id; the input-bound css still names exactly one. Judged after
    // binding, `tr[onclick*="/members/12345"]` ends in a number and would count as a position.
    surface.inject({ kind: 'drift', elementId: 'lastNameLabel', patch: { name: 'Row 12345', text: 'Row 12345', tag: 'tr' } });

    const { result } = await runReplay({ surface, clock });

    expect(result.kind).toBe('success');
    if (result.kind !== 'success') throw new Error('expected success');
    expect(result.locatorReport.find((e) => e.stepId === 's07')).toMatchObject({ strategyKind: 'css', fallbackDepth: 1 });
  });
});

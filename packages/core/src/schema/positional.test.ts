/**
 * `isPositional` / `isPositionalOnly` (shared by the recorder, replay and the validator) and the
 * validator's `positional_only_target` warning. The recorder's own cases for `isPositional` are in
 * agent/recorder-scope.test.ts.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Capability, Locator, TargetDescriptor } from './index.js';
import { isPositional, isPositionalOnly } from './positional.js';
import { validateCapability } from './validate.js';

const loc = (strategy: Locator['strategy']): Locator => ({ strategy, confidence: 0.5, source: 'recorded' });
const css = (selector: string): Locator => loc({ kind: 'css', selector });
const bbox = loc({ kind: 'bbox', x: 0.1, y: 0.1, w: 0.1, h: 0.1 });
const target = (...locators: Locator[]): TargetDescriptor => ({ description: 'balance cell', frame: [], locators });

function load(relative: string): Capability {
  const result = validateCapability(JSON.parse(readFileSync(new URL(relative, import.meta.url), 'utf8')));
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.capability;
}
const example = (): Capability => structuredClone(load('../../../../artifacts/examples/lookup-member-savings-balance.example.json'));

function positionalWarnings(cap: Capability): { path: (string | number)[]; message: string }[] {
  const result = validateCapability(cap);
  if (!result.ok) throw new Error(`expected valid, got: ${JSON.stringify(result.issues)}`);
  return result.warnings.filter((w) => w.code === 'positional_only_target').map((w) => ({ path: w.path, message: w.message }));
}

describe('isPositional / isPositionalOnly', () => {
  it('a bbox and a structural css are positions; every other kind names the element', () => {
    expect(isPositional(bbox)).toBe(true);
    expect(isPositional(css('tr:nth-of-type(6) > td:nth-of-type(2)'))).toBe(true);
    expect(isPositional(css('td > table > tbody > tr > td'))).toBe(true);
    expect(isPositional(css('input[type="text"][name="memberId"]'))).toBe(false);
    expect(isPositional(loc({ kind: 'role', role: 'button', name: 'Search' }))).toBe(false);
    expect(isPositional(loc({ kind: 'label', label: 'Member ID' }))).toBe(false);
    expect(isPositional(loc({ kind: 'text', text: 'Search' }))).toBe(false);
    expect(isPositional(loc({ kind: 'relative', anchor: { text: 'Savings Balance' }, relation: 'right-of' }))).toBe(false);
    expect(isPositional(loc({ kind: 'automation_id', id: 'txtMember' }))).toBe(false);
  });

  it('a css attribute holding a run input is identity as recorded, and would be a position once bound', () => {
    expect(isPositional(css('a[href="/members/{input.memberId}"]'))).toBe(false);
    expect(isPositional(css('a[href="/members/12345"]'))).toBe(true);
  });

  it('isPositionalOnly: every locator of the chain is a position', () => {
    expect(isPositionalOnly(target(css('tr:nth-of-type(6) > td:nth-of-type(2)'), bbox))).toBe(true);
    expect(isPositionalOnly(target(bbox))).toBe(true);
    expect(isPositionalOnly(target(loc({ kind: 'relative', anchor: { text: 'Savings Balance' }, relation: 'right-of' }), bbox))).toBe(false);
    expect(isPositionalOnly(target(css('td#balance'), bbox))).toBe(false);
  });
});

describe('validateCapability: positional_only_target warning', () => {
  it('the shipped artifact and the example raise none: every extract chain names its value', () => {
    expect(positionalWarnings(load('../../../../artifacts/lookup-member-savings-balance.json'))).toEqual([]);
    expect(positionalWarnings(example())).toEqual([]);
  });

  it('warns, without failing validation, for an extract step whose chain is positional only', () => {
    const cap = example();
    const i = cap.steps.findIndex((s) => s.id === 's09');
    const step = cap.steps[i]!;
    if (step.action.type !== 'extract') throw new Error('expected an extract');
    step.action.target.locators = [css('#pnlProfile tr:nth-child(6) td.val'), bbox];

    const warnings = positionalWarnings(cap);
    expect(warnings.map((w) => w.path)).toEqual([['steps', i, 'action', 'target']]);
    expect(warnings[0]!.message).toMatch(/step "s09" reads ".*" through positional locators only \(css, bbox\)/);
    expect(warnings[0]!.message).toMatch(/Add a locator that names the value/);
  });

  it('does not warn for a click, type or select with a positional-only chain: an action has its checkpoint', () => {
    const cap = example();
    const step = cap.steps.find((s) => s.id === 's06')!;
    if (step.action.type !== 'click') throw new Error('expected a click');
    step.action.target.locators = [css('td:nth-of-type(2) > div:nth-of-type(1)'), bbox];
    expect(positionalWarnings(cap)).toEqual([]);
  });

  it('covers a business outcome extract', () => {
    const cap = example();
    const bi = cap.businessOutcomes.findIndex((b) => b.name === 'access_denied');
    cap.businessOutcomes[bi]!.extract![0]!.target.locators = [bbox];
    const warnings = positionalWarnings(cap);
    expect(warnings.map((w) => w.path)).toEqual([['businessOutcomes', bi, 'extract', 0, 'target']]);
    expect(warnings[0]!.message).toMatch(/business outcome "access_denied"/);
  });

  it('covers a tenant override that retargets an extract step, and an extract it adds', () => {
    const cap = example();
    const s09 = cap.steps.find((s) => s.id === 's09')!;
    const override = cap.overrides![0]!;
    override.stepPatches.push({ stepId: 's09', target: target(css('tr:nth-of-type(6) > td:nth-of-type(2)')) });
    override.extraSteps = [{ afterStepId: 's09', step: { ...structuredClone(s09), id: 's09b', action: { type: 'extract', target: target(bbox), output: 'savingsBalance', parse: 'currency' } } }];
    const paths = positionalWarnings(cap).map((w) => w.path);
    const oi = 0;
    expect(paths).toEqual([
      ['overrides', oi, 'stepPatches', override.stepPatches.length - 1, 'target'],
      ['overrides', oi, 'extraSteps', 0, 'step', 'action', 'target'],
    ]);
  });
});

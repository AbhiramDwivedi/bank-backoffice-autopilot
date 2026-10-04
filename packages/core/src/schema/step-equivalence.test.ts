/**
 * The redundant-repeat predicate (step-equivalence.ts) and the `redundant_repeated_step` warning
 * it drives in `validateCapability`: a warning, never an error, so an artifact nobody re-optimizes
 * still validates and replays, but `cu validate` says what is wrong with it.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Step } from './index.js';
import { findRedundantRepeats, isRedundantRepeat, jsonEqual } from './step-equivalence.js';
import { validateCapability } from './validate.js';

const SHIPPED = new URL('../../../../artifacts/lookup-member-savings-balance.json', import.meta.url);
const EXAMPLE = new URL('../../../../artifacts/examples/lookup-member-savings-balance.example.json', import.meta.url);

const field = {
  description: 'field',
  frame: [],
  locators: [{ strategy: { kind: 'label' as const, label: 'Password' }, confidence: 0.8, source: 'inferred' as const }],
};

function typeStep(id: string, extra: Partial<Step> = {}, action: Record<string, unknown> = {}): Step {
  return { id, name: 'Type', action: { type: 'type', target: field, value: { kind: 'secret', env: 'P' }, clear: true, ...action }, risk: 'reversible', ...extra } as Step;
}

describe('isRedundantRepeat', () => {
  it('holds for identical cleared type steps, and for identical selects on a real <select>', () => {
    expect(isRedundantRepeat(typeStep('a'), typeStep('b'))).toBe(true);
    const sel = (id: string, tag: string | undefined): Step => ({
      id,
      name: 'Pick',
      action: { type: 'select', target: { ...field, ...(tag !== undefined ? { snapshot: { tag } } : {}) }, value: { kind: 'literal', value: 'x' } },
      risk: 'reversible',
    });
    expect(isRedundantRepeat(sel('a', 'select'), sel('b', 'select'))).toBe(true);
    // A custom dropdown is driven as click-open + click-option: only as idempotent as two clicks.
    expect(isRedundantRepeat(sel('a', 'div'), sel('b', 'div'))).toBe(false);
    expect(isRedundantRepeat(sel('a', undefined), sel('b', undefined))).toBe(false);
  });

  it('does not hold when anything that matters differs', () => {
    expect(isRedundantRepeat(typeStep('a'), typeStep('b', {}, { clear: false }))).toBe(false);
    expect(isRedundantRepeat(typeStep('a', {}, { pressEnter: true }), typeStep('b', {}, { pressEnter: true }))).toBe(false);
    expect(isRedundantRepeat(typeStep('a'), typeStep('b', {}, { value: { kind: 'secret', env: 'Q' } }))).toBe(false);
    expect(isRedundantRepeat(typeStep('a'), typeStep('b', { risk: 'read' }))).toBe(false);
    expect(isRedundantRepeat(typeStep('a'), typeStep('b', { onFailure: 'escalate' }))).toBe(false);
    expect(isRedundantRepeat(typeStep('a'), typeStep('b', { timeoutMs: 5 }))).toBe(false);
    const p1 = { kind: 'text_visible' as const, text: 'A' };
    const p2 = { kind: 'text_visible' as const, text: 'B' };
    expect(isRedundantRepeat(typeStep('a', { postcondition: p1 }), typeStep('b', { postcondition: p2 }))).toBe(false);
    expect(isRedundantRepeat(typeStep('a'), typeStep('b', { precondition: p1 }))).toBe(false);
    // ... while one postcondition, or equal ones, are fine.
    expect(isRedundantRepeat(typeStep('a'), typeStep('b', { postcondition: p1 }))).toBe(true);
    expect(isRedundantRepeat(typeStep('a', { postcondition: p1 }), typeStep('b', { postcondition: p1 }))).toBe(true);
    const click = (id: string): Step => ({ id, name: 'Click', action: { type: 'click', target: field }, risk: 'reversible' });
    expect(isRedundantRepeat(click('a'), click('b'))).toBe(false);
  });

  it('jsonEqual ignores key order and undefined members', () => {
    expect(jsonEqual({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1, d: undefined })).toBe(true);
    expect(jsonEqual({ a: 1 }, { a: '1' })).toBe(false);
  });

  it('finds runs, comparing against the run head with the merged postcondition', () => {
    const p1 = { kind: 'text_visible' as const, text: 'A' };
    const p2 = { kind: 'text_visible' as const, text: 'B' };
    const steps = [typeStep('s1'), typeStep('s2', { postcondition: p1 }), typeStep('s3'), typeStep('s4', { postcondition: p2 })];
    expect(findRedundantRepeats(steps).map((r) => [r.stepId, r.repeatOf])).toEqual([
      ['s2', 's1'],
      ['s3', 's1'],
    ]);
  });
});

describe('validateCapability: redundant_repeated_step warning', () => {
  it('flags s04 of the shipped artifact as a repeat of s03, as a warning only', () => {
    const res = validateCapability(JSON.parse(readFileSync(SHIPPED, 'utf8')));
    expect(res.ok).toBe(true);
    const warnings = res.ok ? res.warnings.filter((w) => w.code === 'redundant_repeated_step') : [];
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.path).toEqual(['steps', 3]);
    expect(warnings[0]!.message).toContain('"s04" repeats step "s03"');
  });

  it('is silent on the hand-written example', () => {
    const res = validateCapability(JSON.parse(readFileSync(EXAMPLE, 'utf8')));
    expect(res.ok && res.warnings.filter((w) => w.code === 'redundant_repeated_step')).toEqual([]);
  });
});

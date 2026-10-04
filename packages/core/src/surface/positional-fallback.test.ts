/** The rule itself, as a pure function of the recorded chain and what the surface reported. */
import { describe, expect, it } from 'vitest';
import type { Locator, TargetDescriptor } from '../schema/index.js';
import { positionalFallbackRefusal } from './positional-fallback.js';
import type { TriedStrategy } from './types.js';

const loc = (strategy: Locator['strategy']): Locator => ({ strategy, confidence: 0.5, source: 'recorded' });
const target = (...locators: Locator[]): TargetDescriptor => ({ description: 'cell right of "Savings Balance"', frame: [], locators });

const label = loc({ kind: 'label', label: 'Savings Balance' });
const relative = loc({ kind: 'relative', anchor: { text: 'Savings Balance' }, relation: 'right-of' });
const structuralCss = loc({ kind: 'css', selector: 'tr:nth-of-type(6) > td:nth-of-type(2)' });
const identityCss = loc({ kind: 'css', selector: 'input[name="memberId"]' });
const bbox = loc({ kind: 'bbox', x: 0.1, y: 0.1, w: 0.1, h: 0.1 });

const miss = (strategyKind: string, error = 'no match'): TriedStrategy => ({ strategyKind, error });
const ambiguous = (strategyKind: string, matches: number): TriedStrategy => ({ strategyKind, error: `ambiguous: ${matches} matches`, ambiguous: true, matches });

describe('positionalFallbackRefusal', () => {
  it('a winner at depth zero that names the element is used, read or not', () => {
    expect(positionalFallbackRefusal(target(relative, structuralCss, bbox), { strategyIndex: 0, tried: [] }, { read: true })).toBeUndefined();
    expect(positionalFallbackRefusal(target(label, structuralCss), { strategyIndex: 0, tried: [] }, { read: false })).toBeUndefined();
  });

  it('(a) a positional winner after an ambiguous naming locator is refused for every use, and the refusal says how many matched', () => {
    for (const read of [false, true]) {
      const r = positionalFallbackRefusal(target(relative, structuralCss, bbox), { strategyIndex: 1, tried: [ambiguous('relative', 2)] }, { read });
      expect(r?.reason).toBe('ambiguous');
      expect(r?.ambiguous).toEqual({ index: 0, kind: 'relative', matches: 2 });
      expect(r?.winner).toEqual({ index: 1, kind: 'css' });
      expect(r?.message).toBe(
        '2 candidates matched the relative locator of "cell right of "Savings Balance""; replay does not settle an ambiguity by position (css fallback at depth 1 not used)',
      );
      expect(r?.expected).toMatch(/exactly one match for a locator that names/);
      expect(r?.observed).toMatch(/2 candidates matched its relative locator \(relative: ambiguous: 2 matches\); the positional css locator at depth 1 matched and was not used/);
    }
  });

  it('(a) the ambiguity can sit anywhere before the winner, and a bbox winner is refused too', () => {
    const r = positionalFallbackRefusal(
      target(label, relative, structuralCss, bbox),
      { strategyIndex: 3, tried: [ambiguous('label', 3), miss('relative', 'no anchor match'), miss('css')] },
      { read: false },
    );
    expect(r?.reason).toBe('ambiguous');
    expect(r?.ambiguous).toEqual({ index: 0, kind: 'label', matches: 3 });
    expect(r?.winner).toEqual({ index: 3, kind: 'bbox' });
  });

  it('(a) an ambiguous naming locator followed by a winner that names the element is used', () => {
    expect(positionalFallbackRefusal(target(label, relative, bbox), { strategyIndex: 1, tried: [ambiguous('label', 2)] }, { read: true })).toBeUndefined();
    expect(positionalFallbackRefusal(target(label, identityCss), { strategyIndex: 1, tried: [ambiguous('label', 2)] }, { read: false })).toBeUndefined();
  });

  it('(a) an ambiguous POSITIONAL locator before a positional winner is not this rule (an action keeps its fallbacks)', () => {
    expect(positionalFallbackRefusal(target(label, structuralCss, bbox), { strategyIndex: 2, tried: [miss('label'), ambiguous('css', 4)] }, { read: false })).toBeUndefined();
  });

  it('an action whose naming locators all miss still falls back to a position', () => {
    expect(positionalFallbackRefusal(target(label, relative, structuralCss), { strategyIndex: 2, tried: [miss('label'), miss('relative')] }, { read: false })).toBeUndefined();
  });

  it('(b) a read is refused when a positional locator wins and the chain names the element', () => {
    const r = positionalFallbackRefusal(target(relative, structuralCss, bbox), { strategyIndex: 1, tried: [miss('relative', 'no anchor match')] }, { read: true });
    expect(r?.reason).toBe('positional_read');
    expect(r?.message).toBe('a positional fallback (css at depth 1) was not used for a read of "cell right of "Savings Balance"": none of the locators that name it matched');
    expect(r?.observed).toBe('no locator that names it matched (relative: no anchor match); the positional css locator at depth 1 matched and was not used');
  });

  it('(b) a naming locator listed AFTER the positional winner was never tried: still refused, and the refusal says so', () => {
    const r = positionalFallbackRefusal(target(structuralCss, relative), { strategyIndex: 0, tried: [] }, { read: true });
    expect(r?.reason).toBe('positional_read');
    expect(r?.observed).toMatch(/the locators that name it \(relative\) come after the positional one and were not tried/);
  });

  it('(b) a read through a chain of positional locators only is not refused: there is nothing to compare a position against', () => {
    expect(positionalFallbackRefusal(target(structuralCss, bbox), { strategyIndex: 0, tried: [] }, { read: true })).toBeUndefined();
    expect(positionalFallbackRefusal(target(structuralCss, bbox), { strategyIndex: 1, tried: [miss('css')] }, { read: true })).toBeUndefined();
  });

  it('judges the chain as recorded: a css bound to an input is identity, its bound form would be a position', () => {
    const recorded = target(label, loc({ kind: 'css', selector: 'a[href="/members/{input.memberId}"]' }));
    const bound = target(label, loc({ kind: 'css', selector: 'a[href="/members/\\31 2345"]' }));
    const found = { strategyIndex: 1, tried: [ambiguous('label', 2)] };
    expect(positionalFallbackRefusal(recorded, found, { read: true })).toBeUndefined();
    expect(positionalFallbackRefusal(bound, found, { read: true })?.reason).toBe('ambiguous');
  });

  it('an ambiguity without a count is still an ambiguity', () => {
    const r = positionalFallbackRefusal(target(label, bbox), { strategyIndex: 1, tried: [{ strategyKind: 'label', error: 'ambiguous', ambiguous: true }] }, { read: false });
    expect(r?.message).toMatch(/^several candidates matched the label locator/);
  });

  it('a winner index outside the recorded chain is left alone', () => {
    expect(positionalFallbackRefusal(target(label), { strategyIndex: 3, tried: [] }, { read: true })).toBeUndefined();
  });
});

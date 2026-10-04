/**
 * Guards against css-selector injection via bound locator values (packages/core/src/schema/template.ts).
 *
 * Binding CSS-escapes every value bound into a `css` locator, so `{input.memberId}` = `12345`
 * binds `tr[onclick*="/members/{input.memberId}"]` to `tr[onclick*="/members/\31 2345"]`. A real
 * browser treats that exactly like the unescaped form (verified in Chromium). FakeSurface used to
 * match css locators by EXACT STRING compare against the fixture's literal selector, so an escaped
 * bound value silently stopped resolving an element a real browser still resolves: a fake/real
 * divergence that would make a css-fallback test fail for no real reason. Guarantee: FakeSurface
 * compares css selectors modulo CSS escapes, so a css locator bound through the escaping binder
 * resolves on the fake exactly when it would on a real page.
 */
import { describe, expect, it } from 'vitest';
import { bindDescriptor, type TargetDescriptor } from '../schema/index.js';
import { el, scenario, FakeSurface } from './fake/index.js';

function surface(): FakeSurface {
  const sc = scenario()
    .viewport(1000, 1000)
    .screen('results', {
      url: 'http://x.test/results',
      title: 'Results',
      elements: [
        el({ id: 'row', role: 'row', name: 'Row', tag: 'tr', css: ['tr[onclick*="/members/12345"]'], bbox: { x: 0, y: 0, w: 100, h: 20 } }),
        el({ id: 'other', role: 'row', name: 'Other', tag: 'tr', css: ['tr[onclick*="/members/99999"]'], bbox: { x: 0, y: 30, w: 100, h: 20 } }),
      ],
    })
    .build();
  return new FakeSurface(sc);
}

const TEMPLATE: TargetDescriptor = {
  description: 'member result row',
  frame: [],
  locators: [{ strategy: { kind: 'css', selector: 'tr[onclick*="/members/{input.memberId}"]' }, confidence: 0.5, source: 'recorded' }],
};

describe('FakeSurface css matching agrees with a browser after CSS-escaped binding', () => {
  it('a css locator bound with an escaped leading digit still resolves the same element', async () => {
    const s = surface();
    const bound = bindDescriptor(TEMPLATE, { baseUrl: 'http://x.test', inputs: { memberId: '12345' } });
    const sel = (bound.locators[0]!.strategy as { selector: string }).selector;
    expect(sel).not.toBe('tr[onclick*="/members/12345"]'); // proves the binder really escaped it
    const r = await s.resolve(bound, 1000);
    expect(r.found).toBe(true);
    if (r.found) expect(r.ref).toBe((await s.observe()).elements.find((e) => e.name === 'Row')!.ref);
  });

  it('an injection payload still does not match anything (escaping is not undone into a wildcard)', async () => {
    const s = surface();
    const bound = bindDescriptor(TEMPLATE, { baseUrl: 'http://x.test', inputs: { memberId: '"], tr, [x="' } });
    const r = await s.resolve(bound, 1000);
    expect(r.found).toBe(false);
  });
});

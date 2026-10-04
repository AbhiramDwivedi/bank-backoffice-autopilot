/** Business outcomes are checked before a failure is ever classified hard. */
import { describe, expect, it } from 'vitest';
import { createCuCoreSurface } from '../surface/fake-scenarios/cu-core.js';
import { makeFakeClock, runReplay } from './test-helpers.js';

describe('replay: business outcomes', () => {
  it('member 99999 ends as business_outcome member_not_found, not a hard failure', async () => {
    const { result, events } = await runReplay({ inputs: { memberId: '99999' } });

    expect(result.kind).toBe('business_outcome');
    if (result.kind === 'business_outcome') {
      expect(result.name).toBe('member_not_found');
      expect(result.data).toEqual({});
      expect(result.missing).toBeUndefined();
    }
    expect(events.some((e) => e.kind === 'outcome')).toBe(true);
  });

  it('member 90001 ends as business_outcome access_denied with the extracted message', async () => {
    const { result, events } = await runReplay({ inputs: { memberId: '90001' } });

    expect(result.kind).toBe('business_outcome');
    if (result.kind === 'business_outcome') {
      expect(result.name).toBe('access_denied');
      expect(typeof result.data.message).toBe('string');
      expect(result.data.message).toMatch(/^Access Denied/);
      expect(result.missing).toBeUndefined();
    }
    expect(events.some((e) => e.kind === 'outcome')).toBe(true);
  });

  it('member 90001 with the denied-message element drifted unresolvable -> access_denied still returned, with "message" recorded as missing', async () => {
    const clock = makeFakeClock();
    const surface = createCuCoreSurface({ clock });
    // Drift, not hide: `hide_element` would also drop deniedMsg's text from the page's text
    // digest (packages/core/src/surface/fake/view.ts's computeTextDigest skips `hidden` elements), which would
    // break the outcome's OWN detector (`text_visible "Access Denied"`) and the run would never
    // even reach "access_denied" to test its extract failing. Drifting tag/css/bbox instead
    // defeats all three of the extract target's locators (text tag=p, css p.denied, bbox) while
    // leaving deniedMsg's text/name -- and so the digest and the detector -- untouched.
    surface.inject({
      kind: 'drift',
      elementId: 'deniedMsg',
      patch: { tag: 'span', css: ['no.such.selector'], bbox: { x: 1000, y: 700, w: 50, h: 50 } },
    });

    const { result, events } = await runReplay({ surface, clock, inputs: { memberId: '90001' } });

    expect(result.kind).toBe('business_outcome');
    if (result.kind === 'business_outcome') {
      expect(result.name).toBe('access_denied');
      expect(result.data.message).toBeUndefined();
      expect(result.missing).toEqual(['message']);
    }
    // The failed extract is still logged as an `error` event; the outcome is returned regardless.
    expect(events.some((e) => e.kind === 'error' && e.data.outcome === 'access_denied' && e.data.output === 'message')).toBe(true);
    expect(events.some((e) => e.kind === 'outcome' && e.data.name === 'access_denied')).toBe(true);
  });
});

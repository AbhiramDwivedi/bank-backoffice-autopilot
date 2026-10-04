/**
 * The comparison behind a read's identity check, and the fake surface's `readRecordText`.
 */
import { describe, expect, it } from 'vitest';
import { recordTextShows } from './record-identity.js';
import { el, scenario, FakeSurface } from './fake/index.js';

describe('recordTextShows', () => {
  it('finds a value as a whole token only', () => {
    expect(recordTextShows('Member ID 12345 Savings', '12345')).toBe(true);
    expect(recordTextShows('Member ID 123456', '12345')).toBe(false);
    expect(recordTextShows('Al Smithers', 'Smith')).toBe(false);
    expect(recordTextShows('Jane Smith', 'Smith')).toBe(true);
  });

  it('is case-sensitive, collapses whitespace on both sides, and never shows an empty value', () => {
    expect(recordTextShows('Jane  Smith', 'jane smith')).toBe(false);
    expect(recordTextShows('Jane \n Smith', 'Jane   Smith')).toBe(true);
    expect(recordTextShows('anything', '')).toBe(false);
    expect(recordTextShows('anything', '   ')).toBe(false);
  });
});

const box = { x: 0, y: 0, w: 50, h: 20 };

function twoCards(): FakeSurface {
  const built = scenario()
    .screen('list', {
      url: 'http://x.test/list',
      title: 'List',
      text: ['Header text'],
      elements: [
        el({ id: 'aName', role: 'cell', name: 'Jane Smith', text: 'Jane Smith', tag: 'td', container: 'a', bbox: box }),
        el({ id: 'aLabel', role: 'cell', name: 'Balance', text: 'Balance', tag: 'td', container: 'a', bbox: box }),
        el({ id: 'aValue', role: 'cell', name: '$5.00', text: '$5.00', tag: 'td', container: 'a', bbox: box }),
        el({ id: 'bName', role: 'cell', name: 'Al Smithers', text: 'Al Smithers', tag: 'td', container: 'b', bbox: box }),
        el({ id: 'loose', role: 'cell', name: 'Loose', text: 'Loose', tag: 'td', bbox: box }),
      ],
    })
    .build();
  return new FakeSurface(built);
}

describe('FakeSurface.readRecordText', () => {
  it('reads the elements that share the container of the value, and the whole screen when it has none', async () => {
    const surface = twoCards();
    const obs = await surface.observe();
    const ref = (name: string): string => obs.elements.find((e) => e.name === name)!.ref;

    const card = await surface.readRecordText({ ref: ref('$5.00') }, 'container', 100);
    expect(card).toEqual({ ok: true, text: 'Jane Smith Balance $5.00', scope: 'container' });

    const page = await surface.readRecordText({ ref: ref('Loose') }, 'container', 100);
    expect(page.ok && page.scope).toBe('page');
    expect(page.ok && page.text).toContain('Header text');
    expect(page.ok && page.text).toContain('Al Smithers');

    const asked = await surface.readRecordText({ ref: ref('$5.00') }, 'page', 100);
    expect(asked.ok && asked.scope).toBe('page');
  });

  it('reports an unknown ref as element_not_found', async () => {
    const r = await twoCards().readRecordText({ ref: 'e999' }, 'container', 100);
    expect(r).toMatchObject({ ok: false, error: { code: 'element_not_found' } });
  });
});

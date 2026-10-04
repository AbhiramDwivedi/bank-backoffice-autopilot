import { describe, expect, it } from 'vitest';
import { REDACTED_VALUE, type Condition, type TargetDescriptor } from '../schema/index.js';
import { el, scenario, FakeSurface, type Clock, type FakeScenario } from './fake/index.js';
import { locatorTextMatches } from './fake/match.js';

/** A fake clock that never really waits: sleep() just advances `now()` synchronously. Lets
 * tests exercise waitFor()/timeout/delay logic without any real elapsed time. */
function fakeClock(): Clock & { now(): number } {
  let t = 0;
  return {
    now: () => t,
    sleep: (ms: number) => {
      t += ms;
      return Promise.resolve();
    },
  };
}

// A small hand-built two-screen scenario used by most of the mechanics tests below: a form
// with a submit button, and a "done" screen. Element `submit`'s row/label pairing exercises
// the relative/label/bbox locator kinds deliberately.
function basicScenario(): FakeScenario {
  return scenario()
    .viewport(1000, 1000)
    .screen('form', {
      url: 'http://x.test/form',
      title: 'Form',
      elements: [
        el({ id: 'nameLabel', role: 'cell', name: 'Name', text: 'Name', tag: 'td', row: 'r1', bbox: { x: 0, y: 0, w: 50, h: 20 } }),
        el({
          id: 'nameField',
          role: 'textbox',
          name: 'Name',
          label: 'Name',
          tag: 'input',
          css: ['input[name=name]'],
          row: 'r1',
          bbox: { x: 60, y: 0, w: 100, h: 20 },
        }),
        el({ id: 'submit', role: 'button', name: 'Submit', tag: 'input', css: ['input[type=submit]'], bbox: { x: 0, y: 40, w: 60, h: 20 } }),
        el({ id: 'disabledBtn', role: 'button', name: 'Disabled', tag: 'input', enabled: false, bbox: { x: 0, y: 70, w: 60, h: 20 } }),
        el({ id: 'hiddenThing', role: 'generic', name: 'Hidden Thing', tag: 'div', hidden: true, bbox: { x: 0, y: 100, w: 60, h: 20 } }),
      ],
    })
    .on('click', { targetId: 'submit' })
    .goto('done')
    .screen('done', { url: 'http://x.test/done', title: 'Done', elements: [el({ id: 'doneMsg', role: 'generic', name: 'Done!', text: 'Done!', tag: 'div', bbox: { x: 0, y: 0, w: 60, h: 20 } })] })
    .sessionExpiredAt('done')
    .build();
}

function byRole(role: string, name: string, exact = false): TargetDescriptor {
  return { description: `${role} ${name}`, frame: [], locators: [{ strategy: { kind: 'role', role, name, exact }, confidence: 0.9, source: 'inferred' }] };
}

describe('FakeSurface: basic act/observe/transitions', () => {
  it('observe() reports non-hidden elements with stable per-screen refs', async () => {
    const s = new FakeSurface(basicScenario());
    const obs = await s.observe();
    expect(obs.elements.map((e) => e.ref)).toEqual(['e1', 'e2', 'e3', 'e4']); // e5 (hidden) excluded
    expect(obs.url).toBe('http://x.test/form');
  });

  it('click on submit navigates to done; navigated:false for a no-op click', async () => {
    const s = new FakeSurface(basicScenario());
    const r1 = await s.act({ type: 'click', target: { ref: 'e3' } }, 1000);
    expect(r1).toEqual({ ok: true, navigated: true });
    expect(s.currentScreenId()).toBe('done');

    const s2 = new FakeSurface(basicScenario());
    const r2 = await s2.act({ type: 'click', target: byRole('generic', 'nonexistent') }, 1000);
    expect(r2.ok).toBe(false);
    expect(r2.error?.code).toBe('element_not_found');
  });

  it('type() clear vs append, and pressEnter fires a press transition', async () => {
    const built = scenario()
      .screen('f', { url: 'http://x.test/f', title: 'F', elements: [el({ id: 'q', role: 'textbox', name: 'Q', tag: 'input', bbox: { x: 0, y: 0, w: 10, h: 10 } })] })
      .on('press', { key: 'Enter' })
      .goto('g')
      .screen('g', { url: 'http://x.test/g', title: 'G', elements: [] })
      .build();
    const s = new FakeSurface(built);
    await s.act({ type: 'type', target: { ref: 'e1' }, value: 'ab' }, 1000);
    await s.act({ type: 'type', target: { ref: 'e1' }, value: 'cd' }, 1000); // append (no clear)
    expect(s.debugValues().q).toBe('abcd');
    await s.act({ type: 'type', target: { ref: 'e1' }, value: 'zz', clear: true }, 1000); // replace
    expect(s.debugValues().q).toBe('zz');
    const r = await s.act({ type: 'type', target: { ref: 'e1' }, value: '!', pressEnter: true }, 1000);
    expect(r.navigated).toBe(true);
    expect(s.currentScreenId()).toBe('g');
  });

  it('disabled element -> app_error on click', async () => {
    const s = new FakeSurface(basicScenario());
    const r = await s.act({ type: 'click', target: { ref: 'e4' } }, 1000);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('app_error');
  });

  it('password values are REDACTED in observe() and domSnapshot()', async () => {
    const built = scenario()
      .screen('f', {
        url: 'http://x.test/f',
        title: 'F',
        elements: [el({ id: 'pw', role: 'textbox', name: 'Password', tag: 'input', inputType: 'password', bbox: { x: 0, y: 0, w: 10, h: 10 } })],
      })
      .build();
    const s = new FakeSurface(built);
    await s.act({ type: 'type', target: { ref: 'e1' }, value: 'hunter2' }, 1000);
    const obs = await s.observe();
    expect(obs.elements[0]?.value).toBe(REDACTED_VALUE);
    expect(s.debugValues().pw).toBe('hunter2');
    const dom = await s.domSnapshot();
    expect(dom).toContain(REDACTED_VALUE);
    expect(dom).not.toContain('hunter2');
  });

  it('extract is a read-only no-op: ok:true, no state change, no navigation', async () => {
    const s = new FakeSurface(basicScenario());
    const r = await s.act({ type: 'extract', target: { ref: 'e2' }, output: 'name' }, 1000);
    expect(r).toEqual({ ok: true, navigated: false });
    expect(s.currentScreenId()).toBe('form');
  });

  it('navigate with no matching rule -> navigation_failed', async () => {
    const s = new FakeSurface(basicScenario());
    const r = await s.act({ type: 'navigate', url: 'http://nowhere.test/' }, 1000);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('navigation_failed');
  });

  it('switch_frame is a legal no-op', async () => {
    const s = new FakeSurface(basicScenario());
    const r = await s.act({ type: 'switch_frame', frame: [] }, 1000);
    expect(r.ok).toBe(true);
  });

  it('actionLog() records every act() call', async () => {
    const s = new FakeSurface(basicScenario());
    await s.act({ type: 'click', target: { ref: 'e3' } }, 1000);
    expect(s.actionLog()).toHaveLength(1);
    expect(s.actionLog()[0]?.result.navigated).toBe(true);
  });

  it('close() makes further calls throw', async () => {
    const s = new FakeSurface(basicScenario());
    await s.close();
    await expect(s.observe()).rejects.toThrow();
  });
});

describe('FakeSurface: locator fallback order and strategy reporting', () => {
  it('role locator matches first when correct (strategyIndex 0)', async () => {
    const s = new FakeSurface(basicScenario());
    const target: TargetDescriptor = {
      description: 'name field',
      frame: [],
      locators: [
        { strategy: { kind: 'role', role: 'textbox', name: 'Name' }, confidence: 0.9, source: 'inferred' },
        { strategy: { kind: 'label', label: 'Name' }, confidence: 0.7, source: 'inferred' },
      ],
    };
    const res = await s.resolve(target, 1000);
    expect(res).toEqual({ found: true, ref: 'e2', strategyIndex: 0, strategyKind: 'role', tried: [] });
  });

  it('falls back to label (index 1) when role is wrong, and reports the miss before the winner', async () => {
    const s = new FakeSurface(basicScenario());
    const target: TargetDescriptor = {
      description: 'name field, wrong role first',
      frame: [],
      locators: [
        { strategy: { kind: 'role', role: 'checkbox', name: 'Name' }, confidence: 0.9, source: 'inferred' },
        { strategy: { kind: 'label', label: 'Name' }, confidence: 0.7, source: 'inferred' },
      ],
    };
    const res = await s.resolve(target, 1000);
    expect(res).toEqual({ found: true, ref: 'e2', strategyIndex: 1, strategyKind: 'label', tried: [{ strategyKind: 'role', error: 'no match' }] });
  });

  it('text locator can win on its own (index 0)', async () => {
    const s = new FakeSurface(basicScenario());
    const target: TargetDescriptor = {
      description: 'done message',
      frame: [],
      locators: [{ strategy: { kind: 'text', text: 'Name' }, confidence: 0.6, source: 'inferred' }],
    };
    const res = await s.resolve(target, 1000);
    expect(res).toEqual({ found: true, ref: 'e1', strategyIndex: 0, strategyKind: 'text', tried: [] });
  });

  it('css locator can win on its own', async () => {
    const s = new FakeSurface(basicScenario());
    const target: TargetDescriptor = {
      description: 'name field by css',
      frame: [],
      locators: [{ strategy: { kind: 'css', selector: 'input[name=name]' }, confidence: 0.3, source: 'inferred' }],
    };
    const res = await s.resolve(target, 1000);
    expect(res).toEqual({ found: true, ref: 'e2', strategyIndex: 0, strategyKind: 'css', tried: [] });
  });

  it('relative (right-of its row label) locator can win', async () => {
    const s = new FakeSurface(basicScenario());
    const target: TargetDescriptor = {
      description: 'field right of Name label',
      frame: [],
      locators: [{ strategy: { kind: 'relative', anchor: { text: 'Name' }, relation: 'right-of', role: 'textbox' }, confidence: 0.5, source: 'inferred' }],
    };
    const res = await s.resolve(target, 1000);
    expect(res).toEqual({ found: true, ref: 'e2', strategyIndex: 0, strategyKind: 'relative', tried: [] });
  });

  // The anchor rule of the real resolver (adapter-playwright resolve.ts findAnchor): one element
  // whose text equals the anchor wins; otherwise one element containing it; several are an
  // ambiguity, never "the first one".
  describe('relative anchor: the real resolver`s rule', () => {
    const cell = (id: string, text: string, row: string, x: number, y: number) =>
      el({ id, role: 'cell', name: text, text, tag: 'td', row, bbox: { x, y, w: 100, h: 20 } });
    const twoRecords = (labels: [string, string]): FakeSurface =>
      new FakeSurface(
        scenario()
          .screen('list', {
            url: 'http://x.test/list',
            title: 'List',
            elements: [
              cell('l1', labels[0], 'r1', 0, 0),
              cell('v1', '$10.00', 'r1', 120, 0),
              cell('l2', labels[1], 'r2', 0, 40),
              cell('v2', '$99.00', 'r2', 120, 40),
            ],
          })
          .build(),
      );
    const rightOf = (text: string, extra: Partial<{ exact: boolean; wholeWord: boolean }> = {}): TargetDescriptor => ({
      description: `value right of ${text}`,
      frame: [],
      locators: [
        { strategy: { kind: 'relative', anchor: { text, ...extra }, relation: 'right-of' }, confidence: 0.5, source: 'inferred' },
        { strategy: { kind: 'css', selector: 'tr:nth-of-type(1) > td:nth-of-type(2)' }, confidence: 0.3, source: 'inferred' },
      ],
    });

    it('two elements whose text equals the anchor: ambiguous, a miss with the count, not the first one', async () => {
      const res = await twoRecords(['Balance', 'Balance']).resolve(rightOf('Balance'), 0);
      expect(res).toEqual({
        found: false,
        tried: [
          { strategyKind: 'relative', error: 'ambiguous anchor: 2 matches', ambiguous: true, matches: 2 },
          { strategyKind: 'css', error: 'no match' },
        ],
      });
    });

    it('two elements containing the anchor, none equal to it: ambiguous', async () => {
      const res = await twoRecords(['Savings Balance', 'Checking Balance']).resolve(rightOf('Balance'), 0);
      expect(res.found).toBe(false);
      if (!res.found) expect(res.tried[0]).toEqual({ strategyKind: 'relative', error: 'ambiguous anchor: 2 matches', ambiguous: true, matches: 2 });
    });

    it('one element equal to the anchor wins over others that only contain it', async () => {
      const res = await twoRecords(['Balance', 'Checking Balance']).resolve(rightOf('balance'), 0);
      expect(res).toMatchObject({ found: true, ref: 'e2', strategyIndex: 0 });
    });

    it('one element containing the anchor is the anchor', async () => {
      const res = await twoRecords(['Savings Balance', 'Member Name']).resolve(rightOf('Savings'), 0);
      expect(res).toMatchObject({ found: true, ref: 'e2', strategyIndex: 0 });
    });

    it('exact: only equality counts, case-sensitively; two equal anchors are ambiguous', async () => {
      expect((await twoRecords(['Savings Balance', 'Member Name']).resolve(rightOf('Savings', { exact: true }), 0)).found).toBe(false);
      expect((await twoRecords(['Balance', 'Member Name']).resolve(rightOf('balance', { exact: true }), 0)).found).toBe(false);
      expect(await twoRecords(['Balance', 'Checking Balance']).resolve(rightOf('Balance', { exact: true }), 0)).toMatchObject({ found: true, ref: 'e2' });
      const twice = await twoRecords(['Balance', 'Balance']).resolve(rightOf('Balance', { exact: true }), 0);
      expect(twice.found).toBe(false);
      if (!twice.found) expect(twice.tried[0]).toEqual({ strategyKind: 'relative', error: 'ambiguous anchor: 2 exact matches', ambiguous: true, matches: 2 });
    });

    it('wholeWord: a whole-token match in two elements is ambiguous; in one, it anchors', async () => {
      const both = await twoRecords(['Ann Lee', 'Lee Wong']).resolve(rightOf('Lee', { wholeWord: true }), 0);
      expect(both.found).toBe(false);
      if (!both.found) expect(both.tried[0]).toMatchObject({ ambiguous: true, matches: 2 });
      expect(await twoRecords(['Ann Lee', 'Bo Leeson']).resolve(rightOf('Lee', { wholeWord: true }), 0)).toMatchObject({ found: true, ref: 'e2' });
    });

    it('a label that is only a control`s name (no label cell modelled) still anchors, once', async () => {
      const s = new FakeSurface(
        scenario()
          .screen('f', {
            url: 'http://x.test/f',
            title: 'F',
            elements: [
              el({ id: 'a', role: 'textbox', name: 'Amount', label: 'Amount', tag: 'input', row: 'r1', bbox: { x: 0, y: 0, w: 50, h: 20 } }),
              el({ id: 'b', role: 'button', name: 'Go', tag: 'input', row: 'r1', bbox: { x: 60, y: 0, w: 50, h: 20 } }),
            ],
          })
          .build(),
      );
      expect(await s.resolve(rightOf('Amount'), 0)).toMatchObject({ found: true, ref: 'e2', strategyIndex: 0 });
    });
  });

  it("a relative locator's selector filters candidates by the element's listed css selectors (no CSS engine)", async () => {
    const s = new FakeSurface(basicScenario());
    const rel = (selector: string): TargetDescriptor => ({
      description: 'field right of Name label',
      frame: [],
      locators: [{ strategy: { kind: 'relative', anchor: { text: 'Name' }, relation: 'right-of', role: 'textbox', selector }, confidence: 0.5, source: 'inferred' }],
    });
    expect(await s.resolve(rel('input[name=name]'), 1000)).toEqual({ found: true, ref: 'e2', strategyIndex: 0, strategyKind: 'relative', tried: [] });
    expect((await s.resolve(rel('input.other'), 0)).found).toBe(false);
  });

  it('wholeWord: a contains text match needs the text as a whole token, case-sensitively', () => {
    expect(locatorTextMatches('Al Smithers', 'Smith')).toBe(true);
    expect(locatorTextMatches('Al Smithers', 'Smith', false, true)).toBe(false);
    expect(locatorTextMatches('Jane Smith', 'Smith', false, true)).toBe(true);
    expect(locatorTextMatches('Jane Smith', 'smith', false, true)).toBe(false);
    expect(locatorTextMatches('Lee Wong', 'Lee', false, true)).toBe(true); // a whole word of another value: the named limit
    expect(locatorTextMatches('Row for 45123', '4512', false, true)).toBe(false);
  });

  it('wholeWord: a joiner does not end a word, so "A-1001" is not a whole word of "A-1001-B"', () => {
    expect(locatorTextMatches('A-1001-B', 'A-1001', false, true)).toBe(false);
    expect(locatorTextMatches('B-A-1001', 'A-1001', false, true)).toBe(false);
    expect(locatorTextMatches('Smith-Jones', 'Smith', false, true)).toBe(false);
    expect(locatorTextMatches('john.smith', 'smith', false, true)).toBe(false);
    expect(locatorTextMatches('Ref A-1001 (open)', 'A-1001', false, true)).toBe(true);
    expect(locatorTextMatches('Lee, Ann', 'Lee', false, true)).toBe(true);
    expect(locatorTextMatches('Order A-1001.', 'A-1001', false, true)).toBe(true);
  });

  it('wholeWord anchors prefer an exact cell; exact-recorded anchors never fall back to a word', async () => {
    const twoRecords = (labels: [string, string]): FakeSurface =>
      new FakeSurface(
        scenario()
          .screen('list', {
            url: 'http://x.test/list',
            title: 'List',
            elements: [
              el({ id: 'l1', role: 'cell', name: labels[0], text: labels[0], tag: 'td', row: 'r1', bbox: { x: 0, y: 0, w: 100, h: 20 } }),
              el({ id: 'v1', role: 'cell', name: 'one', text: 'one', tag: 'td', row: 'r1', bbox: { x: 120, y: 0, w: 100, h: 20 } }),
              el({ id: 'l2', role: 'cell', name: labels[1], text: labels[1], tag: 'td', row: 'r2', bbox: { x: 0, y: 40, w: 100, h: 20 } }),
              el({ id: 'v2', role: 'cell', name: 'two', text: 'two', tag: 'td', row: 'r2', bbox: { x: 120, y: 40, w: 100, h: 20 } }),
            ],
          })
          .build(),
      );
    const anchored = (text: string, extra: { exact?: boolean; wholeWord?: boolean }): TargetDescriptor => ({
      description: 'value right of the row',
      frame: [],
      locators: [{ strategy: { kind: 'relative', anchor: { text, ...extra }, relation: 'right-of' }, confidence: 0.5, source: 'inferred' }],
    });
    // Exact first: "Lee" alone wins over "Ann Lee" and "Lee Wong", which both hold it as a word.
    expect(await twoRecords(['Lee', 'Lee Wong']).resolve(anchored('Lee', { wholeWord: true }), 0)).toMatchObject({ found: true, ref: 'e2' });
    // No exact cell: the word fallback finds the one cell holding it (a named limit).
    expect(await twoRecords(['Ann Lee', 'Bo Kim']).resolve(anchored('Lee', { wholeWord: true }), 0)).toMatchObject({ found: true, ref: 'e2' });
    // A hyphen does not make "A-1001-B" a word match.
    expect((await twoRecords(['A-1001-B', 'Bo Kim']).resolve(anchored('A-1001', { wholeWord: true }), 0)).found).toBe(false);
    // Recorded as an exact cell: no word fallback at all.
    expect((await twoRecords(['Lee Wong', 'Bo Kim']).resolve(anchored('Lee', { exact: true }), 0)).found).toBe(false);
    expect(await twoRecords(['Lee', 'Lee Wong']).resolve(anchored('Lee', { exact: true }), 0)).toMatchObject({ found: true, ref: 'e2' });
  });

  it('bbox locator (normalized to the 1000x1000 viewport) can win', async () => {
    const s = new FakeSurface(basicScenario());
    // nameField bbox is {x:60,y:0,w:100,h:20} in a 1000x1000 viewport.
    const target: TargetDescriptor = {
      description: 'field at bbox',
      frame: [],
      locators: [{ strategy: { kind: 'bbox', x: 0.08, y: 0.005, w: 0.05, h: 0.01 }, confidence: 0.1, source: 'inferred' }],
    };
    const res = await s.resolve(target, 1000);
    expect(res).toEqual({ found: true, ref: 'e2', strategyIndex: 0, strategyKind: 'bbox', tried: [] });
  });

  it('a found resolution reports an ambiguous miss before the winner, marked with its match count', async () => {
    const built = scenario()
      .screen('f', {
        url: 'http://x.test/f',
        title: 'F',
        elements: [
          el({ id: 'a', role: 'button', name: 'Go', tag: 'input', css: ['form > input:nth-of-type(1)'], bbox: { x: 0, y: 0, w: 10, h: 10 } }),
          el({ id: 'b', role: 'button', name: 'Go', tag: 'input', bbox: { x: 20, y: 0, w: 10, h: 10 } }),
        ],
      })
      .build();
    const res = await new FakeSurface(built).resolve(
      {
        description: 'ambiguous role, then a structural css',
        frame: [],
        locators: [
          { strategy: { kind: 'role', role: 'button', name: 'Go' }, confidence: 0.9, source: 'inferred' },
          { strategy: { kind: 'css', selector: 'form > input:nth-of-type(1)' }, confidence: 0.3, source: 'inferred' },
        ],
      },
      0,
    );
    // The surface reports; whether the css winner may be used is replay's decision (positional-fallback.ts).
    expect(res).toEqual({
      found: true,
      ref: 'e1',
      strategyIndex: 1,
      strategyKind: 'css',
      tried: [{ strategyKind: 'role', error: 'ambiguous: 2 matches', ambiguous: true, matches: 2 }],
    });
  });

  it('ambiguous match (>1) falls through to the next locator, reporting ambiguous: N matches via tried', async () => {
    const built = scenario()
      .screen('f', {
        url: 'http://x.test/f',
        title: 'F',
        elements: [
          el({ id: 'a', role: 'button', name: 'Go', tag: 'input', bbox: { x: 0, y: 0, w: 10, h: 10 } }),
          el({ id: 'b', role: 'button', name: 'Go', tag: 'input', bbox: { x: 20, y: 0, w: 10, h: 10 } }),
        ],
      })
      .build();
    const s = new FakeSurface(built);
    const target: TargetDescriptor = {
      description: 'ambiguous then css',
      frame: [],
      locators: [
        { strategy: { kind: 'role', role: 'button', name: 'Go' }, confidence: 0.9, source: 'inferred' },
        { strategy: { kind: 'text', text: 'nonexistent' }, confidence: 0.5, source: 'inferred' },
      ],
    };
    const res = await s.resolve(target, 1000);
    expect(res.found).toBe(false);
    if (!res.found) {
      expect(res.tried[0]).toEqual({ strategyKind: 'role', error: 'ambiguous: 2 matches', ambiguous: true, matches: 2 });
      expect(res.tried[1]).toEqual({ strategyKind: 'text', error: 'no match' });
    }
  });

  it('frame mismatch -> not found, with a tried entry per locator', async () => {
    const s = new FakeSurface(basicScenario());
    const target: TargetDescriptor = {
      description: 'name field in a frame that does not exist',
      frame: [{ name: 'nope' }],
      locators: [{ strategy: { kind: 'role', role: 'textbox', name: 'Name' }, confidence: 0.9, source: 'inferred' }],
    };
    const res = await s.resolve(target, 1000);
    expect(res).toEqual({ found: false, tried: [{ strategyKind: 'role', error: 'no match' }] });
  });
});

describe('FakeSurface: observe() descriptor round-trip', () => {
  it('every observed element resolves back to itself via its own synthesized descriptor at strategyIndex 0', async () => {
    const s = new FakeSurface(basicScenario());
    const obs = await s.observe();
    for (const element of obs.elements) {
      const res = await s.resolve(element.descriptor, 1000);
      expect(res.found).toBe(true);
      if (res.found) {
        expect(res.ref).toBe(element.ref);
        expect(res.strategyIndex).toBe(0);
      }
    }
  });
});

describe('FakeSurface: failure injection', () => {
  it('drift on the first-locator field makes strategyIndex increase', async () => {
    const s = new FakeSurface(basicScenario());
    const target: TargetDescriptor = {
      description: 'name field',
      frame: [],
      locators: [
        { strategy: { kind: 'role', role: 'textbox', name: 'Name' }, confidence: 0.9, source: 'inferred' },
        { strategy: { kind: 'label', label: 'Name' }, confidence: 0.7, source: 'inferred' },
      ],
    };
    const before = await s.resolve(target, 1000);
    expect(before).toEqual({ found: true, ref: 'e2', strategyIndex: 0, strategyKind: 'role', tried: [] });

    s.inject({ kind: 'drift', elementId: 'nameField', patch: { name: 'Full Identifier' } });
    const after = await s.resolve(target, 1000);
    expect(after).toEqual({ found: true, ref: 'e2', strategyIndex: 1, strategyKind: 'label', tried: [{ strategyKind: 'role', error: 'no match' }] });
  });

  it('hide_element with times:1 hides for exactly one resolve, then reverts', async () => {
    const s = new FakeSurface(basicScenario());
    s.inject({ kind: 'hide_element', elementId: 'submit', times: 1 });
    const target = byRole('button', 'Submit');
    const r1 = await s.resolve(target, 1000);
    expect(r1.found).toBe(false);
    const r2 = await s.resolve(target, 1000);
    expect(r2).toEqual({ found: true, ref: 'e3', strategyIndex: 0, strategyKind: 'role', tried: [] });
  });

  it('hide_element default (Infinity) hides until clearInjections()', async () => {
    const s = new FakeSurface(basicScenario());
    s.inject({ kind: 'hide_element', elementId: 'submit' });
    const target = byRole('button', 'Submit');
    expect((await s.resolve(target, 1000)).found).toBe(false);
    expect((await s.resolve(target, 1000)).found).toBe(false);
    s.clearInjections();
    expect((await s.resolve(target, 1000)).found).toBe(true);
  });

  it('act_error injection short-circuits act() with the injected code', async () => {
    const s = new FakeSurface(basicScenario());
    s.inject({ kind: 'act_error', match: { targetId: 'submit' }, code: 'policy_violation', message: 'blocked' });
    const r = await s.act({ type: 'click', target: { ref: 'e3' } }, 1000);
    expect(r).toEqual({ ok: false, error: { code: 'policy_violation', message: 'blocked' } });
    expect(s.currentScreenId()).toBe('form'); // no transition applied
  });

  it('delay injection combined with a fake clock produces a timeout without ever really waiting', async () => {
    const clock = fakeClock();
    const s = new FakeSurface(basicScenario(), { clock });
    s.inject({ kind: 'delay', ms: 5000 });
    const r = await s.act({ type: 'click', target: { ref: 'e3' } }, 1000);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('timeout');
    expect(clock.now()).toBe(1000); // slept exactly up to the timeout, not the full delay
    expect(s.currentScreenId()).toBe('form'); // transition not applied on timeout
  });

  it('expire_session injection redirects the next act() to sessionExpiredScreen', async () => {
    const s = new FakeSurface(basicScenario());
    s.inject({ kind: 'expire_session' });
    const r = await s.act({ type: 'click', target: { ref: 'e3' } }, 1000);
    expect(r).toEqual({ ok: true, navigated: true });
    expect(s.currentScreenId()).toBe('done');
  });

  it('dialog injection opens an unexpected dialog, which then blocks further acts until dismissed', async () => {
    const s = new FakeSurface(basicScenario());
    s.inject({ kind: 'dialog', dialog: { type: 'alert', message: 'Unexpected!' } });
    const r1 = await s.act({ type: 'click', target: { ref: 'e3' } }, 1000);
    expect(r1).toEqual({ ok: true, navigated: false });
    expect(s.currentScreenId()).toBe('form'); // the click's own effect never ran

    const blocked = await s.act({ type: 'click', target: { ref: 'e3' } }, 1000);
    expect(blocked.ok).toBe(false);
    expect(blocked.error?.code).toBe('unexpected_dialog');

    const dismiss = await s.act({ type: 'dismiss_dialog', accept: true }, 1000);
    expect(dismiss.ok).toBe(true);
    const afterDismiss = await s.check({ kind: 'dialog_open' });
    expect(afterDismiss).toBe(false);
  });
});

describe('FakeSurface: waitFor / autoAdvance / clock', () => {
  it('waitFor polls check() until the condition holds, using the injected clock only', async () => {
    const clock = fakeClock();
    const s = new FakeSurface(basicScenario(), { clock });
    const cond: Condition = { kind: 'text_visible', text: 'Done!' };
    const waitPromise = s.waitFor(cond, 5000);
    // Not on 'done' yet, so it should still be pending; drive it forward now.
    await s.act({ type: 'click', target: { ref: 'e3' } }, 1000);
    expect(await waitPromise).toBe(true);
  });

  it('waitFor honours autoAdvance using the fake clock, with no real waiting', async () => {
    const clock = fakeClock();
    const built = scenario()
      .screen('a', { url: 'http://x.test/a', title: 'A', elements: [], autoAdvance: { afterMs: 300, to: 'b' } })
      .screen('b', { url: 'http://x.test/b', title: 'B', elements: [el({ id: 'm', role: 'generic', name: 'B!', text: 'B!', tag: 'div', bbox: { x: 0, y: 0, w: 10, h: 10 } })] })
      .build();
    const s = new FakeSurface(built, { clock });
    const ok = await s.waitFor({ kind: 'text_visible', text: 'B!' }, 5000);
    expect(ok).toBe(true);
    expect(s.currentScreenId()).toBe('b');
    expect(clock.now()).toBeLessThanOrEqual(350);
  });

  it('waitFor times out (false) when the condition never holds, without real waiting', async () => {
    const clock = fakeClock();
    const s = new FakeSurface(basicScenario(), { clock });
    const ok = await s.waitFor({ kind: 'text_visible', text: 'never appears' }, 200);
    expect(ok).toBe(false);
    expect(clock.now()).toBeGreaterThanOrEqual(200);
  });
});

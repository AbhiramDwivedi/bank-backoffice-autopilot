import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { TargetDescriptor } from '@cu/core/schema';
import { resolveDescriptor } from './resolve.js';
import { createPlaywrightSurface } from './surface.js';
import { startFixtureServer, type FixtureServer } from './test-helpers.js';

let browser: Browser;
let fixtures: FixtureServer;
const contexts: BrowserContext[] = [];

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  fixtures = await startFixtureServer();
});

afterAll(async () => {
  await browser.close();
  await fixtures.close();
});

afterEach(async () => {
  while (contexts.length > 0) {
    const c = contexts.pop()!;
    await c.close().catch(() => undefined);
  }
});

async function newPage(): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  contexts.push(context);
  return context.newPage();
}

function target(locators: TargetDescriptor['locators'], frame: TargetDescriptor['frame'] = []): TargetDescriptor {
  return { description: 'test target', frame, locators };
}

describe('resolveDescriptor', () => {
  it('resolves an adjacent-cell label via the label strategy', async () => {
    const page = await newPage();
    await page.goto(fixtures.url('resolve-search.html'));
    const r = await resolveDescriptor(page, target([{ strategy: { kind: 'label', label: 'Member ID' }, confidence: 0.8, source: 'inferred' }]), 10_000);
    expect(r.found).toBe(true);
    if (!r.found) return;
    expect(r.strategyKind).toBe('label');
    expect(r.strategyIndex).toBe(0);
    const tag = await r.entry.handle.evaluate((el) => el.tagName.toLowerCase());
    expect(tag).toBe('input');
    const id = await r.entry.handle.evaluate((el) => el.id);
    expect(id).toBe('txtMbrId');
  });

  it('resolves the adjacent-cell label whether or not the recorded text carries a trailing colon', async () => {
    const page = await newPage();
    await page.goto(fixtures.url('resolve-search.html'));
    const r = await resolveDescriptor(page, target([{ strategy: { kind: 'label', label: 'Last Name' }, confidence: 0.8, source: 'inferred' }]), 10_000);
    expect(r.found).toBe(true);
    if (!r.found) return;
    const id = await r.entry.handle.evaluate((el) => el.id);
    expect(id).toBe('txtLName');
  });

  it('falls through role miss, label miss, to a text hit at index 2', async () => {
    const page = await newPage();
    await page.goto(fixtures.url('resolve-search.html'));
    const r = await resolveDescriptor(
      page,
      target([
        { strategy: { kind: 'role', role: 'button', name: 'Nonexistent Button' }, confidence: 0.9, source: 'recorded' },
        { strategy: { kind: 'label', label: 'Nonexistent Label' }, confidence: 0.8, source: 'recorded' },
        { strategy: { kind: 'text', text: 'Search', tag: 'div' }, confidence: 0.6, source: 'recorded' },
      ]),
      10_000,
    );
    expect(r.found).toBe(true);
    if (!r.found) return;
    expect(r.strategyIndex).toBe(2);
    expect(r.strategyKind).toBe('text');
    // The misses before the winner, in chain order; neither was an ambiguity.
    expect(r.tried).toEqual([
      { strategyKind: 'role', error: 'no match' },
      { strategyKind: 'label', error: 'no match' },
    ]);
    const id = await r.entry.handle.evaluate((el) => el.id);
    expect(id).toBe('btnSearch');
  });

  it('treats a synthesized non-ARIA role as an immediate miss', async () => {
    const page = await newPage();
    await page.goto(fixtures.url('resolve-search.html'));
    const r = await resolveDescriptor(page, target([{ strategy: { kind: 'role', role: 'clickable', name: 'Search' }, confidence: 0.5, source: 'inferred' }]), 0);
    expect(r.found).toBe(false);
    if (r.found) return;
    expect(r.tried[0]?.error).toBe('non-ARIA role');
  });

  it('falls through an ambiguous text match to the next strategy and reports its index', async () => {
    const page = await newPage();
    await page.goto(fixtures.url('resolve-search.html'));
    const r = await resolveDescriptor(
      page,
      target([
        { strategy: { kind: 'text', text: 'Edit', exact: true }, confidence: 0.6, source: 'recorded' },
        { strategy: { kind: 'css', selector: '#edit2' }, confidence: 0.3, source: 'recorded' },
      ]),
      10_000,
    );
    expect(r.found).toBe(true);
    if (!r.found) return;
    expect(r.strategyIndex).toBe(1);
    expect(r.strategyKind).toBe('css');
    // The ambiguity is reported with its match count; the resolver does not decide what it means.
    expect(r.tried).toHaveLength(1);
    expect(r.tried[0]).toMatchObject({ strategyKind: 'text', ambiguous: true });
    expect(r.tried[0]!.matches).toBeGreaterThan(1);
    expect(r.tried[0]!.error).toBe(`ambiguous: ${r.tried[0]!.matches} matches`);
    const id = await r.entry.handle.evaluate((el) => el.id);
    expect(id).toBe('edit2');
  });

  it('reports an ambiguous relative anchor, a container with two candidates and a geometric tie as ambiguities', async () => {
    const page = await newPage();
    await page.setContent(`<!doctype html><html><body>
      <table id="t1"><tr><td>Member Name</td><td>Ann Reyes</td></tr><tr><td>Savings Balance</td><td id="first">$9,999.99</td></tr></table>
      <table id="t2"><tr><td>Member Name</td><td>Bob Stone</td></tr><tr><td>Savings Balance</td><td id="second">$20.00</td></tr></table>
      <div class="card"><div class="title">Bike Light</div><div class="cost"><s>$12.00</s></div><div class="cost">$9.99</div></div>
      <div id="tie" style="position:relative;height:80px"><span style="position:absolute;left:100px;top:0;width:40px;height:18px">Pick one</span>
        <button style="position:absolute;left:80px;top:40px;width:40px;height:20px">A</button>
        <button style="position:absolute;left:125px;top:40px;width:40px;height:20px">B</button></div>
    </body></html>`);
    const first = { strategy: { kind: 'css' as const, selector: '#first' }, confidence: 0.3, source: 'recorded' as const };

    const anchor = await resolveDescriptor(
      page,
      target([{ strategy: { kind: 'relative', anchor: { text: 'Savings Balance' }, relation: 'right-of', tag: 'td' }, confidence: 0.5, source: 'recorded' }, first]),
      0,
    );
    expect(anchor).toMatchObject({ found: true, strategyIndex: 1, tried: [{ strategyKind: 'relative', error: 'ambiguous anchor: 2 matches', ambiguous: true, matches: 2 }] });

    const exact = await resolveDescriptor(
      page,
      target([{ strategy: { kind: 'relative', anchor: { text: 'Savings Balance', exact: true }, relation: 'right-of', tag: 'td' }, confidence: 0.5, source: 'recorded' }, first]),
      0,
    );
    expect(exact).toMatchObject({ found: true, strategyIndex: 1, tried: [{ strategyKind: 'relative', error: 'ambiguous anchor: 2 exact matches', ambiguous: true, matches: 2 }] });

    const container = await resolveDescriptor(
      page,
      target([{ strategy: { kind: 'relative', anchor: { text: 'Bike Light', exact: true }, relation: 'below', tag: 'div', selector: 'div.cost', within: 'div.card' }, confidence: 0.5, source: 'recorded' }, first]),
      0,
    );
    expect(container).toMatchObject({ found: true, strategyIndex: 1, tried: [{ strategyKind: 'relative', ambiguous: true, matches: 2 }] });
    if (container.found) expect(container.tried[0]!.error).toMatch(/2 candidates in the anchor's container/);

    // Two buttons equally far below the anchor.
    const tie = await resolveDescriptor(
      page,
      target([{ strategy: { kind: 'relative', anchor: { text: 'Pick one' }, relation: 'below', tag: 'button' }, confidence: 0.5, source: 'recorded' }, first]),
      0,
    );
    expect(tie).toMatchObject({ found: true, strategyIndex: 1, tried: [{ strategyKind: 'relative', error: 'ambiguous: 2 candidates within 1px', ambiguous: true, matches: 2 }] });

    // A plain miss carries no ambiguity mark.
    const miss = await resolveDescriptor(
      page,
      target([{ strategy: { kind: 'relative', anchor: { text: 'Checking Balance' }, relation: 'right-of', tag: 'td' }, confidence: 0.5, source: 'recorded' }, first]),
      0,
    );
    expect(miss).toMatchObject({ found: true, strategyIndex: 1 });
    if (miss.found) expect(miss.tried).toEqual([{ strategyKind: 'relative', error: 'no anchor match' }]);
  });

  it('row anchors: a whole-word anchor prefers an exact cell; an exact-recorded one never falls back to a word', async () => {
    const page = await newPage();
    const rows = async (names: string[]): Promise<void> => {
      await page.setContent(`<!doctype html><html><body><table>${names.map((n, i) => `<tr><td>${n}</td><td id="v${i}">value ${i}</td></tr>`).join('')}</table></body></html>`);
    };
    const row = (anchor: { text: string; exact?: boolean; wholeWord?: boolean }): TargetDescriptor =>
      target([{ strategy: { kind: 'relative', anchor: { ...anchor, selector: 'td:nth-child(1)' }, relation: 'right-of', tag: 'td' }, confidence: 0.5, source: 'recorded' }]);

    // Exact first: the cell "Lee" wins over "Lee Wong", which also holds the word.
    await rows(['Lee Wong', 'Lee', 'Bo Kim']);
    const exactFirst = await resolveDescriptor(page, row({ text: 'Lee', wholeWord: true }), 0);
    expect(exactFirst.found).toBe(true);
    if (exactFirst.found) expect(await exactFirst.entry.handle.evaluate((el) => el.textContent)).toBe('value 1');

    // No exact cell: the word fallback finds the one cell holding it (the named limit).
    await rows(['Ann Lee', 'Bo Kim']);
    const word = await resolveDescriptor(page, row({ text: 'Lee', wholeWord: true }), 0);
    expect(word.found).toBe(true);

    // A joiner does not end a word: "A-1001-B" is not "A-1001".
    await rows(['A-1001-B', 'Bo Kim']);
    expect((await resolveDescriptor(page, row({ text: 'A-1001', wholeWord: true }), 0)).found).toBe(false);

    // Recorded as an exact cell: "Lee Wong" is never a fallback.
    await rows(['Lee Wong', 'Bo Kim']);
    expect((await resolveDescriptor(page, row({ text: 'Lee', exact: true }), 0)).found).toBe(false);
  });

  it('reports found:false with a tried entry per strategy when every strategy misses', async () => {
    const page = await newPage();
    await page.goto(fixtures.url('resolve-search.html'));
    const desc = target([
      { strategy: { kind: 'role', role: 'button', name: 'Nope' }, confidence: 0.9, source: 'recorded' },
      { strategy: { kind: 'label', label: 'Nope' }, confidence: 0.8, source: 'recorded' },
      { strategy: { kind: 'text', text: 'Nope' }, confidence: 0.6, source: 'recorded' },
      { strategy: { kind: 'css', selector: '#nope' }, confidence: 0.3, source: 'recorded' },
    ]);
    const r = await resolveDescriptor(page, desc, 300);
    expect(r.found).toBe(false);
    if (r.found) return;
    expect(r.tried).toHaveLength(4);
    expect(r.tried.map((t) => t.strategyKind)).toEqual(['role', 'label', 'text', 'css']);
  });

  it('reports found:false when the frame path does not resolve', async () => {
    const page = await newPage();
    await page.goto(fixtures.url('resolve-search.html'));
    const desc = target([{ strategy: { kind: 'css', selector: 'body' }, confidence: 0.3, source: 'recorded' }], [{ name: 'does-not-exist' }]);
    const r = await resolveDescriptor(page, desc, 300);
    expect(r.found).toBe(false);
    if (r.found) return;
    expect(r.tried[0]?.error).toMatch(/frame not found/);
  });

  it('shares one deadline across every strategy and round on an all-miss descriptor', async () => {
    const page = await newPage();
    await page.goto(fixtures.url('resolve-search.html'));
    const desc = target([
      { strategy: { kind: 'role', role: 'button', name: 'Nope' }, confidence: 0.9, source: 'recorded' },
      { strategy: { kind: 'label', label: 'Nope' }, confidence: 0.8, source: 'recorded' },
      { strategy: { kind: 'text', text: 'Nope' }, confidence: 0.6, source: 'recorded' },
      { strategy: { kind: 'css', selector: '#nope' }, confidence: 0.3, source: 'recorded' },
    ]);
    // The deadline is checked between rounds, so the last round may finish past it; under full-suite
    // load one round of four strategies has taken ~700 ms. The bound only has to separate a shared
    // deadline (about timeoutMs) from a per-strategy one (4 x timeoutMs).
    const timeoutMs = 2000;
    const started = Date.now();
    const r = await resolveDescriptor(page, desc, timeoutMs);
    const elapsed = Date.now() - started;
    expect(r.found).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(timeoutMs);
    expect(elapsed).toBeLessThan(2 * timeoutMs);
  });

  it('resolves via bbox to the closest interactive ancestor at that point', async () => {
    const page = await newPage();
    await page.goto(fixtures.url('resolve-search.html'));
    const vp = page.viewportSize()!;
    const box = await page.locator('#btnSearch').boundingBox();
    expect(box).not.toBeNull();
    const b = box!;
    const desc = target([
      {
        strategy: { kind: 'bbox', x: b.x / vp.width, y: b.y / vp.height, w: b.width / vp.width, h: b.height / vp.height },
        confidence: 0.1,
        source: 'inferred',
      },
    ]);
    const r = await resolveDescriptor(page, desc, 0);
    expect(r.found).toBe(true);
    if (!r.found) return;
    expect(r.strategyKind).toBe('bbox');
    const id = await r.entry.handle.evaluate((el) => el.id);
    expect(id).toBe('btnSearch');
  });

  it('resolves the relative right-of/tag strategy to the adjacent value cell', async () => {
    const page = await newPage();
    await page.goto(fixtures.url('resolve-detail.html'));
    const desc = target([
      { strategy: { kind: 'relative', anchor: { text: 'Savings Balance' }, relation: 'right-of', tag: 'td' }, confidence: 0.5, source: 'inferred' },
    ]);
    const r = await resolveDescriptor(page, desc, 10_000);
    expect(r.found).toBe(true);
    if (!r.found) return;
    expect(r.strategyKind).toBe('relative');
    const id = await r.entry.handle.evaluate((el) => el.id);
    expect(id).toBe('savingsCell');
  });

  it('resolves {text, tag} to the clickable tr ancestor, constraining the climbed element not the raw text leaf', async () => {
    const page = await newPage();
    await page.goto(fixtures.url('resolve-search.html'));
    const r = await resolveDescriptor(
      page,
      target([{ strategy: { kind: 'text', text: '12345', tag: 'tr' }, confidence: 0.6, source: 'recorded' }]),
      10_000,
    );
    expect(r.found).toBe(true);
    if (!r.found) return;
    expect(r.strategyKind).toBe('text');
    const id = await r.entry.handle.evaluate((el) => el.id);
    expect(id).toBe('rowMember12345');
  });

  it('does not resolve {text, tag} when tag names neither the raw text leaf nor its clickable ancestor', async () => {
    const page = await newPage();
    await page.goto(fixtures.url('resolve-search.html'));
    const r = await resolveDescriptor(
      page,
      target([{ strategy: { kind: 'text', text: '12345', tag: 'div' }, confidence: 0.6, source: 'recorded' }]),
      0,
    );
    expect(r.found).toBe(false);
  });

  it('collapses an ancestor/descendant tie among relative candidates to the actionable (innermost) element', async () => {
    // Mirrors apps/mock-app/views/partials/interstitial.ejs: a zero-padding-top wrapper <div> around a
    // single clickable <div> sits at the exact same top edge as its child, so both are `below`
    // the anchor at axis distance 0 -- without gatherRelativeCandidates collapsing the pair, this
    // is "ambiguous: 2 candidates within 1px" even though only the clickable child is ever a
    // synthesis target.
    const page = await newPage();
    await page.goto(fixtures.url('resolve-relative-wrapper.html'));
    const desc = target([
      {
        strategy: { kind: 'relative', anchor: { text: 'Scheduled maintenance notice text.' }, relation: 'below', tag: 'div' },
        confidence: 0.5,
        source: 'inferred',
      },
    ]);
    const r = await resolveDescriptor(page, desc, 10_000);
    expect(r.found).toBe(true);
    if (!r.found) return;
    expect(r.strategyKind).toBe('relative');
    const id = await r.entry.handle.evaluate((el) => el.id);
    expect(id).toBe('okBtn');
  });

  it('collapses an ancestor/descendant tie the other way too: a clickable <tr> over the plain <td> it contains', async () => {
    // The mirror image of the wrapper-div case above: here the ANCESTOR (a clickable <tr>) is the
    // actionable node, and its plain <td> child also passes the (tag/role-less) default filter
    // ("any interactive element or td"), tying at the same axis distance. The collapse must drop
    // the non-actionable td, not just check the ancestor-is-cur direction.
    const page = await newPage();
    await page.goto(fixtures.url('resolve-relative-clickable-ancestor.html'));
    const desc = target([
      { strategy: { kind: 'relative', anchor: { text: 'Row anchor label' }, relation: 'below' }, confidence: 0.5, source: 'inferred' },
    ]);
    const r = await resolveDescriptor(page, desc, 10_000);
    expect(r.found).toBe(true);
    if (!r.found) return;
    expect(r.strategyKind).toBe('relative');
    const id = await r.entry.handle.evaluate((el) => el.id);
    expect(id).toBe('clickableRow');
  });

  it('scopes resolution to the named frame when the same text appears in more than one frame', async () => {
    const page = await newPage();
    await page.goto(fixtures.url('resolve-frame-outer.html'));
    await page.waitForSelector('iframe[name="x"]');
    const desc = target([{ strategy: { kind: 'text', text: 'Duplicate Text' }, confidence: 0.6, source: 'recorded' }], [{ name: 'x' }]);
    const r = await resolveDescriptor(page, desc, 10_000);
    expect(r.found).toBe(true);
    if (!r.found) return;
    const id = await r.entry.handle.evaluate((el) => el.id);
    expect(id).toBe('innerMarker');
  });
});

describe('adjacent-cell labels: a recorded label resolves back to its own control', () => {
  // The naming side (browser-agent's labelFor) and the resolving side (lib.findAdjacentCellControls)
  // share one implementation, so each of these layouts resolves at strategy 0: a spacer cell
  // between label and control, a label restyled by text-transform (innerText differs from
  // textContent), and a label longer than the 80-char cap (recorded truncated, exact:false).
  for (const [id, expectedLabel, expectedExact] of [
    ['member-id', 'Member ID', true],
    ['branch', 'BRANCH CODE', true],
    ['mailing', 'Primary mailing address for all statements, notices and year-end tax documents s', false],
  ] as const) {
    it(`#${id}`, async () => {
      const surface = await createPlaywrightSurface({ browser });
      try {
        await surface.act({ type: 'navigate', url: fixtures.url('resolve-adjacent-cells.html') }, 5000);
        const obs = await surface.observe();
        const observed = obs.elements.find((e) => {
          const first = e.descriptor.locators[0]?.strategy;
          return e.tag === 'input' && first?.kind === 'label' && first.label === expectedLabel;
        });
        expect(observed, `an input whose first locator is label ${JSON.stringify(expectedLabel)}`).toBeDefined();
        if (!observed) return;
        expect(observed.descriptor.locators[0]!.strategy).toMatchObject({ kind: 'label', label: expectedLabel, exact: expectedExact });

        const r = await surface.resolve(observed.descriptor, 5000);
        expect(r.found).toBe(true);
        if (!r.found) return;
        expect(r.strategyIndex).toBe(0);
        expect(r.strategyKind).toBe('label');
        expect(await surface.isSameElement(r.ref, observed.ref)).toBe(true);
        const byId = await surface.resolve(target([{ strategy: { kind: 'css', selector: `#${id}` }, confidence: 0.3, source: 'recorded' }]), 0);
        expect(byId.found).toBe(true);
        if (!byId.found) return;
        expect(await surface.isSameElement(r.ref, byId.ref)).toBe(true);
      } finally {
        await surface.close();
      }
    });
  }
});

import { describe, expect, it } from 'vitest';
import type { Condition, TargetDescriptor } from '../schema/index.js';
import { collapseWhitespace, evaluateCondition, textContains, type ConditionView } from './conditions.js';

function descriptor(description = 'some element'): TargetDescriptor {
  return {
    description,
    frame: [],
    locators: [{ strategy: { kind: 'text', text: 'anything' }, confidence: 0.5, source: 'inferred' }],
  };
}

function view(overrides: Partial<ConditionView> = {}): ConditionView {
  return {
    url: 'http://localhost:4173/workstation',
    textDigest: 'Member Search   Member ID   Search',
    frameText: () => undefined,
    frameUrl: () => undefined,
    hasElement: () => false,
    ...overrides,
  };
}

describe('collapseWhitespace / textContains', () => {
  it('collapses newlines/tabs/runs of spaces to a single space and trims', async () => {
    expect(collapseWhitespace('  a\n\n b\t\tc  ')).toBe('a b c');
  });

  it('textContains defaults to case-insensitive substring', async () => {
    expect(textContains('Hello World', 'hello')).toBe(true);
    expect(textContains('Hello World', 'xyz')).toBe(false);
  });

  it('textContains exact=true is case-sensitive substring', async () => {
    expect(textContains('Hello World', 'hello', true)).toBe(false);
    expect(textContains('Hello World', 'Hello', true)).toBe(true);
  });
});

describe('evaluateCondition: text_visible', () => {
  it('matches a case-insensitive substring of textDigest by default', async () => {
    const c: Condition = { kind: 'text_visible', text: 'member id' };
    expect(await evaluateCondition(c, view())).toBe(true);
  });

  it('exact=true requires a case-sensitive substring', async () => {
    const lower: Condition = { kind: 'text_visible', text: 'member id', exact: true };
    const proper: Condition = { kind: 'text_visible', text: 'Member ID', exact: true };
    expect(await evaluateCondition(lower, view())).toBe(false);
    expect(await evaluateCondition(proper, view())).toBe(true);
  });

  it('with frame: searches frameText(frame), and false if the frame is missing', async () => {
    const c: Condition = { kind: 'text_visible', text: 'hello', frame: [{ name: 'main' }] };
    expect(await evaluateCondition(c, view({ frameText: () => undefined }))).toBe(false);
    expect(await evaluateCondition(c, view({ frameText: () => 'well hello there' }))).toBe(true);
  });

  it('collapses whitespace on both sides before comparing', async () => {
    const c: Condition = { kind: 'text_visible', text: 'Member   ID' };
    expect(await evaluateCondition(c, view({ textDigest: 'Member\n\nID found' }))).toBe(true);
  });
});

describe('evaluateCondition: text_absent', () => {
  it('is the negation of a non-exact whole-page text_visible', async () => {
    const absentMatch: Condition = { kind: 'text_absent', text: 'member id' };
    const absentMiss: Condition = { kind: 'text_absent', text: 'not on the page' };
    expect(await evaluateCondition(absentMatch, view())).toBe(false);
    expect(await evaluateCondition(absentMiss, view())).toBe(true);
  });

  it('with frame: searches frameText(frame) instead of the whole-page textDigest', async () => {
    const c: Condition = { kind: 'text_absent', text: 'error', frame: [{ name: 'main' }] };
    expect(await evaluateCondition(c, view({ frameText: () => 'an error occurred' }))).toBe(false);
    expect(await evaluateCondition(c, view({ frameText: () => 'all clear' }))).toBe(true);
  });

  it('with frame: true (absent) when the frame does not exist, mirroring text_visible\'s false', async () => {
    const c: Condition = { kind: 'text_absent', text: 'error', frame: [{ name: 'does-not-exist' }] };
    expect(await evaluateCondition(c, view({ frameText: () => undefined }))).toBe(true);
  });
});

describe('evaluateCondition: element_visible / element_absent', () => {
  it('delegates to hasElement', async () => {
    const target = descriptor();
    const visible: Condition = { kind: 'element_visible', target };
    const absent: Condition = { kind: 'element_absent', target };
    expect(await evaluateCondition(visible, view({ hasElement: () => true }))).toBe(true);
    expect(await evaluateCondition(absent, view({ hasElement: () => true }))).toBe(false);
    expect(await evaluateCondition(visible, view({ hasElement: () => false }))).toBe(false);
    expect(await evaluateCondition(absent, view({ hasElement: () => false }))).toBe(true);
  });
});

describe('evaluateCondition: an element condition and a positional winner after an ambiguity', () => {
  // text (names the element) > structural css (a position).
  const chain = (cssSelector = 'tr:nth-of-type(2) > td'): TargetDescriptor => ({
    description: 'balance cell',
    frame: [],
    locators: [
      { strategy: { kind: 'text', text: 'Balance' }, confidence: 0.7, source: 'recorded' },
      { strategy: { kind: 'css', selector: cssSelector }, confidence: 0.3, source: 'inferred' },
    ],
  });
  // What a surface reports when the text matched two elements and the css then matched one.
  const afterAmbiguity = (): ConditionView =>
    view({ hasElement: () => ({ found: true, strategyIndex: 1, tried: [{ strategyKind: 'text', error: 'ambiguous: 2 matches', ambiguous: true, matches: 2 }] }) });
  const afterMiss = (): ConditionView => view({ hasElement: () => ({ found: true, strategyIndex: 1, tried: [{ strategyKind: 'text', error: 'no match' }] }) });
  const target = chain();

  it('element_visible is false: the position does not say which of the two was meant', async () => {
    expect(await evaluateCondition({ kind: 'element_visible', target }, afterAmbiguity())).toBe(false);
  });

  it('a refusal never makes a condition true: element_absent and not(element_visible) stay false', async () => {
    expect(await evaluateCondition({ kind: 'element_absent', target }, afterAmbiguity())).toBe(false);
    expect(await evaluateCondition({ kind: 'not', of: { kind: 'element_visible', target } }, afterAmbiguity())).toBe(false);
    // Under a double negation the lookup helps again, so it is strict again.
    expect(await evaluateCondition({ kind: 'not', of: { kind: 'element_absent', target } }, afterAmbiguity())).toBe(false);
    expect(await evaluateCondition({ kind: 'not', of: { kind: 'not', of: { kind: 'element_visible', target } } }, afterAmbiguity())).toBe(false);
  });

  it('a positional winner after a plain miss still counts (a checkpoint keeps its fallback)', async () => {
    expect(await evaluateCondition({ kind: 'element_visible', target }, afterMiss())).toBe(true);
    expect(await evaluateCondition({ kind: 'element_absent', target }, afterMiss())).toBe(false);
  });

  it('an identity css winner after an ambiguity counts: it names the element', async () => {
    expect(await evaluateCondition({ kind: 'element_visible', target: chain('td#balance') }, afterAmbiguity())).toBe(true);
  });

  it('positional-ness is judged on the recorded condition when one is given, through all/any/not', async () => {
    // Bound, the selector ends in a number and reads as a position; as recorded it is bound to the input.
    const bound = chain('a[href="/members/12345"]');
    const recorded = chain('a[href="/members/{input.memberId}"]');
    const wrap = (t: TargetDescriptor): Condition => ({ kind: 'all', of: [{ kind: 'text_visible', text: 'member id' }, { kind: 'any', of: [{ kind: 'element_visible', target: t }] }] });
    expect(await evaluateCondition(wrap(bound), afterAmbiguity())).toBe(false);
    expect(await evaluateCondition(wrap(bound), afterAmbiguity(), { recorded: wrap(recorded) })).toBe(true);
    // A recorded condition of another shape is ignored, not misapplied.
    expect(await evaluateCondition(wrap(bound), afterAmbiguity(), { recorded: { kind: 'element_visible', target: recorded } })).toBe(false);
  });
});

describe('evaluateCondition: async hasElement', () => {
  it('awaits a Promise-returning hasElement (live surfaces resolve asynchronously)', async () => {
    const target = { description: 't', frame: [], locators: [{ strategy: { kind: 'text' as const, text: 'x' }, confidence: 0.7, source: 'inferred' as const }] };
    const slow = (v: boolean) => () => new Promise<boolean>((r) => setTimeout(() => r(v), 5));
    expect(await evaluateCondition({ kind: 'element_visible', target }, view({ hasElement: slow(true) }))).toBe(true);
    expect(await evaluateCondition({ kind: 'element_absent', target }, view({ hasElement: slow(true) }))).toBe(false);
    expect(await evaluateCondition({ kind: 'not', of: { kind: 'element_visible', target } }, view({ hasElement: slow(false) }))).toBe(true);
  });
});

describe('evaluateCondition: url_matches (frame-scoped)', () => {
  it('tests the frame url when frame is given, false when the frame is missing', async () => {
    const c: Condition = { kind: 'url_matches', pattern: '/members/12345', frame: [{ name: 'main' }] };
    expect(await evaluateCondition(c, view({ frameUrl: () => 'http://localhost:4173/members/12345' }))).toBe(true);
    expect(await evaluateCondition(c, view({ frameUrl: () => undefined }))).toBe(false);
    expect(await evaluateCondition(c, view({ url: 'http://localhost:4173/members/12345' }))).toBe(false);
  });
});

describe('evaluateCondition: url_matches', () => {
  it('tests the regex (no flags) against view.url', async () => {
    const c: Condition = { kind: 'url_matches', pattern: '/workstation$' };
    expect(await evaluateCondition(c, view())).toBe(true);
    expect(await evaluateCondition({ kind: 'url_matches', pattern: '/login$' }, view())).toBe(false);
  });

  it('is case-sensitive (no implicit flags)', async () => {
    const c: Condition = { kind: 'url_matches', pattern: 'WORKSTATION' };
    expect(await evaluateCondition(c, view())).toBe(false);
  });

  it('throws a clear Error for an invalid regex source', async () => {
    const c: Condition = { kind: 'url_matches', pattern: '(unterminated' };
    await expect(evaluateCondition(c, view())).rejects.toThrow(/invalid regex/i);
  });
});

describe('evaluateCondition: dialog_open', () => {
  it('false when no dialog is present', async () => {
    expect(await evaluateCondition({ kind: 'dialog_open' }, view())).toBe(false);
  });

  it('true when a dialog is present and no messagePattern given', async () => {
    expect(await evaluateCondition({ kind: 'dialog_open' }, view({ dialog: { type: 'alert', message: 'Are you sure?' } }))).toBe(true);
  });

  it('messagePattern is tested against the dialog message, no flags', async () => {
    const c: Condition = { kind: 'dialog_open', messagePattern: '^Are you' };
    expect(await evaluateCondition(c, view({ dialog: { type: 'confirm', message: 'Are you sure?' } }))).toBe(true);
    expect(await evaluateCondition(c, view({ dialog: { type: 'confirm', message: 'are you sure?' } }))).toBe(false);
  });

  it('throws a clear Error for an invalid messagePattern', async () => {
    const c: Condition = { kind: 'dialog_open', messagePattern: '[' };
    await expect(evaluateCondition(c, view({ dialog: { type: 'alert', message: 'x' } }))).rejects.toThrow(/invalid regex/i);
  });
});

describe('evaluateCondition: all / any / not', () => {
  const truthy: Condition = { kind: 'text_visible', text: 'member id' };
  const falsy: Condition = { kind: 'text_visible', text: 'nope' };

  it('all: every sub-condition must hold', async () => {
    expect(await evaluateCondition({ kind: 'all', of: [truthy, truthy] }, view())).toBe(true);
    expect(await evaluateCondition({ kind: 'all', of: [truthy, falsy] }, view())).toBe(false);
  });

  it('any: at least one sub-condition must hold', async () => {
    expect(await evaluateCondition({ kind: 'any', of: [falsy, falsy] }, view())).toBe(false);
    expect(await evaluateCondition({ kind: 'any', of: [falsy, truthy] }, view())).toBe(true);
  });

  it('not: negates the nested condition', async () => {
    expect(await evaluateCondition({ kind: 'not', of: truthy }, view())).toBe(false);
    expect(await evaluateCondition({ kind: 'not', of: falsy }, view())).toBe(true);
  });

  it('nests all/any/not together', async () => {
    const c: Condition = {
      kind: 'all',
      of: [{ kind: 'any', of: [falsy, truthy] }, { kind: 'not', of: falsy }],
    };
    expect(await evaluateCondition(c, view())).toBe(true);
  });
});

/**
 * The text half of screen masking (mask.ts): the matcher, placeholders, the masked view of an
 * observed element, descriptor sanitization (no masked text in any locator, description or
 * snapshot), the omit-URL check, and the omitted-screenshot placeholder.
 */
import { describe, expect, it } from 'vitest';
import { REDACTED_VALUE, type TargetDescriptor } from '../schema/index.js';
import { DEFAULT_POLICY_PATH, loadPolicy } from '../policy/load.js';
import {
  createMaskMatcher,
  isMaskedPlaceholder,
  maskLabelledLines,
  maskDescriptor,
  maskObservedElement,
  maskPlaceholder,
  screenMaskOptionsFromPolicy,
  urlMatchesAny,
} from './mask.js';
import { isOmittedScreenshot, omittedScreenshotPng } from './omitted.js';
import type { ObservedElement } from './types.js';

const VALUE = '$1,234.56';

function valueCellDescriptor(): TargetDescriptor {
  return {
    description: `cell "${VALUE}" (<td>)`,
    frame: [{ name: 'main' }],
    locators: [
      { strategy: { kind: 'text', text: VALUE, exact: true, tag: 'td' }, confidence: 0.7, source: 'inferred' },
      { strategy: { kind: 'relative', anchor: { text: 'Savings Balance' }, relation: 'right-of', tag: 'td' }, confidence: 0.5, source: 'inferred' },
      { strategy: { kind: 'css', selector: 'table > tbody > tr:nth-of-type(6) > td:nth-of-type(2)' }, confidence: 0.3, source: 'inferred' },
      { strategy: { kind: 'bbox', x: 0.3, y: 0.3, w: 0.1, h: 0.03 }, confidence: 0.1, source: 'inferred' },
    ],
    snapshot: { tag: 'td', role: 'cell', name: VALUE, text: VALUE },
  };
}

function valueCell(): ObservedElement {
  return {
    ref: 'e7',
    role: 'cell',
    name: VALUE,
    text: VALUE,
    tag: 'td',
    bbox: { x: 1, y: 2, w: 3, h: 4 },
    frame: [{ name: 'main' }],
    enabled: true,
    descriptor: valueCellDescriptor(),
  };
}

describe('createMaskMatcher', () => {
  it('replaces masked text wherever it occurs, whitespace- and case-insensitively, longest first, in one pass', () => {
    const m = createMaskMatcher([
      { text: '101 Elm St,  Springfield', kind: 'address' },
      { text: 'Elm', kind: 'street' },
      { text: 'Jane Q. Sample', kind: 'member_name' },
    ]);
    expect(m.replace('Ship to 101 elm st,\nSpringfield today')).toBe('Ship to [MASKED:address] today');
    expect(m.replace('Member: Jane Q. Sample (#12345)')).toBe('Member: [MASKED:member_name] (#12345)');
    expect(m.replace('Elm Grove')).toBe('[MASKED:street] Grove');
    expect(m.contains('nothing here')).toBe(false);
  });

  it('never re-matches a placeholder: applying it twice changes nothing', () => {
    const m = createMaskMatcher([{ text: 'MASKED', kind: 'x' }, { text: 'secret value', kind: 'masked' }]);
    const once = m.replace('a secret value b');
    expect(once).toBe('a [MASKED:masked] b');
    expect(m.replace(once)).toBe(once);
  });

  it('a hidden text shorter than 3 characters is masked as a whole token only; a short part of a hidden element not at all', () => {
    const m = createMaskMatcher([
      { text: '42', kind: 'age' },
      { text: 'OK', kind: 'selector', part: true },
      { text: ':', kind: 'selector' },
    ]);
    expect(m.replace('42')).toBe('[MASKED:age]');
    expect(m.replace('Age 42 years')).toBe('Age [MASKED:age] years');
    expect(m.replace('Ref 1420')).toBe('Ref 1420');
    expect(m.replace('OK')).toBe('OK');
    expect(m.replace('Time: 10:30')).toBe('Time: 10:30');
  });

  it('a string cut off inside a masked text has the cut-off tail masked too', () => {
    const m = createMaskMatcher([{ text: '282 Mill St, Springfield, MA 01103', kind: 'address' }]);
    expect(m.replace('12345 Jane Q. Sample 282 Mill St, Spr')).toBe('12345 Jane Q. Sample [MASKED:address]');
    expect(m.replace('282 Mi')).toBe('[MASKED:address]');
    expect(m.replace('Lives at 282')).toBe('Lives at 282'); // under 5 characters: too short to tell
  });

  it('an empty matcher is the identity', () => {
    const m = createMaskMatcher([]);
    expect(m.empty).toBe(true);
    expect(m.replace('anything')).toBe('anything');
  });
});

describe('maskPlaceholder', () => {
  it('slugs the kind and recognizes its own output', () => {
    expect(maskPlaceholder('Savings Balance')).toBe('[MASKED:savings_balance]');
    expect(maskPlaceholder()).toBe('[MASKED]');
    expect(isMaskedPlaceholder('[MASKED:ssn]')).toBe(true);
    expect(isMaskedPlaceholder('[MASKED:ssn] extra')).toBe(false);
  });
});

describe('maskObservedElement / maskDescriptor: no masked text in the text channel or in any locator', () => {
  it('a masked value cell: placeholder text and name, flagged, value-bearing locators dropped, anchor and bbox kept', () => {
    const out = maskObservedElement(valueCell(), createMaskMatcher([{ text: VALUE, kind: 'savings_balance' }]), 'savings_balance');
    expect(out.masked).toBe(true);
    expect(out.text).toBe('[MASKED:savings_balance]');
    expect(out.name).toBe('[MASKED:savings_balance]');
    expect(JSON.stringify(out)).not.toContain('1,234.56');
    expect(out.descriptor.locators.map((l) => l.strategy.kind)).toEqual(['relative', 'css', 'bbox']);
    expect(out.descriptor.snapshot).toEqual({ tag: 'td', role: 'cell', name: '[MASKED:savings_balance]', text: '[MASKED:savings_balance]' });
    expect(out.descriptor.description).toBe('cell "[MASKED:savings_balance]" (<td>)');
  });

  it('a masked element is masked even when the matcher does not know its text (a typed field)', () => {
    const field: ObservedElement = { ...valueCell(), role: 'textbox', tag: 'input', name: 'Search', text: undefined, value: 'typed-key', descriptor: { ...valueCellDescriptor(), snapshot: { tag: 'input', role: 'textbox', name: 'Search' } } };
    const out = maskObservedElement(field, createMaskMatcher([]), 'input');
    expect(out.value).toBe('[MASKED:input]');
    expect(out.name).toBe('Search'); // a label, not content
    expect(out.masked).toBe(true);
  });

  it('a password keeps the [REDACTED] value marker', () => {
    const pw: ObservedElement = { ...valueCell(), role: 'textbox', tag: 'input', name: 'Password', text: undefined, value: REDACTED_VALUE };
    expect(maskObservedElement(pw, createMaskMatcher([]), 'password').value).toBe(REDACTED_VALUE);
  });

  it('an unmasked element containing masked text (a result row) has the text replaced and the carrying locators dropped', () => {
    const row: ObservedElement = {
      ...valueCell(),
      role: 'clickable',
      tag: 'tr',
      name: '12345 Jane Q. Sample 08/15/2004 Active',
      text: '12345 Jane Q. Sample 08/15/2004 Active',
      descriptor: {
        description: 'clickable "12345 Jane Q. Sample 08/15/2004 Active" (<tr>)',
        frame: [],
        locators: [
          { strategy: { kind: 'text', text: '12345', exact: true }, confidence: 0.7, source: 'inferred' },
          { strategy: { kind: 'relative', anchor: { text: 'Jane Q. Sample' }, relation: 'below' }, confidence: 0.5, source: 'inferred' },
          { strategy: { kind: 'bbox', x: 0, y: 0, w: 1, h: 1 }, confidence: 0.1, source: 'inferred' },
        ],
        snapshot: { tag: 'tr', role: 'clickable', name: '12345 Jane Q. Sample 08/15/2004 Active' },
      },
    };
    const out = maskObservedElement(row, createMaskMatcher([{ text: 'Jane Q. Sample', kind: 'member_name' }]));
    expect(out.masked).toBeUndefined();
    expect(out.name).toBe('12345 [MASKED:member_name] 08/15/2004 Active');
    expect(out.descriptor.locators.map((l) => l.strategy.kind)).toEqual(['text', 'bbox']);
    expect(JSON.stringify(out)).not.toContain('Jane');
  });

  it('a css selector quoting masked text is dropped too', () => {
    const d: TargetDescriptor = {
      description: 'x',
      frame: [],
      locators: [
        { strategy: { kind: 'css', selector: 'a[title="Jane Q. Sample"]' }, confidence: 0.3, source: 'inferred' },
        { strategy: { kind: 'bbox', x: 0, y: 0, w: 1, h: 1 }, confidence: 0.1, source: 'inferred' },
      ],
    };
    expect(maskDescriptor(d, createMaskMatcher([{ text: 'Jane Q. Sample', kind: 'n' }])).locators.map((l) => l.strategy.kind)).toEqual(['bbox']);
  });

  it('exact, within and selector: a relative locator whose anchor, container or candidate selector carries masked text (verbatim or slugged) is dropped', () => {
    const rel = (anchor: string, extra: { exact?: boolean; within?: string; selector?: string }) => ({
      strategy: { kind: 'relative' as const, anchor: { text: anchor, ...(extra.exact !== undefined ? { exact: extra.exact } : {}) }, relation: 'below' as const, tag: 'div', ...(extra.within ? { within: extra.within } : {}), ...(extra.selector ? { selector: extra.selector } : {}) },
      confidence: 0.5,
      source: 'inferred' as const,
    });
    const d: TargetDescriptor = {
      description: 'x',
      frame: [],
      locators: [
        rel('Jane Q. Sample', { exact: true, within: 'div.card' }), // exact anchor on the masked name
        rel('Order total', { within: 'div.customer-jane-q-sample' }), // the container's class slugs the name
        rel('Order total', { within: 'div.card', selector: 'span.acct-40121234' }), // the candidate's class slugs the account
        rel('Order total', { within: 'div.card', selector: 'span.total' }), // clean: kept
        { strategy: { kind: 'css', selector: '#row-jane-q-sample' }, confidence: 0.3, source: 'inferred' },
        { strategy: { kind: 'bbox', x: 0, y: 0, w: 1, h: 1 }, confidence: 0.1, source: 'inferred' },
      ],
    };
    const m = createMaskMatcher([
      { text: 'Jane Q. Sample', kind: 'customer' },
      { text: '4012 1234', kind: 'account' },
    ]);
    const out = maskDescriptor(d, m);
    expect(out.locators).toEqual([d.locators[3], d.locators[5]]);
    expect(m.containsSlugged('div.card')).toBe(false);
    // A short masked text is never compared slugged (it would match inside unrelated identifiers);
    // verbatim, it still is (the matcher's substring rule).
    const short = createMaskMatcher([{ text: 'Ann', kind: 'n' }]);
    expect(short.containsSlugged('div.a-n-n')).toBe(false);
    expect(short.containsSlugged('div.banner')).toBe(true);
  });

  it('a text leaf holding only a fragment of a masked value is a masked element: its description and snapshot never quote the fragment', () => {
    const frag: ObservedElement = {
      ...valueCell(),
      role: 'generic',
      tag: 'span',
      name: '1 Main',
      text: '1 Main',
      descriptor: {
        description: 'generic "1 Main" (<span>)',
        frame: [],
        locators: [
          { strategy: { kind: 'text', text: '1 Main', exact: true, tag: 'span' }, confidence: 0.7, source: 'inferred' },
          { strategy: { kind: 'bbox', x: 0, y: 0, w: 1, h: 1 }, confidence: 0.1, source: 'inferred' },
        ],
        snapshot: { tag: 'span', role: 'generic', name: '1 Main', text: '1 Main' },
      },
    };
    // The matcher only knows the whole value; "1 Main" is caught by its cut-off rule alone.
    const out = maskObservedElement(frag, createMaskMatcher([{ text: '1 Main St', kind: 'address' }]));
    expect(out.masked).toBe(true);
    expect(out.text).toBe('[MASKED:address]');
    expect(JSON.stringify(out)).not.toContain('1 Main');
    expect(out.descriptor.locators.map((l) => l.strategy.kind)).toEqual(['bbox']);
  });

  it("a masked element's own text slugged into its own class or container drops that locator", () => {
    const el: ObservedElement = {
      ...valueCell(),
      role: 'generic',
      tag: 'span',
      name: 'Jane Sample',
      text: 'Jane Sample',
      descriptor: {
        description: 'generic "Jane Sample" (<span>)',
        frame: [],
        locators: [
          { strategy: { kind: 'relative', anchor: { text: 'Customer' }, relation: 'right-of', tag: 'span', selector: 'span.name-jane-sample' }, confidence: 0.5, source: 'inferred' },
          { strategy: { kind: 'relative', anchor: { text: 'Customer' }, relation: 'right-of', tag: 'span', within: 'div.party' }, confidence: 0.5, source: 'inferred' },
          { strategy: { kind: 'bbox', x: 0, y: 0, w: 1, h: 1 }, confidence: 0.1, source: 'inferred' },
        ],
      },
    };
    const out = maskObservedElement(el, createMaskMatcher([]), 'customer');
    expect(out.descriptor.locators.map((l) => (l.strategy.kind === 'relative' ? l.strategy.within ?? l.strategy.selector : l.strategy.kind))).toEqual(['div.party', 'bbox']);
  });
});

describe('policy wiring', () => {
  it('screenMaskOptionsFromPolicy resolves the block and carries the redaction patterns and the run-value getter', () => {
    const policy = loadPolicy(DEFAULT_POLICY_PATH);
    let values = ['a'];
    const opts = screenMaskOptionsFromPolicy(policy, () => values);
    expect(opts.config.maskInputs).toBe('all');
    expect(opts.config.maskLabels.length).toBeGreaterThan(0);
    expect(opts.textPatterns.map((p) => p.name)).toEqual(expect.arrayContaining(['ssn', 'card']));
    values = ['b'];
    expect(opts.sensitiveValues?.()).toEqual(['b']);
  });

  it('urlMatchesAny matches any URL against the policy sources case-insensitively; an invalid source matches (fail closed)', () => {
    expect(urlMatchesAny(['http://x/top', 'http://x/Members/7/SSN'], ['/members/\\d+/ssn$'])).toBe(true);
    expect(urlMatchesAny(['http://x/top'], ['/members/'])).toBe(false);
    expect(urlMatchesAny(['http://x/top'], ['('])).toBe(true);
    expect(urlMatchesAny(['http://x/top'], [])).toBe(false);
  });
});

describe('omitted screenshot placeholder', () => {
  it('is a valid PNG carrying its marker, a fresh copy each time, and is told apart from a capture', () => {
    const a = omittedScreenshotPng();
    expect(a.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(isOmittedScreenshot(a)).toBe(true);
    a[100] = 0;
    expect(omittedScreenshotPng()[100]).not.toBe(0);
    expect(isOmittedScreenshot(Buffer.from('not a placeholder'))).toBe(false);
    expect(isOmittedScreenshot(undefined)).toBe(false);
  });
});

describe('review fixes: tokens, patterns, controls, labelled lines, scale', () => {
  it('a token text (a learned value) matches only as a whole token', () => {
    const m = createMaskMatcher([{ text: '0.00', kind: 'sensitive', token: true }]);
    expect(m.replace('Balance 0.00 today')).toBe('Balance [MASKED:sensitive] today');
    expect(m.replace('Fees $10.00 and $1,250.00')).toBe('Fees $10.00 and $1,250.00');
  });

  it('patterns run after the texts, and never inside a placeholder', () => {
    const m = createMaskMatcher([{ text: 'Pat Example', kind: 'name' }], { patterns: [{ name: 'ssn', regex: '\\b\\d{3}-\\d{2}-\\d{4}\\b' }] });
    expect(m.replace('Pat Example SSN 123-45-6789')).toBe('[MASKED:name] SSN [MASKED:ssn]');
    expect(m.replace('[MASKED:ssn]')).toBe('[MASKED:ssn]');
  });

  it('a masked control keeps its verb; a masked non-field element hides an aria-label name too', () => {
    const m = createMaskMatcher([{ text: 'Ann Lee', kind: 'name' }]);
    const del = maskObservedElement({ ...valueCell(), role: 'link', tag: 'a', name: 'Delete Ann Lee', text: 'Delete Ann Lee' }, m, 'name');
    expect(del).toMatchObject({ name: 'Delete [MASKED:name]', text: 'Delete [MASKED:name]', masked: true });
    const aria = maskObservedElement({ ...valueCell(), role: 'cell', tag: 'td', name: 'Member Ann Lee', text: 'Member card' }, createMaskMatcher([]), 'selector');
    expect(aria.name).toBe('[MASKED:selector]');
  });

  it('maskLabelledLines hides the rest of a "Label: value" line under a matching label', () => {
    expect(maskLabelledLines('Saved.\nAddress: 1 Main St\nBranch: North', ['address'])).toBe('Saved.\nAddress: [MASKED:address]\nBranch: North');
  });

  it('maskLabelledLines: whole-label match anywhere in a line, several pairs, full-width colons; a label word inside a longer label is not one', () => {
    const labels = ['address', 'phone'];
    expect(maskLabelledLines('Confirm mail. Address: 1 Main St Phone: 413-555-0100 Branch: North', labels)).toBe(
      'Confirm mail. Address: [MASKED:address] Phone: [MASKED:phone] Branch: North',
    );
    expect(maskLabelledLines('Address：1 Wide St', labels)).toBe('Address：[MASKED:address]');
    expect(maskLabelledLines('Phone﹕ 413-555-0188', labels)).toBe('Phone﹕ [MASKED:phone]');
    for (const visible of ['Address book: 12 entries', 'Phone support hours: 9 to 5', 'Address verified: yes', 'See https://intranet/address: details', 'Call at 10:30 today']) {
      expect(maskLabelledLines(visible, labels)).toBe(visible);
    }
  });

  it('scales: thousands of masked texts over a long digest in well under a second', () => {
    const texts = Array.from({ length: 5000 }, (_, i) => ({ text: `${100 + i} Elm St, Springfield`, kind: 'address' }));
    const m = createMaskMatcher(texts);
    const digest = Array.from({ length: 400 }, (_, i) => `Row ${i} ${100 + i} Elm St, Springfield Active`).join(' ');
    const started = Date.now();
    const out = m.replace(digest);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(out).not.toContain('Elm St');
  });
});

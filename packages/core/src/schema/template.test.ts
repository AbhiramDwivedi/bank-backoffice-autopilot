import { describe, expect, it } from 'vitest';
import type { Condition, Step, TargetDescriptor } from './index.js';
import {
  bindCondition,
  bindDescriptor,
  bindStep,
  bindTemplate,
  bindValue,
  collectInputPlaceholders,
  UnboundPlaceholderError,
  urlValuePattern,
} from './template.js';

const ctx = {
  baseUrl: 'http://localhost:4173',
  inputs: { memberId: '12345', amount: 50 },
  secret: (e: string) => (e === 'MOCK_PASSWORD' ? 'pw' : undefined),
};

describe('bindTemplate', () => {
  it('replaces baseUrl and input placeholders', () => {
    expect(bindTemplate('{baseUrl}/members/{input.memberId}?a={input.amount}', ctx)).toBe(
      'http://localhost:4173/members/12345?a=50',
    );
  });
  it('throws on unknown input placeholder', () => {
    expect(() => bindTemplate('{input.nope}', ctx)).toThrow(UnboundPlaceholderError);
  });
  it('leaves non-placeholder braces alone', () => {
    expect(bindTemplate('literal {not a placeholder}', ctx)).toBe('literal {not a placeholder}');
  });
});

describe('bindValue', () => {
  it('binds input, literal (templated) and secret', () => {
    expect(bindValue({ kind: 'input', name: 'memberId' }, ctx)).toBe('12345');
    expect(bindValue({ kind: 'literal', value: 'm-{input.memberId}' }, ctx)).toBe('m-12345');
    expect(bindValue({ kind: 'secret', env: 'MOCK_PASSWORD' }, ctx)).toBe('pw');
  });
  it('fails loudly on a missing secret or input', () => {
    expect(() => bindValue({ kind: 'secret', env: 'MISSING' }, ctx)).toThrow(/MISSING/);
    expect(() => bindValue({ kind: 'input', name: 'zzz' }, ctx)).toThrow(UnboundPlaceholderError);
  });
});

const target: TargetDescriptor = {
  description: 'Result row for member {input.memberId}',
  frame: [{ name: 'main' }],
  locators: [
    { strategy: { kind: 'text', text: '{input.memberId}', tag: 'tr' }, confidence: 0.8, source: 'recorded' },
    {
      strategy: { kind: 'relative', anchor: { text: '{input.memberId}' }, relation: 'same-row' },
      confidence: 0.5,
      source: 'inferred',
    },
    { strategy: { kind: 'bbox', x: 0.1, y: 0.2, w: 0.3, h: 0.05 }, confidence: 0.1, source: 'inferred' },
  ],
};

describe('bindDescriptor / bindCondition / bindStep', () => {
  it("binds a relative locator's selector the way a css selector is bound: input values CSS-escaped", () => {
    const d: TargetDescriptor = {
      description: 'price',
      frame: [],
      locators: [
        {
          strategy: {
            kind: 'relative',
            anchor: { text: '{input.memberId}', exact: true },
            relation: 'below',
            tag: 'div',
            selector: 'div.m-{input.memberId}',
            within: 'div.c-{input.memberId}',
          },
          confidence: 0.5,
          source: 'inferred',
        },
      ],
    };
    const bound = bindDescriptor(d, { ...ctx, inputs: { memberId: 'a b' } });
    expect(bound.locators[0]!.strategy).toEqual({
      kind: 'relative',
      anchor: { text: 'a b', exact: true },
      relation: 'below',
      tag: 'div',
      selector: 'div.m-a\\ b',
      within: 'div.c-a\\ b',
    });
    // No selector: none is added.
    expect(bindDescriptor(target, ctx).locators[1]!.strategy).not.toHaveProperty('selector');
  });

  it('binds templated strings inside locators without mutating the input', () => {
    const bound = bindDescriptor(target, ctx);
    expect(bound.description).toBe('Result row for member 12345');
    expect(bound.locators[0]!.strategy).toMatchObject({ kind: 'text', text: '12345' });
    expect(bound.locators[1]!.strategy).toMatchObject({ kind: 'relative', anchor: { text: '12345' } });
    expect(target.locators[0]!.strategy).toMatchObject({ text: '{input.memberId}' });
  });
  it('binds nested conditions', () => {
    const c: Condition = {
      kind: 'all',
      of: [
        { kind: 'text_visible', text: 'Member {input.memberId}' },
        { kind: 'not', of: { kind: 'url_matches', pattern: '/members/{input.memberId}$' } },
      ],
    };
    expect(bindCondition(c, ctx)).toEqual({
      kind: 'all',
      of: [
        { kind: 'text_visible', text: 'Member 12345' },
        { kind: 'not', of: { kind: 'url_matches', pattern: '/members/12345$' } },
      ],
    });
  });
  it('binds a step, resolving the value binding to a string', () => {
    const step: Step = {
      id: 's1',
      name: 'type',
      action: { type: 'type', target, value: { kind: 'input', name: 'memberId' } },
      risk: 'read',
      postcondition: { kind: 'text_visible', text: '{input.memberId}' },
    };
    const b = bindStep(step, ctx);
    expect(b.action).toMatchObject({ type: 'type', value: '12345' });
    expect(b.postcondition).toEqual({ kind: 'text_visible', text: '12345' });
  });
});

describe('collectInputPlaceholders', () => {
  it('finds placeholders anywhere in a tree', () => {
    const found = collectInputPlaceholders({ a: '{input.x}', b: ['{baseUrl}', { c: 'hi {input.y} {input.x}' }] });
    expect([...found].sort()).toEqual(['x', 'y']);
  });
});

describe('url_matches binding of URL-encoded values', () => {
  const bindUrl = (pattern: string, inputs: Record<string, string>): RegExp => {
    const bound = bindCondition({ kind: 'url_matches', pattern }, { baseUrl: 'http://localhost:4173', inputs }) as Extract<Condition, { kind: 'url_matches' }>;
    return new RegExp(bound.pattern);
  };

  it('matches a query value raw, percent-encoded and form-encoded', () => {
    const re = bindUrl('[?&]q={input.q}(?![A-Za-z0-9])', { q: 'Mary Ann' });
    expect(re.test('http://h/search?q=Mary Ann')).toBe(true);
    expect(re.test('http://h/search?q=Mary%20Ann')).toBe(true);
    expect(re.test('http://h/search?q=Mary+Ann')).toBe(true);
    expect(re.test('http://h/search?q=Mary+Beth')).toBe(false);
  });

  it('matches a path segment raw and percent-encoded', () => {
    const re = bindUrl('/people/{input.name}(?![A-Za-z0-9])', { name: 'O Brien' });
    expect(re.test('http://h/people/O%20Brien')).toBe(true);
    expect(re.test('http://h/people/O Brien')).toBe(true);
    expect(re.test('http://h/people/O+Brien')).toBe(true);
    expect(re.test('http://h/people/O%20Briens')).toBe(false);
    expect(re.test('http://h/people/Smith')).toBe(false);
  });

  it('binds a value no encoding changes as the escaped value alone', () => {
    expect(urlValuePattern('12345')).toBe('12345');
    expect(urlValuePattern('a.b')).toBe(String.raw`a\.b`);
  });

  it('encodes regex metacharacters in every alternative', () => {
    const re = bindUrl('^/q/{input.v}$', { v: 'a+b c' });
    expect(re.test('/q/a+b c')).toBe(true);
    expect(re.test('/q/a%2Bb%20c')).toBe(true);
    expect(re.test('/q/a%2Bb+c')).toBe(true);
    expect(re.test('/q/aab c')).toBe(false);
  });

  it('leaves text conditions and dialog message patterns bound to the raw value', () => {
    const inputs = { baseUrl: 'x', inputs: { v: 'Mary Ann' } };
    expect(bindCondition({ kind: 'text_visible', text: 'Hi {input.v}' }, inputs)).toEqual({ kind: 'text_visible', text: 'Hi Mary Ann' });
    expect(bindCondition({ kind: 'dialog_open', messagePattern: '{input.v}' }, inputs)).toEqual({ kind: 'dialog_open', messagePattern: 'Mary Ann' });
  });
});

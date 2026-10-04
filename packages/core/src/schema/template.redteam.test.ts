/**
 * Template/regex injection via `{input.x}` placeholders.
 *
 * A `{input.x}` bound into a `url_matches` pattern or a `dialog_open.messagePattern` is compiled
 * as a regex source with no flags. Splicing the raw input value straight into the pattern string
 * would let an attacker-controlled input change the pattern's regex semantics (broaden a match,
 * e.g. `.*`) or hand the surface an unparseable regex.
 *
 * A `{input.x}` bound into a `css` locator's selector is compiled by the real Playwright surface
 * as a literal CSS selector (`frame.locator(strat.selector)` in `packages/adapter-playwright/src/resolve.ts`).
 * An unescaped substitution could break out of the surrounding selector fragment (close a quoted
 * attribute value, add a selector via `,`, or select everything via `*`).
 *
 * `packages/core/src/schema/template.ts` makes the binder field-aware: `bindUrlPattern` (an
 * alternation of the regex-escaped raw and URL-encoded forms of each value) for
 * `url_matches.pattern`, `bindPattern` (regex-escapes every substituted value) for
 * `dialog_open.messagePattern`, and
 * `bindCssSelector` (CSS-escapes) for a `css` locator's `selector`, while every plain-text field
 * (locator names/labels/texts, descriptions, literal values) keeps using unescaped `bindTemplate`.
 */
import { describe, expect, it } from 'vitest';
import type { Condition, TargetDescriptor } from './index.js';
import { bindCondition, bindDescriptor, bindTemplate, cssEscape, escapeRegExp } from './template.js';

const baseCtx = { baseUrl: 'http://localhost:4173', inputs: {} as Record<string, string | number | boolean> };

function ctxWith(accountId: string) {
  return { ...baseCtx, inputs: { accountId } };
}

// ---------------------------------------------------------------------------------------------
// url_matches
// ---------------------------------------------------------------------------------------------

describe('url_matches pattern injection', () => {
  const pattern = '/accounts/{input.accountId}$';
  const REAL_ACCOUNT_URL = 'http://localhost:4173/accounts/99999';

  const MALICIOUS_VALUES = ['.*', '12345|.*', '(', '$', '\\', '[a-z]+'];

  it.each(MALICIOUS_VALUES)(
    'accountId %j does not broaden url_matches semantics: /accounts/99999 does not match unless accountId literally is 99999',
    (value) => {
      const bound = bindCondition({ kind: 'url_matches', pattern }, ctxWith(value)) as Extract<Condition, { kind: 'url_matches' }>;
      // The bound pattern must compile (guarantee (b): never an invalid regex from escaping).
      const re = new RegExp(bound.pattern);
      // Guarantee (a): a malicious accountId must never match a DIFFERENT, real account's URL.
      expect(re.test(REAL_ACCOUNT_URL)).toBe(false);
    },
  );

  it('a legitimate accountId still matches its own URL (the fix does not break real usage)', () => {
    const bound = bindCondition({ kind: 'url_matches', pattern }, ctxWith('99999')) as Extract<Condition, { kind: 'url_matches' }>;
    expect(new RegExp(bound.pattern).test(REAL_ACCOUNT_URL)).toBe(true);
    expect(new RegExp(bound.pattern).test('http://localhost:4173/accounts/99999X')).toBe(false);
  });

  it('every malicious value still compiles to a valid RegExp (no uncaught SyntaxError at bind time)', () => {
    for (const value of MALICIOUS_VALUES) {
      const bound = bindCondition({ kind: 'url_matches', pattern }, ctxWith(value)) as Extract<Condition, { kind: 'url_matches' }>;
      expect(() => new RegExp(bound.pattern)).not.toThrow();
    }
  });

  it('escapeRegExp neutralizes every JS regex metacharacter', () => {
    expect(escapeRegExp('.*+?^${}()|[]\\')).toBe('\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\');
    // sanity: the escaped text matches only itself, literally.
    expect(new RegExp(`^${escapeRegExp('a.b*c')}$`).test('a.b*c')).toBe(true);
    expect(new RegExp(`^${escapeRegExp('a.b*c')}$`).test('axbc')).toBe(false);
  });
});

describe('dialog_open.messagePattern injection', () => {
  it('an {input.x} substitution into messagePattern is regex-escaped, not left as unparsed regex syntax', () => {
    const bound = bindCondition(
      { kind: 'dialog_open', messagePattern: '^Confirm transfer of {input.amount}\\?$' },
      { ...baseCtx, inputs: { amount: '.*' } },
    ) as Extract<Condition, { kind: 'dialog_open' }>;
    const re = new RegExp(bound.messagePattern!);
    expect(re.test('Confirm transfer of 500?')).toBe(false); // a real, different amount must not match
    expect(re.test('Confirm transfer of .*?')).toBe(true); // the literal value it was actually bound with does
  });
});

// ---------------------------------------------------------------------------------------------
// css locator injection
// ---------------------------------------------------------------------------------------------

describe('css locator selector injection', () => {
  function cssTarget(selector: string): TargetDescriptor {
    return {
      description: 'Row for account {input.id} (test)',
      frame: [],
      locators: [{ strategy: { kind: 'css', selector }, confidence: 0.3, source: 'recorded' }],
    };
  }

  const ATTACK_ID = 'x"], *, [a="';

  it('a quote/comma/star payload cannot break out of a quoted attribute selector', () => {
    const target = cssTarget('[data-id="{input.id}"]');
    const bound = bindDescriptor(target, { ...baseCtx, inputs: { id: ATTACK_ID } });
    const selector = (bound.locators[0]!.strategy as { selector: string }).selector;
    // Must NOT be the naive (vulnerable) substitution, which would read as: an empty
    // `[data-id="x"]` selector, OR a universal `*` selector, OR a broken `[a="` fragment --
    // i.e. it must not contain an unescaped closing quote followed by the rest of the payload.
    const naive = `[data-id="${ATTACK_ID}"]`;
    expect(selector).not.toBe(naive);
    // It is exactly what cssEscape() (this module's own escaping primitive, verified against the
    // CSS.escape() algorithm below) produces for the payload -- i.e. bindDescriptor's `css` case
    // really does route the substitution through it.
    expect(selector).toBe(`[data-id="${cssEscape(ATTACK_ID)}"]`);
    // The escaped payload still ends with an (escaped) closing quote immediately before the
    // selector's own closing `"]` -- i.e. the payload's `"` never terminated the attribute value
    // early, it stayed inside as `\"`.
    expect(selector.endsWith('\\""]')).toBe(true);
  });

  it('an unquoted substitution position is also neutralized (identifier-style escaping)', () => {
    const target = cssTarget('input[name={input.id}]');
    const bound = bindDescriptor(target, { ...baseCtx, inputs: { id: '*],*{color:red}//' } });
    const selector = (bound.locators[0]!.strategy as { selector: string }).selector;
    expect(selector).not.toContain('*],*'); // the raw payload must never appear unescaped
  });

  it('cssEscape matches the CSS.escape() algorithm on ordinary and edge-case input', () => {
    expect(cssEscape('foo')).toBe('foo');
    expect(cssEscape('-foo')).toBe('-foo');
    expect(cssEscape('--foo')).toBe('--foo');
    expect(cssEscape('1foo')).toBe('\\31 foo');
    expect(cssEscape('-')).toBe('\\-');
    expect(cssEscape('"')).toBe('\\"');
    expect(cssEscape('\\')).toBe('\\\\');
    expect(cssEscape(',')).toBe('\\,');
    expect(cssEscape('*')).toBe('\\*');
  });

  it('a benign id (matching a realistic pattern) round-trips unchanged in effect', () => {
    const target = cssTarget('[data-id="{input.id}"]');
    const bound = bindDescriptor(target, { ...baseCtx, inputs: { id: 'ACC-12345' } });
    const selector = (bound.locators[0]!.strategy as { selector: string }).selector;
    expect(selector).toBe('[data-id="ACC-12345"]');
  });
});

// ---------------------------------------------------------------------------------------------
// Plain-text fields are not escaped (role/label/text locators, literal values)
// ---------------------------------------------------------------------------------------------

describe('plain-text fields stay unescaped (they are compared as strings, not compiled)', () => {
  it('bindTemplate with no escape function leaves regex metacharacters untouched', () => {
    expect(bindTemplate('Member {input.memberId}', { ...baseCtx, inputs: { memberId: '.*[x]' } })).toBe('Member .*[x]');
  });

  it('a role/text locator name is substituted literally, not regex- or css-escaped', () => {
    const target: TargetDescriptor = {
      description: 'x',
      frame: [],
      locators: [{ strategy: { kind: 'text', text: 'Row {input.id}' }, confidence: 0.5, source: 'recorded' }],
    };
    const bound = bindDescriptor(target, { ...baseCtx, inputs: { id: '.*' } });
    expect((bound.locators[0]!.strategy as { text: string }).text).toBe('Row .*');
  });
});

// ---------------------------------------------------------------------------------------------
// Documented limitation: role locator `name` never builds a query, so it is not an injection
// surface even though it's a plain-text field (mirrors the FakeSurface / Playwright resolver,
// which compares it via substring/exact text match, never via a selector engine).
// ---------------------------------------------------------------------------------------------

describe('documented limitation: FrameHop.urlPattern is never templated at all', () => {
  it('a {input.x} placeholder inside a FrameHop.urlPattern is left completely unbound (not an injection risk, but also not a working feature)', () => {
    // Neither bindDescriptor (TargetDescriptor.frame) nor bindCondition (Condition.frame, e.g. on
    // url_matches/text_visible) ever touches the `frame` field -- it is spread through untouched.
    // So a `{input.x}` placeholder written into a `FrameHop.urlPattern` can never be exploited by
    // an attacker-controlled input value (nothing is ever substituted into it), but templating a
    // frame hop's urlPattern would need a `bindFramePath` wired into both bindDescriptor and
    // bindCondition, which does not exist yet.
    const target: TargetDescriptor = {
      description: 'x',
      frame: [{ name: 'main', urlPattern: '/members/{input.memberId}' }],
      locators: [{ strategy: { kind: 'text', text: 'x' }, confidence: 0.5, source: 'recorded' }],
    };
    const bound = bindDescriptor(target, { ...baseCtx, inputs: { memberId: '12345' } });
    expect(bound.frame).toEqual(target.frame); // untouched: still the raw, unbound placeholder
    expect(bound.frame[0]!.urlPattern).toBe('/members/{input.memberId}');
  });
});

describe('role locator name is compared as text, not used to build a selector', () => {
  it('quote/backslash/comma characters in a role name have no special meaning', () => {
    const payload = '"], *, [a="';
    const target: TargetDescriptor = {
      description: 'x',
      frame: [],
      locators: [{ strategy: { kind: 'role', role: 'button', name: 'Row {input.id}' }, confidence: 0.9, source: 'recorded' }],
    };
    const bound = bindDescriptor(target, { ...baseCtx, inputs: { id: payload } });
    // Substituted verbatim (a role name is matched as plain text; see fake.ts's locatorTextMatches
    // and the real Playwright resolver's accessible-name comparison -- neither treats it as a
    // selector), so the raw payload appears unchanged rather than being escaped.
    expect((bound.locators[0]!.strategy as { name: string }).name).toBe(`Row ${payload}`);
  });
});

/**
 * Input validation edge cases and adversarial inputs for `validate-inputs.ts`.
 *
 * Covers: pattern anchoring / multiline tricks, an invalid `InputSpec.pattern` becoming a
 * structured failure rather than an uncaught throw, `__proto__`/`constructor`-named declared
 * inputs, unknown/extra input keys, missing required inputs, and numeric coercion edge cases.
 */
import { describe, expect, it } from 'vitest';
import { validateInputs } from './validate-inputs.js';
import type { InputSpec } from '../schema/index.js';

function digitsSpec(overrides: Partial<InputSpec> = {}): Record<string, InputSpec> {
  return { code: { type: 'string', description: 'digits only', required: true, sensitive: false, pattern: '^\\d+$', ...overrides } };
}

// ---------------------------------------------------------------------------------------------
// Pattern enforcement: anchoring, multiline, empty string
// ---------------------------------------------------------------------------------------------

describe('InputSpec.pattern is enforced without an implicit multiline flag or implicit anchors', () => {
  it('rejects a regex-metacharacter payload (`.*`) that is not itself all digits', () => {
    const result = validateInputs(digitsSpec(), { code: '.*' });
    expect(result.ok).toBe(false);
  });

  it('rejects a value with an embedded space ("1 2")', () => {
    const result = validateInputs(digitsSpec(), { code: '1 2' });
    expect(result.ok).toBe(false);
  });

  it('rejects a multiline payload ("12\\n34"): the pattern is compiled with NO `m` flag, so `^`/`$` anchor to the whole string, not per line', () => {
    const result = validateInputs(digitsSpec(), { code: '12\n34' });
    expect(result.ok).toBe(false);
  });

  it('an empty string on a REQUIRED input is rejected as "required", never silently accepted as matching the pattern', () => {
    const result = validateInputs(digitsSpec(), { code: '' });
    expect(result).toEqual({ ok: false, input: 'code', problem: 'input "code" is required' });
  });

  it('an empty string on an OPTIONAL patterned input is treated as "not provided" -- omitted from `values`, never stored as `""` -- so a template referencing it would still throw UnboundPlaceholderError rather than silently bind empty', () => {
    const result = validateInputs(digitsSpec({ required: false }), { code: '' });
    expect(result).toEqual({ ok: true, values: {} });
    expect(Object.prototype.hasOwnProperty.call((result as { values: object }).values, 'code')).toBe(false);
  });

  it('accepts the legitimate value', () => {
    const result = validateInputs(digitsSpec(), { code: '123456' });
    expect(result).toEqual({ ok: true, values: { code: '123456' } });
  });
});

describe('an invalid InputSpec.pattern becomes a structured failure, never an uncaught throw', () => {
  it('a non-compiling pattern is reported as input_validation-shaped failure, not a SyntaxError', () => {
    expect(() => validateInputs(digitsSpec({ pattern: '[unterminated' }), { code: '123' })).not.toThrow();
    const result = validateInputs(digitsSpec({ pattern: '[unterminated' }), { code: '123' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.input).toBe('code');
      expect(result.problem.toLowerCase()).toContain('invalid pattern');
    }
  });
});

// ---------------------------------------------------------------------------------------------
// __proto__ / constructor input names
// ---------------------------------------------------------------------------------------------

describe('__proto__ / constructor as input names', () => {
  // NOTE: these two tests deliberately build `specs`/`raw` via `JSON.parse`, not a `{ __proto__:
  // ... }` object literal. A `__proto__: value` PropertyDefinition in *source* (quoted or not) is
  // grammar-special-cased by JS itself to set the object's prototype rather than create an own
  // property -- so a hand-written literal would test the wrong thing entirely. `JSON.parse` uses
  // `CreateDataProperty` internally and does NOT special-case it, which also matches the real
  // attack surface: a capability artifact or an invocation's raw inputs arrive as parsed JSON.

  it('"__proto__" as an UNDECLARED raw key is rejected as "not declared" (never silently merged or ignored)', () => {
    const specs: Record<string, InputSpec> = { memberId: { type: 'string', description: 'x', required: true, sensitive: false } };
    const raw = JSON.parse('{"memberId":"1","__proto__":{"polluted":true}}') as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(raw, '__proto__')).toBe(true); // sanity: really an own property
    const result = validateInputs(specs, raw);
    expect(result).toEqual({ ok: false, input: '__proto__', problem: 'input "__proto__" is not declared by this capability' });
  });

  it('"__proto__" as a DECLARED input name is stored as a genuine own property, not silently dropped by the inherited __proto__ setter', () => {
    // `[A-Za-z_][A-Za-z0-9_]*` (the schema's Identifier regex) legally matches "__proto__", so a
    // capability author (or an attacker who can influence a capability artifact) could declare
    // it as an input name. Before the fix, `values` was a plain `{}`: assigning
    // `values['__proto__'] = 'evil'` invokes the inherited `Object.prototype.__proto__` setter
    // instead of creating an own property (the setter no-ops on a non-object/non-null value), so
    // the input silently vanished from `values` even though validation reported `ok: true`.
    const specs = JSON.parse(
      '{"__proto__":{"type":"string","description":"x","required":true,"sensitive":false}}',
    ) as Record<string, InputSpec>;
    expect(Object.prototype.hasOwnProperty.call(specs, '__proto__')).toBe(true); // sanity
    const raw = JSON.parse('{"__proto__":"evil-value"}') as Record<string, unknown>;
    const result = validateInputs(specs, raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.prototype.hasOwnProperty.call(result.values, '__proto__')).toBe(true);
      expect((result.values as Record<string, unknown>)['__proto__']).toBe('evil-value');
      // And the returned `values` object's actual prototype was never altered by the assignment.
      expect(Object.getPrototypeOf(result.values)).toBe(null);
    }
  });

  it('"constructor" as a declared input name behaves like any other identifier', () => {
    const specs: Record<string, InputSpec> = {};
    specs['constructor'] = { type: 'string', description: 'x', required: true, sensitive: false };
    const raw: Record<string, unknown> = {};
    raw['constructor'] = 'not-a-function';
    const result = validateInputs(specs, raw);
    expect(result).toEqual({ ok: true, values: { constructor: 'not-a-function' } });
  });
});

// ---------------------------------------------------------------------------------------------
// Unknown inputs, missing required, sensitive leakage (existing guarantees, re-asserted here)
// ---------------------------------------------------------------------------------------------

describe('unknown/extra inputs are rejected, never silently passed through', () => {
  it('an extra key not declared by the capability is rejected', () => {
    const specs: Record<string, InputSpec> = { memberId: { type: 'string', description: 'x', required: true, sensitive: false } };
    const result = validateInputs(specs, { memberId: '1', extraParam: 'attacker-controlled' });
    expect(result).toEqual({ ok: false, input: 'extraParam', problem: 'input "extraParam" is not declared by this capability' });
  });
});

describe('a missing required input is rejected before anything is bound', () => {
  it('missing required input', () => {
    const specs: Record<string, InputSpec> = { memberId: { type: 'string', description: 'x', required: true, sensitive: false } };
    expect(validateInputs(specs, {})).toEqual({ ok: false, input: 'memberId', problem: 'input "memberId" is required' });
  });
});

describe('a sensitive input value is never echoed in a validation failure', () => {
  it('a sensitive input failing its pattern never appears in `problem`', () => {
    const distinctive = 'sunshine-distinctive-secret';
    const specs: Record<string, InputSpec> = { pin: { type: 'string', description: 'pin', required: true, sensitive: true, pattern: '^[0-9]{4}$' } };
    const result = validateInputs(specs, { pin: distinctive });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(distinctive);
  });
});

// ---------------------------------------------------------------------------------------------
// Numeric coercion edge cases
// ---------------------------------------------------------------------------------------------

describe('numeric coercion edge cases', () => {
  it('accepts a numeric string with surrounding whitespace', () => {
    const specs: Record<string, InputSpec> = { amount: { type: 'number', description: 'amount', required: true, sensitive: false } };
    expect(validateInputs(specs, { amount: '  42.5  ' })).toEqual({ ok: true, values: { amount: 42.5 } });
  });

  it('rejects "Infinity" / "NaN" strings (Number.isFinite backstop)', () => {
    const specs: Record<string, InputSpec> = { amount: { type: 'number', description: 'amount', required: true, sensitive: false } };
    expect(validateInputs(specs, { amount: 'Infinity' }).ok).toBe(false);
    expect(validateInputs(specs, { amount: 'NaN' }).ok).toBe(false);
  });
});

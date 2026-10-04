import { describe, expect, it } from 'vitest';
import { validateInputs } from './validate-inputs.js';
import type { InputSpec } from '../schema/index.js';

function specs(): Record<string, InputSpec> {
  return {
    memberId: { type: 'string', description: 'member id', required: true, sensitive: false, pattern: '^[0-9]{5}$' },
    amount: { type: 'number', description: 'amount', required: false, sensitive: false },
    isActive: { type: 'boolean', description: 'active flag', required: false, sensitive: false },
    pin: { type: 'string', description: 'pin', required: true, sensitive: true, pattern: '^[0-9]{6}$' },
  };
}

describe('validateInputs', () => {
  it('accepts valid inputs and omits missing optional ones', () => {
    const result = validateInputs(specs(), { memberId: '12345', pin: '135790' });
    expect(result).toEqual({ ok: true, values: { memberId: '12345', pin: '135790' } });
  });

  it('fails when a required input is missing', () => {
    const result = validateInputs(specs(), { pin: '135790' });
    expect(result).toEqual({ ok: false, input: 'memberId', problem: 'input "memberId" is required' });
  });

  it('treats null, undefined and "" as missing for a required input', () => {
    for (const missing of [null, undefined, '']) {
      const result = validateInputs(specs(), { memberId: missing, pin: '135790' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.input).toBe('memberId');
    }
  });

  it('fails on an undeclared input key', () => {
    const result = validateInputs(specs(), { memberId: '12345', pin: '135790', extra: 'nope' });
    expect(result).toEqual({ ok: false, input: 'extra', problem: 'input "extra" is not declared by this capability' });
  });

  it('coerces a numeric string to a number', () => {
    const result = validateInputs(specs(), { memberId: '12345', pin: '135790', amount: '42.5' });
    expect(result).toEqual({ ok: true, values: { memberId: '12345', pin: '135790', amount: 42.5 } });
  });

  it('coerces "true"/"false" strings to booleans', () => {
    const result = validateInputs(specs(), { memberId: '12345', pin: '135790', isActive: 'true' });
    expect(result).toEqual({ ok: true, values: { memberId: '12345', pin: '135790', isActive: true } });
  });

  it('fails when a value cannot be coerced to the declared type', () => {
    const result = validateInputs(specs(), { memberId: '12345', pin: '135790', amount: 'not-a-number' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.input).toBe('amount');
      expect(result.problem).toContain('expected number');
    }
  });

  it('fails when a value does not match the declared pattern, quoting the value (non-sensitive)', () => {
    const result = validateInputs(specs(), { memberId: 'abc12', pin: '135790' });
    expect(result).toEqual({
      ok: false,
      input: 'memberId',
      problem: 'input "memberId" value "abc12" does not match pattern ^[0-9]{5}$',
    });
  });

  it('never includes a sensitive input value in the problem, even on failure', () => {
    const distinctive = 'sunshine-distinctive-secret';
    const result = validateInputs(specs(), { memberId: '12345', pin: distinctive });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.input).toBe('pin');
      expect(result.problem).not.toContain(distinctive);
    }
    expect(JSON.stringify(result)).not.toContain(distinctive);
  });

  it('checks in Object.keys(specs) order before checking for undeclared raw keys', () => {
    // memberId (declared, required) fails first even though an undeclared key is also present.
    const result = validateInputs(specs(), { pin: '135790', extra: 'nope' });
    expect(result).toEqual({ ok: false, input: 'memberId', problem: 'input "memberId" is required' });
  });
});

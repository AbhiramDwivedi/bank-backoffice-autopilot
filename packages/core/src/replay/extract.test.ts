import { describe, expect, it } from 'vitest';
import { coerceOutput, parseExtracted } from './extract.js';

describe('parseExtracted', () => {
  describe('text (default)', () => {
    it('collapses whitespace and trims', () => {
      const result = parseExtracted('  Jane   Q.\n Sample  ', undefined, undefined);
      expect(result).toEqual({ ok: true, value: 'Jane Q. Sample' });
    });

    it('is the default when parse is omitted', () => {
      expect(parseExtracted('hello', undefined, undefined)).toEqual({ ok: true, value: 'hello' });
      expect(parseExtracted('hello', 'text', undefined)).toEqual({ ok: true, value: 'hello' });
    });

    it('fails on empty (whitespace-only) text', () => {
      const result = parseExtracted('   \n\t  ', 'text', undefined);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain('no text');
    });
  });

  describe('number', () => {
    it('parses a plain integer', () => {
      expect(parseExtracted('  123  ', 'number', undefined)).toEqual({ ok: true, value: 123 });
    });

    it('strips non-numeric characters (units, letters)', () => {
      expect(parseExtracted('42 items', 'number', undefined)).toEqual({ ok: true, value: 42 });
    });

    it('parses a negative decimal', () => {
      expect(parseExtracted('-3.5', 'number', undefined)).toEqual({ ok: true, value: -3.5 });
    });

    it('fails when there are no digits', () => {
      const result = parseExtracted('abc', 'number', undefined);
      expect(result.ok).toBe(false);
    });
  });

  describe('currency', () => {
    it('parses "$1,234.56"', () => {
      expect(parseExtracted('$1,234.56', 'currency', undefined)).toEqual({ ok: true, value: 1234.56 });
    });

    it('parses a leading-minus negative "-$12.00"', () => {
      expect(parseExtracted('-$12.00', 'currency', undefined)).toEqual({ ok: true, value: -12 });
    });

    it('parses an accounting-negative "($12.00)"', () => {
      expect(parseExtracted('($12.00)', 'currency', undefined)).toEqual({ ok: true, value: -12 });
    });

    it('parses "USD 1,234.56"', () => {
      expect(parseExtracted('USD 1,234.56', 'currency', undefined)).toEqual({ ok: true, value: 1234.56 });
    });

    it('fails when there are no digits', () => {
      const result = parseExtracted('N/A', 'currency', undefined);
      expect(result.ok).toBe(false);
    });
  });

  describe('regex', () => {
    it('returns the first capture group when the pattern has one and it matched', () => {
      const result = parseExtracted('42 items in stock', 'regex', '(\\d+) items');
      expect(result).toEqual({ ok: true, value: '42' });
    });

    it('returns the whole match when the pattern has no group', () => {
      const result = parseExtracted('foo123bar', 'regex', 'foo\\d+');
      expect(result).toEqual({ ok: true, value: 'foo123' });
    });

    it('fails when the pattern does not match', () => {
      const result = parseExtracted('hello world', 'regex', '^\\d+$');
      expect(result.ok).toBe(false);
    });

    it('fails when parse is regex but no pattern is given', () => {
      const result = parseExtracted('hello', 'regex', undefined);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason.toLowerCase()).toContain('pattern');
    });
  });
});

describe('coerceOutput', () => {
  it.each([
    ['number', 42, { ok: true, value: 42 }],
    ['number', '42', { ok: true, value: 42 }],
    ['number', ' 3.5 ', { ok: true, value: 3.5 }],
    ['number', 'abc', undefined],
    ['number', true, undefined],
    ['string', 'hi', { ok: true, value: 'hi' }],
    ['string', 42, { ok: true, value: '42' }],
    ['string', true, { ok: true, value: 'true' }],
    ['boolean', true, { ok: true, value: true }],
    ['boolean', 'true', { ok: true, value: true }],
    ['boolean', 'YES', { ok: true, value: true }],
    ['boolean', 'false', { ok: true, value: false }],
    ['boolean', 'no', { ok: true, value: false }],
    ['boolean', 'maybe', undefined],
    ['boolean', 42, undefined],
  ] as const)('type %s, value %p', (type, value, expected) => {
    const result = coerceOutput(value, type);
    if (expected === undefined) {
      expect(result.ok).toBe(false);
    } else {
      expect(result).toEqual(expected);
    }
  });
});

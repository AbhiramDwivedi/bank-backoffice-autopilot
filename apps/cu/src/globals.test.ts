/** Pure flag-parsing helpers (apps/cu/src/globals.ts): parseKeyValues, collect, parsePort. */
import { describe, expect, it } from 'vitest';
import { InvalidArgumentError } from 'commander';
import { collect, parseKeyValues, parsePort } from './globals.js';

describe('parseKeyValues', () => {
  it('splits each pair on the first "="', () => {
    expect(parseKeyValues(['memberId=12345', 'lastName=Sample'])).toEqual({ memberId: '12345', lastName: 'Sample' });
  });

  it('splits only on the FIRST "=", so a value may itself contain "="', () => {
    expect(parseKeyValues(['fault={"a":"b=c"}'])).toEqual({ fault: '{"a":"b=c"}' });
  });

  it('returns {} for undefined or an empty array', () => {
    expect(parseKeyValues(undefined)).toEqual({});
    expect(parseKeyValues([])).toEqual({});
  });

  it('rejects a pair with no "="', () => {
    expect(() => parseKeyValues(['nope'])).toThrow(/--input expects name=value, got "nope"/);
  });

  it('rejects a pair whose name is empty (leading "=")', () => {
    expect(() => parseKeyValues(['=value'])).toThrow(/--input expects name=value/);
  });

  it('uses the given flag name in the error message', () => {
    expect(() => parseKeyValues(['nope'], '--output')).toThrow(/--output expects name=value, got "nope"/);
  });

  it('a later duplicate key overwrites an earlier one', () => {
    expect(parseKeyValues(['x=1', 'x=2'])).toEqual({ x: '2' });
  });
});

describe('collect', () => {
  it('appends onto the previous array, defaulting to []', () => {
    expect(collect('a')).toEqual(['a']);
    expect(collect('b', ['a'])).toEqual(['a', 'b']);
  });

  it('never mutates the previous array it was given', () => {
    const previous = ['a'];
    const next = collect('b', previous);
    expect(previous).toEqual(['a']);
    expect(next).toEqual(['a', 'b']);
  });
});

describe('parsePort', () => {
  it('accepts 0 (ephemeral) through 65535', () => {
    expect(parsePort('0')).toBe(0);
    expect(parsePort('4300')).toBe(4300);
    expect(parsePort('65535')).toBe(65535);
  });

  it('rejects anything that is not a whole port number instead of passing NaN through', () => {
    for (const bad of ['abc', '12abc', '', '-1', '65536', '1.5', '0x10']) {
      expect(() => parsePort(bad)).toThrow(InvalidArgumentError);
    }
    expect(() => parsePort('abc')).toThrow('must be an integer port number (0-65535)');
  });
});

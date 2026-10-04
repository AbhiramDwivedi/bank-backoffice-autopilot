import { describe, expect, it } from 'vitest';
import { textMatches } from './resolve.js';

describe('desktop textMatches: wholeWord uses the shared whole-word rule', () => {
  it('a whole word, case-sensitively; a joiner does not end a word', () => {
    expect(textMatches('Ann Lee', 'Lee', false, true)).toBe(true);
    expect(textMatches('Ann lee', 'Lee', false, true)).toBe(false);
    expect(textMatches('Bo Leeson', 'Lee', false, true)).toBe(false);
    expect(textMatches('A-1001-B', 'A-1001', false, true)).toBe(false);
    expect(textMatches('Ref A-1001 (open)', 'A-1001', false, true)).toBe(true);
  });

  it('exact still means equality, so an exact-recorded anchor has no word fallback', () => {
    expect(textMatches('A-1001', 'A-1001', true, true)).toBe(true);
    expect(textMatches('Lee Wong', 'Lee', true)).toBe(false);
  });
});

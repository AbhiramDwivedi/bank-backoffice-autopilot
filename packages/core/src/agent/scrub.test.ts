import { describe, expect, it } from 'vitest';
import { createScrubber } from './scrub.js';

describe('createScrubber / text', () => {
  it('replaces a secret value wherever it appears', () => {
    const scrub = createScrubber({ secrets: { MOCK_PASSWORD: 'hunter2' }, sensitiveInputs: {} });
    expect(scrub.text('login with hunter2 then retry hunter2 again')).toBe(
      'login with <secret:MOCK_PASSWORD> then retry <secret:MOCK_PASSWORD> again',
    );
  });

  it('replaces a sensitive input value', () => {
    const scrub = createScrubber({ secrets: {}, sensitiveInputs: { memberId: '12345' } });
    expect(scrub.text('member 12345 found')).toBe('member <sensitive:memberId> found');
  });

  it('skips empty values', () => {
    const scrub = createScrubber({ secrets: { EMPTY: '' }, sensitiveInputs: { alsoEmpty: '' } });
    expect(scrub.forbidden).toEqual([]);
    expect(scrub.text('nothing to redact here')).toBe('nothing to redact here');
  });

  it('replaces the longest value first so a shorter value is not partially matched inside it', () => {
    const scrub = createScrubber({
      secrets: { LONG: 'password123', SHORT: '123' },
      sensitiveInputs: {},
    });
    expect(scrub.text('code is password123')).toBe('code is <secret:LONG>');
  });

  it('applies policy redaction patterns in addition to value substitution', () => {
    const scrub = createScrubber({
      secrets: {},
      sensitiveInputs: {},
      policyPatterns: [{ name: 'custom', regex: 'FOO-\\d+' }],
    });
    expect(scrub.text('ticket FOO-4821 opened')).toBe('ticket [REDACTED:custom] opened');
  });

  it('still applies the default patterns (e.g. ssn)', () => {
    const scrub = createScrubber({ secrets: {}, sensitiveInputs: {} });
    expect(scrub.text('ssn 123-45-6789 on file')).toBe('ssn [REDACTED:ssn] on file');
  });
});

describe('createScrubber / deep', () => {
  it('scrubs secret and sensitive values inside nested objects and arrays', () => {
    const scrub = createScrubber({
      secrets: { MOCK_PASSWORD: 'hunter2' },
      sensitiveInputs: { memberId: '12345' },
    });
    const input: { steps: Array<{ why: string; nested?: { deeper: string[] } }> } = {
      steps: [
        { why: 'typed hunter2 into the password field' },
        { why: 'looked up member 12345', nested: { deeper: ['12345 again', 'hunter2 again'] } },
      ],
    };
    const out = scrub.deep(input);
    expect(out.steps[0]?.why).toBe('typed <secret:MOCK_PASSWORD> into the password field');
    expect(out.steps[1]?.why).toBe('looked up member <sensitive:memberId>');
    expect(out.steps[1]?.nested?.deeper).toEqual(['<sensitive:memberId> again', '<secret:MOCK_PASSWORD> again']);
  });

  it('does not mutate the original value', () => {
    const scrub = createScrubber({ secrets: { S: 'topsecret' }, sensitiveInputs: {} });
    const input = { msg: 'contains topsecret here' };
    const out = scrub.deep(input);
    expect(input.msg).toBe('contains topsecret here');
    expect(out.msg).toBe('contains <secret:S> here');
  });

  it('leaves non-string leaves (numbers, booleans, null) untouched', () => {
    const scrub = createScrubber({ secrets: { S: 'topsecret' }, sensitiveInputs: {} });
    const out = scrub.deep({ count: 3, ok: true, missing: null }) as {
      count: number;
      ok: boolean;
      missing: null;
    };
    expect(out).toEqual({ count: 3, ok: true, missing: null });
  });

  it('still redacts by sensitive key name via the underlying redactor', () => {
    const scrub = createScrubber({ secrets: {}, sensitiveInputs: {} });
    const out = scrub.deep({ password: 'whatever-this-is' }) as Record<string, unknown>;
    expect(out.password).toBe('[REDACTED:password]');
  });

  it("a value substitution placeholder survives even under a sensitive-named key that isn't the matching secret", () => {
    const scrub = createScrubber({ secrets: { MOCK_TOKEN: 'abc123token' }, sensitiveInputs: {} });
    // 'note' is not a sensitive key name, so the redactor leaves it as a normal string leaf and
    // the placeholder substitution (which runs after the redactor) is what ends up in the output.
    const out = scrub.deep({ note: `session used abc123token` }) as Record<string, unknown>;
    expect(out.note).toBe('session used <secret:MOCK_TOKEN>');
  });
});

describe('createScrubber / forbidden', () => {
  it('lists every non-empty secret and sensitive value', () => {
    const scrub = createScrubber({
      secrets: { A: 'aaa', B: '' },
      sensitiveInputs: { c: 'ccc', d: '' },
    });
    expect([...scrub.forbidden].sort()).toEqual(['aaa', 'ccc'].sort());
  });
});

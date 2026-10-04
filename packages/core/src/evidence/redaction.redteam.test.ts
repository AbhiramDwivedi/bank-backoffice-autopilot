/**
 * The shared deep redactor (packages/core/src/evidence/redact.ts).
 *
 * Documents known over-redaction, an accepted (by design) miss case, and a fix for a real
 * structural miss (a secret-shaped string used as an object/Map key was never pattern-scanned,
 * only values were). Also confirms several edge cases the module's own docstring claims to
 * handle (nested arrays, Buffer/Uint8Array, never mutating the input, Error objects).
 */
import { describe, expect, it } from 'vitest';
import { createRedactor } from './redact.js';

describe('redactor -- documented over-redaction', () => {
  it('over-redacts any key merely CONTAINING "token" -- e.g. "tokenCount", a plain usage counter -- because key matching is substring, not exact (redact.ts module doc: this is deliberate, "hard to switch off by accident")', () => {
    const redact = createRedactor();
    const out = redact({ tokenCount: 42, inputTokens: 7, retokenized: true }) as Record<string, unknown>;
    expect(out.tokenCount).toBe('[REDACTED:tokenCount]');
    expect(out.inputTokens).toBe('[REDACTED:inputTokens]');
    expect(out.retokenized).toBe('[REDACTED:retokenized]');
    // This is exactly why packages/core/src/agent/transcript.ts's usageForEvidence() renames usage counters to
    // `input`/`output`/`cacheRead`/`cacheWrite` before they ever reach this redactor.
  });
});

describe('redactor -- accepted (documented) miss: pattern floor / no universal short-value catch', () => {
  it('a short PIN-like value that matches no defined pattern and sits under a non-sensitive key is NOT redacted -- accepted by design (foundation.md: a generic pattern short enough to catch this would also hit ordinary small numbers/codes everywhere)', () => {
    const redact = createRedactor();
    // "42" is too short for the SSN pattern (needs \d{3}-\d{2}-\d{4}) and the card pattern (needs
    // 13-19 digits), and "accountType" is not a sensitive key name.
    const out = redact({ accountType: '42' }) as Record<string, unknown>;
    expect(out.accountType).toBe('42'); // NOT redacted -- documents the gap, does not paper over it.
    // The system's actual backstop for this shape of value is the VALUE-based scrubber
    // (packages/core/src/replay/safe-logger.ts, packages/core/src/agent/scrub.ts), which registers the concrete bound
    // secret/sensitive value and scrubs every occurrence regardless of shape -- but even that
    // scrubber has its own documented floor (MIN_SCRUB_LENGTH = 3): see replay-secrets.test.ts and
    // this module's own doc comment ("Values shorter than 3 characters are not scrubbed").
  });
});

describe('redactor -- MISS: a secret-shaped string used as an object KEY (not a value)', () => {
  it('an SSN used as an object property NAME is redacted, not just SSNs used as values', () => {
    const redact = createRedactor();
    const ssn = '123-45-6789';
    const out = redact({ [ssn]: 'Jane Q. Sample' }) as Record<string, unknown>;
    expect(JSON.stringify(out)).not.toContain(ssn);
    expect(Object.keys(out)).toEqual(['[REDACTED:ssn]']);
    expect(out['[REDACTED:ssn]']).toBe('Jane Q. Sample'); // the value itself is untouched -- only the key matched a pattern.
  });

  it('a card-shaped string used as a Map key is redacted the same way', () => {
    const redact = createRedactor();
    const card = '4111111111111111';
    const m = new Map<string, string>([[card, 'primary card']]);
    const out = redact(m) as Record<string, unknown>;
    expect(JSON.stringify(out)).not.toContain(card);
    expect(Object.keys(out)).toEqual(['[REDACTED:card]']);
  });

  it('a key that is BOTH a sensitive key name and pattern-shaped keeps the sensitive-key behaviour (whole value replaced) and the key name is not itself pattern-mangled', () => {
    // "password" doesn't look like any pattern, so this just confirms the two mechanisms don't
    // interfere with each other when only one of them applies.
    const redact = createRedactor();
    const out = redact({ password: 'hunter2' }) as Record<string, unknown>;
    expect(out.password).toBe('[REDACTED:password]');
  });
});

describe('redactor -- confirmed guarantees', () => {
  it('never mutates its input (deep clone), even for nested arrays/objects', () => {
    const redact = createRedactor();
    const input = { password: 'hunter2', nested: { list: [{ ssn: '123-45-6789' }, ['a', ['b', 'c']]] } };
    const snapshot = structuredClone(input);
    redact(input);
    expect(input).toEqual(snapshot);
  });

  it('recurses through nested arrays (arrays of arrays of objects) applying both key- and pattern-based redaction at every depth', () => {
    const redact = createRedactor();
    const out = redact({
      rows: [
        [{ password: 'hunter2' }, { note: 'SSN 123-45-6789 on file' }],
        [[{ deep: { token: 'abc' } }]],
      ],
    }) as { rows: unknown[][] };
    expect(JSON.stringify(out)).not.toContain('hunter2');
    expect(JSON.stringify(out)).not.toContain('123-45-6789');
    expect(JSON.stringify(out)).toContain('[REDACTED:ssn]');
    expect(JSON.stringify(out)).not.toContain('"token":"abc"');
  });

  it('Buffer and Uint8Array values are replaced with a byte-count placeholder, never the raw bytes', () => {
    const redact = createRedactor();
    const buf = Buffer.from('super secret bytes', 'utf8');
    const u8 = new Uint8Array([1, 2, 3, 4, 5]);
    const out = redact({ buf, u8 }) as Record<string, unknown>;
    expect(out.buf).toBe(`[binary ${buf.length} bytes]`);
    expect(out.u8).toBe(`[binary ${u8.byteLength} bytes]`);
  });

  it('a raw Error object carries no enumerable own properties, so message/stack are dropped (not leaked) -- the same as plain JSON.stringify(error) would do; callers that want error detail in evidence already extract .message themselves (see steps.ts/discover.ts) rather than logging the Error instance directly', () => {
    const redact = createRedactor();
    const err = new Error('super secret failure detail: password=hunter2');
    const out = redact({ err }) as { err: unknown };
    expect(JSON.stringify(out)).not.toContain('hunter2');
    // Confirms this is not special-cased by the redactor -- it is a structural property of
    // Error's own (non-enumerable) message/stack, the same shape JSON.stringify(err) produces.
    expect(JSON.stringify({ err })).toBe(JSON.stringify(out));
  });
});

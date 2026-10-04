import { describe, expect, it } from 'vitest';
import { Intervention, ReplayResult } from '../schema/index.js';
import { createRedactor, createRunRedactor, createValueScrubber, DEFAULT_PATTERNS, DEFAULT_SENSITIVE_KEYS, redactionPatternsFromPolicy } from './redact.js';

function deepFreeze<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
  if (value !== null && typeof value === 'object') {
    const obj = value as object;
    if (!seen.has(obj)) {
      seen.add(obj);
      for (const key of Object.getOwnPropertyNames(obj)) {
        deepFreeze((obj as Record<string, unknown>)[key], seen);
      }
      Object.freeze(obj);
    }
  }
  return value;
}

describe('DEFAULT_SENSITIVE_KEYS / DEFAULT_PATTERNS', () => {
  it('exposes the documented default sensitive keys', () => {
    expect([...DEFAULT_SENSITIVE_KEYS].sort()).toEqual(
      ['password', 'passwd', 'token', 'secret', 'authorization', 'cookie', 'set-cookie', 'apikey', 'api_key', 'ssn', 'pin'].sort(),
    );
  });

  it('exposes ssn, card, token and path default patterns', () => {
    const names = DEFAULT_PATTERNS.map((p) => p.name).sort();
    expect(names).toEqual(['card', 'path', 'ssn', 'token'].sort());
  });
});

describe('sensitive key redaction', () => {
  it('redacts a top-level sensitive key regardless of value type', () => {
    const redactor = createRedactor();
    const out = redactor({ password: 'hunter2', count: 3 }) as Record<string, unknown>;
    expect(out.password).toBe('[REDACTED:password]');
    expect(out.count).toBe(3);
  });

  it('redacts nested sensitive keys at depth >= 3, including inside arrays', () => {
    const redactor = createRedactor();
    const input = {
      level1: {
        level2: [
          { level3: { password: 'deep-secret', ok: 'fine' } },
          { level3: { nested: { ssn: '123-45-6789' } } },
        ],
      },
    };
    type Level3 = { password?: string; ok?: string; nested?: { ssn: string } };
    const out = redactor(input) as { level1: { level2: { level3: Level3 }[] } };
    expect(out.level1.level2[0]!.level3.password).toBe('[REDACTED:password]');
    expect(out.level1.level2[0]!.level3.ok).toBe('fine');
    expect(out.level1.level2[1]!.level3.nested!.ssn).toBe('[REDACTED:ssn]');
  });

  it('matches case-insensitively and as a substring of the normalised key', () => {
    const redactor = createRedactor();
    const out = redactor({
      'X-Auth-Token': 'abc123',
      userPassword: 'p@ss',
      access_token: 'tok_xyz',
      ApiKey: 'k-1',
    }) as Record<string, unknown>;
    expect(out['X-Auth-Token']).toBe('[REDACTED:X-Auth-Token]');
    expect(out.userPassword).toBe('[REDACTED:userPassword]');
    expect(out.access_token).toBe('[REDACTED:access_token]');
    expect(out.ApiKey).toBe('[REDACTED:ApiKey]');
  });

  it('matches "pin" only as the whole normalised key, not as a substring', () => {
    const redactor = createRedactor();
    const out = redactor({
      pin: '1234',
      PIN: '5678',
      shipping: 'ground',
      spinner: 'loading',
      pinned: true,
    }) as Record<string, unknown>;
    expect(out.pin).toBe('[REDACTED:pin]');
    expect(out.PIN).toBe('[REDACTED:PIN]');
    expect(out.shipping).toBe('ground');
    expect(out.spinner).toBe('loading');
    expect(out.pinned).toBe(true);
  });

  it('does not rewrite object keys, only values', () => {
    const redactor = createRedactor();
    const out = redactor({ password: 'x' }) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(['password']);
  });
});

describe('pattern redaction', () => {
  it('redacts an SSN', () => {
    const redactor = createRedactor();
    expect(redactor('SSN on file: 123-45-6789')).toBe('SSN on file: [REDACTED:ssn]');
  });

  it('redacts card numbers with spaces, dashes, and no separators', () => {
    const redactor = createRedactor();
    expect(redactor('card 4111 1111 1111 1111 on file')).toBe('card [REDACTED:card] on file');
    expect(redactor('card 4111-1111-1111-1111 on file')).toBe('card [REDACTED:card] on file');
    expect(redactor('card 4111111111111111 on file')).toBe('card [REDACTED:card] on file');
  });

  it('redacts a bearer token', () => {
    const redactor = createRedactor();
    expect(redactor('Authorization: Bearer abc.def-123_XYZ')).toBe('Authorization: Bearer [REDACTED:token]');
  });

  it('leaves ISO timestamps, small numbers, and formatted currency alone', () => {
    const redactor = createRedactor();
    expect(redactor('2026-01-05T23:59:59.000Z')).toBe('2026-01-05T23:59:59.000Z');
    expect(redactor('12345')).toBe('12345');
    expect(redactor(12345)).toBe(12345);
    expect(redactor('$1,234.56')).toBe('$1,234.56');
  });

  it('redacts a 16-digit member/card number stored as a JS number', () => {
    const redactor = createRedactor();
    expect(redactor(4111111111111111)).toBe('[REDACTED:card]');
  });

  it('applies patterns to strings inside arrays', () => {
    const redactor = createRedactor();
    const out = redactor(['note', '123-45-6789', 'ok']) as string[];
    expect(out).toEqual(['note', '[REDACTED:ssn]', 'ok']);
  });

  it('supports a custom pattern and replacement, additive to the defaults', () => {
    const redactor = createRedactor({
      patterns: [{ name: 'employee-id', regex: /EMP-\d{4}/, replacement: '[REDACTED:employee]' }],
    });
    const out = redactor('badge EMP-4821, ssn 123-45-6789') as string;
    expect(out).toBe('badge [REDACTED:employee], ssn [REDACTED:ssn]');
  });

  it('builds patterns from policy redaction entries and merges with defaults', () => {
    const policyPatterns = redactionPatternsFromPolicy([{ name: 'ref', regex: 'SA-\\d{7}' }]);
    const redactor = createRedactor({ patterns: policyPatterns });
    expect(redactor('ref SA-1234567')).toBe('ref [REDACTED:ref]');
    // default patterns are still active even though only custom patterns were passed
    expect(redactor('123-45-6789')).toBe('[REDACTED:ssn]');
  });
});

describe('filesystem path redaction', () => {
  it('redacts a Windows drive path with backslashes', () => {
    const redactor = createRedactor();
    expect(redactor('loading C:\\Users\\redteam\\secret\\evidence.json')).toBe('loading [REDACTED:path]');
  });

  it('redacts a Windows drive path with forward slashes', () => {
    const redactor = createRedactor();
    expect(redactor('loading C:/Users/redteam/secret/evidence.json')).toBe('loading [REDACTED:path]');
  });

  it('redacts a UNC path', () => {
    const redactor = createRedactor();
    expect(redactor('reading \\\\fileserver\\share\\evidence\\run.json failed')).toBe('reading [REDACTED:path] failed');
  });

  it('redacts a POSIX path rooted at /home/ or /Users/', () => {
    const redactor = createRedactor();
    expect(redactor('open /home/redteam/secret.txt failed')).toBe('open [REDACTED:path] failed');
    expect(redactor('open /Users/redteam/secret.txt failed')).toBe('open [REDACTED:path] failed');
  });

  it('redacts a path embedded mid-sentence alongside another pattern', () => {
    const redactor = createRedactor();
    const out = redactor(`read failed: SSN on file 123-45-6789 while loading C:\\Users\\redteam\\secret\\evidence.json`);
    expect(out).toBe('read failed: SSN on file [REDACTED:ssn] while loading [REDACTED:path]');
  });

  it('leaves an http(s) URL and its path intact', () => {
    const redactor = createRedactor();
    expect(redactor('GET http://127.0.0.1:4173/transfer failed')).toBe('GET http://127.0.0.1:4173/transfer failed');
    expect(redactor('see https://example.com/accounts/123')).toBe('see https://example.com/accounts/123');
  });

  it('leaves run-dir-relative evidence paths intact', () => {
    const redactor = createRedactor();
    expect(redactor('screenshot at shots/3.png')).toBe('screenshot at shots/3.png');
    expect(redactor('snapshot at dom/3.html')).toBe('snapshot at dom/3.html');
    expect(redactor('see screenshots/0001.png')).toBe('see screenshots/0001.png');
  });

  it('leaves a css selector containing a slash intact', () => {
    const redactor = createRedactor();
    expect(redactor('a[href="/accounts/123"]')).toBe('a[href="/accounts/123"]');
  });

  it('leaves a date and a fraction intact', () => {
    const redactor = createRedactor();
    expect(redactor('scheduled 2026/09/26')).toBe('scheduled 2026/09/26');
    expect(redactor('ratio 1/2')).toBe('ratio 1/2');
  });
});

describe('safety and defaults', () => {
  it('cannot have default sensitive keys or patterns switched off by passing options', () => {
    // Passing an unrelated custom key must not drop the defaults.
    const redactor = createRedactor({ sensitiveKeys: ['custom-secret'] });
    const out = redactor({ password: 'x', 'custom-secret': 'y' }) as Record<string, unknown>;
    expect(out.password).toBe('[REDACTED:password]');
    expect(out['custom-secret']).toBe('[REDACTED:custom-secret]');
  });
});

describe('type handling', () => {
  it('converts Date to an ISO string', () => {
    const redactor = createRedactor();
    const d = new Date('2026-03-01T00:00:00.000Z');
    expect(redactor(d)).toBe('2026-03-01T00:00:00.000Z');
  });

  it('converts Buffer/Uint8Array to a binary marker', () => {
    const redactor = createRedactor();
    expect(redactor(Buffer.from('hello'))).toBe('[binary 5 bytes]');
    expect(redactor(new Uint8Array([1, 2, 3]))).toBe('[binary 3 bytes]');
  });

  it('converts Map and Set to a plain object/array, applying key + value rules', () => {
    const redactor = createRedactor();
    const map = new Map<string, unknown>([['password', 'x'], ['ok', 'y']]);
    expect(redactor(map)).toEqual({ password: '[REDACTED:password]', ok: 'y' });

    const set = new Set(['a', '123-45-6789']);
    expect(redactor(set)).toEqual(['a', '[REDACTED:ssn]']);
  });

  it('converts bigint to a string', () => {
    const redactor = createRedactor();
    expect(redactor(123n)).toBe('123');
  });

  it('drops functions and symbols', () => {
    const redactor = createRedactor();
    const out = redactor({ fn: () => 1, sym: Symbol('s'), keep: 'yes' }) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(['keep']);
    expect(out.keep).toBe('yes');
  });

  it('replaces cycles with [Circular] instead of looping forever', () => {
    interface Node {
      name: string;
      self?: Node;
      list?: unknown[];
    }
    const node: Node = { name: 'root' };
    node.self = node;
    node.list = [node];

    const redactor = createRedactor();
    const out = redactor(node) as { name: string; self: unknown; list: unknown[] };
    expect(out.name).toBe('root');
    expect(out.self).toBe('[Circular]');
    expect(out.list[0]).toBe('[Circular]');
  });
});

describe('non-mutation', () => {
  it('never mutates its input, even deeply nested/frozen structures', () => {
    const input = deepFreeze({
      user: {
        password: 'secret',
        contact: { ssn: '123-45-6789', notes: ['card 4111 1111 1111 1111'] },
      },
      tags: ['a', 'b'],
    });
    const baseline = structuredClone(input);

    const redactor = createRedactor();
    const out = redactor(input);

    // Input is untouched.
    expect(input).toEqual(baseline);
    // The redactor did do real work on a fresh copy.
    expect(out).not.toEqual(baseline);
  });
});

describe('createValueScrubber', () => {
  it('replaces registered values case-insensitively, longest first', () => {
    const s = createValueScrubber(['1234', '12345678']);
    expect(s.text('acct 12345678 pin 1234')).toBe('acct [REDACTED] pin [REDACTED]');
    const named = createValueScrubber([{ value: 'hunter2', placeholder: '<secret:PW>' }]);
    expect(named.text('HUNTER2 typed')).toBe('<secret:PW> typed');
  });

  it('ignores values below minLength and treats regex metacharacters literally', () => {
    const s = createValueScrubber(['ok', 'a.c'], { minLength: 3 });
    expect(s.text('ok abc a.c')).toBe('ok abc [REDACTED]');
    expect(s.values()).toEqual(['a.c']);
  });

  it('scrubs string leaves deeply, keeps keys and Buffers, and scrubs numbers only when asked', () => {
    const buf = Buffer.from('secret-value');
    const input = { 'secret-value': 'x secret-value', n: 4242, list: ['secret-value'], buf };
    const out = createValueScrubber(['secret-value', '4242']).deep(input);
    expect(out).toEqual({ 'secret-value': 'x [REDACTED]', n: 4242, list: ['[REDACTED]'], buf });
    expect(createValueScrubber(['4242'], { numbers: true }).deep({ n: 4242 })).toEqual({ n: '[REDACTED]' });
  });

  it('picks up values added after creation', () => {
    const s = createValueScrubber();
    expect(s.text('abc')).toBe('abc');
    s.add('abc');
    expect(s.text('xabcx')).toBe('x[REDACTED]x');
  });
});

describe('createValueScrubber: URL-encoded forms', () => {
  it('scrubs a value, its encodeURIComponent form and its +-for-space form, in any case', () => {
    const value = 'AcctNum 42&Test/07';
    const s = createValueScrubber([value]);
    const enc = encodeURIComponent(value);
    const url = `http://localhost:4173/search?a=${enc}&b=${enc.replace(/%20/g, '+')}&c=${enc.toLowerCase()}&d=${value}`;
    const out = s.text(url);
    expect(out).toBe('http://localhost:4173/search?a=[REDACTED]&b=[REDACTED]&c=[REDACTED]&d=[REDACTED]');
    expect(s.values()).toEqual([value]);
  });

  it("scrubs the form encoding of ! ' ( ) ~, a fully percent-encoded value in either hex case, and the HTML-escaped form", () => {
    const s = createValueScrubber(['Summer2024!', "o'brien(1)~"]);
    expect(s.text('http://x/?pw=Summer2024%21&n=o%27brien%281%29%7E')).toBe('http://x/?pw=[REDACTED]&n=[REDACTED]');
    expect(s.text('http://x/?pw=summer2024%21')).toBe('http://x/?pw=[REDACTED]');
    expect(s.text('http://x/?n=o%27brien%281%29%7e')).toBe('http://x/?n=[REDACTED]');
    expect(s.text('<p>o&#39;brien(1)~</p>')).toBe('<p>[REDACTED]</p>');
  });
});

describe('createRunRedactor', () => {
  it('applies the default and added patterns, then the run values (read on every call), leaving numbers alone', () => {
    const values: string[] = [];
    const redact = createRunRedactor({ patterns: [{ name: 'member', regex: 'MBR-[0-9]{4}' }], values: () => values });
    expect(redact({ a: 'ssn 123-45-6789', b: 'MBR-1234', c: 'acct 98765', d: 98765 })).toEqual({
      a: 'ssn [REDACTED:ssn]',
      b: '[REDACTED:member]',
      c: 'acct 98765',
      d: 98765,
    });
    values.push('98765');
    expect(redact({ c: 'acct 98765', d: 98765, url: 'http://x/?q=98765' })).toEqual({ c: 'acct [REDACTED]', d: 98765, url: 'http://x/?q=[REDACTED]' });
  });

  it('leaves ids, timestamps, numbers, enumerations and evidence paths intact, so a ReplayResult still parses', () => {
    const redact = createRunRedactor({ values: () => ['2026', '1234'] });
    const result: ReplayResult = {
      kind: 'hard_failure',
      runId: 'run_20260926_abcd1234',
      capabilityId: 'cap-2026',
      capabilityVersion: '1.2026.0',
      stepsExecuted: 3,
      durationMs: 12345,
      locatorReport: [{ stepId: 's1234', strategyKind: 'label', fallbackDepth: 0 }],
      recoveries: ['retry-2026'],
      stepId: 's1234',
      stepName: 'Search 2026',
      code: 'element_not_found',
      expected: 'row 1234',
      observed: 'no row 1234 in 2026',
      message: 'member 1234 not found',
      evidence: { screenshot: 'shots/1234.png', dom: 'dom/1234.html' },
    };
    const parsed = ReplayResult.parse(redact(result));
    expect(parsed).toMatchObject({
      runId: result.runId,
      capabilityId: result.capabilityId,
      capabilityVersion: result.capabilityVersion,
      durationMs: 12345,
      stepId: 's1234',
      locatorReport: result.locatorReport,
      evidence: result.evidence,
      expected: 'row [REDACTED]',
      observed: 'no row [REDACTED] in [REDACTED]',
      message: 'member [REDACTED] not found',
      stepName: 'Search [REDACTED]',
      recoveries: ['retry-[REDACTED]'],
    });

    const intervention: Intervention = {
      id: 'int_20260926_abcd1234',
      runId: 'run_20260926_abcd1234',
      runKind: 'replay',
      stepId: 's1234',
      reason: { code: 'unrecoverable_condition', message: 'stuck on 1234' },
      screenshotPath: 'shots/1234.png',
      currentUrl: 'http://localhost:4173/m?id=1234',
      createdAt: '2026-09-26T12:34:00.000Z',
      status: 'resolved',
      resolution: {
        by: 'op-1234',
        at: '2026-09-26T12:34:56.000Z',
        notes: 'typed 1234',
        resumeFrom: 'next_step',
        humanActions: [{ ts: '2026-09-26T12:34:50.000Z', type: 'click', frame: [], target: { name: 'Row 1234' } }],
      },
    };
    expect(Intervention.parse(redact(intervention))).toMatchObject({
      id: intervention.id,
      runId: intervention.runId,
      stepId: 's1234',
      screenshotPath: 'shots/1234.png',
      createdAt: intervention.createdAt,
      currentUrl: 'http://localhost:4173/m?id=[REDACTED]',
      reason: { code: 'unrecoverable_condition', message: 'stuck on [REDACTED]' },
      resolution: {
        by: 'op-1234',
        at: '2026-09-26T12:34:56.000Z',
        notes: 'typed [REDACTED]',
        humanActions: [{ ts: '2026-09-26T12:34:50.000Z', target: { name: 'Row [REDACTED]' } }],
      },
    });
  });

  it('treats everything under outputs and data as content, whatever the field is called', () => {
    const redact = createRunRedactor({ values: () => ['hunter22'] });
    expect(redact({ outputs: { id: 'hunter22', createdAt: 'x hunter22' }, id: 'hunter22' })).toEqual({
      outputs: { id: '[REDACTED]', createdAt: 'x [REDACTED]' },
      id: 'hunter22',
    });
  });

  it('keeps a structural field only when its value has the structural shape', () => {
    const redact = createRunRedactor({ values: () => ['hunter22'] });
    expect(redact({ createdAt: 'hunter22', type: 'Hunter22 typed', screenshot: 'x/hunter22 y.png' })).toEqual({
      createdAt: '[REDACTED]',
      type: '[REDACTED] typed',
      screenshot: 'x/[REDACTED] y.png',
    });
  });

  it('is idempotent: a placeholder is never matched again, within one pass or across two', () => {
    const redact = createRunRedactor({ values: () => ['2026', 'RED', 'ACT'] });
    expect(redact('Summer2026')).toBe('Summer[REDACTED]');
    expect(redact(redact('Summer2026 red'))).toBe('Summer[REDACTED] [REDACTED]');
    expect(redact('[REDACTED:ssn] and [REDACTED]')).toBe('[REDACTED:ssn] and [REDACTED]');
    const named = createValueScrubber([{ value: 'secret', placeholder: '<secret:SECRET_KEY>' }, 'KEY']);
    expect(named.text(named.text('secret key'))).toBe('<secret:SECRET_KEY> [REDACTED]');
  });

  it('html() scrubs text, comments and attribute values but never tags, attribute names or the CSP meta', () => {
    const redact = createRunRedactor({ values: () => ['src', 'hunter22', 'meta'] });
    const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:">`;
    const html = `<!doctype html><html><head>${csp}</head><body><img src="a.png" alt='hunter22'><p title=hunter22>Hi hunter22 &amp; meta</p><!-- src hunter22 --></body></html>`;
    expect(redact.html(html)).toBe(
      `<!doctype html><html><head>${csp}</head><body><img src="a.png" alt='[REDACTED]'><p title=[REDACTED]>Hi [REDACTED] &amp; [REDACTED]</p><!-- [REDACTED] [REDACTED] --></body></html>`,
    );
    // Patterns still apply to the whole document.
    expect(createRunRedactor().html('<p>ssn 123-45-6789</p>')).toBe('<p>ssn [REDACTED:ssn]</p>');
  });

  it('ignores run values shorter than minValueLength (default 3)', () => {
    const redact = createRunRedactor({ values: () => ['ab'] });
    expect(redact('ab cab')).toBe('ab cab');
  });

  it('flattens Dates and binary data before scrubbing, never walking into them', () => {
    const redact = createRunRedactor({ values: () => ['secret-value'] });
    expect(redact({ at: new Date('2026-01-01T00:00:00.000Z'), buf: Buffer.from('secret-value') })).toEqual({
      at: '2026-01-01T00:00:00.000Z',
      buf: '[binary 12 bytes]',
    });
  });
});

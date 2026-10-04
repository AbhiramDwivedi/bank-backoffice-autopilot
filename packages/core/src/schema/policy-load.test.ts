import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY_PATH, loadPolicy, parsePolicy } from '../policy/load.js';

describe('DEFAULT_POLICY_PATH / loadPolicy', () => {
  it('loads policies/default.yaml and validates it as a Policy', () => {
    const policy = loadPolicy(DEFAULT_POLICY_PATH);
    expect(policy.name).toBe('mock-cu-core-default');
    expect(policy.allowedOrigins).toEqual(['http://localhost:4173', 'http://localhost:4174']);
    expect([...policy.allowedActions].sort()).toEqual(
      ['navigate', 'click', 'type', 'select', 'press', 'extract', 'wait', 'dismiss_dialog', 'switch_frame'].sort(),
    );
    expect(policy.risk.replayRequiresApproved).toBe(true);
    expect(policy.risk.discoveryMode).toBe('escalate');
  });

  it('denied path patterns (compiled case-insensitively) match fault-injection routes but not ordinary routes', () => {
    const policy = loadPolicy(DEFAULT_POLICY_PATH);
    const denied = policy.deniedPathPatterns.map((src) => new RegExp(src, 'i'));
    expect(denied.some((re) => re.test('/__faults'))).toBe(true);
    expect(denied.some((re) => re.test('/__reset'))).toBe(true);
    expect(denied.some((re) => re.test('/members/search'))).toBe(false);
  });

  it('irreversible text patterns match action verbs but not their status-label past tense', () => {
    const policy = loadPolicy(DEFAULT_POLICY_PATH);
    const patterns = policy.risk.irreversibleTextPatterns.map((src) => new RegExp(src, 'i'));
    const matchesAny = (text: string) => patterns.some((re) => re.test(text));

    expect(matchesAny('Submit')).toBe(true);
    expect(matchesAny('Open Account')).toBe(true);
    expect(matchesAny('confirm transfer')).toBe(true);
    expect(matchesAny('Search')).toBe(false);
    // `\b` right after the alternation requires a non-word boundary immediately following
    // "submit"; in "Submitted" the 't' is followed by 'e' (still a word char), so this must NOT
    // match — a past-tense status label shouldn't trip the same guard as the live action.
    expect(matchesAny('Submitted items')).toBe(false);
  });
});

describe('parsePolicy', () => {
  it('rejects malformed YAML, naming the source', () => {
    expect(() => parsePolicy('name: [unterminated', 'bad.yaml')).toThrow(/bad\.yaml/);
  });

  it('rejects a policy that fails schema validation, naming the failing field path', () => {
    const yamlText = `
name: test
allowedOrigins: []
allowedPathPatterns: []
deniedPathPatterns: []
allowedActions: [navigate]
risk:
  irreversibleTextPatterns: []
  irreversibleUrlPatterns: []
  discoveryMode: escalate
  replayRequiresApproved: true
redaction:
  patterns: []
limits:
  maxSteps: 40
  maxDurationMs: 600000
  maxLlmCalls: 60
`;
    // allowedOrigins requires at least one entry (.min(1)).
    expect(() => parsePolicy(yamlText, 'empty-origins.yaml')).toThrow(/allowedOrigins/);
  });

  it('rejects a policy containing a regex source that does not compile', () => {
    const yamlText = `
name: test
allowedOrigins: ['http://localhost:4173']
allowedPathPatterns: []
deniedPathPatterns: ['(unclosed']
allowedActions: [navigate]
risk:
  irreversibleTextPatterns: []
  irreversibleUrlPatterns: []
  discoveryMode: escalate
  replayRequiresApproved: true
redaction:
  patterns: []
limits:
  maxSteps: 40
  maxDurationMs: 600000
  maxLlmCalls: 60
`;
    expect(() => parsePolicy(yamlText, 'bad-regex.yaml')).toThrow(/invalid regex/i);
  });

  it('accepts a minimal valid policy', () => {
    const yamlText = `
name: minimal
allowedOrigins: ['http://localhost:4173']
allowedPathPatterns: []
deniedPathPatterns: []
allowedActions: [navigate, click]
risk:
  irreversibleTextPatterns: []
  irreversibleUrlPatterns: []
  discoveryMode: block
  replayRequiresApproved: false
redaction:
  patterns: []
limits:
  maxSteps: 10
  maxDurationMs: 60000
  maxLlmCalls: 5
`;
    const policy = parsePolicy(yamlText, 'minimal.yaml');
    expect(policy.name).toBe('minimal');
    // The replay retry limit is optional: a policy written before it existed leaves it to replay's default.
    expect(policy.limits.maxAppErrorRetries).toBeUndefined();
  });

  it('limits.maxAppErrorRetries: the shipped policy sets replay\'s default, 0 (off) is allowed, a negative or fractional count is not', () => {
    expect(loadPolicy(DEFAULT_POLICY_PATH).limits.maxAppErrorRetries).toBe(2);
    const withLimit = (value: string): string => `
name: minimal
allowedOrigins: ['http://localhost:4173']
allowedPathPatterns: []
deniedPathPatterns: []
allowedActions: [navigate]
risk:
  irreversibleTextPatterns: []
  irreversibleUrlPatterns: []
  discoveryMode: block
  replayRequiresApproved: false
redaction:
  patterns: []
limits:
  maxSteps: 10
  maxDurationMs: 60000
  maxLlmCalls: 5
  maxAppErrorRetries: ${value}
`;
    expect(parsePolicy(withLimit('0')).limits.maxAppErrorRetries).toBe(0);
    expect(() => parsePolicy(withLimit('-1'), 'neg.yaml')).toThrow(/limits\.maxAppErrorRetries/);
    expect(() => parsePolicy(withLimit('1.5'), 'frac.yaml')).toThrow(/limits\.maxAppErrorRetries/);
  });
});

import { describe, expect, it } from 'vitest';
import type { Policy } from '@cu/core/schema';
import { baseUrlPolicyError } from './base-url-policy.js';

const MINIMAL_POLICY: Policy = {
  name: 'test-policy',
  allowedOrigins: ['http://localhost:9999'],
  allowedPathPatterns: [],
  deniedPathPatterns: [],
  allowedActions: ['navigate', 'click', 'type', 'select', 'press', 'extract', 'wait', 'dismiss_dialog', 'switch_frame'],
  risk: { irreversibleTextPatterns: [], irreversibleUrlPatterns: [], discoveryMode: 'block', replayRequiresApproved: true },
  redaction: { patterns: [] },
  limits: { maxSteps: 100, maxDurationMs: 600_000, maxLlmCalls: 50 },
};

describe('baseUrlPolicyError', () => {
  it('returns undefined when the origin is in policies/default.yaml (loaded from disk)', () => {
    expect(baseUrlPolicyError('http://localhost:4173', 'policies/default.yaml')).toBeUndefined();
    expect(baseUrlPolicyError('http://localhost:4174/some/path', 'policies/default.yaml')).toBeUndefined();
  });

  it('returns the exact fail-fast message when the origin is not in the loaded policy (from disk)', () => {
    expect(baseUrlPolicyError('http://localhost:4193', 'policies/default.yaml')).toBe(
      'origin http://localhost:4193 is not in policy policies/default.yaml allowedOrigins; add it or pass --policy',
    );
  });

  it('accepts an already-loaded Policy object, bypassing the file entirely (mirrors ComposeOptions: policy wins over policyPath)', () => {
    expect(baseUrlPolicyError('http://localhost:9999', 'irrelevant/path.yaml', MINIMAL_POLICY)).toBeUndefined();
    expect(baseUrlPolicyError('http://localhost:1234', 'irrelevant/path.yaml', MINIMAL_POLICY)).toBe(
      'origin http://localhost:1234 is not in policy irrelevant/path.yaml allowedOrigins; add it or pass --policy',
    );
  });

  it('reports a policy file that fails to load rather than throwing', () => {
    const msg = baseUrlPolicyError('http://localhost:4173', 'policies/does-not-exist.yaml');
    expect(msg).toContain('could not load policy policies/does-not-exist.yaml');
  });

  it('reports a malformed --base-url rather than throwing', () => {
    const msg = baseUrlPolicyError('not a url', 'policies/default.yaml');
    expect(msg).toContain('is not a valid URL');
  });
});

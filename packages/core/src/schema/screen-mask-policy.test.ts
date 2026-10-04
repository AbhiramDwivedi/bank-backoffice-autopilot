/**
 * The `redaction.screen` policy block: optional with defaults (every existing policy parses, and
 * behaviour is at least as strict as before the block existed), strict about unknown keys, and
 * its regex sources are checked at load like every other policy regex.
 */
import { describe, expect, it } from 'vitest';
import { parsePolicy } from '../policy/load.js';
import { buildJsonSchemas } from './export.js';
import { Policy, resolveScreenMask, ScreenMaskPolicy } from './policy.js';

const BASE = `
name: t
allowedOrigins: ['http://localhost:4173']
allowedPathPatterns: []
deniedPathPatterns: []
allowedActions: [navigate, click]
risk: { irreversibleTextPatterns: [], irreversibleUrlPatterns: [], discoveryMode: block, replayRequiresApproved: true }
limits: { maxSteps: 1, maxDurationMs: 1, maxLlmCalls: 1 }
`;

describe('redaction.screen', () => {
  it('a policy without the block parses, and resolves to the strict defaults', () => {
    const p = parsePolicy(`${BASE}redaction: { patterns: [] }\n`);
    expect(p.redaction.screen).toBeUndefined();
    expect(resolveScreenMask(p.redaction.screen)).toEqual({
      maskInputs: 'all',
      maskSelectors: [],
      maskLabels: [],
      maskTextPatterns: true,
      omitScreenshotUrlPatterns: [],
    });
  });

  it('a partial block fills in the rest', () => {
    const p = parsePolicy(`${BASE}redaction: { patterns: [], screen: { maskLabels: ['^phone$'] } }\n`);
    expect(p.redaction.screen).toEqual({ maskInputs: 'all', maskSelectors: [], maskLabels: ['^phone$'], maskTextPatterns: true, omitScreenshotUrlPatterns: [] });
  });

  it('rejects an unknown key and an invalid maskInputs', () => {
    expect(ScreenMaskPolicy.safeParse({ maskEverything: true }).success).toBe(false);
    expect(ScreenMaskPolicy.safeParse({ maskInputs: 'none' }).success).toBe(false);
    expect(Policy.shape.redaction.safeParse({ patterns: [], screen: { maskLabels: [''] } }).success).toBe(false);
  });

  it('checks maskLabels and omitScreenshotUrlPatterns sources at load', () => {
    expect(() => parsePolicy(`${BASE}redaction: { patterns: [], screen: { maskLabels: ['('] } }\n`)).toThrow(/redaction\.screen\.maskLabels/);
    expect(() => parsePolicy(`${BASE}redaction: { patterns: [], screen: { omitScreenshotUrlPatterns: ['['] } }\n`)).toThrow(/omitScreenshotUrlPatterns/);
  });

  it('the exported JSON schema validates a partial block: no screen field is required (the input shape)', () => {
    const policy = buildJsonSchemas().policy as { $defs: { ScreenMaskPolicy: { required?: string[]; properties: object } } };
    const screen = policy.$defs.ScreenMaskPolicy;
    expect(screen.required ?? []).toEqual([]);
    expect(Object.keys(screen.properties)).toContain('maskLabels');
  });
});

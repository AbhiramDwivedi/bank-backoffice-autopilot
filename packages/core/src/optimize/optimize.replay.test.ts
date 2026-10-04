/**
 * The optimizer driving the REAL replay engine: every trial is a `replayCapability` run on a fresh
 * cu-core FakeSurface (the in-memory model of the mock app), with the probe wired through replay's
 * own `beforeStep` hook. Proves the pieces fit -- probe, hook, trial copies, output equality --
 * on the shipped artifact, without a browser. The same check against the real mock app in
 * Chromium is tests/e2e/optimize.test.ts.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validateCapability, type Capability, type LocatorStrategy } from '../schema/index.js';
import { createRunLogger } from '../evidence/index.js';
import { createCuCoreSurface } from '../surface/index.js';
import { replayCapability } from '../replay/index.js';
import { DEFAULT_PASSWORD, DEFAULT_USER_ID } from '@cu/mock-app/test-helpers';
import { optimizeCapability } from './optimize.js';
import type { RunTrial } from './types.js';

const SHIPPED_URL = new URL('../../../../artifacts/lookup-member-savings-balance.json', import.meta.url);
const SECRETS: Record<string, string> = { MOCK_USER: DEFAULT_USER_ID, MOCK_PASSWORD: DEFAULT_PASSWORD };

/**
 * The shipped artifact, with one locator prepended to two chains so the in-memory fake can resolve
 * them: the fake matches a CSS selector by exact string (s05's `input[type="image"][name="login"]`
 * is not in its list) and a table row by its whole text (s08's exact "12345"). Nothing else changes;
 * tests/e2e/optimize.test.ts runs the artifact unpatched against the real mock app in Chromium.
 */
function loadShipped(): Capability {
  const res = validateCapability(JSON.parse(readFileSync(SHIPPED_URL, 'utf8')));
  if (!res.ok) throw new Error(JSON.stringify(res.issues));
  const cap = res.capability;
  const prepend = (stepId: string, strategy: LocatorStrategy): void => {
    const action = cap.steps.find((s) => s.id === stepId)!.action;
    if (action.type !== 'click') throw new Error(`${stepId} is not a click`);
    action.target.locators.unshift({ strategy, confidence: 0.8, source: 'human' });
  };
  prepend('s05', { kind: 'role', role: 'button', name: 'login' });
  prepend('s08', { kind: 'text', text: '{input.memberId}' });
  return cap;
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function replayTrialRunner(inputs: Record<string, unknown>): RunTrial {
  const root = mkdtempSync(path.join(os.tmpdir(), 'optimize-replay-'));
  dirs.push(root);
  let n = 0;
  return async (req) => {
    n += 1;
    const logger = createRunLogger({ runId: `trial-${n}`, runKind: 'replay', rootDir: root });
    const result = await replayCapability({
      capability: req.capability,
      inputs,
      surface: createCuCoreSurface(),
      baseUrl: 'http://localhost:4173',
      logger,
      secret: (env) => SECRETS[env],
      stepTimeoutMs: 500,
      ...(req.beforeStep !== undefined ? { beforeStep: req.beforeStep } : {}),
    });
    return { kind: result.kind, ...(result.kind === 'success' ? { outputs: result.outputs } : {}), runDir: logger.dir };
  };
}

describe('optimizeCapability with real replay trials (cu-core FakeSurface)', () => {
  it('removes the duplicate password step and both vacuous "Password:" checkpoints, and still returns the same balance', async () => {
    // The operator's read-only declaration (what `cu optimize --read-only` asserts).
    const cap: Capability = { ...loadShipped(), readOnly: true };
    const { capability, report, baselineOutputs } = await optimizeCapability(cap, { runTrial: replayTrialRunner({ memberId: '12345' }), verifyRuns: 2, bumpVersion: true });

    expect(report.stop).toBe('completed');
    expect(baselineOutputs).toEqual({ savingsBalance: 1234.56, memberName: 'Jane Q. Sample' });
    expect(capability.steps.some((s) => s.id === 's04')).toBe(false);
    expect(capability.steps.find((s) => s.id === 's02')!.postcondition).toBeUndefined();
    expect(capability.steps.find((s) => s.id === 's03')!.postcondition).toBeUndefined();
    expect(report.changes.filter((c) => c.kind === 'dropped_vacuous_postcondition').map((c) => c.stepId)).toEqual(['s02', 's03']);
    // The input-bound checkpoints that did real work are untouched.
    expect(capability.steps.find((s) => s.id === 's07')!.postcondition).toEqual(cap.steps.find((s) => s.id === 's07')!.postcondition);
    expect(capability.steps.find((s) => s.id === 's08')!.postcondition).toEqual(cap.steps.find((s) => s.id === 's08')!.postcondition);
    expect(capability.version).toBe('1.2.3');
    expect(capability.status).toBe('draft');
    expect(validateCapability(capability).ok).toBe(true);

    // The optimized draft replays to the same answer.
    const again = await replayTrialRunner({ memberId: '12345' })({ capability, purpose: 'verify', label: 'check' });
    expect(again).toMatchObject({ kind: 'success', outputs: { savingsBalance: 1234.56, memberName: 'Jane Q. Sample' } });
  });
});

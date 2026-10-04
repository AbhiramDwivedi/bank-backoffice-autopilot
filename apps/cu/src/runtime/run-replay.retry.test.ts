/**
 * runReplay's wiring of the app-error retry (packages/core/src/replay, `retryAppError`): the
 * run-level read-only assertion, the budget from the policy's `limits.maxAppErrorRetries`, and the
 * caller's own budget (`replayExtras`, what an optimizer trial passes) winning over the policy.
 * On the in-memory CU Core surface with every member search failing, so each run ends in
 * `hard_failure app_error` and the number of `retry_app_error` recoveries is the budget it had.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadPolicy } from '@cu/core/policy';
import type { Policy } from '@cu/core/schema';
import { createCuCoreSurface } from '@cu/core/surface';
import { runReplay, type RunReplayOptions } from './run-replay.js';

const EXAMPLE = 'artifacts/examples/lookup-member-savings-balance.example.json';
const RETRY = 'retry_app_error';

beforeAll(() => {
  process.env.MOCK_USER ??= 'operator1';
  process.env.MOCK_PASSWORD ??= 'demo-pass-123';
});

const tempDirs: string[] = [];
afterEach(() => {
  for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function example(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(EXAMPLE, 'utf8')) as Record<string, unknown>;
}

function policyWith(maxAppErrorRetries: number | undefined): Policy {
  const base = loadPolicy(path.resolve('policies/default.yaml'));
  // The shipped policy's own retry limit is left out: each case states the one it runs under.
  const limits = { maxSteps: base.limits.maxSteps, maxDurationMs: base.limits.maxDurationMs, maxLlmCalls: base.limits.maxLlmCalls };
  return { ...base, limits: { ...limits, ...(maxAppErrorRetries !== undefined ? { maxAppErrorRetries } : {}) } };
}

/**
 * A clock for the surface only, so the failing search does not wait out its checkpoint (the search
 * step's own 15 s timeout) in real time on every attempt. Replay itself runs on the real clock
 * here; every run passes a backoff of 0, so no retry waits.
 */
function instantClock(): { now(): number; sleep(ms: number): Promise<void> } {
  let now = 0;
  return {
    now: () => now,
    sleep: (ms) => {
      now += ms;
      return Promise.resolve();
    },
  };
}

function failingSearchSurface(): ReturnType<typeof createCuCoreSurface> {
  return createCuCoreSurface({ failSearch: true, clock: instantClock() });
}

/** One replay with every search failing; returns how many times it retried, and the result. */
async function failingRun(extra: Partial<RunReplayOptions>): Promise<{ retries: number; code: string | undefined }> {
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-replay-retry-'));
  tempDirs.push(runsDir);
  const { result } = await runReplay({
    capability: example(),
    inputs: { memberId: '12345' },
    policy: policyWith(1),
    runsDir,
    baseUrl: 'http://localhost:4173',
    headless: true,
    autoOperator: 'abort',
    surface: failingSearchSurface(),
    appErrorRetryBackoffMs: 0,
    ...extra,
  });
  return { retries: result.recoveries.filter((r) => r === RETRY).length, code: result.kind === 'hard_failure' ? result.code : undefined };
}

describe('runReplay: the app-error retry', () => {
  it('without readOnly nothing retries, whatever the policy allows', async () => {
    expect(await failingRun({})).toEqual({ retries: 0, code: 'app_error' });
  });

  it('readOnly: true retries as often as the policy\'s limits.maxAppErrorRetries says', async () => {
    expect(await failingRun({ readOnly: true })).toEqual({ retries: 1, code: 'app_error' });
  });

  it('a policy without the limit leaves replay\'s default of 2; a policy that sets 0 turns the retry off', async () => {
    expect(await failingRun({ readOnly: true, policy: policyWith(undefined) })).toEqual({ retries: 2, code: 'app_error' });
    expect(await failingRun({ readOnly: true, policy: policyWith(0) })).toEqual({ retries: 0, code: 'app_error' });
  });

  it('the caller\'s own budget wins over the policy: an optimizer trial passes 0 and never retries', async () => {
    const readOnlyCapability = { ...example(), readOnly: true };
    expect(await failingRun({ capability: readOnlyCapability, replayExtras: { maxAppErrorRetries: 0 } })).toEqual({ retries: 0, code: 'app_error' });
    // The same capability, replayed normally, does retry: its own readOnly: true needs no flag.
    expect(await failingRun({ capability: readOnlyCapability })).toEqual({ retries: 1, code: 'app_error' });
  });

  it('readOnly on a capability with an irreversible step is refused by replay: a policy_violation result, nothing acted on', async () => {
    const cap = example();
    const steps = cap.steps as { id: string; risk: string }[];
    steps.find((s) => s.id === 's06')!.risk = 'irreversible';
    cap.riskLevel = 'irreversible';
    const surface = failingSearchSurface();
    expect(await failingRun({ capability: cap, readOnly: true, surface })).toEqual({ retries: 0, code: 'policy_violation' });
    expect(surface.actionLog()).toEqual([]);
  });
});

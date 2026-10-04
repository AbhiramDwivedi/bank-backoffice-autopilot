/**
 * Discovery loop limit enforcement: the loop runs until `done`, `stuck`, abort, or a limit
 * (`maxSteps`, `maxLlmCalls`, `maxDurationMs`; defaults from `policy.limits`). Covers
 * maxLlmCalls, maxDurationMs (fake clock, no real waiting), the policy-default fallback,
 * adversarial caller inputs (Infinity/NaN/negative -- all of which fall back to the policy
 * default via `resolveLimits`, packages/core/src/agent/limits.ts), a permanently-failing LLM (throws /
 * always-malformed tool call), and a repeated-identical-action loop.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { discover } from './discover.js';
import { createScriptedLlm, type ScriptedTurn } from './scripted-llm.js';
import type { DiscoverOptions, InputDecl, PolicyGuardLike } from './types.js';
import { createCuCoreSurface } from '../surface/fake-scenarios/cu-core.js';
import { createRunLogger, newRunId } from '../evidence/index.js';
import { DEFAULT_POLICY_PATH, loadPolicy } from '../policy/load.js';
import type { Policy } from '../schema/index.js';

const BASE_URL = 'http://localhost:4173';
const ENTRY_URL = `${BASE_URL}/login`;
const DEFAULT_POLICY = loadPolicy(DEFAULT_POLICY_PATH);

// ---------------------------------------------------------------------------------------------
// Shared helpers. These mirror the ones in discover.test.ts, which are module-local there and
// not exported, so this separate suite defines its own copies.
// ---------------------------------------------------------------------------------------------

const tmpDirs: string[] = [];
const surfaces: { close(): Promise<void> }[] = [];

afterEach(async () => {
  while (surfaces.length > 0) await surfaces.pop()!.close();
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function makeLogger() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'limits-redteam-'));
  tmpDirs.push(dir);
  const runId = newRunId();
  const logger = createRunLogger({ runId, runKind: 'discovery', rootDir: dir });
  return { dir, runId, logger };
}

function allowGuard(): PolicyGuardLike {
  return {
    checkAction: () => ({ decision: 'allow', reason: 'ok', risk: 'read' }),
    checkUrl: () => ({ allowed: true, reason: 'ok' }),
  };
}

function makeInputs(overrides: Record<string, InputDecl> = {}): Record<string, InputDecl> {
  return {
    memberId: { value: '12345', sensitive: false, description: 'The member ID to look up.', type: 'string' },
    ...overrides,
  };
}

function baseOptions(
  logger: ReturnType<typeof makeLogger>['logger'],
  llm: DiscoverOptions['llm'],
  overrides: Partial<DiscoverOptions> = {},
): DiscoverOptions {
  const surface = createCuCoreSurface();
  surfaces.push(surface);
  return {
    goal: 'Log in, look up member 12345 and read their current savings balance.',
    target: { baseUrl: BASE_URL, entryUrl: ENTRY_URL },
    app: { vendor: 'Acme Core Systems', product: 'CU Core Workstation', surface: 'web' },
    inputs: makeInputs(),
    surface,
    policy: DEFAULT_POLICY,
    guard: allowGuard(),
    logger,
    llm,
    secretEnvNames: ['MOCK_USER', 'MOCK_PASSWORD'],
    secrets: (env) => ({ MOCK_USER: 'operator1', MOCK_PASSWORD: 'demo-pass-123' })[env],
    expectTimeoutMs: 150,
    ...overrides,
  };
}

/** A harmless action ("press Escape") that never asserts `done`/`stuck` and needs no ref lookup
 *  -- i.e. exactly "the scripted LLM that never says done" the task calls for, immune to any
 *  drift in the FakeSurface scenario's element refs/names. */
function pressForever(): ScriptedTurn {
  return { tool: 'press', input: { key: 'Escape', why: 'Try to clear anything blocking the view', expect: '' } };
}

function policyWithLimits(overrides: Partial<Policy['limits']>): Policy {
  return { ...DEFAULT_POLICY, limits: { ...DEFAULT_POLICY.limits, ...overrides } };
}

/** A deterministic fake clock: call N returns `base + deltasMs[N]` (clamped to the last entry).
 *  discover.ts calls `now()` exactly once for `startedAtMs` and then once per loop iteration
 *  that reaches the duration check -- no real timers, no waiting. */
function fakeClock(deltasMs: number[]): () => Date {
  const base = Date.parse('2024-01-01T00:00:00.000Z');
  let i = 0;
  return () => {
    const idx = Math.min(i, deltasMs.length - 1);
    i += 1;
    return new Date(base + (deltasMs[idx] ?? 0));
  };
}

// ---------------------------------------------------------------------------------------------
// maxSteps stops the loop and reports the reason
// ---------------------------------------------------------------------------------------------

describe('maxSteps', () => {
  it('stops a scripted LLM that always returns a harmless action and reports max_steps', async () => {
    const { logger } = makeLogger();
    const llm = createScriptedLlm(Array.from({ length: 10 }, pressForever));
    const opts = baseOptions(logger, llm, { maxSteps: 4 });

    const result = await discover(opts);

    expect(result.status).toBe('max_steps');
    expect(result.reason).toBe('max_steps');
    expect(llm.requests).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------------------------
// maxLlmCalls stops the loop independently of maxSteps
// ---------------------------------------------------------------------------------------------

describe('maxLlmCalls', () => {
  it('stops after exactly maxLlmCalls model calls and reports max_llm_calls', async () => {
    const { logger } = makeLogger();
    const llm = createScriptedLlm(Array.from({ length: 20 }, pressForever));
    const opts = baseOptions(logger, llm, { maxSteps: 1000, maxLlmCalls: 3 });

    const result = await discover(opts);

    expect(result.status).toBe('max_steps');
    expect(result.reason).toBe('max_llm_calls');
    expect(llm.requests).toHaveLength(3);
    expect(result.llmCalls).toBe(3);
  });
});

// ---------------------------------------------------------------------------------------------
// maxDurationMs stops the loop, proven with a fake clock (no real waiting / slow LLM)
// ---------------------------------------------------------------------------------------------

describe('maxDurationMs', () => {
  it('stops on the first duration check once the fake clock has advanced past the budget', async () => {
    const { logger } = makeLogger();
    const llm = createScriptedLlm(Array.from({ length: 20 }, pressForever));
    const clock = fakeClock([0, 10_000]); // call 1: startedAtMs=base; call 2: base+10s
    const opts = baseOptions(logger, llm, {
      maxSteps: 1000,
      maxLlmCalls: 1000,
      maxDurationMs: 5000,
      now: clock,
    });

    const result = await discover(opts);

    expect(result.status).toBe('max_steps');
    expect(result.reason).toBe('max_duration');
    // The duration check fires before the first observe/LLM call of the loop body.
    expect(llm.requests).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------
// policy.limits.* apply when the caller passes none
// ---------------------------------------------------------------------------------------------

describe('policy.limits fallback', () => {
  it('uses policy.limits.maxSteps when the caller supplies no maxSteps override', async () => {
    const { logger } = makeLogger();
    const llm = createScriptedLlm(Array.from({ length: 20 }, pressForever));
    const tightPolicy = policyWithLimits({ maxSteps: 3 });
    const opts = baseOptions(logger, llm, { policy: tightPolicy }); // no maxSteps override

    const result = await discover(opts);

    expect(result.status).toBe('max_steps');
    expect(result.reason).toBe('max_steps');
    expect(llm.requests).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------------------------
// Adversarial caller-supplied limits: an invalid maxSteps falls back to the policy default
// (resolveLimits, packages/core/src/agent/limits.ts) instead of disabling the step limit.
// ---------------------------------------------------------------------------------------------

describe('adversarial caller-supplied limits', () => {
  it('maxSteps: Infinity falls back to the policy default instead of disabling the step limit', async () => {
    const { logger } = makeLogger();
    const llm = createScriptedLlm(Array.from({ length: 50 }, pressForever));
    const tightPolicy = policyWithLimits({ maxSteps: 3 });
    // maxLlmCalls is deliberately generous so maxSteps is the limit that actually bites.
    const opts = baseOptions(logger, llm, { policy: tightPolicy, maxSteps: Infinity, maxLlmCalls: 1000 });

    const result = await discover(opts);

    expect(result.status).toBe('max_steps');
    expect(result.reason).toBe('max_steps');
    expect(llm.requests).toHaveLength(3);
  });

  it('maxSteps: NaN falls back to the policy default the same way', async () => {
    const { logger } = makeLogger();
    const llm = createScriptedLlm(Array.from({ length: 50 }, pressForever));
    const tightPolicy = policyWithLimits({ maxSteps: 3 });
    const opts = baseOptions(logger, llm, { policy: tightPolicy, maxSteps: Number.NaN, maxLlmCalls: 1000 });

    const result = await discover(opts);

    expect(result.status).toBe('max_steps');
    expect(result.reason).toBe('max_steps');
    expect(llm.requests).toHaveLength(3);
  });

  it('a non-positive maxSteps (e.g. -1) falls back to the policy default rather than stopping the run before it starts', async () => {
    const { logger } = makeLogger();
    const llm = createScriptedLlm(Array.from({ length: 50 }, pressForever));
    const tightPolicy = policyWithLimits({ maxSteps: 3 });
    const opts = baseOptions(logger, llm, { policy: tightPolicy, maxSteps: -1, maxLlmCalls: 1000 });

    const result = await discover(opts);

    expect(result.status).toBe('max_steps');
    expect(result.reason).toBe('max_steps');
    expect(llm.requests).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------------------------
// An LLM that throws on every call is bounded to exactly one call
// ---------------------------------------------------------------------------------------------

describe('an LLM client that always throws', () => {
  it('ends the run as stuck after exactly one failed call, not retried indefinitely', async () => {
    const { logger } = makeLogger();
    const throwingLlm = {
      model: 'throwing-test-llm',
      complete: async (): Promise<never> => {
        throw new Error('simulated network failure');
      },
    };
    const opts = baseOptions(logger, throwingLlm, { maxSteps: 1000, maxLlmCalls: 1000 });

    const result = await discover(opts);

    expect(result.status).toBe('stuck');
    expect(result.reason).toContain('llm_error');
    expect(result.reason).toContain('simulated network failure');
    expect(result.llmCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// An LLM that always returns a malformed/invalid tool call is bounded by maxSteps
// ---------------------------------------------------------------------------------------------

describe('an LLM that always returns an invalid tool call', () => {
  it('never crashes and is bounded by maxSteps, not left to loop forever', async () => {
    const { logger } = makeLogger();
    // Missing required `why`/`expect` fields -> parseToolCall fails every single turn.
    const invalidTurns: ScriptedTurn[] = Array.from({ length: 10 }, () => ({
      tool: 'click',
      input: { ref: 'e1' },
    }));
    const llm = createScriptedLlm(invalidTurns);
    const opts = baseOptions(logger, llm, { maxSteps: 5, maxLlmCalls: 1000 });

    const result = await discover(opts);

    expect(result.status).toBe('max_steps');
    expect(result.reason).toBe('max_steps');
    expect(llm.requests).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------------------------
// A repeated identical action with no `expect` is bounded by maxSteps only: the stuck-repeat
// detector (StuckRepeatDetector, packages/core/src/agent/limits.ts) only ever counts a call that declares an
// `expect` and then fails to meet it, so a no-op action with an empty `expect` (e.g. a bare
// keypress used to probe the screen) does not feed it. The loop still relies on consecutive-deny
// (3), consecutive-no-tool-use (3), and maxSteps to bound this case.
// ---------------------------------------------------------------------------------------------

describe('identical action repeated every turn with no expect', () => {
  it('is bounded by maxSteps; an empty expect never feeds the stuck-repeat detector', async () => {
    const { logger } = makeLogger();
    // The exact same action, same why/expect, every single turn.
    const identical = { tool: 'press' as const, input: { key: 'Escape', why: 'Try again', expect: '' } };
    const llm = createScriptedLlm(Array.from({ length: 10 }, () => identical));
    const opts = baseOptions(logger, llm, { maxSteps: 6 });

    const result = await discover(opts);

    expect(result.status).toBe('max_steps');
    expect(result.reason).toBe('max_steps');
    expect(llm.requests).toHaveLength(6);
  });
});

// ---------------------------------------------------------------------------------------------
// A repeated identical action WITH an expect that never comes true is caught sooner: the third
// consecutive repeat routes through the same stuck path as a repeated policy denial.
// ---------------------------------------------------------------------------------------------

describe('identical action repeated with an expectation that is never met', () => {
  it('gives up as stuck on the third consecutive repeat, well before maxSteps', async () => {
    const { logger } = makeLogger();
    const identical = { tool: 'press' as const, input: { key: 'Escape', why: 'Try again', expect: 'This text never appears' } };
    const llm = createScriptedLlm(Array.from({ length: 20 }, () => identical));
    const opts = baseOptions(logger, llm, { maxSteps: 1000 });

    const result = await discover(opts);

    expect(result.status).toBe('stuck');
    expect(result.reason).toContain('repeated 3 times');
    expect(llm.requests).toHaveLength(3);
  });
});

/**
 * Covers two edge cases in packages/core/src/replay/steps.ts:
 *
 * 1. `policyContext()` folds a target descriptor's own `description` into the text checked
 *    against `irreversibleTextPatterns` (mirroring `descriptorTexts()` in
 *    packages/core/src/policy/enforcing-surface.ts), so a step whose target has no snapshot or text locator --
 *    only a css/bbox locator -- is still classified irreversible when its description alone says
 *    so, even though the author declared the step `risk: 'read'`.
 * 2. `checkOutcomes()`'s outcome `data` and `RunState.outputs` are built as null-prototype
 *    objects, so an extracted field literally named "__proto__" (a legal `Identifier`) survives
 *    as a normal own property instead of being silently dropped or reparenting the container.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { el, FakeSurface, scenario } from '../surface/index.js';
import type { Surface } from '../surface/types.js';
import { createRunLogger, createValueScrubber, newRunId } from '../evidence/index.js';
import { createPolicyGuard, DEFAULT_POLICY_PATH, loadPolicy } from '../policy/index.js';
import type { BusinessOutcome, Capability, Step, TargetDescriptor } from '../schema/index.js';
import { checkOutcomes, runStep } from './steps.js';
import type { InputValue, ReplayClock, RunState } from './types.js';
import { makeFakeClock, runReplay } from './test-helpers.js';

const BASE = 'http://localhost:4173';

function textTarget(text: string, description = text): TargetDescriptor {
  return { description, frame: [], locators: [{ strategy: { kind: 'text', text }, confidence: 0.8, source: 'recorded' }] };
}

function cssOnlyTarget(description: string, selector: string): TargetDescriptor {
  return { description, frame: [], locators: [{ strategy: { kind: 'css', selector }, confidence: 0.3, source: 'recorded' }] };
}

function minimalCapability(overrides: { steps?: Step[]; businessOutcomes?: BusinessOutcome[] } = {}): Capability {
  return {
    schemaVersion: '1.0',
    id: 'policy-context-fixture',
    version: '1.0.0',
    name: 'Policy context fixture',
    description: 'Minimal capability used only to exercise steps.ts directly.',
    app: { vendor: 'Acme', product: 'Core', surface: 'web', entryUrl: `${BASE}/start` },
    status: 'draft',
    riskLevel: 'read',
    inputs: {},
    outputs: {},
    steps: overrides.steps ?? [],
    success: { condition: { kind: 'text_visible', text: 'Ready' }, description: 'reached the ready state' },
    businessOutcomes: overrides.businessOutcomes ?? [],
    recoveryRules: [],
    provenance: { discoveredAt: '2024-01-01T00:00:00Z', discoveryRunId: 'test-run', recordedBy: 'human' },
  };
}

// -------------------------------------------------------------------------------------------
// 1. Target description drives runtime risk classification
// -------------------------------------------------------------------------------------------

function buildClickScenario() {
  return scenario()
    .screen('start', {
      url: `${BASE}/start`,
      title: 'Start',
      text: ['Ready'],
      elements: [el({ id: 'confirm', role: 'button', name: 'OK', text: 'OK', tag: 'button', css: ['#confirm-btn'], bbox: { x: 0, y: 0, w: 10, h: 10 } })],
    })
    .on('navigate', { url: `${BASE}/start` })
    .goto('start')
    .build();
}

function buildClickCapability(): Capability {
  return minimalCapability({
    steps: [
      { id: 's01', name: 'Navigate to start', action: { type: 'navigate', url: `${BASE}/start` }, risk: 'read' },
      // The author marked this 'read': neither the live element's accessible name ("OK") nor any
      // snapshot/text locator says otherwise -- only the descriptor's own `description` does.
      { id: 's02', name: 'Click confirm', action: { type: 'click', target: cssOnlyTarget('Confirm transfer', '#confirm-btn') }, risk: 'read' },
    ],
  });
}

describe('runtime risk classification includes the target description', () => {
  it('refuses a css-only click whose only irreversible signal is its target description, without approval', async () => {
    const guard = createPolicyGuard(loadPolicy(DEFAULT_POLICY_PATH));
    const clock = makeFakeClock();
    const surface = new FakeSurface(buildClickScenario(), { clock });

    const { result } = await runReplay({ capability: buildClickCapability(), inputs: {}, surface, clock, policy: guard });

    expect(result.kind).toBe('hard_failure');
    if (result.kind === 'hard_failure') {
      expect(result.code).toBe('policy_violation');
      expect(result.stepId).toBe('s02');
    }
  });
});

// -------------------------------------------------------------------------------------------
// 2. Prototype-safe outputs and outcome data
// -------------------------------------------------------------------------------------------

function buildValueScenario() {
  return scenario()
    .screen('main', {
      url: `${BASE}/main`,
      title: 'Main',
      text: ['Ready'],
      elements: [el({ id: 'value', role: 'cell', name: 'Value', text: '77', tag: 'td', bbox: { x: 0, y: 0, w: 10, h: 10 } })],
    })
    .build();
}

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function makeRunState(overrides: { capability: Capability; surface: Surface }): RunState {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'proto-safety-'));
  tmpDirs.push(dir);
  const logger = createRunLogger({ runId: newRunId(), runKind: 'replay', rootDir: dir });
  const clock: ReplayClock = { now: () => 0, sleep: () => Promise.resolve() };
  return {
    runId: logger.runId,
    capability: overrides.capability,
    inputs: {},
    surface: overrides.surface,
    logger,
    scrubber: createValueScrubber([]),
    clock,
    baseUrl: BASE,
    irreversibleAllowed: true,
    stepTimeoutMs: 2000,
    startedAt: 0,
    deadline: 1_000_000,
    outputs: Object.create(null) as Record<string, InputValue>,
    locatorReport: [],
    recoveries: [],
    recoveryAttempts: new Map(),
    stepsExecuted: 0,
    sessionExpiredSignals: [],
    appErrorSignals: [],
  };
}

describe('prototype-safe outputs and outcome data', () => {
  it('an extracted value bound to output "__proto__" survives as an own property of RunState.outputs', async () => {
    const surface = new FakeSurface(buildValueScenario());
    const step: Step = {
      id: 's01',
      name: 'Extract value',
      action: { type: 'extract', target: textTarget('77', 'Value cell'), output: '__proto__', parse: 'text' },
      risk: 'read',
    };
    const capability = minimalCapability({ steps: [step] });
    const state = makeRunState({ capability, surface });

    const outcome = await runStep(state, step);

    expect(outcome.kind).toBe('ok');
    expect(Object.prototype.hasOwnProperty.call(state.outputs, '__proto__')).toBe(true);
    expect(state.outputs['__proto__']).toBe('77');
  });

  it('a business outcome extract bound to output "__proto__" survives as an own property of the returned outcome data', async () => {
    const surface = new FakeSurface(buildValueScenario());
    const capability = minimalCapability({
      businessOutcomes: [
        {
          name: 'weird_outcome',
          description: 'test-only outcome whose extract output is named "__proto__".',
          detector: { kind: 'text_visible', text: 'Ready' },
          // Computed key: writes a genuine own property named "__proto__" on this object literal
          // (a literal `__proto__:` key here would instead set the OBJECT'S prototype).
          returns: { ['__proto__']: { type: 'string', description: 'test' } },
          extract: [{ output: '__proto__', target: textTarget('77', 'Value cell'), parse: 'text' }],
        },
      ],
    });
    const state = makeRunState({ capability, surface });

    const outcome = await checkOutcomes(state, 's01');

    expect(outcome?.kind).toBe('business_outcome');
    if (outcome?.kind === 'business_outcome') {
      expect(Object.prototype.hasOwnProperty.call(outcome.data, '__proto__')).toBe(true);
      expect(outcome.data['__proto__']).toBe('77');
    }
  });
});

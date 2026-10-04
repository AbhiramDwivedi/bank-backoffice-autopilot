import { describe, expect, it } from 'vitest';
import type { Action, BusinessOutcome, Capability, Step, TargetDescriptor } from '../schema/index.js';
import { bumpMinor, mapStepId, mergeOutcomes, type ExtendRun } from './extend.js';

function targetFor(name: string): TargetDescriptor {
  return {
    description: `${name} button`,
    frame: [],
    locators: [{ strategy: { kind: 'role', role: 'button', name }, confidence: 0.9, source: 'recorded' }],
  };
}

function step(id: string, action: Action): Step {
  return { id, name: id, action, risk: 'read' };
}

function baseCapability(overrides: Partial<Capability> = {}): Capability {
  return {
    schemaVersion: '1.0',
    id: 'lookup-member',
    version: '1.0.0',
    name: 'Lookup Member',
    description: 'Looks up a member.',
    app: { vendor: 'Acme', product: 'CU Core', surface: 'web', entryUrl: '{baseUrl}/login' },
    status: 'draft',
    riskLevel: 'read',
    inputs: {},
    outputs: {},
    steps: [
      step('s01', { type: 'navigate', url: '{baseUrl}/login' }),
      step('s02', { type: 'click', target: targetFor('Foo') }),
      step('s03', { type: 'click', target: targetFor('Bar') }),
    ],
    success: { condition: { kind: 'text_visible', text: 'ok' }, description: 'done' },
    businessOutcomes: [],
    recoveryRules: [],
    provenance: { discoveredAt: '2026-01-01T00:00:00Z', discoveryRunId: 'run0', recordedBy: 'llm' },
    ...overrides,
  };
}

describe('bumpMinor', () => {
  it('bumps the minor version and resets patch to 0', () => {
    expect(bumpMinor('1.0.0')).toBe('1.1.0');
    expect(bumpMinor('1.2.3')).toBe('1.3.0');
  });

  it('drops prerelease/build metadata', () => {
    expect(bumpMinor('2.4.9-beta.1+build.5')).toBe('2.5.0');
  });

  it('throws on a non-semver string', () => {
    expect(() => bumpMinor('not-a-version')).toThrow();
  });
});

describe('mapStepId', () => {
  const existing: Step[] = [
    step('s01', { type: 'navigate', url: '{baseUrl}/login' }),
    step('s02', { type: 'click', target: targetFor('Foo') }),
    step('s03', { type: 'click', target: targetFor('Bar') }),
  ];

  it('matches by action type + canonical target description, even when the index differs', () => {
    const newSteps: Step[] = [
      step('n01', { type: 'navigate', url: '{baseUrl}/login' }),
      step('n02', { type: 'click', target: targetFor('Bar') }), // index 1, but describes s03 ("Bar"), not s02 ("Foo")
    ];
    expect(mapStepId(existing, newSteps, 'n02')).toBe('s03');
  });

  it('matches navigate by url and press by key when there is no target', () => {
    const newSteps: Step[] = [step('n01', { type: 'navigate', url: '{baseUrl}/login' }), step('n02', { type: 'press', key: 'Enter' })];
    const existingWithPress: Step[] = [...existing, step('s04', { type: 'press', key: 'Enter' })];
    expect(mapStepId(existingWithPress, newSteps, 'n01')).toBe('s01');
    expect(mapStepId(existingWithPress, newSteps, 'n02')).toBe('s04');
  });

  it('falls back to the same index when the action has no matchable target (e.g. wait)', () => {
    const newSteps: Step[] = [
      step('n01', { type: 'navigate', url: '{baseUrl}/login' }),
      step('n02', { type: 'wait', condition: { kind: 'text_visible', text: 'anything' } }),
    ];
    expect(mapStepId(existing, newSteps, 'n02')).toBe('s02'); // index 1 -> existing[1] = s02
  });

  it('falls back to the last existing step when the new step id is unknown or out of range', () => {
    const newSteps: Step[] = [
      step('n01', { type: 'navigate', url: '{baseUrl}/login' }),
      step('n02', { type: 'wait', condition: { kind: 'text_visible', text: 'anything' } }),
      step('n03', { type: 'wait', condition: { kind: 'text_visible', text: 'anything else' } }),
      step('n04', { type: 'wait', condition: { kind: 'text_visible', text: 'yet another' } }),
    ];
    expect(mapStepId(existing, newSteps, 'does-not-exist')).toBe('s03');
    expect(mapStepId(existing, newSteps, 'n04')).toBe('s03'); // index 3 is out of range for a 3-step existing capability
  });

  it('returns undefined when there are no existing steps', () => {
    expect(mapStepId([], [step('n01', { type: 'navigate', url: '{baseUrl}/login' })], 'n01')).toBeUndefined();
  });
});

describe('mergeOutcomes', () => {
  const existingSteps: Step[] = [
    step('s01', { type: 'navigate', url: '{baseUrl}/login' }),
    step('s02', { type: 'click', target: targetFor('Foo') }),
    step('s03', { type: 'click', target: targetFor('Bar') }),
  ];

  function memberNotFound(): BusinessOutcome {
    return {
      name: 'member_not_found',
      description: 'No member matches.',
      detector: { kind: 'text_visible', text: 'No records found.' },
      afterSteps: ['s02'],
      returns: {},
    };
  }

  it('adds new outcomes with afterSteps remapped via mapStepId, keeps steps identical, and bumps the version', () => {
    const existing = baseCapability({ steps: existingSteps, businessOutcomes: [memberNotFound()] });
    const newSteps: Step[] = [step('n01', { type: 'navigate', url: '{baseUrl}/login' }), step('n02', { type: 'click', target: targetFor('Bar') })];
    const run: ExtendRun = {
      steps: newSteps,
      outcomes: [
        {
          name: 'access_denied',
          description: 'Restricted member.',
          detector: { kind: 'text_visible', text: 'Access Denied' },
          afterSteps: ['n02'],
          returns: {},
        },
      ],
      runId: 'run1',
      discoveredAt: '2026-09-25T01:00:00Z',
      model: 'test-model',
    };

    const merged = mergeOutcomes(existing, run);

    expect(merged.steps).toBe(existing.steps); // unchanged, same reference
    expect(merged.version).toBe('1.1.0');
    const added = merged.businessOutcomes.find((o) => o.name === 'access_denied');
    expect(added?.afterSteps).toEqual(['s03']); // remapped from n02 ("Bar") to s03 ("Bar"), not the raw index
    expect(merged.businessOutcomes.find((o) => o.name === 'member_not_found')).toBeDefined();
    expect(merged.provenance.notes).toContain('run1');
    expect(merged.provenance.notes).toContain('access_denied');

    // Does not mutate the input.
    expect(existing.businessOutcomes).toHaveLength(1);
    expect(existing.version).toBe('1.0.0');
    expect(existing.provenance.notes).toBeUndefined();
  });

  it('replaces an existing outcome with the same name instead of duplicating it', () => {
    const existing = baseCapability({ steps: existingSteps, businessOutcomes: [memberNotFound()] });
    const run: ExtendRun = {
      steps: [step('n01', { type: 'click', target: targetFor('Foo') })],
      outcomes: [
        {
          name: 'member_not_found',
          description: 'Updated description from the new run.',
          detector: { kind: 'text_visible', text: 'No records found.' },
          returns: {},
        },
      ],
      runId: 'run2',
      discoveredAt: '2026-09-25T02:00:00Z',
      model: 'test-model',
    };
    const merged = mergeOutcomes(existing, run);
    expect(merged.businessOutcomes).toHaveLength(1);
    expect(merged.businessOutcomes[0]!.description).toBe('Updated description from the new run.');
  });

  it('sets recordedBy to mixed when the existing capability was human-recorded, and leaves llm/mixed alone', () => {
    const runFor = (): ExtendRun => ({
      steps: existingSteps,
      outcomes: [],
      runId: 'run3',
      discoveredAt: '2026-09-25T03:00:00Z',
      model: 'test-model',
    });

    const human = baseCapability({ steps: existingSteps, provenance: { discoveredAt: '2026-01-01T00:00:00Z', discoveryRunId: 'run0', recordedBy: 'human' } });
    expect(mergeOutcomes(human, runFor()).provenance.recordedBy).toBe('mixed');

    const llm = baseCapability({ steps: existingSteps, provenance: { discoveredAt: '2026-01-01T00:00:00Z', discoveryRunId: 'run0', recordedBy: 'llm' } });
    expect(mergeOutcomes(llm, runFor()).provenance.recordedBy).toBe('llm');

    const mixed = baseCapability({ steps: existingSteps, provenance: { discoveredAt: '2026-01-01T00:00:00Z', discoveryRunId: 'run0', recordedBy: 'mixed' } });
    expect(mergeOutcomes(mixed, runFor()).provenance.recordedBy).toBe('mixed');
  });

  it('appends to existing provenance notes rather than replacing them', () => {
    const existing = baseCapability({
      steps: existingSteps,
      provenance: { discoveredAt: '2026-01-01T00:00:00Z', discoveryRunId: 'run0', recordedBy: 'llm', notes: 'original note' },
    });
    const run: ExtendRun = {
      steps: existingSteps,
      outcomes: [],
      runId: 'run4',
      discoveredAt: '2026-09-25T04:00:00Z',
      model: 'test-model',
      notes: 'extra context from the run',
    };
    const merged = mergeOutcomes(existing, run);
    expect(merged.provenance.notes).toContain('original note');
    expect(merged.provenance.notes).toContain('run4');
    expect(merged.provenance.notes).toContain('extra context from the run');
  });

  it('produces a draft from an approved capability, and notes that the approval does not carry over', () => {
    const existing = baseCapability({ steps: existingSteps, status: 'approved' });
    const run: ExtendRun = {
      steps: existingSteps,
      outcomes: [memberNotFound()],
      runId: 'run5',
      discoveredAt: '2026-09-25T05:00:00Z',
      model: 'test-model',
    };
    const merged = mergeOutcomes(existing, run);
    expect(merged.status).toBe('draft');
    expect(merged.version).toBe('1.1.0');
    expect(merged.provenance.notes).toContain('Version 1.0.0 was approved; that approval does not carry over to 1.1.0');
    expect(existing.status).toBe('approved');
  });

  it('keeps a draft capability a draft without an approval note', () => {
    const merged = mergeOutcomes(baseCapability({ steps: existingSteps }), {
      steps: existingSteps,
      outcomes: [],
      runId: 'run6',
      discoveredAt: '2026-09-25T06:00:00Z',
      model: 'test-model',
    });
    expect(merged.status).toBe('draft');
    expect(merged.provenance.notes).not.toContain('approval');
  });
});

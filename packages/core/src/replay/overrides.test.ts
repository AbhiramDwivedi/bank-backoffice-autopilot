import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyTenantOverride } from './overrides.js';
import { Capability, validateCapability } from '../schema/index.js';
import type { TargetDescriptor } from '../schema/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function target(desc: string): TargetDescriptor {
  return {
    description: desc,
    frame: [],
    locators: [{ strategy: { kind: 'text', text: desc }, confidence: 0.9, source: 'recorded' }],
  };
}

function baseCap(): Capability {
  return {
    schemaVersion: '1.0',
    id: 'test-capability',
    version: '1.0.0',
    name: 'Test Capability',
    description: 'Self-contained fixture capability for overrides.ts unit tests.',
    app: { vendor: 'Acme', product: 'Widget', surface: 'web', entryUrl: '{baseUrl}/login' },
    status: 'approved',
    riskLevel: 'read',
    inputs: {},
    outputs: { balance: { type: 'number', description: 'the balance' } },
    steps: [
      { id: 's01', name: 'Open login', risk: 'read', action: { type: 'navigate', url: '{baseUrl}/login' } },
      { id: 's02', name: 'Open decoy', risk: 'read', action: { type: 'navigate', url: '{baseUrl}/other' } },
      {
        id: 's03',
        name: 'Enter username',
        risk: 'read',
        action: { type: 'type', target: target('Username field'), value: { kind: 'literal', value: 'demo' }, clear: true },
      },
      { id: 's04', name: 'Submit', risk: 'read', action: { type: 'click', target: target('Submit button') } },
      {
        id: 's05',
        name: 'Read balance',
        risk: 'read',
        action: { type: 'extract', target: target('Balance cell'), output: 'balance', parse: 'currency' },
      },
    ],
    success: { condition: { kind: 'text_visible', text: 'Balance' }, description: 'balance shown' },
    businessOutcomes: [],
    recoveryRules: [],
    provenance: { discoveredAt: '2026-01-01T00:00:00Z', discoveryRunId: 'run1', recordedBy: 'human' },
  };
}

describe('applyTenantOverride', () => {
  it('returns the capability unchanged (applied undefined) when tenant is undefined', () => {
    const cap = baseCap();
    const result = applyTenantOverride(cap, undefined);
    expect(result.applied).toBeUndefined();
    expect(result.capability).toBe(cap);
  });

  it('returns the capability unchanged (applied undefined) for a tenant with no matching override', () => {
    const cap = baseCap();
    cap.overrides = [{ tenant: 'some-other-tenant', stepPatches: [] }];
    const result = applyTenantOverride(cap, 'nonexistent-tenant');
    expect(result.applied).toBeUndefined();
    expect(result.capability).toBe(cap);
  });

  it('applies a target patch to a step', () => {
    const cap = baseCap();
    cap.overrides = [
      {
        tenant: 'acme-b',
        stepPatches: [{ stepId: 's03', target: target('Member # field') }],
      },
    ];
    const { capability, applied } = applyTenantOverride(cap, 'acme-b');
    const step = capability.steps.find((s) => s.id === 's03')!;
    expect(step.action.type).toBe('type');
    if (step.action.type === 'type') {
      expect(step.action.target.description).toBe('Member # field');
      // Untouched fields of the action survive the target-only patch.
      expect(step.action.clear).toBe(true);
    }
    expect(applied).toBeDefined();
    expect(applied!.patchedSteps).toEqual(['s03']);
  });

  it('shallow-merges an action partial patch onto the step', () => {
    const cap = baseCap();
    cap.overrides = [
      {
        tenant: 'acme-b',
        stepPatches: [{ stepId: 's03', action: { pressEnter: true } }],
      },
    ];
    const { capability, applied } = applyTenantOverride(cap, 'acme-b');
    const step = capability.steps.find((s) => s.id === 's03')!;
    expect(step.action.type).toBe('type');
    if (step.action.type === 'type') {
      expect(step.action.pressEnter).toBe(true);
      // Fields not in the patch are preserved.
      expect(step.action.clear).toBe(true);
      expect(step.action.value).toEqual({ kind: 'literal', value: 'demo' });
    }
    expect(applied!.patchedSteps).toEqual(['s03']);
  });

  it('records a step id once in patchedSteps even when both target and action are patched', () => {
    const cap = baseCap();
    cap.overrides = [
      {
        tenant: 'acme-b',
        stepPatches: [{ stepId: 's03', target: target('Member # field'), action: { pressEnter: true } }],
      },
    ];
    const { applied } = applyTenantOverride(cap, 'acme-b');
    expect(applied!.patchedSteps).toEqual(['s03']);
  });

  it('inserts extra steps immediately after their afterStepId, preserving relative order for the same anchor', () => {
    const cap = baseCap();
    cap.overrides = [
      {
        tenant: 'acme-b',
        stepPatches: [],
        extraSteps: [
          { afterStepId: 's01', step: { id: 'e1', name: 'Extra 1', risk: 'read', action: { type: 'click', target: target('E1') } } },
          { afterStepId: 's01', step: { id: 'e2', name: 'Extra 2', risk: 'read', action: { type: 'click', target: target('E2') } } },
          { afterStepId: 's04', step: { id: 'e3', name: 'Extra 3', risk: 'read', action: { type: 'click', target: target('E3') } } },
        ],
      },
    ];
    const { capability, applied } = applyTenantOverride(cap, 'acme-b');
    expect(capability.steps.map((s) => s.id)).toEqual(['s01', 'e1', 'e2', 's02', 's03', 's04', 'e3', 's05']);
    expect(applied!.extraSteps).toEqual([
      { stepId: 'e1', afterStepId: 's01' },
      { stepId: 'e2', afterStepId: 's01' },
      { stepId: 'e3', afterStepId: 's04' },
    ]);
  });

  it('throws when an extra step is anchored after another extra step rather than a base step', () => {
    const cap = baseCap();
    cap.overrides = [
      {
        tenant: 'acme-b',
        stepPatches: [],
        extraSteps: [
          { afterStepId: 's01', step: { id: 'e1', name: 'Extra 1', risk: 'read', action: { type: 'click', target: target('E1') } } },
          { afterStepId: 'e1', step: { id: 'e2', name: 'Extra 2', risk: 'read', action: { type: 'click', target: target('E2') } } },
        ],
      },
    ];
    expect(() => applyTenantOverride(cap, 'acme-b')).toThrow(/unknown afterStepId "e1"/);
    // validateCapability rejects the same override up front.
    const issues = validateCapability(cap);
    expect(issues.ok).toBe(false);
    if (!issues.ok) expect(issues.issues).toContainEqual(expect.objectContaining({ code: 'unknown_step_ref', path: ['overrides', 0, 'extraSteps', 1, 'afterStepId'] }));
  });

  it('raises riskLevel when an inserted extra step is riskier than every base step', () => {
    const cap = baseCap();
    cap.overrides = [
      {
        tenant: 'acme-b',
        stepPatches: [],
        extraSteps: [
          {
            afterStepId: 's04',
            step: { id: 'e1', name: 'Irreversible extra', risk: 'irreversible', action: { type: 'click', target: target('Confirm') } },
          },
        ],
      },
    ];
    const { capability } = applyTenantOverride(cap, 'acme-b');
    expect(capability.riskLevel).toBe('irreversible');
  });

  it('rewrites entryUrl and every navigate step whose url matched the original entryUrl exactly', () => {
    const cap = baseCap();
    cap.overrides = [
      {
        tenant: 'acme-b',
        entryUrl: '{baseUrl}/acme-b/login',
        stepPatches: [],
      },
    ];
    const { capability, applied } = applyTenantOverride(cap, 'acme-b');
    expect(capability.app.entryUrl).toBe('{baseUrl}/acme-b/login');
    const s01 = capability.steps.find((s) => s.id === 's01')!;
    expect(s01.action).toEqual({ type: 'navigate', url: '{baseUrl}/acme-b/login' });
    // The decoy step navigates elsewhere and must NOT be rewritten.
    const s02 = capability.steps.find((s) => s.id === 's02')!;
    expect(s02.action).toEqual({ type: 'navigate', url: '{baseUrl}/other' });
    expect(applied!.entryUrl).toBe('{baseUrl}/acme-b/login');
  });

  it('sets app.tenant and removes overrides from the effective capability', () => {
    const cap = baseCap();
    cap.overrides = [{ tenant: 'acme-b', stepPatches: [] }];
    const { capability } = applyTenantOverride(cap, 'acme-b');
    expect(capability.app.tenant).toBe('acme-b');
    expect(capability.overrides).toBeUndefined();
  });

  it('never mutates the input capability', () => {
    const cap = baseCap();
    cap.overrides = [
      {
        tenant: 'acme-b',
        entryUrl: '{baseUrl}/acme-b/login',
        stepPatches: [{ stepId: 's03', target: target('Member # field'), action: { pressEnter: true } }],
        extraSteps: [{ afterStepId: 's01', step: { id: 'e1', name: 'Extra', risk: 'read', action: { type: 'click', target: target('E1') } } }],
      },
    ];
    const before = JSON.parse(JSON.stringify(cap)) as unknown;
    const { capability } = applyTenantOverride(cap, 'acme-b');
    expect(JSON.parse(JSON.stringify(cap))).toEqual(before);
    expect(capability).not.toBe(cap);
    expect(capability.steps).not.toBe(cap.steps);
  });

  it('produces an effective capability that still passes validateCapability', () => {
    const cap = baseCap();
    cap.overrides = [
      {
        tenant: 'acme-b',
        entryUrl: '{baseUrl}/acme-b/login',
        stepPatches: [{ stepId: 's03', target: target('Member # field'), action: { pressEnter: true } }],
        extraSteps: [{ afterStepId: 's04', step: { id: 'e1', name: 'Extra', risk: 'read', action: { type: 'click', target: target('E1') } } }],
      },
    ];
    const { capability } = applyTenantOverride(cap, 'acme-b');
    const result = validateCapability(capability);
    if (!result.ok) throw new Error(JSON.stringify(result.issues, null, 2));
    expect(result.ok).toBe(true);
  });

  it('throws when a stepPatch targets an unknown step id', () => {
    const cap = baseCap();
    cap.overrides = [{ tenant: 'acme-b', stepPatches: [{ stepId: 'nope', target: target('X') }] }];
    expect(() => applyTenantOverride(cap, 'acme-b')).toThrow();
  });

  it('throws when a target patch is set on an action with no target', () => {
    const cap = baseCap();
    cap.overrides = [{ tenant: 'acme-b', stepPatches: [{ stepId: 's01', target: target('X') }] }];
    expect(() => applyTenantOverride(cap, 'acme-b')).toThrow();
  });

  describe('example artifact', () => {
    const exampleRaw = readFileSync(
      path.join(here, '../../../../artifacts/examples/lookup-member-savings-balance.example.json'),
      'utf8',
    );

    it('applies the riverbend-fcu override and still passes validateCapability', () => {
      const exampleJson: unknown = JSON.parse(exampleRaw);
      const cap = Capability.parse(exampleJson);
      const { capability, applied } = applyTenantOverride(cap, 'riverbend-fcu');
      expect(applied).toBeDefined();
      expect(applied!.tenant).toBe('riverbend-fcu');
      const result = validateCapability(capability);
      if (!result.ok) throw new Error(JSON.stringify(result.issues, null, 2));
      expect(result.ok).toBe(true);
      expect(capability.app.tenant).toBe('riverbend-fcu');
      expect(capability.overrides).toBeUndefined();
    });
  });
});

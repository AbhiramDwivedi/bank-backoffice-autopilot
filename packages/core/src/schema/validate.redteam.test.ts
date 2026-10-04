/**
 * Input validation and recovery/override risk checks at the schema layer.
 *
 * `InputSpec.pattern` itself must be a compilable regex, checked at capability-load time (before
 * any invocation), and a `sensitive` input must never carry a literal `example` value (the one
 * place a "sensitive" promise could otherwise leak in plain sight: docs, a catalog listing, a UI
 * form's placeholder).
 *
 * A `RecoveryRule` action must never be able to perform (or look like) an irreversible action.
 * Reading only a target's role/label/text/relative-anchor locators is not enough: a target
 * identified solely by a `css` locator contributes none of those, so an author (or attacker)
 * could give it an honest, readable `description` ("Confirm transfer button") while a check
 * scanning only locator text never sees it. `validateCapability` folds `description` into the
 * texts this check scans.
 *
 * A tenant override (`TenantOverride`) has no `approvedBy`/status of its own, so it always runs
 * under the base capability's `status`. Without a check, an override could insert an
 * `extraSteps` entry declared `risk: 'irreversible'` (or retarget an existing step via
 * `stepPatches`) into an already-`approved` capability, and `applyTenantOverride`
 * (`packages/core/src/replay/overrides.ts`) recomputes `riskLevel` to cover it -- so replay's approval gate
 * (`capability.status === 'approved'`) would let it run, even though nobody who approved the
 * base capability ever saw this step. `validateCapability` rejects this outright.
 */
import { describe, expect, it } from 'vitest';
import { validateCapability } from './validate.js';
import type { Capability, TargetDescriptor } from './index.js';

function textTarget(text: string, description = text): TargetDescriptor {
  return { description, frame: [], locators: [{ strategy: { kind: 'text', text }, confidence: 0.8, source: 'recorded' }] };
}

/** A target identifiable ONLY by a css locator -- no role/label/text/relative locator at all --
 *  so `targetTexts()` (role/label/text/relative + snapshot) contributes nothing; only its
 *  `description` (always present, `NonEmpty`) carries any human-readable text. */
function cssOnlyTarget(selector: string, description: string): TargetDescriptor {
  return { description, frame: [], locators: [{ strategy: { kind: 'css', selector }, confidence: 0.3, source: 'recorded' }] };
}

function baseCapability(): Capability {
  return {
    schemaVersion: '1.0',
    id: 'redteam-fixture',
    version: '1.0.0',
    name: 'Validation fixture',
    description: 'Minimal capability used only by these schema tests.',
    app: { vendor: 'Acme', product: 'Core', surface: 'web', entryUrl: '{baseUrl}/login' },
    status: 'approved',
    riskLevel: 'read',
    inputs: {},
    outputs: {},
    steps: [
      { id: 's01', name: 'Navigate to login', action: { type: 'navigate', url: '{baseUrl}/login' }, risk: 'read' },
      { id: 's02', name: 'Click search', action: { type: 'click', target: textTarget('Search') }, risk: 'read' },
    ],
    success: { condition: { kind: 'text_visible', text: 'ok' }, description: 'ok' },
    businessOutcomes: [],
    recoveryRules: [],
    provenance: { discoveredAt: '2024-01-01T00:00:00Z', discoveryRunId: 'redteam-run', recordedBy: 'human' },
  };
}

function issueCodes(result: ReturnType<typeof validateCapability>): string[] {
  return result.ok ? [] : result.issues.map((i) => i.code);
}

// ---------------------------------------------------------------------------------------------
// input validation
// ---------------------------------------------------------------------------------------------

describe('InputSpec.pattern must itself be a compilable regex (rejected at load time)', () => {
  it('an invalid InputSpec.pattern fails validateCapability with invalid_regex, before any invocation', () => {
    const cap = structuredClone(baseCapability());
    cap.inputs.memberId = { type: 'string', description: 'Member ID', required: true, sensitive: false, pattern: '[unterminated' };
    const result = validateCapability(cap);
    expect(result.ok).toBe(false);
    expect(issueCodes(result)).toContain('invalid_regex');
  });
});

describe('a sensitive input must not carry a literal example value', () => {
  it('sensitive:true with an example value fails validateCapability', () => {
    const cap = structuredClone(baseCapability());
    cap.inputs.ssn = { type: 'string', description: 'Member SSN', required: true, sensitive: true, example: '123-45-6789' };
    const result = validateCapability(cap);
    expect(result.ok).toBe(false);
    expect(issueCodes(result)).toContain('sensitive_input_has_example');
  });

  it('sensitive:true with no example, or a non-sensitive input with an example, both pass', () => {
    const cap = structuredClone(baseCapability());
    cap.inputs.ssn = { type: 'string', description: 'Member SSN', required: true, sensitive: true };
    cap.inputs.memberId = { type: 'string', description: 'Member ID', required: true, sensitive: false, example: '12345' };
    expect(validateCapability(cap).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// recovery rule irreversible actions
// ---------------------------------------------------------------------------------------------

describe('a recovery rule cannot perform (or read as) an irreversible action', () => {
  it('a plain text-locator "Confirm Transfer" recovery action is rejected', () => {
    const cap = structuredClone(baseCapability());
    cap.recoveryRules = [
      {
        name: 'dismiss_notice',
        description: 'test recovery rule',
        trigger: { kind: 'text_visible', text: 'System Maintenance Notice' },
        actions: [{ type: 'click', target: textTarget('Confirm Transfer') }],
        maxAttempts: 1,
      },
    ];
    const result = validateCapability(cap);
    expect(result.ok).toBe(false);
    expect(issueCodes(result)).toContain('irreversible_recovery_action');
  });

  it('a css-only target whose readable `description` says "Confirm transfer" is rejected, even though targetTexts() ignores css locators and description', () => {
    const cap = structuredClone(baseCapability());
    cap.recoveryRules = [
      {
        name: 'dismiss_notice',
        description: 'test recovery rule',
        trigger: { kind: 'text_visible', text: 'System Maintenance Notice' },
        actions: [{ type: 'click', target: cssOnlyTarget('#confirmBtn', 'Confirm transfer button (test)') }],
        maxAttempts: 1,
      },
    ];
    const result = validateCapability(cap);
    expect(result.ok).toBe(false);
    expect(issueCodes(result)).toContain('irreversible_recovery_action');
  });

  it('a css-only target with an innocuous description passes (no false positive)', () => {
    const cap = structuredClone(baseCapability());
    cap.recoveryRules = [
      {
        name: 'dismiss_notice',
        description: 'test recovery rule',
        trigger: { kind: 'text_visible', text: 'System Maintenance Notice' },
        actions: [{ type: 'click', target: cssOnlyTarget('#okBtn', 'OK button on the maintenance interstitial') }],
        maxAttempts: 1,
      },
    ];
    expect(validateCapability(cap).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// tenant override irreversible injection
// ---------------------------------------------------------------------------------------------

describe('a tenant override cannot smuggle an irreversible step past an already-approved capability', () => {
  it('an extraStep declared risk:"irreversible" on an approved capability is rejected', () => {
    const cap = structuredClone(baseCapability());
    expect(cap.status).toBe('approved');
    cap.overrides = [
      {
        tenant: 'tenant-b',
        stepPatches: [],
        extraSteps: [
          {
            afterStepId: 's02',
            step: { id: 'sConfirm', name: 'Confirm transfer', risk: 'irreversible', action: { type: 'click', target: textTarget('OK') } },
          },
        ],
      },
    ];
    const result = validateCapability(cap);
    expect(result.ok).toBe(false);
    expect(issueCodes(result)).toContain('override_irreversible_change');
  });

  it('an extraStep mislabelled risk:"read" whose target text says "Confirm Transfer" is still rejected (cannot dodge the check by mislabelling)', () => {
    const cap = structuredClone(baseCapability());
    cap.overrides = [
      {
        tenant: 'tenant-b',
        stepPatches: [],
        extraSteps: [
          {
            afterStepId: 's02',
            step: { id: 'sConfirm', name: 'Confirm transfer', risk: 'read', action: { type: 'click', target: textTarget('Confirm Transfer') } },
          },
        ],
      },
    ];
    const result = validateCapability(cap);
    expect(result.ok).toBe(false);
    expect(issueCodes(result)).toContain('override_irreversible_change');
  });

  it('a stepPatch retargeting an existing step onto a css-only "Confirm transfer" control is rejected', () => {
    const cap = structuredClone(baseCapability());
    cap.overrides = [
      {
        tenant: 'tenant-b',
        stepPatches: [{ stepId: 's02', target: cssOnlyTarget('#confirmBtn', 'Confirm transfer button (test)') }],
      },
    ];
    const result = validateCapability(cap);
    expect(result.ok).toBe(false);
    expect(issueCodes(result)).toContain('override_irreversible_change');
  });

  it('an extraStep with an ordinary read/reversible action and an innocuous target passes', () => {
    const cap = structuredClone(baseCapability());
    cap.overrides = [
      {
        tenant: 'tenant-b',
        stepPatches: [],
        extraSteps: [
          {
            afterStepId: 's02',
            step: { id: 'sWait', name: 'Wait for results', risk: 'read', action: { type: 'wait', condition: { kind: 'text_visible', text: 'results' } } },
          },
        ],
      },
    ];
    expect(validateCapability(cap).ok).toBe(true);
  });
});

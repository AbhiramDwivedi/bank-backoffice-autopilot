/**
 * End-to-end hardening tests, through the public replay API (`replayCapability` via `runReplay`).
 *
 * - A `url_matches` postcondition templated with an unconstrained input must not let an
 *   attacker-controlled value broaden the match onto a different real page (here: a different
 *   account than the one requested -- a confused-deputy risk for a financial-data runtime), and
 *   must not crash the run with an uncaught exception even when the raw value would make the
 *   pattern syntactically invalid regex.
 *
 * - A recovery rule that would click a "Confirm Transfer"-style control is refused: since
 *   `validateCapability` runs before any surface call, a capability carrying such a rule never
 *   loads at all, and zero surface interaction ever happens.
 *
 * - A tenant override cannot inject an irreversible extra step into an already-`approved`
 *   capability: the same "validate before touching the surface" guarantee applies to the
 *   overridden (effective) capability, so the attempt is refused with zero surface calls.
 */
import { describe, expect, it } from 'vitest';
import { createCuCoreSurface } from '../surface/fake-scenarios/cu-core.js';
import { el, FakeSurface, scenario } from '../surface/index.js';
import type { Capability, TargetDescriptor } from '../schema/index.js';
import { loadExample, makeFakeClock, runReplay, wrapSurface } from './test-helpers.js';

function textTarget(text: string, description = text): TargetDescriptor {
  return { description, frame: [], locators: [{ strategy: { kind: 'text', text }, confidence: 0.8, source: 'recorded' }] };
}

// ---------------------------------------------------------------------------------------------
// url_matches regex injection, end to end
// ---------------------------------------------------------------------------------------------

describe('a malicious accountId bound into a url_matches postcondition', () => {
  const BASE = 'http://localhost:4173';

  /** Two screens: clicking "Go" ALWAYS lands on account 99999, no matter what accountId was
   *  requested (there is no real per-account routing in this fixture -- the point is solely to
   *  check what the postcondition does once it's on a page for a DIFFERENT account). */
  function buildScenario() {
    return scenario()
      .screen('start', {
        url: `${BASE}/start`,
        title: 'Start',
        elements: [el({ id: 'go', role: 'button', name: 'Go', text: 'Go', tag: 'button', bbox: { x: 0, y: 0, w: 10, h: 10 } })],
      })
      .on('click', { targetId: 'go' })
      .goto('account-99999')
      .onAny('navigate', { url: `${BASE}/start` })
      .goto('start')
      .screen('account-99999', {
        url: `${BASE}/accounts/99999`,
        title: 'Account 99999',
        text: ['Account overview'],
        elements: [],
      })
      .build();
  }

  function buildCapability(): Capability {
    return {
      schemaVersion: '1.0',
      id: 'redteam-t1-fixture',
      version: '1.0.0',
      name: 'Injection fixture',
      description: 'Minimal capability used only by this test.',
      app: { vendor: 'Acme', product: 'Core', surface: 'web', entryUrl: '{baseUrl}/start' },
      status: 'approved',
      riskLevel: 'read',
      inputs: {
        // Deliberately no `pattern`: a free-text field is a realistic case (not every input is a
        // 5-digit member id), and this is exactly the case the fix must hold up under.
        accountId: { type: 'string', description: 'account id (deliberately unconstrained)', required: true, sensitive: false },
      },
      outputs: {},
      steps: [
        { id: 's01', name: 'Navigate to start', action: { type: 'navigate', url: '{baseUrl}/start' }, risk: 'read' },
        {
          id: 's02',
          name: 'Click go',
          action: { type: 'click', target: textTarget('Go') },
          risk: 'read',
          postcondition: { kind: 'url_matches', pattern: '/accounts/{input.accountId}$' },
        },
      ],
      success: { condition: { kind: 'text_visible', text: 'Account overview' }, description: 'reached an account page' },
      businessOutcomes: [],
      recoveryRules: [],
      provenance: { discoveredAt: '2024-01-01T00:00:00Z', discoveryRunId: 'redteam-run', recordedBy: 'human' },
    };
  }

  const MALICIOUS_VALUES = ['.*', '12345|.*', '(', '$', '\\', '[a-z]+'];

  it.each(MALICIOUS_VALUES)(
    'accountId %j: never a false success (must not read account 99999 as if it were the requested account), and never an uncaught crash',
    async (accountId) => {
      const clock = makeFakeClock();
      const surface = new FakeSurface(buildScenario(), { clock });
      const cap = buildCapability();

      // The whole point: this must resolve to a well-formed ReplayResult, not reject/throw.
      const { result } = await runReplay({ capability: cap, inputs: { accountId }, surface, clock });

      // Guarantee (a): a malicious accountId must never be treated as matching the expected
      // account when the page actually shows a different one (99999). It must NOT be `success`.
      expect(result.kind).not.toBe('success');
      expect(result.kind).toBe('hard_failure');
      if (result.kind === 'hard_failure') {
        // Guarantee (b): a structured failure, specifically the postcondition not holding --
        // never `internal` from an uncaught regex SyntaxError.
        expect(result.code).toBe('checkpoint_failed');
      }
    },
  );

  it('a legitimate accountId (matching the actual page) still succeeds -- the fix does not break real usage', async () => {
    const clock = makeFakeClock();
    const surface = new FakeSurface(buildScenario(), { clock });
    const cap = buildCapability();

    const { result } = await runReplay({ capability: cap, inputs: { accountId: '99999' }, surface, clock });

    expect(result.kind).toBe('success');
  });
});

// ---------------------------------------------------------------------------------------------
// recovery rule irreversible action, end to end
// ---------------------------------------------------------------------------------------------

describe('a recovery rule that would click "Confirm Transfer" is refused', () => {
  it('the capability never loads (validateCapability runs before any surface call); zero surface interaction', async () => {
    const cap = structuredClone(loadExample());
    cap.recoveryRules.push({
      name: 'malicious_recovery',
      description: 'test-only: a recovery rule that would click an irreversible-looking control',
      trigger: { kind: 'text_visible', text: 'Member Search', frame: [{ name: 'main' }] },
      actions: [{ type: 'click', target: textTarget('Confirm Transfer') }],
      maxAttempts: 1,
    });

    const clock = makeFakeClock();
    const surface = createCuCoreSurface({ clock });
    const wrapper = wrapSurface(surface);

    const { result } = await runReplay({ capability: cap, surface: wrapper.surface, clock });

    expect(result.kind).toBe('hard_failure');
    if (result.kind === 'hard_failure') {
      expect(result.code).toBe('internal'); // rejected by validateCapability, not a runtime policy check
      expect(result.observed).toContain('irreversible_recovery_action');
    }
    expect(wrapper.totalCalls()).toBe(0);
    expect(surface.actionLog()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// tenant override irreversible injection, end to end
// ---------------------------------------------------------------------------------------------

describe('a tenant override cannot inject an irreversible extra step into an approved capability', () => {
  it('the overridden capability fails re-validation; refused before any surface call', async () => {
    const cap = structuredClone(loadExample());
    expect(cap.status).toBe('approved'); // override injection must be refused even though the capability is already approved

    cap.overrides = [
      {
        tenant: 'evil-tenant',
        stepPatches: [],
        extraSteps: [
          {
            afterStepId: 's06',
            step: {
              id: 'sConfirmTransfer',
              name: 'Confirm transfer (test-only, should never run)',
              risk: 'irreversible',
              action: { type: 'click', target: textTarget('OK') },
            },
          },
        ],
      },
    ];

    const clock = makeFakeClock();
    const surface = createCuCoreSurface({ clock });
    const wrapper = wrapSurface(surface);

    const { result } = await runReplay({ capability: cap, tenant: 'evil-tenant', surface: wrapper.surface, clock });

    expect(result.kind).toBe('hard_failure');
    if (result.kind === 'hard_failure') {
      expect(result.code).toBe('internal');
      expect(result.observed).toContain('override_irreversible_change');
    }
    expect(wrapper.totalCalls()).toBe(0);
    expect(surface.actionLog()).toEqual([]);
  });

  it('the same override tenant with only an ordinary (read) extra step runs normally', async () => {
    const cap = structuredClone(loadExample());
    cap.overrides = [
      {
        tenant: 'benign-tenant',
        stepPatches: [],
        extraSteps: [
          {
            afterStepId: 's06',
            step: {
              id: 'sExtraWait',
              name: 'Extra wait step (test only)',
              risk: 'read',
              action: { type: 'wait', condition: { kind: 'text_visible', text: 'record(s) found', frame: [{ name: 'main' }] } },
            },
          },
        ],
      },
    ];

    const { result } = await runReplay({ capability: cap, tenant: 'benign-tenant' });
    expect(result.kind).toBe('success');
  });
});

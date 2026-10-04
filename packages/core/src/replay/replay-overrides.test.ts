/** A tenant override that inserts an extra step runs it in order. */
import { describe, expect, it } from 'vitest';
import { validateCapability } from '../schema/index.js';
import { loadExample, runReplay } from './test-helpers.js';

describe('replay: tenant override extra step', () => {
  it("the extra step's id appears in `action` events in order, and the patch is logged", async () => {
    const cap = structuredClone(loadExample());
    cap.overrides = [
      {
        tenant: 'extra-step-tenant',
        stepPatches: [],
        extraSteps: [
          {
            afterStepId: 's06',
            step: {
              id: 'sExtraWait',
              name: 'Extra wait step (test only)',
              risk: 'read',
              timeoutMs: 2000,
              action: { type: 'wait', condition: { kind: 'text_visible', text: 'record(s) found', frame: [{ name: 'main' }] } },
            },
          },
        ],
      },
    ];
    const validated = validateCapability(cap);
    if (!validated.ok) throw new Error(JSON.stringify(validated.issues));

    const { result, events } = await runReplay({ capability: validated.capability, tenant: 'extra-step-tenant' });

    expect(result.kind).toBe('success');

    const actionStepIds = events.filter((e) => e.kind === 'action').map((e) => e.stepId);
    const i06 = actionStepIds.indexOf('s06');
    const iExtra = actionStepIds.indexOf('sExtraWait');
    const i07 = actionStepIds.indexOf('s07');
    expect(i06).toBeGreaterThanOrEqual(0);
    expect(iExtra).toBeGreaterThan(i06);
    expect(i07).toBeGreaterThan(iExtra);

    const overrideEvent = events.find((e) => e.kind === 'observation' && (e.data as { override?: unknown }).override !== undefined);
    expect(overrideEvent).toBeDefined();
    const applied = (
      overrideEvent?.data as { override: { tenant: string; patchedSteps: string[]; extraSteps: { stepId: string; afterStepId: string }[] } }
    ).override;
    expect(applied.tenant).toBe('extra-step-tenant');
    expect(applied.extraSteps).toEqual([{ stepId: 'sExtraWait', afterStepId: 's06' }]);
  });
});

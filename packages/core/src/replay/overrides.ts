/**
 * Applies a tenant's TenantOverride (step patches, extra steps, entry URL rewrite) to a base
 * Capability, producing an effective, tenant-specific capability that should still pass
 * `validateCapability`. Pure: never mutates the input `cap`. See docs/design/replay.md
 * ("Tenant overrides ... applied before execution") and packages/core/src/replay/types.ts.
 */
import { RISK_ORDER } from '../schema/index.js';
import type { Action, Capability, Step } from '../schema/index.js';
import type { AppliedOverride } from './types.js';

/**
 * Applies the override matching `tenant` (if any) to `cap`: patches existing steps, inserts
 * extra steps, and optionally rewrites the entry URL. Returns the original `cap` unchanged (with
 * `applied` undefined) when `tenant` is undefined or has no matching override. Throws if a patch
 * or extra step references an unknown step id, or sets a target patch on an action with no
 * target; `validateCapability` is expected to have already caught these cases.
 */
export function applyTenantOverride(cap: Capability, tenant: string | undefined): { capability: Capability; applied?: AppliedOverride } {
  if (tenant === undefined) return { capability: cap };

  const override = (cap.overrides ?? []).find((o) => o.tenant === tenant);
  if (!override) return { capability: cap };

  // Never mutate the input; work on a deep clone from here on.
  const cloned: Capability = structuredClone(cap);
  const originalEntryUrl = cap.app.entryUrl;

  const patchedSteps: string[] = [];

  for (const patch of override.stepPatches) {
    const step = cloned.steps.find((s) => s.id === patch.stepId);
    if (!step) {
      // validateCapability (unknown_step_ref) should have caught this already.
      throw new Error(`tenant override "${tenant}" patches unknown step id "${patch.stepId}"`);
    }

    if (patch.target !== undefined) {
      if (!('target' in step.action)) {
        throw new Error(
          `tenant override "${tenant}" sets a target patch for step "${patch.stepId}", but its action type ` +
            `"${step.action.type}" has no target`,
        );
      }
      step.action.target = patch.target;
    }

    if (patch.action !== undefined) {
      if (patch.action.type !== undefined && patch.action.type !== step.action.type) {
        // validateCapability (override_action_type_mismatch) should have caught this already.
        throw new Error(
          `tenant override "${tenant}" patches step "${patch.stepId}" action type from "${step.action.type}" to "${patch.action.type}"`,
        );
      }
      step.action = { ...step.action, ...patch.action } as Action;
    }

    if (!patchedSteps.includes(patch.stepId)) patchedSteps.push(patch.stepId);
  }

  const extraSteps = override.extraSteps ?? [];

  // Every afterStepId must name a base step (validateCapability's unknown_step_ref); extra steps
  // sharing an afterStepId are inserted after it in declaration order.
  const baseIds = new Set(cloned.steps.map((s) => s.id));
  for (const es of extraSteps) {
    if (!baseIds.has(es.afterStepId)) {
      throw new Error(`tenant override "${tenant}" extra step "${es.step.id}" references unknown afterStepId "${es.afterStepId}"`);
    }
  }

  const insertionsAfter = new Map<string, Step[]>();
  for (const es of extraSteps) {
    const list = insertionsAfter.get(es.afterStepId) ?? [];
    list.push(es.step);
    insertionsAfter.set(es.afterStepId, list);
  }

  const newSteps: Step[] = [];
  for (const base of cloned.steps) {
    newSteps.push(base, ...(insertionsAfter.get(base.id) ?? []));
  }
  cloned.steps = newSteps;

  let entryUrl: string | undefined;
  if (override.entryUrl !== undefined) {
    entryUrl = override.entryUrl;
    cloned.app.entryUrl = override.entryUrl;
    for (const step of cloned.steps) {
      if (step.action.type === 'navigate' && step.action.url === originalEntryUrl) {
        step.action.url = override.entryUrl;
      }
    }
  }

  cloned.app.tenant = tenant;
  delete cloned.overrides;

  // An inserted extra step may be riskier than any base step; keep riskLevel = max(step.risk)
  // (validateCapability's risk_level_mismatch check) true for the effective capability.
  for (const es of extraSteps) {
    if (RISK_ORDER[es.step.risk] > RISK_ORDER[cloned.riskLevel]) {
      cloned.riskLevel = es.step.risk;
    }
  }

  const applied: AppliedOverride = {
    tenant,
    patchedSteps,
    extraSteps: extraSteps.map((es) => ({ stepId: es.step.id, afterStepId: es.afterStepId })),
    ...(entryUrl !== undefined ? { entryUrl } : {}),
  };

  return { capability: cloned, applied };
}

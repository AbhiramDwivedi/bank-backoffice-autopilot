/**
 * Pure capability rewrites the optimizer composes: the static collapse of redundant repeats,
 * dropping postconditions, removing a step, and the bookkeeping around them (protected step ids,
 * risk level, trial copies). None of these touch a surface.
 *
 * Step ids are never renumbered: a removed step leaves a gap (`s03`, `s05`). Ids are referenced by
 * business outcomes, tenant overrides, run evidence and approval notes, and a renumbering would
 * silently re-point every one of them.
 */
import {
  RISK_ORDER,
  collectInputPlaceholders,
  isRedundantRepeat,
  type Action,
  type Capability,
  type Condition,
  type RiskClass,
  type Step,
} from '../schema/index.js';
import type { KeptReason, OptimizeChange } from './types.js';

/**
 * Step ids other parts of the capability point at, with the reason: tenant override `stepPatches`
 * and `extraSteps` anchors, and business-outcome `afterSteps`. The optimizer never removes or
 * collapses these: an override is not trialled (a trial runs the base capability on one tenant),
 * and an outcome's eligibility window is not exercised by a success-path trial.
 */
export function protectedStepIds(cap: Capability): Map<string, KeptReason> {
  const out = new Map<string, KeptReason>();
  for (const o of cap.overrides ?? []) {
    for (const p of o.stepPatches) out.set(p.stepId, 'override_reference');
    for (const x of o.extraSteps ?? []) out.set(x.afterStepId, 'override_reference');
  }
  for (const bo of cap.businessOutcomes) {
    for (const id of bo.afterSteps ?? []) if (!out.has(id)) out.set(id, 'outcome_reference');
  }
  return out;
}

/** The highest declared step risk (what `riskLevel` must equal). */
export function maxRisk(steps: readonly Step[]): RiskClass {
  let max: RiskClass = 'read';
  for (const s of steps) if (RISK_ORDER[s.risk] > RISK_ORDER[max]) max = s.risk;
  return max;
}

/** A deep copy (capabilities are plain JSON). */
export function cloneCapability(cap: Capability): Capability {
  return structuredClone(cap);
}

/** `cap` with `steps` replaced and `riskLevel` recomputed to match. */
export function withSteps(cap: Capability, steps: Step[]): Capability {
  return { ...cap, steps, riskLevel: maxRisk(steps) };
}

/** `cap` without step `stepId` (no renumbering). */
export function removeStep(cap: Capability, stepId: string): Capability {
  return withSteps(
    cap,
    cap.steps.filter((s) => s.id !== stepId),
  );
}

/** `cap` with the postconditions of `stepIds` removed. */
export function dropPostconditions(cap: Capability, stepIds: ReadonlySet<string>): Capability {
  return withSteps(
    cap,
    cap.steps.map((s) => {
      if (!stepIds.has(s.id) || s.postcondition === undefined) return s;
      const rest: Step = { ...s };
      delete rest.postcondition;
      return rest;
    }),
  );
}

/**
 * Collapse rewrite: folds each run of consecutive redundant repeats (see `isRedundantRepeat` in
 * schema/step-equivalence.ts) into the run's FIRST step, which takes over the run's postcondition
 * when it has none of its own. The first step survives, rather than the one that happened to carry
 * the checkpoint, so the survivor runs from exactly the page state the original run's first copy
 * ran from -- which is what lets the vacuity probe observe the survivor's merged checkpoint in a
 * replay of the unmodified capability. A run touching a protected step id is left alone. This is a
 * candidate, not a safe rewrite: a recorded retry is evidence the first write may not have stuck
 * (a late script clearing the field), so the collapse is only kept if replays confirm it.
 */
export function collapseRedundantRepeats(cap: Capability, protectedIds: ReadonlyMap<string, KeptReason>): { capability: Capability; changes: OptimizeChange[] } {
  const steps = cap.steps;
  const out: Step[] = [];
  const changes: OptimizeChange[] = [];
  let i = 0;
  while (i < steps.length) {
    let survivor: Step = steps[i]!;
    let j = i + 1;
    while (j < steps.length && !protectedIds.has(survivor.id) && !protectedIds.has(steps[j]!.id) && isRedundantRepeat(survivor, steps[j]!)) {
      const next = steps[j]!;
      if (survivor.postcondition === undefined && next.postcondition !== undefined) survivor = { ...survivor, postcondition: next.postcondition };
      changes.push({ kind: 'collapsed_repeat', stepId: next.id, into: survivor.id, name: next.name });
      j += 1;
    }
    out.push(survivor);
    i = j;
  }
  return { capability: changes.length > 0 ? withSteps(cap, out) : cap, changes };
}

/** For each declared output, the id of the LAST step that extracts it (the one whose value replay
 *  returns). Removing that step can only lose or change the output, so it is never tried. */
export function lastExtractStepIds(cap: Capability): Set<string> {
  const last = new Map<string, string>();
  for (const s of cap.steps) if (s.action.type === 'extract') last.set(s.action.output, s.id);
  return new Set(last.values());
}

/** The input names an action consumes: a `{input.x}` placeholder anywhere in it (URL, target,
 *  literal value), or an `input` value binding. */
export function inputsConsumedBy(action: Action): Set<string> {
  const names = collectInputPlaceholders(action);
  if ((action.type === 'type' || action.type === 'select') && action.value.kind === 'input') names.add(action.value.name);
  return names;
}

/** For each declared input, the id of the LAST step that consumes it. Removing that step can only
 *  make the capability stop using the input (a lookup that no longer looks anything up), which an
 *  output-equality check on one input set cannot always see -- so it is never tried. */
export function lastInputUseStepIds(cap: Capability): Set<string> {
  const last = new Map<string, string>();
  const declared = new Set(Object.keys(cap.inputs));
  for (const s of cap.steps) for (const name of inputsConsumedBy(s.action)) if (declared.has(name)) last.set(name, s.id);
  return new Set(last.values());
}

/** Step ids any tenant override references (patches or extra-step anchors). */
export function overrideReferencedIds(cap: Capability): Set<string> {
  const out = new Set<string>();
  for (const o of cap.overrides ?? []) {
    for (const p of o.stepPatches) out.add(p.stepId);
    for (const x of o.extraSteps ?? []) out.add(x.afterStepId);
  }
  return out;
}

/** `x.y.z` of a semver string (prerelease/build dropped). */
export function coreVersion(version: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : version;
}

/** '1.0.1' -> '1.0.2' (prerelease/build dropped). */
export function bumpPatch(version: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!m) return version;
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

/**
 * The copy a trial replays: `status: 'draft'` (an irreversible-flagged action then fails the
 * approval gate instead of executing) and version `<x.y.z>-optimize.<n>`, so no trial's
 * `result.json` can ever be taken as replay evidence for approving a real version.
 */
export function trialCopy(cap: Capability, baseVersion: string, n: number): Capability {
  return { ...cloneCapability(cap), status: 'draft', version: `${coreVersion(baseVersion)}-optimize.${n}` };
}

/** Compact, single-line rendering of a condition for reports. */
export function describeCondition(c: Condition): string {
  switch (c.kind) {
    case 'text_visible':
      return `text "${c.text}" visible`;
    case 'text_absent':
      return `text "${c.text}" absent`;
    case 'element_visible':
      return `element "${c.target.description}" visible`;
    case 'element_absent':
      return `element "${c.target.description}" absent`;
    case 'url_matches':
      return `url matches /${c.pattern}/`;
    case 'dialog_open':
      return 'dialog open';
    case 'all':
      return `all of [${c.of.map(describeCondition).join(', ')}]`;
    case 'any':
      return `any of [${c.of.map(describeCondition).join(', ')}]`;
    case 'not':
      return `not (${describeCondition(c.of)})`;
  }
}

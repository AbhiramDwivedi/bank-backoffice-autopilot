/**
 * The vacuity probe: a `beforeStep` hook (replay's observational per-step hook) that checks, for
 * selected steps, whether a given condition ALREADY holds immediately before the step acts.
 *
 * A postcondition that held before its step proves nothing about the step: it would have passed
 * had the step silently done nothing. It does not settle the page either: replay's postcondition
 * wait returns at once when its condition already holds, so it never waited for anything. Such a
 * checkpoint is vacuous, and dropping it loses neither detection nor settling -- on the run that was
 * observed. Observations are ANDed across attempts: a condition is reported as held only if it held
 * every time the step was about to act.
 */
import type { Condition } from '../schema/index.js';
import type { BeforeStepHook } from '../replay/index.js';

/** A probe hook plus what it saw. */
export interface BeforeStepProbe {
  hook: BeforeStepHook;
  /** stepId -> whether its condition held before the step every time it was about to act. A step
   *  that never ran (the trial ended earlier) is absent. */
  results(): Map<string, boolean>;
}

/** Builds a probe that checks `conditions.get(step.id)` before each matching step acts. */
export function createBeforeStepProbe(conditions: ReadonlyMap<string, Condition>): BeforeStepProbe {
  const seen = new Map<string, boolean>();
  const hook: BeforeStepHook = async ({ step, check }) => {
    const condition = conditions.get(step.id);
    if (condition === undefined) return;
    const held = await check(condition);
    seen.set(step.id, (seen.get(step.id) ?? true) && held);
  };
  return { hook, results: () => new Map(seen) };
}

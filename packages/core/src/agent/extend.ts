/**
 * Extend mode: probes an already-discovered capability for exceptional outcomes and merges them
 * in without touching the recorded steps.
 */
import type { BusinessOutcome, Capability, Step } from '../schema/index.js';

/** '1.0.0' -> '1.1.0', '1.2.3' -> '1.3.0', prerelease/build dropped. */
export function bumpMinor(version: string): string {
  const m = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) throw new Error(`bumpMinor: not a valid semver version: ${version}`);
  const major = m[1]!;
  const minor = Number(m[2]!);
  return `${major}.${minor + 1}.0`;
}

/** Match key for step-identity comparison: action.type + canonical target description, or
 * navigate url / press key when the action has no target. undefined when neither applies
 * (wait / dismiss_dialog / switch_frame). */
function stepMatchKey(step: Step): string | undefined {
  const a = step.action;
  switch (a.type) {
    case 'navigate':
      return `navigate:${a.url}`;
    case 'press':
      return `press:${a.key}`;
    case 'click':
    case 'type':
    case 'select':
    case 'extract':
      return `${a.type}:${a.target.description}`;
    case 'wait':
    case 'dismiss_dialog':
    case 'switch_frame':
      return undefined;
  }
}

/**
 * Index-mapping: find the existing step matching newSteps[newIndex] by action.type + canonical
 * target description (or navigate url / press key when no target); fallback: existing step at
 * the same index; else the last existing step. Returns its id.
 */
export function mapStepId(existing: readonly Step[], newSteps: readonly Step[], newStepId: string): string | undefined {
  if (existing.length === 0) return undefined;

  const newIndex = newSteps.findIndex((s) => s.id === newStepId);
  const newStep = newIndex >= 0 ? newSteps[newIndex] : undefined;

  if (newStep) {
    const key = stepMatchKey(newStep);
    if (key !== undefined) {
      const match = existing.find((s) => stepMatchKey(s) === key);
      if (match) return match.id;
    }
  }

  if (newIndex >= 0 && newIndex < existing.length) return existing[newIndex]!.id;
  return existing[existing.length - 1]!.id;
}

/** The steps and outcomes discovered by an extend-mode run, for {@link mergeOutcomes}. */
export interface ExtendRun {
  steps: readonly Step[];
  outcomes: readonly BusinessOutcome[];
  runId: string;
  discoveredAt: string;
  model: string;
  notes?: string;
}

function withoutAfterSteps(o: BusinessOutcome): BusinessOutcome {
  const copy = { ...o };
  delete copy.afterSteps;
  return copy;
}

/**
 * existing + outcomes (afterSteps remapped via mapStepId; same-name outcome replaced), steps
 * UNCHANGED, version bumped, provenance.notes appended, recordedBy unchanged unless existing was
 * 'human' (a purely hand-recorded capability gaining LLM-discovered outcomes becomes 'mixed').
 * The new version is always `status: 'draft'`: its added outcomes are unreviewed, so an approval
 * of `existing` never carries over (the note records that when `existing` was approved).
 * Does not mutate `existing`.
 */
export function mergeOutcomes(existing: Capability, run: ExtendRun): Capability {
  const mergedOutcomes = existing.businessOutcomes.slice();
  const addedNames: string[] = [];

  for (const outcome of run.outcomes) {
    let next: BusinessOutcome = outcome;
    if (outcome.afterSteps) {
      const remapped = outcome.afterSteps
        .map((id) => mapStepId(existing.steps, run.steps, id))
        .filter((id): id is string => id !== undefined);
      next = remapped.length > 0 ? { ...outcome, afterSteps: remapped } : withoutAfterSteps(outcome);
    }
    const idx = mergedOutcomes.findIndex((o) => o.name === next.name);
    if (idx >= 0) mergedOutcomes[idx] = next;
    else mergedOutcomes.push(next);
    addedNames.push(next.name);
  }

  const version = bumpMinor(existing.version);
  const recordedBy = existing.provenance.recordedBy === 'human' ? 'mixed' : existing.provenance.recordedBy;

  const mainNote = `Extended by discovery run ${run.runId} at ${run.discoveredAt} (${run.model}): added outcomes ${addedNames.join(', ')}.`;
  const approvalNote =
    existing.status === 'approved' ? ` Version ${existing.version} was approved; that approval does not carry over to ${version}, which needs its own review.` : '';
  const withApproval = `${mainNote}${approvalNote}`;
  const noteLine = run.notes && run.notes.trim() !== '' ? `${withApproval} ${run.notes.trim()}` : withApproval;
  const notes = existing.provenance.notes ? `${existing.provenance.notes}\n${noteLine}` : noteLine;

  return {
    ...existing,
    version,
    status: 'draft',
    businessOutcomes: mergedOutcomes,
    provenance: { ...existing.provenance, recordedBy, notes },
  };
}

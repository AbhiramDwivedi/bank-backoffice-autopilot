/**
 * Human-readable renderings of an {@link OptimizeReport}: the provenance note appended to the
 * optimized draft (what a reviewer sees in the artifact itself) and the short CLI summary. Neither
 * contains an input value, an output value or a secret: only step ids, step names, conditions
 * already present in the artifact, output NAMES and verdicts.
 */
import type { OptimizeChange, OptimizeReport } from './types.js';

function ids(changes: readonly OptimizeChange[], kind: OptimizeChange['kind']): string[] {
  return changes.filter((c) => c.kind === kind).map((c) => c.stepId);
}

function changeClauses(report: OptimizeReport): string[] {
  const clauses: string[] = [];
  const collapsed = report.changes.filter((c): c is Extract<OptimizeChange, { kind: 'collapsed_repeat' }> => c.kind === 'collapsed_repeat');
  if (collapsed.length > 0) {
    clauses.push(`collapsed ${collapsed.map((c) => `${c.stepId} into ${c.into}`).join(', ')} (exact repeats of an idempotent field write)`);
  }
  const dropped = ids(report.changes, 'dropped_vacuous_postcondition');
  if (dropped.length > 0) clauses.push(`dropped the postcondition of ${dropped.join(', ')} (it already held before the step acted, so it could not detect anything)`);
  const removed = ids(report.changes, 'removed_step');
  if (removed.length > 0) clauses.push(`removed ${removed.join(', ')} (the replay succeeded with the same outputs without them)`);
  return clauses;
}

/** The line appended to `provenance.notes` of an optimized draft (only ever written for a
 *  verified result: nothing else is rewritten). */
export function provenanceNote(report: OptimizeReport, source: string, at: Date): string {
  const v = report.verification;
  const parts = [`Optimized by ${source} at ${at.toISOString()} under the operator's read-only declaration: ${changeClauses(report).join('; ') || 'no changes'}.`];
  if (v !== undefined && (v.kept === 'search' || v.kept === 'start')) {
    parts.push(`Verified by ${v.required}/${v.required} consecutive replays with the baseline outputs (tenant: ${report.probedTenant ?? 'base'}).`);
  }
  parts.push(`${report.trialsUsed} trial replay(s). Steps ${report.stepsBefore} -> ${report.stepsAfter}. Draft: needs review and approval.`);
  return parts.join(' ');
}

/** A short multi-line summary for the terminal. */
export function summarizeOptimization(report: OptimizeReport): string[] {
  const lines: string[] = [];
  if (report.stop === 'analysis_only') {
    lines.push(`optimize: ${report.stopDetail ?? 'analysis only'}`);
    const a = report.analysis;
    for (const r of a.redundantRepeats) lines.push(`  - would try collapsing ${r.stepId} into ${r.repeatOf} (exact repeat)`);
    if (a.checkpointsToProbe.length > 0) lines.push(`  - would probe the checkpoints of ${a.checkpointsToProbe.join(', ')} for vacuity`);
    if (a.removalCandidates.length > 0) lines.push(`  - would try removing ${a.removalCandidates.join(', ')}`);
    for (const n of report.notes) lines.push(`optimize: note: ${n}`);
    return lines;
  }
  lines.push(`optimize: steps ${report.stepsBefore} -> ${report.stepsAfter}; trials used ${report.trialsUsed} (removal ${report.removalTrialsUsed}/${report.maxTrials}${report.budgetExhausted ? ', budget exhausted' : ''})`);
  if (report.stopDetail !== undefined) lines.push(`optimize: ${report.stopDetail}`);
  for (const c of report.changes) {
    if (c.kind === 'collapsed_repeat') lines.push(`  - ${c.stepId} "${c.name}": collapsed into ${c.into} (exact repeat of an idempotent field write)`);
    else if (c.kind === 'dropped_vacuous_postcondition') lines.push(`  - ${c.stepId}: dropped vacuous postcondition (${c.condition}; it held before the step acted)`);
    else lines.push(`  - ${c.stepId} "${c.name}": removed (${c.actionType}; replay succeeded with the same outputs without it)`);
  }
  if (report.changes.length === 0) lines.push('  (no changes)');
  const v = report.verification;
  if (v !== undefined) {
    for (const a of v.attempts) {
      lines.push(`optimize: verify ${a.candidate}: ${a.passed}/${v.required} passed${a.failure !== undefined ? ` (${a.failure})` : ''}`);
    }
  }
  for (const n of report.notes) lines.push(`optimize: note: ${n}`);
  return lines;
}

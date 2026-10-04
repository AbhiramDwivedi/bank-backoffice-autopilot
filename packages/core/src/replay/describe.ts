/**
 * describe.ts -- describeResult, summarizeLocatorDrift, summarizeStability. One human-readable
 * paragraph per ReplayResult, and a stability report over a `replay --times N` series, for the
 * CLI.
 *
 * Design choice: the trailing "Recoveries: ..." and "Locator drift: ..." sentences are appended
 * for every result kind, not only `success`. Both `recoveries` and `locatorReport` live on
 * `ReplayBase`, so they exist regardless of how the run ended, and knowing which recovery rules
 * fired / whether locators drifted is exactly as useful context on a failure or an escalation as
 * it is on a success.
 */
import type { EscalatedOutcome, FailureCode, LocatorReportEntry, LocatorStrategyKind, ReplayResult, ReplayResultKind } from '../schema/index.js';

const TRUNCATE_MAX = 300;

/** Aggregate view of how far locator resolution had to fall back across a set of resolutions. */
export interface LocatorDriftSummary {
  total: number;
  drifted: number;
  maxDepth: number;
  byStrategy: Partial<Record<LocatorStrategyKind, { resolved: number; drifted: number }>>;
  driftedSteps: string[];
}

/** Counts locator resolutions per strategy kind; `drifted` = entries with `fallbackDepth > 0`. */
export function summarizeLocatorDrift(report: LocatorReportEntry[]): LocatorDriftSummary {
  const byStrategy: Partial<Record<LocatorStrategyKind, { resolved: number; drifted: number }>> = {};
  const driftedSteps: string[] = [];
  const seenSteps = new Set<string>();
  let drifted = 0;
  let maxDepth = 0;

  for (const entry of report) {
    const bucket = byStrategy[entry.strategyKind] ?? { resolved: 0, drifted: 0 };
    bucket.resolved += 1;
    if (entry.fallbackDepth > 0) {
      bucket.drifted += 1;
      drifted += 1;
      if (entry.fallbackDepth > maxDepth) maxDepth = entry.fallbackDepth;
      if (!seenSteps.has(entry.stepId)) {
        seenSteps.add(entry.stepId);
        driftedSteps.push(entry.stepId);
      }
    }
    byStrategy[entry.strategyKind] = bucket;
  }

  return { total: report.length, drifted, maxDepth, byStrategy, driftedSteps };
}

/** Escalated runs broken down three ways; each breakdown sums to {@link StabilitySummary.escalations}. */
export interface EscalationBreakdown {
  /** Keyed by the intervention reason (`unexpected_dialog`, `unrecoverable_condition`, ...). */
  reason: Record<string, number>;
  /** Keyed by resolution (`resumed_success`, `resumed_failed`, `abandoned`), or `pending` when absent. */
  resolution: Record<string, number>;
  /**
   * Keyed by what the run produced after hand-back: `success`, `business_outcome:<name>`,
   * `hard_failure:<FailureCode>`, or `none` when the run never continued.
   */
  outcome: Record<string, number>;
}

/** How often one recovery rule fired across a series. */
export interface RecoveryCount {
  /** Total firings across every run. */
  fired: number;
  /** Runs in which it fired at least once. */
  runs: number;
}

/** Aggregate outcome and locator-drift counts across a `replay --times N` series. */
export interface StabilitySummary {
  runs: number;
  successes: number;
  /** Count of `business_outcome` runs, keyed by outcome name. */
  businessOutcomes: Record<string, number>;
  /** Count of `hard_failure` runs, keyed by `FailureCode`. */
  failures: Record<string, number>;
  escalations: number;
  meanDurationMs: number;
  /** Union across every run: targets that did not resolve at strategy index 0 in ANY run. */
  drift: LocatorDriftSummary;
  /** Count of runs per result kind. Every kind is present, zero included. */
  byKind: Record<ReplayResultKind, number>;
  /** Escalated runs by reason, resolution and underlying outcome. */
  escalationBreakdown: EscalationBreakdown;
  /**
   * Recovery rules that fired, keyed by rule name, plus the engine's own app-error retry under
   * `retry_app_error`. Recoverable conditions (a dismissed notice, a waited-out stall, a transient
   * app error that a retry got past) never become a result kind; this is where a series shows them.
   */
  recoveries: Record<string, RecoveryCount>;
  /** Every locator resolution across the series, counted by fallback depth (`"0"` = first locator). */
  fallbackDepths: Record<string, number>;
  minDurationMs: number;
  maxDurationMs: number;
}

/** The `EscalationBreakdown.outcome` key for one escalated run. */
function escalatedOutcomeKey(outcome: EscalatedOutcome | undefined): string {
  if (outcome === undefined) return 'none';
  switch (outcome.kind) {
    case 'success':
      return 'success';
    case 'business_outcome':
      return `business_outcome:${outcome.name}`;
    case 'hard_failure':
      return `hard_failure:${outcome.code}`;
  }
}

/**
 * A keyed counter with no prototype. Keys come from the artifact (outcome names, recovery rule
 * names are schema `Identifier`s) and from result text, and `__proto__` / `constructor` are legal
 * there: on a plain `{}` they would read inherited members, and `counts.__proto__ = n` would
 * rewrite the object's prototype instead of counting. Serializes to JSON like any object.
 */
function counter<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function bump(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

/**
 * Aggregates a `replay --times N` series into a stability report: outcome counts by kind (and,
 * for business outcomes and hard failures, by name/code; for escalations, by reason, resolution and
 * underlying outcome), which recovery rules fired and in how many runs, the distribution of locator
 * fallback depths, duration mean/min/max, and the union of locator drift across all runs (via
 * `summarizeLocatorDrift` over every run's `locatorReport`, concatenated).
 */
export function summarizeStability(results: ReplayResult[]): StabilitySummary {
  const byKind: Record<ReplayResultKind, number> = { success: 0, business_outcome: 0, hard_failure: 0, escalated: 0 };
  const businessOutcomes = counter<number>();
  const failures = counter<number>();
  const escalationBreakdown: EscalationBreakdown = { reason: counter(), resolution: counter(), outcome: counter() };
  const recoveries = counter<RecoveryCount>();
  const fallbackDepths = counter<number>();
  let totalDurationMs = 0;
  let minDurationMs = Number.POSITIVE_INFINITY;
  let maxDurationMs = 0;
  const allLocatorReports: LocatorReportEntry[] = [];

  for (const result of results) {
    totalDurationMs += result.durationMs;
    minDurationMs = Math.min(minDurationMs, result.durationMs);
    maxDurationMs = Math.max(maxDurationMs, result.durationMs);
    allLocatorReports.push(...result.locatorReport);
    for (const entry of result.locatorReport) bump(fallbackDepths, String(entry.fallbackDepth));
    for (const rule of new Set(result.recoveries)) {
      const count = recoveries[rule] ?? { fired: 0, runs: 0 };
      count.runs += 1;
      count.fired += result.recoveries.filter((r) => r === rule).length;
      recoveries[rule] = count;
    }
    byKind[result.kind] += 1;
    switch (result.kind) {
      case 'success':
        break;
      case 'business_outcome':
        bump(businessOutcomes, result.name);
        break;
      case 'hard_failure':
        bump(failures, result.code);
        break;
      case 'escalated':
        bump(escalationBreakdown.reason, result.reason);
        bump(escalationBreakdown.resolution, result.resolution ?? 'pending');
        bump(escalationBreakdown.outcome, escalatedOutcomeKey(result.outcome));
        break;
    }
  }

  return {
    runs: results.length,
    successes: byKind.success,
    businessOutcomes,
    failures,
    escalations: byKind.escalated,
    meanDurationMs: results.length > 0 ? totalDurationMs / results.length : 0,
    drift: summarizeLocatorDrift(allLocatorReports),
    byKind,
    escalationBreakdown,
    recoveries,
    fallbackDepths,
    minDurationMs: results.length > 0 ? minDurationMs : 0,
    maxDurationMs,
  };
}

function truncate(s: string): string {
  if (s.length <= TRUNCATE_MAX) return s;
  return `${s.slice(0, TRUNCATE_MAX - 3)}...`;
}

function formatScalar(value: string | number | boolean): string {
  return typeof value === 'string' ? `"${value}"` : String(value);
}

function formatScalarEntries(data: Record<string, string | number | boolean>): string {
  return Object.entries(data)
    .map(([k, v]) => `${k}=${formatScalar(v)}`)
    .join(', ');
}

function formatDuration(durationMs: number): string {
  return (durationMs / 1000).toFixed(1);
}

function formatRecoveries(recoveries: readonly string[]): string {
  return recoveries.length > 0 ? `Recoveries: ${recoveries.join(', ')}.` : 'Recoveries: none.';
}

function formatDrift(report: LocatorReportEntry[]): string {
  const summary = summarizeLocatorDrift(report);
  if (summary.drifted === 0) return 'Locator drift: none.';
  const kinds = Object.keys(summary.byStrategy) as LocatorStrategyKind[];
  const parts = kinds.filter((k) => (summary.byStrategy[k]?.drifted ?? 0) > 0).map((k) => `${k} x${summary.byStrategy[k]!.drifted}`);
  return `Locator drift: ${summary.drifted} of ${summary.total} targets resolved by a fallback (${parts.join(', ')}); review these locators.`;
}

function describeStepFailure(stepId: string | undefined, stepName: string | undefined, code: FailureCode, message: string): string {
  if (stepId === undefined) return `FAILED with ${code}: ${message}.`;
  const namePart = stepName !== undefined ? ` ("${stepName}")` : '';
  return `FAILED at step ${stepId}${namePart} with ${code}: ${message}.`;
}

/** The underlying answer the caller actually got once the human handed control back. */
function describeEscalatedOutcome(outcome: EscalatedOutcome): string {
  switch (outcome.kind) {
    case 'success': {
      const outputsText = formatScalarEntries(outcome.outputs);
      return `Outcome: success${outputsText.length > 0 ? `: ${outputsText}` : ''}.`;
    }
    case 'business_outcome': {
      const dataText = formatScalarEntries(outcome.data);
      return `Outcome: business outcome "${outcome.name}". Data: {${dataText}}.`;
    }
    case 'hard_failure':
      return `Outcome: hard failure ${outcome.code}: ${truncate(outcome.message)}.`;
  }
}

/** One paragraph summarizing a ReplayResult for the CLI. */
export function describeResult(result: ReplayResult): string {
  const header = `Capability ${result.capabilityId}@${result.capabilityVersion}`;
  const durationS = formatDuration(result.durationMs);

  let body: string;
  switch (result.kind) {
    case 'success': {
      const outputsText = formatScalarEntries(result.outputs);
      const outputsPart = outputsText.length > 0 ? `: ${outputsText}` : '';
      body = `succeeded in ${result.stepsExecuted} steps (${durationS}s)${outputsPart}.`;
      break;
    }
    case 'business_outcome': {
      const dataText = formatScalarEntries(result.data);
      const missingPart = result.missing !== undefined && result.missing.length > 0 ? ` Missing returns: ${result.missing.join(', ')}.` : '';
      body = `ended with business outcome "${result.name}" after ${result.stepsExecuted} steps (not a failure). Data: {${dataText}}.${missingPart}`;
      break;
    }
    case 'hard_failure': {
      const evidenceParts: string[] = [];
      if (result.evidence.screenshot !== undefined) evidenceParts.push(result.evidence.screenshot);
      if (result.evidence.dom !== undefined) evidenceParts.push(result.evidence.dom);
      const evidenceSentence = evidenceParts.length > 0 ? ` Evidence: ${evidenceParts.join(', ')}.` : '';
      body =
        `${describeStepFailure(result.stepId, result.stepName, result.code, result.message)} ` +
        `Expected: ${truncate(result.expected)}. Observed: ${truncate(result.observed)}.${evidenceSentence}`;
      break;
    }
    case 'escalated': {
      const stepPart = result.stepId !== undefined ? ` at step ${result.stepId}` : '';
      const resolutionText = result.resolution ?? 'pending';
      const outcomePart = result.outcome !== undefined ? ` ${describeEscalatedOutcome(result.outcome)}` : '';
      body = `escalated to a human${stepPart} (intervention ${result.interventionId}): ${result.reason}. Resolution: ${resolutionText}.${outcomePart}`;
      break;
    }
  }

  return [header, body, formatRecoveries(result.recoveries), formatDrift(result.locatorReport)].join(' ');
}

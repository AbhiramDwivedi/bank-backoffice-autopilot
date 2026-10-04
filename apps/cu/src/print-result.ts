/**
 * Shared stdout formatting for a `ReplayResult`, used by both `replay` and `catalog invoke`,
 * which share the same output/exit-code contract, plus the `replay --times N` stability summary.
 */
import path from 'node:path';
import type { ReplayResult } from '@cu/core/schema';
import { describeResult, type StabilitySummary } from '@cu/core/replay';
import { seriesChaosLines, type SeriesChaos } from './chaos-report.js';

/** What the human summary shows instead of a sensitive output's value. */
export const SENSITIVE_OUTPUT_SHOWN_AS = '<sensitive>';

/**
 * `result` with each output or business-outcome return named in `sensitive` shown as
 * {@link SENSITIVE_OUTPUT_SHOWN_AS}: for the human summary, which lands in scrollback and CI logs.
 */
export function withSensitiveOutputsHidden(result: ReplayResult, sensitive: ReadonlySet<string>): ReplayResult {
  if (sensitive.size === 0) return result;
  const hide = (values: Record<string, string | number | boolean>): Record<string, string | number | boolean> =>
    Object.fromEntries(Object.entries(values).map(([k, v]) => [k, sensitive.has(k) ? SENSITIVE_OUTPUT_SHOWN_AS : v]));
  if (result.kind === 'success') return { ...result, outputs: hide(result.outputs) };
  if (result.kind === 'business_outcome') return { ...result, data: hide(result.data) };
  if (result.kind === 'escalated' && result.outcome?.kind === 'success') return { ...result, outcome: { ...result.outcome, outputs: hide(result.outcome.outputs) } };
  if (result.kind === 'escalated' && result.outcome?.kind === 'business_outcome') return { ...result, outcome: { ...result.outcome, data: hide(result.outcome.data) } };
  return result;
}

/**
 * `json: true` -> stdout gets ONLY the pretty `ReplayResult` JSON (everything else the caller
 * wants to say goes to stderr), sensitive outputs included: `--json` is the programmatic return
 * channel and the caller asked for the data. Otherwise stdout gets `describeResult(result)` (which
 * already ends with its own "Locator drift: ..." sentence -- see `packages/core/src/replay/describe.ts`
 * -- so this prints no separate drift line of its own), with every output named in
 * `opts.sensitiveOutputs` (OutputSpec.sensitive) shown as `<sensitive>`, and the `result.json` path.
 * The run directory itself is not printed here: `runWithShutdown` (apps/cu/src/runtime/lifecycle.ts)
 * announces it exactly once, on every path (success, error, or interrupt), so a second copy is
 * never printed alongside it.
 */
export function printReplayResult(result: ReplayResult, runDir: string, opts: { json: boolean; sensitiveOutputs?: readonly string[] }): void {
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(describeResult(withSensitiveOutputsHidden(result, new Set(opts.sensitiveOutputs ?? []))));
  console.log(`result: ${path.join(runDir, 'result.json')}`);
}

/** Rows of `[label, count]` as aligned text, label column padded to the widest label. */
function table(rows: [string, number | string][], indent = '  '): string[] {
  const width = Math.max(...rows.map(([label]) => label.length));
  return rows.map(([label, n]) => `${indent}${label.padEnd(width)}  ${String(n).padStart(4)}`);
}

/** Longest breakdown key the table prints in full; escalation reasons are whole sentences. `--json` keeps them whole. */
const MAX_KEY = 72;

/** Sub-rows (`indent` deeper) for one breakdown, largest count first. */
function breakdownRows(counts: Record<string, number>, prefix = ''): [string, number][] {
  return Object.entries(counts)
    .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
    .map(([key, n]) => [`    ${prefix}${key.length > MAX_KEY ? `${key.slice(0, MAX_KEY - 3)}...` : key}`, n]);
}

/**
 * Human-readable lines summarizing a `replay --times N` series (see `summarizeStability`): runs by
 * result kind, each kind broken down (failures by `FailureCode`, business outcomes by name,
 * escalations by reason / resolution / underlying outcome), the recovery rules that fired, the
 * locator fallback-depth distribution and drift, and durations.
 */
export function stabilitySummaryLines(summary: StabilitySummary): string[] {
  const s = (n: number): string => (n / 1000).toFixed(1);
  const lines = [
    `${summary.runs} run(s); duration mean ${s(summary.meanDurationMs)}s, min ${s(summary.minDurationMs)}s, max ${s(summary.maxDurationMs)}s`,
    'result kind',
  ];
  const kindRows: [string, number][] = [['  success', summary.byKind.success]];
  kindRows.push(['  business_outcome', summary.byKind.business_outcome], ...breakdownRows(summary.businessOutcomes));
  kindRows.push(['  hard_failure', summary.byKind.hard_failure], ...breakdownRows(summary.failures));
  kindRows.push(
    ['  escalated', summary.byKind.escalated],
    ...breakdownRows(summary.escalationBreakdown.reason, 'reason '),
    ...breakdownRows(summary.escalationBreakdown.resolution, 'resolution '),
    ...breakdownRows(summary.escalationBreakdown.outcome, 'then '),
  );
  lines.push(...table(kindRows, ''));

  const recoveries = Object.entries(summary.recoveries).sort(([a, x], [b, y]) => y.fired - x.fired || a.localeCompare(b));
  if (recoveries.length === 0) {
    lines.push('recoveries fired: none');
  } else {
    lines.push('recoveries fired (times, in how many runs)');
    const width = Math.max(...recoveries.map(([name]) => name.length));
    for (const [name, c] of recoveries) lines.push(`  ${name.padEnd(width)}  ${String(c.fired).padStart(4)}  in ${c.runs} run(s)`);
  }

  const depths = Object.entries(summary.fallbackDepths).sort(([a], [b]) => Number(a) - Number(b));
  lines.push(
    `locator fallback depth: ${depths.length > 0 ? depths.map(([d, n]) => `${d}=${n}`).join(', ') : 'no resolutions'} (0 = first locator)`,
  );
  const driftSteps = summary.drift.driftedSteps.length > 0 ? summary.drift.driftedSteps.join(', ') : 'none';
  lines.push(
    `locator drift (union across all runs): ${summary.drift.drifted}/${summary.drift.total} target(s) resolved by a fallback ` +
      `(max fallback depth ${summary.drift.maxDepth}; steps: ${driftSteps})`,
  );
  return lines;
}

/**
 * `json: true` -> the human summary goes to stderr, and stdout gets ONLY the pretty
 * `{ runs, stability, chaos? }` JSON. Otherwise the human summary is all stdout gets. `chaos` is
 * present only for a series run under `--fault` chaos (see chaos-report.ts).
 */
export function printStabilitySummary(
  runs: ReplayResult[],
  summary: StabilitySummary,
  opts: { json: boolean; chaos?: SeriesChaos },
): void {
  const lines = stabilitySummaryLines(summary);
  if (opts.chaos !== undefined) lines.push(...seriesChaosLines(opts.chaos, summary.runs));
  if (opts.json) {
    for (const line of lines) console.error(line);
    console.log(JSON.stringify({ runs, stability: summary, ...(opts.chaos !== undefined ? { chaos: opts.chaos } : {}) }, null, 2));
    return;
  }
  for (const line of lines) console.log(line);
}

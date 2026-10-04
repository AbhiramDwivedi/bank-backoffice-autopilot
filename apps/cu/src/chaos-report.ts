/**
 * The chaos half of a `replay --times N` stability report.
 *
 * When `--fault` carries a `chaos` object (the mock app's seeded intermittent faults, see
 * apps/mock-app/chaos.ts), the series is only useful if it can be re-run exactly, and only
 * readable next to what the app actually injected. So after the series, and before the faults are
 * restored, the CLI reads `GET <baseUrl>/__faults/chaos` (per-kind draw/fire counters and the
 * ordered log of injected faults) and prints it with the seed and the exact `--fault` value.
 *
 * Like `--fault` itself, this is the CLI acting as the operator of the demo over plain `fetch`;
 * the replay surface can never reach `/__faults` (policy `deniedPathPatterns`). The CLI does not
 * import the mock app: the report is parsed defensively as JSON from a target that might be
 * something else entirely, and a missing or malformed report degrades to the seed alone.
 */

/** Draw/fire counters for one fault kind, as the target reports them. */
export interface ChaosKindCount {
  draws: number;
  fired: number;
}

/** One injected fault from the target's chaos log. */
export interface ChaosInjection {
  seq: number;
  kind: string;
  draw: number;
  method: string;
  path: string;
  delayMs?: number;
}

/** The parts of `GET /__faults/chaos` the CLI reports. */
export interface TargetChaosReport {
  config: Record<string, unknown> | null;
  stats: Record<string, ChaosKindCount>;
  log: ChaosInjection[];
  logDropped: number;
}

/** What a `--times` series under chaos adds to its stability report (the `chaos` key under `--json`). */
export interface SeriesChaos {
  /** The seed from `--fault`, echoed so the series can be re-run exactly. */
  seed: number;
  /** The exact `--fault` value: re-running with it and the same `--times` reproduces the series. */
  fault: unknown;
  /** What the target says it injected, or undefined when the report could not be read. */
  report?: TargetChaosReport;
  /** Why `report` is missing. */
  reportError?: string;
}

/** How long the post-series read of `GET /__faults/chaos` may take before it is reported as failed. */
export const CHAOS_REPORT_TIMEOUT_MS = 5000;

/** The human report lists at most this many injected faults; `--json` carries them all. */
const HUMAN_LOG_LINES = 20;

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * What to POST back after a `--fault` run, given the `GET /__faults` snapshot taken before it.
 * Posting a `chaos` config is an accepted chaos POST, which restarts its streams, counters and log
 * from the seed. So the snapshot's `chaos` is restored only when this `--fault` itself set a
 * `chaos` key (then putting back the prior config, `null` included, is the point, and its restart
 * is inherent). Otherwise `chaos` is left out and chaos that was already running keeps running,
 * mid-sequence, untouched.
 */
export function restoreBodyFor(snapshot: unknown, faultBody: unknown): unknown {
  if (!isRecord(snapshot) || !('chaos' in snapshot)) return snapshot;
  if (isRecord(faultBody) && 'chaos' in faultBody) return snapshot;
  const flags: Record<string, unknown> = { ...snapshot };
  delete flags.chaos;
  return flags;
}

/** The chaos seed in a `--fault` body, or undefined when the body sets no chaos (or turns it off). */
export function chaosSeedOf(faultBody: unknown): number | undefined {
  if (!isRecord(faultBody) || !isRecord(faultBody.chaos)) return undefined;
  const seed = faultBody.chaos.seed;
  return typeof seed === 'number' ? seed : undefined;
}

/** Validates the JSON of `GET /__faults/chaos`; throws with a short reason when it is not one. */
export function parseTargetChaosReport(raw: unknown): TargetChaosReport {
  if (!isRecord(raw) || !isRecord(raw.stats) || !Array.isArray(raw.log)) throw new Error('not a chaos report (expected {config, stats, log})');
  const stats: Record<string, ChaosKindCount> = {};
  for (const [kind, v] of Object.entries(raw.stats)) {
    if (!isRecord(v) || typeof v.draws !== 'number' || typeof v.fired !== 'number') throw new Error(`malformed stats for "${kind}"`);
    stats[kind] = { draws: v.draws, fired: v.fired };
  }
  const log: ChaosInjection[] = [];
  for (const e of raw.log) {
    if (!isRecord(e) || typeof e.seq !== 'number' || typeof e.kind !== 'string' || typeof e.draw !== 'number' || typeof e.path !== 'string') {
      throw new Error('malformed chaos log entry');
    }
    log.push({
      seq: e.seq,
      kind: e.kind,
      draw: e.draw,
      method: typeof e.method === 'string' ? e.method : 'GET',
      path: e.path,
      ...(typeof e.delayMs === 'number' ? { delayMs: e.delayMs } : {}),
    });
  }
  return {
    config: isRecord(raw.config) ? raw.config : null,
    stats,
    log,
    logDropped: typeof raw.logDropped === 'number' ? raw.logDropped : 0,
  };
}

/**
 * Reads the target's chaos report for the series that just ran. Never throws: a failed read is
 * returned as `reportError`, and the seed is still echoed.
 */
export async function collectSeriesChaos(
  baseUrl: string,
  faultBody: unknown,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = CHAOS_REPORT_TIMEOUT_MS,
): Promise<SeriesChaos | undefined> {
  const seed = chaosSeedOf(faultBody);
  if (seed === undefined) return undefined;
  try {
    // A target that accepts the connection and never answers must not hold the summary hostage.
    const res = await fetchImpl(`${baseUrl}/__faults/chaos`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`GET ${baseUrl}/__faults/chaos -> HTTP ${res.status}`);
    return { seed, fault: faultBody, report: parseTargetChaosReport(await res.json()) };
  } catch (err) {
    return { seed, fault: faultBody, reportError: err instanceof Error ? err.message : String(err) };
  }
}

/** `s` as one bash/POSIX-shell word: single-quoted, each embedded `'` written as `'\''`. */
export function shellQuote(s: string): string {
  return `'${s.split("'").join("'\\''")}'`;
}

/**
 * The re-run hint. Only `--times` and `--fault` are printed: the artifact, `--input`, `--tenant`
 * and `--base-url` must stay as they were, and the line says so instead of passing for the whole
 * command. Quoted for bash.
 */
export function rerunLine(times: number, fault: unknown): string {
  return `re-run this exact series: the same replay command (artifact, --input and other flags unchanged) with --times ${times} --fault ${shellQuote(JSON.stringify(fault))}`;
}

/** Human-readable lines for the chaos part of a stability report. */
export function seriesChaosLines(chaos: SeriesChaos, times: number): string[] {
  const lines = [`chaos seed: ${chaos.seed}`];
  if (chaos.report === undefined) {
    lines.push(`  (could not read what the app injected: ${chaos.reportError ?? 'unknown error'})`);
  } else {
    const kinds = Object.entries(chaos.report.stats);
    if (kinds.length === 0) lines.push('  no fault kinds configured');
    const width = Math.max(4, ...kinds.map(([k]) => k.length));
    if (kinds.length > 0) lines.push(`  ${'kind'.padEnd(width)}  fired  draws`);
    for (const [kind, c] of kinds) lines.push(`  ${kind.padEnd(width)}  ${String(c.fired).padStart(5)}  ${String(c.draws).padStart(5)}`);
    const log = chaos.report.log;
    if (log.length > 0) {
      const dropped = chaos.report.logDropped > 0 ? ` (${chaos.report.logDropped} earlier entries dropped by the app)` : '';
      lines.push(`  injected, in order${dropped}:`);
      for (const e of log.slice(0, HUMAN_LOG_LINES)) {
        const delay = e.delayMs !== undefined ? ` +${e.delayMs}ms` : '';
        lines.push(`    #${e.seq} ${e.kind} (draw ${e.draw}) ${e.method} ${e.path}${delay}`);
      }
      if (log.length > HUMAN_LOG_LINES) lines.push(`    ... ${log.length - HUMAN_LOG_LINES} more (--json has the full log)`);
    }
  }
  lines.push(rerunLine(times, chaos.fault));
  return lines;
}

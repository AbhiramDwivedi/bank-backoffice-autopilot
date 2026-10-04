/**
 * Run evidence logger — the sink where the "redaction happens at the sink" design principle is
 * enforced.
 *
 * Layout written under `<rootDir>/<runId>/`:
 *   events.jsonl   one JSON `RunEvent` per line, appended synchronously (crash-safety and
 *                  ordering matter more than throughput here — this is regulated evidence, not a
 *                  hot path)
 *   shots/<seq>.png
 *   dom/<seq>.html
 *   result.json
 *
 * Every event's `data` (and the `finish()` result, and any DOM snapshot) is passed through the
 * redactor before it touches disk. Callers are expected to pass raw, unredacted data — the sink
 * is the last (and only trusted) line of defense against secrets/PII leaking into evidence.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { RunEvent, type RunEventKind, type RunKind, type EvidenceRef, ReplayResult, type ReplayResultKind } from '../schema/index.js';
import { createRedactor, type Redactor, type RunRedactor } from './redact.js';

/** The four `ReplayResult.kind` values — used to decide whether `finish()` should validate its
 *  argument against the `ReplayResult` schema (discovery results have their own, unvalidated shape). */
const REPLAY_RESULT_KINDS: ReadonlySet<string> = new Set<ReplayResultKind>([
  'success',
  'business_outcome',
  'hard_failure',
  'escalated',
]);

/** Options for `createRunLogger`. */
export interface RunLoggerOptions {
  runId: string;
  runKind: RunKind;
  /** e.g. 'runs' — the run's own directory is `<rootDir>/<runId>`. */
  rootDir: string;
  /**
   * Defaults to `createRedactor()`. A {@link RunRedactor} also redacts DOM snapshots through its
   * `html()`, which leaves the markup itself unchanged; any other redactor sees the whole document
   * as one string.
   */
  redactor?: Redactor | RunRedactor;
  /** Defaults to `() => new Date()`. Injectable for deterministic tests. */
  clock?: () => Date;
}

/** A run's evidence sink: appends events, writes screenshots and DOM snapshots, and finalizes the
 *  result -- all redacted before they touch disk. */
export interface RunLogger {
  /** Absolute path to `runs/<runId>`. */
  readonly dir: string;
  readonly runId: string;
  /** The redactor this logger applies to everything it writes, when it exposes it. */
  readonly redactor?: Redactor;
  /**
   * Assigns the next 0-based `seq` and current `ts`, redacts `data`, validates the resulting
   * `RunEvent`, appends one JSON line to `events.jsonl`, and returns the event as written.
   * Throws if called after `finish()`.
   */
  event(e: { kind: RunEventKind; stepId?: string; data?: Record<string, unknown>; evidence?: EvidenceRef }): RunEvent;
  /** Writes `shots/<seq>.png`; `seq` defaults to the next event seq. Returns the path relative to
   *  the run dir, e.g. `'shots/3.png'` (forward slashes always). */
  screenshot(buf: Buffer, seq?: number): string;
  /** Writes `dom/<seq>.html`, redacted. `seq` defaults to the next event seq. Returns e.g. `'dom/3.html'`. */
  dom(html: string, seq?: number): string;
  /**
   * Writes `result.json` (redacted, pretty-printed) and appends a `run_finished` event with
   * `{ kind }` when the result has a `kind`. If `result.kind` is one of the four `ReplayResult`
   * kinds it is validated against the `ReplayResult` schema first and this throws on an invalid
   * shape — callers must not be allowed to persist a malformed replay result. Any other shape
   * (e.g. a discovery result) is written as-is. Returns `'result.json'`. Throws if called twice,
   * or if a subsequent `event()` is attempted.
   */
  finish(result: unknown): string;
}

function isRunRedactor(r: Redactor | RunRedactor): r is RunRedactor {
  return typeof (r as Partial<RunRedactor>).html === 'function';
}

function toRelative(...parts: string[]): string {
  return parts.join('/');
}

/**
 * Creates the evidence sink for one run: makes `<rootDir>/<runId>`, writes an initial
 * `run_started` event, and returns a `RunLogger` for appending further events, screenshots, DOM
 * snapshots, and the final result.
 */
export function createRunLogger(opts: RunLoggerOptions): RunLogger {
  const clock = opts.clock ?? (() => new Date());
  const redactor = opts.redactor ?? createRedactor();
  const dir = path.resolve(opts.rootDir, opts.runId);
  const eventsPath = path.join(dir, 'events.jsonl');
  const shotsDir = path.join(dir, 'shots');
  const domDir = path.join(dir, 'dom');
  const resultPath = path.join(dir, 'result.json');

  mkdirSync(dir, { recursive: true });

  let seq = 0;
  let finished = false;

  function event(e: { kind: RunEventKind; stepId?: string; data?: Record<string, unknown>; evidence?: EvidenceRef }): RunEvent {
    if (finished) throw new Error(`RunLogger: run ${opts.runId} already finished; cannot log another event`);

    const thisSeq = seq;
    seq += 1;

    const redactedData = redactor(e.data ?? {});

    const candidate: unknown = {
      runId: opts.runId,
      seq: thisSeq,
      ts: clock().toISOString(),
      kind: e.kind,
      ...(e.stepId !== undefined ? { stepId: e.stepId } : {}),
      data: redactedData,
      ...(e.evidence !== undefined ? { evidence: e.evidence } : {}),
    };

    const parsed = RunEvent.parse(candidate);
    appendFileSync(eventsPath, `${JSON.stringify(parsed)}\n`, 'utf8');
    return parsed;
  }

  function screenshot(buf: Buffer, seqOverride?: number): string {
    const s = seqOverride ?? seq;
    mkdirSync(shotsDir, { recursive: true });
    writeFileSync(path.join(shotsDir, `${s}.png`), buf);
    return toRelative('shots', `${s}.png`);
  }

  function dom(html: string, seqOverride?: number): string {
    const s = seqOverride ?? seq;
    mkdirSync(domDir, { recursive: true });
    const redacted = isRunRedactor(redactor) ? redactor.html(html) : (redactor(html) as string);
    writeFileSync(path.join(domDir, `${s}.html`), redacted, 'utf8');
    return toRelative('dom', `${s}.html`);
  }

  function finish(result: unknown): string {
    if (finished) throw new Error(`RunLogger: run ${opts.runId} already finished`);

    let toWrite: unknown = result;
    let finishedKind: string | undefined;

    if (result !== null && typeof result === 'object' && 'kind' in result) {
      const k = (result as { kind: unknown }).kind;
      if (typeof k === 'string') {
        finishedKind = k;
        if (REPLAY_RESULT_KINDS.has(k)) {
          // Throws (ZodError) on an invalid shape — callers must not persist garbage.
          toWrite = ReplayResult.parse(result);
        }
      }
    }

    const redacted = redactor(toWrite);
    mkdirSync(dir, { recursive: true });
    writeFileSync(resultPath, JSON.stringify(redacted, null, 2), 'utf8');

    event({ kind: 'run_finished', data: finishedKind !== undefined ? { kind: finishedKind } : {} });
    finished = true;
    return 'result.json';
  }

  const logger: RunLogger = {
    dir,
    runId: opts.runId,
    redactor,
    event,
    screenshot,
    dom,
    finish,
  };

  // Every run gets an automatic run_started event (seq 0) so evidence never lacks a start marker.
  event({ kind: 'run_started', data: { runKind: opts.runKind } });

  return logger;
}

import { z } from 'zod';
import { IsoDateTime, NonEmpty } from './common.js';

/** Whether a run is an LLM-driven discovery session or a deterministic capability replay. */
export const RunKind = z.enum(['discovery', 'replay']);
export type RunKind = z.infer<typeof RunKind>;

/** The kinds of event a run can emit to its log, in roughly chronological variety. */
export const RunEventKind = z.enum([
  'run_started',
  'run_finished',
  /** Summary of what the surface reported (element count, url, screenshot path). */
  'observation',
  /** Discovery only: model's stated reasoning + chosen action (redacted). */
  'decision',
  'action',
  'action_result',
  /** Replay: which strategy fired, fallbackDepth. */
  'locator_resolved',
  /** Pre/postcondition evaluation result. */
  'checkpoint',
  /** A RecoveryRule fired, or replay retried a transient app error (`rule: 'retry_app_error'`). */
  'recovery',
  /** Business outcome detected. */
  'outcome',
  /** Allow/deny/flag decision. */
  'policy',
  /** Intervention raised. */
  'escalation',
  /** automation -> paused -> human -> resuming -> automation */
  'control_transfer',
  /** Captured during human control. */
  'human_action',
  'error',
]);
export type RunEventKind = z.infer<typeof RunEventKind>;

/** Paths relative to the run directory. */
export const EvidenceRef = z.strictObject({ screenshot: z.string().optional(), dom: z.string().optional() });
export type EvidenceRef = z.infer<typeof EvidenceRef>;

/** One entry in a run's event log; `data` has already been passed through the redactor. */
export const RunEvent = z
  .strictObject({
    runId: NonEmpty,
    seq: z.number().int().min(0),
    ts: IsoDateTime,
    kind: RunEventKind,
    stepId: z.string().optional(),
    /** Already redacted. */
    data: z.record(z.string(), z.unknown()),
    evidence: EvidenceRef.optional(),
  })
  .meta({ id: 'RunEvent' });
export type RunEvent = z.infer<typeof RunEvent>;

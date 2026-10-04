import { z } from 'zod';
import { NonEmpty, Scalar } from './common.js';
import { LocatorStrategyKind } from './locator.js';
import { EvidenceRef } from './run-event.js';

/** Why a replay step failed hard; see {@link ReplayHardFailure.code}. */
export const FailureCode = z.enum([
  'element_not_found',
  'precondition_failed',
  'checkpoint_failed',
  'timeout',
  'policy_violation',
  'unexpected_dialog',
  'session_expired',
  'app_error',
  'navigation_failed',
  'input_validation',
  'internal',
]);
export type FailureCode = z.infer<typeof FailureCode>;

/** Which locator strategy resolved a step's target, and how deep into its fallback chain. */
export const LocatorReportEntry = z.strictObject({
  stepId: NonEmpty,
  strategyKind: LocatorStrategyKind,
  /** 0 = first locator fired. Depth > 0 is the drift signal. */
  fallbackDepth: z.number().int().min(0),
});
export type LocatorReportEntry = z.infer<typeof LocatorReportEntry>;

const base = {
  runId: NonEmpty,
  capabilityId: NonEmpty,
  capabilityVersion: NonEmpty,
  /** `capabilityDigest()` of the replayed capability's content (schema/digest.ts); `cu approve`
   *  requires it to match the artifact being approved. Absent on results from before it existed. */
  capabilityDigest: z.string().optional(),
  stepsExecuted: z.number().int().min(0),
  durationMs: z.number().min(0),
  locatorReport: z.array(LocatorReportEntry),
  /** Names of RecoveryRules that fired, in order, plus `retry_app_error` once per app-error retry
   *  replay made (its own recovery, not a rule of the capability). */
  recoveries: z.array(z.string()),
};

/** A replay that reached its capability's declared success condition. */
export const ReplaySuccess = z.strictObject({ ...base, kind: z.literal('success'), outputs: z.record(z.string(), Scalar) });
/** A replay that ended by matching one of the capability's declared business outcomes instead
 * of its success condition. */
export const ReplayBusinessOutcome = z.strictObject({
  ...base,
  kind: z.literal('business_outcome'),
  name: NonEmpty,
  data: z.record(z.string(), Scalar),
  /** Declared `returns` keys whose `extract` failed (target not found, read/parse/coerce error),
   *  so they are absent from `data`. Omitted (never an empty array) when every attempted key
   *  extracted successfully. */
  missing: z.array(z.string()).optional(),
});
/** A replay that stopped on an unrecoverable error, with the evidence needed to diagnose it. */
export const ReplayHardFailure = z.strictObject({
  ...base,
  kind: z.literal('hard_failure'),
  stepId: z.string().optional(),
  stepName: z.string().optional(),
  code: FailureCode,
  expected: z.string(),
  observed: z.string(),
  message: z.string(),
  evidence: EvidenceRef,
});
/** What a run produced once the human handed control back after an escalation. */
export const EscalatedOutcome = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('success'), outputs: z.record(z.string(), Scalar) }),
  z.strictObject({ kind: z.literal('business_outcome'), name: NonEmpty, data: z.record(z.string(), Scalar) }),
  z.strictObject({ kind: z.literal('hard_failure'), code: FailureCode, message: z.string(), stepId: z.string().optional() }),
]);
export type EscalatedOutcome = z.infer<typeof EscalatedOutcome>;

/** A replay that raised a human intervention; `outcome` is set once the run continued after
 * hand-back. */
export const ReplayEscalated = z.strictObject({
  ...base,
  kind: z.literal('escalated'),
  interventionId: NonEmpty,
  stepId: z.string().optional(),
  reason: z.string(),
  resolution: z.enum(['resumed_success', 'resumed_failed', 'abandoned']).optional(),
  /** Present when the run continued after hand-back: the caller's real answer. */
  outcome: EscalatedOutcome.optional(),
});

/** The final result of one capability replay. */
export const ReplayResult = z
  .discriminatedUnion('kind', [ReplaySuccess, ReplayBusinessOutcome, ReplayHardFailure, ReplayEscalated])
  .meta({ id: 'ReplayResult' });
export type ReplayResult = z.infer<typeof ReplayResult>;
/** The `kind` discriminator values of {@link ReplayResult}. */
export type ReplayResultKind = ReplayResult['kind'];

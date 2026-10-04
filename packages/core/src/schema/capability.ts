import { z } from 'zod';
import { IsoDateTime, Identifier, KEBAB_RE, NonEmpty, SEMVER_RE } from './common.js';
import {
  Action,
  ClickAction,
  Condition,
  DismissDialogAction,
  ExtractAction,
  NavigateAction,
  ParseMode,
  PressAction,
  RiskClass,
  SelectAction,
  Step,
  SwitchFrameAction,
  TypeAction,
  WaitAction,
} from './action.js';
import { TargetDescriptor } from './locator.js';

/** Primitive JSON value types a capability input or output can declare. */
export const JsonType = z.enum(['string', 'number', 'boolean']);
export type JsonType = z.infer<typeof JsonType>;

/** Declares one named input a capability accepts at invocation. */
export const InputSpec = z.strictObject({
  type: JsonType,
  description: NonEmpty,
  required: z.boolean(),
  /** Sensitive inputs are never persisted in plaintext (logs, results, artifacts). */
  sensitive: z.boolean(),
  /** Regex source the value must match (compiled without flags, anchored by the author). */
  pattern: z.string().optional(),
  example: z.string().optional(),
});
export type InputSpec = z.infer<typeof InputSpec>;

/** Declares one named output a capability produces on success. */
export const OutputSpec = z.strictObject({
  type: JsonType,
  description: NonEmpty,
  /**
   * Returned to the caller, but redacted like a sensitive input everywhere it would persist
   * (result.json, events, Relay). Set by discovery when the value was read from a masked element.
   */
  sensitive: z.boolean().optional(),
});
export type OutputSpec = z.infer<typeof OutputSpec>;

/** One value a business outcome pulls off the page when it fires. */
export const OutcomeExtract = z.strictObject({
  output: Identifier,
  target: TargetDescriptor,
  parse: ParseMode.optional(),
  pattern: z.string().optional(),
});
export type OutcomeExtract = z.infer<typeof OutcomeExtract>;

/** A named, detectable non-success result (e.g. "member not found") a capability can report
 * instead of a hard failure. */
export const BusinessOutcome = z.strictObject({
  /** "member_not_found" */
  name: Identifier,
  description: NonEmpty,
  /** Checked after every step and on any failure before it becomes a hard_failure. */
  detector: Condition,
  /** Step ids where it may legitimately occur; omitted = any. */
  afterSteps: z.array(NonEmpty).optional(),
  /** Shape of `data` in the result; may be {}. */
  returns: z.record(Identifier, OutputSpec),
  extract: z.array(OutcomeExtract).optional(),
});
export type BusinessOutcome = z.infer<typeof BusinessOutcome>;

/** An automatic recovery action tried when `trigger` matches, up to `maxAttempts` times. */
export const RecoveryRule = z.strictObject({
  /** "dismiss_maintenance_notice" */
  name: Identifier,
  description: NonEmpty,
  trigger: Condition,
  /** Must be read/reversible in effect; validateCapability and the executor reject irreversible ones. */
  actions: z.array(Action).min(1),
  maxAttempts: z.number().int().min(1),
});
export type RecoveryRule = z.infer<typeof RecoveryRule>;

/** Partial<Action>, distributed over the union: each variant with every field optional. */
export const PartialAction = z.union([
  NavigateAction.partial(),
  ClickAction.partial(),
  TypeAction.partial(),
  SelectAction.partial(),
  PressAction.partial(),
  ExtractAction.partial(),
  WaitAction.partial(),
  DismissDialogAction.partial(),
  SwitchFrameAction.partial(),
]);
export type PartialAction = z.infer<typeof PartialAction>;

/** A per-tenant patch onto an existing step (`stepPatches`) or an inserted extra step
 * (`extraSteps`); carries no approval of its own, so it always runs under the base
 * capability's `status`. */
export const TenantOverride = z.strictObject({
  tenant: NonEmpty,
  entryUrl: NonEmpty.optional(),
  stepPatches: z.array(z.strictObject({ stepId: NonEmpty, target: TargetDescriptor.optional(), action: PartialAction.optional() })),
  extraSteps: z.array(z.strictObject({ afterStepId: NonEmpty, step: Step })).optional(),
  notes: z.string().optional(),
});
export type TenantOverride = z.infer<typeof TenantOverride>;

/**
 * Which steps sign in to the app, and the condition that proves the session is signed in. The
 * `relogin` scripted operator re-runs these steps on a live session after it expires. Optional: a
 * capability without one gets the same block derived at run time by `deriveAuth` (schema/auth.ts),
 * the rule the recorder uses to fill it in. Stores step ids and a condition only, never a value.
 */
export const AuthBlock = z.strictObject({
  /** Step ids, in order: a contiguous run from the first step, containing a secret-bound step. */
  steps: z.array(NonEmpty).min(1),
  /** Holds once the session is signed in; checked after re-running `steps`. */
  signedIn: Condition,
});
export type AuthBlock = z.infer<typeof AuthBlock>;

/** A discovered, replayable unit of work against one app: its steps, business outcomes,
 * recovery rules, and tenant overrides. */
export const Capability = z
  .strictObject({
    schemaVersion: z.literal('1.0'),
    /** kebab-case, stable across versions: "lookup-member-savings-balance" */
    id: z.string().regex(KEBAB_RE, 'must be kebab-case'),
    /** semver */
    version: z.string().regex(SEMVER_RE, 'must be a semver version'),
    name: NonEmpty,
    description: NonEmpty,
    app: z.strictObject({
      vendor: NonEmpty,
      product: NonEmpty,
      productVersion: z.string().optional(),
      /** Omitted = base capability for the product. */
      tenant: z.string().optional(),
      surface: z.enum(['web', 'desktop']),
      /** May contain {baseUrl}. */
      entryUrl: NonEmpty,
    }),
    status: z.enum(['draft', 'approved', 'deprecated']),
    /** Max over steps (enforced by validateCapability). */
    riskLevel: RiskClass,
    /**
     * The operator's assertion that replaying this capability -- whole, or with any of its steps
     * removed -- changes nothing in the target app. Set by `discover --read-only` or
     * `cu optimize --read-only`; never inferred. It is what allows the optimizer to replay mutated
     * variants of the capability against the live app (docs/design/optimize.md). The system does
     * not verify it; validateCapability only rejects it on a capability with anything irreversible.
     */
    readOnly: z.literal(true).optional(),
    inputs: z.record(Identifier, InputSpec),
    outputs: z.record(Identifier, OutputSpec),
    steps: z.array(Step).min(1),
    success: z.strictObject({ condition: Condition, description: NonEmpty }),
    businessOutcomes: z.array(BusinessOutcome),
    recoveryRules: z.array(RecoveryRule),
    /** The sign-in steps and signed-in condition (see AuthBlock); derived at run time when omitted. */
    auth: AuthBlock.optional(),
    provenance: z.strictObject({
      discoveredAt: IsoDateTime,
      discoveryRunId: NonEmpty,
      recordedBy: z.enum(['llm', 'human', 'mixed']),
      model: z.string().optional(),
      notes: z.string().optional(),
    }),
    /** Design seam for multi-tenant; may be empty in v1. */
    overrides: z.array(TenantOverride).optional(),
  })
  .meta({ id: 'Capability' });
export type Capability = z.infer<typeof Capability>;

/**
 * Internal contracts shared by the replay engine's modules (replay.ts, steps.ts, classify.ts,
 * escalate.ts, extract.ts, overrides.ts, validate-inputs.ts, bind.ts, safe-logger.ts,
 * describe.ts).
 *
 * This directory must never import the Anthropic SDK or anything under packages/core/src/agent
 * (enforced by no-llm.test.ts): replay is the no-LLM production path.
 */
import type {
  BoundStep,
  Capability,
  Condition,
  FailureCode,
  LocatorReportEntry,
  ReplayResult,
  RiskClass,
  Step,
} from '../schema/index.js';
import type { RunLogger, ValueScrubber } from '../evidence/index.js';
import type { EscalationHandler } from '../session/index.js';
import type { Surface, SurfaceAction } from '../surface/index.js';
export type { ActOptions } from '../surface/index.js';

/** A capability input, secret, or output value. */
export type InputValue = string | number | boolean;

/** Injectable time source, so tests can run a run's clock deterministically. */
export interface ReplayClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// Policy seam: replay code depends only on this shape. The concrete implementation lives in
// packages/core/src/policy/guard.ts.
// ---------------------------------------------------------------------------------------------

/** A policy guard's verdict on a proposed action: run it, block it, or flag it as irreversible. */
export type PolicyDecision = 'allow' | 'deny' | 'flag_irreversible';

/** What a policy guard sees about the action it is checking. */
export interface PolicyActionContext {
  runKind: 'replay';
  stepId?: string;
  /** Best-known accessible name of the action's target (recorded snapshot / role locator name). */
  targetName?: string;
  /** Best-known visible text of the action's target (recorded snapshot / text locator). */
  targetText?: string;
  /** Page URL at the moment of the check (route-scoped rules; base for relative navigate URLs). */
  currentUrl: string;
  /**
   * The step's declared risk. The guard may only RAISE the effective risk above what its own
   * text/URL heuristics compute, never lower it. Omitted for recovery actions.
   */
  riskOverride?: RiskClass;
}

/** Result of a policy guard's check on one action. */
export interface PolicyCheck {
  decision: PolicyDecision;
  reason: string;
  risk?: RiskClass;
}

/**
 * Structural subset of `createPolicyGuard(policy)` (packages/core/src/policy/guard.ts; replay-policy.test.ts
 * asserts the real guard is assignable to this). The action passed is
 * the BOUND action with any `value` masked as '[REDACTED]': policy decides on type, target and
 * URL, never on the typed value, so the guard never sees a secret.
 */
export interface PolicyGuardLike {
  checkAction(action: SurfaceAction, ctx: PolicyActionContext): PolicyCheck;
}

// ---------------------------------------------------------------------------------------------
// Public options
// ---------------------------------------------------------------------------------------------

export const DEFAULT_SESSION_EXPIRED_SIGNALS: readonly string[] = ['Your session has expired', 'Session Expired', 'Please log in again'];
export const DEFAULT_APP_ERROR_SIGNALS: readonly string[] = ['Application Error', 'ORA-', 'HTTP Status 500', 'Internal Server Error'];
export const DEFAULT_ESCALATE_ON: readonly FailureCode[] = ['unexpected_dialog', 'session_expired'];
export const DEFAULT_STEP_TIMEOUT = 10_000;
export const DEFAULT_MAX_DURATION_MS = 600_000;
export const DEFAULT_MAX_ESCALATIONS = 3;
/** How many times one run may restart its steps to get past a transient `app_error` (read-only runs only). */
export const DEFAULT_MAX_APP_ERROR_RETRIES = 2;
/** Wait before the first app-error retry; retry n waits n times this. */
export const DEFAULT_APP_ERROR_RETRY_BACKOFF_MS = 1000;
/**
 * The name an app-error retry is reported under, in `recovery` events and `result.recoveries`. It
 * is the engine's own recovery, not a `RecoveryRule` of the capability; a declared rule with the
 * same name would be counted together with it.
 */
export const APP_ERROR_RETRY = 'retry_app_error';
/** Fraction of the step timeout given to the precondition wait. */
export const PRECONDITION_TIMEOUT_FRACTION = 0.25;

/** What a {@link BeforeStepHook} is given for one step. */
export interface BeforeStepInfo {
  /** A frozen deep copy of the step about to act, as this run executes it (after any tenant
   *  override), unbound. Mutating it is impossible, and could not affect the run anyway. */
  step: Readonly<Step>;
  /**
   * Evaluates `condition` on the live surface once, right now (no waiting), after binding its
   * `{baseUrl}` / `{input.x}` placeholders exactly as replay binds the step's own conditions. A
   * condition that cannot be bound evaluates to `false`. Each call is logged as a `checkpoint`
   * event with `phase: 'observe'`. Never acts on the surface.
   */
  check(condition: Condition): Promise<boolean>;
}

/**
 * A purely observational per-step hook: called once per step attempt, after recovery rules and
 * the precondition, immediately before the policy gate and the step's own action. It can look
 * (`check`) but has no way to act, cannot change the step or the run, and anything it throws is
 * logged and ignored. A hook that has not settled after {@link BEFORE_STEP_HOOK_TIMEOUT_MS} is
 * logged as hung and the step proceeds without it. The optimizer uses it to find postconditions that already hold before their
 * step runs (packages/core/src/optimize).
 */
export type BeforeStepHook = (info: BeforeStepInfo) => void | Promise<void>;

/** How long replay waits for a `beforeStep` hook before logging it as hung and moving on. */
export const BEFORE_STEP_HOOK_TIMEOUT_MS = 10_000;

/** Inputs to {@link replayCapability}: what to run, against what surface, and how to handle timing, escalation, and policy. */
export interface ReplayOptions {
  /** Raw artifact JSON; validated inside with validateCapability. */
  capability: unknown;
  inputs: Record<string, unknown>;
  surface: Surface;
  baseUrl: string;
  /** Selects capability.overrides[].tenant, applied before execution. */
  tenant?: string;
  policy?: PolicyGuardLike;
  /** policy.risk.replayRequiresApproved; default true. */
  replayRequiresApproved?: boolean;
  logger: RunLogger;
  escalate?: EscalationHandler;
  /** Failure codes that escalate (when a handler exists) even if step.onFailure is 'fail'. */
  escalateOn?: readonly FailureCode[];
  maxEscalations?: number;
  /**
   * The caller's assertion, for this run, that replaying the capability changes nothing in the
   * target app: the run-level form of the artifact's own `readOnly: true`, and as unverified. It
   * is what lets replay re-run steps on its own to get past a transient `app_error` (rewind.ts).
   * Refused before any surface call (`policy_violation`) on a capability the validator would not
   * accept `readOnly: true` on (anything irreversible, rule `read_only_irreversible`).
   */
  readOnly?: boolean;
  /**
   * How many times this run may retry after an `app_error`, each time restarting its steps from a
   * step that can run from any page (rewind.ts, `appErrorRetryIndex`). Only a read-only run (the
   * capability's `readOnly: true`, or {@link ReplayOptions.readOnly}) retries at all. Counted
   * apart from `maxEscalations`. Default {@link DEFAULT_MAX_APP_ERROR_RETRIES}; 0 disables.
   */
  maxAppErrorRetries?: number;
  /** Wait before app-error retry n is n times this, on the run's clock. Default {@link DEFAULT_APP_ERROR_RETRY_BACKOFF_MS}. */
  appErrorRetryBackoffMs?: number;
  clock?: ReplayClock;
  /** Default step timeout; a step's own timeoutMs wins. Default 10000. */
  stepTimeoutMs?: number;
  /** Wall-clock budget for automation (time spent waiting on a human is excluded). Default 600000. */
  maxDurationMs?: number;
  /** Credential resolver for `{kind:'secret'}` bindings, called at bind time (typically
   *  `CredentialSet.get`). Omitted: every secret binding is unavailable (a bind failure). */
  secret?: (env: string) => string | undefined;
  sessionExpiredSignals?: readonly string[];
  appErrorSignals?: readonly string[];
  /** Observational hook called before each step acts; see {@link BeforeStepHook}. */
  beforeStep?: BeforeStepHook;
  /** Override of {@link BEFORE_STEP_HOOK_TIMEOUT_MS} (tests). */
  beforeStepTimeoutMs?: number;
}

// ---------------------------------------------------------------------------------------------
// Module contracts
// ---------------------------------------------------------------------------------------------

/** Outcome of validating a capability's declared inputs against the values supplied for a run. */
export type InputValidationResult =
  | { ok: true; values: Record<string, InputValue> }
  | { ok: false; input: string; problem: string };

/** Record of a tenant override applied to a capability before a run. */
export interface AppliedOverride {
  tenant: string;
  /** stepIds whose target and/or action fields were patched. */
  patchedSteps: string[];
  /** ids of inserted extra steps, with the step they follow. */
  extraSteps: { stepId: string; afterStepId: string }[];
  entryUrl?: string;
}

/** Outcome of parsing a raw extracted value into a typed {@link InputValue}. */
export type ParseResult = { ok: true; value: InputValue } | { ok: false; reason: string };

/** A step's target and action after placeholders are resolved to concrete values. */
export interface ReplayBinding {
  bound: BoundStep;
  /** True when the step's value (or any placeholder in it) came from a secret or a sensitive input. */
  valueRedacted: boolean;
}

/** Registry of bound secret and sensitive values; every string that reaches the RunLogger passes through it. */
export type Scrubber = ValueScrubber;

/** A failure as first detected, before classification. */
export interface FailureSignal {
  code: FailureCode;
  /** Human readable: what the step/checkpoint required. */
  expected: string;
  /** What was seen (tried locators, text excerpt, surface error). Scrubbed before logging. */
  observed: string;
  message: string;
}

/** A {@link FailureSignal} after classification has had a chance to refine its code. */
export interface ClassifiedFailure extends FailureSignal {
  /** Set when classification replaced the original code (e.g. element_not_found -> session_expired). */
  originalCode?: FailureCode;
  /** Whitespace-collapsed excerpt of the page text at classification time (max ~300 chars). */
  textExcerpt?: string;
  /**
   * The session-expired or app-error signal the page text matched, when the code comes from the
   * page (whether or not that changed it). Absent when the code is only what the step or the
   * surface reported: an `app_error` a surface returns for a control it found but could not
   * operate has none, and is not what the app-error retry is for.
   */
  matchedSignal?: string;
}

/** Inputs classification needs to reinterpret a raw failure signal. */
export interface ClassifyContext {
  surface: Surface;
  sessionExpiredSignals: readonly string[];
  appErrorSignals: readonly string[];
}

/** Codes that come from replay itself, not the page; classification never rewrites them. */
export const NON_PAGE_CODES: readonly FailureCode[] = ['policy_violation', 'input_validation', 'internal'];

/** Per-run mutable state shared by replay.ts and steps.ts. */
export interface RunState {
  runId: string;
  capability: Capability;
  inputs: Record<string, InputValue>;
  surface: Surface;
  /** The scrubbing wrapper (safe-logger.ts), never the raw logger. */
  logger: RunLogger;
  scrubber: Scrubber;
  clock: ReplayClock;
  baseUrl: string;
  policy?: PolicyGuardLike;
  /** Approval gate passed (status approved, or replayRequiresApproved false). */
  irreversibleAllowed: boolean;
  stepTimeoutMs: number;
  startedAt: number;
  /** Automation deadline; extended by time spent waiting on a human. */
  deadline: number;
  outputs: Record<string, InputValue>;
  /**
   * Outputs (and outcome returns) read from content the surface masks although the capability
   * does not flag them sensitive (discovered under a looser policy): treated as sensitive for
   * this run (redacted in evidence, still returned).
   */
  maskedOutputs?: Set<string>;
  locatorReport: LocatorReportEntry[];
  recoveries: string[];
  /** RecoveryRule name -> attempts used this run. */
  recoveryAttempts: Map<string, number>;
  stepsExecuted: number;
  lastCompletedStepId?: string;
  /** Ids of steps whose irreversible action this run has dispatched (steps.ts, at act time) or that
   *  completed / were handed back `next_step` while declared irreversible (replay.ts). A resume
   *  point at or before one of them is refused (rewind.ts). Always set by replayCapability; optional
   *  only so a hand-built state in a unit test need not. */
  irreversibleRan?: Set<string>;
  secret?: (env: string) => string | undefined;
  sessionExpiredSignals: readonly string[];
  appErrorSignals: readonly string[];
  beforeStep?: BeforeStepHook;
  beforeStepTimeoutMs?: number;
}

/** A classified failure tied to the step (if any) that produced it, with captured evidence. */
export interface StepFailure extends ClassifiedFailure {
  stepId?: string;
  stepName?: string;
  evidence: { screenshot?: string; dom?: string };
}

/** What steps.ts returns for one step attempt. */
export type StepOutcome =
  | { kind: 'ok' }
  | { kind: 'business_outcome'; name: string; data: Record<string, InputValue>; missing?: string[] }
  | { kind: 'failure'; failure: StepFailure };

/** The `hard_failure` variant of {@link ReplayResult}. */
export type HardFailureResult = Extract<ReplayResult, { kind: 'hard_failure' }>;

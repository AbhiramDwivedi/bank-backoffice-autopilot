/**
 * Contracts of the capability optimizer (`optimizeCapability`, optimize.ts).
 *
 * The optimizer is model-free and surface-free: it never creates a browser, a surface or a
 * session. Everything that executes a capability goes through the injected {@link RunTrial}, which
 * the composition root implements with a real replay (apps/cu/src/runtime/run-optimize.ts) and
 * tests implement with a fake. That keeps the whole search unit-testable and keeps this module out
 * of the no-LLM guard's way: it imports `schema` and `replay` (types) only.
 *
 * The safety boundary (docs/design/optimize.md): a trial EXECUTES the capability -- and mutated
 * variants of it -- against the live target. So every rewrite is replay-verified, and the
 * replay-backed passes run only on a capability the operator has declared `readOnly`. Without the
 * declaration, or with any veto (irreversible step, no outputs, a caller veto), the optimizer is
 * analysis-only: it rewrites nothing and reports what it would look at.
 */
import type { Capability, ReplayResult, Step } from '../schema/index.js';
import type { BeforeStepHook } from '../replay/index.js';

/** A replay's extracted outputs. Held in memory only; never written into a report. */
export type OutputMap = Record<string, string | number | boolean>;

/**
 * Why a trial runs:
 * - `baseline`: the unmodified capability, establishing the outputs every candidate must reproduce
 *   (and, through the vacuity probe, which checkpoints already hold before their step).
 * - `start`: a rewrite level (collapse + vacuity, or collapse alone) the removal search starts from.
 * - `removal`: the current candidate minus one step.
 * - `verify`: one of the final `verifyRuns` replays of the chosen candidate.
 */
export type TrialPurpose = 'baseline' | 'start' | 'removal' | 'verify';

/** One trial the optimizer asks the caller to run. */
export interface TrialRequest {
  /**
   * The capability to replay. Always a trial copy: `status: 'draft'` (so the approval gate refuses
   * anything the policy flags irreversible) and a prerelease version `<x.y.z>-optimize.<n>`, so a
   * trial's run directory can never count as replay evidence for `cu approve` of a real version.
   */
  capability: Capability;
  purpose: TrialPurpose;
  /** Short human-readable label, e.g. `remove s05`. */
  label: string;
  /** Observational hook to pass to `replayCapability` as `beforeStep`, when present. */
  beforeStep?: BeforeStepHook;
}

/** What one trial produced. A thrown error is NOT a failed trial: it propagates (e.g. Ctrl-C). */
export interface TrialOutcome {
  kind: ReplayResult['kind'];
  /** Present on `success`. Compared in memory, never persisted by the optimizer. */
  outputs?: OutputMap;
  runId?: string;
  runDir?: string;
  /** One line on why a non-success trial failed. The runner must redact it (it is persisted). */
  detail?: string;
  /** Sum of the locator fallback depths the run reported (lower is a more stable path). */
  locatorDepth?: number;
}

/** Runs one trial: replays `req.capability` once, unattended, in a fresh session. Expected
 *  failures are returned as a non-`success` outcome (an escalation counts as one); only an
 *  interruption should throw. */
export type RunTrial = (req: TrialRequest) => Promise<TrialOutcome>;

/** Options for {@link optimizeCapability}. */
export interface OptimizeOptions {
  /** Replays a trial. Without it the optimizer is analysis-only. */
  runTrial?: RunTrial;
  /** Analysis only, even for a read-only capability with a trial runner. */
  analyzeOnly?: boolean;
  /** Cap on removal trials (the search). Baseline, start and verification trials are not counted
   *  against it but are reported in `trialsUsed`. Default {@link DEFAULT_MAX_TRIALS}. */
  maxTrials?: number;
  /** Consecutive successful, output-equal replays the result must pass. Default {@link DEFAULT_VERIFY_RUNS}. */
  verifyRuns?: number;
  /** Pause between consecutive trials, for a polite pace against a real site. Default 0. */
  trialDelayMs?: number;
  /** Outputs the baseline must also reproduce (discovery's own extracted outputs). */
  referenceOutputs?: OutputMap;
  /**
   * Extra irreversibility test (the policy's view, from the composition root). Any step this
   * returns true for, or any step declared `risk: 'irreversible'`, vetoes trials. Default: the
   * schema's default irreversible-text patterns against the step's target texts.
   */
  isIrreversible?: (step: Step) => boolean;
  /**
   * A caller veto per step: a reason string vetoes trials (analysis-only), `undefined` does not.
   * Models and heuristics may veto, never permit -- e.g. the composition root vetoes a step whose
   * recorded risk was raised by the risk judge.
   */
  vetoStep?: (step: Step) => string | undefined;
  /** Bump the patch version of a changed result (cu optimize on an existing artifact). Default false. */
  bumpVersion?: boolean;
  /** Who/what optimized, for the provenance note (e.g. `cu optimize`, `discover run run_x`). */
  source?: string;
  /** The tenant override key the trials apply, if any (the tenant the vacuity probe observed). */
  tenant?: string;
  /** Checked before every trial: once aborted, no further trial starts and the input comes back
   *  unchanged (`stop: 'aborted'`). */
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  /** One-line progress messages while the optimizer works. Never the report's `stopDetail`: the
   *  caller prints that once, from the report (`summarizeOptimization`). */
  log?: (line: string) => void;
}

/** Default {@link OptimizeOptions.maxTrials}. */
export const DEFAULT_MAX_TRIALS = 25;
/** Default {@link OptimizeOptions.verifyRuns}. */
export const DEFAULT_VERIFY_RUNS = 3;

/** One change the optimizer made to the capability. */
export type OptimizeChange =
  | { kind: 'collapsed_repeat'; stepId: string; into: string; name: string }
  | { kind: 'dropped_vacuous_postcondition'; stepId: string; condition: string }
  | { kind: 'removed_step'; stepId: string; name: string; actionType: string };

/** Why a step was never tried for removal (or a vacuous checkpoint was kept). */
export type KeptReason =
  | 'override_reference' // a tenant override patches it or anchors an extra step on it
  | 'outcome_reference' // a business outcome's afterSteps names it
  | 'last_extract' // the last extract of a declared output: removing it can only lose the output
  | 'last_input_use' // the last step consuming a declared input: removing it can only stop using it
  | 'invalid_without' // the capability would fail validateCapability without it
  | 'weakens_validation'; // removing it (or its checkpoint) adds a validateCapability warning

/** One trial, as recorded in the report. No output values: only whether they matched. */
export interface OptimizeTrialRecord {
  n: number;
  purpose: TrialPurpose;
  label: string;
  kind: ReplayResult['kind'];
  /** On a `success`: whether the outputs deep-equal the baseline's (baseline: the reference's). */
  outputsMatch?: boolean;
  /** removal trials: whether the removal was kept. */
  accepted?: boolean;
  runId?: string;
  detail?: string;
  /** Sum of locator fallback depths the trial reported, when the runner provides it. */
  locatorDepth?: number;
}

/** Why the optimizer only analysed (rewrote nothing). */
export type AnalysisReason =
  | 'requested' // --analyze-only
  | 'not_read_only' // the capability is not declared readOnly
  | 'irreversible_steps' // a step is declared or policy-classified irreversible
  | 'no_outputs' // no declared outputs: output equality would compare nothing
  | 'vetoed' // the caller vetoed a step (vetoStep)
  | 'no_trial_runner';

/** How the optimization ended. */
export type OptimizeStop =
  | 'completed' // all passes ran
  | 'analysis_only' // see analysisReason; nothing rewritten
  | 'baseline_failed' // the unmodified capability did not replay to success: nothing to compare against
  | 'baseline_mismatch' // it succeeded with outputs different from the reference (discovery) outputs
  | 'aborted'; // the signal fired; nothing rewritten

/** What the optimizer would look at, reported in analysis-only mode (and always, for reference). */
export interface OptimizeAnalysis {
  /** Steps that exactly repeat the step before them (collapse candidates). */
  redundantRepeats: { stepId: string; repeatOf: string }[];
  /** Steps whose postcondition the vacuity probe would observe. */
  checkpointsToProbe: string[];
  /** Steps the removal search would try. */
  removalCandidates: string[];
}

/** What {@link optimizeCapability} did and why; written as `optimize.json`. Contains no output
 *  or input values -- only names, step ids, verdicts and run ids. */
export interface OptimizeReport {
  capabilityId: string;
  versionBefore: string;
  versionAfter: string;
  /** Whether the capability (or the caller) declared it read-only. */
  readOnly: boolean;
  stop: OptimizeStop;
  analysisReason?: AnalysisReason;
  /** One line explaining a non-`completed` stop, and how to enable trials when analysis-only. */
  stopDetail?: string;
  /** Steps that vetoed trials, with the reason. */
  vetoes: { stepId: string; reason: string }[];
  analysis: OptimizeAnalysis;
  /** Whether the returned capability differs from the input at all. */
  changed: boolean;
  stepsBefore: number;
  stepsAfter: number;
  changes: OptimizeChange[];
  /** Removal trials that failed, and why. */
  rejected: { stepId: string; reason: string }[];
  /** Steps never tried for removal, and vacuous checkpoints kept, with the reason. */
  kept: { stepId: string; reason: KeptReason; what: 'step' | 'postcondition' }[];
  /** Steps that are declared or policy-classified irreversible. */
  irreversibleSteps: string[];
  /** The baseline run: its kind, the NAMES of the outputs it produced, and whether they matched the
   *  reference outputs (when there were any). Values live only in the run's own redacted evidence. */
  baseline?: { kind: ReplayResult['kind']; outputNames: string[]; matchesReference?: boolean; runId?: string; detail?: string };
  /** The tenant whose view the vacuity probe and the trials observed (`base` = no override). */
  probedTenant?: string;
  verification?: {
    /** Which candidate was finally kept: the search result, the search's starting point, or none
     *  (the input, unchanged). */
    kept: 'search' | 'start' | 'unchanged';
    required: number;
    /** Per verified candidate: how many consecutive runs passed before one failed (or all). */
    attempts: { candidate: 'search' | 'start'; passed: number; failure?: string }[];
  };
  trialsUsed: number;
  removalTrialsUsed: number;
  maxTrials: number;
  budgetExhausted: boolean;
  trials: OptimizeTrialRecord[];
  /** Caveats a reviewer needs (overrides not trialled, inputs it was verified with, ...). */
  notes: string[];
}

/** The optimized draft plus the report. When `report.changed` is false, `capability` is the input,
 *  untouched (same version and status). */
export interface OptimizeResult {
  capability: Capability;
  report: OptimizeReport;
  /** The baseline's output VALUES, for in-process comparison only (`discover --candidates`). Never
   *  write this anywhere: it is the caller's data, unredacted. */
  baselineOutputs?: OutputMap;
}

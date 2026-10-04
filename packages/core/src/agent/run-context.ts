/**
 * Shared per-run state and context for the discovery loop's split-out modules
 * (tool-handlers.ts, finalize.ts): the loop's mutable turn-by-turn state, and the typed bundle of
 * services and config those modules act on in place of a long parameter list.
 */
import type { EvidenceRef, RiskJudgeConfig, RunEventKind } from '../schema/index.js';
import type { GuardedRiskJudge } from '../policy/index.js';
import type { Recorder } from './recorder.js';
import type { HistoryEntry } from './prompt.js';
import type { Scrubber } from './scrub.js';
import type { StuckRepeatDetector } from './limits.js';
import type { DiscoverOptions, DiscoveryResult } from './types.js';

/** Mutable counters and accumulators that change turn by turn as the loop runs. Shared by
 *  reference through `RunContext.state`, so a mutation made inside `dispatch` or an escalation
 *  helper is visible to the loop that called it. */
export interface LoopState {
  turn: number;
  llmCalls: number;
  consecutiveDenies: number;
  consecutiveNoToolUse: number;
  escalationsUsed: number;
  history: HistoryEntry[];
  lastResult: string | undefined;
  extractedOutputs: Map<string, string | number>;
  /** Outputs extracted from a masked element: returned to the caller, withheld from the model and redacted in evidence. */
  sensitiveOutputs: Set<string>;
  /** Actions the risk judge raised above the lexical risk (absent = none yet). */
  judgeRaised?: number;
  /** Consecutive judge consultations that came back unavailable (absent = none). */
  judgeUnavailableStreak?: number;
}

/** `DiscoveryResult` minus the fields only known once the run is fully over (run id, step/call
 *  counts, transcript path, usage totals): what a terminal outcome or a finalized capability
 *  build can produce on its own. */
export type ResultShape = Omit<DiscoveryResult, 'runId' | 'stepsRecorded' | 'llmCalls' | 'transcriptPath' | 'usage'>;

/**
 * Everything one turn's tool dispatch, escalation, or the run's finalization needs beyond the
 * current observation/tool-call: the caller's options, the recorder/scrubber, resolved secrets,
 * timing budgets, and the loop's mutable `state`. Built once per run in `discover()` and passed by
 * reference.
 */
export interface RunContext {
  readonly opts: DiscoverOptions;
  readonly runId: string;
  /** True for an outcome-discovery ("extend") run: changes how `declare_outcome`/`done` resolve. */
  readonly isExtend: boolean;
  readonly recorder: Recorder;
  readonly scrubber: Scrubber;
  /** Env var name to resolved secret value, for this run only. */
  readonly secretValues: Record<string, string>;
  /** Input name to concrete value, for every input declared `sensitive`. */
  readonly sensitiveInputs: Record<string, string>;
  readonly stuckRepeats: StuckRepeatDetector;
  readonly expectTimeoutMs: number;
  readonly actionTimeoutMs: number;
  readonly now: () => Date;
  readonly state: LoopState;
  /** The run's risk judge (timeout, typed errors, per-run cache) and its resolved policy config,
   *  present only when a judge is wired in and `config.mode` is not 'off'. */
  readonly judge?: { readonly guarded: GuardedRiskJudge; readonly config: RiskJudgeConfig };
  /** Scrubs `data` and forwards it to the run's event log (same contract as `RunLogger.event`). */
  logEvent(kind: RunEventKind, data: Record<string, unknown>, extra?: { stepId?: string; evidence?: EvidenceRef }): void;
}

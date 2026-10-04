/**
 * Public API of the session/handoff module. The seam types that replay and the agent depend on
 * live in `./types.ts`; this file adds the broker, the intervention store, and the error types.
 * See docs/design/handoff.md for the full design.
 */
import type { HumanAction, Intervention, InterventionStatus, RunKind } from '../schema/index.js';
import type { Redactor, RunLogger } from '../evidence/index.js';
import type { HumanActionCapture, Surface } from '../surface/index.js';
import type { ControlToken, ControlTransferEvent, EscalationHandler, EscalationResolution } from './types.js';

/** Thrown for every transition the state machine does not allow. Maps to HTTP 409 in the operator API. */
export class IllegalControlTransitionError extends Error {
  override readonly name = 'IllegalControlTransitionError';
  constructor(
    readonly operation: string,
    readonly state: string,
    message: string,
    readonly interventionId?: string,
  ) {
    super(message);
  }
}

/** Thrown when an intervention id is not known to a broker/store. Maps to HTTP 404. */
export class UnknownInterventionError extends Error {
  override readonly name = 'UnknownInterventionError';
  constructor(readonly interventionId: string) {
    super(`unknown intervention ${interventionId}`);
  }
}

/** Whether a store write created a new intervention record or updated an existing one. */
export type InterventionChange = 'created' | 'updated';

/** One human action accepted into the live round of an intervention. */
export interface HumanActionEvent {
  interventionId: string;
  runId: string;
  source: 'capture' | 'scripted-operator';
  /** The sanitized action exactly as stored (never a raw capture payload). */
  action: HumanAction;
}

/** Persists intervention records, validates them against the schema, and notifies subscribers of every change. */
export interface InterventionStore {
  /** Validates with the zod `Intervention` schema, persists, notifies. Throws on duplicate id or invalid record. */
  create(i: Intervention): Intervention;
  get(id: string): Intervention | undefined;
  /** `fn` receives a deep copy of the current record and returns the next one; validated + persisted + notified. Throws UnknownInterventionError. */
  update(id: string, fn: (current: Intervention) => Intervention): Intervention;
  /** Newest first. */
  list(filter?: { runId?: string; status?: InterventionStatus }): Intervention[];
  /** Called synchronously after every successful create/update. Returns an unsubscribe function. */
  subscribe(cb: (i: Intervention, change: InterventionChange) => void): () => void;
}

/** Configuration for `createInterventionStore`: where (if anywhere) to mirror records to disk, and how to redact them before writing. */
export interface InterventionStoreOptions {
  /** When set, every write also goes to `<runDir>/interventions/<id>.json` (redacted, pretty JSON). */
  runDir?: string;
  /** Applied to the on-disk copy only. Defaults to `createRedactor()`. */
  redactor?: (value: unknown) => unknown;
}

/** Input to `SessionBroker.handBack`: where automation should resume, and who is handing control back. */
export interface HandBackInput {
  resumeFrom: 'current_step' | 'next_step';
  /** Only with `current_step`: resume at this step instead of the failing one (see
   *  `EscalationResolution.resumeAtStepId`). The broker records it; replay decides whether it is safe. */
  resumeAtStepId?: string;
  notes?: string;
  by: string;
}

/** Options passed to `SessionBroker.takeControl`. */
export interface TakeControlOptions {
  /**
   * Marks this round as held by a scripted (simulated) operator, not a real one. The lease
   * checker never expires a `human` round marked this way, because a scripted operator never
   * calls the heartbeat endpoint (see `SessionBrokerOptions.interventionLeaseMs`) and it resolves
   * far faster than any realistic lease, so an expiry here could only be a false positive.
   */
  scripted?: boolean;
}

/**
 * Test/production seam for the lease checker's periodic scan. Defaults to a real, `unref`'d
 * `setInterval`/`clearInterval`, so a live broker never keeps a process alive on its own. Inject
 * a manual scheduler (store the callback, invoke it directly) alongside a custom `clock` to drive
 * the checker deterministically in tests, without needing to fake global timers.
 */
export interface LeaseTimerHooks {
  setInterval(fn: () => void | Promise<void>, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

/** Configuration for `createSessionBroker`: the live surface to guard, where to log events, and the optional overrides below. */
export interface SessionBrokerOptions {
  /** The live session. The broker is the only thing that should hold the raw reference. */
  surface: Surface;
  logger: RunLogger;
  runId: string;
  runKind: RunKind;
  /** Defaults to `createInterventionStore({ runDir: logger.dir, redactor })`. */
  store?: InterventionStore;
  /**
   * The run's redactor (e.g. `createRunRedactor`: policy patterns plus the run's known values).
   * Applied to the data of every event this broker logs, before the logger's own redaction (skipped
   * when the logger already applies this same redactor, so events are redacted once), and to the
   * default store's on-disk copy. Defaults to `createRedactor()` for the store and to no extra
   * pass on events.
   */
  redactor?: Redactor;
  /** Default operator identity used when a call omits `by`. Default 'operator'. */
  operatorId?: string;
  /** Override the capture; defaults to `surface.humanCapture`. `null` disables capture explicitly. */
  capture?: HumanActionCapture | null;
  /** Shown to the operator: which browser window holds the live session (e.g. its title). */
  sessionLabel?: string;
  /** Default () => new Date(). */
  clock?: () => Date;
  /** How long takeControl waits for an in-flight automation `act` to settle, and the timeout for capture start/stop. Default 5000. */
  quiesceTimeoutMs?: number;
  /**
   * Registered secret values (resolved secrets, sensitive input values), read each time they are
   * needed so a value bound after `takeControl` still counts. Scrubbed (with their URL-encoded
   * forms) out of an escalation's `currentUrl`, reason, goal and context before the intervention
   * record is created, so none of them reach the store, `view()`/`views()` or the escalation
   * event; and out of a captured action's `url`, `target.name`/`target.selector`/non-input
   * `target.text`, as defense in depth against a capture that derives one of those fields from
   * something a human typed.
   */
  secretValues?: () => string[];
  /**
   * How long a `human` round may go without a heartbeat, or a `paused` (open) intervention may
   * sit with nobody taking control, before the lease checker acts. Default 900000 (15 minutes).
   * Scripted-operator rounds are exempt (see `TakeControlOptions.scripted`).
   */
  interventionLeaseMs?: number;
  /** How often the lease checker scans. Default `Math.min(interventionLeaseMs / 4, 5000)`. */
  leaseCheckIntervalMs?: number;
  /** Default: a real, `unref`'d `setInterval`/`clearInterval`. See `LeaseTimerHooks`. */
  leaseTimerHooks?: LeaseTimerHooks;
}

/** Everything the operator UI needs about one intervention. */
export interface InterventionView {
  intervention: Intervention;
  /** Accumulated across all rounds of this intervention, including the live (not yet handed back) round. */
  humanActions: HumanAction[];
  /** Automation's free-form context from the EscalationRequest (not part of the Intervention schema; also in the escalation event). */
  context?: Record<string, unknown>;
  /** Absolute path of the escalation screenshot, if one was persisted. */
  screenshotFile?: string;
  control: { state: ControlToken['state']; holder: ControlToken['holder']; interventionId?: string; terminated: boolean };
  captureMode: 'surface' | 'scripted' | 'none';
  sessionLabel?: string;
  /** Last re-verification failure reason, if the intervention was reopened. */
  reverifyFailure?: string;
  /** ISO timestamp of the most recent heartbeat for the current `human` round, if any (see `SessionBroker.recordHeartbeat`). */
  lastHeartbeatAt?: string;
  /** Set when the lease checker last returned this intervention to `paused` for want of a heartbeat; not part of the `Intervention` schema (see docs/design/handoff.md, "Known limits"). */
  leaseExpiredNote?: string;
}

/**
 * Runtime interface for one live session's human-in-the-loop control transfer: the guarded
 * surfaces, escalation, and the takeControl/handBack/abort/resumed transitions.
 */
export interface SessionBroker {
  readonly runId: string;
  readonly runKind: RunKind;
  /** Guarded wrapper. Automation (replay/agent) must use this and never the raw surface. */
  readonly surface: Surface;
  /** Live getter: reading it twice can give different answers. */
  readonly token: ControlToken;
  /** True after abort(): no further transitions; guarded act always refused; close() allowed. */
  readonly terminated: boolean;
  readonly escalate: EscalationHandler;
  readonly interventions: InterventionStore;
  readonly sessionLabel?: string;
  /** The intervention lease this broker enforces (`SessionBrokerOptions.interventionLeaseMs`, default 900000). Read-only. */
  readonly leaseMs: number;

  /** paused -> human. Waits for in-flight automation acts to settle, starts capture. */
  takeControl(interventionId: string, by?: string, opts?: TakeControlOptions): Promise<void>;
  /** human -> resuming. Stops capture, status resolved, resolves the pending escalation promise. */
  handBack(interventionId: string, input: HandBackInput): Promise<EscalationResolution>;
  /** paused|human|resuming -> terminal. Status abandoned, resolves with resumeFrom 'abort'. */
  abort(interventionId: string, by?: string, notes?: string): Promise<EscalationResolution>;
  /** Caller (replay/agent) re-verified the checkpoint: resuming -> automation. */
  resumed(interventionId?: string, by?: string): void;
  /** Caller's re-verification failed: resuming -> paused, intervention reopened (status open) with a note. */
  reverifyFailed(interventionId: string, reason: string, by?: string): void;
  /**
   * Records a heartbeat for the current `human` round of `interventionId`, resetting the lease
   * checker's anchor. Throws `IllegalControlTransitionError` unless state is `human` for exactly
   * this intervention. Called by Relay's heartbeat (every 5 s) while the operator holds control.
   */
  recordHeartbeat(interventionId: string): void;
  /** Every transition, after it is logged. Returns unsubscribe. */
  onTransfer(cb: (e: ControlTransferEvent) => void): () => void;
  /**
   * Fires once per human action accepted into a live round (capture or scripted operator), after
   * it is sanitized, stored and logged as a `human_action` event. Never fires for a dropped
   * (malformed) action. A throwing listener never breaks recording or other listeners. Returns
   * unsubscribe.
   */
  onHumanAction(listener: (e: HumanActionEvent) => void): () => void;
  /** Resolves on the next handBack/abort of the current round, or immediately with the last resolution if already resolved/abandoned. */
  waitForResolution(interventionId: string): Promise<EscalationResolution>;

  /** Operator-side surface: `act` allowed ONLY while state === 'human' for this intervention. Used by the scripted operator. */
  operatorSurface(interventionId: string): Surface;
  /**
   * Append a human action to the live round (only while state === 'human' for this intervention).
   * Sanitised to the HumanAction whitelist (a `value` key can never survive), logged as `human_action`.
   * Used by the capture callback and by the scripted operator when no real capture exists.
   */
  recordHumanAction(interventionId: string, action: HumanAction, source: 'capture' | 'scripted-operator'): void;
  view(interventionId: string): InterventionView;
  views(): InterventionView[];
  /** Fresh PNG of the live session (read-only). */
  liveScreenshot(): Promise<Buffer>;
  /** Stops the lease-checker interval. Idempotent. Call when this broker's live session is done. */
  dispose(): void;
}

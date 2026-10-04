/**
 * The one port Relay depends on: what a human-in-the-loop console needs from the core.
 *
 * Relay is a delivery adapter. Its HTTP app (app.ts) talks only to `RelayBrokerPort`, never to a
 * `SessionBroker`, Playwright, the agent or replay. `fromSessionBroker` (broker-adapter.ts) is the
 * only code that knows the core API; swapping the core means rewriting that one adapter.
 *
 * Values returned here carry only a run's own redaction (when it was registered with one; see
 * `BrokerAdapterOptions.redact`). The HTTP layer redacts every payload it sends on top.
 * Errors: implementations throw `PortNotFoundError` and `PortConflictError` (below), never the
 * core's own error classes, so the HTTP layer maps errors without importing the core.
 */
import type { CapturedAction, ControlState, InterventionDto, InterventionStatus, ResumeFrom, RunDto } from '../shared/api.js';

/** What changed. Carries ids only; the HTTP layer reads the fresh view when it publishes. */
export type PortChange =
  | { type: 'intervention'; change: 'created' | 'updated' | 'actions'; interventionId: string; runId: string }
  | { type: 'control'; runId: string; from: ControlState; to: ControlState; by: string; at: string; interventionId?: string }
  | { type: 'heartbeat'; runId: string; interventionId: string; at: string };

/** Input to `handBack`. */
export interface HandBackCommand {
  by: string;
  resumeFrom: ResumeFrom;
  /** Only with `current_step`: the step automation should resume at instead of the failing one.
   *  The run decides whether it is safe and asks again when it is not. */
  resumeAtStepId?: string;
  notes?: string;
}

/** Result of `handBack` and `abort`. */
export interface ResolutionResult {
  interventionId: string;
  resumeFrom: ResumeFrom | 'abort';
  resumeAtStepId?: string;
  notes?: string;
  by: string;
  humanActions: CapturedAction[];
}

/** Everything Relay needs from the core, for every live run it can see. */
export interface RelayBrokerPort {
  /** Every live run and its control state. */
  runs(): RunDto[];
  /** Control state of one run, or undefined when the run is unknown. */
  controlToken(runId: string): RunDto | undefined;
  /** Newest first. */
  listInterventions(filter?: { status?: InterventionStatus }): InterventionDto[];
  /** Undefined when unknown. */
  getIntervention(interventionId: string): InterventionDto | undefined;
  /** paused -> human. Resolves with the updated view once capture has started. */
  take(interventionId: string, by: string): Promise<InterventionDto>;
  /** human -> resuming. Resolves the escalation automation is awaiting. */
  handBack(interventionId: string, command: HandBackCommand): Promise<ResolutionResult>;
  /** Ends the run. Resolves the escalation with `resumeFrom: 'abort'`. */
  abort(interventionId: string, by: string, notes?: string): Promise<ResolutionResult>;
  /** Renews the lease of the current human round. Returns the new lease anchor. */
  heartbeat(interventionId: string, by?: string): { at: string; intervention: InterventionDto };
  /** Every intervention change, control transfer and heartbeat. Listeners run asynchronously
   *  (after the core finished the transition) and a throwing listener never breaks the core.
   *  Returns unsubscribe. */
  subscribe(listener: (change: PortChange) => void): () => void;
  /** PNG captured at escalation time; undefined when none was persisted. */
  escalationScreenshot(interventionId: string): Promise<Uint8Array | undefined>;
  /** Fresh PNG of the run's live session. Rejects with PortNotFoundError for an unknown run. */
  liveScreenshot(runId: string): Promise<Uint8Array>;
}

/** The intervention or run does not exist. HTTP 404. */
export class PortNotFoundError extends Error {
  override readonly name = 'PortNotFoundError';
  constructor(
    readonly kind: 'intervention' | 'run',
    readonly id: string,
  ) {
    super(`unknown ${kind} ${id}`);
  }
}

/** The control state machine refused the call. HTTP 409 with `state` in the body. */
export class PortConflictError extends Error {
  override readonly name = 'PortConflictError';
  constructor(
    readonly operation: string,
    readonly state: string,
    message: string,
  ) {
    super(message);
  }
}

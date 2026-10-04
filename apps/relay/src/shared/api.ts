/**
 * Relay's wire contract: the JSON the server sends and the UI reads, over REST and SSE.
 *
 * Types only, no runtime code and no imports, so the UI bundle and the server share one
 * definition without the UI ever depending on the core. The server adapter maps the core's
 * `InterventionView` into these shapes (see ../server/broker-adapter.ts).
 *
 * Naming rule: no serialized key may contain `token`, `secret`, `password`, `cookie`,
 * `authorization`, `apikey` or equal `pin`/`ssn`. The core redactor blanks any such key's value,
 * and Relay runs every payload through it.
 */

export type RunKind = 'discovery' | 'replay';
export type ControlState = 'automation' | 'paused' | 'human' | 'resuming';
export type Holder = 'automation' | 'human' | 'none';
export type InterventionStatus = 'open' | 'human_active' | 'resolved' | 'abandoned';
export type ReasonCode =
  | 'stuck'
  | 'risky_action_confirmation'
  | 'unrecoverable_condition'
  | 'policy_block'
  | 'max_steps'
  | 'unexpected_dialog';
export type ResumeFrom = 'current_step' | 'next_step';
export type CaptureMode = 'surface' | 'scripted' | 'none';

/** One hop from the top document towards a frame. `[]` is the top document. */
export interface FrameHop {
  name?: string;
  urlPattern?: string;
  index?: number;
}

/**
 * One action a human performed while holding control. There is no value field: the core never
 * stores what a human typed. For `type: 'input'` the UI shows a redaction marker and never
 * renders `target.text`, even if a faulty producer sent one.
 */
export interface CapturedAction {
  ts: string;
  type: 'click' | 'input' | 'keypress' | 'navigate' | 'submit';
  frame: FrameHop[];
  target: { tag?: string; role?: string; name?: string; text?: string; selector?: string };
  valueRedacted?: boolean;
  /** Key name for keypress actions ('Enter', 'Tab', 'Escape'). */
  key?: string;
  url?: string;
}

/** How an intervention ended. `abort` means the run was abandoned. */
export interface Resolution {
  by: string;
  at: string;
  notes?: string;
  resumeFrom: ResumeFrom | 'abort';
  /** Set when the hand-back named the step to resume at (with `current_step`). */
  resumeAtStepId?: string;
}

/** A step as automation names it to the console: id, and name when it has one. */
export interface RetryResumeStep {
  stepId: string;
  stepName?: string;
}

/**
 * `context.retryResume` on a replay intervention, set by automation when the failure is a lost
 * session, and fixed for that round. A hand-back of `current_step` that names no resume point (the
 * only retry this console sends) does not re-run just the failing step then: the run resumes at
 * `stepId`, the first step after the sign-in, because what the steps after the sign-in typed went
 * with the session; `repeats` lists the completed steps that are not reads and will run again.
 * `refused` is present when automation will not resume there, and says why (an irreversible step
 * in between was already carried out, `blockedBy`). `retryRuns` then says what a retry does
 * instead: the failing step alone (`failing_step`), or the success check again
 * (`success_check`); absent, the retry is refused outright because the failing step itself
 * already ran. The UI reads it to say what "retry" will do.
 */
export interface RetryResumeHint extends RetryResumeStep {
  repeats?: RetryResumeStep[];
  refused?: string;
  blockedBy?: RetryResumeStep;
  retryRuns?: 'failing_step' | 'success_check';
}

/** One hop of the control state machine, as observed by Relay. */
export interface TimelineEntry {
  from: ControlState;
  to: ControlState;
  by: string;
  at: string;
}

/** The intervention lease while a human holds control: expires `ms` after `anchorAt`. */
export interface LeaseInfo {
  ms: number;
  /** Last heartbeat, or the moment control was taken when no heartbeat arrived yet. */
  anchorAt: string;
  expiresAt: string;
}

/** Everything the UI needs about one intervention. */
export interface InterventionDto {
  id: string;
  runId: string;
  runKind: RunKind;
  capabilityId?: string;
  goal?: string;
  stepId?: string;
  reason: { code: ReasonCode; message: string };
  currentUrl?: string;
  createdAt: string;
  status: InterventionStatus;
  resolution?: Resolution;
  /** True when an escalation screenshot exists (`GET /api/interventions/:id/screenshot`). */
  hasScreenshot: boolean;
  /** Automation's free-form context. `expected` and `observed` are shown side by side when present. */
  context?: Record<string, unknown>;
  /** Accumulated across all rounds, including the live one. */
  humanActions: CapturedAction[];
  captureMode: CaptureMode;
  /** Title of the browser window that holds the live session. */
  sessionLabel?: string;
  /** Operator name that took control of the current round, while status is `human_active`. */
  heldBy?: string;
  lastHeartbeatAt?: string;
  /** Present while status is `human_active`. */
  lease?: LeaseInfo;
  /** Control hops for this intervention, oldest first. */
  timeline: TimelineEntry[];
  /** Set when automation could not verify the page after a hand-back and reopened the intervention. */
  reverifyFailure?: string;
  /** Set when the lease expired and control returned to `paused`. */
  leaseExpiredNote?: string;
}

/** One live run and who holds its session. */
export interface RunDto {
  runId: string;
  runKind: RunKind;
  state: ControlState;
  holder: Holder;
  /** The intervention the control state refers to, if any. */
  interventionId?: string;
  terminated: boolean;
  sessionLabel?: string;
  /** Lease length for a human round in this run. */
  leaseMs: number;
  /** Capability of the run's most recent intervention (replay runs). */
  capabilityId?: string;
  /** Goal of the run's most recent intervention (discovery runs). */
  goal?: string;
}

/** `GET /api/runs`. */
export interface RunsResponse {
  runs: RunDto[];
}

/** `GET /api/interventions`. Newest first. */
export interface InterventionsResponse {
  interventions: InterventionDto[];
  /** Id of the newest SSE event at the time of this snapshot; pass as `lastEventId` to `/api/events`. */
  lastEventId: string;
}

/** Inlined into `GET /` as `<script id="relay-bootstrap" type="application/json">`. */
export interface Bootstrap {
  runs: RunDto[];
  interventions: InterventionDto[];
  lastEventId: string;
  serverTime: string;
}

/** `POST /api/interventions/:id/handback` and `/abort` respond with this. */
export interface ResolutionResponse {
  interventionId: string;
  resumeFrom: ResumeFrom | 'abort';
  resumeAtStepId?: string;
  notes?: string;
  by: string;
  humanActions: CapturedAction[];
}

/** `POST /api/interventions/:id/heartbeat`. */
export interface HeartbeatResponse {
  interventionId: string;
  at: string;
  lease: LeaseInfo;
}

/** Every non-2xx response. `state` is present on 409 (the control state that refused the call). */
export interface ApiError {
  error: { code: ApiErrorCode; message: string; state?: string };
}

export type ApiErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'payload_too_large'
  | 'unavailable'
  | 'internal';

// ---- Server-Sent Events (`GET /api/events`) -------------------------------------------------
//
// Each message: `id: <bootId>.<seq>`, `event: <type>`, `data: <JSON of the matching payload>`.
// A client reconnecting with `Last-Event-ID` (header) or `?lastEventId=` (query) receives every
// buffered event after that id. When the id is unknown (older than the 500-event ring buffer, or
// from a previous server process) the server sends one `reset` event instead and the client
// refetches `/api/runs` and `/api/interventions`. A `: keep-alive` comment goes out every 15 s.

/** `event: intervention`. Sent on every store change and every new captured action. */
export interface InterventionEvent {
  change: 'created' | 'updated' | 'actions';
  intervention: InterventionDto;
}

/** `event: control`. Sent on every control transfer. */
export interface ControlEvent {
  from: ControlState;
  to: ControlState;
  by: string;
  at: string;
  interventionId?: string;
  run: RunDto;
}

/** `event: heartbeat`. Sent when an operator's heartbeat is recorded. */
export interface HeartbeatEvent {
  runId: string;
  interventionId: string;
  at: string;
  lease: LeaseInfo;
}

/** `event: reset`. The client's position is unknown; refetch the snapshot. */
export interface ResetEvent {
  reason: 'unknown_event_id' | 'buffer_overflow';
}

export interface RelayEventMap {
  intervention: InterventionEvent;
  control: ControlEvent;
  heartbeat: HeartbeatEvent;
  reset: ResetEvent;
}
export type RelayEventType = keyof RelayEventMap;

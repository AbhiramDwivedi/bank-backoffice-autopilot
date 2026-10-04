/**
 * Shared handoff interfaces for the control-transfer seam between automation and a human
 * operator.
 *
 * The replay executor and the discovery agent never know how a human is reached. They call an
 * `EscalationHandler` and await a resolution. The SessionBroker (packages/core/src/session) implements the
 * handler: it flips the control token, exposes the live session to the operator surface,
 * captures what the human does, and resumes. Tests use a scripted handler.
 */
import type { ControlState, HumanAction, Intervention } from '../schema/index.js';

/** What automation knows when it gives up. Everything the operator needs to act. */
export type EscalationRequest = Pick<Intervention, 'runId' | 'runKind' | 'capabilityId' | 'goal' | 'stepId' | 'reason'> & {
  /** PNG of the live session at the moment of escalation; the handler persists it. */
  screenshotPng?: Buffer;
  currentUrl?: string;
  /** Free text the automation adds: expected vs observed, last actions, etc. */
  context?: Record<string, unknown>;
};

/** What happened after an intervention was resolved: how automation should resume, what the human did, and who resolved it. */
export interface EscalationResolution {
  interventionId: string;
  resumeFrom: 'current_step' | 'next_step' | 'abort';
  /**
   * Only with `resumeFrom: 'current_step'`: resume by running THIS step (an id of the capability as
   * the run executes it) and continue from there, instead of re-running the failing one. Used to
   * rebuild page state an earlier step created and a lost session destroyed (a typed form field).
   * Replay decides whether it is safe and refuses it otherwise (docs/design/replay.md, "Resuming at
   * another step"); a consumer that does not know the field (discovery) sees a plain `current_step`.
   */
  resumeAtStepId?: string;
  notes?: string;
  humanActions: HumanAction[];
  by: string;
}

/**
 * Blocks until a human (or scripted operator) resolves the intervention. Automation must not
 * touch the surface while this promise is pending: control belongs to the human.
 */
export type EscalationHandler = (req: EscalationRequest) => Promise<EscalationResolution>;

/** Who holds the session. Exposed so callers (and tests) can assert on control transfer. */
export interface ControlToken {
  readonly state: ControlState;
  readonly holder: 'automation' | 'human' | 'none';
  readonly interventionId?: string;
}

/** One recorded step in the control-transfer state machine, logged for every transition. */
export interface ControlTransferEvent {
  from: ControlState;
  to: ControlState;
  interventionId?: string;
  by: string;
  at: string;
}

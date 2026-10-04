import { z } from 'zod';
import { IsoDateTime, NonEmpty } from './common.js';
import { FramePath } from './locator.js';
import { RunKind } from './run-event.js';

/**
 * automation -> paused (escalation raised) -> human (operator takes control)
 * human -> resuming (operator hands back) -> automation (checkpoint re-verified) | paused (re-verify failed)
 * any -> aborted terminal via intervention status 'abandoned'
 */
export const ControlState = z.enum(['automation', 'paused', 'human', 'resuming']);
export type ControlState = z.infer<typeof ControlState>;

/** One user action captured while a human has control, for replay's audit trail. */
export const HumanAction = z.strictObject({
  ts: IsoDateTime,
  type: z.enum(['click', 'input', 'keypress', 'navigate', 'submit']),
  frame: FramePath,
  target: z.strictObject({
    tag: z.string().optional(),
    role: z.string().optional(),
    name: z.string().optional(),
    text: z.string().optional(),
    selector: z.string().optional(),
  }),
  /** Inputs are never stored in plaintext. */
  valueRedacted: z.boolean().optional(),
  /** Key name for keypress actions ('Enter', 'Tab', 'Escape'). */
  key: z.string().optional(),
  url: z.string().optional(),
});
export type HumanAction = z.infer<typeof HumanAction>;

/** Why an intervention was raised. */
export const InterventionReasonCode = z.enum([
  'stuck',
  'risky_action_confirmation',
  'unrecoverable_condition',
  'policy_block',
  'max_steps',
  'unexpected_dialog',
]);
export type InterventionReasonCode = z.infer<typeof InterventionReasonCode>;

/** Lifecycle state of an {@link Intervention}. */
export const InterventionStatus = z.enum(['open', 'human_active', 'resolved', 'abandoned']);
export type InterventionStatus = z.infer<typeof InterventionStatus>;

/** A request for a human to take over a run, and, once resolved, how they resolved it. */
export const Intervention = z
  .strictObject({
    id: NonEmpty,
    runId: NonEmpty,
    runKind: RunKind,
    capabilityId: z.string().optional(),
    goal: z.string().optional(),
    stepId: z.string().optional(),
    reason: z.strictObject({ code: InterventionReasonCode, message: z.string() }),
    screenshotPath: z.string().optional(),
    currentUrl: z.string().optional(),
    createdAt: IsoDateTime,
    status: InterventionStatus,
    resolution: z
      .strictObject({
        by: NonEmpty,
        at: IsoDateTime,
        notes: z.string().optional(),
        humanActions: z.array(HumanAction),
        resumeFrom: z.enum(['current_step', 'next_step', 'abort']),
        /** With `current_step` only: the step replay was asked to resume at instead of the failing one. */
        resumeAtStepId: NonEmpty.optional(),
      })
      .optional(),
  })
  .meta({ id: 'Intervention' });
export type Intervention = z.infer<typeof Intervention>;

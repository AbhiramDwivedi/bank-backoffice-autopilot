/**
 * The scripted (simulated) operator.
 *
 * This module SIMULATES a human for automated tests and for the unattended evidence run: there
 * is no person at a keyboard here, only a script deciding what to click and type. Everything it
 * does is labelled `by: 'scripted-operator'` on every control transfer and `source:
 * 'scripted-operator'` on every recorded `HumanAction` -- nothing it produces is allowed to look
 * like a real operator did it.
 *
 * Despite being simulated, it acts through the *operator-side* surface
 * (`broker.operatorSurface(interventionId)`) on the same live session automation was driving, via
 * the broker's real `takeControl` / `handBack` / `abort` transitions. It never gets a shortcut
 * around the control-transfer guard, so it exercises exactly the same path a real operator's
 * browser session would: it cannot act until it holds the token, and every action it takes is
 * gated the same way a human's would be.
 *
 * `ScriptedOperatorContext.surface` is the *operator-guarded* surface, not the raw one, so that
 * even this simulated human cannot act unless it currently holds the control token for its
 * intervention.
 */
import {
  DEFAULT_STEP_TIMEOUT_MS,
  type FramePath,
  type HumanAction,
  type Intervention,
  type TargetDescriptor,
} from '../schema/index.js';
import { isRefTarget, type ActResult, type Observation, type ResolvedTarget, type Surface, type SurfaceAction } from '../surface/index.js';
import type { SessionBroker } from './broker-api.js';

/** What the script gets for one round of handling an open intervention. */
export interface ScriptedOperatorContext {
  intervention: Intervention;
  /** Operator-side surface for this intervention: acts only while the operator holds control. */
  surface: Surface;
  /** Performs the action on the same live surface AND records it as a HumanAction when the surface has no real capture. */
  act(action: SurfaceAction, timeoutMs?: number): Promise<ActResult>;
  observe(): Promise<Observation>;
  round: number; // 1 for first attempt, 2+ after reverifyFailed reopened it
}

/** What the script decided to do with the intervention: hand control back (optionally noting how automation should resume) or abort the run. */
export interface ScriptedOperatorResult {
  resumeFrom: 'current_step' | 'next_step' | 'abort';
  /** Only with `current_step`: the step to resume at (see `EscalationResolution.resumeAtStepId`). */
  resumeAtStepId?: string;
  notes?: string;
}

/** Configuration for `scriptedOperator`: the broker to drive, the script that plays the human, and limits on how many rounds it will handle. */
export interface ScriptedOperatorOptions {
  broker: SessionBroker;
  /** Identity used for takeControl/handBack/abort. Default 'scripted-operator'. */
  by?: string;
  script: (ctx: ScriptedOperatorContext) => Promise<ScriptedOperatorResult>;
  /** Stop handling an intervention after this many rounds (then abort it). Default 3. */
  maxRounds?: number;
  /** Whether the scripted operator should record actions itself. Default: auto = true iff the broker's view says captureMode !== 'surface'. */
  recordActions?: boolean;
}

/** Handle returned by `scriptedOperator` for stopping it and inspecting what it has handled. */
export interface ScriptedOperatorHandle {
  stop(): void;
  /** Resolves once all in-flight handling has finished. */
  idle(): Promise<void>;
  handled(): string[];
  /** Errors swallowed while handling interventions, newest last. */
  errors(): ReadonlyArray<{ interventionId: string; message: string }>;
}

const DEFAULT_MAX_ROUNDS = 3;
const DEFAULT_BY = 'scripted-operator';

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type HumanActionTarget = HumanAction['target'];

function snapshotToTarget(snapshot: NonNullable<TargetDescriptor['snapshot']>): HumanActionTarget {
  return { tag: snapshot.tag, role: snapshot.role, name: snapshot.name, text: snapshot.text };
}

/** Walks `descriptor.locators` in order and maps the first locator of a kind this whitelist
 * understands (role / label / text / css) to a HumanAction target. `relative` and `bbox`
 * locators carry nothing translatable and are skipped. */
function firstLocatorTarget(descriptor: TargetDescriptor): HumanActionTarget {
  for (const locator of descriptor.locators) {
    const s = locator.strategy;
    switch (s.kind) {
      case 'role':
        return { role: s.role, name: s.name };
      case 'label':
        return { name: s.label };
      case 'text':
        return { text: s.text };
      case 'css':
        return { selector: s.selector };
      default:
        continue;
    }
  }
  return {};
}

/** Resolves a `ResolvedTarget` (a `{ref}` from an observation, or a replay-style
 * `TargetDescriptor`) into a HumanAction target + frame. For a ref, prefers the most recent
 * observation made through `ctx.observe()`; falls back to `surface.describeRef` when available;
 * frame is the observed element's frame, or `[]` when only `describeRef` is available (which
 * carries no FramePath) or nothing at all. */
async function resolveTargetInfo(
  resolvedTarget: ResolvedTarget,
  surface: Surface,
  lastObservation: Observation | undefined,
): Promise<{ target: HumanActionTarget; frame: FramePath }> {
  if (isRefTarget(resolvedTarget)) {
    const observed = lastObservation?.elements.find((e) => e.ref === resolvedTarget.ref);
    if (observed) {
      return {
        target: { tag: observed.tag, role: observed.role, name: observed.name, text: observed.text },
        frame: observed.frame,
      };
    }
    const described = await surface.describeRef?.(resolvedTarget.ref);
    if (described) {
      return { target: { tag: described.tag, role: described.role, name: described.name, text: described.text }, frame: [] };
    }
    return { target: {}, frame: [] };
  }
  const descriptor = resolvedTarget;
  const target = descriptor.snapshot ? snapshotToTarget(descriptor.snapshot) : firstLocatorTarget(descriptor);
  return { target, frame: descriptor.frame };
}

/**
 * Maps one `SurfaceAction` (already performed, successfully) to the `HumanAction` that should be
 * recorded for it, or `undefined` when the action type is not human-visible input.
 *
 * click -> 'click'; type/select -> 'input' (`valueRedacted: true`, no `value` anywhere -- the
 * bound value is never read here); press -> 'keypress' (the HumanAction schema has no `key`
 * field, so nothing is recorded about which key); navigate -> 'navigate' with `url` = the
 * action's own destination url; dismiss_dialog -> 'click' on a synthetic `{role: 'dialog', name:
 * 'accept'|'dismiss'}` target. wait/extract/switch_frame are not human-visible input and return
 * undefined. `url` is otherwise `await surface.currentUrl()` taken *after* the act.
 */
async function buildHumanAction(action: SurfaceAction, surface: Surface, lastObservation: Observation | undefined): Promise<HumanAction | undefined> {
  const ts = new Date().toISOString();

  if (action.type === 'wait' || action.type === 'extract' || action.type === 'switch_frame') {
    return undefined;
  }

  if (action.type === 'navigate') {
    return { ts, type: 'navigate', frame: [], target: {}, url: action.url };
  }

  const url = await surface.currentUrl();

  if (action.type === 'press') {
    return { ts, type: 'keypress', frame: [], target: {}, url };
  }

  if (action.type === 'dismiss_dialog') {
    return { ts, type: 'click', frame: [], target: { role: 'dialog', name: action.accept ? 'accept' : 'dismiss' }, url };
  }

  // click / type / select: all three carry a ResolvedTarget.
  const { target, frame } = await resolveTargetInfo(action.target, surface, lastObservation);
  if (action.type === 'click') {
    return { ts, type: 'click', frame, target, url };
  }
  // type / select
  return { ts, type: 'input', frame, target, valueRedacted: true, url };
}

/**
 * Subscribes to the broker's open interventions and drives each one through `opts.script`,
 * simulating a human operator end to end (takeControl, act through the operator surface,
 * handBack or abort). Keeps running until `stop()` is called.
 */
export function scriptedOperator(opts: ScriptedOperatorOptions): ScriptedOperatorHandle {
  const by = opts.by ?? DEFAULT_BY;
  const maxRounds = opts.maxRounds ?? DEFAULT_MAX_ROUNDS;

  let stopped = false;
  /** Guards against queuing a second `setTimeout` for the same still-open notification burst;
   * cleared the instant the timer fires (not when handling finishes) -- see `schedule()`. */
  const pendingTimer = new Set<string>();
  /** Every currently-scheduled-or-running handling promise, for `idle()`. Not keyed: nothing here
   * needs to look one up, only to wait for all of them. */
  const inFlightPromises = new Set<Promise<void>>();
  const roundsSeen = new Map<string, number>();
  const handledSet = new Set<string>();
  const errorsList: { interventionId: string; message: string }[] = [];

  async function tryAbort(interventionId: string, notes: string): Promise<void> {
    try {
      await opts.broker.abort(interventionId, by, notes);
    } catch (err) {
      errorsList.push({ interventionId, message: `abort also failed: ${errMessage(err)}` });
    }
  }

  async function handleIntervention(interventionId: string): Promise<void> {
    // The subscribe notification that scheduled this can fire *before* the broker finishes
    // flipping its token to 'paused' for this intervention (e.g. `escalate()` notifies the store
    // before it sets `state`/`current`) -- that's fine, because the token is only actually
    // inspected here, inside the deferred (setTimeout) continuation, by which point the broker's
    // synchronous transition has always finished. Re-check both the token and the intervention's
    // current status now, and bail out quietly on a stale/superseded notification instead of
    // consuming a round.
    const token = opts.broker.token;
    if (token.state !== 'paused' || token.interventionId !== interventionId) return;
    const precheck = opts.broker.interventions.get(interventionId);
    if (!precheck || precheck.status !== 'open') return;

    const round = (roundsSeen.get(interventionId) ?? 0) + 1;
    roundsSeen.set(interventionId, round);

    if (round > maxRounds) {
      await tryAbort(interventionId, `scripted operator: exceeded maxRounds (${maxRounds}) at round ${round}`);
      handledSet.add(interventionId);
      return;
    }

    let scriptResult: ScriptedOperatorResult;
    try {
      // Marks this round exempt from the intervention lease: a scripted operator never calls the
      // heartbeat endpoint (there is no browser polling it), and resolves far faster than any
      // realistic lease, so the lease checker must never treat it as an abandoned human round.
      await opts.broker.takeControl(interventionId, by, { scripted: true });

      const surface = opts.broker.operatorSurface(interventionId);
      let lastObservation: Observation | undefined;

      const view = opts.broker.view(interventionId);
      const recordActions = opts.recordActions ?? view.captureMode !== 'surface';

      const act = async (action: SurfaceAction, timeoutMs: number = DEFAULT_STEP_TIMEOUT_MS): Promise<ActResult> => {
        const result = await surface.act(action, timeoutMs);
        // Only record actions that actually happened -- a failed act isn't something the human
        // did, it's something the human tried and the app refused/errored on.
        if (recordActions && result.ok) {
          const humanAction = await buildHumanAction(action, surface, lastObservation);
          if (humanAction) opts.broker.recordHumanAction(interventionId, humanAction, 'scripted-operator');
        }
        return result;
      };

      const observe = async (): Promise<Observation> => {
        const obs = await surface.observe();
        lastObservation = obs;
        return obs;
      };

      const intervention = opts.broker.interventions.get(interventionId);
      if (!intervention) throw new Error(`intervention ${interventionId} vanished after takeControl`);

      const ctx: ScriptedOperatorContext = { intervention, surface, act, observe, round };
      scriptResult = await opts.script(ctx);
    } catch (err) {
      const message = errMessage(err);
      errorsList.push({ interventionId, message });
      await tryAbort(interventionId, `scripted operator failed: ${message}`);
      handledSet.add(interventionId);
      return;
    }

    try {
      if (scriptResult.resumeFrom === 'abort') {
        await opts.broker.abort(interventionId, by, scriptResult.notes);
      } else {
        await opts.broker.handBack(interventionId, {
          resumeFrom: scriptResult.resumeFrom,
          ...(scriptResult.resumeAtStepId !== undefined ? { resumeAtStepId: scriptResult.resumeAtStepId } : {}),
          notes: scriptResult.notes,
          by,
        });
      }
    } catch (err) {
      const message = errMessage(err);
      errorsList.push({ interventionId, message });
      await tryAbort(interventionId, `scripted operator failed: ${message}`);
    }
    handledSet.add(interventionId);
  }

  function schedule(interventionId: string): void {
    if (stopped) return;
    // De-duplicates a burst of synchronous notifications for the same still-open status (at most
    // one queued timer per intervention at a time). This is NOT "don't start a new round while a
    // previous one is still settling" -- by the time a later notification's timer could fire, the
    // broker's status/token will already have moved on (checked inside `handleIntervention`), so a
    // round-2 (reverifyFailed) notification arriving while round 1's promise chain is still
    // unwinding must still get its own timer.
    if (pendingTimer.has(interventionId)) return;
    pendingTimer.add(interventionId);
    let settle!: () => void;
    const p = new Promise<void>((resolve) => {
      settle = resolve;
    });
    inFlightPromises.add(p);
    setTimeout(() => {
      pendingTimer.delete(interventionId);
      // Never run broker transitions inside the store's subscribe callback; this timer is what
      // moves execution out of that synchronous notification.
      void handleIntervention(interventionId).finally(() => {
        inFlightPromises.delete(p);
        settle();
      });
    }, 0);
  }

  const unsubscribe = opts.broker.interventions.subscribe((intervention) => {
    if (stopped) return;
    if (intervention.runId !== opts.broker.runId) return;
    if (intervention.status !== 'open') return;
    // Deliberately NOT checking `broker.token` here: this callback runs synchronously inside the
    // store's notify(), which can fire before the broker has finished flipping its token for this
    // very change (see `handleIntervention`). The token is re-checked there, once execution is
    // safely past the synchronous transition, via the setTimeout(0) below.
    schedule(intervention.id);
  });

  return {
    stop(): void {
      stopped = true;
      unsubscribe();
    },
    async idle(): Promise<void> {
      while (inFlightPromises.size > 0) {
        await Promise.allSettled([...inFlightPromises]);
      }
    },
    handled(): string[] {
      return [...handledSet];
    },
    errors(): ReadonlyArray<{ interventionId: string; message: string }> {
      return [...errorsList];
    },
  };
}

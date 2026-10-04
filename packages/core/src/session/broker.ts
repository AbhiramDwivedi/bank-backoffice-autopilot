/**
 * SessionBroker: the control-transfer state machine for human-in-the-loop escalation.
 *
 * One live `Surface` (one browser session) belongs to one broker. Automation only ever sees
 * `broker.surface`, a guarded wrapper that refuses to act (and to `resolve`) unless
 * `state === 'automation'`; the operator only ever sees `broker.operatorSurface(id)`, gated the
 * same way for `state === 'human'` on the current intervention. Neither wrapper is a `Proxy`:
 * both are explicit objects, so a `Surface` method neither one forwards fails closed.
 *
 *   automation --escalate()--> paused --takeControl()--> human --handBack()--> resuming
 *        ^                       ^                                              |
 *        |                       +----------------reverifyFailed()--------------+
 *        +-----------------------------------resumed()--------------------------+
 *
 *   abort() from paused | human | resuming -> terminal (terminated=true, state stays 'paused').
 *
 * Every transition logs a `control_transfer` event before `onTransfer` listeners run (listener
 * exceptions are swallowed, so one bad listener can't break a transition). `takeControl`/
 * `handBack`/`abort` hold a transition lock for their whole duration; a concurrent call throws
 * `IllegalControlTransitionError` rather than racing. Nothing a human typed is ever stored:
 * `recordHumanAction` rebuilds every action from the `HumanAction` whitelist and scrubs every
 * registered secret value out of the surviving identity fields and URL. An escalation's text
 * fields are scrubbed of the same values before its record is created, and every event this
 * broker logs goes through `SessionBrokerOptions.redactor` when one is given.
 */
import path from 'node:path';
import { createValueScrubber, newInterventionId, type RunLogger, type ValueScrubber } from '../evidence/index.js';
import type { ControlState, Intervention, RunKind } from '../schema/index.js';
import { HumanAction } from '../schema/index.js';
import { createInterventionStore } from './store.js';
import { IllegalControlTransitionError, UnknownInterventionError } from './broker-api.js';
import type {
  HandBackInput,
  HumanActionEvent,
  InterventionStore,
  InterventionView,
  LeaseTimerHooks,
  SessionBroker,
  SessionBrokerOptions,
  TakeControlOptions,
} from './broker-api.js';
import type { ControlToken, ControlTransferEvent, EscalationHandler, EscalationResolution } from './types.js';
import type { HumanActionCapture, Surface } from '../surface/index.js';

/** Per-intervention bookkeeping the broker keeps outside the (schema-constrained) store record. */
interface SideRecord {
  /** Automation's free-form context from the `EscalationRequest`. Never part of the Intervention schema. */
  context?: Record<string, unknown>;
  /** Accumulated across every round of this intervention's life, including the live round. */
  humanActions: HumanAction[];
  /** The pending round's deferred; undefined once resolved (handBack/abort) until reverifyFailed starts a new one. */
  deferred?: { promise: Promise<EscalationResolution>; resolve: (r: EscalationResolution) => void };
  lastResolution?: EscalationResolution;
  reverifyFailure?: string;
  captureMode: 'surface' | 'scripted' | 'none';
  /** True from just before `capture.start()` is called until capture is stopped; bridges the race
   *  between starting capture and flipping `state` to 'human' (see `recordHumanAction`). */
  capturing: boolean;
  captureHandle?: HumanActionCapture;
  /** ISO timestamp of the most recent `takeControl()` for the live `human` round. Unset once the round ends. */
  tookControlAt?: string;
  /** ISO timestamp of the most recent heartbeat for the live `human` round. Unset once the round ends. */
  lastHeartbeatAt?: string;
  /** ISO timestamp of the most recent moment this intervention became (or re-became) `paused` with
   *  status `open`: set by escalate, reverifyFailed, and a lease expiry's return to paused. Anchors
   *  the "nobody took control" lease. */
  pausedSinceAt?: string;
  /** True while the live `human` round is held by a scripted (simulated) operator (see
   *  `TakeControlOptions.scripted`); exempts this round from the human lease. */
  scripted?: boolean;
  /** Set when the lease checker last returned this intervention to `paused` for want of a heartbeat. */
  leaseExpiredNote?: string;
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function holderFor(state: ControlState): 'automation' | 'human' | 'none' {
  switch (state) {
    case 'automation':
      return 'automation';
    case 'human':
      return 'human';
    case 'paused':
    case 'resuming':
      return 'none';
  }
}

/** Bounds every string that goes from a captured action into evidence. */
const MAX_TARGET_FIELD = 300;
function capString(v: string, max = MAX_TARGET_FIELD): string {
  return v.length <= max ? v : `${v.slice(0, max)}…[truncated ${v.length - max}]`;
}

/** Ignore a registered "secret" shorter than this: matching it would flag ordinary short words. */
const SECRET_SCRUB_MIN_LENGTH = 3;

/** Target fields a captured action's identity is built from that are never derived from a typed
 *  value by the real capture, but are scrubbed anyway as defense in depth against one that is. */
const SCRUBBED_TARGET_FIELDS = ['name', 'selector', 'text'] as const;

/** A keypress action's `key` is kept only when it names a key (`Enter`, `Tab`, `Escape`,
 *  `ArrowDown`, `F5`, `Backspace`), never a single printable character: a buggy capture sending
 *  `key: 'a'` per keystroke would otherwise leak typed text one character at a time. */
const NAMED_KEY_PATTERN = /^[A-Z][A-Za-z0-9]{1,31}$/;

/** Capture start/stop run under the transition lock; a hung capture must not wedge the broker. */
async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Shallow-plus-target copy so a listener mutating the event's `action` can never reach the copy
 *  stored in `rec.humanActions` (or the one already logged/persisted). */
function cloneHumanAction(a: HumanAction): HumanAction {
  return { ...a, target: { ...a.target } };
}

function mergeNotes(previous: string | undefined, next: string | undefined): string | undefined {
  if (previous !== undefined && next !== undefined) return `${previous}\n${next}`;
  return previous ?? next;
}

/**
 * Wraps `logger` so every event's data passes through `redactor` before the logger's own
 * redaction. Returns `logger` itself when it already applies that same redactor, so an event is
 * redacted exactly once.
 */
function redactingLogger(logger: RunLogger, redactor: (value: unknown) => unknown): RunLogger {
  if (logger.redactor === redactor) return logger;
  return {
    dir: logger.dir,
    runId: logger.runId,
    ...(logger.redactor !== undefined ? { redactor: logger.redactor } : {}),
    event: (e) => logger.event({ ...e, ...(e.data !== undefined ? { data: redactor(e.data) as Record<string, unknown> } : {}) }),
    screenshot: (buf, seq) => logger.screenshot(buf, seq),
    dom: (html, seq) => logger.dom(html, seq),
    finish: (result) => logger.finish(result),
  };
}

/** Default `interventionLeaseMs`: how long a human round may go unheartbeated, or an escalation
 *  may sit unattended, before the lease checker acts. 15 minutes. */
const DEFAULT_INTERVENTION_LEASE_MS = 15 * 60 * 1000;

/** `by` used for every lease-driven transition, so it is distinguishable in evidence from a real
 *  operator identity or the 'automation'/'scripted-operator' actors. */
const LEASE_CHECKER_ACTOR = 'lease-checker';

/** Real-timer default for `LeaseTimerHooks`: an `unref`'d `setInterval` so a live broker never
 *  keeps a process alive on its own. Cast defensively around `.unref()`: this project's tsconfig
 *  includes the DOM lib alongside `@types/node`, so the statically-inferred handle type is not
 *  guaranteed to carry `.unref`, even though the actual runtime value (this always runs under
 *  Node) does. */
const defaultLeaseTimerHooks: LeaseTimerHooks = {
  setInterval: (fn, ms) => {
    const handle = setInterval(fn, ms);
    (handle as unknown as { unref?: () => void }).unref?.();
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle as Parameters<typeof clearInterval>[0]),
};

/**
 * Builds a `SessionBroker` for one live `Surface`: the control-transfer state machine, the
 * guarded automation/operator surfaces, and the intervention store. See the module doc above for
 * the full transition table.
 */
export function createSessionBroker(opts: SessionBrokerOptions): SessionBroker {
  const surface = opts.surface;
  const logger = opts.redactor !== undefined ? redactingLogger(opts.logger, opts.redactor) : opts.logger;
  const runId = opts.runId;
  const runKind: RunKind = opts.runKind;
  const clock = opts.clock ?? (() => new Date());
  const quiesceTimeoutMs = opts.quiesceTimeoutMs ?? 5000;
  const captureTimeoutMs = quiesceTimeoutMs;
  const defaultOperatorId = opts.operatorId ?? 'operator';
  const store: InterventionStore =
    opts.store ?? createInterventionStore({ runDir: logger.dir, ...(opts.redactor !== undefined ? { redactor: opts.redactor } : {}) });
  const interventionLeaseMs = opts.interventionLeaseMs ?? DEFAULT_INTERVENTION_LEASE_MS;
  const leaseCheckIntervalMs = opts.leaseCheckIntervalMs ?? Math.min(interventionLeaseMs / 4, 5000);
  const leaseTimerHooks: LeaseTimerHooks = opts.leaseTimerHooks ?? defaultLeaseTimerHooks;

  let state: ControlState = 'automation';
  let current: string | undefined;
  let terminated = false;
  let lockHeld = false;
  let inFlightActs = 0;

  const sideRecords = new Map<string, SideRecord>();
  const transferListeners = new Set<(e: ControlTransferEvent) => void>();
  const humanActionListeners = new Set<(e: HumanActionEvent) => void>();

  /** A scrubber over the registered secret values as they are right now; undefined when there are none. */
  function secretScrubber(): ValueScrubber | undefined {
    const values = opts.secretValues?.() ?? [];
    return values.length > 0 ? createValueScrubber(values, { minLength: SECRET_SCRUB_MIN_LENGTH }) : undefined;
  }

  function requireSide(interventionId: string): SideRecord {
    const rec = sideRecords.get(interventionId);
    if (rec === undefined) throw new UnknownInterventionError(interventionId);
    return rec;
  }

  function illegal(operation: string, fromState: ControlState, message: string, interventionId?: string): IllegalControlTransitionError {
    return new IllegalControlTransitionError(operation, fromState, message, interventionId);
  }

  function logError(interventionId: string, message: string, err: unknown): void {
    logger.event({
      kind: 'error',
      stepId: store.get(interventionId)?.stepId,
      data: { interventionId, message, detail: err instanceof Error ? err.message : String(err) },
    });
  }

  function logTransfer(
    from: ControlState,
    to: ControlState,
    interventionId: string | undefined,
    by: string,
    extra?: { terminal?: boolean; reason?: string },
  ): void {
    const event: ControlTransferEvent = { from, to, interventionId, by, at: clock().toISOString() };
    const stepId = interventionId !== undefined ? store.get(interventionId)?.stepId : undefined;
    logger.event({
      kind: 'control_transfer',
      stepId,
      data: {
        ...event,
        ...(extra?.terminal === true ? { terminal: true } : {}),
        ...(extra?.reason !== undefined ? { reason: extra.reason } : {}),
      },
    });
    for (const cb of transferListeners) {
      try {
        cb(event);
      } catch {
        // A bad listener must not break the transition.
      }
    }
  }

  // --- escalation ------------------------------------------------------------------------------

  const escalate: EscalationHandler = async (req) => {
    if (terminated) throw illegal('escalate', state, 'the run has been terminated');
    if (state !== 'automation') {
      throw illegal('escalate', state, `escalate requires state 'automation', got '${state}'`);
    }
    if (req.runId !== runId) {
      throw illegal('escalate', state, `escalation for run '${req.runId}' sent to the broker of run '${runId}'`);
    }

    // Reserve control synchronously, before any await: from here on the guarded surface refuses
    // automation acts and a second escalate() throws, even while the screenshot is collected. The
    // lock keeps takeControl/abort off this id until the store record exists.
    const id = newInterventionId(clock());
    state = 'paused';
    current = id;
    lockHeld = true;
    let pending: Promise<EscalationResolution>;
    try {
      ({ pending } = await escalateReserved(req, id));
    } catch (err) {
      // No record was created: hand control back to automation rather than strand the token.
      if (store.get(id) === undefined && current === id) {
        state = 'automation';
        current = undefined;
      }
      throw err;
    } finally {
      lockHeld = false;
    }
    // Awaited by the caller outside the lock, so takeControl/abort can proceed.
    return pending;
  };

  /** Everything escalate does after control is reserved. Returns the round's promise wrapped, so it is not awaited under the lock. */
  async function escalateReserved(
    request: Parameters<EscalationHandler>[0],
    id: string,
  ): Promise<{ pending: Promise<EscalationResolution> }> {
    let req = request;
    let screenshotPng = req.screenshotPng;
    if (screenshotPng === undefined) {
      try {
        screenshotPng = await surface.screenshot();
      } catch {
        // No screenshot available; proceed without one.
      }
    }
    let currentUrl = req.currentUrl;
    if (currentUrl === undefined) {
      try {
        currentUrl = await surface.currentUrl();
      } catch {
        // No URL available; proceed without one.
      }
    }

    // The URL (a query string can carry a typed value), reason, goal and context are all shown to
    // the operator and written to evidence: none may carry a registered secret value.
    const scrubber = secretScrubber();
    if (scrubber !== undefined) {
      if (currentUrl !== undefined) currentUrl = scrubber.text(currentUrl);
      req = {
        ...req,
        reason: { ...req.reason, message: scrubber.text(req.reason.message) },
        ...(req.goal !== undefined ? { goal: scrubber.text(req.goal) } : {}),
        ...(req.context !== undefined ? { context: scrubber.deep(req.context) } : {}),
      };
    }

    const screenshotPath = screenshotPng !== undefined ? logger.screenshot(screenshotPng) : undefined;

    const createdAt = clock().toISOString();
    const record: Intervention = {
      id,
      runId: req.runId,
      runKind: req.runKind,
      ...(req.capabilityId !== undefined ? { capabilityId: req.capabilityId } : {}),
      ...(req.goal !== undefined ? { goal: req.goal } : {}),
      ...(req.stepId !== undefined ? { stepId: req.stepId } : {}),
      reason: req.reason,
      ...(screenshotPath !== undefined ? { screenshotPath } : {}),
      ...(currentUrl !== undefined ? { currentUrl } : {}),
      createdAt,
      status: 'open',
    };

    // The token already shows 'paused'/this id (reserved in escalate), so subscribers notified
    // synchronously by `store.create` (e.g. the scripted operator) see the new state.
    try {
      store.create(record);
    } catch (err) {
      // Nothing was actually created; don't leave the token pointed at a non-existent intervention.
      state = 'automation';
      current = undefined;
      throw err;
    }
    sideRecords.set(id, { context: req.context, humanActions: [], captureMode: 'none', capturing: false, pausedSinceAt: createdAt });

    logger.event({
      kind: 'escalation',
      stepId: req.stepId,
      data: { interventionId: id, reason: req.reason, capabilityId: req.capabilityId, goal: req.goal, currentUrl, context: req.context },
      ...(screenshotPath !== undefined ? { evidence: { screenshot: screenshotPath } } : {}),
    });

    // The control_transfer log line + onTransfer listener notification still happen here, after
    // the escalation event is on record.
    logTransfer('automation', 'paused', id, 'automation');

    const rec = requireSide(id);
    const deferred = createDeferred<EscalationResolution>();
    rec.deferred = deferred;
    return { pending: deferred.promise };
  }

  // --- take control ------------------------------------------------------------------------------

  async function waitForQuiesce(interventionId: string): Promise<void> {
    if (inFlightActs <= 0) return;
    const deadline = Date.now() + quiesceTimeoutMs;
    while (inFlightActs > 0) {
      if (Date.now() >= deadline) {
        throw illegal(
          'takeControl',
          state,
          `timed out after ${quiesceTimeoutMs}ms waiting for in-flight automation action(s) to settle`,
          interventionId,
        );
      }
      await sleep(10);
    }
  }

  async function takeControl(interventionId: string, by: string = defaultOperatorId, takeOpts: TakeControlOptions = {}): Promise<void> {
    if (terminated) throw illegal('takeControl', state, 'the run has been terminated', interventionId);
    if (current !== interventionId) {
      throw illegal('takeControl', state, `intervention '${interventionId}' is not the current intervention`, interventionId);
    }
    if (state !== 'paused') throw illegal('takeControl', state, `takeControl requires state 'paused', got '${state}'`, interventionId);
    if (lockHeld) throw illegal('takeControl', state, 'another control transition is already in progress', interventionId);

    lockHeld = true;
    try {
      await waitForQuiesce(interventionId);

      const rec = requireSide(interventionId);
      rec.capturing = true;

      const captureObj: HumanActionCapture | undefined = opts.capture === null ? undefined : (opts.capture ?? surface.humanCapture);
      if (captureObj !== undefined) {
        try {
          await withTimeout(captureObj.start((a) => {
            // Never throw into the surface's listener: a late event after stop is logged and dropped.
            try {
              recordHumanAction(interventionId, a, 'capture');
            } catch (err) {
              logError(interventionId, 'dropped human action received outside human control', err);
            }
          }), captureTimeoutMs, 'humanCapture.start()');
          rec.captureMode = 'surface';
          rec.captureHandle = captureObj;
        } catch (err) {
          logError(interventionId, 'failed to start human action capture', err);
          rec.captureMode = 'none';
          rec.captureHandle = undefined;
          // A start that timed out may still finish later and register its listener: stop it so it
          // cleans up whenever it does. Not awaited, since a hung start can hang stop() too.
          withTimeout(captureObj.stop(), captureTimeoutMs, 'humanCapture.stop()').catch((stopErr: unknown) => {
            try {
              logError(interventionId, 'failed to stop human action capture after a failed start', stopErr);
            } catch {
              // The run's logger has already finished; nothing is left to record into.
            }
          });
        }
      } else {
        rec.captureMode = 'none';
      }

      if (terminated || state !== 'paused' || current !== interventionId) {
        throw illegal('takeControl', state, 'control state changed unexpectedly while starting capture', interventionId);
      }

      rec.tookControlAt = clock().toISOString();
      rec.lastHeartbeatAt = undefined;
      rec.scripted = takeOpts.scripted === true;

      state = 'human';
      logTransfer('paused', 'human', interventionId, by);
      store.update(interventionId, (c) => ({ ...c, status: 'human_active' }));
    } finally {
      lockHeld = false;
    }
  }

  // --- capture / recording -----------------------------------------------------------------------

  async function stopCapture(rec: SideRecord, interventionId: string): Promise<void> {
    rec.capturing = false;
    const handle = rec.captureHandle;
    rec.captureHandle = undefined;
    if (handle === undefined) return;
    try {
      await withTimeout(handle.stop(), captureTimeoutMs, 'humanCapture.stop()');
    } catch (err) {
      logError(interventionId, 'failed to stop human action capture', err);
    }
  }

  /** Clears the lease bookkeeping for a `human` round that just ended (handBack, abort, or a lease
   *  expiry), so a stale anchor from a previous round can never affect the next one. */
  function endHumanRound(rec: SideRecord): void {
    rec.tookControlAt = undefined;
    rec.lastHeartbeatAt = undefined;
    rec.scripted = undefined;
  }

  /**
   * Records a heartbeat for the live `human` round, read by the lease checker below. Called by
   * Relay's HTTP API (`POST /api/interventions/:id/heartbeat`), which the Relay page hits every 5 s
   * while the operator holds control; a scripted operator never calls this (see
   * `TakeControlOptions.scripted`).
   */
  function recordHeartbeat(interventionId: string): void {
    if (terminated) throw illegal('heartbeat', state, 'the run has been terminated', interventionId);
    if (current !== interventionId || state !== 'human') {
      throw illegal('heartbeat', state, `heartbeat requires state 'human' for the current intervention, got '${state}'`, interventionId);
    }
    requireSide(interventionId).lastHeartbeatAt = clock().toISOString();
  }

  function recordHumanAction(interventionId: string, action: HumanAction, source: 'capture' | 'scripted-operator'): void {
    const rec = requireSide(interventionId);

    const acceptable =
      (state === 'human' && current === interventionId) || (rec.capturing && current === interventionId && state === 'paused');
    if (!acceptable) {
      throw illegal('recordHumanAction', state, 'operator does not hold control', interventionId);
    }

    // Rebuild from the whitelist only -- a `value` key can never survive, no matter what the
    // caller (real capture, fake capture, or scripted operator) put on the input object.
    const raw = action as unknown as Record<string, unknown>;
    const rawTarget = (raw.target ?? {}) as Record<string, unknown>;
    const sanitizedTarget: Record<string, string> = {};
    // For an `input` the element's text can be the typed value itself (a textarea, a capture that
    // reads the wrong property), so `text` is dropped for inputs: identify the field by
    // tag/role/name/selector only. Every kept string is capped so evidence stays bounded.
    const targetKeys = raw.type === 'input' ? (['tag', 'role', 'name', 'selector'] as const) : (['tag', 'role', 'name', 'text', 'selector'] as const);
    for (const key of targetKeys) {
      const v = rawTarget[key];
      if (typeof v === 'string') sanitizedTarget[key] = capString(v);
    }

    // `key` (keypress only): a named key only (Enter, Tab, Escape, ArrowDown, F5, Backspace, ...),
    // never a single printable character -- dropped silently otherwise (defense in depth: a buggy
    // capture sending `key: 'a'` per keystroke would leak typed text one character at a time).
    let sanitizedKey: string | undefined;
    if (raw.type === 'keypress' && typeof raw.key === 'string' && NAMED_KEY_PATTERN.test(raw.key)) {
      sanitizedKey = raw.key;
    }

    // Defense in depth: the real capture only ever derives name/selector/text from static element
    // identity, never from a typed value, but a broken or malicious Surface implementation might
    // not honor that. Scrub every registered secret value out of the identity fields anyway, and
    // out of the URL (a form submitted with GET puts what was typed into the query string). Built
    // fresh here (not at broker-construction time) so a secret bound after `takeControl` counts.
    const scrubber = secretScrubber();
    if (scrubber !== undefined) {
      for (const field of SCRUBBED_TARGET_FIELDS) {
        const v = sanitizedTarget[field];
        if (v !== undefined) sanitizedTarget[field] = scrubber.text(v);
      }
      // Unlike the identity fields above, `key` has no bounded identity payload worth keeping once
      // scrubbing has touched it: if it changed, it contained a registered secret, so drop it.
      if (sanitizedKey !== undefined && scrubber.text(sanitizedKey) !== sanitizedKey) {
        sanitizedKey = undefined;
      }
    }

    const candidate: Record<string, unknown> = {
      ts: raw.ts,
      type: raw.type,
      frame: raw.frame,
      target: sanitizedTarget,
    };
    if (typeof raw.url === 'string') candidate.url = capString(scrubber !== undefined ? scrubber.text(raw.url) : raw.url, 2000);
    if (raw.type === 'input') {
      candidate.valueRedacted = true;
    } else if (typeof raw.valueRedacted === 'boolean') {
      candidate.valueRedacted = raw.valueRedacted;
    }
    if (sanitizedKey !== undefined) candidate.key = sanitizedKey;

    const parsed = HumanAction.safeParse(candidate);
    if (!parsed.success) {
      logger.event({
        kind: 'error',
        stepId: store.get(interventionId)?.stepId,
        data: {
          interventionId,
          message: 'dropped malformed human action',
          issues: parsed.error.issues.map((issue) => issue.path.join('.')),
        },
      });
      return;
    }

    rec.humanActions.push(parsed.data);
    if (source === 'scripted-operator' && rec.captureMode === 'none') {
      rec.captureMode = 'scripted';
    }
    logger.event({
      kind: 'human_action',
      stepId: store.get(interventionId)?.stepId,
      data: { interventionId, source, action: parsed.data },
    });

    for (const cb of humanActionListeners) {
      try {
        cb({ interventionId, runId, source, action: cloneHumanAction(parsed.data) });
      } catch {
        // A bad listener must not break recording or other listeners.
      }
    }
  }

  // --- hand back / resume / reverify / abort -----------------------------------------------------

  async function handBack(interventionId: string, input: HandBackInput): Promise<EscalationResolution> {
    if (terminated) throw illegal('handBack', state, 'the run has been terminated', interventionId);
    if (current !== interventionId) {
      throw illegal('handBack', state, `intervention '${interventionId}' is not the current intervention`, interventionId);
    }
    if (state !== 'human') throw illegal('handBack', state, `handBack requires state 'human', got '${state}'`, interventionId);
    if (lockHeld) throw illegal('handBack', state, 'another control transition is already in progress', interventionId);
    // A resume point names the step to run instead of the failing one: it only means something
    // with current_step (next_step already says "the human did this step").
    const resumeAtStepId = input.resumeAtStepId;
    if (resumeAtStepId !== undefined && (input.resumeFrom !== 'current_step' || resumeAtStepId.length === 0)) {
      throw illegal('handBack', state, 'resumeAtStepId must be a non-empty step id and is only valid with resumeFrom current_step', interventionId);
    }

    lockHeld = true;
    try {
      const rec = requireSide(interventionId);
      await stopCapture(rec, interventionId);
      endHumanRound(rec);

      state = 'resuming';
      logTransfer('human', 'resuming', interventionId, input.by);

      const at = clock().toISOString();
      const updated = store.update(interventionId, (c) => {
        const notes = mergeNotes(c.resolution?.notes, input.notes);
        return {
          ...c,
          status: 'resolved',
          resolution: {
            by: input.by,
            at,
            ...(notes !== undefined ? { notes } : {}),
            humanActions: [...rec.humanActions],
            resumeFrom: input.resumeFrom,
            ...(resumeAtStepId !== undefined ? { resumeAtStepId } : {}),
          },
        };
      });

      const resolution: EscalationResolution = {
        interventionId,
        resumeFrom: input.resumeFrom,
        ...(resumeAtStepId !== undefined ? { resumeAtStepId } : {}),
        ...(updated.resolution?.notes !== undefined ? { notes: updated.resolution.notes } : {}),
        humanActions: [...rec.humanActions],
        by: input.by,
      };
      rec.lastResolution = resolution;
      rec.deferred?.resolve(resolution);
      rec.deferred = undefined;
      return resolution;
    } finally {
      lockHeld = false;
    }
  }

  function resumed(interventionId?: string, by = 'automation'): void {
    if (terminated) throw illegal('resumed', state, 'the run has been terminated', interventionId);
    if (state !== 'resuming') throw illegal('resumed', state, `resumed requires state 'resuming', got '${state}'`, interventionId);
    if (interventionId !== undefined && current !== interventionId) {
      throw illegal('resumed', state, `intervention '${interventionId}' is not the current intervention`, interventionId);
    }

    const id = current;
    state = 'automation';
    current = undefined;
    logTransfer('resuming', 'automation', id, by);
  }

  function reverifyFailed(interventionId: string, reason: string, by = 'automation'): void {
    if (terminated) throw illegal('reverifyFailed', state, 'the run has been terminated', interventionId);
    if (state !== 'resuming') throw illegal('reverifyFailed', state, `reverifyFailed requires state 'resuming', got '${state}'`, interventionId);
    if (current !== interventionId) {
      throw illegal('reverifyFailed', state, `intervention '${interventionId}' is not the current intervention`, interventionId);
    }

    state = 'paused';
    logTransfer('resuming', 'paused', interventionId, by, { reason });

    const at = clock().toISOString();
    store.update(interventionId, (c) => {
      const note = `[re-verification failed at ${at}: ${reason}]`;
      const resolution = c.resolution;
      if (resolution === undefined) return { ...c, status: 'open' };
      return { ...c, status: 'open', resolution: { ...resolution, notes: mergeNotes(resolution.notes, note) } };
    });

    const rec = requireSide(interventionId);
    rec.reverifyFailure = reason;
    rec.pausedSinceAt = at;
    rec.deferred = createDeferred<EscalationResolution>();
  }

  async function abort(interventionId: string, by: string = defaultOperatorId, notes?: string): Promise<EscalationResolution> {
    if (terminated) throw illegal('abort', state, 'the run has already been terminated', interventionId);
    if (current !== interventionId) {
      throw illegal('abort', state, `intervention '${interventionId}' is not the current intervention`, interventionId);
    }
    if (state !== 'paused' && state !== 'human' && state !== 'resuming') {
      throw illegal('abort', state, `abort requires state 'paused'|'human'|'resuming', got '${state}'`, interventionId);
    }
    if (lockHeld) throw illegal('abort', state, 'another control transition is already in progress', interventionId);

    lockHeld = true;
    try {
      const rec = requireSide(interventionId);
      const fromState = state;
      if (fromState === 'human') {
        await stopCapture(rec, interventionId);
        endHumanRound(rec);
      }

      // Flip before the store write, same reasoning as escalate(): store.update notifies
      // subscribers synchronously and they may read broker.token.
      terminated = true;
      state = 'paused';
      current = undefined;

      const at = clock().toISOString();
      const updated = store.update(interventionId, (c) => {
        const mergedNotes = mergeNotes(c.resolution?.notes, notes);
        return {
          ...c,
          status: 'abandoned',
          resolution: {
            by,
            at,
            ...(mergedNotes !== undefined ? { notes: mergedNotes } : {}),
            humanActions: [...rec.humanActions],
            resumeFrom: 'abort',
          },
        };
      });

      logTransfer(fromState, 'paused', interventionId, by, { terminal: true });

      const resolution: EscalationResolution = {
        interventionId,
        resumeFrom: 'abort',
        ...(updated.resolution?.notes !== undefined ? { notes: updated.resolution.notes } : {}),
        humanActions: [...rec.humanActions],
        by,
      };
      rec.lastResolution = resolution;
      if (rec.deferred) {
        rec.deferred.resolve(resolution);
        rec.deferred = undefined;
      }
      return resolution;
    } finally {
      lockHeld = false;
    }
  }

  // --- intervention lease ------------------------------------------------------------------------

  /**
   * `human` -> `paused`: the operator went silent (no heartbeat, and no `handBack`/`abort`) for
   * longer than `interventionLeaseMs`. Unlike `reverifyFailed`, this never runs through `resuming`:
   * the human never handed back a resume decision, so there is nothing for automation to
   * re-verify. The intervention reopens (status `open`) exactly where `reverifyFailed` leaves it,
   * with the same "keep the previous resolution, append a note" rule -- so if this is not the
   * first round, the note lands in `resolution.notes`; if it is (no `resolution` yet), the note is
   * only in the `control_transfer` event and `view().leaseExpiredNote`, not on the persisted
   * record (the `Intervention` schema has no room for a note outside `resolution`; see
   * docs/design/handoff.md "Known limits").
   */
  async function expireHumanLease(interventionId: string, elapsedMs: number): Promise<void> {
    if (lockHeld || terminated || state !== 'human' || current !== interventionId) return;
    lockHeld = true;
    try {
      const rec = requireSide(interventionId);
      await stopCapture(rec, interventionId);
      endHumanRound(rec);

      const note = `[lease expired: no operator heartbeat for ${elapsedMs} ms]`;
      state = 'paused';
      logTransfer('human', 'paused', interventionId, LEASE_CHECKER_ACTOR, { reason: note });

      const at = clock().toISOString();
      store.update(interventionId, (c) => {
        const resolution = c.resolution;
        if (resolution === undefined) return { ...c, status: 'open' };
        return { ...c, status: 'open', resolution: { ...resolution, notes: mergeNotes(resolution.notes, note) } };
      });

      rec.leaseExpiredNote = note;
      rec.pausedSinceAt = at;
    } finally {
      lockHeld = false;
    }
  }

  /**
   * `paused` -> terminal: nobody took control within `interventionLeaseMs` of the intervention
   * (re-)becoming paused. Goes through the real `abort()` (same resolution path a human abort
   * uses), so waiters are released and the run ends exactly as it does on abort.
   */
  async function expireUnattendedPause(interventionId: string, elapsedMs: number): Promise<void> {
    if (lockHeld || terminated || state !== 'paused' || current !== interventionId) return;
    const note = `[unattended: no operator took control within ${elapsedMs} ms]`;
    try {
      await abort(interventionId, LEASE_CHECKER_ACTOR, note);
    } catch {
      // Lost a race with a legitimate transition (e.g. a real takeControl landed first); nothing
      // left to do -- the intervention is no longer this checker's concern.
    }
  }

  /**
   * The periodic scan. Only ever the single `current` intervention is at risk (only one is live
   * per broker), so there is no store scan here. Skips entirely while another transition holds
   * `lockHeld`, rather than blocking for it, so it never races a concurrent takeControl/handBack/
   * abort/reverifyFailed: it just tries again on the next tick. Always resolves (never rejects),
   * so the default real-timer callback can fire-and-forget it, and a manual test timer can safely
   * `await` it.
   */
  function checkLeases(): Promise<void> {
    if (terminated || lockHeld || current === undefined) return Promise.resolve();
    const id = current;
    const rec = sideRecords.get(id);
    if (rec === undefined) return Promise.resolve();
    const nowMs = clock().getTime();

    if (state === 'human') {
      if (rec.scripted === true) return Promise.resolve(); // never touch a scripted operator's round
      const anchor = rec.lastHeartbeatAt ?? rec.tookControlAt;
      if (anchor === undefined) return Promise.resolve();
      const elapsed = nowMs - new Date(anchor).getTime();
      if (elapsed > interventionLeaseMs) return expireHumanLease(id, elapsed).catch(() => {});
      return Promise.resolve();
    }

    if (state === 'paused') {
      const anchor = rec.pausedSinceAt;
      if (anchor === undefined) return Promise.resolve();
      const elapsed = nowMs - new Date(anchor).getTime();
      if (elapsed > interventionLeaseMs) return expireUnattendedPause(id, elapsed).catch(() => {});
    }

    return Promise.resolve();
  }

  let leaseTimerHandle: unknown = leaseTimerHooks.setInterval(checkLeases, leaseCheckIntervalMs);

  function dispose(): void {
    if (leaseTimerHandle !== undefined) {
      leaseTimerHooks.clearInterval(leaseTimerHandle);
      leaseTimerHandle = undefined;
    }
  }

  async function waitForResolution(interventionId: string): Promise<EscalationResolution> {
    const rec = requireSide(interventionId);
    if (rec.deferred) return rec.deferred.promise;
    if (rec.lastResolution) return rec.lastResolution;
    throw new UnknownInterventionError(interventionId);
  }

  function onTransfer(cb: (e: ControlTransferEvent) => void): () => void {
    transferListeners.add(cb);
    return () => {
      transferListeners.delete(cb);
    };
  }

  function onHumanAction(cb: (e: HumanActionEvent) => void): () => void {
    humanActionListeners.add(cb);
    return () => {
      humanActionListeners.delete(cb);
    };
  }

  // --- guarded surfaces ---------------------------------------------------------------------------

  const guardedSurface: Surface = {
    observe: () => surface.observe(),
    resolve: async (target, timeoutMs) => {
      if (terminated || state !== 'automation') {
        return { found: false, tried: [{ strategyKind: 'control', error: 'control held by human' }] };
      }
      return surface.resolve(target, timeoutMs);
    },
    act: async (action, timeoutMs, actOpts) => {
      if (terminated) {
        return { ok: false, error: { code: 'policy_violation', message: 'run aborted by operator' } };
      }
      if (state !== 'automation') {
        return { ok: false, error: { code: 'policy_violation', message: `control held by human (state: ${state})` } };
      }
      inFlightActs += 1;
      try {
        return await surface.act(action, timeoutMs, actOpts);
      } finally {
        inFlightActs -= 1;
      }
    },
    readText: (target, timeoutMs) => surface.readText(target, timeoutMs),
    check: (condition, opts) => surface.check(condition, opts),
    waitFor: (condition, timeoutMs, opts) => surface.waitFor(condition, timeoutMs, opts),
    screenshot: () => surface.screenshot(),
    domSnapshot: () => surface.domSnapshot(),
    currentUrl: () => surface.currentUrl(),
    close: async () => {
      if (state === 'automation' || terminated) return surface.close();
      throw illegal('close', state, 'cannot close the live session while an intervention is in progress', current);
    },
    ...(surface.frameUrls !== undefined ? { frameUrls: () => surface.frameUrls!() } : {}),
    ...(surface.describeRef !== undefined ? { describeRef: (ref: string) => surface.describeRef!(ref) } : {}),
    ...(surface.isSameElement !== undefined ? { isSameElement: (a: string, b: string) => surface.isSameElement!(a, b) } : {}),
    // Discovery's recorder only. The operator's surface (below) does not expose it.
    ...(surface.recordContextOf !== undefined ? { recordContextOf: (ref: string) => surface.recordContextOf!(ref) } : {}),
    // Replay's identity check on a read.
    ...(surface.readRecordText !== undefined ? { readRecordText: (target, within, timeoutMs) => surface.readRecordText!(target, within, timeoutMs) } : {}),
  };

  function operatorSurface(interventionId: string): Surface {
    function allowed(): boolean {
      return !terminated && state === 'human' && current === interventionId;
    }
    return {
      observe: () => surface.observe(),
      resolve: async (target, timeoutMs) => {
        if (!allowed()) return { found: false, tried: [{ strategyKind: 'control', error: 'operator does not hold control' }] };
        return surface.resolve(target, timeoutMs);
      },
      act: async (action, timeoutMs, actOpts) => {
        if (!allowed()) return { ok: false, error: { code: 'policy_violation', message: 'operator does not hold control' } };
        return surface.act(action, timeoutMs, actOpts);
      },
      readText: (target, timeoutMs) => surface.readText(target, timeoutMs),
      check: (condition, opts) => surface.check(condition, opts),
      waitFor: (condition, timeoutMs, opts) => surface.waitFor(condition, timeoutMs, opts),
      screenshot: () => surface.screenshot(),
      domSnapshot: () => surface.domSnapshot(),
      currentUrl: () => surface.currentUrl(),
      close: async () => {
        throw illegal('close', state, 'the operator surface can never close the live session', interventionId);
      },
      ...(surface.frameUrls !== undefined ? { frameUrls: () => surface.frameUrls!() } : {}),
      ...(surface.describeRef !== undefined ? { describeRef: (ref: string) => surface.describeRef!(ref) } : {}),
      ...(surface.isSameElement !== undefined ? { isSameElement: (a: string, b: string) => surface.isSameElement!(a, b) } : {}),
    };
  }

  // --- views ---------------------------------------------------------------------------------------

  function view(interventionId: string): InterventionView {
    const intervention = store.get(interventionId);
    if (intervention === undefined) throw new UnknownInterventionError(interventionId);
    const rec = sideRecords.get(interventionId);
    const screenshotFile = intervention.screenshotPath !== undefined ? path.join(logger.dir, intervention.screenshotPath) : undefined;
    return {
      intervention,
      humanActions: rec !== undefined ? [...rec.humanActions] : (intervention.resolution?.humanActions ?? []),
      context: rec?.context,
      ...(screenshotFile !== undefined ? { screenshotFile } : {}),
      control: { state, holder: holderFor(state), interventionId: current, terminated },
      captureMode: rec?.captureMode ?? 'none',
      sessionLabel: opts.sessionLabel,
      ...(rec?.reverifyFailure !== undefined ? { reverifyFailure: rec.reverifyFailure } : {}),
      ...(rec?.lastHeartbeatAt !== undefined ? { lastHeartbeatAt: rec.lastHeartbeatAt } : {}),
      ...(rec?.leaseExpiredNote !== undefined ? { leaseExpiredNote: rec.leaseExpiredNote } : {}),
    };
  }

  function views(): InterventionView[] {
    return store.list({ runId }).map((i) => view(i.id));
  }

  async function liveScreenshot(): Promise<Buffer> {
    return surface.screenshot();
  }

  const broker: SessionBroker = {
    runId,
    runKind,
    surface: guardedSurface,
    get token(): ControlToken {
      return Object.freeze({ state, holder: holderFor(state), interventionId: current });
    },
    get terminated(): boolean {
      return terminated;
    },
    escalate,
    interventions: store,
    sessionLabel: opts.sessionLabel,
    leaseMs: interventionLeaseMs,
    takeControl,
    handBack,
    abort,
    resumed,
    reverifyFailed,
    recordHeartbeat,
    onTransfer,
    onHumanAction,
    waitForResolution,
    operatorSurface,
    recordHumanAction,
    view,
    views,
    liveScreenshot,
    dispose,
  };

  return broker;
}

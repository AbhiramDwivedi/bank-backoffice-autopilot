/**
 * `fromSessionBroker` / `createSessionRegistry`: the only code that implements `RelayBrokerPort`
 * on the core's `SessionBroker`. See docs/design/relay.md ("The port Relay depends on") and
 * apps/relay/src/server/ports.ts for the contract this file fulfils.
 *
 *  - A captured human action is pushed here via `broker.onHumanAction`, which fires once per
 *    action accepted into a live round (capture or scripted operator); there is no poll timer.
 *  - The lease length comes from `broker.leaseMs` (the core's own `interventionLeaseMs`), with
 *    `register(broker, {leaseMs})` and `createSessionRegistry(brokers, {leaseMs})` as overrides
 *    (see `BrokerAdapterOptions.leaseMs`).
 *  - Every DTO built from a run passes through that run's own redactor, when it was registered
 *    with one (`BrokerAdapterOptions.redact`), before the app-wide redactor sees it.
 *
 * This file tracks who took control and the control timeline itself, from `onTransfer`
 * (`heldBy`, `tookControlAt`), since the broker exposes live control state but not a history of it.
 */
import { readFile } from 'node:fs/promises';
import type {
  CapturedAction,
  InterventionDto,
  InterventionStatus,
  LeaseInfo,
  Resolution,
  RunDto,
  TimelineEntry,
} from '../shared/api.js';
import {
  IllegalControlTransitionError,
  UnknownInterventionError,
  type ControlTransferEvent,
  type InterventionView,
  type SessionBroker,
} from './core.js';
import {
  PortConflictError,
  PortNotFoundError,
  type HandBackCommand,
  type PortChange,
  type RelayBrokerPort,
  type ResolutionResult,
} from './ports.js';

/** Timeline entries kept per intervention; oldest dropped past this. */
const MAX_TIMELINE_ENTRIES = 100;

export interface BrokerAdapterOptions {
  /** Lease length shown to the UI for a human round in a registered run. Defaults to `broker.leaseMs`. */
  leaseMs?: number;
  /**
   * The run's own redactor (e.g. its policy patterns plus its known secret/sensitive values),
   * applied to the content of every intervention, run and resolution DTO built from that run.
   * Identifiers (`id`, `runId`, `interventionId`, `stepId`, `capabilityId`, `heldBy`), statuses,
   * the lease and every top-level timestamp are taken out before it runs and put back after, so a
   * short redacted value can never corrupt an id or a holder the UI compares against. Nested
   * timestamps (`resolution.at`, a human action's `ts`) survive because the run redactor leaves
   * structural fields alone (see `createRunRedactor`). A `register()` call's own redactor wins over the
   * registry-level one. The app-wide `RelayAppOptions.redact` still runs on top.
   */
  redact?: (value: unknown) => unknown;
}

export interface RelaySessionRegistry extends RelayBrokerPort {
  register(broker: SessionBroker, opts?: BrokerAdapterOptions): void;
  /** Unsubscribes from that broker's events; the broker itself is left running (call `broker.dispose()` yourself if it should stop). */
  unregister(runId: string): void;
  /** Unsubscribes from every registered broker. Idempotent. */
  dispose(): void;
}

/** Bookkeeping the adapter keeps per intervention: the timeline and who currently holds control. */
interface SideData {
  runId: string;
  timeline: TimelineEntry[];
  heldBy?: string;
  /** ISO timestamp of the most recent paused->human transfer for this intervention's current round. */
  tookControlAt?: string;
}

interface BrokerEntry {
  broker: SessionBroker;
  leaseMs: number;
  /** The run's own redactor; undefined when it was registered without one. */
  redact?: (value: unknown) => unknown;
  unsubscribe: () => void;
}

/** Not exported by core.ts (see the lint rule this file is under); derived from the method itself:
 *  the parameter type of the listener `onHumanAction` accepts. */
type HumanActionEvent = Parameters<Parameters<SessionBroker['onHumanAction']>[0]>[0];

function mapError(err: unknown, interventionId: string): unknown {
  if (err instanceof UnknownInterventionError) return new PortNotFoundError('intervention', interventionId);
  if (err instanceof IllegalControlTransitionError) return new PortConflictError(err.operation, err.state, err.message);
  return err;
}

function toResolution(intervention: InterventionView['intervention']): Resolution | undefined {
  const r = intervention.resolution;
  if (r === undefined) return undefined;
  return {
    by: r.by,
    at: r.at,
    ...(r.notes !== undefined ? { notes: r.notes } : {}),
    resumeFrom: r.resumeFrom,
    ...(r.resumeAtStepId !== undefined ? { resumeAtStepId: r.resumeAtStepId } : {}),
  };
}

function toDto(view: InterventionView, side: SideData, leaseMs: number): InterventionDto {
  const intervention = view.intervention;
  const isHumanActive = intervention.status === 'human_active';
  const resolution = toResolution(intervention);

  let lease: LeaseInfo | undefined;
  if (isHumanActive) {
    const anchorAt = view.lastHeartbeatAt ?? side.tookControlAt ?? intervention.createdAt;
    lease = { ms: leaseMs, anchorAt, expiresAt: new Date(new Date(anchorAt).getTime() + leaseMs).toISOString() };
  }

  return {
    id: intervention.id,
    runId: intervention.runId,
    runKind: intervention.runKind,
    ...(intervention.capabilityId !== undefined ? { capabilityId: intervention.capabilityId } : {}),
    ...(intervention.goal !== undefined ? { goal: intervention.goal } : {}),
    ...(intervention.stepId !== undefined ? { stepId: intervention.stepId } : {}),
    reason: intervention.reason,
    ...(intervention.currentUrl !== undefined ? { currentUrl: intervention.currentUrl } : {}),
    createdAt: intervention.createdAt,
    status: intervention.status,
    ...(resolution !== undefined ? { resolution } : {}),
    hasScreenshot: view.screenshotFile !== undefined,
    ...(view.context !== undefined ? { context: view.context } : {}),
    humanActions: view.humanActions as CapturedAction[],
    captureMode: view.captureMode,
    ...(view.sessionLabel !== undefined ? { sessionLabel: view.sessionLabel } : {}),
    ...(isHumanActive && side.heldBy !== undefined ? { heldBy: side.heldBy } : {}),
    ...(view.lastHeartbeatAt !== undefined ? { lastHeartbeatAt: view.lastHeartbeatAt } : {}),
    ...(lease !== undefined ? { lease } : {}),
    timeline: side.timeline,
    ...(view.reverifyFailure !== undefined ? { reverifyFailure: view.reverifyFailure } : {}),
    ...(view.leaseExpiredNote !== undefined ? { leaseExpiredNote: view.leaseExpiredNote } : {}),
  };
}

function toRunDto(entry: BrokerEntry): RunDto {
  const broker = entry.broker;
  const token = broker.token;
  const newest = broker.interventions.list()[0];
  const dto: RunDto = {
    runId: broker.runId,
    runKind: broker.runKind,
    state: token.state,
    holder: token.holder,
    ...(token.interventionId !== undefined ? { interventionId: token.interventionId } : {}),
    terminated: broker.terminated,
    ...(broker.sessionLabel !== undefined ? { sessionLabel: broker.sessionLabel } : {}),
    leaseMs: entry.leaseMs,
    ...(newest?.capabilityId !== undefined ? { capabilityId: newest.capabilityId } : {}),
    ...(newest?.goal !== undefined ? { goal: newest.goal } : {}),
  };
  if (entry.redact === undefined) return dto;
  const { runId, runKind, state, holder, interventionId, terminated, leaseMs, capabilityId, ...content } = dto;
  return {
    ...(entry.redact(content) as typeof content),
    runId,
    runKind,
    state,
    holder,
    ...(interventionId !== undefined ? { interventionId } : {}),
    terminated,
    leaseMs,
    ...(capabilityId !== undefined ? { capabilityId } : {}),
  };
}

/** The DTO for one intervention of a registered run: its content through the run's redactor, its
 *  identifiers, holder, status, top-level timestamps and lease untouched. */
function dtoFor(entry: BrokerEntry, view: InterventionView, side: SideData): InterventionDto {
  const dto = toDto(view, side, entry.leaseMs);
  if (entry.redact === undefined) return dto;
  const { id, runId, runKind, stepId, capabilityId, heldBy, createdAt, status, hasScreenshot, captureMode, lastHeartbeatAt, lease, timeline, ...content } =
    dto;
  return {
    ...(entry.redact(content) as typeof content),
    id,
    runId,
    runKind,
    ...(stepId !== undefined ? { stepId } : {}),
    ...(capabilityId !== undefined ? { capabilityId } : {}),
    ...(heldBy !== undefined ? { heldBy } : {}),
    createdAt,
    status,
    hasScreenshot,
    captureMode,
    ...(lastHeartbeatAt !== undefined ? { lastHeartbeatAt } : {}),
    ...(lease !== undefined ? { lease } : {}),
    timeline,
  };
}

/** A resolution returned to the caller: its notes and actions through the run's redactor. */
function resolutionFor(entry: BrokerEntry, result: ResolutionResult): ResolutionResult {
  if (entry.redact === undefined) return result;
  const { interventionId, resumeFrom, resumeAtStepId, ...content } = result;
  return { ...(entry.redact(content) as typeof content), interventionId, resumeFrom, ...(resumeAtStepId !== undefined ? { resumeAtStepId } : {}) };
}

export function createSessionRegistry(brokers: SessionBroker[] = [], opts: BrokerAdapterOptions = {}): RelaySessionRegistry {
  const brokersByRunId = new Map<string, BrokerEntry>();
  const sideByIntervention = new Map<string, SideData>();
  const listeners = new Set<(change: PortChange) => void>();

  function publish(change: PortChange): void {
    // Deferred: `store.create` notifies subscribers before the broker sets its own side record
    // (context/captureMode), so a listener that reads the broker synchronously here could see a
    // half-built view. By the time this microtask runs, the core's own synchronous escalation
    // path (which never awaits between `store.create` and setting its side record) has finished.
    queueMicrotask(() => {
      for (const listener of listeners) {
        try {
          listener(change);
        } catch {
          // A bad listener must never break another listener or the core.
        }
      }
    });
  }

  function ensureSide(interventionId: string, runId: string): SideData {
    let side = sideByIntervention.get(interventionId);
    if (side === undefined) {
      side = { runId, timeline: [] };
      sideByIntervention.set(interventionId, side);
    }
    return side;
  }

  function pushTimeline(side: SideData, entry: TimelineEntry): void {
    side.timeline.push(entry);
    if (side.timeline.length > MAX_TIMELINE_ENTRIES) side.timeline.splice(0, side.timeline.length - MAX_TIMELINE_ENTRIES);
  }

  function findEntryFor(interventionId: string): BrokerEntry | undefined {
    for (const entry of brokersByRunId.values()) {
      if (entry.broker.interventions.get(interventionId) !== undefined) return entry;
    }
    return undefined;
  }

  function register(broker: SessionBroker, regOpts: BrokerAdapterOptions = {}): void {
    if (brokersByRunId.has(broker.runId)) unregister(broker.runId);
    // Precedence: this register() call's own override, else the registry-level option this
    // registry was created with, else the broker's own lease.
    const leaseMs = regOpts.leaseMs ?? opts.leaseMs ?? broker.leaseMs;
    const redact = regOpts.redact ?? opts.redact;

    // Seed a synthetic first hop for interventions that existed before this process subscribed,
    // so their timeline is never empty even though the real escalation transfer predates us.
    for (const view of broker.views()) {
      const id = view.intervention.id;
      if (!sideByIntervention.has(id)) {
        sideByIntervention.set(id, {
          runId: broker.runId,
          timeline: [{ from: 'automation', to: 'paused', by: 'automation', at: view.intervention.createdAt }],
        });
      }
    }

    const unsubStore = broker.interventions.subscribe((intervention, change) => {
      publish({ type: 'intervention', change, interventionId: intervention.id, runId: intervention.runId });
    });

    const unsubTransfer = broker.onTransfer((e: ControlTransferEvent) => {
      if (e.interventionId !== undefined) {
        const side = ensureSide(e.interventionId, broker.runId);
        pushTimeline(side, { from: e.from, to: e.to, by: e.by, at: e.at });
        if (e.to === 'human') {
          side.heldBy = e.by;
          side.tookControlAt = e.at;
        } else {
          side.heldBy = undefined;
        }
      }
      publish({ type: 'control', runId: broker.runId, from: e.from, to: e.to, by: e.by, at: e.at, interventionId: e.interventionId });
    });

    const unsubHumanAction = broker.onHumanAction((e: HumanActionEvent) => {
      publish({ type: 'intervention', change: 'actions', interventionId: e.interventionId, runId: e.runId });
    });

    brokersByRunId.set(broker.runId, {
      broker,
      leaseMs,
      ...(redact !== undefined ? { redact } : {}),
      unsubscribe: () => {
        unsubStore();
        unsubTransfer();
        unsubHumanAction();
      },
    });
  }

  function unregister(runId: string): void {
    const entry = brokersByRunId.get(runId);
    if (entry === undefined) return;
    entry.unsubscribe();
    brokersByRunId.delete(runId);
    for (const [id, side] of sideByIntervention) {
      if (side.runId === runId) sideByIntervention.delete(id);
    }
  }

  function dispose(): void {
    for (const runId of [...brokersByRunId.keys()]) unregister(runId);
    listeners.clear();
  }

  function runs(): RunDto[] {
    return [...brokersByRunId.values()].map(toRunDto);
  }

  function controlToken(runId: string): RunDto | undefined {
    const entry = brokersByRunId.get(runId);
    return entry === undefined ? undefined : toRunDto(entry);
  }

  function sideFor(interventionId: string, runId: string): SideData {
    return sideByIntervention.get(interventionId) ?? { runId, timeline: [] };
  }

  function getIntervention(interventionId: string): InterventionDto | undefined {
    const entry = findEntryFor(interventionId);
    if (entry === undefined) return undefined;
    const view = entry.broker.view(interventionId);
    return dtoFor(entry, view, sideFor(interventionId, entry.broker.runId));
  }

  function listInterventions(filter?: { status?: InterventionStatus }): InterventionDto[] {
    const all: InterventionDto[] = [];
    for (const entry of brokersByRunId.values()) {
      for (const intervention of entry.broker.interventions.list(filter)) {
        const view = entry.broker.view(intervention.id);
        all.push(dtoFor(entry, view, sideFor(intervention.id, entry.broker.runId)));
      }
    }
    all.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return all;
  }

  async function take(interventionId: string, by: string): Promise<InterventionDto> {
    const entry = findEntryFor(interventionId);
    if (entry === undefined) throw new PortNotFoundError('intervention', interventionId);
    try {
      await entry.broker.takeControl(interventionId, by);
    } catch (err) {
      throw mapError(err, interventionId);
    }
    return dtoFor(entry, entry.broker.view(interventionId), sideFor(interventionId, entry.broker.runId));
  }

  async function handBack(interventionId: string, command: HandBackCommand): Promise<ResolutionResult> {
    const entry = findEntryFor(interventionId);
    if (entry === undefined) throw new PortNotFoundError('intervention', interventionId);
    try {
      return resolutionFor(
        entry,
        await entry.broker.handBack(interventionId, {
          by: command.by,
          resumeFrom: command.resumeFrom,
          ...(command.resumeAtStepId !== undefined ? { resumeAtStepId: command.resumeAtStepId } : {}),
          notes: command.notes,
        }),
      );
    } catch (err) {
      throw mapError(err, interventionId);
    }
  }

  async function abort(interventionId: string, by: string, notes?: string): Promise<ResolutionResult> {
    const entry = findEntryFor(interventionId);
    if (entry === undefined) throw new PortNotFoundError('intervention', interventionId);
    try {
      return resolutionFor(entry, await entry.broker.abort(interventionId, by, notes));
    } catch (err) {
      throw mapError(err, interventionId);
    }
  }

  function heartbeat(interventionId: string, _by?: string): { at: string; intervention: InterventionDto } {
    const entry = findEntryFor(interventionId);
    if (entry === undefined) throw new PortNotFoundError('intervention', interventionId);
    try {
      entry.broker.recordHeartbeat(interventionId);
    } catch (err) {
      throw mapError(err, interventionId);
    }
    const view = entry.broker.view(interventionId);
    const dto = dtoFor(entry, view, sideFor(interventionId, entry.broker.runId));
    const at = view.lastHeartbeatAt ?? new Date().toISOString();
    publish({ type: 'heartbeat', runId: entry.broker.runId, interventionId, at });
    return { at, intervention: dto };
  }

  function subscribe(listener: (change: PortChange) => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  async function escalationScreenshot(interventionId: string): Promise<Uint8Array | undefined> {
    const entry = findEntryFor(interventionId);
    if (entry === undefined) return undefined;
    const view = entry.broker.view(interventionId);
    if (view.screenshotFile === undefined) return undefined;
    try {
      return await readFile(view.screenshotFile);
    } catch {
      return undefined;
    }
  }

  async function liveScreenshot(runId: string): Promise<Uint8Array> {
    const entry = brokersByRunId.get(runId);
    if (entry === undefined) throw new PortNotFoundError('run', runId);
    return entry.broker.liveScreenshot();
  }

  for (const b of brokers) register(b);

  return {
    runs,
    controlToken,
    listInterventions,
    getIntervention,
    take,
    handBack,
    abort,
    heartbeat,
    subscribe,
    escalationScreenshot,
    liveScreenshot,
    register,
    unregister,
    dispose,
  };
}

export function fromSessionBroker(broker: SessionBroker, opts?: BrokerAdapterOptions): RelaySessionRegistry {
  return createSessionRegistry([broker], opts);
}

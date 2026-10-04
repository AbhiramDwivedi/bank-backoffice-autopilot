/**
 * The UI's single state store, plus the selectors every view uses.
 *
 * One plain object, replaced (never mutated) on every change. Listeners are notified once per
 * microtask, so a burst of SSE events causes one render. Views read with `store.get()` and
 * subscribe with `store.subscribe`; they never keep their own copy of server data.
 */
import type { Bootstrap, InterventionDto, RunDto } from '../shared/api.js';

export type Connection = 'connecting' | 'live' | 'reconnecting' | 'offline';
export type ThemeChoice = 'system' | 'light' | 'dark';
export type ShotMode = 'escalation' | 'live';
export type PendingOp = 'take' | 'handback' | 'abort';
export type ToastKind = 'info' | 'success' | 'warning' | 'error';

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
  /** Auto-dismiss after this many ms; errors stay until dismissed when undefined. */
  ttlMs?: number;
}

export interface RelayState {
  runs: Readonly<Record<string, RunDto>>;
  interventions: Readonly<Record<string, InterventionDto>>;
  selectedId: string | null;
  connection: Connection;
  /** Newest SSE event id applied; sent back on reconnect. */
  lastEventId: string | null;
  /** Operator name sent as `by`. Stored per browser. */
  operator: string;
  theme: ThemeChoice;
  shotMode: ShotMode;
  /** In-flight command per intervention id; views disable the matching controls. */
  pending: Readonly<Record<string, PendingOp>>;
  toasts: readonly Toast[];
  /** serverTime - Date.now() at bootstrap; add to Date.now() for ages and lease countdowns. */
  clockSkewMs: number;
}

export type Listener = (state: RelayState, prev: RelayState) => void;

export interface Store {
  get(): RelayState;
  /** Shallow-merges a patch (or the patch a function returns) and schedules one notification. */
  set(patch: Partial<RelayState> | ((s: RelayState) => Partial<RelayState>)): void;
  subscribe(listener: Listener): () => void;
}

export function createStore(initial: RelayState): Store {
  let state = initial;
  let notifiedState = initial;
  let scheduled = false;
  const listeners = new Set<Listener>();

  function flush(): void {
    scheduled = false;
    const prev = notifiedState;
    notifiedState = state;
    if (prev === state) return;
    for (const l of listeners) {
      try {
        l(state, prev);
      } catch (err) {
        console.error('relay: listener failed', err);
      }
    }
  }

  return {
    get: () => state,
    set(patch) {
      const p = typeof patch === 'function' ? patch(state) : patch;
      state = { ...state, ...p };
      if (!scheduled) {
        scheduled = true;
        queueMicrotask(flush);
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

// ---- Preferences (per browser; storage may be unavailable) ----------------------------------

const PREF_OPERATOR = 'relay.operator';
const PREF_THEME = 'relay.theme';

function readPref(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writePref(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage blocked (private window, policy): the preference lasts for this page only.
  }
}

export function loadOperator(): string {
  const v = readPref(PREF_OPERATOR)?.trim();
  return v && v.length > 0 ? v.slice(0, 100) : 'operator';
}

export function saveOperator(name: string): void {
  writePref(PREF_OPERATOR, name);
}

export function loadTheme(): ThemeChoice {
  const v = readPref(PREF_THEME);
  return v === 'light' || v === 'dark' ? v : 'system';
}

export function saveTheme(choice: ThemeChoice): void {
  writePref(PREF_THEME, choice);
}

// ---- Construction and server-data actions ---------------------------------------------------

export function initialState(boot: Bootstrap | null): RelayState {
  return {
    runs: boot ? indexBy(boot.runs, (r) => r.runId) : {},
    interventions: boot ? indexBy(boot.interventions, (i) => i.id) : {},
    selectedId: null,
    connection: 'connecting',
    lastEventId: boot?.lastEventId ?? null,
    operator: loadOperator(),
    theme: loadTheme(),
    shotMode: 'escalation',
    pending: {},
    toasts: [],
    clockSkewMs: boot ? new Date(boot.serverTime).getTime() - Date.now() : 0,
  };
}

function indexBy<T>(items: readonly T[], key: (t: T) => string): Record<string, T> {
  const out: Record<string, T> = {};
  for (const item of items) out[key(item)] = item;
  return out;
}

/** Replaces all server data (bootstrap refetch or SSE `reset`). Keeps the selection if it still exists. */
export function applySnapshot(store: Store, runs: readonly RunDto[], interventions: readonly InterventionDto[], lastEventId: string): void {
  store.set((s) => {
    const byId = indexBy(interventions, (i) => i.id);
    return {
      runs: indexBy(runs, (r) => r.runId),
      interventions: byId,
      lastEventId,
      selectedId: s.selectedId !== null && byId[s.selectedId] !== undefined ? s.selectedId : null,
    };
  });
}

export function upsertIntervention(store: Store, dto: InterventionDto): void {
  store.set((s) => ({ interventions: { ...s.interventions, [dto.id]: dto } }));
}

export function upsertRun(store: Store, dto: RunDto): void {
  store.set((s) => ({ runs: { ...s.runs, [dto.runId]: dto } }));
}

export function select(store: Store, id: string | null): void {
  store.set((s) => (s.selectedId === id ? {} : { selectedId: id, shotMode: 'escalation' }));
}

export function setPending(store: Store, interventionId: string, op: PendingOp | null): void {
  store.set((s) => {
    const next = { ...s.pending };
    if (op === null) delete next[interventionId];
    else next[interventionId] = op;
    return { pending: next };
  });
}

let toastSeq = 0;

export function pushToast(store: Store, kind: ToastKind, message: string, ttlMs?: number): number {
  const id = ++toastSeq;
  const ttl = ttlMs ?? (kind === 'error' ? undefined : 6000);
  // At most three on screen: a burst of events never buries the page under notifications.
  store.set((s) => ({ toasts: [...s.toasts, { id, kind, message, ...(ttl !== undefined ? { ttlMs: ttl } : {}) }].slice(-3) }));
  return id;
}

export function dismissToast(store: Store, id: number): void {
  store.set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

// ---- Selectors -------------------------------------------------------------------------------

/** What the operator sees for one intervention. Drives the state pill and the right pane. */
export type ViewState = 'paused' | 'mine' | 'held' | 'resuming' | 'resolved' | 'abandoned';

export const VIEW_STATE_LABEL: Record<ViewState, string> = {
  paused: 'Paused',
  mine: 'You have control',
  held: 'Held by another operator',
  resuming: 'Resuming',
  resolved: 'Resolved',
  abandoned: 'Abandoned',
};

/**
 * `heldBy` is unknown only when Relay attached to a run mid-round; that round counts as `mine` so
 * a local operator can still hand it back (identity is client-declared anyway; see relay.md).
 */
export function viewState(dto: InterventionDto, run: RunDto | undefined, operator: string): ViewState {
  switch (dto.status) {
    case 'abandoned':
      return 'abandoned';
    case 'open':
      return 'paused';
    case 'human_active':
      return dto.heldBy === undefined || dto.heldBy === operator ? 'mine' : 'held';
    case 'resolved':
      return run !== undefined && run.state === 'resuming' && run.interventionId === dto.id ? 'resuming' : 'resolved';
  }
}

export interface QueueGroups {
  open: InterventionDto[];
  inProgress: InterventionDto[];
  resolved: InterventionDto[];
}

const RESOLVED_LIMIT = 50;

/**
 * Open and In progress: oldest first (the longest wait is at the top). Resolved: most recently
 * resolved first, capped at 50. A handed-back intervention whose run is still re-verifying
 * (`resuming`) counts as In progress.
 */
export function queueGroups(state: RelayState): QueueGroups {
  const open: InterventionDto[] = [];
  const inProgress: InterventionDto[] = [];
  const resolved: InterventionDto[] = [];
  for (const dto of Object.values(state.interventions)) {
    const vs = viewState(dto, state.runs[dto.runId], state.operator);
    if (vs === 'paused') open.push(dto);
    else if (vs === 'mine' || vs === 'held' || vs === 'resuming') inProgress.push(dto);
    else resolved.push(dto);
  }
  const created = (d: InterventionDto): number => new Date(d.createdAt).getTime();
  const ended = (d: InterventionDto): number => new Date(d.resolution?.at ?? d.createdAt).getTime();
  open.sort((a, b) => created(a) - created(b));
  inProgress.sort((a, b) => created(a) - created(b));
  resolved.sort((a, b) => ended(b) - ended(a));
  return { open, inProgress, resolved: resolved.slice(0, RESOLVED_LIMIT) };
}

/** Queue order as the keyboard walks it: Open, then In progress, then Resolved. */
export function queueOrder(state: RelayState): string[] {
  const g = queueGroups(state);
  return [...g.open, ...g.inProgress, ...g.resolved].map((d) => d.id);
}

export function selected(state: RelayState): InterventionDto | undefined {
  return state.selectedId !== null ? state.interventions[state.selectedId] : undefined;
}

/** Server-aligned now, in ms since epoch. */
export function serverNow(state: RelayState): number {
  return Date.now() + state.clockSkewMs;
}

/** Remaining lease in ms (negative once expired), or undefined when no human round is live. */
export function leaseRemainingMs(dto: InterventionDto, now: number): number | undefined {
  if (dto.status !== 'human_active' || dto.lease === undefined) return undefined;
  return new Date(dto.lease.expiresAt).getTime() - now;
}

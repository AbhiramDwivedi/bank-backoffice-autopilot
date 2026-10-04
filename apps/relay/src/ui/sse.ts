/**
 * Live updates over `GET /api/events`. Owns store.connection and store.lastEventId, and applies
 * every intervention/control/heartbeat/reset event to the store. See shared/api.ts for the wire
 * protocol (named SSE events, Last-Event-ID resumption, the `reset` fallback).
 *
 * Reconnection: the browser's native EventSource retry runs first (readyState stays CONNECTING).
 * If the connection is ever fully CLOSED (a fatal error, or a close we triggered), this module
 * takes over with its own exponential backoff (1s doubling to 30s, with jitter). Either way, if
 * 60s pass without getting back to `live`, the connection is shown as `offline` (retries continue
 * in the background). `online` and a visible tab both force an immediate retry when not already
 * connected.
 */
import type { ControlEvent, HeartbeatEvent, InterventionEvent, ResetEvent } from '../shared/api.js';
import type { AppContext } from './context.js';
import { applySnapshot, upsertIntervention, upsertRun } from './store.js';

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
const OFFLINE_AFTER_MS = 60_000;

const enc = encodeURIComponent;

function safeParse<T>(raw: string): T | undefined {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

export function connectEvents(ctx: AppContext): { close(): void } {
  let es: EventSource | undefined;
  let closed = false;
  let backoffMs = INITIAL_BACKOFF_MS;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let offlineTimer: ReturnType<typeof setTimeout> | undefined;

  function buildUrl(): string {
    const last = ctx.store.get().lastEventId;
    return last ? `/api/events?lastEventId=${enc(last)}` : '/api/events';
  }

  function trackId(evt: MessageEvent<string>): void {
    if (evt.lastEventId) ctx.store.set({ lastEventId: evt.lastEventId });
  }

  function scheduleOffline(): void {
    if (offlineTimer !== undefined) return;
    offlineTimer = setTimeout(() => {
      offlineTimer = undefined;
      if (!closed) ctx.store.set({ connection: 'offline' });
    }, OFFLINE_AFTER_MS);
  }

  function clearOffline(): void {
    if (offlineTimer !== undefined) {
      clearTimeout(offlineTimer);
      offlineTimer = undefined;
    }
  }

  async function refetchSnapshot(): Promise<void> {
    try {
      const [runsRes, interventionsRes] = await Promise.all([ctx.api.runs(), ctx.api.interventions()]);
      applySnapshot(ctx.store, runsRes.runs, interventionsRes.interventions, interventionsRes.lastEventId);
    } catch {
      // The next successful reconnect (or another reset) will retry this.
    }
  }

  function onOpen(): void {
    clearOffline();
    backoffMs = INITIAL_BACKOFF_MS;
    ctx.store.set({ connection: 'live' });
  }

  function onError(): void {
    if (closed) return;
    scheduleOffline();
    ctx.store.set((s) => (s.connection === 'offline' ? {} : { connection: 'reconnecting' }));
    if (es?.readyState === EventSource.CLOSED) reconnectManually();
  }

  function onIntervention(evt: MessageEvent<string>): void {
    trackId(evt);
    const data = safeParse<InterventionEvent>(evt.data);
    if (!data) return;
    upsertIntervention(ctx.store, data.intervention);
    if (data.change === 'created') {
      const label = data.intervention.capabilityId ?? data.intervention.goal ?? data.intervention.id;
      ctx.toast('info', `New intervention: ${label}`);
    }
  }

  function onControl(evt: MessageEvent<string>): void {
    trackId(evt);
    const data = safeParse<ControlEvent>(evt.data);
    if (!data) return;
    upsertRun(ctx.store, data.run);
  }

  function onHeartbeat(evt: MessageEvent<string>): void {
    trackId(evt);
    const data = safeParse<HeartbeatEvent>(evt.data);
    if (!data) return;
    ctx.store.set((s) => {
      const existing = s.interventions[data.interventionId];
      if (!existing) return {};
      return {
        interventions: { ...s.interventions, [data.interventionId]: { ...existing, lease: data.lease, lastHeartbeatAt: data.at } },
      };
    });
  }

  function onReset(evt: MessageEvent<string>): void {
    trackId(evt);
    const data = safeParse<ResetEvent>(evt.data);
    if (!data) return;
    void refetchSnapshot();
  }

  function open(): void {
    if (closed) return;
    es?.close();
    const next = new EventSource(buildUrl());
    es = next;
    next.addEventListener('open', onOpen);
    next.addEventListener('error', onError);
    next.addEventListener('intervention', onIntervention as EventListener);
    next.addEventListener('control', onControl as EventListener);
    next.addEventListener('heartbeat', onHeartbeat as EventListener);
    next.addEventListener('reset', onReset as EventListener);
  }

  function reconnectManually(): void {
    if (closed || reconnectTimer !== undefined) return;
    const jitter = Math.random() * backoffMs * 0.2;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      open();
    }, backoffMs + jitter);
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
  }

  function forceReconnect(): void {
    if (closed || es?.readyState === EventSource.OPEN) return;
    if (reconnectTimer !== undefined) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
    backoffMs = INITIAL_BACKOFF_MS;
    open();
  }

  function onNetworkOnline(): void {
    forceReconnect();
  }

  function onVisibility(): void {
    if (document.visibilityState === 'visible') forceReconnect();
  }

  window.addEventListener('online', onNetworkOnline);
  document.addEventListener('visibilitychange', onVisibility);

  open();

  return {
    close(): void {
      closed = true;
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      clearOffline();
      window.removeEventListener('online', onNetworkOnline);
      document.removeEventListener('visibilitychange', onVisibility);
      es?.close();
    },
  };
}

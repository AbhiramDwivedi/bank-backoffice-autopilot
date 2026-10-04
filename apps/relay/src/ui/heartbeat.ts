/**
 * Keeps every intervention's lease alive while this operator holds it: a heartbeat fires the
 * moment an intervention becomes `mine`, then every 5 s for as long as it stays `mine`, for every
 * such intervention at once (not only the selected one). Reconciliation runs off the store, so a
 * hand-back, a `take` elsewhere, or a resolved/abandoned transition stops the loop for that id on
 * the very next notification.
 *
 * A refused heartbeat stops the loop for good until the server says something new: a 409 (this
 * operator no longer holds the round) refetches the intervention once, and a 404 (the run is gone)
 * is terminal. Either way the DTO the refusal was based on is remembered, and the loop is not
 * restarted while the store still holds that exact object -- only a fresh DTO (an SSE update, a
 * snapshot) can start it again, so a store that still says `mine` never spins a 409/toast loop.
 */
import { ApiRequestError } from './api.js';
import type { AppContext } from './context.js';
import { titleOf } from './format.js';
import { upsertIntervention, viewState } from './store.js';
import type { InterventionDto } from '../shared/api.js';

const INTERVAL_MS = 5000;

interface Entry {
  timer: ReturnType<typeof setTimeout> | undefined;
  outageToasted: boolean;
  stopped: boolean;
}

export function mountHeartbeat(ctx: AppContext): void {
  const active = new Map<string, Entry>();
  /** Per id: the DTO object in the store when the server last refused a heartbeat for it. */
  const refused = new Map<string, InterventionDto | undefined>();

  function stop(id: string): void {
    const entry = active.get(id);
    if (!entry) return;
    entry.stopped = true;
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    active.delete(id);
  }

  function scheduleNext(id: string, entry: Entry): void {
    entry.timer = setTimeout(() => void tick(id, entry), INTERVAL_MS);
  }

  /** Stops the loop and pins it off until the store holds a different DTO for `id`. */
  function refuse(id: string): void {
    stop(id);
    refused.set(id, ctx.store.get().interventions[id]);
  }

  /** After a 409: fetch what the server now says about `id`, and pin the loop off against that. */
  async function refetch(id: string): Promise<void> {
    try {
      const fresh = await ctx.api.intervention(id);
      if (refused.get(id) !== ctx.store.get().interventions[id]) return; // something newer already arrived
      refused.set(id, fresh);
      upsertIntervention(ctx.store, fresh);
    } catch {
      // The stale DTO stays pinned; the SSE stream (or its reset snapshot) brings the real state.
    }
  }

  async function tick(id: string, entry: Entry): Promise<void> {
    if (entry.stopped) return;
    const operator = ctx.store.get().operator;
    try {
      const res = await ctx.api.heartbeat(id, operator);
      if (entry.stopped) return;
      ctx.store.set((s) => {
        const dto = s.interventions[id];
        if (!dto) return {};
        return { interventions: { ...s.interventions, [id]: { ...dto, lease: res.lease, lastHeartbeatAt: res.at } } };
      });
      scheduleNext(id, entry);
    } catch (err) {
      if (entry.stopped) return;
      if (err instanceof ApiRequestError && err.status === 409) {
        refuse(id);
        const dto = ctx.store.get().interventions[id];
        ctx.toast('error', `You no longer have control of ${titleOf(dto ?? {})}.`);
        void refetch(id);
        return;
      }
      if (err instanceof ApiRequestError && err.status === 404) {
        refuse(id);
        const dto = ctx.store.get().interventions[id];
        ctx.toast('error', `${titleOf(dto ?? {})} is no longer on Relay; its run has ended.`);
        return;
      }
      if (!entry.outageToasted) {
        entry.outageToasted = true;
        ctx.toast('warning', "Can't reach Relay to renew your lease. Retrying.");
      }
      scheduleNext(id, entry);
    }
  }

  function ensureRunning(id: string): void {
    if (active.has(id)) return;
    const entry: Entry = { timer: undefined, outageToasted: false, stopped: false };
    active.set(id, entry);
    void tick(id, entry);
  }

  function reconcile(): void {
    const state = ctx.store.get();
    for (const [id, dto] of refused) {
      if (state.interventions[id] !== dto) refused.delete(id);
    }
    const mineIds = new Set<string>();
    for (const dto of Object.values(state.interventions)) {
      if (refused.has(dto.id)) continue;
      if (viewState(dto, state.runs[dto.runId], state.operator) === 'mine') mineIds.add(dto.id);
    }
    for (const id of mineIds) ensureRunning(id);
    for (const id of Array.from(active.keys())) {
      if (!mineIds.has(id)) stop(id);
    }
  }

  ctx.store.subscribe(reconcile);
  reconcile();
}

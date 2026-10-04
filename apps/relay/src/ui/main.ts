/**
 * Relay's UI entry point. Reads the inlined bootstrap (falling back to a live fetch when it's
 * missing or unparsable), builds the one `AppContext` every view shares, and mounts the top bar,
 * toasts, panes and the SSE connection.
 *
 * Guard: toasts mount first and on their own, so that if anything after it throws (a bad
 * snapshot fetch, a mounting bug), the app can still surface an error toast instead of leaving a
 * silently broken page. The static shell markup (topbar, pane containers) is already in
 * index.html, so a failure here never blanks the page -- at worst it leaves a pane unmounted.
 */
import type { Bootstrap } from '../shared/api.js';
import { createApi } from './api.js';
import type { AppContext } from './context.js';
import { applySnapshot, createStore, initialState, pushToast } from './store.js';
import { connectEvents } from './sse.js';
import { createConfirm } from './views/confirm.js';
import { mountPanes } from './views/panes.js';
import { mountToasts } from './views/toasts.js';
import { mountTopbar } from './views/topbar.js';

function readBootstrap(): Bootstrap | null {
  const el = document.getElementById('relay-bootstrap');
  if (!el?.textContent) return null;
  try {
    return JSON.parse(el.textContent) as Bootstrap;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const api = createApi();
  const boot = readBootstrap();
  const store = createStore(initialState(boot));
  const confirm = createConfirm();

  const ctx: AppContext = {
    store,
    api,
    toast(kind, message) {
      pushToast(store, kind, message);
    },
    confirm,
  };

  try {
    mountToasts(ctx);
  } catch (err) {
    // Nothing more we can do without a working toasts view; the rest of the app still tries below.
    console.error('relay: toasts failed to mount', err);
  }

  try {
    if (!boot) {
      const [runsRes, interventionsRes] = await Promise.all([api.runs(), api.interventions()]);
      applySnapshot(store, runsRes.runs, interventionsRes.interventions, interventionsRes.lastEventId);
    }
    mountTopbar(ctx);
    mountPanes(ctx);
    connectEvents(ctx);
  } catch (err) {
    console.error('relay: failed to start', err);
    ctx.toast('error', 'Relay could not load the intervention queue. Reload the page to try again.');
  }
}

main().catch((err: unknown) => {
  console.error('relay: fatal startup error', err);
});

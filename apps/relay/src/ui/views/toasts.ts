/**
 * Renders store.toasts into #toasts. Each toast auto-dismisses after its `ttlMs` (errors have no
 * ttl and stay until dismissed); the per-toast timer pauses while the toast is hovered or focused,
 * so a notification never disappears mid-read, and resumes with whatever time was left.
 */
import type { AppContext } from '../context.js';
import { byId, h, patchList, setAttr, setText } from '../dom.js';
import { dismissToast } from '../store.js';
import type { Toast } from '../store.js';

interface TimerState {
  handle: ReturnType<typeof setTimeout> | undefined;
  /** Set only while paused: how much time was left when it was paused. */
  remainingMs: number | undefined;
  startedAt: number;
}

export function mountToasts(ctx: AppContext): void {
  const root = byId('toasts');
  const timers = new Map<number, TimerState>();

  const clearTimer = (id: number): void => {
    const t = timers.get(id);
    if (t?.handle !== undefined) clearTimeout(t.handle);
    timers.delete(id);
  };

  const armTimer = (toast: Toast): void => {
    if (toast.ttlMs === undefined) return;
    const handle = setTimeout(() => dismissToast(ctx.store, toast.id), toast.ttlMs);
    timers.set(toast.id, { handle, remainingMs: undefined, startedAt: Date.now() });
  };

  const pause = (id: number): void => {
    const t = timers.get(id);
    if (!t || t.handle === undefined) return;
    clearTimeout(t.handle);
    const toast = ctx.store.get().toasts.find((x) => x.id === id);
    const total = toast?.ttlMs ?? 0;
    const elapsed = Date.now() - t.startedAt;
    t.remainingMs = Math.max(0, total - elapsed);
    t.handle = undefined;
  };

  const resume = (id: number): void => {
    const t = timers.get(id);
    if (!t || t.handle !== undefined || t.remainingMs === undefined) return;
    const remaining = t.remainingMs;
    t.remainingMs = undefined;
    t.startedAt = Date.now();
    t.handle = setTimeout(() => dismissToast(ctx.store, id), remaining);
  };

  const create = (toast: Toast): HTMLElement => {
    const el = h(
      'div',
      { class: 'toast', 'data-kind': toast.kind },
      h('span', { class: 'toast-icon', 'aria-hidden': 'true' }),
      h('p', { class: 'toast-message' }),
      h(
        'button',
        {
          type: 'button',
          class: 'toast-dismiss',
          'aria-label': 'Dismiss notification',
          onclick: () => dismissToast(ctx.store, toast.id),
        },
        '×',
      ),
    );
    el.addEventListener('mouseenter', () => pause(toast.id));
    el.addEventListener('mouseleave', () => resume(toast.id));
    el.addEventListener('focusin', () => pause(toast.id));
    el.addEventListener('focusout', () => resume(toast.id));
    return el;
  };

  const update = (el: HTMLElement, toast: Toast): void => {
    setAttr(el, 'data-kind', toast.kind);
    setAttr(el, 'role', toast.kind === 'error' ? 'alert' : null);
    const msg = el.querySelector('.toast-message');
    if (msg) setText(msg, toast.message);
    if (!timers.has(toast.id)) armTimer(toast);
  };

  const render = (): void => {
    const toasts = ctx.store.get().toasts;
    patchList(root, toasts, (t) => String(t.id), create, update);
    const alive = new Set(toasts.map((t) => t.id));
    for (const id of Array.from(timers.keys())) {
      if (!alive.has(id)) clearTimer(id);
    }
  };

  render();
  ctx.store.subscribe((s, prev) => {
    if (s.toasts !== prev.toasts) render();
  });
}

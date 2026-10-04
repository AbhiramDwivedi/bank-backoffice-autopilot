/**
 * The one shared 1 s clock. Queue ages and the lease countdown both need to tick every second
 * without a store change; rather than each view running its own `setInterval`, they register a
 * callback here. Callbacks rewrite text directly (`setText`) and never trigger a re-render.
 */

type TickListener = () => void;

const listeners = new Set<TickListener>();
let timer: ReturnType<typeof setInterval> | undefined;

/** Registers a callback to run every second. Returns an unsubscribe function. */
export function onTick(cb: TickListener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Starts the shared interval. Idempotent: later calls are no-ops. */
export function startTicker(): void {
  if (timer !== undefined) return;
  timer = setInterval(() => {
    for (const cb of listeners) {
      try {
        cb();
      } catch (err) {
        console.error('relay: tick listener failed', err);
      }
    }
  }, 1000);
}

/**
 * Throttled, de-duplicated cache in front of a run's live screenshot capture.
 *
 * A capture (a real screencast frame, or `SessionBroker.liveScreenshot()` underneath the fake
 * surface in tests) is not free, and a detail panel polling `GET /api/runs/:runId/screenshot`
 * every second or two should not cause more than one capture per run per window. See app.ts.
 */

export interface LiveScreenshotFrame {
  png: Uint8Array;
  capturedAt: Date;
}

export interface LiveScreenshotCacheOptions {
  capture: (runId: string) => Promise<Uint8Array>;
  /** At most one capture per run within this many ms; a call inside the window gets the cached frame. Default 1000. */
  minIntervalMs?: number;
  /** Default `Date.now`. */
  now?: () => number;
}

export interface LiveScreenshotCache {
  get(runId: string): Promise<LiveScreenshotFrame>;
}

interface Entry {
  png: Uint8Array;
  capturedAt: number;
  lastRequestedAt: number;
  inFlight?: Promise<LiveScreenshotFrame>;
}

/** Entries not requested for this long are dropped, so a long-lived server does not accumulate
 *  one cache entry per run forever. */
const EVICT_AFTER_MS = 60_000;

export function createLiveScreenshotCache(opts: LiveScreenshotCacheOptions): LiveScreenshotCache {
  const capture = opts.capture;
  const minIntervalMs = opts.minIntervalMs ?? 1000;
  const now = opts.now ?? Date.now;

  const entries = new Map<string, Entry>();

  function evictStale(): void {
    const cutoff = now() - EVICT_AFTER_MS;
    for (const [runId, entry] of entries) {
      if (entry.inFlight === undefined && entry.lastRequestedAt < cutoff) entries.delete(runId);
    }
  }

  async function get(runId: string): Promise<LiveScreenshotFrame> {
    evictStale();

    const nowMs = now();
    let entry = entries.get(runId);
    if (entry === undefined) {
      entry = { png: new Uint8Array(0), capturedAt: -Infinity, lastRequestedAt: nowMs };
      entries.set(runId, entry);
    } else {
      entry.lastRequestedAt = nowMs;
    }

    if (entry.inFlight !== undefined) return entry.inFlight;

    const withinWindow = nowMs - entry.capturedAt < minIntervalMs;
    if (withinWindow) return { png: entry.png, capturedAt: new Date(entry.capturedAt) };

    const live = entry;
    const promise = (async (): Promise<LiveScreenshotFrame> => {
      try {
        const png = await capture(runId);
        const capturedAtMs = now();
        // A failed capture is never cached (see below, the `finally` only clears `inFlight`): on
        // success alone we update the frame so the next call inside the window gets it too.
        live.png = png;
        live.capturedAt = capturedAtMs;
        return { png, capturedAt: new Date(capturedAtMs) };
      } finally {
        live.inFlight = undefined;
      }
    })();
    entry.inFlight = promise;
    return promise;
  }

  return { get };
}

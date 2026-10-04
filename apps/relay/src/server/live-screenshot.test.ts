import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLiveScreenshotCache } from './live-screenshot.js';

describe('createLiveScreenshotCache', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('two calls within the window share one capture; a call after the window triggers a second', async () => {
    let now = 1_000_000;
    let calls = 0;
    const cache = createLiveScreenshotCache({
      capture: async (runId) => {
        calls += 1;
        return new Uint8Array([calls, runId.length]);
      },
      minIntervalMs: 1000,
      now: () => now,
    });

    const first = await cache.get('run-a');
    expect(calls).toBe(1);
    expect(first.png).toEqual(new Uint8Array([1, 5]));

    now += 500; // still inside the window
    const second = await cache.get('run-a');
    expect(calls).toBe(1);
    expect(second.png).toEqual(first.png);
    expect(second.capturedAt.getTime()).toBe(first.capturedAt.getTime());

    now += 600; // 1100ms since the first capture: past the 1000ms window
    const third = await cache.get('run-a');
    expect(calls).toBe(2);
    expect(third.png).toEqual(new Uint8Array([2, 5]));
  });

  it('concurrent callers for the same run share one in-flight capture', async () => {
    let calls = 0;
    let resolveCapture: ((png: Uint8Array) => void) | undefined;
    const cache = createLiveScreenshotCache({
      capture: () =>
        new Promise<Uint8Array>((resolve) => {
          calls += 1;
          resolveCapture = resolve;
        }),
    });

    const p1 = cache.get('run-a');
    const p2 = cache.get('run-a');
    expect(calls).toBe(1); // only one capture started, even though two callers are waiting

    resolveCapture?.(new Uint8Array([9]));
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.png).toEqual(new Uint8Array([9]));
    expect(r2.png).toEqual(new Uint8Array([9]));
    expect(r1.capturedAt.getTime()).toBe(r2.capturedAt.getTime());
  });

  it('a failed capture is not cached: the very next call retries immediately', async () => {
    let attempt = 0;
    const cache = createLiveScreenshotCache({
      capture: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error('capture failed');
        return new Uint8Array([attempt]);
      },
      minIntervalMs: 60_000, // huge window: if the failure were cached, the retry below would return stale data instead of retrying
    });

    await expect(cache.get('run-a')).rejects.toThrow('capture failed');
    expect(attempt).toBe(1);

    const ok = await cache.get('run-a');
    expect(attempt).toBe(2);
    expect(ok.png).toEqual(new Uint8Array([2]));
  });

  it('different runs are throttled independently', async () => {
    const calls: string[] = [];
    const now = 0;
    const cache = createLiveScreenshotCache({
      capture: async (runId) => {
        calls.push(runId);
        return new Uint8Array([calls.length]);
      },
      minIntervalMs: 1000,
      now: () => now,
    });

    await cache.get('run-a');
    await cache.get('run-b');
    expect(calls).toEqual(['run-a', 'run-b']);
  });

  it('evicts an entry not requested for 60s, so the next call captures again even inside the original window', async () => {
    let now = 0;
    let calls = 0;
    const cache = createLiveScreenshotCache({
      capture: async () => {
        calls += 1;
        return new Uint8Array([calls]);
      },
      minIntervalMs: 1000,
      now: () => now,
    });

    await cache.get('run-a');
    expect(calls).toBe(1);

    now += 60_001; // past the 60s eviction window
    await cache.get('run-a');
    expect(calls).toBe(2);
  });
});

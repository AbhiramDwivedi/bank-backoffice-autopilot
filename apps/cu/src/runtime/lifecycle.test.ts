/**
 * `runWithShutdown` prints the run directory exactly once per run (on a normal completion and on
 * an interrupted one, never inside the signal handler's own message), and reports an interrupted
 * run to its caller as an `InterruptedError` whether the body resolved or rejected.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Composition } from './compose.js';
import { INTERRUPTED_EXIT_CODE, InterruptedError, isInterruptedError, runWithShutdown } from './lifecycle.js';

// The signal handler sets process.exitCode = 130; never let that leak into the test process.
afterEach(() => {
  process.exitCode = undefined;
});

function fakeComposition(opts: { interventionId?: string } = {}): {
  c: Composition;
  close: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
} {
  const close = vi.fn(async () => undefined);
  const abort = vi.fn(async () => undefined);
  const c = {
    logger: { dir: '/tmp/fake-run-dir' },
    broker: {
      token: { state: 'automation', holder: 'automation', interventionId: opts.interventionId },
      terminated: false,
      abort,
    },
    close,
  } as unknown as Composition;
  return { c, close, abort };
}

describe('runWithShutdown', () => {
  it('prints "run dir: ..." exactly once on normal completion', async () => {
    const { c, close } = fakeComposition();
    const lines: string[] = [];

    const result = await runWithShutdown(c, async () => 'ok', (l) => lines.push(l));

    expect(result).toBe('ok');
    expect(close).toHaveBeenCalledTimes(1);
    const runDirLines = lines.filter((l) => l.includes('run dir:'));
    expect(runDirLines).toEqual(['run dir: /tmp/fake-run-dir']);
  });

  it('on SIGINT, prints "run dir: ..." exactly once (not once in the shutdown message and again in the finally)', async () => {
    const { c, abort } = fakeComposition({ interventionId: 'iv-1' });
    const lines: string[] = [];
    let releaseBody: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseBody = resolve;
    });
    // Simulates the real contract (lifecycle.ts's header comment): closing the session makes the
    // in-flight body reject, which is what actually unwinds the try/finally on a real run.
    const body = (): Promise<never> => gate.then(() => Promise.reject(new Error('interrupted')));

    const runPromise = runWithShutdown(c, body, (l) => lines.push(l)).then(
      () => undefined,
      (err: unknown) => err,
    );

    // Node passes the signal name as the listener's argument; emit it explicitly (unlike a real
    // signal, `process.emit('SIGINT')` alone would call the handler with `sig === undefined`).
    process.emit('SIGINT', 'SIGINT');
    // Let the signal handler's fire-and-forget abort().then(close) microtasks settle.
    await new Promise((resolve) => setImmediate(resolve));
    releaseBody?.();
    const err = await runPromise;

    expect(err).toBeInstanceOf(InterruptedError);
    expect((err as InterruptedError).signal).toBe('SIGINT');
    expect((err as Error).cause).toEqual(new Error('interrupted'));

    expect(abort).toHaveBeenCalledWith('iv-1', 'cli-signal', expect.stringContaining('SIGINT'));
    expect(lines.some((l) => l === '\nSIGINT: shutting down')).toBe(true);
    expect(lines.some((l) => l.includes('SIGINT') && l.includes('run dir:'))).toBe(false);
    const runDirLines = lines.filter((l) => l.includes('run dir:'));
    expect(runDirLines).toEqual(['run dir: /tmp/fake-run-dir']);
  });

  it('throws InterruptedError even when the body resolves normally after the signal (replay reports a result instead of throwing)', async () => {
    const { c, close } = fakeComposition();
    const lines: string[] = [];
    let releaseBody: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseBody = resolve;
    });

    const runPromise = runWithShutdown(c, () => gate.then(() => 'result-after-close'), (l) => lines.push(l));
    const settled = runPromise.then(
      (v) => ({ ok: true as const, v }),
      (e: unknown) => ({ ok: false as const, e }),
    );

    process.emit('SIGINT', 'SIGINT');
    expect(process.exitCode).toBe(INTERRUPTED_EXIT_CODE);
    await new Promise((resolve) => setImmediate(resolve));
    releaseBody?.();
    const outcome = await settled;

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(isInterruptedError(outcome.e)).toBe(true);
      expect((outcome.e as InterruptedError).signal).toBe('SIGINT');
    }
    expect(close).toHaveBeenCalled();
    expect(lines.filter((l) => l.includes('run dir:'))).toEqual(['run dir: /tmp/fake-run-dir']);
  });

  it('passes a body error through unchanged when no signal arrived', async () => {
    const { c } = fakeComposition();
    const boom = new Error('boom');
    await expect(runWithShutdown(c, () => Promise.reject(boom), () => undefined)).rejects.toBe(boom);
  });

  it('removes its signal listeners once the run is over', async () => {
    const { c } = fakeComposition();
    const before = process.listenerCount('SIGINT');
    await runWithShutdown(c, async () => 'ok', () => undefined);
    expect(process.listenerCount('SIGINT')).toBe(before);
  });
});

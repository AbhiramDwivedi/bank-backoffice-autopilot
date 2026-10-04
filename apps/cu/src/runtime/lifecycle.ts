/**
 * Graceful shutdown for commands that own a live session: close the browser and stop the
 * operator server on completion, on error, and on SIGINT/SIGTERM. The run dir is printed exactly
 * once, on every path (a run that was interrupted still has evidence worth reading) -- by the
 * `finally` block below, never by the signal handler itself, so an interrupted run does not print
 * it twice.
 *
 * The first signal does NOT call process.exit(): it aborts any open intervention and closes the
 * session, so the in-flight body settles and unwinds through the callers' own finally blocks
 * (fault restore, operator server close). Once the body has settled, an interrupted run always
 * ends in an `InterruptedError`, whether the body resolved (replay reports a result even when its
 * browser was closed under it) or rejected. Callers map that error to `INTERRUPTED_EXIT_CODE`
 * (130) and stop any further work (e.g. the rest of a `--times` series) instead of reporting the
 * body's result. process.exitCode is also set to 130 by the handler, for callers that do not catch.
 * A second signal forces the exit.
 */
import type { Composition } from './compose.js';

/** Process exit code for a run interrupted by SIGINT/SIGTERM (128 + SIGINT's signal number). */
export const INTERRUPTED_EXIT_CODE = 130;

/** Thrown by {@link runWithShutdown} once an interrupted run has shut down. `cause` is the body's
 *  own error, when it rejected. */
export class InterruptedError extends Error {
  readonly signal: NodeJS.Signals;

  constructor(signal: NodeJS.Signals, cause?: unknown) {
    super(`interrupted by ${signal}`, cause !== undefined ? { cause } : undefined);
    this.name = 'InterruptedError';
    this.signal = signal;
  }
}

/** True for an {@link InterruptedError} (also across module copies, by name). */
export function isInterruptedError(err: unknown): err is InterruptedError {
  return err instanceof InterruptedError || (err instanceof Error && err.name === 'InterruptedError');
}

/** Runs `body` under graceful shutdown: closes `c` on completion, on error, and on
 * SIGINT/SIGTERM. Throws {@link InterruptedError} when a signal arrived during the run (see the
 * module header for the signal-handling contract). */
export async function runWithShutdown<T>(c: Composition, body: () => Promise<T>, print: (line: string) => void = (l) => console.error(l)): Promise<T> {
  let interruptedBy: NodeJS.Signals | undefined;
  const onSignal = (sig: NodeJS.Signals): void => {
    if (interruptedBy !== undefined) process.exit(INTERRUPTED_EXIT_CODE);
    interruptedBy = sig;
    process.exitCode = INTERRUPTED_EXIT_CODE;
    print(`\n${sig}: shutting down`);
    // A run parked on a human (open intervention) would never unwind: abort it first so the
    // pending escalation resolves with 'abort', then close the session.
    const id = c.broker.token.interventionId;
    const abort = id !== undefined && !c.broker.terminated ? c.broker.abort(id, 'cli-signal', `interrupted by ${sig}`).then(() => undefined, () => undefined) : Promise.resolve();
    void abort.then(() => c.close());
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  let value: T;
  try {
    value = await body();
  } catch (err) {
    if (interruptedBy !== undefined) throw new InterruptedError(interruptedBy, err);
    throw err;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    await c.close();
    print(`run dir: ${c.logger.dir}`);
  }
  if (interruptedBy !== undefined) throw new InterruptedError(interruptedBy);
  return value;
}

/**
 * Local debug sink for raw browser messages. What the surface returns to the model, the evidence
 * and Relay is fixed, page-free text (a browser error can quote the page: an element's text, a
 * typed value). The raw message is still what a developer needs to diagnose a failure, so with
 * `CU_DEBUG=1` (or `true`) it is written to this process's stderr, and nowhere else: not to the run
 * log, not to events.jsonl, not to any port.
 */

/** True when `CU_DEBUG` asks for raw browser messages on stderr. Read per call, so tests can toggle it. */
export function debugEnabled(): boolean {
  const v = process.env['CU_DEBUG'];
  return v === '1' || v === 'true';
}

/** Writes `[cu-debug] <where>: <raw message>` to stderr when `CU_DEBUG` is on; never throws. */
export function debugRaw(where: string, err: unknown): void {
  if (!debugEnabled()) return;
  try {
    const raw = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    process.stderr.write(`[cu-debug] ${where}: ${raw}\n`);
  } catch {
    /* stderr closed */
  }
}

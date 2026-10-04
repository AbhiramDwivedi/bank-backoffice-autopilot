/**
 * Run logger wrapper that scrubs every bound secret and sensitive value before anything reaches
 * the evidence sink. It complements the logger's own key and pattern redaction, which only knows
 * shapes, not the values bound in this run. `RunState.logger` always holds this wrapper, so no
 * code path in replay can bypass it.
 */
import { scrubMarkup, type RunLogger } from '../evidence/index.js';
import type { Scrubber } from './types.js';

/** Values shorter than this are not scrubbed; redacting two-letter codes destroys unrelated log text. */
export const SCRUB_MIN_LENGTH = 3;

/** Wraps `logger` so event data, DOM snapshots and the final result pass through `scrubber`. */
export function createSafeLogger(logger: RunLogger, scrubber: Scrubber): RunLogger {
  return {
    dir: logger.dir,
    runId: logger.runId,
    event(e) {
      return logger.event({ ...e, data: e.data !== undefined ? scrubber.deep(e.data) : e.data });
    },
    screenshot(buf, seq) {
      return logger.screenshot(buf, seq);
    },
    dom(html, seq) {
      // Text, comments and attribute values only: tags, attribute names and the snapshot's CSP stay intact.
      return logger.dom(scrubMarkup(html, scrubber), seq);
    },
    finish(result) {
      // deep() replaces string leaves only, so the ReplayResult shape that finish() validates is unchanged.
      return logger.finish(scrubber.deep(result));
    },
  };
}

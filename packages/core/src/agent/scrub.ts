/**
 * Scrubbing for everything the discovery agent sends to the model or writes to disk.
 *
 * Two layers run in order. The shared redactor first replaces sensitive keys and secret-shaped
 * patterns. The value scrubber then replaces every known secret and sensitive input value with a
 * named placeholder (`<secret:ENV>`, `<sensitive:name>`). Running the value layer last keeps the
 * named placeholders from being overwritten by a key-based `[REDACTED:key]`.
 */
import { createRedactor, createValueScrubber, redactionPatternsFromPolicy, type ScrubValue } from '../evidence/index.js';
import type { Policy } from '../schema/index.js';

/** Inputs to {@link createScrubber}: the run's known secret and sensitive values, plus any
 *  policy-defined redaction patterns. */
export interface ScrubberOptions {
  /** Environment variable name to resolved value. */
  secrets: Record<string, string>;
  /** Input name to concrete run value. */
  sensitiveInputs: Record<string, string>;
  policyPatterns?: Policy['redaction']['patterns'];
}

/** Scrubs secret, sensitive, and pattern-matched values out of strings and JSON-like values. */
export interface Scrubber {
  text(s: string): string;
  /** Returns a deep copy with every string leaf scrubbed. Object keys are not scrubbed. */
  deep<T>(v: T): T;
  /** All non-empty secret and sensitive values (the raw values, not the placeholders), including ones added mid-run. */
  readonly forbidden: readonly string[];
  /**
   * Registers a value that became sensitive mid-run (text read from a masked element), scrubbed as
   * `placeholder` from then on. Values shorter than {@link MIN_ADDED_VALUE_LENGTH} are ignored: a
   * short value ("12", "0.00") would scrub unrelated text everywhere.
   */
  add(value: string, placeholder: string): void;
}

/** Shortest value {@link Scrubber.add} registers. */
export const MIN_ADDED_VALUE_LENGTH = 3;

/** Creates the agent's scrubber from this run's secrets and sensitive inputs. */
export function createScrubber(o: ScrubberOptions): Scrubber {
  const known: ScrubValue[] = [
    ...Object.entries(o.secrets).map(([name, value]) => ({ value, placeholder: `<secret:${name}>` })),
    ...Object.entries(o.sensitiveInputs).map(([name, value]) => ({ value, placeholder: `<sensitive:${name}>` })),
  ];
  const values = createValueScrubber(known, { numbers: true });
  const redactor = createRedactor({ patterns: o.policyPatterns ? redactionPatternsFromPolicy(o.policyPatterns) : [] });

  return {
    text(s: string): string {
      const redacted = redactor(s);
      return values.text(typeof redacted === 'string' ? redacted : s);
    },
    deep<T>(v: T): T {
      return values.deep(redactor(v)) as T;
    },
    get forbidden(): readonly string[] {
      return values.values();
    },
    add(value: string, placeholder: string): void {
      const v = value.trim();
      if (v.length >= MIN_ADDED_VALUE_LENGTH) values.add(v, placeholder);
    },
  };
}

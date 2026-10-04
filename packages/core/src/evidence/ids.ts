/**
 * Evidence identifiers.
 *
 * Run ids and intervention ids are used as directory / file names on disk (`runs/<runId>/...`),
 * so the id alphabet is restricted to lowercase alphanumerics — filename- and URL-safe on every
 * OS, no escaping needed.
 *
 * Format: `<prefix>_<yyyymmdd>_<nanoid8>`, date in UTC so ids sort and group consistently
 * regardless of the host machine's local timezone.
 */
import { customAlphabet } from 'nanoid';

/** Lowercase alphanumerics only — safe in filenames, URLs, and shells without quoting. */
const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const nanoid8 = customAlphabet(ID_ALPHABET, 8);

function yyyymmddUtc(now: Date): string {
  const y = String(now.getUTCFullYear()).padStart(4, '0');
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

/** Matches ids produced by {@link newRunId}. */
export const RUN_ID_RE = /^run_\d{8}_[0-9a-z]{8}$/;
/** Matches ids produced by {@link newInterventionId}. */
export const INTERVENTION_ID_RE = /^int_\d{8}_[0-9a-z]{8}$/;

/** `run_<yyyymmdd>_<nanoid8>` — date is UTC. */
export function newRunId(now: Date = new Date()): string {
  return `run_${yyyymmddUtc(now)}_${nanoid8()}`;
}

/** `int_<yyyymmdd>_<nanoid8>` — date is UTC. */
export function newInterventionId(now: Date = new Date()): string {
  return `int_${yyyymmddUtc(now)}_${nanoid8()}`;
}

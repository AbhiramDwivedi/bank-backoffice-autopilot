/**
 * Fetch-based helpers for the mock app's test-harness endpoints (/__reset, /__faults). Only the
 * CLI/recording process itself is allowed to call these directly (the replay policy denies them
 * to the automated surface); record.ts is "the operator of this demo" the same way the CLI's
 * --fault flag is documented to be.
 */
import { VIDEO_BASE_URL } from './contracts.js';

/** Resets mock-app state (faults to default, seed data, maintenance interstitial) so each
 *  scenario starts from a known baseline. */
export async function resetMockApp(baseUrl: string = VIDEO_BASE_URL): Promise<void> {
  const res = await fetch(`${baseUrl}/__reset`, { method: 'POST' });
  if (!res.ok) throw new Error(`POST ${baseUrl}/__reset -> HTTP ${res.status}`);
}

/**
 * Merges `body` into the mock app's live fault flags. Returns the previous snapshot so the caller
 * can restore it afterwards (mirrors the CLI's --fault handling, including its two rules):
 *
 * - The mock app answers 200 with a `rejected` list for keys it did not apply. Any rejected key
 *   throws, naming the keys, so a recording never runs a scenario without the fault it asked for.
 * - The snapshot carries `chaos` only when `body` sets `chaos` itself. Posting a chaos config
 *   restarts its streams, so restoring one that was already running would rewind it.
 */
export async function setFaults(body: unknown, baseUrl: string = VIDEO_BASE_URL): Promise<unknown> {
  const before = await fetch(`${baseUrl}/__faults`);
  if (!before.ok) throw new Error(`GET ${baseUrl}/__faults -> HTTP ${before.status}`);
  const snapshot: unknown = await before.json();
  const res = await fetch(`${baseUrl}/__faults`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${baseUrl}/__faults -> HTTP ${res.status}`);
  const reply: unknown = await res.json().catch(() => undefined);
  const rejected = reply !== null && typeof reply === 'object' ? (reply as { rejected?: unknown }).rejected : undefined;
  if (Array.isArray(rejected) && rejected.length > 0) {
    throw new Error(`POST ${baseUrl}/__faults: the mock app rejected ${rejected.map(String).join(', ')}`);
  }
  const setsChaos = body !== null && typeof body === 'object' && 'chaos' in body;
  if (!setsChaos && snapshot !== null && typeof snapshot === 'object' && 'chaos' in snapshot) {
    const flags: Record<string, unknown> = { ...(snapshot as Record<string, unknown>) };
    delete flags.chaos;
    return flags;
  }
  return snapshot;
}

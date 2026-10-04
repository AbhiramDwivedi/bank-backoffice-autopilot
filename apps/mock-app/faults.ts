import { parseChaos, type ChaosConfig } from './chaos.js';

/**
 * Fault-injection flags toggled through the mock app's /__faults endpoint.
 *
 * `GET /__faults` returns this object as-is, and posting that JSON back restores the same
 * configuration (`replay --fault` and the video recorder snapshot and restore it this way; an
 * active chaos config restarts its streams from the seed when posted), so every field here
 * must be plain, round-trippable configuration. Live chaos counters and the chaos log are runtime
 * state and live on `AppContext.chaos`, served by `GET /__faults/chaos` instead.
 */
export interface Faults {
  /** Delay every non-/__ response by N ms. 0 = off. */
  slowMs: number;
  /** GET /members/search returns HTTP 500 "Application Error" page. */
  failSearch: boolean;
  /** Next authenticated request clears the session and redirects to /session-expired; then auto-clears. */
  expireSession: boolean;
  /** Maintenance interstitial shown once per session on the first main-content page. Default ON. */
  interstitial: boolean;
  /** Member id that additionally returns 403 on detail and sub-account routes. '' = off. */
  denyMember: string;
  /**
   * Seeded, probabilistic versions of the faults above (chaos.ts). null = off (the default). An
   * explicit switch always wins over chaos for the same fault on the same request: chaos only
   * draws where the switch would not already inject that fault.
   */
  chaos: ChaosConfig | null;
}

/** Returns a fresh set of fault flags with everything at its default (interstitial on, all others off, no chaos). */
export function defaultFaults(): Faults {
  return { slowMs: 0, failSearch: false, expireSession: false, interstitial: true, denyMember: '', chaos: null };
}

/**
 * Merge a JSON body into the flags. Unknown keys and wrongly-typed values are not applied; they
 * are returned so the caller can report them (a harness typo should be visible, not silent).
 * Top-level keys merge independently, as they always have. The `chaos` value is validated as a
 * whole (chaos.ts `parseChaos`): one bad sub-key rejects all of it and leaves the previous chaos
 * config in place. An accepted `chaos` object is always stored as a new object, which restarts
 * the chaos streams from its seed (see `chaosRuntime` in context.ts).
 */
export function mergeFaults(target: Faults, body: unknown): string[] {
  const rejected: string[] = [];
  // A non-object body (array, scalar, or unparsed because of a wrong content-type) is itself a
  // harness error: report it rather than returning an empty, successful-looking merge.
  if (!body || typeof body !== 'object' || Array.isArray(body)) return ['(body: expected a JSON object)'];
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    switch (k) {
      case 'slowMs':
        if (typeof v === 'number' && Number.isFinite(v) && v >= 0) target.slowMs = Math.floor(v);
        else rejected.push(k);
        break;
      case 'failSearch':
      case 'expireSession':
      case 'interstitial':
        if (typeof v === 'boolean') target[k] = v;
        else rejected.push(k);
        break;
      case 'denyMember':
        if (typeof v === 'string') target.denyMember = v;
        else if (v === null) target.denyMember = '';
        else rejected.push(k);
        break;
      case 'chaos': {
        const parsed = parseChaos(v);
        if (parsed.ok) target.chaos = parsed.config;
        else rejected.push(...parsed.rejected);
        break;
      }
      default:
        rejected.push(k);
    }
  }
  return rejected;
}

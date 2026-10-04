import type { Request, Response } from 'express';
import { createChaosRuntime, drawFault, type ChaosRuntime, type DrawSite } from './chaos.js';
import type { AppState, Member } from './data/seed.js';
import type { Faults } from './faults.js';
import type { SessionStore } from './session.js';
import type { TenantConfig } from './tenant.js';

/**
 * Everything a route module needs. One context per createApp() instance: no module-level
 * mutable state, so tests can run many isolated apps in one process.
 */
export interface AppContext {
  tenant: TenantConfig;
  /** Mutable; POST /__reset replaces ctx.state with a fresh seed. Always read via ctx.state. */
  state: AppState;
  faults: Faults;
  /**
   * Live chaos streams, counters and log, built from `faults.chaos`. Always read through
   * {@link chaosRuntime}, which rebuilds it when the config changed; never set it directly.
   */
  chaos: ChaosRuntime | null;
  sessions: SessionStore;
  /** Password for operator1. */
  password: string;
}

/**
 * The chaos runtime for the current `faults.chaos` config, or null when chaos is off. The runtime
 * remembers the config object it was built from; when `faults.chaos` is a different object (a new
 * `POST /__faults {"chaos": ...}`, `/__reset`, or a test assigning it directly) the old streams,
 * counters and log are discarded and fresh ones start from the seed.
 */
export function chaosRuntime(ctx: AppContext): ChaosRuntime | null {
  const config = ctx.faults.chaos;
  if (config === null) {
    ctx.chaos = null;
    return null;
  }
  if (ctx.chaos?.config !== config) ctx.chaos = createChaosRuntime(config);
  return ctx.chaos;
}

/** Chaos draws only on the member (transaction) routes; see chaos.ts for why. */
export function isTransactionPath(path: string): boolean {
  return path.toLowerCase().startsWith('/members/');
}

/** The chaos-log view of a request: method and path, never the query string or cookies. */
export function drawSite(req: Request): DrawSite {
  return { method: req.method, path: req.path };
}

/**
 * Whether the maintenance interstitial goes into this main-content page. Main-content pages
 * (search, detail, sub-account form, confirmation) pass the result to their view as
 * `interstitial`, and the view includes partials/interstitial.
 *
 * The `interstitial` switch shows it exactly once per session, on the first such page. Chaos
 * `interstitial` draws only on the pages where the switch did not already show it, so a
 * deterministic test of the once-per-session notice is never made probabilistic.
 */
export function takeInterstitial(ctx: AppContext, req: Request): boolean {
  const s = ctx.sessions.get(req);
  if (!s) return false;
  if (ctx.faults.interstitial && !s.interstitialShown) {
    s.interstitialShown = true;
    return true;
  }
  return drawFault(chaosRuntime(ctx), 'interstitial', drawSite(req));
}

/**
 * Resolve a member for detail/sub-account routes. On failure it has already sent the response
 * (404 "member-not-found" view, or 403 "access-denied" view) and returns undefined.
 * 403 when the member is restricted OR equals the `denyMember` fault.
 */
export function resolveMember(ctx: AppContext, req: Request, res: Response, id: string): Member | undefined {
  const m = ctx.state.members.get(id);
  if (!m) {
    res.status(404).render('member-not-found', { memberId: id, interstitial: takeInterstitial(ctx, req) });
    return undefined;
  }
  if (m.restricted || (ctx.faults.denyMember !== '' && ctx.faults.denyMember === id)) {
    res.status(403).render('access-denied', { memberId: id });
    return undefined;
  }
  return m;
}

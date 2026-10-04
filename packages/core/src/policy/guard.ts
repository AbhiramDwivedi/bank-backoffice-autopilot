/**
 * `createPolicyGuard`: a pure, synchronous decision function over a `Policy` -- an allowlist of
 * origins/routes/action types, with conservative handling of risky/irreversible actions. It has
 * no knowledge of `Surface`, refs, or descriptors: callers (the policy-enforcing surface in
 * `enforcing-surface.ts`) are responsible for turning "a ref" or "a TargetDescriptor" into the
 * plain `{ targetName, targetText, currentUrl }` context this needs. That split keeps this
 * module trivially unit-testable and keeps "finding out what a target currently is"
 * (async, surface-specific, TOCTOU-sensitive) out of the one place that needs to be simple and
 * synchronous.
 *
 * Regex convention (see packages/core/src/policy/load.ts): every regex *source* string embedded in a `Policy`
 * is compiled here, once (at `createPolicyGuard` time), with the 'i' flag and no others.
 */
import type { Action, ActionType, Policy, RiskClass } from '../schema/index.js';
import { RISK_ORDER } from '../schema/index.js';
import {
  DESKTOP_PROTOCOL,
  committingKey,
  decodedDesktopLocation,
  desktopOrigin,
  desktopUrlProblem,
  isDesktopUrl,
  parseDesktopUrl,
  resolveDesktopRelative,
  urlShapeRefusal,
  type SurfaceAction,
} from '../surface/index.js';

/**
 * Either shape an action can be classified in: a bound `SurfaceAction` (agent/replay time, target
 * already a ref or a `TargetDescriptor` about to be resolved) or a raw `Action` straight out of a
 * `Capability` (target not yet resolved at all). `classifyRisk`/`checkAction` never look at
 * `.target`/`.value` directly -- only at `ctx.targetName`/`ctx.targetText` -- so both shapes are
 * classified identically.
 */
export type PolicyActionLike = SurfaceAction | Action;

/**
 * Context the caller supplies about the action being classified/checked. Deliberately excludes
 * the action's raw target: resolving *what a target currently is* (ref vs descriptor, live vs
 * snapshot text, following a ref through to a live element) is the policy-enforcing surface's
 * job (it alone can do it without a TOCTOU gap), not the guard's.
 */
export interface PolicyActionContext {
  /** Live (or best-known) accessible name of the action's target, if it has one. */
  targetName?: string;
  /** Live (or best-known) visible text of the action's target, if it has one. For
   * `dismiss_dialog`, this is the pending dialog's message, if the caller knows it. */
  targetText?: string;
  /**
   * URL of the frame/document the action acts against. For `navigate`, this is the URL being
   * navigated *from* -- used only to resolve a relative target URL before checking it.
   */
  currentUrl: string;
  /**
   * Forces the effective risk to at least this class. Can only ever *raise* the risk
   * `classifyRisk` would otherwise compute, never lower it -- see `checkAction`'s doc comment.
   * A capability step marked `risk: 'read'` cannot downgrade a "Confirm" click to non-irreversible;
   * it can only make an otherwise-reversible/read step be treated as more dangerous than the
   * text/URL heuristics alone would say.
   */
  riskOverride?: RiskClass;
}

/** Result of {@link PolicyGuard.checkUrl}. */
export interface PolicyUrlCheck {
  allowed: boolean;
  reason: string;
}

/** Result of {@link PolicyGuard.checkAction}. */
export interface PolicyActionDecision {
  decision: 'allow' | 'deny' | 'flag_irreversible';
  reason: string;
  risk: RiskClass;
}

/** Pure, synchronous policy decision engine created by {@link createPolicyGuard}. */
export interface PolicyGuard {
  /**
   * Origin must EXACTLY equal one of `policy.allowedOrigins` (both normalized via
   * {@link allowlistOrigin}). The pathname is normalized before matching -- percent-decoded once,
   * repeated `/` collapsed, `.`/`..` segments resolved -- so a deny pattern can't be evaded by
   * encoding, doubled slashes, or a `..` escape; a pathname with a malformed percent-escape is
   * denied outright. `deniedPathPatterns` (matched against the lower-cased normalized path) wins
   * over `allowedPathPatterns` (matched against the normalized, case-preserved path; empty =
   * all paths on an allowed origin are in scope). An unparseable URL, or one whose scheme isn't
   * `http:`/`https:`/`desktop:` (so `javascript:`, `data:`, `file:`, and also
   * `about:blank`/`about:srcdoc`), is always denied.
   *
   * A desktop location (`desktop://<process>/<window title>`, see
   * `packages/core/src/surface/desktop-location.ts`) is allowed only by a `desktop://<process>`
   * entry naming exactly that process (case-insensitive, no wildcards); its path is `/` plus the
   * decoded window title, matched by the same path patterns, without dot-segment resolution (a
   * title is not a path). A malformed desktop location is denied.
   */
  checkUrl(url: string): PolicyUrlCheck;
  /**
   * 1. `action.type` not in `policy.allowedActions` -> `deny`.
   * 2. `navigate`: resolve `action.url` against `ctx.currentUrl` if relative, then `checkUrl` it
   *    -> `deny` if not allowed.
   * 3. Effective risk = `ctx.riskOverride` raised over `classifyRisk(action, ctx)` (never
   *    lowered). `irreversible` -> `flag_irreversible`; otherwise -> `allow`.
   */
  checkAction(action: PolicyActionLike, ctx: PolicyActionContext): PolicyActionDecision;
  /**
   * click / select / press of a committing key (Enter, NumpadEnter, Space; see
   * `isCommittingKeyPress`) / type with `pressEnter: true`, on a target whose
   * `ctx.targetName` or `ctx.targetText` matches `risk.irreversibleTextPatterns`, OR whose
   * `ctx.currentUrl` matches `risk.irreversibleUrlPatterns` -> `irreversible`. `navigate` to a
   * URL (resolved against `ctx.currentUrl`) matching `risk.irreversibleUrlPatterns` ->
   * `irreversible`. Any other `type`/`select`/`click` -> `reversible`. `extract`/`wait`/
   * `switch_frame`/`dismiss_dialog(accept:false)`/an allowed `navigate`/`press` of a non-Enter
   * key -> `read`. `dismiss_dialog(accept:true)` -> `reversible`, UNLESS `ctx.targetText` (the
   * dialog's message, when the caller knows it) matches `irreversibleTextPatterns` -> then
   * `irreversible` (a confirm() accept can be the final step of an irreversible flow).
   */
  classifyRisk(action: PolicyActionLike, ctx: Pick<PolicyActionContext, 'targetName' | 'targetText' | 'currentUrl'>): RiskClass;
  readonly limits: Policy['limits'];
  readonly policy: Policy;
}

/**
 * Resolves `url` against `base` when it's relative; returns `url` unchanged (letting the
 * caller's own URL parsing surface the real problem) if either fails to parse. Exported so the
 * policy-enforcing surface can resolve a `navigate` target the same way (e.g. to pre-check it
 * while quarantined) without duplicating this logic.
 */
export function resolveRelativeUrl(url: string, base: string): string {
  // A UNC path, a protocol-relative URL or a backslash is never resolved: it is returned as written,
  // and checkUrl refuses it (a browser handed the raw string would load a file: page).
  if (urlShapeRefusal(url) !== undefined) return url;
  // Against a desktop location: the same resolution the desktop surface uses (no dot segments).
  const desktop = resolveDesktopRelative(url, base);
  if (desktop !== undefined) return desktop;
  try {
    return new URL(url, base).toString();
  } catch {
    return url;
  }
}

/**
 * The allowlist identity of a URL: `URL.origin` for http(s); `desktop://<process>` (lower-cased,
 * see `desktopOrigin`) for a well-formed desktop location; undefined for anything else, including
 * every scheme whose `URL.origin` is the opaque string "null" -- so no two such URLs, and no such
 * URL and an allowlist entry, can ever compare equal through it. The one origin notion shared by
 * the guard, the composition root's per-run narrowing and the CLI's fail-fast check.
 */
export function allowlistOrigin(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.origin;
  if (parsed.protocol === DESKTOP_PROTOCOL) {
    const loc = parseDesktopUrl(url);
    return loc ? desktopOrigin(loc.processName) : undefined;
  }
  return undefined;
}

function compileAll(sources: readonly string[]): RegExp[] {
  return sources.map((source) => new RegExp(source, 'i'));
}

/**
 * Percent-decodes a pathname once, collapses repeated `/`, and resolves `.`/`..` segments -- the
 * same normalization a browser applies before issuing a request, so `checkUrl` matches deny/allow
 * patterns against the path that would actually go out on the wire, and a deny pattern can't be
 * evaded by encoding, a doubled slash, or a `..` escape. A pathname whose percent-encoding cannot
 * be decoded (a malformed escape) is reported as such rather than matched partially decoded.
 */
function normalizePathname(pathname: string): { ok: true; value: string } | { ok: false } {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return { ok: false };
  }
  const segments = decoded.replace(/\/{2,}/g, '/').split('/');
  const resolved: string[] = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      resolved.pop();
      continue;
    }
    resolved.push(segment);
  }
  return { ok: true, value: `/${resolved.join('/')}` };
}

function matchesAny(regexes: readonly RegExp[], value: string): boolean {
  return regexes.some((re) => re.test(value));
}

/**
 * True for a `press` of a key that activates the focused control: Enter in every spelling a
 * surface accepts (`Enter`, `Return`, `"\r"`, `"\n"`), NumpadEnter, Space (`Space`, `" "`,
 * `Spacebar`). One table (`committingKey`, core surface module) shared with both surfaces, which
 * press exactly the normalized key, so the guard and the surfaces cannot disagree.
 */
export function isCommittingKeyPress(action: PolicyActionLike): boolean {
  return action.type === 'press' && committingKey(action.key) !== undefined;
}

/**
 * Tests URL regexes against a URL, and for a desktop location also against its decoded form
 * (`desktop://<process>/<window title as shown>`), so a pattern written with a title's spaces
 * matches. Only ever adds matches, so it can only make a classification more conservative.
 */
function urlMatchesAny(regexes: readonly RegExp[], url: string): boolean {
  if (matchesAny(regexes, url)) return true;
  const decoded = decodedDesktopLocation(url);
  return decoded !== undefined && matchesAny(regexes, decoded);
}

/**
 * Compiles `policy`'s regex sources once and returns a {@link PolicyGuard} bound to it. Throws on
 * an `allowedOrigins` entry that is neither an http(s) origin nor a desktop://<process> location:
 * a malformed entry must fail loudly, not silently allow nothing.
 */
export function createPolicyGuard(policy: Policy): PolicyGuard {
  const allowedOriginSet = new Set(
    policy.allowedOrigins.map((entry) => {
      const origin = allowlistOrigin(entry);
      if (origin === undefined) {
        const detail = isDesktopUrl(entry) ? `: ${desktopUrlProblem(entry) ?? 'malformed'}` : '';
        throw new Error(`policy '${policy.name}': allowedOrigins entry '${entry}' is neither an http(s) origin nor a desktop://<process> location${detail}`);
      }
      return origin;
    }),
  );
  const allowedActionSet = new Set<ActionType>(policy.allowedActions);
  const deniedPathRegexes = compileAll(policy.deniedPathPatterns);
  const allowedPathRegexes = compileAll(policy.allowedPathPatterns);
  const irreversibleTextRegexes = compileAll(policy.risk.irreversibleTextPatterns);
  const irreversibleUrlRegexes = compileAll(policy.risk.irreversibleUrlPatterns);

  function checkUrl(url: string): PolicyUrlCheck {
    const shape = urlShapeRefusal(url);
    if (shape !== undefined) return { allowed: false, reason: shape };
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { allowed: false, reason: `'${url}' is not a parseable URL` };
    }
    if (parsed.protocol === DESKTOP_PROTOCOL) return checkDesktopUrl(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { allowed: false, reason: `scheme '${parsed.protocol}' is not http(s)` };
    }
    if (!allowedOriginSet.has(parsed.origin)) {
      return { allowed: false, reason: `origin '${parsed.origin}' is not an allowed origin` };
    }
    const normalized = normalizePathname(parsed.pathname);
    if (!normalized.ok) {
      return { allowed: false, reason: `path '${parsed.pathname}' contains a percent-escape that cannot be decoded` };
    }
    if (matchesAny(deniedPathRegexes, normalized.value.toLowerCase())) {
      return { allowed: false, reason: `path '${parsed.pathname}' matches a denied path pattern` };
    }
    if (allowedPathRegexes.length > 0 && !matchesAny(allowedPathRegexes, normalized.value)) {
      return { allowed: false, reason: `path '${parsed.pathname}' matches no allowed path pattern` };
    }
    return { allowed: true, reason: 'origin and path allowed' };
  }

  /** `checkUrl` for a desktop location; see its doc comment. */
  function checkDesktopUrl(url: string): PolicyUrlCheck {
    const loc = parseDesktopUrl(url);
    if (!loc) return { allowed: false, reason: `'${url}' is not a well-formed desktop://<process>/<window title> location` };
    const origin = desktopOrigin(loc.processName);
    if (!allowedOriginSet.has(origin)) return { allowed: false, reason: `origin '${origin}' is not an allowed origin` };
    const path = `/${loc.title ?? ''}`;
    if (matchesAny(deniedPathRegexes, path.toLowerCase())) {
      return { allowed: false, reason: `window '${loc.title ?? ''}' matches a denied path pattern` };
    }
    if (allowedPathRegexes.length > 0 && !matchesAny(allowedPathRegexes, path)) {
      return { allowed: false, reason: `window '${loc.title ?? ''}' matches no allowed path pattern` };
    }
    return { allowed: true, reason: 'process and window allowed' };
  }

  /** Whether the *target* side of the irreversible check fires: live name/text match, or the
   * current page/frame URL itself matches an irreversible-URL pattern (e.g. the sub-account
   * form's own page, independent of what's clicked on it). */
  function targetIsIrreversible(ctx: Pick<PolicyActionContext, 'targetName' | 'targetText' | 'currentUrl'>): boolean {
    if (ctx.targetName !== undefined && matchesAny(irreversibleTextRegexes, ctx.targetName)) return true;
    if (ctx.targetText !== undefined && matchesAny(irreversibleTextRegexes, ctx.targetText)) return true;
    if (urlMatchesAny(irreversibleUrlRegexes, ctx.currentUrl)) return true;
    return false;
  }

  function classifyRisk(action: PolicyActionLike, ctx: Pick<PolicyActionContext, 'targetName' | 'targetText' | 'currentUrl'>): RiskClass {
    switch (action.type) {
      case 'navigate': {
        const resolved = resolveRelativeUrl(action.url, ctx.currentUrl);
        return urlMatchesAny(irreversibleUrlRegexes, resolved) ? 'irreversible' : 'read';
      }
      case 'click':
      case 'select':
        return targetIsIrreversible(ctx) ? 'irreversible' : 'reversible';
      case 'type':
        if (action.pressEnter === true) return targetIsIrreversible(ctx) ? 'irreversible' : 'reversible';
        return 'reversible';
      case 'press':
        if (isCommittingKeyPress(action)) return targetIsIrreversible(ctx) ? 'irreversible' : 'reversible';
        return 'read';
      case 'dismiss_dialog':
        if (action.accept !== true) return 'read';
        if (ctx.targetText !== undefined && matchesAny(irreversibleTextRegexes, ctx.targetText)) return 'irreversible';
        return 'reversible';
      case 'extract':
      case 'wait':
      case 'switch_frame':
        return 'read';
      default: {
        const exhaustive: never = action;
        throw new Error(`classifyRisk: unhandled action ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  function checkAction(action: PolicyActionLike, ctx: PolicyActionContext): PolicyActionDecision {
    const baseRisk = classifyRisk(action, ctx);
    const risk = ctx.riskOverride !== undefined && RISK_ORDER[ctx.riskOverride] > RISK_ORDER[baseRisk] ? ctx.riskOverride : baseRisk;

    if (!allowedActionSet.has(action.type)) {
      return { decision: 'deny', reason: `action type '${action.type}' is not in policy '${policy.name}' allowedActions`, risk };
    }

    if (action.type === 'navigate') {
      const resolved = resolveRelativeUrl(action.url, ctx.currentUrl);
      const urlCheck = checkUrl(resolved);
      if (!urlCheck.allowed) {
        return { decision: 'deny', reason: `navigate to '${resolved}' denied: ${urlCheck.reason}`, risk };
      }
    }

    if (risk === 'irreversible') {
      return {
        decision: 'flag_irreversible',
        reason: `action classified irreversible by policy '${policy.name}'; requires allowIrreversible`,
        risk,
      };
    }
    return { decision: 'allow', reason: `action allowed (risk=${risk})`, risk };
  }

  return { checkUrl, checkAction, classifyRisk, limits: policy.limits, policy };
}

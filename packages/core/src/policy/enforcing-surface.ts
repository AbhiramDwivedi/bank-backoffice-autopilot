/**
 * Wraps a `Surface` so every `act()` (and, for quarantine detection, `observe()`) call is
 * checked against a `PolicyGuard` before it reaches the underlying surface. This is the only
 * place that decides whether an action runs; `PolicyGuard` itself is pure and has no notion of
 * Surfaces, refs, or descriptors.
 *
 * Non-obvious decisions:
 * - A target is resolved to a live description (`describeRef`) before classification, and the
 *   same resolved ref is what gets acted on -- no stale snapshot, no TOCTOU gap between check
 *   and act. Both the live description and the descriptor's own static text are checked; a
 *   match on either raises risk (`riskOverride` only ever raises, never lowers). An
 *   unknown/undescribable ref classifies as `irreversible`.
 * - An action that lands any frame on an off-policy URL quarantines the surface: only a
 *   `navigate` to an allowed URL, or `dismiss_dialog`, is permitted until every frame is
 *   on-policy again. The same allowlist check also runs *before* every action (not just after),
 *   so a surface that went off-policy with no `act()`/`observe()` call in between -- e.g. a human
 *   navigating away during a handoff -- is quarantined, and the action refused, before it ever
 *   reaches the inner surface.
 * - `press Enter` / `type(pressEnter: true)` can submit a control other than the one just
 *   classified (a legacy form's implicit submit), so this also scans the page for any enabled
 *   element matching `irreversibleTextPatterns` and raises risk if one exists.
 * - `PolicyDecisionEvent` describes the target (name/text/tag/role) but never carries a typed
 *   value.
 */
import type { ActionType, Condition, RiskClass, TargetDescriptor } from '../schema/index.js';
import {
  isRefTarget,
  type ActOptions,
  type ActResult,
  type CheckOptions,
  type HumanActionCapture,
  type Observation,
  type ReadTextResult,
  type RecordContext,
  type RecordTextResult,
  type RecordTextWithin,
  type RefDescription,
  type ResolvedTarget,
  type Resolution,
  type Surface,
  type SurfaceAction,
} from '../surface/index.js';
import { isCommittingKeyPress, resolveRelativeUrl, type PolicyGuard } from './guard.js';

/** One policy decision made about an action or observation, emitted via `WithPolicyOptions.onDecision`. */
export interface PolicyDecisionEvent {
  ts: string;
  /**
   * The action type this decision was made about. `'observe'` is used for a quarantine
   * transition detected from an `observe()` call rather than from `act()` -- there is no single
   * "action" to attribute it to in that case.
   */
  actionType: ActionType | 'observe';
  decision: 'allow' | 'deny' | 'flag_irreversible' | 'refused_irreversible' | 'quarantine' | 'quarantine_cleared';
  risk?: RiskClass;
  reason: string;
  /** What the target *is* -- never a typed value. Omitted for actions without a target. */
  target?: { name?: string; text?: string; tag?: string; role?: string };
  url?: string;
}

/** Configuration for {@link withPolicy}. */
export interface WithPolicyOptions {
  onDecision?: (event: PolicyDecisionEvent) => void;
  runKind?: 'discovery' | 'replay';
}

/** A `Surface` wrapped by {@link withPolicy}, exposing whether it is currently quarantined after
 * an off-policy navigation. */
export interface PolicySurface extends Surface {
  readonly quarantined: boolean;
  readonly quarantineReason?: string;
}

const NEUTRAL_FRAME_URLS: ReadonlySet<string> = new Set(['about:blank', 'about:srcdoc']);

/** Action types whose `SurfaceAction` variant carries a `target`. */
function hasTarget(action: SurfaceAction): action is Extract<SurfaceAction, { target: ResolvedTarget }> {
  return action.type === 'click' || action.type === 'type' || action.type === 'select' || action.type === 'extract';
}

/** Action types after which the frame-URL / quarantine check runs: the ones that can plausibly
 * cause navigation in some frame. */
function isQuarantineCheckedAction(actionType: ActionType): boolean {
  return (
    actionType === 'navigate' ||
    actionType === 'click' ||
    actionType === 'type' ||
    actionType === 'select' ||
    actionType === 'press' ||
    actionType === 'dismiss_dialog'
  );
}

/** Every text an author put on a `TargetDescriptor` that a human could plausibly read as the
 * control's name: its `description`, its record-time `snapshot` name/text, and each locator's own text/label/
 * role-name. Used alongside the live `describeRef` result -- see the file header. Also used by the
 * risk judge's static (audit-time) classification in `judge.ts`. */
export function descriptorTexts(descriptor: TargetDescriptor): string[] {
  // `description` is the author's own summary ("Confirm the transfer button"); a css/bbox-only
  // descriptor on a surface without describeRef would otherwise carry no readable text at all.
  const out: string[] = [descriptor.description];
  if (descriptor.snapshot?.name !== undefined) out.push(descriptor.snapshot.name);
  if (descriptor.snapshot?.text !== undefined) out.push(descriptor.snapshot.text);
  for (const locator of descriptor.locators) {
    const s = locator.strategy;
    if (s.kind === 'text') out.push(s.text);
    else if (s.kind === 'label') out.push(s.label);
    else if (s.kind === 'role') out.push(s.name);
  }
  return out;
}

function nowIso(): string {
  return new Date().toISOString();
}

interface TargetInfo {
  ref: string;
  name: string | undefined;
  text: string | undefined;
  frameUrl: string | undefined;
  eventTarget: PolicyDecisionEvent['target'];
  /** 'irreversible' when the target must be treated conservatively: an unknown/stale ref, or a
   * static descriptor text matched even though the live description alone didn't. */
  riskOverride: RiskClass | undefined;
}

type DescribeTargetResult = { ok: true; info: TargetInfo } | { ok: false; result: ActResult };

class EnforcingSurface implements PolicySurface {
  private quarantinedFlag = false;
  private quarantineReasonVal: string | undefined;
  private readonly irreversibleTextRegexes: RegExp[];
  readonly frameUrls: (() => Promise<string[]>) | undefined;
  readonly describeRef: ((ref: string) => Promise<RefDescription | undefined>) | undefined;
  readonly isSameElement: ((refA: string, refB: string) => Promise<boolean>) | undefined;
  readonly recordContextOf: ((ref: string) => RecordContext | undefined) | undefined;
  readonly readRecordText: ((target: ResolvedTarget, within: RecordTextWithin, timeoutMs: number) => Promise<RecordTextResult>) | undefined;

  constructor(
    private readonly inner: Surface,
    private readonly guard: PolicyGuard,
    private readonly opts: WithPolicyOptions,
  ) {
    this.irreversibleTextRegexes = this.guard.policy.risk.irreversibleTextPatterns.map((p) => new RegExp(p, 'i'));
    // Faithful passthrough of Surface's optional methods: present iff the inner surface has them.
    this.frameUrls = inner.frameUrls ? () => inner.frameUrls!() : undefined;
    this.describeRef = inner.describeRef ? (ref: string) => inner.describeRef!(ref) : undefined;
    this.isSameElement = inner.isSameElement ? (refA: string, refB: string) => inner.isSameElement!(refA, refB) : undefined;
    this.recordContextOf = inner.recordContextOf ? (ref: string) => inner.recordContextOf!(ref) : undefined;
    // A read of the container's text, for the identity check on a read: it acts on nothing.
    this.readRecordText = inner.readRecordText ? (target, within, timeoutMs) => inner.readRecordText!(target, within, timeoutMs) : undefined;
  }

  get quarantined(): boolean {
    return this.quarantinedFlag;
  }

  get quarantineReason(): string | undefined {
    return this.quarantineReasonVal;
  }

  get humanCapture(): HumanActionCapture | undefined {
    return this.inner.humanCapture;
  }

  private emit(event: PolicyDecisionEvent): void {
    this.opts.onDecision?.(event);
  }

  private matchesStaticText(texts: readonly string[]): boolean {
    return texts.some((t) => this.irreversibleTextRegexes.some((re) => re.test(t)));
  }

  /** Resolves+describes a click/type/select/extract target, per the file header's "no bypass" /
   * "resolve-then-act-by-ref" rules. Never touches `inner.act()`. */
  private async describeTarget(target: ResolvedTarget, timeoutMs: number): Promise<DescribeTargetResult> {
    if (isRefTarget(target)) {
      const desc = this.inner.describeRef ? await this.inner.describeRef(target.ref) : undefined;
      if (!desc) {
        // Unknown ref (no describeRef, or a stale/unrecognized ref): conservative default.
        return {
          ok: true,
          info: { ref: target.ref, name: undefined, text: undefined, frameUrl: undefined, eventTarget: undefined, riskOverride: 'irreversible' },
        };
      }
      // Classification reads the real text (a masked "Delete <member>" button is still a delete);
      // the decision event quotes only the masked view (screen masking).
      return {
        ok: true,
        info: {
          ref: target.ref,
          name: desc.classifyName ?? desc.name,
          text: desc.classifyText ?? desc.text,
          frameUrl: desc.frameUrl,
          eventTarget: { name: desc.name, text: desc.text, tag: desc.tag, role: desc.role },
          riskOverride: undefined,
        },
      };
    }

    const resolution: Resolution = await this.inner.resolve(target, timeoutMs);
    if (!resolution.found) {
      const detail = resolution.tried.map((t) => `${t.strategyKind}: ${t.error}`).join('; ');
      return { ok: false, result: { ok: false, error: { code: 'element_not_found', message: `${target.description}: ${detail}` } } };
    }
    const staticMatch = this.matchesStaticText(descriptorTexts(target));
    const liveDesc: RefDescription | undefined = this.inner.describeRef ? await this.inner.describeRef(resolution.ref) : undefined;
    const name = liveDesc?.classifyName ?? liveDesc?.name ?? target.snapshot?.name;
    const text = liveDesc?.classifyText ?? liveDesc?.text ?? target.snapshot?.text;
    const eventTarget: PolicyDecisionEvent['target'] = liveDesc
      ? { name: liveDesc.name, text: liveDesc.text, tag: liveDesc.tag, role: liveDesc.role }
      : { name: target.snapshot?.name, text: target.snapshot?.text, tag: target.snapshot?.tag };
    return {
      ok: true,
      info: { ref: resolution.ref, name, text, frameUrl: liveDesc?.frameUrl, eventTarget, riskOverride: staticMatch ? 'irreversible' : undefined },
    };
  }

  /** Best-effort: the pending dialog's message, for classifying `dismiss_dialog(accept: true)`.
   * `undefined` (-> `classifyRisk` treats it as `reversible`) if the surface has no answer, or
   * observing fails outright. */
  private async tryGetDialogMessage(): Promise<string | undefined> {
    try {
      const obs = await this.inner.observe();
      return obs.dialog?.message;
    } catch {
      return undefined;
    }
  }

  /** See the file header ("Enter can submit a different control than the one classified").
   * True iff the current page has at least one *enabled* element whose name/text matches
   * `irreversibleTextPatterns` -- i.e. Enter could plausibly be activating an irreversible
   * submit control, even though the acted-on target (or lack of one, for a bare `press`) doesn't
   * itself look irreversible. Fails closed: if `observe()` throws, an irreversible submit control
   * cannot be ruled out, so this returns `true` rather than silently trusting the target-only
   * classification. */
  private async enterMayActivateIrreversibleControl(): Promise<boolean> {
    try {
      const obs = await this.inner.observe();
      // A masked control's real text is unknown here, so a masked button or link counts (fail closed).
      return obs.elements.some(
        (e) =>
          e.enabled !== false &&
          (this.matchesStaticText([e.name, ...(e.text !== undefined ? [e.text] : [])]) || (e.masked === true && /^(button|link|clickable)$/.test(e.role))),
      );
    } catch {
      return true;
    }
  }

  private scanFrameUrls(actionType: ActionType | 'observe', urls: readonly string[]): void {
    const offending = urls.find((u) => !NEUTRAL_FRAME_URLS.has(u) && !this.guard.checkUrl(u).allowed);
    if (offending !== undefined) {
      const reason = `off-policy URL '${offending}' detected: ${this.guard.checkUrl(offending).reason}`;
      const wasQuarantined = this.quarantinedFlag;
      this.quarantinedFlag = true;
      this.quarantineReasonVal = reason;
      if (!wasQuarantined) this.emit({ ts: nowIso(), actionType, decision: 'quarantine', reason, url: offending });
      return;
    }
    if (this.quarantinedFlag) {
      this.quarantinedFlag = false;
      this.quarantineReasonVal = undefined;
      this.emit({ ts: nowIso(), actionType, decision: 'quarantine_cleared', reason: 'all observed frame URLs are back on-policy' });
    }
  }

  async act(action: SurfaceAction, timeoutMs: number, actOpts?: ActOptions): Promise<ActResult> {
    let cachedUrl: string | undefined;
    const currentUrl = async (): Promise<string> => {
      if (cachedUrl === undefined) cachedUrl = await this.inner.currentUrl();
      return cachedUrl;
    };

    // 1. Pre-act allowlist check: before every action type (not only navigate), re-check the
    // current top URL and every frame URL against the allowlist. This catches a surface that
    // landed off-policy without ever going through this wrapper's own act() -- most notably a
    // human navigating away during a handoff/escalation -- which the post-act scan below would
    // otherwise miss until some *later* action happened to trigger it. Reuses `scanFrameUrls`
    // verbatim, so entry into and clearing of quarantine, and the emitted decision events, are
    // identical to the existing post-navigate path: about:blank/about:srcdoc stay neutral (the
    // very first navigate off a fresh surface, or one whose current URL is not yet known, is
    // never refused), and any other off-policy URL quarantines immediately, before the action
    // reaches `inner.resolve`/`inner.act` at all.
    const preActUrls = this.inner.frameUrls ? await this.inner.frameUrls() : [await currentUrl()];
    this.scanFrameUrls(action.type, preActUrls);

    // 2. Quarantine gate: only an allowed-URL navigate, or dismiss_dialog, pass through to the
    // normal pipeline below; anything else is refused without touching inner.resolve/act.
    if (this.quarantinedFlag) {
      let passthrough = action.type === 'dismiss_dialog';
      if (!passthrough && action.type === 'navigate') {
        passthrough = this.guard.checkUrl(resolveRelativeUrl(action.url, await currentUrl())).allowed;
      }
      if (!passthrough) {
        const message = `surface is quarantined (${this.quarantineReasonVal ?? 'off-policy navigation'}); only navigate to an allowed URL or dismiss_dialog is permitted`;
        this.emit({ ts: nowIso(), actionType: action.type, decision: 'deny', reason: message });
        return { ok: false, error: { code: 'policy_violation', message } };
      }
    }

    // 3. Target description (click/type/select/extract) and dialog-message lookup
    // (dismiss_dialog accept:true) -- see file header.
    let resolvedAction: SurfaceAction = action;
    let targetName: string | undefined;
    let targetText: string | undefined;
    let frameUrl: string | undefined;
    let eventTarget: PolicyDecisionEvent['target'];
    let riskOverride: RiskClass | undefined;

    if (hasTarget(action)) {
      const described = await this.describeTarget(action.target, timeoutMs);
      if (!described.ok) return described.result;
      resolvedAction = { ...action, target: { ref: described.info.ref } } as SurfaceAction;
      targetName = described.info.name;
      targetText = described.info.text;
      frameUrl = described.info.frameUrl;
      eventTarget = described.info.eventTarget;
      riskOverride = described.info.riskOverride;
    } else if (action.type === 'dismiss_dialog' && action.accept === true) {
      targetText = await this.tryGetDialogMessage();
    }

    // 3b. Enter can submit a control other than the one just classified -- see the file header.
    // Skip the extra observe() when already at the max risk (unknown ref, or the target
    // itself already matched an irreversible pattern).
    // Enter, NumpadEnter and Space all activate whatever has focus (isCommittingKeyPress).
    const isEnterTriggering = isCommittingKeyPress(action) || (action.type === 'type' && action.pressEnter === true);
    if (isEnterTriggering && riskOverride !== 'irreversible' && (await this.enterMayActivateIrreversibleControl())) {
      riskOverride = 'irreversible';
    }

    // 4. Decide.
    const ctxUrl = frameUrl ?? (await currentUrl());
    const decision = this.guard.checkAction(action, { targetName, targetText, currentUrl: ctxUrl, riskOverride });
    const navUrl = action.type === 'navigate' ? resolveRelativeUrl(action.url, ctxUrl) : undefined;

    if (decision.decision === 'deny') {
      this.emit({ ts: nowIso(), actionType: action.type, decision: 'deny', risk: decision.risk, reason: decision.reason, target: eventTarget, url: navUrl });
      return { ok: false, error: { code: 'policy_violation', message: decision.reason } };
    }

    if (decision.decision === 'flag_irreversible') {
      if (actOpts?.allowIrreversible !== true) {
        const message = `${decision.reason}; refused without allowIrreversible`;
        this.emit({
          ts: nowIso(),
          actionType: action.type,
          decision: 'refused_irreversible',
          risk: decision.risk,
          reason: message,
          target: eventTarget,
          url: navUrl,
        });
        return { ok: false, error: { code: 'policy_violation', message } };
      }
      this.emit({
        ts: nowIso(),
        actionType: action.type,
        decision: 'flag_irreversible',
        risk: decision.risk,
        reason: decision.reason,
        target: eventTarget,
        url: navUrl,
      });
    } else {
      this.emit({ ts: nowIso(), actionType: action.type, decision: 'allow', risk: decision.risk, reason: decision.reason, target: eventTarget, url: navUrl });
    }

    // 5. Act, then re-check every frame URL for quarantine.
    const result = await this.inner.act(resolvedAction, timeoutMs, actOpts);
    if (isQuarantineCheckedAction(action.type)) {
      const urls = this.inner.frameUrls ? await this.inner.frameUrls() : [await this.inner.currentUrl()];
      this.scanFrameUrls(action.type, urls);
    }
    return result;
  }

  async observe(): Promise<Observation> {
    const observation = await this.inner.observe();
    this.scanFrameUrls('observe', [observation.url, ...observation.frames.map((f) => f.url)]);
    return observation;
  }

  resolve(target: TargetDescriptor, timeoutMs: number): Promise<Resolution> {
    return this.inner.resolve(target, timeoutMs);
  }

  readText(target: ResolvedTarget, timeoutMs: number): Promise<ReadTextResult> {
    return this.inner.readText(target, timeoutMs);
  }

  check(condition: Condition, opts?: CheckOptions): Promise<boolean> {
    return this.inner.check(condition, opts);
  }

  waitFor(condition: Condition, timeoutMs: number, opts?: CheckOptions): Promise<boolean> {
    return this.inner.waitFor(condition, timeoutMs, opts);
  }

  screenshot(): Promise<Buffer> {
    return this.inner.screenshot();
  }

  domSnapshot(): Promise<string> {
    return this.inner.domSnapshot();
  }

  currentUrl(): Promise<string> {
    return this.inner.currentUrl();
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}

/** Wraps `surface` so every `act()` call is checked against `guard` before it can run against the
 * underlying surface; see the module header for the full contract. */
export function withPolicy(surface: Surface, guard: PolicyGuard, opts: WithPolicyOptions = {}): PolicySurface {
  return new EnforcingSurface(surface, guard, opts);
}

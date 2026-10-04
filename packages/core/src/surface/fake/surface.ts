/**
 * FakeSurface: an in-memory `Surface` implementation. A scenario is a small graph of named
 * "screens", each with a flat list of elements and transition rules describing how actions move
 * between screens. Replay, session, and agent code exercise the same `Surface` contract a real
 * Playwright surface implements, so every behavioral choice below is deliberate.
 *
 * Non-obvious behavior:
 *  - **Refs are positional, not content-based.** `observe()` assigns ref `e<i+1>` to the element
 *    at index `i` of the current screen's `elements` array, so the same authored element always
 *    gets the same ref on that screen, whether or not it is currently visible, hidden by an
 *    injected fault, or drifted.
 *  - **Injections never mutate the authored scenario.** `hide_element`'s `times` counter is
 *    decremented once per genuine resolution attempt (`resolve()`, `check()`/`waitFor()`, or the
 *    target step inside `act()`); a plain read like `observe()` reflects the current state but
 *    never consumes a use. `drift` has no countdown: it is a permanent patch until
 *    `clearInjections()`.
 *  - **`act()` order:** an open dialog blocks everything but `dismiss_dialog`; the target
 *    resolves once; an `act_error` injection can veto; `dismiss_dialog` runs; an injected
 *    `dialog`/`expire_session` can short-circuit immediately; only then is latency simulated and
 *    the action's real effect applied.
 *  - **`resolve()` is instantaneous**: nothing changes on its own between calls (except a
 *    screen's own `autoAdvance`, which only `waitFor()` polls for), so `timeoutMs` is ignored.
 *  - **`extract` is a read-only no-op**; `switch_frame` is a no-op, since every target/condition
 *    already carries its own `FramePath`.
 *  - **A disabled element fails with `app_error`, not `element_not_found`**: it was found, it
 *    just refuses the interaction.
 */
import {
  DEFAULT_STEP_TIMEOUT_MS,
  REDACTED_VALUE,
  type ActionType,
  type Condition,
  type FailureCode,
  type TargetDescriptor,
} from '../../schema/index.js';
import { collapseWhitespace, evaluateCondition, type ConditionView } from '../conditions.js';
import {
  isRefTarget,
  type ActOptions,
  type ActResult,
  type CheckOptions,
  type RefDescription,
  type Observation,
  type ResolvedTarget,
  type ReadTextResult,
  type RecordTextResult,
  type RecordTextWithin,
  type Resolution,
  type Surface,
  type SurfaceAction,
  type TriedStrategy,
} from '../types.js';
import { DEFAULT_VIEWPORT, type FakeScenario, type FakeScreenSpec, type FakeElementSpec, type TransitionContext, type TransitionRule, type TransitionTarget } from './scenario.js';
import { cssUnescape, frameMatches, framePathEquals, locatorTextMatches, resolveBbox, resolveRelative, type RuntimeElement } from './match.js';
import { computeTextDigest, maskedPlaceholderFor, screenMaskMatcher, toMaskedObservedElement } from './view.js';
import { omittedScreenshotPng } from '../omitted.js';

// ---------------------------------------------------------------------------------------------
// Failure injection
// ---------------------------------------------------------------------------------------------

/** A fault to inject into a `FakeSurface`'s next matching action or resolution attempt. */
export type InjectedFailure =
  | {
      kind: 'act_error';
      match?: { actionType?: ActionType; targetId?: string; targetName?: string };
      code: FailureCode;
      message?: string;
      /** Default 1. */
      times?: number;
    }
  | { kind: 'hide_element'; elementId: string; /** Default Infinity. */ times?: number }
  | { kind: 'drift'; elementId: string; patch: Partial<FakeElementSpec> }
  | { kind: 'delay'; ms: number; /** Default 1. */ times?: number }
  | { kind: 'expire_session' }
  | { kind: 'dialog'; dialog: { type: 'alert' | 'confirm' | 'prompt'; message: string }; /** Default 1. */ times?: number };

// ---------------------------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------------------------

/** Time source `FakeSurface` uses for action latency and `waitFor` timeouts; swap in a fake
 * clock in tests that need deterministic control over elapsed time. */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

/** Wall-clock `Clock` backed by `Date.now`/`setTimeout`. */
export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Constructor options for `FakeSurface`. */
export interface FakeSurfaceOptions {
  clock?: Clock;
}

// ---------------------------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------------------------

type TargetResolution = { ok: true; ref: string; spec: FakeElementSpec } | { ok: false; code: FailureCode; message: string };

interface DialogState {
  type: 'alert' | 'confirm' | 'prompt';
  message: string;
  onAccept?: string;
  onDismiss?: string;
}

const FAKE_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
/** A constant, tiny, valid 1x1 transparent PNG -- used for every `observe().screenshotPng`
 * and `screenshot()` call. `FakeSurface` never renders anything real. */
export const FAKE_PNG: Buffer = Buffer.from(FAKE_PNG_BASE64, 'base64');

/**
 * In-memory `Surface` implementation driven by a `FakeScenario` graph. See the module doc above
 * for behavior that isn't obvious from the code.
 */
export class FakeSurface implements Surface {
  private readonly clock: Clock;
  private screenId: string;
  private screenEnteredAt: number;
  private readonly values: Record<string, string> = {};
  private dialog: DialogState | undefined;
  private closed = false;
  private readonly injections: { failure: InjectedFailure; remaining: number }[] = [];
  private readonly log: { action: SurfaceAction; result: ActResult }[] = [];

  constructor(
    private readonly scenario: FakeScenario,
    options: FakeSurfaceOptions = {},
  ) {
    if (!(scenario.initial in scenario.screens)) {
      throw new Error(`FakeSurface: initial screen '${scenario.initial}' is not defined in the scenario`);
    }
    this.clock = options.clock ?? realClock;
    this.screenId = scenario.initial;
    this.screenEnteredAt = this.clock.now();
  }

  // --- failure injection -----------------------------------------------------------------

  inject(f: InjectedFailure): void {
    const remaining =
      f.kind === 'hide_element'
        ? (f.times ?? Infinity)
        : f.kind === 'drift'
          ? Infinity
          : f.kind === 'expire_session'
            ? 1
            : (f.times ?? 1);
    this.injections.push({ failure: f, remaining });
  }

  clearInjections(): void {
    this.injections.length = 0;
  }

  private takeInjection<K extends InjectedFailure['kind']>(
    kind: K,
    predicate: (f: Extract<InjectedFailure, { kind: K }>) => boolean,
  ): Extract<InjectedFailure, { kind: K }> | undefined {
    for (const entry of this.injections) {
      if (entry.failure.kind !== kind || entry.remaining <= 0) continue;
      const f = entry.failure as Extract<InjectedFailure, { kind: K }>;
      if (!predicate(f)) continue;
      entry.remaining -= 1;
      return f;
    }
    return undefined;
  }

  // --- screen/element bookkeeping ----------------------------------------------------------

  private assertOpen(): void {
    if (this.closed) throw new Error('FakeSurface: this surface is closed');
  }

  private currentScreenSpec(): FakeScreenSpec {
    const screen = this.scenario.screens[this.screenId];
    if (!screen) throw new Error(`FakeSurface: current screen '${this.screenId}' is not defined in the scenario`);
    return screen;
  }

  private setScreen(id: string): void {
    this.screenId = id;
    this.screenEnteredAt = this.clock.now();
  }

  /** Non-consuming: drift-patched + hide-annotated view of the current screen's elements,
   * indexed by position (`e1`..`eN`), reflecting whichever injections are currently active. */
  private peekElements(screen: FakeScreenSpec): RuntimeElement[] {
    return screen.elements.map((raw, i) => {
      let spec = raw;
      for (const inj of this.injections) {
        if (inj.failure.kind === 'drift' && inj.failure.elementId === raw.id) {
          spec = { ...spec, ...inj.failure.patch };
        }
      }
      const hiddenByInjection = this.injections.some(
        (inj) => inj.failure.kind === 'hide_element' && inj.failure.elementId === raw.id && inj.remaining > 0,
      );
      if (hiddenByInjection) spec = { ...spec, hidden: true };
      return { ref: `e${i + 1}`, spec };
    });
  }

  private tickHideInjections(): void {
    for (const inj of this.injections) {
      if (inj.failure.kind === 'hide_element' && inj.remaining > 0) inj.remaining -= 1;
    }
  }

  /** One "resolution attempt": peek, then consume one use from any active `hide_element`. */
  private peekAndTick(screen: FakeScreenSpec): RuntimeElement[] {
    const elements = this.peekElements(screen);
    this.tickHideInjections();
    return elements;
  }

  // --- locator resolution ------------------------------------------------------------------

  /** The shared sync resolver: tries `target.locators` in order, first one to yield exactly
   * one visible, frame-matching element wins. 0 matches -> 'no match'; >1 -> 'ambiguous: N
   * matches' (marked `ambiguous`, with the count) and falls through (strict, like Playwright).
   * `relative` is ambiguous when its anchor is (several elements show the anchor text); among the
   * candidates around one anchor it narrows to the nearest, and `bbox` to the smallest area. A
   * found resolution carries the misses before the winner in `tried`. */
  private resolveDescriptorSync(target: TargetDescriptor): Resolution {
    const screen = this.currentScreenSpec();
    const all = this.peekAndTick(screen);
    const pool = all.filter((e) => e.spec.hidden !== true && frameMatches(e.spec.frame ?? [], target.frame, screen));
    const tried: TriedStrategy[] = [];
    for (let i = 0; i < target.locators.length; i++) {
      const strat = target.locators[i]!.strategy;
      let candidates: RuntimeElement[] = [];
      let picked: RuntimeElement | undefined;
      switch (strat.kind) {
        case 'role':
          candidates = pool.filter((e) => e.spec.role === strat.role && locatorTextMatches(e.spec.name, strat.name, strat.exact));
          break;
        case 'label':
          candidates = pool.filter((e) => locatorTextMatches(e.spec.label, strat.label, strat.exact));
          break;
        case 'text':
          candidates = pool.filter(
            (e) => locatorTextMatches(e.spec.text, strat.text, strat.exact, strat.wholeWord) && (strat.tag === undefined || e.spec.tag === strat.tag),
          );
          break;
        case 'css':
          candidates = pool.filter((e) => (e.spec.css ?? []).some((c) => cssUnescape(c) === cssUnescape(strat.selector)));
          break;
        case 'automation_id':
          candidates = pool.filter((e) => e.spec.automationId === strat.id);
          break;
        case 'relative': {
          const rel = resolveRelative(pool, strat);
          if ('error' in rel) {
            tried.push({ strategyKind: strat.kind, error: rel.error, ...(rel.matches !== undefined ? { ambiguous: true as const, matches: rel.matches } : {}) });
            continue;
          }
          picked = rel.element;
          candidates = [picked];
          break;
        }
        case 'bbox':
          picked = resolveBbox(pool, strat, this.scenario.viewport ?? DEFAULT_VIEWPORT);
          candidates = picked ? [picked] : [];
          break;
      }
      if (candidates.length === 0) {
        tried.push({ strategyKind: strat.kind, error: 'no match' });
        continue;
      }
      if (candidates.length > 1) {
        tried.push({ strategyKind: strat.kind, error: `ambiguous: ${candidates.length} matches`, ambiguous: true, matches: candidates.length });
        continue;
      }
      const winner = picked ?? candidates[0]!;
      return { found: true, ref: winner.ref, strategyIndex: i, strategyKind: strat.kind, tried };
    }
    return { found: false, tried };
  }

  /** `masked`: text as `observe()` reports it (the model's view), not the real screen. */
  private buildConditionView(masked = false): ConditionView {
    const screen = this.currentScreenSpec();
    const mask = masked ? screenMaskMatcher(this.peekElements(screen).filter((e) => e.spec.hidden !== true)) : undefined;
    const view = (t: string | undefined): string | undefined => (t === undefined || mask === undefined ? t : mask.replace(t));
    return {
      url: screen.url,
      textDigest: view(computeTextDigest(screen, this.peekElements(screen), 'all') ?? '') ?? '',
      frameText: (frame) => view(computeTextDigest(screen, this.peekElements(screen), frame)),
      frameUrl: (frame) => {
        if (frame.length === 0) return screen.url;
        const key = JSON.stringify(frame);
        return screen.frames?.find((f) => JSON.stringify(f.path) === key)?.url;
      },
      hasElement: (target) => this.resolveDescriptorSync(target),
      dialog: this.dialog ? { type: this.dialog.type, message: this.dialog.message } : undefined,
    };
  }

  // --- Surface interface ---------------------------------------------------------------------

  async observe(): Promise<Observation> {
    this.assertOpen();
    const screen = this.currentScreenSpec();
    const all = this.peekElements(screen);
    const visible = all.filter((e) => e.spec.hidden !== true).slice(0, 150);
    const mask = screenMaskMatcher(all.filter((e) => e.spec.hidden !== true));
    return {
      url: screen.url,
      title: mask.replace(screen.title),
      ...(screen.omitScreenshot === true ? {} : { screenshotPng: FAKE_PNG }),
      elements: visible.map((e) => toMaskedObservedElement(e, this.values, mask, this.scenario.viewport ?? DEFAULT_VIEWPORT)),
      frames: screen.frames ?? [],
      dialog: this.dialog ? { type: this.dialog.type, message: this.dialog.message } : undefined,
      textDigest: mask.replace(computeTextDigest(screen, all, 'all') ?? ''),
    };
  }

  /** `timeoutMs` is accepted for interface compatibility but unused: see the file header
   * ("`resolve()` is instantaneous"). */
  async resolve(target: TargetDescriptor, timeoutMs: number): Promise<Resolution> {
    void timeoutMs;
    this.assertOpen();
    return this.resolveDescriptorSync(target);
  }

  async readText(target: ResolvedTarget, timeoutMs: number): Promise<ReadTextResult> {
    this.assertOpen();
    const screen = this.currentScreenSpec();
    const all = this.peekElements(screen);
    let ref: string;
    if (isRefTarget(target)) {
      ref = target.ref;
    } else {
      const r = await this.resolve(target, timeoutMs);
      if (!r.found) {
        return { ok: false, error: { code: 'element_not_found', message: `readText: ${target.description}: ${r.tried.map((t) => `${t.strategyKind}: ${t.error}`).join('; ')}` } };
      }
      ref = r.ref;
    }
    const el = all.find((e) => e.ref === ref);
    if (!el) return { ok: false, error: { code: 'element_not_found', message: `readText: stale ref ${ref}` } };
    const text = collapseWhitespace(el.spec.value ?? el.spec.text ?? el.spec.name ?? '');
    // Masked: the element is masked, or its text holds text masked elsewhere on the screen.
    const masked = el.spec.masked !== undefined || screenMaskMatcher(all.filter((e) => e.spec.hidden !== true)).contains(text);
    return masked ? { ok: true, text, masked: true } : { ok: true, text };
  }

  /** See `Surface.readRecordText`: the texts of the elements sharing the element's `container` id, else of the whole screen. */
  async readRecordText(target: ResolvedTarget, within: RecordTextWithin, timeoutMs: number): Promise<RecordTextResult> {
    this.assertOpen();
    const screen = this.currentScreenSpec();
    const all = this.peekElements(screen);
    let ref: string;
    if (isRefTarget(target)) {
      ref = target.ref;
    } else {
      const r = await this.resolve(target, timeoutMs);
      if (!r.found) {
        return { ok: false, error: { code: 'element_not_found', message: `readRecordText: ${target.description}: ${r.tried.map((t) => `${t.strategyKind}: ${t.error}`).join('; ')}` } };
      }
      ref = r.ref;
    }
    const el = all.find((e) => e.ref === ref);
    if (!el) return { ok: false, error: { code: 'element_not_found', message: `readRecordText: stale ref ${ref}` } };
    const textOf = (e: (typeof all)[number]): string => e.spec.value ?? e.spec.text ?? e.spec.name ?? '';
    const container = el.spec.container;
    if (within === 'container' && container !== undefined) {
      const text = all.filter((e) => e.spec.container === container && e.spec.hidden !== true).map(textOf).join(' ');
      return { ok: true, text: collapseWhitespace(text), scope: 'container' };
    }
    const own = [...(screen.text ?? []), ...all.filter((e) => e.spec.hidden !== true && JSON.stringify(e.spec.frame ?? []) === JSON.stringify(el.spec.frame ?? [])).map(textOf)];
    return { ok: true, text: collapseWhitespace(own.join(' ')), scope: 'page' };
  }

  async check(condition: Condition, opts?: CheckOptions): Promise<boolean> {
    this.assertOpen();
    return evaluateCondition(condition, this.buildConditionView(opts?.view === 'masked'), { recorded: opts?.recorded });
  }

  async waitFor(condition: Condition, timeoutMs: number, opts?: CheckOptions): Promise<boolean> {
    this.assertOpen();
    const deadline = this.clock.now() + timeoutMs;
    for (;;) {
      this.maybeAutoAdvance();
      if (await this.check(condition, opts)) return true;
      const now = this.clock.now();
      if (now >= deadline) return false;
      await this.clock.sleep(Math.min(50, deadline - now));
    }
  }

  private maybeAutoAdvance(): void {
    const screen = this.currentScreenSpec();
    if (!screen.autoAdvance) return;
    if (this.clock.now() - this.screenEnteredAt >= screen.autoAdvance.afterMs) {
      this.setScreen(screen.autoAdvance.to);
    }
  }

  async screenshot(): Promise<Buffer> {
    this.assertOpen();
    return this.currentScreenSpec().omitScreenshot === true ? omittedScreenshotPng() : FAKE_PNG;
  }

  async domSnapshot(): Promise<string> {
    this.assertOpen();
    const screen = this.currentScreenSpec();
    const all = this.peekElements(screen);
    const mask = screenMaskMatcher(all.filter((e) => e.spec.hidden !== true));
    const lines: string[] = [`<!-- screen: ${screen.id} url: ${screen.url} title: ${JSON.stringify(mask.replace(screen.title))} -->`];
    if (this.dialog) lines.push(`<!-- dialog: ${this.dialog.type} ${JSON.stringify(this.dialog.message)} -->`);
    for (const { spec } of all) {
      if (spec.hidden) continue;
      const ph = maskedPlaceholderFor(spec);
      const raw = this.values[spec.id] ?? spec.value;
      const value = raw === undefined ? undefined : spec.inputType === 'password' ? REDACTED_VALUE : (ph ?? mask.replace(raw));
      const name = ph !== undefined && (spec.name === spec.text || spec.text === undefined) ? ph : mask.replace(spec.name);
      const attrs = [
        `role=${JSON.stringify(spec.role)}`,
        `name=${JSON.stringify(name)}`,
        spec.text !== undefined ? `text=${JSON.stringify(ph ?? mask.replace(spec.text))}` : undefined,
        value !== undefined ? `value=${JSON.stringify(value)}` : undefined,
        spec.enabled === false ? 'disabled' : undefined,
      ].filter((a): a is string => a !== undefined);
      lines.push(`<${spec.tag} ${attrs.join(' ')} />`);
    }
    return lines.join('\n');
  }

  async currentUrl(): Promise<string> {
    this.assertOpen();
    return this.currentScreenSpec().url;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  /** Top document URL followed by every declared frame URL of the current screen. */
  async frameUrls(): Promise<string[]> {
    this.assertOpen();
    const screen = this.currentScreenSpec();
    return [screen.url, ...(screen.frames ?? []).map((f) => f.url)];
  }

  /** What `ref` points at on the current screen (never its value); undefined if unknown. */
  async describeRef(ref: string): Promise<RefDescription | undefined> {
    this.assertOpen();
    const screen = this.currentScreenSpec();
    const entry = this.peekElements(screen).find((e) => e.ref === ref);
    if (!entry) return undefined;
    const frame = entry.spec.frame ?? [];
    const frameUrl = frame.length === 0 ? screen.url : screen.frames?.find((f) => framePathEquals(f.path, frame))?.url;
    // The same masked view observe() gives: a masked element's content never reaches policy events.
    const ph = maskedPlaceholderFor(entry.spec);
    const mask = screenMaskMatcher(this.peekElements(screen).filter((e) => e.spec.hidden !== true));
    const name = ph !== undefined && (entry.spec.name === entry.spec.text || entry.spec.text === undefined) ? ph : mask.replace(entry.spec.name);
    const text = entry.spec.text === undefined ? undefined : (ph ?? mask.replace(entry.spec.text));
    const real = ph !== undefined || name !== entry.spec.name || text !== entry.spec.text;
    return {
      tag: entry.spec.tag,
      role: entry.spec.role,
      name,
      text,
      frameUrl,
      ...(real ? { classifyName: entry.spec.name, ...(entry.spec.text !== undefined ? { classifyText: entry.spec.text } : {}) } : {}),
    };
  }

  /** Refs here are positional per screen and `resolve()` returns the element's own ref, so two refs
   *  name the same element exactly when they are equal and that element is on the current screen. */
  async isSameElement(refA: string, refB: string): Promise<boolean> {
    this.assertOpen();
    return refA === refB && this.peekElements(this.currentScreenSpec()).some((e) => e.ref === refA);
  }

  // --- act() -----------------------------------------------------------------------------

  /** `opts` is accepted for interface compatibility; FakeSurface enforces no policy (see withPolicy). */
  async act(action: SurfaceAction, timeoutMs: number, opts?: ActOptions): Promise<ActResult> {
    void opts;
    this.assertOpen();

    // 1. An open dialog blocks everything except dismissing it.
    if (this.dialog && action.type !== 'dismiss_dialog') {
      const message = `a ${this.dialog.type} dialog is open: ${JSON.stringify(this.dialog.message)}`;
      return this.finishAct(action, { ok: false, error: { code: 'unexpected_dialog', message } });
    }

    const screen = this.currentScreenSpec();

    // 2. Resolve the action's target once, if it has one (consumes a hide_element use).
    const targetInfo = this.resolveActionTargetIfAny(action, screen);
    const resolvedSpec = targetInfo?.ok ? targetInfo.spec : undefined;

    // 3. An injected act_error can veto the action outright, immediately (no latency).
    const errInj = this.takeInjection(
      'act_error',
      (f) =>
        (f.match?.actionType === undefined || f.match.actionType === action.type) &&
        (f.match?.targetId === undefined || f.match.targetId === resolvedSpec?.id) &&
        (f.match?.targetName === undefined || f.match.targetName === resolvedSpec?.name),
    );
    if (errInj) {
      return this.finishAct(action, { ok: false, error: { code: errInj.code, message: errInj.message ?? `injected ${errInj.code}` } });
    }

    // 4. dismiss_dialog is app chrome, handled ahead of the remaining injections/latency.
    if (action.type === 'dismiss_dialog') {
      return this.finishAct(action, this.performDismissDialog(action));
    }

    // 5. An injected unexpected dialog pops up immediately instead of the normal effect.
    const dialogInj = this.takeInjection('dialog', () => true);
    if (dialogInj) {
      this.dialog = { type: dialogInj.dialog.type, message: dialogInj.dialog.message };
      return this.finishAct(action, { ok: true, navigated: false });
    }

    // 6. An injected session expiry redirects immediately ("the app just redirects").
    const expireInj = this.takeInjection('expire_session', () => true);
    if (expireInj) {
      if (this.scenario.sessionExpiredScreen === undefined) {
        throw new Error('FakeSurface: expire_session was injected but the scenario has no sessionExpiredScreen configured');
      }
      const before = this.screenId;
      this.setScreen(this.scenario.sessionExpiredScreen);
      return this.finishAct(action, { ok: true, navigated: before !== this.screenId });
    }

    // 7. Latency: screen latencyMs plus any injected extra delay.
    const delayInj = this.takeInjection('delay', () => true);
    const totalLatency = (this.scenario.latencyMs ?? 0) + (delayInj?.ms ?? 0);
    if (totalLatency > timeoutMs) {
      await this.clock.sleep(timeoutMs);
      return this.finishAct(action, { ok: false, error: { code: 'timeout', message: `action exceeded timeout of ${timeoutMs}ms` } });
    }
    if (totalLatency > 0) await this.clock.sleep(totalLatency);

    // 8. The action's real per-type effect.
    const result = await this.performAction(action, targetInfo);
    return this.finishAct(action, result);
  }

  private resolveActionTargetIfAny(action: SurfaceAction, screen: FakeScreenSpec): TargetResolution | undefined {
    switch (action.type) {
      case 'click':
      case 'type':
      case 'select':
      case 'extract':
        return this.resolveActionTarget(action.target, screen);
      default:
        return undefined;
    }
  }

  private resolveActionTarget(rt: ResolvedTarget, screen: FakeScreenSpec): TargetResolution {
    if (isRefTarget(rt)) {
      const all = this.peekAndTick(screen);
      const entry = all.find((e) => e.ref === rt.ref);
      if (!entry || entry.spec.hidden === true) {
        return { ok: false, code: 'element_not_found', message: `no visible element with ref '${rt.ref}' on screen '${screen.id}'` };
      }
      return { ok: true, ref: entry.ref, spec: entry.spec };
    }
    const resolution = this.resolveDescriptorSync(rt);
    if (!resolution.found) {
      const detail = resolution.tried.map((t) => `${t.strategyKind}: ${t.error}`).join('; ');
      return { ok: false, code: 'element_not_found', message: `target not found: ${rt.description} (tried ${detail})` };
    }
    const all = this.peekElements(screen);
    const entry = all.find((e) => e.ref === resolution.ref)!;
    return { ok: true, ref: entry.ref, spec: entry.spec };
  }

  private async performAction(action: SurfaceAction, targetInfo: TargetResolution | undefined): Promise<ActResult> {
    switch (action.type) {
      case 'navigate':
        return this.performNavigate(action.url);
      case 'click':
        return this.performClick(targetInfo!);
      case 'type':
        return this.performType(action, targetInfo!);
      case 'select':
        return this.performSelect(action, targetInfo!);
      case 'press':
        return this.performPress(action.key);
      case 'extract':
        return this.performExtract(targetInfo!);
      case 'wait':
        return this.performWait(action);
      case 'switch_frame':
        return { ok: true };
      case 'dismiss_dialog':
        throw new Error('unreachable: dismiss_dialog is handled earlier in act()');
      default: {
        const exhaustive: never = action;
        throw new Error(`FakeSurface: unhandled action type ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  private findRule(
    actionType: ActionType,
    extra: { targetId?: string; targetName?: string; targetText?: string; url?: string; key?: string },
  ): TransitionRule | undefined {
    for (const rule of this.scenario.rules) {
      if (rule.from !== '*' && rule.from !== this.screenId) continue;
      if (rule.match.actionType !== actionType) continue;
      if (rule.match.targetId !== undefined && rule.match.targetId !== extra.targetId) continue;
      if (rule.match.targetName !== undefined && rule.match.targetName !== extra.targetName) continue;
      if (rule.match.targetText !== undefined && rule.match.targetText !== extra.targetText) continue;
      if (rule.match.key !== undefined && rule.match.key !== extra.key) continue;
      if (rule.match.url !== undefined) {
        if (extra.url === undefined) continue;
        const matchesUrl = rule.match.url instanceof RegExp ? rule.match.url.test(extra.url) : rule.match.url === extra.url;
        if (!matchesUrl) continue;
      }
      if (rule.when && !rule.when({ values: { ...this.values }, screenId: this.screenId })) continue;
      return rule;
    }
    return undefined;
  }

  private applyRule(rule: TransitionRule | undefined): ActResult {
    if (!rule) return { ok: true, navigated: false };
    const ctx: TransitionContext = { values: { ...this.values }, screenId: this.screenId };
    const target = typeof rule.to === 'function' ? rule.to(ctx) : rule.to;
    return this.applyTransitionTarget(target);
  }

  private applyTransitionTarget(target: TransitionTarget): ActResult {
    if (typeof target === 'string') {
      if (!(target in this.scenario.screens)) {
        throw new Error(`FakeSurface: scenario rule targets unknown screen '${target}'`);
      }
      const before = this.screenId;
      this.setScreen(target);
      return { ok: true, navigated: target !== before };
    }
    if ('dialog' in target) {
      this.dialog = { type: target.dialog.type, message: target.dialog.message, onAccept: target.onAccept, onDismiss: target.onDismiss };
      return { ok: true, navigated: false };
    }
    return { ok: false, error: { code: target.error, message: target.message ?? `rule error: ${target.error}` } };
  }

  private performNavigate(url: string): ActResult {
    const rule = this.findRule('navigate', { url });
    if (!rule) {
      return {
        ok: false,
        error: { code: 'navigation_failed', message: `no scenario rule matches navigate to '${url}' from screen '${this.screenId}'` },
      };
    }
    return this.applyRule(rule);
  }

  private performClick(targetInfo: TargetResolution): ActResult {
    if (!targetInfo.ok) return { ok: false, error: { code: targetInfo.code, message: targetInfo.message } };
    if (targetInfo.spec.enabled === false) {
      return { ok: false, error: { code: 'app_error', message: `element '${targetInfo.spec.name}' (id '${targetInfo.spec.id}') is disabled` } };
    }
    return this.applyRule(
      this.findRule('click', { targetId: targetInfo.spec.id, targetName: targetInfo.spec.name, targetText: targetInfo.spec.text }),
    );
  }

  private performType(action: Extract<SurfaceAction, { type: 'type' }>, targetInfo: TargetResolution): ActResult {
    if (!targetInfo.ok) return { ok: false, error: { code: targetInfo.code, message: targetInfo.message } };
    if (targetInfo.spec.enabled === false) {
      return { ok: false, error: { code: 'app_error', message: `element '${targetInfo.spec.name}' (id '${targetInfo.spec.id}') is disabled` } };
    }
    const current = this.values[targetInfo.spec.id] ?? '';
    this.values[targetInfo.spec.id] = action.clear ? action.value : current + action.value;
    if (action.pressEnter) {
      return this.applyRule(this.findRule('press', { key: 'Enter' }));
    }
    return { ok: true, navigated: false };
  }

  private performSelect(action: Extract<SurfaceAction, { type: 'select' }>, targetInfo: TargetResolution): ActResult {
    if (!targetInfo.ok) return { ok: false, error: { code: targetInfo.code, message: targetInfo.message } };
    if (targetInfo.spec.enabled === false) {
      return { ok: false, error: { code: 'app_error', message: `element '${targetInfo.spec.name}' (id '${targetInfo.spec.id}') is disabled` } };
    }
    this.values[targetInfo.spec.id] = action.value;
    return { ok: true, navigated: false };
  }

  private performExtract(targetInfo: TargetResolution): ActResult {
    if (!targetInfo.ok) return { ok: false, error: { code: targetInfo.code, message: targetInfo.message } };
    // Read-only no-op: replay/agent code reads the value back via observe(). See file header.
    return { ok: true, navigated: false };
  }

  private performPress(key: string): ActResult {
    return this.applyRule(this.findRule('press', { key }));
  }

  private async performWait(action: Extract<SurfaceAction, { type: 'wait' }>): Promise<ActResult> {
    const before = this.screenId;
    const met = await this.waitFor(action.condition, action.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS);
    const navigated = this.screenId !== before;
    if (!met) return { ok: false, navigated, error: { code: 'timeout', message: 'wait condition was not met within timeout' } };
    return { ok: true, navigated };
  }

  private performDismissDialog(action: Extract<SurfaceAction, { type: 'dismiss_dialog' }>): ActResult {
    if (!this.dialog) {
      // Nothing to dismiss; a graceful no-op rather than an error.
      return { ok: true, navigated: false };
    }
    const dialog = this.dialog;
    this.dialog = undefined;
    const nextScreen = action.accept ? dialog.onAccept : dialog.onDismiss;
    if (nextScreen === undefined) return { ok: true, navigated: false };
    const before = this.screenId;
    this.setScreen(nextScreen);
    return { ok: true, navigated: nextScreen !== before };
  }

  private finishAct(action: SurfaceAction, result: ActResult): ActResult {
    this.log.push({ action, result });
    return result;
  }

  // --- test introspection (not part of the Surface contract) --------------------------------

  currentScreenId(): string {
    return this.screenId;
  }

  /** Raw (un-redacted) values store, keyed by element id. Named `debugValues` deliberately --
   * this is for tests, never for anything that ends up in evidence/logs. */
  debugValues(): Readonly<Record<string, string>> {
    return { ...this.values };
  }

  actionLog(): ReadonlyArray<{ action: SurfaceAction; result: ActResult }> {
    return [...this.log];
  }
}

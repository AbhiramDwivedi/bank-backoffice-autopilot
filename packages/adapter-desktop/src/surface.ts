/**
 * DesktopSurface: the `Surface` port over a native Windows application, through UI Automation.
 *
 * Everything that touches Windows goes through the bridge (bridge/UiaBridge.cs, spoken to by
 * bridge-client.ts); everything that decides lives here and in tree.ts / resolve.ts /
 * descriptor.ts / mask.ts / capture.ts, which is why the whole surface runs against the fake
 * bridge on any OS.
 *
 * Contract decisions (docs/design/desktop.md has the reasoning):
 *  - Scope. The surface sees and touches only windows of the process it launched (or was given
 *    by pid) and that process's descendants. The bridge enforces it; nothing here can name a
 *    window outside it.
 *  - Location. `desktop://<process>/<window title>`; `navigate` to such a URL waits for that
 *    window of this app to be open. It never starts a program and never activates a window.
 *  - No global input, no activation. Clicks, typing and selection are UIA patterns, except that a
 *    Win32 push button is clicked by posting the notification its parent receives on a click (a
 *    synchronous UIA Invoke that opens a modal window blocks the app's UI thread against every
 *    later UIA call) and a Win32 edit gets WM_SETTEXT (the UIA proxy's SetValue activates the app's
 *    window); `press` posts the key to the app's focused window. A control that only a mouse could
 *    drive fails with a typed `app_error` that says so.
 *  - Dialogs. A blocking owned window (a modal dialog) is `dialog_open`; its controls are listed and
 *    can be clicked like any other (frame `[{name: <dialog title>}]`), every action outside it fails
 *    with `unexpected_dialog`, and `dismiss_dialog` presses its default (accept) or cancel button.
 *  - Values. Password fields are never read; see mask.ts for what screenshots and observations hide.
 *    Masking follows the screen-masking contract (docs/design/screen-masking.md): `check`/`waitFor`
 *    with `{ view: 'masked' }` evaluate against the masked text view; `readText` sets `masked` when
 *    the element is masked; `describeRef` returns the masked view, with the real strings only in
 *    `classifyName`/`classifyText` for risk classification; an observation that may not carry a
 *    screenshot carries none.
 */
import { DEFAULT_STEP_TIMEOUT_MS, REDACTED_VALUE, type Condition, type FramePath, type TargetDescriptor } from '@cu/core/schema';
import {
  collapseWhitespace,
  evaluateCondition,
  formatDesktopUrl,
  isRefTarget,
  normalizeKeyName,
  omittedScreenshotPng,
  parseDesktopUrl,
  resolveDesktopRelative,
  urlShapeRefusal,
  processNameFromImage,
  type ActOptions,
  type ActResult,
  type CheckOptions,
  type ConditionView,
  type HumanActionCapture,
  type Observation,
  type ObservedDialog,
  type ObservedElement,
  type ReadTextResult,
  type RecordTextResult,
  type RecordTextWithin,
  type RefDescription,
  type Resolution,
  type ResolvedTarget,
  type Surface,
  type SurfaceAction,
} from '@cu/core/surface';
import { BridgeCallError, startUiaBridge, type BridgeClient, type BridgeProcess } from './bridge-client.js';
import { createDesktopCapture } from './capture.js';
import { synthesizeDescriptor } from './descriptor.js';
import { killLaunched, launchApp, type AppLaunch, type LaunchedApp } from './launch.js';
import { DesktopMask, MASKED_TEXT, maskFrame, maskLocation, type DesktopScreenMask, type MaskedStrings } from './mask.js';
import { CT, type WireActKind } from './protocol.js';
import { resolveInView } from './resolve.js';
import { recordTextOf } from './record-text.js';
import { buildView, digestOf, type DesktopNode, type DesktopView } from './tree.js';

const MAX_ELEMENTS = 150;
const MAX_DIGEST_CHARS = 8000;
const POLL_MS = 250;
const SETTLE_MS = 200;
/** How long a pattern call may run before the surface stops waiting for it (it keeps running). */
const PATTERN_BLOCK_MS = 1500;
/** A view is reused for this long when nothing was done in between (policy checks ask for the URL around every act). */
const VIEW_TTL_MS = 120;
/** 1x1 transparent PNG: what screenshot() returns when a capture fails. */
const EMPTY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const VALUE_CONTROL_TYPES: ReadonlySet<number> = new Set([CT.Edit, CT.ComboBox, CT.Spinner, CT.Document, CT.Slider]);

/** The visible titles of a view: window titles and frame hop (group) names, for title masking. */
function titlesOf(view: DesktopView): string[] {
  const out = new Set(view.windows.map((w) => w.title));
  for (const n of view.nodes) for (const hop of n.frame) if (hop.name !== undefined) out.add(hop.name);
  return [...out];
}

/** A connection to a bridge: the real process, or an in-process fake. */
export interface BridgeConnection {
  client: BridgeClient;
  /** Ends the bridge (and, for the real one, every process of a launched app with it). */
  close(): Promise<void>;
  /** The bridge's process id, for the real bridge. */
  pid?: number;
  /** Kills the bridge process abruptly through its own handle (tests: a runtime that dies). */
  kill?: () => void;
}

/** Options for {@link createDesktopSurface}. */
export interface DesktopSurfaceOptions {
  /** The app's process name (an image name's `.exe` is dropped): the host of its desktop:// locations. Windows of other processes are never its main window. */
  processName: string;
  /** Start the app (the surface owns it and ends it on close). Exactly one of `launch` / `attachPid`. */
  launch?: AppLaunch;
  /** Attach to an already running process (left running on close). */
  attachPid?: number;
  /** An already-started bridge (tests: the fake bridge). Default: start the real UIA bridge (Windows only). */
  bridge?: BridgeConnection;
  /**
   * Label/text masking rules for screenshots and observations. Passwords and fields the surface
   * typed into are masked whether or not this is given; these rules apply only when it is.
   */
  mask?: DesktopScreenMask;
  /** How long to wait for the app's first window. Default 30000. */
  startTimeoutMs?: number;
  /**
   * Environment variable names a launched app must not inherit, on top of what is always withheld
   * (`ANTHROPIC_*`, `TYPESAFE_*`, `CU_*`, secret-looking names; see launch.ts `appEnvironment`).
   * The composition root passes the run's credential names.
   */
  dropEnv?: readonly string[];
  /** Diagnostic sink. Never receives typed values. */
  log?: (msg: string) => void;
}

interface RefEntry {
  rid: string;
  frame: FramePath;
  info: RefDescription;
}

/** `Surface` over a Windows application via UI Automation. Create with {@link createDesktopSurface}. */
export class DesktopSurface implements Surface {
  readonly humanCapture: HumanActionCapture;
  /** Process id the surface launched or attached to. */
  readonly rootPid: number;
  private readonly processName: string;
  private readonly client: BridgeClient;
  private readonly mask: DesktopMask;
  private readonly log: (msg: string) => void;
  private observedRefs = new Map<string, RefEntry>();
  private readonly resolvedRefs = new Map<string, RefEntry>();
  private resolvedCounter = 0;
  private mainHwnd: number | undefined;
  private cached: { view: DesktopView; at: number } | undefined;
  private closed = false;

  constructor(
    private readonly bridge: BridgeConnection,
    rootPid: number,
    processName: string,
    private readonly launched: LaunchedApp | undefined,
    opts: { mask?: DesktopScreenMask; log?: (msg: string) => void },
  ) {
    this.client = bridge.client;
    this.rootPid = rootPid;
    this.processName = processNameFromImage(processName);
    this.mask = new DesktopMask(opts.mask);
    this.log = opts.log ?? (() => undefined);
    this.humanCapture = createDesktopCapture({
      client: this.client,
      snapshot: () => this.view(true),
      log: this.log,
      // Recorded human actions are masked like observations: names, frame hops and locations.
      // A window event names a window the view may not hold yet, so its own title is checked too.
      redact: (view) => {
        const nodes = view?.nodes ?? [];
        const titles = view ? titlesOf(view) : [];
        const hidden = this.mask.maskedStrings(nodes, titles);
        const plus = (more: readonly string[]): MaskedStrings => (more.length === 0 ? hidden : this.mask.maskedStrings(nodes, [...titles, ...more]));
        return {
          name: (n) => hidden.scrub(this.shownName(n)),
          text: (s) => hidden.scrub(s),
          frame: (f) => maskFrame(f, plus(f.flatMap((h) => (h.name !== undefined ? [h.name] : [])))),
          url: (u) => maskLocation(u, plus([parseDesktopUrl(u)?.title ?? ''])),
        };
      },
    });
  }

  /** Test hook: kills the bridge process abruptly, as a dying runtime would leave it. */
  killBridgeForTest(): void {
    this.bridge.kill?.();
  }

  // --- views ---------------------------------------------------------------------------------

  /** A fresh (or, within VIEW_TTL_MS of the last one and with nothing done since, the last) view. */
  async view(fresh = false): Promise<DesktopView> {
    this.assertOpen();
    if (!fresh && this.cached && Date.now() - this.cached.at < VIEW_TTL_MS) return this.cached.view;
    const snapshot = await this.client.call({ op: 'snapshot' });
    const view = buildView(snapshot, { processName: this.processName, ...(this.mainHwnd !== undefined ? { mainHwnd: this.mainHwnd } : {}) });
    if (view.main) this.mainHwnd = view.main.hwnd;
    this.cached = { view, at: Date.now() };
    return view;
  }

  /** The bridge process id (real bridge only). */
  get bridgePid(): number | undefined {
    return this.bridge.pid;
  }

  /**
   * Test hook, not part of `Surface`: whether a window of the app currently has the foreground.
   * The surface never activates the app; tests pin that with this.
   */
  async appHasForeground(): Promise<boolean> {
    return (await this.client.call({ op: 'foreground' })).owned;
  }

  private invalidate(): void {
    this.cached = undefined;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('DesktopSurface is closed');
  }

  private frameUrlOf(view: DesktopView, node: DesktopNode): string {
    return view.windows.find((w) => w.hwnd === node.hwnd)?.url ?? view.url;
  }

  /** The name shown for a node: a masked static or button shows its value as its name, so it gets the placeholder; a field keeps its label. */
  private shownName(node: DesktopNode): string {
    if (this.mask.hidesText(node) && !VALUE_CONTROL_TYPES.has(node.ct)) return MASKED_TEXT;
    return node.name;
  }

  private shownValue(node: DesktopNode): string | undefined {
    if (node.password) return REDACTED_VALUE;
    if (node.value === undefined) return undefined;
    // An empty masked field stays empty: a placeholder would say there is something to hide.
    return this.mask.hidesText(node) && node.value !== '' ? MASKED_TEXT : node.value;
  }

  private shownText(node: DesktopNode): string | undefined {
    if (node.password) return undefined;
    if (node.text === undefined) return undefined;
    return this.mask.hidesText(node) ? MASKED_TEXT : node.text;
  }

  /** Nodes in reading order: the topmost dialog's first (it is what is in front), then the main window, then the rest. */
  private ordered(view: DesktopView): DesktopNode[] {
    const order = [view.dialog?.hwnd, view.main?.hwnd, ...view.windows.map((w) => w.hwnd)].filter((h): h is number => h !== undefined);
    const seen = new Set<number>();
    const out: DesktopNode[] = [];
    for (const h of order) {
      if (seen.has(h)) continue;
      seen.add(h);
      out.push(...view.nodes.filter((n) => n.hwnd === h));
    }
    return out;
  }

  private digest(view: DesktopView, nodes: readonly DesktopNode[]): string {
    return digestOf(view, nodes, (n) => {
      if (n.password || n.ct === CT.Pane || n.ct === CT.Window) return undefined;
      if (n.ct === CT.Edit || n.ct === CT.ComboBox || n.ct === CT.Spinner || n.ct === CT.Document) return this.shownValue(n);
      return this.shownText(n);
    }).slice(0, MAX_DIGEST_CHARS);
  }

  private dialogOf(view: DesktopView): ObservedDialog | undefined {
    const d = view.dialog;
    if (!d) return undefined;
    const nodes = view.nodes.filter((n) => n.hwnd === d.hwnd && n.visible);
    const message = collapseWhitespace(nodes.filter((n) => n.ct === CT.Text).map((n) => this.shownText(n) ?? '').join(' ')) || d.title;
    const buttons = nodes.filter((n) => n.ct === CT.Button).length;
    const type: ObservedDialog['type'] = nodes.some((n) => n.ct === CT.Edit) ? 'prompt' : buttons >= 2 ? 'confirm' : 'alert';
    return { type, message };
  }

  private framesOf(view: DesktopView, hidden: MaskedStrings): { path: FramePath; url: string }[] {
    const out = new Map<string, { path: FramePath; url: string }>();
    for (const n of view.nodes) {
      if (n.frame.length === 0) continue;
      const path = maskFrame(n.frame, hidden);
      const key = JSON.stringify(path);
      if (!out.has(key)) out.set(key, { path, url: maskLocation(this.frameUrlOf(view, n), hidden) });
    }
    return [...out.values()];
  }

  /** Nodes inside `frame`: the main window for `[]`, else everything under that window/group hop path. */
  private nodesIn(view: DesktopView, frame: FramePath): DesktopNode[] {
    if (frame.length === 0) return view.nodes.filter((n) => n.hwnd === view.main?.hwnd);
    return view.nodes.filter(
      (n) =>
        n.frame.length >= frame.length &&
        frame.every((hop, i) => (hop.name === undefined || n.frame[i]!.name === hop.name) && (hop.index === undefined || (n.frame[i]!.index ?? 0) === hop.index)),
    );
  }

  /**
   * The condition view. `masked`: text as the masked view shows it (what the model is shown), so a
   * condition the model wrote is a pure function of what it could see; otherwise the real text
   * (replay's recorded conditions).
   */
  private conditionView(view: DesktopView, masked = false): ConditionView {
    const hidden = masked ? this.mask.maskedStrings(view.nodes, titlesOf(view)) : undefined;
    const real = (n: DesktopNode): string | undefined => (n.password ? undefined : hidden ? hidden.scrub(this.shownText(n)) : n.text);
    const dialog = this.dialogOf(view);
    return {
      url: view.url,
      textDigest: digestOf(view, this.ordered(view), real),
      frameText: (frame) => {
        const nodes = this.nodesIn(view, frame);
        if (frame.length > 0 && nodes.length === 0) return undefined;
        return digestOf(view, nodes, real);
      },
      frameUrl: (frame) => {
        if (frame.length === 0) return view.url;
        const node = view.nodes.find((n) => JSON.stringify(n.frame) === JSON.stringify(frame));
        return node ? this.frameUrlOf(view, node) : undefined;
      },
      // The whole resolution, not a bare boolean: evaluateCondition refuses a positional winner after an ambiguity.
      hasElement: (target: TargetDescriptor) => resolveInView(view, target),
      ...(dialog ? { dialog: hidden ? hidden.scrubDeep(dialog) : dialog } : {}),
    };
  }

  // --- Surface: perceive ---------------------------------------------------------------------

  async observe(): Promise<Observation> {
    const view = await this.view(true);
    const nodes = this.ordered(view).filter((n) => n.visible && (n.interactive || n.informative));
    const interactive = nodes.filter((n) => n.interactive);
    const informative = nodes.filter((n) => !n.interactive);
    const selected = [...interactive, ...informative].slice(0, MAX_ELEMENTS);
    // What the mask hides must not surface anywhere else either (a borrowed name, a title, a
    // dialog message, a locator): every string below goes through `hidden.scrub`.
    const hidden = this.mask.maskedStrings(view.nodes, titlesOf(view));
    const screenshotPng = await this.screenshotOf(view);
    const refs = new Map<string, RefEntry>();
    const elements: ObservedElement[] = selected.map((n, i) => {
      const ref = `e${i + 1}`;
      const name = hidden.scrub(this.shownName(n));
      const text = hidden.scrub(this.shownText(n));
      const value = hidden.scrub(this.shownValue(n));
      refs.set(ref, { rid: n.rid, frame: n.frame, info: this.describeNode(view, n, hidden) });
      return {
        ref,
        role: n.role,
        name,
        ...(text !== undefined && text !== name ? { text: text.slice(0, 120) } : {}),
        tag: n.tag,
        ...(value !== undefined ? { value } : {}),
        bbox: n.bbox,
        frame: maskFrame(n.frame, hidden),
        enabled: n.enabled,
        descriptor: synthesizeDescriptor(view, n, hidden),
        ...(this.mask.hidesText(n) ? { masked: true as const } : {}),
      };
    });
    this.observedRefs = refs;
    const dialog = this.dialogOf(view);
    return {
      // A masked string in a window title is scrubbed from the location too (re-encoded, same
      // process); currentUrl()/frameUrls(), which the policy checks, keep the real title.
      url: maskLocation(view.url, hidden),
      title: hidden.scrub(view.main?.title ?? ''),
      ...(screenshotPng !== undefined ? { screenshotPng } : {}),
      elements,
      frames: this.framesOf(view, hidden),
      ...(dialog ? { dialog: hidden.scrubDeep(dialog) } : {}),
      textDigest: hidden.scrub(this.digest(view, this.ordered(view))),
    };
  }

  async resolve(target: TargetDescriptor, timeoutMs: number): Promise<Resolution> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    let rounds = 0;
    for (;;) {
      const view = await this.view(true);
      const r = resolveInView(view, target);
      rounds++;
      const left = deadline - Date.now();
      if (r.found) {
        // A fallback winning on the very first look may be a screen still being drawn: look once more.
        if (r.strategyIndex > 0 && rounds === 1 && left > POLL_MS) {
          await sleep(POLL_MS);
          continue;
        }
        const ref = `r${++this.resolvedCounter}`;
        this.resolvedRefs.set(ref, { rid: r.node.rid, frame: r.node.frame, info: this.describeNode(view, r.node, this.mask.maskedStrings(view.nodes, titlesOf(view))) });
        if (this.resolvedRefs.size > 500) this.resolvedRefs.delete(this.resolvedRefs.keys().next().value!);
        return { found: true, ref, strategyIndex: r.strategyIndex, strategyKind: r.strategyKind, tried: r.tried };
      }
      if (left <= 0) return r;
      await sleep(Math.min(POLL_MS, left));
    }
  }

  async readText(target: ResolvedTarget, timeoutMs: number): Promise<ReadTextResult> {
    const found = await this.lookup(target, timeoutMs);
    if (!found.ok) return { ok: false, error: { code: found.code, message: found.message } };
    const n = found.node;
    if (n.password) return { ok: false, error: { code: 'input_validation', message: 'refusing to read a password field' } };
    const text = collapseWhitespace(n.text ?? n.name ?? '');
    // Masked: the element (or an ancestor) is masked, or the text holds something the mask hides.
    // The caller withholds the value from the model and records it sensitive.
    const hidden = this.mask.maskedStrings(found.view.nodes, titlesOf(found.view));
    let masked = this.mask.hidesText(n) || this.mask.paints(n) || hidden.mentions(text);
    for (let p = n.parent; !masked && p >= 0; p = found.view.nodes[p]!.parent) masked = this.mask.hidesText(found.view.nodes[p]!);
    return masked ? { ok: true, text, masked: true } : { ok: true, text };
  }

  /** See `Surface.readRecordText`: the text of the element's record container (or window), real and never masked, for a comparison the caller drops. */
  async readRecordText(target: ResolvedTarget, within: RecordTextWithin, timeoutMs: number): Promise<RecordTextResult> {
    const found = await this.lookup(target, timeoutMs);
    if (!found.ok) return { ok: false, error: { code: found.code, message: found.message } };
    if (found.node.password) return { ok: false, error: { code: 'input_validation', message: 'refusing to read a password field' } };
    return { ok: true, ...recordTextOf(found.view, found.node, within) };
  }

  async check(condition: Condition, opts?: CheckOptions): Promise<boolean> {
    return evaluateCondition(condition, this.conditionView(await this.view(), opts?.view === 'masked'), { recorded: opts?.recorded });
  }

  async waitFor(condition: Condition, timeoutMs: number, opts?: CheckOptions): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await evaluateCondition(condition, this.conditionView(await this.view(true), opts?.view === 'masked'), { recorded: opts?.recorded })) return true;
      const left = deadline - Date.now();
      if (left <= 0) return false;
      await sleep(Math.min(POLL_MS, left));
    }
  }

  /**
   * The masked screenshot; the omitted-screenshot placeholder where the policy omits screenshots,
   * and a 1x1 empty PNG when there is no window to capture or the capture fails.
   */
  async screenshot(): Promise<Buffer> {
    const view = await this.view(true);
    if (view.main && this.mask.omitsScreenshotAt(view.url)) return omittedScreenshotPng();
    return (await this.screenshotOf(view)) ?? EMPTY_PNG;
  }

  /** The masked capture, or undefined when none may or can be taken (an observation then carries none). */
  private async screenshotOf(view: DesktopView): Promise<Buffer | undefined> {
    if (!view.main || this.mask.omitsScreenshotAt(view.url)) return undefined;
    const maskRids = view.nodes.filter((n) => this.mask.paints(n)).map((n) => n.rid);
    try {
      // Typed values stay in this process: fields holding one are named by rid (mask.paints).
      const shot = await this.client.call({ op: 'screenshot', hwnd: view.main.hwnd, maskRids });
      return Buffer.from(shot.png, 'base64');
    } catch (err) {
      this.log(`screenshot failed: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  /** The accessibility tree as evidence: names and structure, never a value, masked content as `[MASKED]`. */
  async domSnapshot(): Promise<string> {
    const view = await this.view(true);
    const hidden = this.mask.maskedStrings(view.nodes, titlesOf(view));
    const esc = (s: string): string => JSON.stringify(hidden.scrub(s));
    const lines: string[] = [`<!-- desktop accessibility tree: ${esc(maskLocation(view.url, hidden))}; values are never serialized -->`];
    for (const w of view.windows) {
      lines.push(`<window title=${esc(w.title)} url=${esc(maskLocation(w.url, hidden))}${w.isMain ? ' main' : ''}${w.blocking ? ' modal' : ''}>`);
      const nodes = view.nodes.filter((n) => n.hwnd === w.hwnd && n.visible);
      const depth = (n: DesktopNode): number => {
        let d = 1;
        for (let p = n.parent; p >= 0; p = view.nodes[p]!.parent) d++;
        return d;
      };
      for (const n of nodes) {
        const attrs = [
          `name=${esc(this.shownName(n))}`,
          this.mask.hidesText(n) ? 'masked' : undefined,
          n.automationId !== undefined ? `automationId=${esc(n.automationId)}` : undefined,
          n.label !== undefined && n.label !== n.name ? `label=${esc(n.label)}` : undefined,
          n.ct === CT.Text || n.ct === CT.Button || n.ct === CT.Group ? undefined : n.value !== undefined || n.password ? 'value=""' : undefined,
          n.password ? 'password' : undefined,
          n.enabled ? undefined : 'disabled',
        ].filter((a): a is string => a !== undefined);
        lines.push(`${'  '.repeat(depth(n))}<${n.tag} ${attrs.join(' ')} />`);
      }
      lines.push('</window>');
    }
    if (view.skipped.length > 0) lines.push(`<!-- not answering: ${view.skipped.map((s) => esc(s.title)).join(', ')} -->`);
    return lines.join('\n');
  }

  async currentUrl(): Promise<string> {
    return (await this.view()).url;
  }

  async frameUrls(): Promise<string[]> {
    const view = await this.view();
    return [view.url, ...view.windows.filter((w) => !w.isMain).map((w) => w.url)];
  }

  /** True when two refs (observed or resolved) name the same UI Automation element: equal runtime
   *  ids. Two different controls that merely describe alike are never "the same". */
  async isSameElement(refA: string, refB: string): Promise<boolean> {
    const a = this.observedRefs.get(refA) ?? this.resolvedRefs.get(refA);
    const b = this.observedRefs.get(refB) ?? this.resolvedRefs.get(refB);
    return a !== undefined && b !== undefined && a.rid === b.rid;
  }

  async describeRef(ref: string): Promise<RefDescription | undefined> {
    const entry = this.observedRefs.get(ref) ?? this.resolvedRefs.get(ref);
    if (!entry) return undefined;
    try {
      const view = await this.view();
      const node = view.nodes.find((n) => n.rid === entry.rid);
      if (node) return this.describeNode(view, node, this.mask.maskedStrings(view.nodes, titlesOf(view)));
    } catch {
      /* fall back to what the ref looked like when bound */
    }
    return entry.info;
  }

  /**
   * What a ref is: `name`/`text` as the observation shows them (the masked view, which a policy
   * decision event may quote), and the real strings in `classifyName`/`classifyText` for the policy
   * wrapper's risk classification only (a mask hides content from the model and evidence, not from
   * the runtime's own safety checks, which must see a masked "Confirm Transfer" as what it is).
   */
  private describeNode(view: DesktopView, n: DesktopNode, hidden: MaskedStrings): RefDescription {
    const realText = n.password ? undefined : n.text;
    const shownText = hidden.scrub(this.shownText(n));
    return {
      tag: n.tag,
      role: n.role,
      name: hidden.scrub(this.shownName(n)),
      ...(shownText !== undefined ? { text: shownText } : {}),
      classifyName: n.name,
      ...(realText !== undefined ? { classifyText: realText } : {}),
      frameUrl: maskLocation(this.frameUrlOf(view, n), hidden),
    };
  }

  // --- Surface: act ----------------------------------------------------------------------------

  private async lookup(
    target: ResolvedTarget,
    timeoutMs: number,
  ): Promise<{ ok: true; node: DesktopNode; view: DesktopView } | { ok: false; code: 'element_not_found'; message: string }> {
    if (isRefTarget(target)) {
      const entry = this.observedRefs.get(target.ref) ?? this.resolvedRefs.get(target.ref);
      if (!entry) return { ok: false, code: 'element_not_found', message: `unknown or expired ref '${target.ref}' (refs are valid until the next observe)` };
      const view = await this.view(true);
      const node = view.nodes.find((n) => n.rid === entry.rid);
      if (!node || !node.visible) return { ok: false, code: 'element_not_found', message: `the element behind ref '${target.ref}' is no longer on screen` };
      return { ok: true, node, view };
    }
    const r = await this.resolve(target, timeoutMs);
    if (!r.found) {
      return { ok: false, code: 'element_not_found', message: `target not found: ${target.description} (tried ${r.tried.map((t) => `${t.strategyKind}: ${t.error}`).join('; ')})` };
    }
    const entry = this.resolvedRefs.get(r.ref)!;
    const view = await this.view();
    const node = view.nodes.find((n) => n.rid === entry.rid);
    if (!node) return { ok: false, code: 'element_not_found', message: `${target.description} disappeared while it was being resolved` };
    return { ok: true, node, view };
  }

  async act(action: SurfaceAction, timeoutMs: number, opts?: ActOptions): Promise<ActResult> {
    void opts; // policy is enforced by withPolicy(), not here
    this.assertOpen();
    this.invalidate();
    try {
      return await this.actInner(action, timeoutMs);
    } catch (err) {
      if (err instanceof BridgeCallError) return { ok: false, error: { code: err.code === 'timeout' ? 'timeout' : 'internal', message: `desktop bridge: ${err.message}` } };
      throw err;
    } finally {
      this.invalidate();
    }
  }

  private async actInner(action: SurfaceAction, timeoutMs: number): Promise<ActResult> {
    switch (action.type) {
      case 'navigate':
        return this.navigate(action.url, timeoutMs);
      case 'wait': {
        const met = await this.waitFor(action.condition, action.timeoutMs ?? timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS);
        return met ? { ok: true, navigated: false } : { ok: false, error: { code: 'timeout', message: 'wait condition was not met within timeout' } };
      }
      case 'switch_frame': {
        if (action.frame.length === 0) return { ok: true, navigated: false };
        const exists = this.nodesIn(await this.view(true), action.frame).length > 0;
        return exists ? { ok: true, navigated: false } : { ok: false, error: { code: 'element_not_found', message: `frame not found: ${JSON.stringify(action.frame)}` } };
      }
      case 'dismiss_dialog':
        return this.dismissDialog(action.accept, action.promptText, timeoutMs);
      case 'press':
        // The key the guard classified (core `normalizeKeyName`): "\r" and "Return" press Enter.
        return this.press(normalizeKeyName(action.key), undefined);
      case 'click':
      case 'type':
      case 'select':
      case 'extract':
        return this.actOnTarget(action, timeoutMs);
    }
  }

  /** Runs an action, lets the app react, and reports whether the location or the window set changed. */
  private async settled(before: DesktopView, run: () => Promise<ActResult>): Promise<ActResult> {
    const result = await run();
    if (!result.ok) return result;
    await sleep(SETTLE_MS);
    this.invalidate();
    let after: DesktopView;
    try {
      after = await this.view(true);
    } catch {
      return { ...result, navigated: true };
    }
    const key = (v: DesktopView): string => [v.url, ...v.windows.map((w) => `${w.hwnd}:${w.title}`)].join('\n');
    return { ...result, navigated: key(before) !== key(after) };
  }

  private async actOnTarget(action: Extract<SurfaceAction, { type: 'click' | 'type' | 'select' | 'extract' }>, timeoutMs: number): Promise<ActResult> {
    const found = await this.lookup(action.target, timeoutMs);
    if (!found.ok) return { ok: false, error: { code: found.code, message: found.message } };
    const { node, view } = found;
    if (action.type === 'extract') return { ok: true, navigated: false };
    if (view.dialog && node.hwnd !== view.dialog.hwnd) {
      const d = this.dialogOf(view)!;
      return { ok: false, error: { code: 'unexpected_dialog', message: `a ${d.type} dialog is open: ${JSON.stringify(d.message)}` } };
    }
    if (!node.enabled) return { ok: false, error: { code: 'app_error', message: `${node.role} "${node.name}" is disabled` } };
    switch (action.type) {
      case 'click':
        return this.settled(view, () => this.click(node));
      case 'type':
        return this.settled(view, () => this.type(node, action.value, action.clear !== false, action.pressEnter === true));
      case 'select':
        return this.settled(view, () => this.pattern(node, 'selectOption', action.value));
    }
  }

  private async pattern(node: DesktopNode, kind: WireActKind, value?: string): Promise<ActResult> {
    try {
      await this.client.call({ op: 'act', rid: node.rid, kind, ...(value !== undefined ? { value } : {}), blockMs: PATTERN_BLOCK_MS });
      return { ok: true };
    } catch (err) {
      if (!(err instanceof BridgeCallError)) throw err;
      switch (err.code) {
        case 'stale':
          return { ok: false, error: { code: 'element_not_found', message: `${node.role} "${node.name}" is gone: ${err.message}` } };
        case 'option_not_found':
          return { ok: false, error: { code: 'element_not_found', message: err.message } };
        case 'out_of_scope':
          return { ok: false, error: { code: 'policy_violation', message: err.message } };
        case 'timeout':
          return { ok: false, error: { code: 'timeout', message: err.message } };
        default:
          return { ok: false, error: { code: 'app_error', message: `${node.role} "${node.name}": ${err.message}` } };
      }
    }
  }

  private click(node: DesktopNode): Promise<ActResult> {
    const p = node.patterns;
    if (p.has('invoke')) return this.pattern(node, 'invoke');
    if (p.has('toggle')) return this.pattern(node, 'toggle');
    if (p.has('selectionItem')) return this.pattern(node, 'select');
    if (p.has('expandCollapse')) return this.pattern(node, 'expand');
    return Promise.resolve({
      ok: false,
      error: {
        code: 'app_error',
        message: `${node.role} "${node.name}" exposes no UI Automation pattern that activates it (Invoke, Toggle, SelectionItem, ExpandCollapse); clicking it would need synthesized mouse input, which this surface never sends`,
      },
    });
  }

  private async type(node: DesktopNode, value: string, clear: boolean, pressEnter: boolean): Promise<ActResult> {
    if (!node.patterns.has('value') || node.readOnly) {
      return {
        ok: false,
        error: {
          code: 'app_error',
          message: `${node.role} "${node.name}" ${node.readOnly ? 'is read-only' : 'exposes no UI Automation Value pattern'}; typing into it would need synthesized keystrokes, which this surface never sends`,
        },
      };
    }
    // Remembered before typing: a partial value can already be on screen if typing fails.
    this.mask.rememberTyped(node.rid, value);
    const full = clear || node.password ? value : `${node.value ?? ''}${value}`;
    const r = await this.pattern(node, 'setValue', full);
    if (!r.ok || !pressEnter) return r;
    return this.press('Enter', node);
  }

  private async press(key: string, node: DesktopNode | undefined): Promise<ActResult> {
    const view = await this.view(true);
    const hwnd = view.dialog?.hwnd ?? view.main?.hwnd;
    if (hwnd === undefined && !node) return { ok: false, error: { code: 'element_not_found', message: 'the application has no window to send the key to' } };
    return this.settled(view, async () => {
      try {
        await this.client.call(node ? { op: 'key', key, rid: node.rid } : { op: 'key', key, hwnd: hwnd! });
        return { ok: true };
      } catch (err) {
        if (err instanceof BridgeCallError && err.code === 'unsupported_key') return { ok: false, error: { code: 'app_error', message: err.message } };
        throw err;
      }
    });
  }

  private async dismissDialog(accept: boolean, promptText: string | undefined, timeoutMs: number): Promise<ActResult> {
    void timeoutMs;
    const view = await this.view(true);
    const d = view.dialog;
    if (!d) return { ok: true, navigated: false }; // graceful no-op, as on the web
    const nodes = view.nodes.filter((n) => n.hwnd === d.hwnd && n.visible && n.enabled);
    const buttons = nodes.filter((n) => n.ct === CT.Button);
    if (accept && promptText !== undefined) {
      const field = nodes.find((n) => n.ct === CT.Edit && n.patterns.has('value') && !n.readOnly);
      if (field) {
        const typed = await this.type(field, promptText, true, false);
        if (!typed.ok) return typed;
      }
    }
    const ACCEPT = /^(ok|yes|open|confirm|continue|save|submit|accept|retry|proceed|&?ok)\b/i;
    const CANCEL = /^(cancel|no|close|abort|dismiss)\b/i;
    let button: DesktopNode | undefined;
    if (accept) button = buttons.find((b) => b.isDefault) ?? buttons.find((b) => ACCEPT.test(b.name)) ?? buttons.find((b) => !CANCEL.test(b.name));
    else button = buttons.find((b) => CANCEL.test(b.name)) ?? (buttons.length === 1 ? buttons[0] : undefined);
    if (button) return this.settled(view, () => this.pattern(button, 'invoke'));
    if (!accept) {
      const win = d.wire;
      // No cancel button: close the window through its UIA Window pattern (what its close box does).
      return this.settled(view, async () => {
        try {
          await this.client.call({ op: 'act', rid: win.rid, kind: 'closeWindow', blockMs: PATTERN_BLOCK_MS });
          return { ok: true };
        } catch (err) {
          return { ok: false, error: { code: 'app_error', message: `could not close the dialog: ${err instanceof Error ? err.message : String(err)}` } };
        }
      });
    }
    return { ok: false, error: { code: 'app_error', message: `the dialog ${JSON.stringify(d.title)} has no button to accept it with` } };
  }

  private async navigate(url: string, timeoutMs: number): Promise<ActResult> {
    const shape = urlShapeRefusal(url);
    if (shape !== undefined) return { ok: false, error: { code: 'navigation_failed', message: shape } };
    const current = (await this.view(true)).url;
    // The same resolution the policy guard applies (core `resolveDesktopRelative`): an absolute URL
    // as written, a relative one as a window of this app, never dot-segment resolution (a ".." title
    // is a title).
    const absolute = resolveDesktopRelative(url, current) ?? url;
    const loc = parseDesktopUrl(absolute);
    if (!loc) return { ok: false, error: { code: 'navigation_failed', message: `a desktop surface only goes to desktop://<process>/<window title> locations, not '${absolute}'` } };
    if (loc.processName !== this.processName) {
      return { ok: false, error: { code: 'navigation_failed', message: `this surface drives ${formatDesktopUrl(this.processName)}; it does not start or switch to ${formatDesktopUrl(loc.processName)}` } };
    }
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const view = await this.view(true);
      const ok = loc.title === undefined ? view.main !== undefined : view.windows.some((w) => w.title === loc.title);
      if (ok) return { ok: true, navigated: false };
      const left = deadline - Date.now();
      if (left <= 0) {
        const what = loc.title === undefined ? 'no window of the application' : `no window titled ${JSON.stringify(loc.title)}`;
        return { ok: false, error: { code: 'navigation_failed', message: `${what} is open (a desktop surface waits for a window; it cannot open one by URL)` } };
      }
      await sleep(Math.min(POLL_MS, left));
    }
  }

  // --- lifecycle --------------------------------------------------------------------------------

  /** Stops capture, ends the bridge and, when the surface launched the app, the app's process tree. Idempotent. */
  async close(): Promise<void> {
    if (this.closed) return;
    try {
      await this.humanCapture.stop();
    } catch {
      /* ignore */
    }
    this.closed = true;
    await this.bridge.close().catch(() => undefined);
    if (this.launched) {
      // Gated on the launched process's own handle: once it has exited its pid may be a stranger's.
      killLaunched(this.launched);
      await Promise.race([this.launched.exited, sleep(5000)]);
    }
  }
}

/**
 * Starts (or attaches to) the app, starts the UIA bridge bound to it, and waits for the app's
 * first window of `processName`. On any failure everything already started is ended again.
 */
export async function createDesktopSurface(opts: DesktopSurfaceOptions): Promise<DesktopSurface> {
  if ((opts.launch === undefined) === (opts.attachPid === undefined)) throw new Error('createDesktopSurface: pass exactly one of launch or attachPid');
  const log = opts.log ?? (() => undefined);
  if (!opts.bridge && process.platform !== 'win32') throw new Error('the desktop surface drives Windows applications through UI Automation; it needs Windows');
  let bridgeProcess: BridgeProcess | undefined;
  let launched: LaunchedApp | undefined;
  let surface: DesktopSurface | undefined;
  try {
    const bridge: BridgeConnection =
      opts.bridge ??
      (await (async () => {
        bridgeProcess = await startUiaBridge({ log });
        const bp = bridgeProcess;
        return {
          client: bp.client,
          close: () => bp.close(),
          kill: () => void bp.child.kill(),
          ...(bp.child.pid !== undefined ? { pid: bp.child.pid } : {}),
        };
      })());
    if (opts.launch) {
      launched = await launchApp({ ...opts.launch, dropEnv: [...(opts.launch.dropEnv ?? []), ...(opts.dropEnv ?? [])] });
    }
    const pid = launched?.pid ?? opts.attachPid!;
    // Owning the tree (ending it with the bridge) needs the bridge's proof that this pid is the
    // child just launched, not a stranger that inherited a recycled pid.
    await bridge.client.call(
      launched ? { op: 'attach', pid, killOnClose: true, launchedBy: process.pid, launchedAfter: launched.launchedAt } : { op: 'attach', pid },
    );
    surface = new DesktopSurface(bridge, pid, opts.processName, launched, { ...(opts.mask ? { mask: opts.mask } : {}), log });
    await waitForMainWindow(surface, opts.processName, opts.startTimeoutMs ?? 30_000);
    return surface;
  } catch (err) {
    if (surface) await surface.close().catch(() => undefined);
    else {
      await bridgeProcess?.close().catch(() => undefined);
      if (opts.bridge) await opts.bridge.close().catch(() => undefined);
      if (launched) killLaunched(launched);
    }
    throw err;
  }
}

async function waitForMainWindow(surface: DesktopSurface, processName: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const view = await surface.view(true);
    if (view.main) return;
    const others = view.windows.map((w) => `${w.processName}: ${JSON.stringify(w.title)}`);
    if (Date.now() >= deadline) {
      const seen = others.length > 0 ? ` (the process tree shows only: ${others.join(', ')})` : '';
      throw new Error(`no window of process "${processNameFromImage(processName)}" appeared within ${timeoutMs}ms${seen}; check that --base-url names the app's process`);
    }
    await sleep(POLL_MS);
  }
}

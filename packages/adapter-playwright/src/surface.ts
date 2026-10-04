/**
 * PlaywrightSurface: the `Surface` (packages/core/src/surface/types.ts) over Chromium via Playwright, biased
 * toward legacy markup (framesets, adjacent-cell labels, onclick rows, div buttons).
 *
 * This file is the glue: lifecycle, native-dialog holding, the ref registry, the ConditionView
 * for check()/waitFor(). Per-concern logic lives in enumerate.ts (observe), resolve.ts
 * (locator strategies), act.ts (actions + readText), snapshot.ts (domSnapshot), mask.ts
 * (screen masking) and capture.ts (human-action capture). Other modules import only `Surface`; `page` is exposed for the
 * session broker (shared page, operator view).
 *
 * Screen masking (docs/design/screen-masking.md): every pixel and every piece of observed text
 * leaves through observe()/screenshot()/domSnapshot()/describeRef(), and each of them applies the
 * same mask plan (mask.ts), so the model, evidence, escalation requests and Relay's live view get
 * one masked view. observe() plans once and uses the plan for the elements, the text digest and
 * the screenshot; readText() and conditions read the real page (extraction is local; conditions
 * must see what the page says). A plan that cannot be computed fails closed: no screenshot.
 *
 * Native dialogs: one `page.on('dialog')` listener HOLDS the dialog (neither accepted nor
 * dismissed) so observe() reports it and `dialog_open` is true until `dismiss_dialog`. While a
 * dialog is held Chromium blocks script evaluation, so observe()/check()/describeRef() answer
 * from the last cached page state instead of evaluating, and every action except
 * `dismiss_dialog` fails fast with `unexpected_dialog`. An evaluation already in flight when a
 * dialog opens is raced against the dialog (`unlessDialog`), so it cannot block the caller either.
 */
import { chromium, type Browser, type BrowserContext, type Dialog, type Page } from 'playwright';
import { DEFAULT_STEP_TIMEOUT_MS, type Condition, type FramePath, type TargetDescriptor } from '@cu/core/schema';
import { collapseWhitespace, evaluateCondition, type ConditionView } from '@cu/core/surface';
import {
  isOmittedScreenshot,
  isRefTarget,
  keepsVerbWhenMasked,
  maskObservedElement,
  maskPlaceholder,
  omittedScreenshotPng,
  type ScreenMaskOptions,
  type CheckOptions,
  type ActOptions,
  type ActResult,
  type HumanActionCapture,
  type Observation,
  type ObservedDialog,
  type ReadTextResult,
  type RecordContext,
  type RecordTextResult,
  type RecordTextWithin,
  type RefDescription,
  type Resolution,
  type ResolvedTarget,
  type Surface,
  type SurfaceAction,
} from '@cu/core/surface';
import { performAction, readRecordTextOf, readTextOf, type ActContext, type TargetLookup } from './act.js';
import { createHumanCapture } from './capture.js';
import { debugRaw } from './debug.js';
import { enumeratePage } from './enumerate.js';
import { listFrames, resolveFramePath } from './frames.js';
import { MASK_COLOR, ScreenMasker, type AbandonSignal, type ScreenMaskPlan } from './mask.js';
import { detectAgent, ensureAgent, installAgentInitScript, type AgentSource } from './inpage.js';
import { RefRegistry, type RefEntry, type RefInfo } from './refs.js';
import { resolveDescriptor } from './resolve.js';
import { snapshotDom } from './snapshot.js';

/** Options for createPlaywrightSurface(). */
export interface PlaywrightSurfaceOptions {
  /** Default true. Ignored when `browser` or `page` is supplied. */
  headless?: boolean;
  /** Used as the context baseURL (relative navigate URLs). */
  baseUrl?: string;
  /** Default 1280x800. Ignored when `page` is supplied. */
  viewport?: { width: number; height: number };
  slowMo?: number;
  /** Use this browser (a new context/page is created and owned by the surface). */
  browser?: Browser;
  /** Use this existing page (shared with the session broker); the surface owns nothing and close() only detaches. */
  page?: Page;
  /** Diagnostic sink for locator fallbacks etc. */
  log?: (msg: string) => void;
  /** Called once per surface, the first time browser-agent detection completes; see AgentModeDetail. */
  onAgentDetected?: (detail: AgentModeDetail) => void;
  /**
   * The policy's `redaction.screen` block and the run's values (`screenMaskOptionsFromPolicy`).
   * Omitted: the schema defaults (every filled field, password and redaction-pattern match masked).
   */
  screenMask?: ScreenMaskOptions;
  /** Longest one masked capture (plan, capture, verification) may take; default 20 s. Past it: the omitted placeholder. */
  captureDeadlineMs?: number;
}

/** One surface's browser-agent detection: the main frame's mode plus every frame's. */
export interface AgentModeDetail {
  browserAgent: {
    /** The main frame's detection. */
    source: AgentSource;
    present: boolean;
    version?: string;
    /** The main frame's agent is present and usable as is: this driver's major, not older than its copy. */
    compatible: boolean;
    /** Version of an app-shipped agent (another major, or older) that this driver's copy replaced in the main frame. */
    replacedVersion?: string;
    frames: { frame: FramePath; source: AgentSource; compatible: boolean }[];
  };
}

const MAX_ELEMENTS = 150;
/** Plan + capture attempts before a changing page gets the omitted placeholder (see observe/screenshot). */
const CAPTURE_TRIES = 3;
/** Longest a plan, capture and verification may hold the capture lock (a page in an endless loop). */
const CAPTURE_DEADLINE_MS = 20_000;
/**
 * observe() also enumerates the page inside its plan (the elements need the plan's marks), and
 * enumerating a very large page is slow on its own (a 5,000-row table takes minutes, before any
 * masking), so its deadline is this many capture deadlines.
 */
/** Longest a capture retry waits for the page to finish loading first. */
const RETRY_SETTLE_MS = 1000;
const OBSERVE_DEADLINE_FACTOR = 9;
const MAX_DIGEST_CHARS = 8000;
const POLL_MS = 250;
/** 1x1 transparent PNG, returned when a screenshot cannot be taken (e.g. while a dialog blocks rendering). */
const EMPTY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

interface PageTextCache {
  url: string;
  title: string;
  textDigest: string;
  frameTexts: Map<string, string>;
  frameUrls: Map<string, string>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** What `unlessDialog` returns instead of an operation's result when a native dialog opened first. */
const DIALOG_OPENED: unique symbol = Symbol('dialog-opened');
type DialogOpened = typeof DIALOG_OPENED;

/** Surface implementation backed by a real Chromium page via Playwright. See the module header for the native-dialog contract. */
export class PlaywrightSurface implements Surface {
  readonly page: Page;
  readonly humanCapture: HumanActionCapture;
  private readonly refs = new RefRegistry();
  private readonly masker: ScreenMasker;
  /** The text digest of the last observation, masked: what a dialog-blocked observation reports. */
  private lastMaskedDigest = '';
  /** The title of the last observation, masked. */
  private lastMaskedTitle = '';
  private pendingDialog: Dialog | undefined;
  private readonly dialogWaiters = new Set<() => void>();
  private cache: PageTextCache = { url: 'about:blank', title: '', textDigest: '', frameTexts: new Map(), frameUrls: new Map() };
  private closed = false;
  private readonly log: (msg: string) => void;
  private _agentDetection: AgentModeDetail | undefined;
  private agentDetectionDone = false;
  private readonly onDialog = (d: Dialog): void => {
    this.pendingDialog = d;
    const waiters = [...this.dialogWaiters];
    this.dialogWaiters.clear();
    for (const w of waiters) w();
  };

  constructor(
    page: Page,
    private readonly owned: { browser?: Browser; context?: BrowserContext },
    log?: (msg: string) => void,
    private readonly onAgentDetected?: (detail: AgentModeDetail) => void,
    /** Base URL relative navigations resolve against when the page is blank. */
    private readonly baseUrl?: string,
    screenMask?: ScreenMaskOptions,
    private readonly captureDeadlineMs: number = CAPTURE_DEADLINE_MS,
  ) {
    this.page = page;
    this.log = log ?? (() => undefined);
    this.masker = new ScreenMasker(screenMask, this.log);
    page.on('dialog', this.onDialog);
    // A human's clicks are described by the page; masked content is masked there too.
    this.humanCapture = createHumanCapture(page, { scrubText: (s) => this.masker.scrubText(s) });
  }

  // --- dialogs -------------------------------------------------------------------------------

  /** The pending dialog as it may leave the surface: its message masked like any page text (conditions use `dialogInfo`). */
  private maskedDialogInfo(): ObservedDialog | undefined {
    const d = this.dialogInfo();
    return d ? { ...d, message: this.masker.scrubText(d.message) } : undefined;
  }

  private dialogInfo(): ObservedDialog | undefined {
    const d = this.pendingDialog;
    if (!d) return undefined;
    const t = d.type();
    const type: ObservedDialog['type'] = t === 'confirm' || t === 'prompt' ? t : 'alert';
    return { type, message: d.message() };
  }

  private dialogOpened(): Promise<void> {
    if (this.pendingDialog) return Promise.resolve();
    return new Promise<void>((r) => this.dialogWaiters.add(r));
  }

  /**
   * Runs `op`, which evaluates in the page, unless a native dialog is held or opens before `op`
   * settles. An evaluation blocks for as long as a dialog is open, and a held dialog is only
   * handled through this surface, so awaiting it would never return. When the dialog comes first
   * this returns DIALOG_OPENED, leaves `op` to settle once the dialog is handled, and hands its
   * late value to `discardLate` (e.g. to dispose element handles).
   */
  private async unlessDialog<T>(op: () => Promise<T>, discardLate?: (value: T) => unknown): Promise<T | DialogOpened> {
    if (this.pendingDialog) return DIALOG_OPENED;
    let waiter: (() => void) | undefined;
    const opened = new Promise<DialogOpened>((resolve) => {
      waiter = () => resolve(DIALOG_OPENED);
      this.dialogWaiters.add(waiter);
    });
    const pending = op();
    try {
      const winner = await Promise.race([pending, opened]);
      if (winner === DIALOG_OPENED) {
        pending.then(
          (late) => {
            try {
              void Promise.resolve(discardLate?.(late)).catch(() => undefined);
            } catch {
              /* discarding is best effort */
            }
          },
          () => undefined,
        );
      }
      return winner;
    } finally {
      if (waiter) this.dialogWaiters.delete(waiter);
    }
  }

  private async handleDialog(action: Extract<SurfaceAction, { type: 'dismiss_dialog' }>): Promise<ActResult> {
    const d = this.pendingDialog;
    if (!d) return { ok: true, navigated: false }; // graceful no-op, same as FakeSurface
    this.pendingDialog = undefined;
    const urlsBefore = listFrames(this.page).map((f) => f.url).join('\n');
    try {
      if (action.accept) await d.accept(action.promptText);
      else await d.dismiss();
    } catch (err) {
      // Already handled elsewhere (e.g. page navigated); treat as dismissed.
      this.log(`dismiss_dialog: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Accepting a confirm on a navigating link/submit starts a navigation; give it a moment.
    await sleep(100);
    try {
      await this.page.waitForLoadState('domcontentloaded', { timeout: 5000 });
    } catch {
      /* ignore */
    }
    const urlsAfter = listFrames(this.page).map((f) => f.url).join('\n');
    return { ok: true, navigated: urlsAfter !== urlsBefore };
  }

  // --- targets -------------------------------------------------------------------------------

  private readonly lookup: TargetLookup = async (target, timeoutMs) => {
    if (isRefTarget(target)) {
      const entry = this.refs.get(target.ref);
      if (!entry) return { ok: false, code: 'element_not_found', message: `unknown or expired ref '${target.ref}' (refs are valid until the next observe)` };
      return { ok: true, entry };
    }
    const r = await resolveDescriptor(this.page, target, timeoutMs, { log: this.log });
    if (!r.found) {
      return { ok: false, code: 'element_not_found', message: `target not found: ${target.description} (tried ${r.tried.map((t) => `${t.strategyKind}: ${t.error}`).join('; ')})` };
    }
    // Register descriptor-resolved handles too, so they are disposed on eviction instead of leaking.
    this.refs.bindResolved(r.entry);
    return { ok: true, entry: r.entry };
  };

  private actContext(): ActContext {
    return {
      page: this.page,
      lookup: this.lookup,
      dialogOpened: () => this.dialogOpened(),
      hasPendingDialog: () => this.pendingDialog !== undefined,
      ...(this.baseUrl !== undefined ? { baseUrl: this.baseUrl } : {}),
    };
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('PlaywrightSurface is closed');
  }

  // --- browser-agent detection ------------------------------------------------------------

  /** The last completed browser-agent detection for this surface, if any (see onAgentDetected). */
  get agentDetection(): AgentModeDetail | undefined {
    return this._agentDetection;
  }

  /**
   * Detects the browser-agent's mode once per surface, the first time this runs while the page
   * has navigated somewhere (`page.url()` is not `about:blank`) and no native dialog is blocking
   * evaluation. Each frame first gets `ensureAgent`, so the record describes the agent this driver
   * actually uses: when it replaced an app-shipped copy (another major, or an older one of its
   * own), the record says `source: 'injected'` with the app's version in `replacedVersion`. Never
   * throws: a failure (or a still-blank page, or a held dialog) just means the next
   * observe()/resolve()/act()/readText() tries again.
   */
  private async reportAgentDetectionOnce(): Promise<void> {
    if (this.agentDetectionDone) return;
    if (this.pendingDialog) return; // evaluation is blocked while a native dialog is held
    if (this.page.url() === 'about:blank') return;
    try {
      const frameInfos = listFrames(this.page);
      const detected = await this.unlessDialog(() =>
        Promise.all(
          frameInfos.map(async (f) => {
            // Let a synchronous app <script> in <head> run before installing over it.
            await f.frame.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => undefined);
            // A frame that cannot take the driver's copy is still reported, as found.
            await ensureAgent(f.frame).catch(() => undefined);
            return { frame: f.path, ...(await detectAgent(f.frame)) };
          }),
        ),
      );
      if (detected === DIALOG_OPENED) return;
      const perFrame = detected;
      const main = perFrame[0];
      const detail: AgentModeDetail = {
        browserAgent: {
          source: main?.source ?? 'none',
          present: main?.present ?? false,
          version: main?.version,
          compatible: main?.compatible ?? false,
          ...(main?.replacedVersion !== undefined ? { replacedVersion: main.replacedVersion } : {}),
          frames: perFrame.map((d) => ({ frame: d.frame, source: d.source, compatible: d.compatible })),
        },
      };
      this._agentDetection = detail;
      this.agentDetectionDone = true;
      try {
        this.onAgentDetected?.(detail);
      } catch {
        /* a caller's callback must never break the surface */
      }
      const replaced = detail.browserAgent.replacedVersion !== undefined ? ` replaced=${detail.browserAgent.replacedVersion}` : '';
      this.log(
        `browser-agent: source=${detail.browserAgent.source} version=${detail.browserAgent.version ?? 'unknown'} compatible=${detail.browserAgent.compatible}${replaced} frames=${detail.browserAgent.frames.length}`,
      );
    } catch {
      /* leave agentDetectionDone false; retry on the next operation */
    }
  }

  // --- ConditionView -------------------------------------------------------------------------

  /** Refreshes the text cache from the live page (no-op while a dialog blocks evaluation, including one that opens mid-refresh). */
  private async refreshCache(): Promise<PageTextCache> {
    const fresh = await this.unlessDialog(() => this.readPageText());
    if (fresh !== DIALOG_OPENED) this.cache = fresh;
    return this.cache;
  }

  /** Reads every frame's text, the URLs and the title from the live page. */
  private async readPageText(): Promise<PageTextCache> {
    const frames = listFrames(this.page);
    const frameTexts = new Map<string, string>();
    const frameUrls = new Map<string, string>();
    const parts: string[] = [];
    for (const f of frames) {
      const key = JSON.stringify(f.path);
      frameUrls.set(key, f.url);
      let text: string;
      try {
        text = collapseWhitespace(String(await f.frame.evaluate('document.body ? document.body.innerText : ""')));
      } catch {
        text = ''; // frame navigating / detached: treat as empty for this poll
      }
      frameTexts.set(key, text);
      if (text) parts.push(text);
    }
    let title = this.cache.title;
    try {
      title = await this.page.title();
    } catch {
      /* navigating */
    }
    return { url: this.page.url(), title, textDigest: parts.join(' '), frameTexts, frameUrls };
  }

  /**
   * The condition view. `masked`: text as the masked view shows it (the model's view). Each frame's
   * body text is read in the same synchronous call that plans its masks (`observe: 'text'`), then
   * put through that plan's matcher; a frame the plan does not cover reads as empty. Nothing else
   * about the page is consulted, so whether a condition holds depends only on the masked text.
   */
  private async buildConditionView(masked = false): Promise<ConditionView> {
    let c = await this.refreshCache();
    if (masked) {
      const view = await this.unlessDialog(() =>
        this.masker.exclusive(
          async () => {
            const plan = await this.masker.plan(this.page, { observe: 'text' });
            try {
              const frameTexts = new Map<string, string>();
              for (const f of listFrames(this.page)) {
                const h = plan.observed(f.frame);
                const raw: unknown = h ? await h.evaluate((r: { text?: unknown }) => r.text).catch(() => '') : '';
                frameTexts.set(JSON.stringify(f.path), typeof raw === 'string' ? plan.matcher.replace(collapseWhitespace(raw)) : '');
              }
              return { ...c, textDigest: [...frameTexts.values()].filter(Boolean).join(' '), frameTexts };
            } finally {
              await plan.cleanup();
            }
          },
          { deadlineMs: this.captureDeadlineMs, onTimeout: () => ({ ...c, textDigest: '', frameTexts: new Map<string, string>() }) },
        ),
      );
      c = view === DIALOG_OPENED ? { ...c, textDigest: this.lastMaskedDigest, frameTexts: new Map<string, string>() } : view;
    }
    const frameKey = (path: FramePath): string | undefined => {
      if (this.pendingDialog) return JSON.stringify(path);
      const f = resolveFramePath(this.page, path);
      if (!f) return undefined;
      // Map the live frame back to the canonical path key used by the cache.
      const info = listFrames(this.page).find((x) => x.frame === f);
      return info ? JSON.stringify(info.path) : undefined;
    };
    return {
      url: c.url,
      textDigest: c.textDigest,
      frameText: (frame) => {
        const k = frameKey(frame);
        return k === undefined ? undefined : c.frameTexts.get(k);
      },
      frameUrl: (frame) => {
        const k = frameKey(frame);
        return k === undefined ? undefined : c.frameUrls.get(k);
      },
      hasElement: async (target: TargetDescriptor) => {
        try {
          const r = await this.unlessDialog(
            () => resolveDescriptor(this.page, target, 0, { log: this.log }),
            (late) => (late.found ? late.entry.handle.dispose() : undefined),
          );
          // The probe, not a bare boolean: evaluateCondition refuses a positional winner after an ambiguity.
          return r !== DIALOG_OPENED && r.found ? { found: true, strategyIndex: r.strategyIndex, tried: r.tried } : false;
        } catch {
          return false;
        }
      },
      dialog: masked ? this.maskedDialogInfo() : this.dialogInfo(),
    };
  }

  // --- Surface -------------------------------------------------------------------------------

  async observe(): Promise<Observation> {
    const result = await this.observeInner();
    await this.reportAgentDetectionOnce();
    return result;
  }

  private async observeInner(): Promise<Observation> {
    this.assertOpen();
    const dialog = this.maskedDialogInfo();
    if (dialog) return this.dialogObservation(dialog);
    // The elements, the digest and the title come from one plan, read in the same in-page call as
    // the plan itself (`observe: 'elements'`), so they are exactly what the plan saw and never need
    // re-planning. The screenshot is taken under its own plan right after (`captureMasked`): checked,
    // captured, verified, retried up to CAPTURE_TRIES times, withheld when the page will not hold still.
    type Attempt = { enumerated: Awaited<ReturnType<typeof enumeratePage>>; plan: ScreenMaskPlan; shot: Buffer | undefined; topCovered: boolean; title: string };
    const dispose = (a: Attempt): Promise<unknown> => Promise.all(a.enumerated.elements.map((e) => e.handle.dispose().catch(() => undefined)));
    const result = await this.unlessDialog(
      () =>
        this.masker.exclusive<Attempt | undefined>(
          async (signal) => {
            let attempt: Attempt | undefined;
            let withheld = false;
            // A frame that attaches while the page is being read (frames still loading) is not in
            // this read: read again, after letting the page settle, up to CAPTURE_TRIES times.
            for (let tries = 1; tries <= CAPTURE_TRIES && !signal.abandoned; tries++) {
              if (attempt) await dispose(attempt);
              if (tries > 1) await this.page.waitForLoadState('load', { timeout: RETRY_SETTLE_MS }).catch(() => undefined);
              const plan = await this.masker.plan(this.page, { observe: 'elements', maxElements: MAX_ELEMENTS });
              let uncovered: boolean;
              try {
                const enumerated = await enumeratePage(this.page, {
                  maxElements: MAX_ELEMENTS,
                  maxDigestChars: MAX_DIGEST_CHARS,
                  mask: { observed: (frame) => plan.observed(frame) },
                });
                const topCovered = plan.observed(this.page.mainFrame()) !== undefined;
                const title = topCovered ? await this.page.title().catch(() => '') : '';
                uncovered = plan.hasUncoveredFrames(this.page);
                withheld = plan.failed || this.masker.omitFor(listFrames(this.page).map((f) => f.url));
                attempt = { enumerated, plan, shot: undefined, topCovered, title };
              } finally {
                await plan.cleanup();
              }
              if (!uncovered) break;
            }
            if (!attempt) return undefined;
            if (signal.abandoned) {
              await dispose(attempt);
              return undefined;
            }
            if (withheld) return attempt;
            const shot = await this.captureMasked(signal).catch((err: unknown) => {
              debugRaw('screenshot', err);
              this.log('screenshot failed');
              return undefined;
            });
            if (signal.abandoned) {
              await dispose(attempt);
              return undefined;
            }
            return { ...attempt, shot };
          },
          { deadlineMs: this.captureDeadlineMs * OBSERVE_DEADLINE_FACTOR, onTimeout: () => undefined },
        ),
      (late) => (late ? dispose(late) : undefined),
    );
    if (result === DIALOG_OPENED) return this.dialogObservation(this.maskedDialogInfo()!);
    if (result === undefined) return this.withheldObservation();
    const { enumerated, plan, shot: screenshotPng, topCovered, title } = result;
    const entries = new Map<string, RefEntry>();
    const elements = enumerated.elements.map((e, i) => {
      const ref = `e${i + 1}`;
      const masked = maskObservedElement({ ref, ...e.element }, plan.matcher, e.maskKind);
      // The ref snapshot is what describeRef falls back to: the masked view, never the raw text.
      const info: RefInfo = { tag: masked.tag, role: masked.role, name: masked.name, ...(masked.text !== undefined ? { text: masked.text } : {}) };
      // The recorder-only context stays here, with the real text (see `recordContextOf`); it is
      // flagged when the element's own text holds masked content, so no locator ever quotes it.
      const rc = e.recordContext;
      const recordContext: RecordContext | undefined = rc && {
        ...rc,
        ...(e.maskKind !== undefined || plan.matcher.contains(rc.ownText) ? { ownTextMasked: true as const } : {}),
        // A masked cell's text (and its column's shared text) is never quoted in a locator.
        rowCells: rc.rowCells.map((cell) => (plan.matcher.contains(cell.text) ? { ...cell, masked: true as const } : cell)),
      };
      entries.set(ref, { frame: e.frame, framePath: e.element.frame, handle: e.handle, info, ...(recordContext ? { recordContext } : {}) });
      return masked;
    });
    this.refs.replaceObserved(entries);
    const textDigest = plan.matcher.replace(enumerated.textDigest);
    this.lastMaskedDigest = textDigest;
    // The top document's title leaves only when its plan covered it (fail closed).
    this.lastMaskedTitle = topCovered ? plan.matcher.replace(title) : '';
    this.cache = { ...this.cache, url: this.page.url(), title };
    return {
      url: this.page.url(),
      title: this.lastMaskedTitle,
      ...(screenshotPng !== undefined ? { screenshotPng } : {}),
      elements,
      ...(enumerated.omitted > 0 ? { elementsOmitted: enumerated.omitted } : {}),
      frames: enumerated.frames,
      dialog: this.maskedDialogInfo(),
      textDigest,
    };
  }

  /** An observation when masking gave up within its deadline: no screenshot, no elements, no text. */
  private withheldObservation(): Observation {
    this.refs.replaceObserved(new Map());
    return {
      url: this.page.url(),
      title: '',
      elements: [],
      frames: listFrames(this.page).map((f) => ({ path: f.path, url: f.url })),
      dialog: this.maskedDialogInfo(),
      textDigest: '',
    };
  }

  /** Script evaluation is blocked while a native dialog is open: the last masked digest plus the dialog. */
  private async dialogObservation(dialog: ObservedDialog): Promise<Observation> {
    this.refs.replaceObserved(new Map());
    const shot = await this.screenshot();
    return {
      url: this.page.url(),
      title: this.lastMaskedTitle,
      ...(isOmittedScreenshot(shot) ? {} : { screenshotPng: shot }),
      elements: [],
      frames: listFrames(this.page).map((f) => ({ path: f.path, url: f.url })),
      dialog,
      textDigest: this.lastMaskedDigest.slice(0, MAX_DIGEST_CHARS),
    };
  }

  async resolve(target: TargetDescriptor, timeoutMs: number): Promise<Resolution> {
    const result = await this.resolveInner(target, timeoutMs);
    await this.reportAgentDetectionOnce();
    return result;
  }

  private async resolveInner(target: TargetDescriptor, timeoutMs: number): Promise<Resolution> {
    this.assertOpen();
    if (this.pendingDialog) {
      return { found: false, tried: [{ strategyKind: '*', error: 'a native dialog is pending; dismiss it first' }] };
    }
    const r = await this.unlessDialog(
      () => resolveDescriptor(this.page, target, timeoutMs, { log: this.log }),
      (late) => (late.found ? late.entry.handle.dispose() : undefined),
    );
    if (r === DIALOG_OPENED) {
      return { found: false, tried: [{ strategyKind: '*', error: 'a native dialog opened; dismiss it first' }] };
    }
    const tried = r.tried.map((t) => ({ ...t, error: this.masker.scrubText(t.error) }));
    if (!r.found) return { found: false, tried };
    const ref = this.refs.bindResolved(r.entry);
    return { found: true, ref, strategyIndex: r.strategyIndex, strategyKind: r.strategyKind, tried };
  }

  async act(action: SurfaceAction, timeoutMs: number, opts?: ActOptions): Promise<ActResult> {
    const result = await this.actInner(action, timeoutMs, opts);
    await this.reportAgentDetectionOnce();
    // act.ts never passes a browser message through; this catches whatever else could quote the page.
    return result.error ? { ...result, error: { ...result.error, message: this.masker.scrubText(result.error.message) } } : result;
  }

  private async actInner(action: SurfaceAction, timeoutMs: number, opts?: ActOptions): Promise<ActResult> {
    void opts; // policy is enforced by withPolicy(), not here
    this.assertOpen();
    if (this.pendingDialog && action.type !== 'dismiss_dialog') {
      const d = this.maskedDialogInfo()!;
      return { ok: false, error: { code: 'unexpected_dialog', message: `a ${d.type} dialog is open: ${JSON.stringify(d.message)}` } };
    }
    switch (action.type) {
      case 'dismiss_dialog':
        return this.handleDialog(action);
      case 'wait': {
        const met = await this.waitFor(action.condition, action.timeoutMs ?? timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS);
        return met ? { ok: true, navigated: false } : { ok: false, error: { code: 'timeout', message: 'wait condition was not met within timeout' } };
      }
      case 'switch_frame':
        return resolveFramePath(this.page, action.frame)
          ? { ok: true, navigated: false }
          : { ok: false, error: { code: 'element_not_found', message: `frame not found: ${JSON.stringify(action.frame)}` } };
      case 'type': {
        // Remember what was typed and where, so screenshots mask it (see mask.ts), whether or not
        // typing completed: a partial value can already be on screen.
        let typedInto: RefEntry | undefined;
        const ctx: ActContext = {
          ...this.actContext(),
          lookup: async (target, ms) => {
            const r = await this.lookup(target, ms);
            if (r.ok) typedInto = r.entry;
            return r;
          },
        };
        try {
          return await performAction(ctx, action, timeoutMs);
        } finally {
          await this.masker.typed.remember(typedInto, action.value);
        }
      }
      default:
        return performAction(this.actContext(), action, timeoutMs);
    }
  }

  async readText(target: ResolvedTarget, timeoutMs: number): Promise<ReadTextResult> {
    const result = await this.readTextInner(target, timeoutMs);
    await this.reportAgentDetectionOnce();
    return result;
  }

  private async readTextInner(target: ResolvedTarget, timeoutMs: number): Promise<ReadTextResult> {
    this.assertOpen();
    if (this.pendingDialog) return { ok: false, error: { code: 'unexpected_dialog', message: 'a native dialog is pending' } };
    const read = await this.unlessDialog(async (): Promise<ReadTextResult> => {
      const r = await this.lookup(target, timeoutMs);
      if (!r.ok) return { ok: false, error: { code: r.code, message: this.masker.scrubText(r.message) } };
      const read = await readTextOf(r.entry, timeoutMs);
      if (!read.ok) return { ok: false, error: { ...read.error, message: this.masker.scrubText(read.error.message) } };
      // Masked: the element, an ancestor or a descendant is painted over, or the text holds
      // something the plan hides. The caller withholds and redacts it; the value is also masked
      // wherever a later page shows it.
      const masked = await this.readTouchesMask(r.entry, read.text);
      if (masked) this.masker.learn(read.text);
      return masked ? { ok: true, text: read.text, masked: true } : read;
    });
    if (read === DIALOG_OPENED) return { ok: false, error: { code: 'unexpected_dialog', message: 'a native dialog opened' } };
    return read;
  }

  /**
   * See `Surface.readRecordText`. Reads the real text of the element's record container (or frame),
   * for a record identity check: the caller compares it and drops it, so unlike `readText` it
   * neither masks nor learns anything from it.
   */
  async readRecordText(target: ResolvedTarget, within: RecordTextWithin, timeoutMs: number): Promise<RecordTextResult> {
    this.assertOpen();
    if (this.pendingDialog) return { ok: false, error: { code: 'unexpected_dialog', message: 'a native dialog is pending' } };
    const read = await this.unlessDialog(async (): Promise<RecordTextResult> => {
      const r = await this.lookup(target, timeoutMs);
      if (!r.ok) return { ok: false, error: { code: r.code, message: this.masker.scrubText(r.message) } };
      const out = await readRecordTextOf(r.entry, within);
      return out.ok ? out : { ok: false, error: { ...out.error, message: this.masker.scrubText(out.error.message) } };
    });
    if (read === DIALOG_OPENED) return { ok: false, error: { code: 'unexpected_dialog', message: 'a native dialog opened' } };
    return read;
  }

  async check(condition: Condition, opts?: CheckOptions): Promise<boolean> {
    this.assertOpen();
    return evaluateCondition(condition, await this.buildConditionView(opts?.view === 'masked'), { recorded: opts?.recorded });
  }

  async waitFor(condition: Condition, timeoutMs: number, opts?: CheckOptions): Promise<boolean> {
    this.assertOpen();
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await this.check(condition, opts)) return true;
      const left = deadline - Date.now();
      if (left <= 0) return false;
      await sleep(Math.min(POLL_MS, left));
    }
  }

  /**
   * PNG of the page with everything the screen-mask policy hides painted over (see mask.ts). On a
   * page matching `omitScreenshotUrlPatterns`, or when the plan cannot be computed for a rendered
   * frame, no capture is taken and the omitted-screenshot placeholder is returned instead (fail
   * closed). While a native dialog blocks script evaluation nothing can be planned, so the same
   * placeholder is returned unless the policy could not mask anything anyway (then Playwright's own
   * capture is tried: it skips its in-page preparation while a dialog is open, bounded by a short
   * timeout). A dialog that opens while a masked screenshot is being planned or taken is handled the
   * same way; the abandoned attempt removes its marks once the dialog is handled. A capture that
   * fails outright returns a 1x1 empty PNG.
   */
  async screenshot(): Promise<Buffer> {
    this.assertOpen();
    if (this.pendingDialog) return this.screenshotWhileDialog();
    // A frame detaching between planning and capture fails the masked screenshot; plan once more.
    for (let attempt = 1; ; attempt++) {
      try {
        const shot = await this.unlessDialog(() => this.maskedScreenshot());
        return shot === DIALOG_OPENED ? await this.screenshotWhileDialog() : shot;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (attempt < 2 && /detached|context was destroyed/i.test(message)) continue;
        debugRaw('screenshot', err);
        this.log(`screenshot failed (${err instanceof Error ? err.name : 'Error'})`);
        return EMPTY_PNG;
      }
    }
  }

  private async maskedScreenshot(): Promise<Buffer> {
    if (this.masker.omitFor(listFrames(this.page).map((f) => f.url))) return omittedScreenshotPng();
    return this.masker.exclusive(async (signal) => (await this.captureMasked(signal)) ?? omittedScreenshotPng(), {
      deadlineMs: this.captureDeadlineMs,
      onTimeout: () => omittedScreenshotPng(),
    });
  }

  /**
   * One masked screenshot, under the capture lock (`signal` from `exclusive`): plan, check that the
   * redaction stylesheet wins, capture, verify. A capture of a page that changed under the plan
   * (content appeared unmarked, a mark was stripped, a frame navigated or appeared) is discarded
   * and the whole thing redone, up to CAPTURE_TRIES times. Undefined when no capture can go out: a
   * plan failed, the page out-ranks the stylesheet, or the page would not hold still. Throws when
   * Playwright cannot capture at all.
   */
  private async captureMasked(signal: AbandonSignal): Promise<Buffer | undefined> {
    for (let attempt = 1; attempt <= CAPTURE_TRIES && !signal.abandoned; attempt++) {
      // A retry follows a page that changed (often frames still loading): let it settle briefly.
      if (attempt > 1) await this.page.waitForLoadState('load', { timeout: RETRY_SETTLE_MS }).catch(() => undefined);
      const plan = await this.masker.plan(this.page);
      try {
        if (plan.failed) return undefined;
        if (plan.hasUncoveredFrames(this.page) || signal.abandoned) continue;
        if (!(await plan.sheetWins())) return undefined;
        const shot = await this.capture(plan);
        if (!signal.abandoned && (await plan.verify(this.page))) return shot;
      } finally {
        await plan.cleanup();
      }
    }
    if (!signal.abandoned) this.log('screen mask: the page kept changing while it was masked; screenshot withheld');
    return undefined;
  }

  /**
   * The masked capture itself; throws when Playwright cannot capture. The redaction is the plan's
   * stylesheet (`style`), laid out and painted with the content in the same frame; Playwright's
   * element `mask` over the same elements is a second layer. `animations: 'disabled'` settles CSS
   * animations for the capture. The stylesheet hides every caret itself (`caret: 'initial'`), so
   * Playwright writes no inline styles into the page.
   */
  private capture(plan: ScreenMaskPlan): Promise<Buffer> {
    return this.page.screenshot({ type: 'png', timeout: 10000, style: plan.sheet, mask: plan.mask, maskColor: MASK_COLOR, animations: 'disabled', caret: 'initial' });
  }

  private async screenshotWhileDialog(): Promise<Buffer> {
    if (!this.masker.canCaptureUnplanned) return omittedScreenshotPng();
    try {
      return await this.page.screenshot({ type: 'png', timeout: 2000 });
    } catch {
      this.log('screenshot failed');
      return EMPTY_PNG;
    }
  }

  async domSnapshot(): Promise<string> {
    this.assertOpen();
    const d = this.maskedDialogInfo();
    const pendingComment = (dialog: ObservedDialog | undefined): string =>
      `<!-- native ${dialog ? `${dialog.type} ` : ''}dialog pending: ${JSON.stringify(dialog?.message ?? '')}; DOM not readable while it is open -->`;
    if (d) return pendingComment(d);
    const withheld = '<!-- DOM withheld: the screen mask could not be applied while the page kept changing -->';
    const snap = await this.unlessDialog(() =>
      this.masker.exclusive(
        async (signal) => {
          for (let attempt = 1; attempt <= CAPTURE_TRIES && !signal.abandoned; attempt++) {
            const plan = await this.masker.plan(this.page);
            try {
              const html = await snapshotDom(this.page, { nonce: plan.nonce, skipFrame: (frame) => !plan.covers(frame), patterns: plan.matcher });
              if (!signal.abandoned && (await plan.verify(this.page))) return html;
            } finally {
              await plan.cleanup();
            }
          }
          return withheld;
        },
        { deadlineMs: this.captureDeadlineMs, onTimeout: () => withheld },
      ),
    );
    return snap === DIALOG_OPENED ? pendingComment(this.maskedDialogInfo()) : snap;
  }

  async currentUrl(): Promise<string> {
    this.assertOpen();
    return this.page.url();
  }

  async frameUrls(): Promise<string[]> {
    this.assertOpen();
    return listFrames(this.page).map((f) => f.url);
  }

  async describeRef(ref: string): Promise<RefDescription | undefined> {
    this.assertOpen();
    const entry = this.refs.get(ref);
    if (!entry) return undefined;
    const frameUrl = entry.frame.isDetached() ? undefined : entry.frame.url();
    if (!this.pendingDialog) {
      try {
        const live = await this.unlessDialog(() =>
          this.masker.exclusive(
            async () => {
              await ensureAgent(entry.frame);
              return (await entry.handle.evaluate((el, o) => {
                const lib = window.__cuAgent!.lib;
                const d = lib.describe(el);
                return { tag: d.tag, role: d.role, name: d.name, text: d.text, maskKind: lib.maskKindOf(el, o) };
              }, this.masker.probeOptions())) as RefInfo & { maskKind: string };
            },
            // Past the deadline: describe nothing live; the masked snapshot below answers.
            { deadlineMs: this.captureDeadlineMs, onTimeout: () => undefined },
          ),
        );
        if (live === undefined) throw new Error('deadline');
        if (live !== DIALOG_OPENED) return { ...this.maskedDescription(live), frameUrl };
      } catch {
        /* Detached or navigating: fall back to the snapshot taken when the ref was bound (unlike an
           unknown ref, which returns undefined). Safe for policy: acting on a detached handle fails
           with element_not_found before anything executes. */
      }
    }
    // The bound snapshot can be raw (a ref bound by resolve()): only its masked view leaves.
    if (!entry.info) return { frameUrl };
    return {
      ...entry.info,
      ...(entry.info.name !== undefined ? { name: this.masker.scrubText(entry.info.name), classifyName: entry.info.name } : {}),
      ...(entry.info.text !== undefined ? { text: this.masker.scrubText(entry.info.text), classifyText: entry.info.text } : {}),
      frameUrl,
    };
  }

  /**
   * What describeRef reports for a live description: the masked view (a masked element's own text
   * as its placeholder; known masked texts and run values replaced), so a policy event that quotes
   * its target never quotes masked content.
   */
  private maskedDescription(live: RefInfo & { maskKind: string }): RefDescription {
    const { maskKind, ...info } = live;
    // The real strings go along for risk classification only (RefDescription.classifyName/Text).
    const classify = {
      ...(info.name !== undefined ? { classifyName: info.name } : {}),
      ...(info.text !== undefined ? { classifyText: info.text } : {}),
    };
    if (maskKind) {
      const ph = maskPlaceholder(maskKind);
      if (keepsVerbWhenMasked(info.role ?? '', info.tag ?? '')) {
        // As in the observation: a control keeps its verb, only the hidden text is replaced
        // ("Delete [MASKED:member]"). When nothing known matches, the whole string is hidden (fail closed).
        const keepVerb = (s: string): string => {
          const scrubbed = this.masker.scrubText(s);
          return scrubbed !== s ? scrubbed : s === '' ? s : ph;
        };
        return {
          ...info,
          ...(info.name !== undefined ? { name: keepVerb(info.name) } : {}),
          ...(info.text !== undefined ? { text: keepVerb(info.text) } : {}),
          ...classify,
        };
      }
      const nameIsText = info.name !== undefined && info.text !== undefined && info.text.toLowerCase().startsWith(info.name.toLowerCase());
      return {
        ...info,
        ...(info.name !== undefined ? { name: nameIsText ? ph : this.masker.scrubText(info.name) } : {}),
        ...(info.text !== undefined && info.text !== '' ? { text: ph } : {}),
        ...classify,
      };
    }
    return {
      ...info,
      ...(info.name !== undefined ? { name: this.masker.scrubText(info.name) } : {}),
      ...(info.text !== undefined ? { text: this.masker.scrubText(info.text) } : {}),
      ...classify,
    };
  }

  /**
   * True when the text just read from `entry` touches masked content: the element, an ancestor or a
   * descendant is painted over, a hidden text range lies inside it, or the text holds something the
   * plan's matcher hides (a value shown elsewhere under its label, a run value, a pattern match).
   * Fails closed: when the plan cannot answer, the read counts as masked.
   */
  private async readTouchesMask(entry: RefEntry, text: string): Promise<boolean> {
    try {
      const answer = await this.masker.exclusive(
        async () => {
          const plan = await this.masker.plan(this.page);
          try {
            if (!plan.covers(entry.frame)) return true;
            return (await plan.touches(entry.frame, entry.handle)) || plan.matcher.contains(text);
          } finally {
            await plan.cleanup();
          }
        },
        { deadlineMs: this.captureDeadlineMs, onTimeout: () => true },
      );
      return answer;
    } catch {
      return true;
    }
  }

  /**
   * Test-only: not part of the `Surface` interface. True when `refA` and `refB` currently point
   * at the exact same DOM node (Playwright's own `el === other` inside an evaluate() callback
   * compares live node identity, not handle identity -- the same check resolve.ts's internal
   * `sameElement`/`dedupeByIdentity` already rely on). Refs and `ObservedElement` never expose a
   * handle publicly, and `describeRef()` (tag/role/name/text/frameUrl) cannot distinguish two
   * structurally-identical elements (e.g. a wrapper <div> and the one clickable child it wraps),
   * so this is the one place that needs real node identity rather than a description match.
   */
  /** See `Surface.recordContextOf`: the latest observation's recorder-only context for `ref`. */
  recordContextOf(ref: string): RecordContext | undefined {
    if (this.closed) return undefined;
    return this.refs.getObserved(ref)?.recordContext;
  }

  async isSameElement(refA: string, refB: string): Promise<boolean> {
    this.assertOpen();
    const a = this.refs.get(refA);
    const b = this.refs.get(refB);
    if (!a || !b) return false;
    try {
      return await a.handle.evaluate((el, other) => el === other, b.handle);
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.page.off('dialog', this.onDialog);
    try {
      await this.humanCapture.stop();
    } catch {
      /* ignore */
    }
    this.refs.clear();
    await this.masker.dispose();
    if (this.owned.browser) await this.owned.browser.close();
    else if (this.owned.context) await this.owned.context.close();
  }
}

/**
 * Creates a PlaywrightSurface. With `page`, the surface borrows it (close() does not close it).
 *
 * Every path installs the driver's browser-agent init script on the context before any page of
 * this surface navigates (for the `page` option, a page that has already navigated is covered
 * instead by `ensureAgent`, called lazily by observe()/resolve()/act(); see `installAgentInitScript`).
 */
export async function createPlaywrightSurface(opts: PlaywrightSurfaceOptions = {}): Promise<PlaywrightSurface> {
  if (opts.page) {
    await installAgentInitScript(opts.page.context());
    return new PlaywrightSurface(opts.page, {}, opts.log, opts.onAgentDetected, opts.baseUrl, opts.screenMask, opts.captureDeadlineMs);
  }
  const viewport = opts.viewport ?? { width: 1280, height: 800 };
  if (opts.browser) {
    const context = await opts.browser.newContext({ viewport, baseURL: opts.baseUrl });
    await installAgentInitScript(context);
    const page = await context.newPage();
    return new PlaywrightSurface(page, { context }, opts.log, opts.onAgentDetected, opts.baseUrl, opts.screenMask, opts.captureDeadlineMs);
  }
  const browser = await chromium.launch({ headless: opts.headless ?? true, slowMo: opts.slowMo });
  const context = await browser.newContext({ viewport, baseURL: opts.baseUrl });
  await installAgentInitScript(context);
  const page = await context.newPage();
  return new PlaywrightSurface(page, { browser }, opts.log, opts.onAgentDetected, opts.baseUrl, opts.screenMask, opts.captureDeadlineMs);
}

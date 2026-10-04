/**
 * Screen masking for the Playwright surface (docs/design/screen-masking.md): what every screenshot,
 * DOM snapshot and observation hides before it leaves the surface, so the model, the evidence and
 * the operator console all get one masked view and no consumer has its own masking to forget.
 *
 * A plan is computed per capture, across every frame:
 *  1. Elements this surface typed into are marked through handles it owns (`TypedValueMask`), so a
 *     page that reformats a typed value is still covered.
 *  2. In each frame, one `window.__cuAgent.lib.maskPlan(...)` call applies the policy's rules
 *     (selectors, inputs, labels, text patterns; see `@cu/browser-agent`'s mask.ts) and marks the
 *     hits with a per-plan nonce attribute.
 *  3. What must never be sent to a page is compared here, in Node: the page reports the own text
 *     of every element it left visible and the value of every field; text containing one of the
 *     run's secret/sensitive values (`maskTextPatterns`), a field holding a value this surface typed
 *     or a run value, and text another frame masked, are marked with one more call per frame that
 *     has a hit. A page on one origin never learns a value typed on, or shown by, another.
 * Pixels are redacted in CSS: the screenshot is taken with `redactionSheet(nonce)` as Playwright's
 * screenshot `style`, which makes every password field, `[data-cu-mask="<nonce>"]` (elements a rule
 * hid) and `[data-cu-mask-paint="<nonce>"]` (the element holding a hidden text range) transparent,
 * hides everything inside them and paints their boxes grey. The browser lays that out together
 * with the content, in one frame, so a script that moves content during the capture moves the
 * redaction with it. Before the capture `lib.maskSheetCheck` confirms the sheet wins on every
 * marked element (a page's inline `!important` or `@layer` rule can out-rank it); when it does not,
 * no screenshot is taken. Playwright's element `mask` over the same selectors is a second layer.
 * Then the marks are removed.
 *
 * With `observe`, step 2 is `lib.maskObserve` (the plan, the frame's enumeration and the enumerated
 * elements' mask kinds) or `lib.maskObserveText` (the plan and the body text), ONE synchronous call
 * per frame, so the text an observation or a condition check reads is exactly the text the plan
 * saw (`ScreenMaskPlan.observed`).
 *
 * Fail closed: a frame that is rendered but cannot be planned (agent unusable, a rule the page
 * rejects as invalid, evaluation failing twice) marks the whole plan `failed`. The surface then
 * takes no screenshot (observe() reports none, screenshot() returns the omitted placeholder), writes
 * no DOM for that frame, and drops that frame's text and elements from the observation. A frame
 * that is not rendered (detached, or its frame element has no box) is skipped: it shows nothing.
 */
import { randomBytes } from 'node:crypto';
import type { ElementHandle, Frame, JSHandle, Locator, Page } from 'playwright';
import { MASK_KIND_ATTR, MASK_PAINT_ATTR, type MaskPlanOptions, type MaskPlanResult, type MaskRange } from '@cu/browser-agent';
import { DEFAULT_PATTERNS } from '@cu/core/evidence';
import { resolveScreenMask, type ScreenMaskConfig } from '@cu/core/schema';
import { createMaskMatcher, maskLabelledLines, MIN_MASKED_SUBSTRING, urlMatchesAny, type MaskedText, type MaskMatcher, type ScreenMaskOptions } from '@cu/core/surface';
import { frameOffset, listFrames, type FrameInfo } from './frames.js';
import { AgentVersionError, ensureAgent } from './inpage.js';
import type { RefEntry } from './refs.js';

/** Attribute that marks a masked element for one plan (value: the plan's nonce). */
export const MASK_ATTR = 'data-cu-mask';
/** Colour painted over masked content. */
export const MASK_COLOR = '#7f7f7f';

/**
 * `:not(#id)` adds an id's specificity without narrowing the match: eight of them out-rank any
 * realistic page rule (an `!important` page rule needs more than eight ids to beat the sheet). Only
 * a page's inline `!important` style or an `@layer` `!important` rule can; `lib.maskSheetCheck`
 * detects those before every capture.
 */
const SPECIFICITY = Array.from({ length: 8 }, (_, i) => `:not(#cu-mask-${i})`).join('');

/**
 * The redaction stylesheet for one capture (Playwright's screenshot `style`, which it applies to
 * every frame and shadow root and removes after the capture). It starts with the agent's
 * recognition marker, so the agent's change detection does not count it.
 */
export function redactionSheet(nonce: string): string {
  const roots = [`[${MASK_ATTR}="${nonce}"]`, `[${MASK_PAINT_ATTR}="${nonce}"]`, 'input[type=password i]'].map((r) => r + SPECIFICITY);
  const list = (suffix: string): string => roots.map((r) => r + suffix).join(',\n');
  const hideText =
    'color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: none !important; ' +
    '-webkit-text-stroke: 0 transparent !important; text-decoration-color: transparent !important; ' +
    'text-emphasis-color: transparent !important; caret-color: transparent !important;';
  return [
    `/*cu-mask:${nonce}*/`,
    '* { caret-color: transparent !important; }',
    `${list('')},\n${list('::first-letter')},\n${list('::first-line')},\n${list('::placeholder')},\n${list('::selection')},\n${list('::marker')} { ${hideText} }`,
    `${list('')} { background: ${MASK_COLOR} !important; border-color: ${MASK_COLOR} !important; outline-color: transparent !important; box-shadow: none !important; }`,
    `${list(' *')},\n${list('::before')},\n${list('::after')},\n${list(' *::before')},\n${list(' *::after')} { visibility: hidden !important; }`,
    `${roots.map((r) => `:is(img, canvas, video, svg, object, embed, iframe, frame, picture, input[type=image i])${r}`).join(',\n')} { visibility: hidden !important; }`,
  ].join('\n');
}
/** Bounds on what is remembered; the oldest entries go first. */
const MAX_VALUES = 200;
const MAX_HANDLES = 100;
const MAX_HISTORY = 1000;

/** Remembers what a surface typed: the values, and the elements they went into. */
export class TypedValueMask {
  private readonly typedValues: string[] = [];
  private readonly handles: ElementHandle<Element>[] = [];

  /** True once anything was typed. */
  get active(): boolean {
    return this.typedValues.length > 0 || this.handles.length > 0;
  }

  /** The typed values, oldest first (compared Node-side only, never sent to a page). */
  get values(): readonly string[] {
    return this.typedValues;
  }

  /** Records a typed value and, when known, the element it went into. Never throws. */
  async remember(entry: RefEntry | undefined, value: string): Promise<void> {
    if (value !== '' && !this.typedValues.includes(value)) {
      this.typedValues.push(value);
      if (this.typedValues.length > MAX_VALUES) this.typedValues.shift();
    }
    if (!entry) return;
    try {
      const own = (await entry.handle.evaluateHandle((el) => el)).asElement() as ElementHandle<Element> | null;
      if (!own) return;
      this.handles.push(own);
      if (this.handles.length > MAX_HANDLES) void this.handles.shift()?.dispose().catch(() => undefined);
    } catch {
      /* detached already: the value match still covers a re-rendered copy */
    }
  }

  /** Marks every still-connected typed-into element with `nonce`; forgets detached ones. */
  async markHandles(nonce: string): Promise<void> {
    for (let i = this.handles.length - 1; i >= 0; i--) {
      const h = this.handles[i]!;
      const ok = await h
        .evaluate((el, [attr, kindAttr, n]) => {
          if (!el.isConnected) return false;
          el.setAttribute(attr, n);
          el.setAttribute(kindAttr, 'input');
          return true;
        }, [MASK_ATTR, MASK_KIND_ATTR, nonce] as const)
        .catch(() => false);
      if (!ok) {
        this.handles.splice(i, 1);
        await h.dispose().catch(() => undefined);
      }
    }
  }

  /** True when every still-connected typed-into element still carries `nonce` (a script did not strip it). */
  async verify(nonce: string): Promise<boolean> {
    for (const h of this.handles) {
      const ok = await h
        .evaluate((el, [attr, n]) => !el.isConnected || el.getAttribute(attr) === n, [MASK_ATTR, nonce] as const)
        .catch(() => true); // detached with its document: nothing of it can be captured
      if (!ok) return false;
    }
    return true;
  }

  /** Releases the element handles. */
  async dispose(): Promise<void> {
    const handles = this.handles.splice(0);
    for (const h of handles) await h.dispose().catch(() => undefined);
  }
}

/** One capture's masks; `cleanup()` must run once the capture is done. */
export interface ScreenMaskPlan {
  readonly nonce: string;
  /** `[data-cu-mask="<nonce>"]`: every element masked by this plan. */
  readonly selector: string;
  /** Locators for `page.screenshot({ mask })`, one per frame. */
  readonly mask: Locator[];
  /** A rendered frame could not be planned: take no screenshot (fail closed). */
  readonly failed: boolean;
  /**
   * With `observe`: per frame, the handle to that frame's `lib.maskObserve` result (`plan`,
   * `enumeration`, `kinds`) or `lib.maskObserveText` result (`plan`, `text`), released by
   * `cleanup()`. A frame without one was not observed with the plan: none of its text may be reported.
   */
  observed(frame: Frame): JSHandle | undefined;
  /** The frames that could not be planned: none of their DOM or text may leave the surface. */
  readonly failedFrames: ReadonlySet<Frame>;
  /**
   * True when `frame` was planned (or skipped as not rendered) by this plan. A frame that attached
   * after the plan was computed is not covered: its content must not leave the surface either.
   */
  covers(frame: Frame): boolean;
  /** True when the page now has a frame this plan does not cover (a capture would show it unmasked). */
  hasUncoveredFrames(page: Page): boolean;
  /** Why frames failed (for the surface's log; never page text). */
  readonly reasons: readonly string[];
  /** Everything this plan masked (plus the run's values when `maskTextPatterns`), for the text channel and DOM snapshots. */
  readonly texts: readonly MaskedText[];
  /** Matcher over `texts` (and, with `maskTextPatterns`, the redaction patterns). */
  readonly matcher: MaskMatcher;
  /**
   * After a capture: true only when nothing changed since the plan in any frame it covered (no
   * navigation, no node, text, `value` or `alt` change, every mark, paint mark and typed-field mark
   * in place) and no frame appeared. Anything else means the capture may show content the plan
   * never saw: discard it.
   */
  verify(page: Page): Promise<boolean>;
  /** The stylesheet the screenshot is taken with (`redactionSheet`). */
  readonly sheet: string;
  /**
   * Right before a screenshot: true when the redaction stylesheet wins on every marked element in
   * every planned frame (`lib.maskSheetCheck`). False: take no screenshot.
   */
  sheetWins(): Promise<boolean>;
  /** True when `el` (in `frame`), an ancestor or a descendant is masked, or a hidden text range lies inside it. */
  touches(frame: Frame, el: ElementHandle<Element>): Promise<boolean>;
  cleanup(): Promise<void>;
}

/** Removes a plan's marks; works without the agent (a frame where installing it failed). */
const CLEAR_JS = `(function (a) {
  var e = document.querySelectorAll('[' + a.attr + '="' + a.nonce + '"]');
  for (var j = 0; j < e.length; j++) { e[j].removeAttribute(a.attr); e[j].removeAttribute(a.kind); }
  var p = document.querySelectorAll('[' + a.paint + '="' + a.nonce + '"]');
  for (var k = 0; k < p.length; k++) p[k].removeAttribute(a.paint);
  try { if (window.__cuAgent && window.__cuAgent.lib && window.__cuAgent.lib.maskClear) window.__cuAgent.lib.maskClear(a.attr, a.nonce); } catch (x) {}
  return true;
})`;

const invoke = (fnSource: string, arg: unknown): string => `${fnSource}(${JSON.stringify(arg)})`;

const lower = (s: string): string => s.toLowerCase();

function isPlanResult(v: unknown): v is MaskPlanResult {
  if (!v || typeof v !== 'object') return false;
  const r = v as Partial<MaskPlanResult>;
  return Array.isArray(r.texts) && Array.isArray(r.blocks) && Array.isArray(r.fields) && Array.isArray(r.errors);
}

/** A value worth remembering from a masked element: long enough, and specific enough, to mask elsewhere as a whole token. */
function learnable(v: string): boolean {
  return v.length >= 6 || (v.length >= 4 && /\d/.test(v));
}

/** Whole-token occurrence check: no letter or digit right before `start` or right after `end`. */
function isWholeToken(text: string, start: number, end: number): boolean {
  const word = (ch: string | undefined): boolean => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
  return !word(text[start - 1]) && !word(text[end]);
}

/** Every occurrence of each needle (lower-cased) in `text`, as block ranges. */
function findRanges(block: number, text: string, needles: readonly { needle: string; kind: string; token: boolean }[]): (MaskRange & { kind: string })[] {
  const lowerText = text.toLowerCase().replace(/\n/g, ' ');
  const out: (MaskRange & { kind: string })[] = [];
  for (const n of needles) {
    if (n.needle === '') continue;
    for (let at = lowerText.indexOf(n.needle); at !== -1; at = lowerText.indexOf(n.needle, at + 1)) {
      const end = at + n.needle.length;
      if (n.token && !isWholeToken(text, at, end)) continue;
      out.push({ block, start: at, end, kind: n.kind });
    }
  }
  return out;
}

/** Sanitizes page-reported texts: strings only, bounded. */
function textsOf(v: unknown): MaskedText[] {
  if (!Array.isArray(v)) return [];
  const out: MaskedText[] = [];
  for (const t of v) {
    if (t && typeof t === 'object' && typeof (t as MaskedText).text === 'string') {
      const kind = typeof (t as MaskedText).kind === 'string' ? (t as MaskedText).kind : 'masked';
      const part = (t as MaskedText).part === true;
      out.push({ text: (t as MaskedText).text.slice(0, part ? 2000 : 20000), kind: kind.slice(0, 40), ...(part ? { part: true } : {}) });
    }
  }
  return out;
}

/** Options for {@link ScreenMasker.exclusive}. */
export interface ExclusiveOptions<T> {
  /** Give up after this long: `onTimeout()` is returned and the lock released (the abandoned work sees `signal.abandoned`). */
  deadlineMs: number;
  onTimeout: () => T;
}

/** Set once an `exclusive` call gave up waiting: work still running must stop before it captures anything. */
export interface AbandonSignal {
  abandoned: boolean;
}

/** The screen masking a Playwright surface applies (see the module header). */
export class ScreenMasker {
  readonly typed = new TypedValueMask();
  readonly config: ScreenMaskConfig;
  private readonly patterns: { name: string; regex: string }[];
  private readonly runValues: () => readonly string[];
  /** Values read through `readText` from masked elements: masked wherever they show from then on (whole tokens). */
  private readonly learned: string[] = [];
  /** Serializes plan..cleanup: two plans at once would re-mark each other's elements (see `exclusive`). */
  private lock: Promise<void> = Promise.resolve();
  /** Recently masked texts, for strings that leave the page without a plan (captured human actions). */
  private readonly history = new Map<string, MaskedText>();
  private readonly log: (msg: string) => void;
  private lastFailure = '';

  /**
   * Without `opts`, the schema defaults apply (every filled field masked, the built-in redaction
   * patterns on screen text) and no run values are known.
   */
  constructor(opts: ScreenMaskOptions | undefined, log: (msg: string) => void) {
    this.config = opts?.config ?? resolveScreenMask(undefined);
    // The built-in patterns always apply, policy patterns add to them (as with the evidence
    // redactor: a policy can add masking, never remove it).
    const builtIn = DEFAULT_PATTERNS.map((p) => ({ name: p.name, regex: typeof p.regex === 'string' ? p.regex : p.regex.source }));
    const seen = new Set<string>();
    this.patterns = [...builtIn, ...(opts?.textPatterns ?? [])].filter((p) => {
      const key = `${p.name}\u0000${p.regex}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    this.runValues = opts?.sensitiveValues ?? (() => []);
    this.log = log;
  }

  /**
   * Runs `fn` (a plan and everything that uses its marks, through cleanup) with no other plan in
   * flight on this surface. Two overlapping plans (Relay's live view polling during an
   * observation, a policy check describing a target) would re-mark each other's elements with
   * their own nonce and the first capture would go out unmasked. With a deadline, a page that
   * never answers (a script in an endless loop) cannot hold the lock forever: past it the caller
   * gets `onTimeout()`, the lock is released, and the abandoned work, which sees
   * `signal.abandoned`, must not capture anything when it resumes.
   */
  async exclusive<T>(fn: (signal: AbandonSignal) => Promise<T>, opts?: ExclusiveOptions<T>): Promise<T> {
    const previous = this.lock;
    let release!: () => void;
    this.lock = new Promise<void>((r) => (release = r));
    const signal: AbandonSignal = { abandoned: false };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const work = (async () => {
        await previous;
        return fn(signal);
      })();
      if (!opts) return await work;
      const timedOut = new Promise<{ timedOut: true }>((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), opts.deadlineMs);
      });
      const winner = await Promise.race([work.then((value) => ({ value })), timedOut]);
      if ('timedOut' in winner) {
        signal.abandoned = true;
        work.catch(() => undefined);
        this.log('screen mask: a capture did not finish within its deadline; withheld');
        return opts.onTimeout();
      }
      return winner.value;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      release();
    }
  }

  /**
   * Records a value read from a masked element: from now on it is masked wherever the page shows
   * it as a whole token (screen and text). Only values specific enough to mask elsewhere are kept
   * (6+ characters, or 4+ with a digit): "Yes" or "0" would hide half of every page. Applies only
   * with `maskTextPatterns`, like the run's own values.
   */
  learn(value: string): void {
    const v = value.trim().replace(/\s+/g, ' ');
    if (!learnable(v) || this.learned.includes(v)) return;
    this.learned.push(v);
    if (this.learned.length > MAX_VALUES) this.learned.shift();
  }

  /**
   * `pageOptions()` under a separate marking attribute, for a one-element probe
   * (`lib.maskKindOf`): its marks and its cleanup can never touch a capture's marks.
   */
  probeOptions(): Omit<MaskPlanOptions, 'nonce'> {
    return { ...this.pageOptions(), attr: `${MASK_ATTR}-probe` };
  }

  /** The rules as the page receives them (no nonce, no run value). */
  pageOptions(): Omit<MaskPlanOptions, 'nonce'> {
    return {
      attr: MASK_ATTR,
      maskInputs: this.config.maskInputs,
      selectors: [...this.config.maskSelectors],
      labels: [...this.config.maskLabels],
      textPatterns: this.config.maskTextPatterns ? this.patterns : [],
    };
  }

  /** The run's non-empty secret/sensitive values, read now. */
  private currentRunValues(): string[] {
    try {
      return [...this.runValues()].map((v) => String(v)).filter((v) => v.trim() !== '');
    } catch {
      return [];
    }
  }

  /**
   * True when a capture taken without planning (a native dialog blocks evaluation) could show
   * nothing this policy masks: only typed-field masking configured, nothing typed, no rule that
   * reads page content, no run value. Otherwise such a capture must not be taken.
   */
  get canCaptureUnplanned(): boolean {
    const c = this.config;
    return (
      c.maskInputs === 'typed' &&
      !this.typed.active &&
      c.maskSelectors.length === 0 &&
      c.maskLabels.length === 0 &&
      (!c.maskTextPatterns || (this.patterns.length === 0 && this.currentRunValues().length === 0)) &&
      c.omitScreenshotUrlPatterns.length === 0
    );
  }

  /** True when one of `urls` (top document and frames) matches `omitScreenshotUrlPatterns`. */
  omitFor(urls: readonly string[]): boolean {
    return urlMatchesAny(urls, this.config.omitScreenshotUrlPatterns);
  }

  /**
   * Masks a string that leaves the page without a plan (a captured human action's target, a
   * native dialog's message, a ref description that could not be read live, a browser error):
   * recently masked texts, the run's values, "Label: value" lines under the policy's labels, and
   * (with `maskTextPatterns`) the redaction patterns.
   */
  scrubText(s: string): string {
    return this.matcherOver([...this.history.values()]).replace(maskLabelledLines(s, this.config.maskLabels));
  }

  /** The texts a matcher needs beyond what a plan hid: the run's values and learned values (with `maskTextPatterns`). */
  private withRunValues(texts: readonly MaskedText[]): MaskedText[] {
    if (!this.config.maskTextPatterns) return [...texts];
    return [
      ...texts,
      ...this.currentRunValues().map((v) => ({ text: v, kind: 'sensitive' })),
      ...this.learned.map((v) => ({ text: v, kind: 'sensitive', token: true })),
    ];
  }

  private matcherOver(texts: readonly MaskedText[]): MaskMatcher {
    return createMaskMatcher(this.withRunValues(texts), this.config.maskTextPatterns ? { patterns: this.patterns } : {});
  }

  private remember(texts: readonly MaskedText[]): void {
    for (const t of texts) {
      if (t.part === true) continue;
      const key = lower(t.text);
      if (key.length < MIN_MASKED_SUBSTRING) continue;
      this.history.delete(key);
      this.history.set(key, t);
      if (this.history.size > MAX_HISTORY) this.history.delete(this.history.keys().next().value as string);
    }
  }

  /**
   * Plans one frame: the result (with `observed`, the handle to the whole `maskObserve` /
   * `maskObserveText` result, when `observe`), `skip` (not rendered), or an error (rendered but
   * unplannable). An agent of another major is rethrown for `observe: 'elements'` (an observation
   * must fail loudly, as enumeration does).
   */
  private async planFrame(
    f: FrameInfo,
    nonce: string,
    observe: 'elements' | 'text' | undefined,
    maxElements?: number,
  ): Promise<{ result: MaskPlanResult; observed?: JSHandle } | { skip: true } | { error: string }> {
    if (f.frame.isDetached()) return { skip: true };
    let message = '';
    for (let attempt = 1; attempt <= 2; attempt++) {
      let observed: JSHandle | undefined;
      try {
        await ensureAgent(f.frame);
        const opts = { ...this.pageOptions(), nonce };
        let raw: unknown;
        if (observe) {
          observed =
            observe === 'elements'
              ? await f.frame.evaluateHandle(
                  ([o, max]) => window.__cuAgent!.lib.maskObserve(o, max !== undefined ? { maxElements: max } : undefined),
                  [opts, maxElements] as const,
                )
              : await f.frame.evaluateHandle((o) => window.__cuAgent!.lib.maskObserveText(o), opts);
          raw = await observed.evaluate((r: { plan: unknown }) => r.plan);
        } else {
          raw = await f.frame.evaluate((o) => window.__cuAgent!.lib.maskPlan(o), opts);
        }
        const fail = (error: string): { error: string } => {
          void observed?.dispose().catch(() => undefined);
          return { error };
        };
        if (!isPlanResult(raw)) return fail('mask plan returned an unexpected shape');
        if (raw.errors.length > 0) return fail(`mask rules rejected: ${raw.errors.slice(0, 3).join('; ')}`);
        if (raw.truncated) return fail('too many text blocks to compare against the run values');
        const result = { ...raw, texts: textsOf(raw.texts) };
        return observed ? { result, observed } : { result };
      } catch (err) {
        await observed?.dispose().catch(() => undefined);
        if (observe === 'elements' && err instanceof AgentVersionError) throw err;
        message = err instanceof Error ? (err.name || 'Error') : 'Error';
        if (attempt === 1) await f.frame.waitForLoadState('domcontentloaded', { timeout: 2000 }).catch(() => undefined);
      }
    }
    if (!(await isRendered(f.frame))) return { skip: true };
    return { error: `frame could not be planned (${message})` };
  }

  /**
   * Computes the masks for one capture of `page` (see the module header). With `observe`, each
   * frame is planned and enumerated (`'elements'`) or read (`'text'`, its body text) in one call
   * (`observed`). Never throws, except an `AgentVersionError` with `observe: 'elements'`.
   */
  async plan(page: Page, opts: { observe?: 'elements' | 'text'; maxElements?: number } = {}): Promise<ScreenMaskPlan> {
    const nonce = randomBytes(8).toString('hex');
    const selector = `[${MASK_ATTR}="${nonce}"]`;
    const paintSelector = `[${MASK_PAINT_ATTR}="${nonce}"]`;
    const sheet = redactionSheet(nonce);
    // Any navigation from here to verify() means the capture may show a document nobody planned.
    let navigated = false;
    const onNavigated = (): void => {
      navigated = true;
    };
    page.on('framenavigated', onNavigated);
    const frames = listFrames(page);
    const failedFrames = new Set<Frame>();
    const reasons: string[] = [];
    const texts: MaskedText[] = [];
    const planned: { frame: Frame; result: MaskPlanResult }[] = [];
    const observed = new Map<Frame, JSHandle>();

    await this.typed.markHandles(nonce);
    try {
      for (const f of frames) {
        const r = await this.planFrame(f, nonce, opts.observe, opts.maxElements);
        if ('result' in r) {
          planned.push({ frame: f.frame, result: r.result });
          if (r.observed) observed.set(f.frame, r.observed);
          texts.push(...r.result.texts);
        } else if ('error' in r) {
          failedFrames.add(f.frame);
          reasons.push(r.error);
        }
      }
    } catch (err) {
      page.off('framenavigated', onNavigated);
      for (const h of observed.values()) await h.dispose().catch(() => undefined);
      for (const f of frames) {
        await f.frame.evaluate(invoke(CLEAR_JS, { attr: MASK_ATTR, kind: MASK_KIND_ATTR, paint: MASK_PAINT_ATTR, nonce })).catch(() => undefined);
      }
      throw err;
    }

    // Node-side comparisons: values that must never reach a page.
    const runValues = this.config.maskTextPatterns ? this.currentRunValues() : [];
    const valueNeedles = [
      ...runValues.filter((v) => v.trim().length >= MIN_MASKED_SUBSTRING).map((v) => ({ needle: lower(v.trim().replace(/\s+/g, ' ')), kind: 'sensitive', token: false })),
      ...(this.config.maskTextPatterns ? this.learned : []).map((v) => ({ needle: lower(v), kind: 'sensitive', token: true })),
    ];
    const fieldValues = new Map<string, string>();
    for (const v of this.typed.values) fieldValues.set(v, 'input');
    for (const v of this.currentRunValues()) fieldValues.set(v, 'sensitive');
    for (const entry of planned) {
      const { frame, result } = entry;
      // Text masked in another frame is masked here too (one masked view across frames).
      const crossFrame = planned
        .filter((other) => other.frame !== frame)
        .flatMap((other) => other.result.texts)
        .filter((t) => t.part !== true && t.text.length >= MIN_MASKED_SUBSTRING)
        .map((t) => ({ needle: lower(t.text), kind: t.kind, token: false }));
      const needles = [...valueNeedles, ...crossFrame];
      const byKind = new Map<string, { ranges: MaskRange[]; fields: number[] }>();
      const group = (kind: string): { ranges: MaskRange[]; fields: number[] } => {
        let g = byKind.get(kind);
        if (!g) byKind.set(kind, (g = { ranges: [], fields: [] }));
        return g;
      };
      if (needles.length > 0) {
        result.blocks.forEach((text, i) => {
          if (typeof text !== 'string') return;
          for (const r of findRanges(i, text, needles)) group(r.kind).ranges.push({ block: r.block, start: r.start, end: r.end });
        });
      }
      result.fields.forEach((value, i) => {
        if (typeof value !== 'string') return;
        const kind = fieldValues.get(value);
        if (kind !== undefined) group(kind).fields.push(i);
      });
      for (const [kind, g] of byKind) {
        try {
          const added = (await frame.evaluate(([n, r, fi, k]) => window.__cuAgent!.lib.maskMark(n, r, fi, k), [nonce, g.ranges, g.fields, kind] as const)) as unknown;
          if (added === null || typeof added !== 'object') throw new Error('replaced');
          texts.push(...textsOf((added as { texts?: unknown }).texts));
        } catch {
          failedFrames.add(frame);
          reasons.push('marking matched values failed (the frame changed while it was planned)');
        }
      }
    }

    this.remember(texts);
    const failed = failedFrames.size > 0;
    if (failed) {
      const why = reasons.join('; ');
      if (why !== this.lastFailure) this.log(`screen mask: failing closed (${why})`);
      this.lastFailure = why;
    }
    const covered = new Set<Frame>(frames.map((f) => f.frame));
    const plannedFrames = new Set<Frame>(planned.map((x) => x.frame));
    const allTexts = this.withRunValues(texts);
    const verify = async (p: Page): Promise<boolean> => {
      if (navigated || listFrames(p).some((f) => !covered.has(f.frame))) return false;
      for (const x of planned) {
        const ok: unknown = await x.frame.evaluate((n) => window.__cuAgent!.lib.maskVerify(n), nonce).catch(() => null);
        if (ok !== true) return false;
      }
      if (!(await this.typed.verify(nonce))) return false;
      return !navigated;
    };
    return {
      nonce,
      selector,
      mask: frames.map((f) => f.frame.locator(`input[type=password i], ${selector}, ${paintSelector}`)),
      failed,
      sheet,
      observed: (frame) => (failedFrames.has(frame) ? undefined : observed.get(frame)),
      failedFrames,
      covers: (frame) => covered.has(frame) && !failedFrames.has(frame),
      hasUncoveredFrames: (p) => listFrames(p).some((f) => !covered.has(f.frame)),
      reasons,
      texts: allTexts,
      matcher: createMaskMatcher(allTexts, this.config.maskTextPatterns ? { patterns: this.patterns } : {}),
      verify,
      sheetWins: async () => {
        for (const x of planned) {
          const losing: unknown = await x.frame.evaluate(([n, css]) => window.__cuAgent!.lib.maskSheetCheck(n, css), [nonce, sheet] as const).catch(() => null);
          if (losing !== 0) {
            this.log(`screen mask: the redaction stylesheet does not win on ${typeof losing === 'number' && losing > 0 ? `${losing} element(s)` : 'this page'}; screenshot withheld`);
            return false;
          }
        }
        return true;
      },
      touches: async (frame, el) => {
        if (!plannedFrames.has(frame)) return true; // unplanned: assume the worst
        try {
          return (await el.evaluate((node, n) => window.__cuAgent!.lib.maskTouches(n, node), nonce)) === true;
        } catch {
          return true;
        }
      },
      cleanup: async () => {
        page.off('framenavigated', onNavigated);
        for (const h of observed.values()) await h.dispose().catch(() => undefined);
        for (const f of frames) {
          await f.frame.evaluate(invoke(CLEAR_JS, { attr: MASK_ATTR, kind: MASK_KIND_ATTR, paint: MASK_PAINT_ATTR, nonce })).catch(() => undefined);
        }
      },
    };
  }

  /** Releases what the masker holds (typed-into element handles). */
  async dispose(): Promise<void> {
    await this.typed.dispose();
  }
}

/** True when `frame` can show anything: the top document always; a child frame when its frame element has a box. */
async function isRendered(frame: Frame): Promise<boolean> {
  if (!frame.parentFrame()) return true;
  if (frame.isDetached()) return false;
  try {
    return (await frameOffset(frame)) !== undefined;
  } catch {
    return false;
  }
}

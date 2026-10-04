/**
 * What the desktop surface paints over in screenshots and blanks in observations.
 *
 * Always, whatever the configuration:
 *  - Password fields (UIA IsPassword) are painted over and never read (the bridge never asks
 *    for their value; this module never sees one).
 *  - Every field this surface typed into, for the rest of the surface's life, and any field whose
 *    current value equals a value this surface typed (an app that copies a typed value into
 *    another field), mirroring packages/adapter-playwright/src/mask.ts.
 *
 * Typed values never leave this process: the bridge is told which fields to paint by element id,
 * and which fields hold a typed value is decided here, from the values in the snapshot.
 *
 * Configurable through a {@link DesktopScreenMask}, which the composition root builds from the
 * policy's `redaction.screen` block ({@link desktopScreenMaskFromPolicy}, the same block the
 * Playwright surface honours; docs/design/screen-masking.md):
 *  - `maskInputs: 'all'` paints every editable value control, typed into or not, and shows its
 *    value as `[MASKED]` (an empty field stays empty).
 *  - `maskLabels`: regex sources, each matched (case-insensitively) against a field's WHOLE label
 *    (as `^(?:source)$`, a trailing colon dropped), never a substring of it; a value control, or a
 *    static showing a value, whose label matches is painted over, and its value/text in the
 *    observation (elements, text digest) is replaced by `[MASKED]`.
 *  - `maskTextPatterns`: regex sources; an element whose visible text matches is painted over and
 *    shown as `[MASKED]`.
 *  - `sensitiveValues`: the run's secret and sensitive values; an element showing one is masked
 *    like a `maskTextPatterns` match, and the value is scrubbed wherever else it shows. Compared in
 *    this process only.
 *  - `omitScreenshotUrlPatterns`: regex sources; while the current location matches, screenshots
 *    are not taken at all (an observation carries none).
 *  - `maskSelectors` are CSS selectors and have no desktop meaning; they are ignored.
 * Fields this surface typed into are shown as `[MASKED]` too, whatever the configuration.
 *
 * Condition checks see real values unless the caller asks for the masked view
 * (`CheckOptions.view: 'masked'`, how discovery evaluates model-written text), and `readText`
 * returns the real text with `masked: true` when the element is masked, so the caller withholds it.
 */
import { DEFAULT_PATTERNS } from '@cu/core/evidence';
import type { FramePath } from '@cu/core/schema';
import { formatDesktopUrl, parseDesktopUrl, type ScreenMaskOptions } from '@cu/core/surface';
import { CT } from './protocol.js';
import type { DesktopNode } from './tree.js';

/**
 * A frame path with every hop whose name carries a masked string replaced by an index-only hop
 * (`{ index }`): the window or group title is not recorded, and the hop still matches (any frame at
 * that depth with that index), so targets under it resolve by their own locators, which descriptor
 * synthesis checks are unique across every frame such a hop matches.
 */
export function maskFrame(frame: FramePath, hidden: MaskedStrings): FramePath {
  if (hidden.empty) return frame;
  return frame.map((hop) => (hop.name !== undefined && hidden.mentions(hop.name) ? { index: hop.index ?? 0 } : hop));
}

/**
 * A desktop location with the masked strings scrubbed from its window title (re-encoded, so it is
 * still a well-formed location of the same process). Anything else is returned unchanged.
 */
export function maskLocation(url: string, hidden: MaskedStrings): string {
  if (hidden.empty) return url;
  const loc = parseDesktopUrl(url);
  if (!loc || loc.title === undefined || !hidden.mentions(loc.title)) return url;
  return formatDesktopUrl(loc.processName, hidden.scrub(loc.title));
}

/** Label/text masking options for screenshots and observations (see the module header for what is always masked). */
export interface DesktopScreenMask {
  /** `typed` (default): only fields this surface typed into; `all`: every editable field. */
  maskInputs?: 'all' | 'typed';
  /** CSS selectors: no desktop equivalent, ignored. */
  maskSelectors?: readonly string[];
  /** Regex sources matched (case-insensitively) against a field's label. */
  maskLabels?: readonly string[];
  /** Regex sources matched (case-insensitively) against an element's visible text. */
  maskTextPatterns?: readonly string[];
  /** Regex sources matched (case-insensitively) against the current desktop:// location. */
  omitScreenshotUrlPatterns?: readonly string[];
  /** The run's secret and sensitive values, read per view: an element showing one is masked. */
  sensitiveValues?: () => readonly string[];
}

/**
 * The desktop form of a policy's `redaction.screen` block (`screenMaskOptionsFromPolicy`):
 * `maskInputs`, `maskLabels` (whole-label match) and `omitScreenshotUrlPatterns` as written; with
 * `maskTextPatterns`, the built-in redaction patterns plus the policy's, and the run's values.
 * `maskSelectors` (CSS) have no desktop meaning.
 */
export function desktopScreenMaskFromPolicy(opts: ScreenMaskOptions): DesktopScreenMask {
  const c = opts.config;
  const builtIn = DEFAULT_PATTERNS.map((p) => (typeof p.regex === 'string' ? p.regex : p.regex.source));
  return {
    maskInputs: c.maskInputs,
    maskLabels: [...c.maskLabels],
    maskTextPatterns: c.maskTextPatterns ? [...new Set([...builtIn, ...opts.textPatterns.map((p) => p.regex)])] : [],
    omitScreenshotUrlPatterns: [...c.omitScreenshotUrlPatterns],
    ...(c.maskTextPatterns && opts.sensitiveValues ? { sensitiveValues: opts.sensitiveValues } : {}),
  };
}

/** Replacement shown for a masked value in an observation. */
export const MASKED_TEXT = '[MASKED]';

/**
 * The strings one view must not show: every value or visible text of an element the mask hides.
 * A masked string can also turn up elsewhere (a borrowed Win32 name, a window title, a dialog
 * message, a locator), so everything an observation carries is scrubbed with {@link scrub}, and
 * locators that would record one are dropped ({@link mentions}). Strings shorter than three
 * characters are matched whole, not as substrings, so masking "1" does not rewrite every digit.
 */
export class MaskedStrings {
  private readonly strings: string[];

  constructor(strings: Iterable<string>) {
    this.strings = [...new Set([...strings].filter((s) => s.trim() !== ''))].sort((a, b) => b.length - a.length);
  }

  get empty(): boolean {
    return this.strings.length === 0;
  }

  /** True when `s` is, or (for masked strings of 3+ characters) contains, a masked string. */
  mentions(s: string | undefined): boolean {
    if (s === undefined || this.strings.length === 0) return false;
    return this.strings.some((m) => (m.length >= 3 ? s.includes(m) : s === m));
  }

  /** `s` with every masked string replaced by `[MASKED]`. */
  scrub(s: string): string;
  scrub(s: string | undefined): string | undefined;
  scrub(s: string | undefined): string | undefined {
    if (s === undefined || this.strings.length === 0) return s;
    let out = s;
    for (const m of this.strings) {
      if (m.length >= 3) out = out.split(m).join(MASKED_TEXT);
      else if (out === m) out = MASKED_TEXT;
    }
    return out;
  }

  /** A deep copy of `value` with every string scrubbed. */
  scrubDeep<T>(value: T): T {
    if (this.strings.length === 0) return value;
    const walk = (v: unknown): unknown => {
      if (typeof v === 'string') return this.scrub(v);
      if (Array.isArray(v)) return v.map(walk);
      if (v !== null && typeof v === 'object' && !Buffer.isBuffer(v)) {
        const o: Record<string, unknown> = {};
        for (const [k, x] of Object.entries(v)) o[k] = walk(x);
        return o;
      }
      return v;
    };
    return walk(value) as T;
  }
}

const EDITABLE: ReadonlySet<number> = new Set([CT.Edit, CT.ComboBox, CT.Spinner, CT.Document]);
const MAX_VALUES = 200;

function compile(sources: readonly string[] | undefined, whole = false): RegExp[] {
  const out: RegExp[] = [];
  for (const s of sources ?? []) {
    try {
      out.push(new RegExp(whole ? `^(?:${s})$` : s, 'i'));
    } catch {
      /* an invalid pattern masks nothing rather than breaking the surface; policy load validates */
    }
  }
  return out;
}

/** Applies a {@link DesktopScreenMask} plus the always-on rules to a view's nodes. */
export class DesktopMask {
  private readonly typedRids = new Set<string>();
  private readonly typedValues: string[] = [];
  private readonly labels: RegExp[];
  private readonly texts: RegExp[];
  private readonly omit: RegExp[];
  private readonly all: boolean;
  private readonly runValues: () => readonly string[];

  constructor(config: DesktopScreenMask = {}) {
    this.labels = compile(config.maskLabels, true);
    this.texts = compile(config.maskTextPatterns);
    this.omit = compile(config.omitScreenshotUrlPatterns);
    this.all = config.maskInputs === 'all';
    this.runValues = config.sensitiveValues ?? (() => []);
  }

  /** The run's values worth matching (3+ characters, like every masked string). */
  private values3(): string[] {
    try {
      return this.runValues().filter((v) => v.trim().length >= 3);
    } catch {
      return [];
    }
  }

  /** Records a field this surface typed into, and the value typed. */
  rememberTyped(rid: string, value: string): void {
    this.typedRids.add(rid);
    if (value !== '' && !this.typedValues.includes(value)) {
      this.typedValues.push(value);
      if (this.typedValues.length > MAX_VALUES) this.typedValues.shift();
    }
  }

  /** Values typed so far: the bridge also paints any field currently holding one of them. */
  get values(): readonly string[] {
    return this.typedValues;
  }

  /** True when no screenshot may be taken at `url`. */
  omitsScreenshotAt(url: string): boolean {
    return this.omit.some((re) => re.test(url));
  }

  /** The node's value or text is replaced by `[MASKED]` in observations. */
  hidesText(node: DesktopNode): boolean {
    return this.hidesInput(node) || this.hiddenByRule(node);
  }

  /**
   * An editable field masked as a field: every one under `maskInputs: 'all'`, and those this surface
   * typed into. Its value is hidden in its own element only, never scrubbed elsewhere (a search key
   * is echoed all over a results page).
   */
  private hidesInput(node: DesktopNode): boolean {
    if (!EDITABLE.has(node.ct)) return false;
    return this.all || this.typedRids.has(node.rid) || (node.value !== undefined && node.value !== '' && this.typedValues.includes(node.value));
  }

  /** Content a label, text-pattern or run-value rule hides: hidden wherever else it shows too. */
  private hiddenByRule(node: DesktopNode): boolean {
    if (node.label !== undefined && (EDITABLE.has(node.ct) || node.ct === CT.Text)) {
      const label = node.label.replace(/\s+/g, ' ').trim().replace(/\s*[:\uFF1A\uFE55]$/, '');
      if (this.labels.some((re) => re.test(label))) return true;
    }
    const text = node.text;
    if (text !== undefined && this.texts.some((re) => re.test(text))) return true;
    const values = this.values3();
    if (values.length > 0) {
      const shown = [node.text, node.value, node.uiaName].filter((s): s is string => s !== undefined);
      if (values.some((v) => shown.some((s) => s.includes(v)))) return true;
    }
    return false;
  }

  /**
   * The strings a view must not show: values and texts of the nodes a label, text-pattern or
   * run-value rule hides (not of fields masked only as fields), every title (a window title or
   * group name: visible text too) that a `maskTextPatterns` pattern matches, whole, and the run's
   * values.
   */
  maskedStrings(nodes: readonly DesktopNode[], titles: readonly string[] = []): MaskedStrings {
    const out: string[] = [];
    for (const n of nodes) {
      if (!this.hiddenByRule(n)) continue;
      if (n.value !== undefined) out.push(n.value);
      if (n.text !== undefined) out.push(n.text);
      // A static or button shows its value as its name.
      if (!EDITABLE.has(n.ct) && n.uiaName.trim() !== '') out.push(n.uiaName.trim());
    }
    for (const t of titles) if (t.trim() !== '' && this.texts.some((re) => re.test(t))) out.push(t);
    // The run's values are scrubbed wherever they show (a title, a borrowed name, a dialog message).
    out.push(...this.values3());
    return new MaskedStrings(out);
  }

  /** The node is painted over in screenshots. */
  paints(node: DesktopNode): boolean {
    if (node.password) return true;
    if (this.typedRids.has(node.rid)) return true;
    if (node.value !== undefined && node.value !== '' && this.typedValues.includes(node.value)) return true;
    if (this.all && EDITABLE.has(node.ct)) return true;
    return this.hidesText(node);
  }
}

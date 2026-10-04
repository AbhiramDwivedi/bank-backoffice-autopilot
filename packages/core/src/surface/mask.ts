/**
 * The text half of screen masking (docs/design/screen-masking.md), shared by every surface: once a
 * surface knows what it painted over in the pixels, these helpers hide the same content in what it
 * reports as text, so the model, the evidence and the operator console get one masked view.
 *
 * A surface adapter decides WHAT is masked (it alone can see the app); this module only turns
 * "these texts were masked, this element was masked" into placeholders:
 *  - a masked element's own text and value become `[MASKED:<kind>]`, and its name too when the
 *    name is that text (a value cell named by its content), not when it is a label;
 *  - every other string the surface reports (other elements' names and texts, the text digest, the
 *    title) has each masked text replaced wherever it occurs, whitespace- and case-insensitively;
 *  - a synthesized descriptor loses every locator whose match string carries masked text (a text,
 *    role, label or anchor locator; a css selector, or a relative locator's `selector`/`within`,
 *    that quotes it, verbatim or slugged into a class or id), so record-time PII is never
 *    recorded into a capability. The bbox locator always survives, so a masked element stays
 *    addressable, and a value cell keeps the anchor locator built from its (unmasked) label.
 *
 * Placeholders are never matched again, so applying a matcher twice changes nothing.
 */
import { REDACTED_VALUE, alnumFold, resolveScreenMask, type Locator, type Policy, type ScreenMaskConfig, type TargetDescriptor } from '../schema/index.js';
import type { ObservedElement } from './types.js';

export type { ScreenMaskConfig };

/** One piece of text a surface masked, and the rule that masked it (a short slug: 'address', 'ssn', 'input'). */
export interface MaskedText {
  text: string;
  kind: string;
  /** Only part of what was hidden (an inner element's own text). A short part ("OK", ":") is not matched elsewhere. */
  part?: boolean;
  /** Match only as a whole token (a learned value "0.00" must not hide "$10.00"). */
  token?: boolean;
}

/** Options for {@link createMaskMatcher}. */
export interface MaskMatcherOptions {
  /** Regex sources (compiled 'gi'), applied after the texts: each match becomes `[MASKED:<name>]`. */
  patterns?: readonly { name: string; regex: string }[];
}

/**
 * Everything a surface adapter needs to honour a policy's `redaction.screen` block. Built by
 * {@link screenMaskOptionsFromPolicy}; another adapter (desktop) takes the same object.
 */
export interface ScreenMaskOptions {
  config: ScreenMaskConfig;
  /** Applied to on-screen text when `config.maskTextPatterns` (the policy's `redaction.patterns`). */
  textPatterns: readonly { name: string; regex: string }[];
  /**
   * The run's secret and sensitive values, read on every screenshot (a value can become known
   * mid-run). Compared inside the surface process only: never sent to the app.
   */
  sensitiveValues?: () => readonly string[];
}

/** The options a surface needs to apply `policy.redaction.screen`, with the run's values as a getter. */
export function screenMaskOptionsFromPolicy(policy: Policy, sensitiveValues?: () => readonly string[]): ScreenMaskOptions {
  return {
    config: resolveScreenMask(policy.redaction.screen),
    textPatterns: policy.redaction.patterns.map((p) => ({ name: p.name, regex: p.regex })),
    ...(sensitiveValues !== undefined ? { sensitiveValues } : {}),
  };
}

/** Matches one placeholder this module writes. */
export const MASKED_PLACEHOLDER_RE = /\[MASKED(?::[a-z0-9_]{1,32})?\]/;

/** `[MASKED:<kind>]` (kind slugged to `[a-z0-9_]`, max 32), or `[MASKED]` without one. */
export function maskPlaceholder(kind?: string): string {
  const slug = (kind ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32)
    .replace(/_+$/, '');
  return slug ? `[MASKED:${slug}]` : '[MASKED]';
}

/** True when `s` is exactly one placeholder (a field or name this module already masked). */
export function isMaskedPlaceholder(s: string | undefined): boolean {
  return s !== undefined && new RegExp(`^${MASKED_PLACEHOLDER_RE.source}$`).test(s.trim());
}

const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** Texts shorter than this are only masked where a whole field equals them (a two-letter code is everywhere). */
export const MIN_MASKED_SUBSTRING = 3;
/** Shortest trailing prefix of a masked text that a matcher still treats as that text, cut off. */
export const MIN_TRUNCATED_TAIL = 5;

/** Replaces masked texts in arbitrary strings. */
export interface MaskMatcher {
  /** No texts registered: `replace` is the identity. */
  readonly empty: boolean;
  /** `s` with every masked text replaced by its placeholder; a field equal to a short masked text becomes the placeholder. */
  replace(s: string): string;
  /** True when `replace(s)` would change `s`. */
  contains(s: string): boolean;
  /**
   * True when `s` (a CSS selector) carries a masked text, compared with everything but letters and
   * digits removed on both sides: a value slugged into a class or id (`.member-jane-sample`,
   * `#acct-4012`) is found too. Masked texts under {@link MIN_SLUGGED_LEN} folded characters, and
   * whole-token-only ones, are not compared (they would match inside unrelated identifiers).
   */
  containsSlugged(s: string): boolean;
}

/** Shortest folded masked text {@link MaskMatcher.containsSlugged} looks for. */
export const MIN_SLUGGED_LEN = 4;

/**
 * A matcher over `texts`: whitespace-collapsed, case-insensitive, longest first, one left-to-right
 * pass (a replacement is never matched again; an existing placeholder is skipped). Texts of
 * {@link MIN_MASKED_SUBSTRING}+ characters are replaced wherever they occur. A shorter one that is
 * the whole of what was hidden (a masked "42" cell) is replaced where it stands as a whole token
 * ("Age 42"), when it has a letter or digit, and so is a `token` text of any length; a short part
 * of a hidden element ("OK" inside a masked panel) is not matched elsewhere at all. Patterns
 * (`opts.patterns`) run last. A string that changes comes back whitespace-collapsed.
 *
 * Built for large plans (thousands of masked cells): texts are indexed by their first characters,
 * so a replace costs one scan of the input, not one pass per masked text.
 */
export function createMaskMatcher(texts: Iterable<MaskedText>, opts: MaskMatcherOptions = {}): MaskMatcher {
  // key (collapsed, lower-cased) -> { placeholder, whole-token only }
  const entries = new Map<string, { ph: string; token: boolean }>();
  for (const t of texts) {
    const c = collapse(t.text);
    if (c === '' || isMaskedPlaceholder(c)) continue;
    const key = c.toLowerCase();
    const isShort = c.length < MIN_MASKED_SUBSTRING;
    if (isShort && (t.part === true || !/[\p{L}\p{N}]/u.test(c))) continue;
    const token = isShort || t.token === true;
    const existing = entries.get(key);
    if (existing === undefined) entries.set(key, { ph: maskPlaceholder(t.kind), token });
    else if (!token && existing.token) existing.token = false; // a substring entry wins over a token-only one
  }
  const patterns = (opts.patterns ?? []).flatMap((p) => {
    try {
      return [{ re: new RegExp(p.regex, 'gi'), ph: maskPlaceholder(p.name) }];
    } catch {
      return [];
    }
  });
  // Index by the first PREFIX characters (shorter keys under their whole text), longest first.
  const PREFIX = 3;
  const index = new Map<string, string[]>();
  for (const key of entries.keys()) {
    const k = key.slice(0, PREFIX);
    let list = index.get(k);
    if (!list) index.set(k, (list = []));
    list.push(key);
  }
  for (const list of index.values()) list.sort((x, y) => y.length - x.length);
  // Keys for the truncated-tail check, by their first MIN_TRUNCATED_TAIL characters.
  const tails = new Map<string, string[]>();
  let longest = 0;
  for (const [key, e] of entries) {
    if (e.token || key.length <= MIN_TRUNCATED_TAIL) continue;
    longest = Math.max(longest, key.length);
    const k = key.slice(0, MIN_TRUNCATED_TAIL);
    let list = tails.get(k);
    if (!list) tails.set(k, (list = []));
    list.push(key);
  }
  const isWord = (ch: string | undefined): boolean => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
  // Folded (letters and digits only) masked texts, for selectors (`containsSlugged`).
  const folded = [...new Set([...entries].filter(([, e]) => !e.token).map(([key]) => alnumFold(key)))].filter((f) => f.length >= MIN_SLUGGED_LEN);
  const placeholderAt = /\[MASKED(?::[a-z0-9_]{1,32})?\]/y;

  const scan = (c: string): string => {
    const lower = c.toLowerCase();
    let out = '';
    let changed = false;
    let i = 0;
    while (i < c.length) {
      if (c[i] === '[') {
        placeholderAt.lastIndex = i;
        const m = placeholderAt.exec(c);
        if (m) {
          out += m[0];
          i += m[0].length;
          continue;
        }
      }
      let hit: string | undefined;
      for (let len = Math.min(PREFIX, c.length - i); len >= 1 && hit === undefined; len--) {
        const list = index.get(lower.slice(i, i + len));
        if (!list) continue;
        for (const key of list) {
          if (!lower.startsWith(key, i)) continue;
          const e = entries.get(key)!;
          if (e.token && (isWord(c[i - 1]) || isWord(c[i + key.length]))) continue;
          hit = key;
          break;
        }
      }
      if (hit !== undefined) {
        out += entries.get(hit)!.ph;
        i += hit.length;
        changed = true;
      } else {
        out += c[i];
        i++;
      }
    }
    return changed ? out : c;
  };

  /**
   * A string cut off inside a masked text (an element name capped at 80 or 300 characters, a
   * digest capped at 8000) ends with a prefix of it that the full-text match cannot see. A tail
   * of {@link MIN_TRUNCATED_TAIL}+ characters, starting at a word boundary, that is a proper prefix
   * of a masked text is masked too. Only the last 2000 characters are examined.
   */
  const maskTruncatedTail = (c: string): string => {
    if (tails.size === 0) return c;
    const lower = c.toLowerCase();
    const from = Math.max(0, c.length - Math.min(longest - 1, 2000));
    for (let at = from; at + MIN_TRUNCATED_TAIL <= c.length; at++) {
      if (at > 0 && isWord(c[at - 1]) && isWord(c[at])) continue;
      const list = tails.get(lower.slice(at, at + MIN_TRUNCATED_TAIL));
      if (!list) continue;
      const rest = lower.slice(at);
      const key = list.find((k) => k.length > rest.length && k.startsWith(rest));
      if (key !== undefined) return `${c.slice(0, at)}${entries.get(key)!.ph}`;
    }
    return c;
  };

  const applyPatterns = (s: string): string => {
    let out = s;
    for (const p of patterns) out = out.replace(p.re, (m) => (isMaskedPlaceholder(m) ? m : p.ph));
    return out;
  };
  const replace = (s: string): string => {
    if (s === '') return s;
    if (entries.size === 0) return applyPatterns(s);
    const c = collapse(s);
    const whole = entries.get(c.toLowerCase());
    if (whole !== undefined) return whole.ph;
    const scanned = maskTruncatedTail(scan(c));
    return applyPatterns(scanned === c ? s : scanned);
  };
  return {
    empty: entries.size === 0 && patterns.length === 0,
    replace,
    contains: (s) => replace(s) !== s,
    containsSlugged: (s) => {
      if (replace(s) !== s) return true;
      if (folded.length === 0) return false;
      const f = alnumFold(s);
      return f !== '' && folded.some((t) => f.includes(t));
    },
  };
}

/** True when two strings overlap: one (collapsed, lower-cased, non-empty) contains the other. */
function overlaps(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const x = collapse(a).toLowerCase();
  const y = collapse(b).toLowerCase();
  return x !== '' && y !== '' && (x.includes(y) || y.includes(x));
}

/** The strings a locator matches on, when it can carry page text (bbox never does). */
function locatorStrings(l: Locator): string[] {
  const s = l.strategy;
  switch (s.kind) {
    case 'role':
      return [s.name];
    case 'label':
      return [s.label];
    case 'text':
      return [s.text];
    case 'relative':
      return [s.anchor.text];
    case 'css':
      return [];
    case 'automation_id':
      // A developer-assigned id, rarely page data; dropped like any locator if it carries hidden text.
      return [s.id];
    case 'bbox':
      return [];
  }
}

/** The CSS selectors a locator carries (a css locator's, a relative locator's `selector` and
 *  `within`): page text can sit in them verbatim or slugged into a class or id. */
function locatorSelectors(l: Locator): string[] {
  const s = l.strategy;
  if (s.kind === 'css') return [s.selector];
  if (s.kind === 'relative') return [s.selector, s.within].filter((x): x is string => x !== undefined);
  return [];
}

/**
 * `d` with every locator carrying masked text dropped (bbox always kept), and masked text replaced
 * in its description and snapshot. `own` are the element's own strings when the element itself is
 * masked (its text, its value): any locator overlapping them is dropped too, and they become
 * `placeholder` in the snapshot.
 */
export function maskDescriptor(d: TargetDescriptor, matcher: MaskMatcher, own: readonly (string | undefined)[] = [], placeholder = maskPlaceholder()): TargetDescriptor {
  const ownStrings = own.filter((s): s is string => s !== undefined && collapse(s) !== '' && s !== REDACTED_VALUE && !isMaskedPlaceholder(s));
  const carries = (s: string): boolean => matcher.contains(s) || ownStrings.some((o) => overlaps(o, s));
  const ownFolded = ownStrings.map(alnumFold).filter((f) => f.length >= MIN_SLUGGED_LEN);
  const selectorCarries = (sel: string): boolean => matcher.containsSlugged(sel) || ownStrings.some((o) => overlaps(o, sel)) || ownFolded.some((f) => alnumFold(sel).includes(f));
  const hide = (s: string): string => (ownStrings.some((o) => overlaps(o, s)) ? placeholder : matcher.replace(s));
  const locators = d.locators.filter((l) => l.strategy.kind === 'bbox' || (!locatorStrings(l).some(carries) && !locatorSelectors(l).some(selectorCarries)));
  const out: TargetDescriptor = { ...d, description: ownStrings.reduce((acc, o) => acc.split(o).join(placeholder), matcher.replace(d.description)), locators };
  if (d.snapshot !== undefined) {
    const snap = { ...d.snapshot };
    if (snap.name !== undefined) snap.name = hide(snap.name);
    if (snap.text !== undefined) snap.text = hide(snap.text);
    out.snapshot = snap;
  }
  return out;
}

/**
 * The text-channel view of one observed element. `maskedKind` set = the element itself was painted
 * over (it, or an ancestor, matched a rule): its text and value become the placeholder, its name too
 * when the name is its own text, and it is flagged `masked: true`. Otherwise every masked text
 * inside its strings is replaced. Either way its descriptor goes through {@link maskDescriptor}.
 */
export function maskObservedElement(el: ObservedElement, matcher: MaskMatcher, maskedKindIn?: string): ObservedElement {
  // An element whose whole text is hidden content is a masked element, painted or not: a text
  // leaf holding one fragment of a value split across elements (`<span>1 Main</span><span> St</span>`)
  // carries no mark of its own, and its fragment is masked only by the matcher's cut-off rule,
  // which a description quoting it mid-string would not trigger.
  const maskedKind = maskedKindIn ?? (matcher.empty ? undefined : wholeMaskedKind(el, matcher));
  if (maskedKind === undefined) {
    if (matcher.empty) return el;
    const out: ObservedElement = { ...el, name: matcher.replace(el.name), descriptor: maskDescriptor(el.descriptor, matcher) };
    if (el.text !== undefined) out.text = matcher.replace(el.text);
    if (el.value !== undefined && el.value !== REDACTED_VALUE) out.value = matcher.replace(el.value);
    return out;
  }
  const isField = FIELD_TAGS.has(el.tag);
  if (!isField && INTERACTIVE_ROLES.has(el.role)) {
    // A control keeps its verb: only the hidden text inside its name is replaced ("Delete
    // [MASKED:member_name]"), so the model and the agent's own gate still see what it does. The
    // matcher holds every text the plan hid (a whole hidden control's text included), and a name
    // cut off inside one is caught by its truncated-tail rule; the hidden part of a long control
    // can also lie past its (capped) name, which then stays as it is.
    const out: ObservedElement = { ...el, name: matcher.replace(el.name), masked: true, descriptor: maskDescriptor(el.descriptor, matcher) };
    if (el.text !== undefined) out.text = matcher.replace(el.text);
    return out;
  }
  const ph = maskPlaceholder(maskedKind);
  const ownValue = el.value !== undefined && el.value !== REDACTED_VALUE ? el.value : undefined;
  // A field's name is its label; anything else's name (its text, or an aria-label that can repeat
  // the hidden content) is content.
  const nameIsContent = el.name !== '' && !isField;
  const out: ObservedElement = {
    ...el,
    name: nameIsContent ? ph : matcher.replace(el.name),
    masked: true,
    descriptor: maskDescriptor(el.descriptor, matcher, [el.text, ownValue, nameIsContent ? el.name : undefined], ph),
  };
  if (el.text !== undefined) out.text = ph;
  // An empty field stays empty: it is masked so that whatever is typed into it is hidden, and
  // showing a placeholder would tell the model there is something to hide.
  if (el.value !== undefined) out.value = el.value === REDACTED_VALUE ? REDACTED_VALUE : el.value === '' ? '' : ph;
  return out;
}

/** The kind when a non-field element's whole text (or, without text, its name) masks to one
 *  placeholder; undefined otherwise. '' for a placeholder without a kind. */
function wholeMaskedKind(el: ObservedElement, matcher: MaskMatcher): string | undefined {
  if (FIELD_TAGS.has(el.tag)) return undefined;
  const own = el.text !== undefined && el.text.trim() !== '' ? el.text : el.name;
  if (own.trim() === '' || isMaskedPlaceholder(own)) return undefined;
  const replaced = matcher.replace(own);
  if (!isMaskedPlaceholder(replaced)) return undefined;
  const m = /^\[MASKED(?::([a-z0-9_]{1,32}))?\]$/.exec(replaced.trim());
  return m?.[1] ?? '';
}

const FIELD_TAGS: ReadonlySet<string> = new Set(['input', 'textarea', 'select']);
const INTERACTIVE_ROLES: ReadonlySet<string> = new Set(['button', 'link', 'clickable', 'menuitem', 'tab']);

/**
 * True when a masked element keeps its verb in the masked view (a control that is not a field):
 * only the hidden text inside its name is replaced. Shared by `maskObservedElement` and a surface's
 * live ref description, so an observation and a policy event name the same control the same way.
 */
export function keepsVerbWhenMasked(role: string, tag: string): boolean {
  return !FIELD_TAGS.has(tag) && INTERACTIVE_ROLES.has(role);
}

/**
 * `text` with the value of every "Label: value" pair whose label matches one of `labels` (regex
 * sources, compiled 'i', matched against the WHOLE label) replaced by `[MASKED:<label>]`: the same
 * rule a surface applies to a line of page text, for text that leaves without a page (a native
 * dialog's message). The label is the 1 to 5 words right before a colon, shortest first, never
 * across a sentence end or another pair; the value runs to the next `Word:` or the end of the line.
 * An ASCII colon must be followed by a space or the end of the line; the full-width colons (U+FF1A,
 * U+FE55) need nothing after them.
 */
export function maskLabelledLines(text: string, labels: readonly string[]): string {
  const res = labels.flatMap((l) => {
    try {
      return [new RegExp(`^(?:${l})$`, 'i')];
    } catch {
      return [];
    }
  });
  if (res.length === 0) return text;
  const isSpace = (ch: string | undefined): boolean => ch !== undefined && /\s/.test(ch);
  return text
    .split('\n')
    .map((line) => {
      const colons: number[] = [];
      for (let i = 1; i < line.length; i++) {
        const ch = line[i]!;
        if ((ch === ':' && (i + 1 >= line.length || isSpace(line[i + 1]))) || ch === '\uFF1A' || ch === '\uFE55') colons.push(i);
      }
      const wordStart = (c: number): number => {
        let i = c;
        while (i > 0 && isSpace(line[i - 1])) i--;
        while (i > 0 && !isSpace(line[i - 1])) i--;
        return i;
      };
      const cuts: { from: number; to: number; kind: string }[] = [];
      colons.forEach((c, idx) => {
        let start = c;
        let kind: string | undefined;
        for (let w = 0; w < 5 && kind === undefined; w++) {
          let i = start;
          while (i > 0 && isSpace(line[i - 1])) i--;
          if (i === 0) break;
          if (w > 0 && /[.;!?|:\uFF1A\uFE55\u3002]/.test(line[i - 1]!)) break;
          start = wordStart(i);
          const label = line.slice(start, c).replace(/\s+/g, ' ').trim();
          if (res.some((re) => re.test(label))) kind = label;
        }
        if (kind === undefined) return;
        let from = c + 1;
        while (from < line.length && isSpace(line[from])) from++;
        const next = colons[idx + 1];
        let to = next !== undefined ? wordStart(next) : line.length;
        while (to > from && (isSpace(line[to - 1]) || (next !== undefined && /[;,]/.test(line[to - 1]!)))) to--;
        if (to > from) cuts.push({ from, to, kind });
      });
      let out = line;
      for (const cut of cuts.reverse()) out = `${out.slice(0, cut.from)}${maskPlaceholder(cut.kind)}${out.slice(cut.to)}`;
      return out;
    })
    .join('\n');
}

/** True when `url` matches one of the policy regex sources (compiled with 'i'). An invalid source matches (fail closed). */
export function urlMatchesAny(urls: readonly string[], patterns: readonly string[]): boolean {
  for (const p of patterns) {
    let re: RegExp;
    try {
      re = new RegExp(p, 'i');
    } catch {
      return true;
    }
    if (urls.some((u) => re.test(u))) return true;
  }
  return false;
}

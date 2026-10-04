/**
 * Generic text leaves and container anchors: what makes a value addressable on markup that is not
 * a legacy table.
 *
 * The legacy rules in enumerate.ts list headings, label/value table cells, message cells, short
 * <b>/<font> texts and error-list items. A value on a modern page (a price in a product card, a
 * status in a <span>, a total in a <p>) matches none of them, so the model could see it but had no
 * element to extract it from. This module adds a third group, 'text', and the descriptor inputs
 * that make such an element findable again at replay.
 *
 * WHAT IS A TEXT LEAF
 * A visible element with at least one direct text-node child that contains a letter or digit: it
 * renders text itself rather than inheriting it from a child. The principle is "leaf text blocks",
 * not a tag list, so a <div>, <span>, <p>, <dd>, <li>, <time>, <output>, an element with role
 * status/alert/definition, or a lone <td> all qualify the same way. Decisions:
 *  - Own text, not inherited. `<div><span>$5</span></div>` lists the span, not the div. An element
 *    with both direct text and element children (`<p>Total: <b>$5</b></p>`) is a leaf, and its
 *    name is its whole rendered text ("Total: $5").
 *  - Inline formatting is absorbed. A class-less, id-less inline child (span, em, strong, i, small,
 *    code, ...) of a leaf is part of its parent's sentence, not a separate block, so it is skipped.
 *    One with a class or id is kept: authors style a value separately (`<span class="amount">`)
 *    exactly when it is a value. Legacy rules still win: a <b> stays listed as before.
 *  - The direct text must hold a letter or digit, so separators ("|", "•", "$") are not listed.
 * WHAT IS EXCLUDED
 *  - Text inside an interactive element: it is that control's accessible name, already listed
 *    with the control. Listing it again would give the model two refs for one thing.
 *  - Text inside an element a legacy rule already selected (its text is that element's name), and
 *    a listed control's label source: its <label>, its aria-labelledby target, or the legacy
 *    adjacent cell that names it ("Member ID" to the left of the Member ID box).
 *  - Hidden or zero-size elements (isVisible), and script/style/noscript/template and other
 *    non-text tags.
 *  - Text over TEXT_LEAF_MAX (200) characters. A long paragraph is prose, not a value: it is not
 *    listed, and stays readable in the page's text digest. A value inside it that the author marked
 *    up (a <b>, a classed <span>) is still listed on its own.
 * PRIORITY AND THE CAP
 * The driver caps the element list (150): interactive first, then the legacy informative kinds,
 * then text leaves by `priority`, lowest first, document order within a priority. A page with
 * hundreds of text leaves therefore never pushes out a control or a legacy cell. Priorities:
 *  0 a message (inside role=alert/status or an aria-live region), or a short value-like leaf (a
 *    digit, at most VALUE_LIKE_MAX characters): prices, dates, counts, ids, statuses;
 *  1 a short leaf (at most 80 characters) near a control (within three levels of one);
 *  2 any other short leaf;
 *  3 a longer leaf (81 to 200 characters).
 * What the cap drops is the low-priority tail; the driver reports how many were dropped so the
 * model knows the list is incomplete.
 *
 * CONTAINER ANCHORS
 * A value in a card is identified by the record it belongs to, not by the text right above it:
 * in a product card the text above the price is the description, and anchoring on that would
 * make a capability return the recorded product's price for every input. The container is the
 * nearest ancestor that holds, outside the element itself, at least one usable anchor: a visible
 * element that renders text of its own (a direct text node, so a wrapper whose innerText only
 * concatenates its children does not count) of at most 80 characters, unique in the document,
 * and not value-like (at most 40 characters with digits making up at least half of its letters and
 * digits: "$29.99", "Order 12345", but not "Model 3 Charger"; see isNumericText). For anchors,
 * uniqueness counts every element (no climb to the clickable: the anchor lookup does not climb).
 * The cap is applied before any of this runs, so it costs at most maxElements elements a frame.
 * A level holding only value-like anchors (the price beside an "Add to
 * cart" button) does not end the climb: a sibling value is record data, not the record's name,
 * so it is kept but listed after the named anchors found further up. That is the smallest
 * grouping a person would read as "this record" (a card, a list item, a table row, a form
 * section), found from the DOM rather than from a list of record-like tags, and it is the same
 * rule for tables and for cards. The climb stops at <body> or at a subtree of over
 * CONTAINER_MAX_ELEMENTS elements (then it is the page, not a record). Within the container,
 * anchors are preferred in this order: a heading, a link's text (a record's title is usually a
 * link), then any other leaf in document order, with value-like texts last (another value of the
 * same record changes over time). Up to CONTAINER_ANCHORS_MAX are returned, so that when the run's
 * input is one of them (the product name, a SKU), the recorder keeps the anchor that carries
 * the input and drops the rest.
 *
 * Each anchor comes with a relation (below, right-of, above, left-of, from the record-time
 * geometry) and a candidate filter: the element's tag, its role when real, and a class selector
 * (`div.price`, or `.pricebar > div` scoped by the parent's classes when the element has none)
 * so that the description <div> between the name and the price is not a candidate. An anchor is
 * returned only if a simulation of the driver's relative resolver (same candidate filter, same
 * ancestor/descendant collapse, same nested-container rule, same geometry and 1px tie rule) picks
 * this very element from it -- with one deliberate exception: inside a container, the anchor is
 * emitted whenever the element is a candidate there, even when it is not the only one. The
 * resolver misses on such a locator (more than one candidate per container), and the recorder's
 * record-time verification then refuses the target; without the anchor, the element would fall
 * back to positional locators. The simulation sees only the light DOM and approximates the anchor
 * lookup; the check that counts is the record-time one, with the real resolver.
 */
import { attr, collapse, inferRole, stripColon, tagOf } from './naming.js';
import { closestClickable, isNestedInteractive } from './selectors.js';
import type { ContainerAnchor, Rect } from './types.js';
import { MAX_STRING } from './constants.js';

/** Longest own text listed as a text leaf; longer is prose (left to the text digest). */
export const TEXT_LEAF_MAX = 200;
/** Longest text that counts as value-like (priority 0) when it holds a digit. */
export const VALUE_LIKE_MAX = 40;
/** Longest text usable as an anchor, and the upper bound of a "short" leaf. */
export const ANCHOR_TEXT_MAX = 80;
/** At most this many container anchors per element. */
export const CONTAINER_ANCHORS_MAX = 3;
/** A container subtree larger than this is the page, not a record: the climb stops. */
export const CONTAINER_MAX_ELEMENTS = 400;
/** Ancestor levels the container climb tries before giving up. */
const CONTAINER_MAX_DEPTH = 8;

/** Tags that never hold a text leaf of their own (or whose text is not rendered text). */
const NON_TEXT_TAGS: ReadonlySet<string> = new Set([
  'html', 'head', 'body', 'script', 'style', 'noscript', 'template', 'title', 'meta', 'link', 'base',
  'iframe', 'frame', 'frameset', 'object', 'embed', 'canvas', 'svg', 'math', 'img', 'picture', 'video', 'audio',
  'source', 'track', 'map', 'area', 'br', 'hr', 'wbr', 'input', 'button', 'select', 'option', 'optgroup',
  'datalist', 'textarea',
]);

/** Inline formatting tags absorbed into a parent leaf when they carry no class or id. */
const INLINE_TAGS: ReadonlySet<string> = new Set([
  'span', 'b', 'i', 'em', 'strong', 'u', 's', 'small', 'mark', 'code', 'sub', 'sup', 'abbr', 'cite', 'q', 'kbd', 'var', 'font', 'bdi', 'bdo',
]);

/** Class tokens that describe state, not identity: a selector using them would miss once the state changes. */
const STATE_CLASS_RE = /^(?:is-|has-)|^(?:active|selected|disabled|enabled|focus|focused|hover|open|opened|closed|hidden|visible|show|shown|current|checked|expanded|collapsed|loading|loaded)$/i;

/** Class tokens that look generated by a build tool (CSS modules, CSS-in-JS hashes, numeric ids). */
const GENERATED_CLASS_RE = /\d{3,}|^(?:css|sc|jsx|emotion|svelte|ng|ember|makeStyles)-|[-_][A-Za-z0-9]*\d[A-Za-z0-9]*$|^_/;

const HAS_WORD_RE = /[\p{L}\p{N}]/u;
const HAS_DIGIT_RE = /\p{N}/u;

/** Relations a container anchor may use, in the order they are tried. */
const RELATIONS: readonly ContainerAnchor['relation'][] = ['below', 'right-of', 'above', 'left-of'];

/** Concatenated direct text-node children of `el` (not its descendants'). */
export function directText(el: Element): string {
  let s = '';
  for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 3) s += n.nodeValue || '';
  return collapse(s);
}

/** `s` case-folded with everything but letters and digits removed: how a text reads once slugged
 *  into a class name ("In transit" and `status-in-transit` both hold "intransit"). */
export function alnumFold(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

/**
 * `el`'s class tokens that are neither state nor generated, at most 3. A token that holds one of
 * `avoid` (texts, compared alnum-folded, 3+ characters) is left out too: a class slugged from the
 * element's own value (`status-in-transit` on a span reading "In transit") or from its record's
 * name would select only records holding that same text.
 */
export function stableClasses(el: Element, avoid: readonly string[] = []): string[] {
  const out: string[] = [];
  const list = el.classList;
  if (!list) return out;
  const slugs = avoid.map(alnumFold).filter((s) => s.length >= 3);
  for (let i = 0; i < list.length && out.length < 3; i++) {
    const c = list[i]!;
    if (!c || STATE_CLASS_RE.test(c) || GENERATED_CLASS_RE.test(c)) continue;
    const fc = alnumFold(c);
    if (slugs.some((s) => fc.includes(s))) continue;
    out.push(c);
  }
  return out;
}

function cssIdent(s: string): string {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(s) : s.replace(/[^A-Za-z0-9_-]/g, (c) => `\\${c}`);
}

/** `tag.cls1.cls2` from `el`'s stable classes (minus those holding one of `avoid`); '' when none is left. */
export function ownClassSelector(el: Element, avoid: readonly string[] = []): string {
  const cls = stableClasses(el, avoid);
  return cls.length ? tagOf(el) + cls.map((c) => `.${cssIdent(c)}`).join('') : '';
}

/** `el`'s own class selector, else `parent.cls > tag` scoped by its parent's stable classes, else
 *  ''. Classes holding `el`'s own text (`ownText`, alnum-folded) are never used. */
export function classSelector(el: Element, ownText = ''): string {
  const avoid = ownText ? [ownText] : [];
  const own = ownClassSelector(el, avoid);
  if (own) return own;
  const p = el.parentElement;
  if (!p) return '';
  const pcls = stableClasses(p, avoid);
  return pcls.length ? `${tagOf(p)}${pcls.map((c) => `.${cssIdent(c)}`).join('')} > ${tagOf(el)}` : '';
}

/** True when `sel` matches exactly one element of this document (false on an invalid selector). */
export function isUniqueSelector(sel: string): boolean {
  if (!sel) return false;
  try {
    return document.querySelectorAll(sel).length === 1;
  } catch {
    return false;
  }
}

function safeMatches(el: Element, sel: string): boolean {
  try {
    return el.matches(sel);
  } catch {
    return false;
  }
}

/** Shared per-document state the leaf and anchor computations read. */
export interface LeafContext {
  visible: readonly Element[];
  visibleSet: ReadonlySet<Element>;
  /** Collapsed own text (innerText) of every visible element. */
  textCache: ReadonlyMap<Element, string>;
  interactiveSet: ReadonlySet<Element>;
  /** Elements the legacy informative rules selected. */
  legacySet: ReadonlySet<Element>;
  /** Visible text leaves (isTextLeaf), the anchor candidates. */
  anchorCandidates: ReadonlySet<Element>;
  /** Uniqueness for a text locator: {@link leafTextIndex} with `climb` (the resolver climbs to the clickable). */
  isUniqueLeafText(t: string): boolean;
  /** Uniqueness for a relative anchor: {@link leafTextIndex} without `climb` (the anchor lookup does not climb). */
  isUniqueAnchorText(t: string): boolean;
  rect(el: Element): Rect;
  /** Per call: a table column's shared affixes ({@link columnAffixes}), by table section and column index. */
  columnCache?: Map<Element, Map<number, ColumnAffixes | null>>;
}

/**
 * Uniqueness of a text the way the driver's text lookups see it (Playwright's getByText returns
 * the innermost element holding the text): among visible elements that render text themselves (a
 * direct text node with a letter or digit), keyed by their collapsed innerText, lower-cased (the
 * anchor lookup compares case-insensitively). With `climb`, an element and its closest
 * interactive ancestor count as one, as for a text locator, whose resolver climbs to the
 * clickable; without it every element counts, as for a relative anchor, whose lookup does not
 * climb (two same-text cells in one clickable row are ambiguous there). A wrapper whose innerText
 * merely repeats its only child's text does not count twice, which the legacy uniqueness map
 * (enumerate.ts, kept as is for the legacy groups) does count.
 */
export function leafTextIndex(visible: readonly Element[], textCache: ReadonlyMap<Element, string>, climb: boolean): (t: string) => boolean {
  const m = new Map<string, Set<Element>>();
  for (const el of visible) {
    const t = textCache.get(el) || '';
    if (!t || t.length > ANCHOR_TEXT_MAX || !HAS_WORD_RE.test(directText(el))) continue;
    const key = t.toLowerCase();
    let set = m.get(key);
    if (!set) {
      set = new Set();
      m.set(key, set);
    }
    set.add(climb ? closestClickable(el) || el : el);
  }
  return (t: string): boolean => !!t && m.get(t.toLowerCase())?.size === 1;
}

/** One selected text leaf and its cap priority (0 kept first). */
export interface TextLeaf {
  el: Element;
  priority: number;
}

function hasAncestorIn(el: Element, set: ReadonlySet<Element>): boolean {
  for (let p = el.parentElement; p; p = p.parentElement) if (set.has(p)) return true;
  return false;
}

function nearestAncestorIn(el: Element, set: ReadonlySet<Element>): Element | undefined {
  for (let p = el.parentElement; p; p = p.parentElement) if (set.has(p)) return p;
  return undefined;
}

/**
 * True when a person can actually see `el`'s text, beyond what isVisible checks (display,
 * visibility, a non-empty box): not transparent (`opacity: 0` on it or an ancestor), not inside an
 * `aria-hidden="true"` subtree, more than 1px in each direction (screen-reader-only text), and not
 * placed off the page's top or left edge (`left: -9999px`), where no scrolling reaches it.
 */
function isPerceivable(el: Element, r: Rect): boolean {
  if (r.w <= 1 || r.h <= 1) return false;
  const docX = r.x + (window.scrollX || 0);
  const docY = r.y + (window.scrollY || 0);
  if (docX + r.w <= 0 || docY + r.h <= 0) return false;
  if (el.closest && el.closest('[aria-hidden="true"]')) return false;
  if (typeof el.checkVisibility === 'function') {
    if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
  } else {
    for (let p: Element | null = el; p; p = p.parentElement) {
      if (parseFloat(window.getComputedStyle(p).opacity) === 0) return false;
    }
  }
  return true;
}

/**
 * Elements whose text is a listed control's label, so listing them again would repeat the
 * control's name: every `aria-labelledby` target, every associated <label>, and the legacy
 * adjacent cell (the nearest preceding cell with text in the control's row, the same walk
 * naming.ts adjacentCellLabelInfo does).
 */
function labelSources(interactiveSet: ReadonlySet<Element>): Set<Element> {
  const out = new Set<Element>();
  for (const el of interactiveSet) {
    for (const id of attr(el, 'aria-labelledby').split(/\s+/)) {
      const n = id ? document.getElementById(id) : null;
      if (n) out.add(n);
    }
    const tag = tagOf(el);
    if (tag !== 'input' && tag !== 'select' && tag !== 'textarea') continue;
    const labels = (el as HTMLInputElement).labels;
    if (labels) for (let i = 0; i < labels.length; i++) out.add(labels[i]!);
    const cell = el.closest ? el.closest('td,th') : null;
    for (let prev = cell ? cell.previousElementSibling : null; prev; prev = prev.previousElementSibling) {
      const pt = tagOf(prev);
      if ((pt === 'td' || pt === 'th') && stripColon((prev as HTMLElement).innerText || prev.textContent || '')) {
        out.add(prev);
        break;
      }
    }
  }
  return out;
}

function isMessageRegion(el: Element): boolean {
  return !!(el.closest && el.closest('[role=alert],[role=status],[aria-live]:not([aria-live=off])'));
}

/** Ancestors at 1..3 levels of every interactive element (excluding body/html): "near a control". */
function nearControlAncestors(interactiveSet: ReadonlySet<Element>): Set<Element> {
  const out = new Set<Element>();
  for (const el of interactiveSet) {
    let p = el.parentElement;
    for (let d = 0; d < 3 && p; d++, p = p.parentElement) {
      const t = tagOf(p);
      if (t === 'body' || t === 'html') break;
      out.add(p);
    }
  }
  return out;
}

/**
 * The visible text leaves of this document that no interactive or legacy rule already covers, in
 * document order, each with its cap priority. See the module header for every rule.
 */
export function selectTextLeaves(c: LeafContext): TextLeaf[] {
  const out: TextLeaf[] = [];
  const taken = new Set<Element>();
  const near = nearControlAncestors(c.interactiveSet);
  const labels = labelSources(c.interactiveSet);
  for (const el of c.visible) {
    if (c.interactiveSet.has(el) || c.legacySet.has(el)) continue;
    const tag = tagOf(el);
    if (NON_TEXT_TAGS.has(tag)) continue;
    if (!HAS_WORD_RE.test(directText(el))) continue;
    const t = c.textCache.get(el) || '';
    if (!t || t.length > TEXT_LEAF_MAX) continue;
    if (isNestedInteractive(el)) continue; // part of a control's name
    // Inside a legacy element: part of that element's name -- unless the name, capped at 80
    // characters, cannot show all of it; then the legacy element counts as this leaf's sentence
    // (class-less inline text is absorbed, a marked-up value is listed).
    const legacyAncestor = nearestAncestorIn(el, c.legacySet);
    if (legacyAncestor && (c.textCache.get(legacyAncestor) || '').length <= ANCHOR_TEXT_MAX) continue;
    if (labels.has(el) || hasAncestorIn(el, labels)) continue; // a listed control's label: its name
    if (!isPerceivable(el, c.rect(el))) continue; // transparent, aria-hidden, sr-only or off-page
    const parent = el.parentElement;
    const parentIsSentence = !!parent && (taken.has(parent) || parent === legacyAncestor);
    if (parentIsSentence && INLINE_TAGS.has(tag) && !attr(el, 'id') && stableClasses(el).length === 0) {
      taken.add(el); // absorbed: part of the parent's sentence; children of it are absorbed too
      continue;
    }
    taken.add(el);
    let priority: number;
    if (isMessageRegion(el) || (t.length <= VALUE_LIKE_MAX && HAS_DIGIT_RE.test(t))) priority = 0;
    else if (t.length <= ANCHOR_TEXT_MAX) {
      let isNear = false;
      let p = el.parentElement;
      for (let d = 0; d < 3 && p && !isNear; d++, p = p.parentElement) isNear = near.has(p);
      priority = isNear ? 1 : 2;
    } else priority = 3;
    out.push({ el, priority });
  }
  // `taken` also holds absorbed inline children: keep only the selected leaves.
  return out;
}

// -------------------------------------------------------------------------------------------
// Container anchors.
// -------------------------------------------------------------------------------------------

function xOverlap(a: Rect, b: Rect): boolean {
  return b.x < a.x + a.w && b.x + b.w > a.x;
}

function inRowBand(anchor: Rect, cand: Rect): boolean {
  const cy = cand.y + cand.h / 2;
  return cy >= anchor.y && cy <= anchor.y + anchor.h;
}

/** Same predicates as the driver's relative resolver (adapter-playwright resolve.ts satisfiesRelation). */
function satisfies(rel: ContainerAnchor['relation'], a: Rect, c: Rect): boolean {
  switch (rel) {
    case 'right-of':
      return inRowBand(a, c) && c.x >= a.x + a.w - 2;
    case 'left-of':
      return inRowBand(a, c) && c.x + c.w <= a.x + 2;
    case 'below':
      return xOverlap(a, c) && c.y >= a.y + a.h - 2;
    case 'above':
      return xOverlap(a, c) && c.y + c.h <= a.y + 2;
  }
}

/** Same distance as the driver's relative resolver (resolve.ts axisDistance). */
function distance(rel: ContainerAnchor['relation'], a: Rect, c: Rect): number {
  switch (rel) {
    case 'right-of':
      return c.x - (a.x + a.w);
    case 'left-of':
      return a.x - (c.x + c.w);
    case 'below':
      return c.y - (a.y + a.h);
    case 'above':
      return a.y - (c.y + c.h);
  }
}

/** What the driver's relative resolver filters candidates by. */
interface CandidateFilter {
  tag: string;
  role: string | undefined;
  selector: string;
  /** The anchor's container (`anchor.closest(within)`): only its descendants are candidates. */
  container: Element;
  /** The container's selector; a candidate whose nearest match is another (nested) container is
   *  not a candidate. '' for no container bound. */
  within: string;
}

/**
 * True when the driver's relative resolver, given `anchor`, `rel` and `f`, would pick exactly
 * `target`: the same candidate set (visible, not the anchor or an ancestor of it, matching tag,
 * role and selector), the same ancestor/descendant collapse (the actionable or else the innermost
 * element of a contained pair wins), nearest along the relation's axis, and a miss on a tie within
 * 1px. The filters commute, so the cheap geometric one runs first over the whole pool, and the
 * candidate checks and the collapse run lazily, nearest first, until two survivors decide it.
 */
function resolvesTo(target: Element, anchor: Element, rel: ContainerAnchor['relation'], f: CandidateFilter, c: LeafContext, byTag: Map<string, Element[]>): boolean {
  const isCand = (x: Element): boolean =>
    c.visibleSet.has(x) &&
    x !== anchor &&
    !x.contains(anchor) &&
    x !== f.container &&
    f.container.contains(x) &&
    (!f.within || x.closest(f.within) === f.container) &&
    tagOf(x) === f.tag &&
    (f.role === undefined || inferRole(x).role === f.role) &&
    (!f.selector || safeMatches(x, f.selector));
  const ar = c.rect(anchor);
  const scored: { x: Element; d: number }[] = [];
  for (const x of candidatePool(f, byTag)) {
    if (!c.visibleSet.has(x) || !f.container.contains(x)) continue;
    const xr = c.rect(x);
    if (satisfies(rel, ar, xr)) scored.push({ x, d: distance(rel, ar, xr) });
  }
  scored.sort((p, q) => p.d - q.d);
  const dominated = (x: Element): boolean => {
    const xSelf = closestClickable(x) === x;
    for (let p = x.parentElement; p; p = p.parentElement) {
      if (isCand(p) && closestClickable(p) === p && !xSelf) return true;
    }
    const kids = x.getElementsByTagName(f.tag);
    for (let i = 0; i < kids.length; i++) {
      const k = kids[i]!;
      if (!isCand(k)) continue;
      if (!(xSelf && closestClickable(k) !== k)) return true;
    }
    return false;
  };
  if (f.within) {
    // Container-bounded (the resolver's within rule): the element must be a candidate inside the
    // anchor's own container, and the resolver takes it only when it is the ONLY one there. When
    // it is not (a struck-through list price above the sale price), the anchor is still emitted:
    // it tells the recorder the element belongs to the anchor's record, the resolver misses on it,
    // and record-time verification then refuses to record the target -- rather than the element
    // falling back to a positional locator for want of any anchor.
    const inContainer: Element[] = [];
    for (const x of candidatePool(f, byTag)) if (isCand(x) && !dominated(x)) inContainer.push(x);
    if (!inContainer.includes(target)) return false;
    return inContainer.length > 1 || satisfies(rel, ar, c.rect(target));
  }
  const kept: { x: Element; d: number }[] = [];
  for (const s of scored) {
    if (!isCand(s.x) || dominated(s.x)) continue;
    kept.push(s);
    if (kept.length === 2) break;
  }
  const best = kept[0];
  if (!best || best.x !== target) return false;
  const next = kept[1];
  return !(next && Math.abs(next.d - best.d) <= 1);
}

/**
 * True for a short text that reads as a value rather than a name: at most VALUE_LIKE_MAX
 * characters, and at least half of its letters and digits are digits ("$29.99", "Sep 30, 2026",
 * "Order 12345"; not "Product A0 item" or "Model 3 Charger").
 */
function isNumericText(text: string): boolean {
  if (text.length > VALUE_LIKE_MAX) return false;
  const alnum = text.match(/[\p{L}\p{N}]/gu) || [];
  const digits = text.match(/\p{N}/gu) || [];
  return digits.length > 0 && digits.length * 2 >= alnum.length;
}

/** Candidates the resolver's filter could keep, before the per-element checks: every visible
 *  element of the tag, or, with a selector, only what the selector matches (cached per
 *  enumeration, keyed on its `byTag` map). */
const selectorPools = new WeakMap<Map<string, Element[]>, Map<string, Element[]>>();
function candidatePool(f: CandidateFilter, byTag: Map<string, Element[]>): readonly Element[] {
  if (!f.selector) return byTag.get(f.tag) || [];
  let cache = selectorPools.get(byTag);
  if (!cache) {
    cache = new Map();
    selectorPools.set(byTag, cache);
  }
  let pool = cache.get(f.selector);
  if (!pool) {
    try {
      pool = Array.from(document.querySelectorAll(f.selector));
    } catch {
      pool = [];
    }
    cache.set(f.selector, pool);
  }
  return pool;
}

/** Lower is preferred: heading, then a link's text, then anything else; value-like texts last. */
function anchorRank(el: Element, text: string): number {
  let r = 2;
  if (el.closest && el.closest('h1,h2,h3,h4,h5,h6,[role=heading]')) r = 0;
  else if (el.closest && el.closest('a[href]')) r = 1;
  if (isNumericText(text)) r += 3;
  return r;
}

/** Groups visible elements by tag, for the resolver simulation. Built once per enumerate(). */
export function visibleByTag(visible: readonly Element[]): Map<string, Element[]> {
  const m = new Map<string, Element[]>();
  for (const el of visible) {
    const t = tagOf(el);
    let list = m.get(t);
    if (!list) {
      list = [];
      m.set(t, list);
    }
    list.push(el);
  }
  return m;
}

/**
 * The 'below' anchor for a text leaf: the nearest text directly above (gap 0..60px, overlapping
 * horizontally, the legacy rule), restricted to elements that render the text themselves and are
 * unique in the document, and kept only when a tag-only relative locator from it picks `el` back
 * out. '' otherwise. The legacy elements keep the unverified rule (enumerate.ts findAboveAnchor):
 * their recorded chains depend on it.
 */
export function verifiedAboveAnchor(el: Element, role: string | undefined, c: LeafContext, byTag: Map<string, Element[]>): string {
  const er = c.rect(el);
  let best: Element | undefined;
  let bestGap = Infinity;
  for (const cand of c.anchorCandidates) {
    if (cand === el || cand.contains(el) || el.contains(cand)) continue;
    const cr = c.rect(cand);
    const gap = er.y - (cr.y + cr.h);
    if (gap < 0 || gap > 60 || !xOverlap(cr, er)) continue;
    if (gap < bestGap) {
      bestGap = gap;
      best = cand;
    }
  }
  if (!best || !HAS_WORD_RE.test(directText(best))) return '';
  const text = c.textCache.get(best) || '';
  if (!text || text.length > ANCHOR_TEXT_MAX || !c.isUniqueAnchorText(text)) return '';
  return resolvesTo(el, best, 'below', { tag: tagOf(el), role, selector: '', container: document.documentElement, within: '' }, c, byTag) ? text : '';
}

/**
 * Anchors from `el`'s container (see the module header): up to CONTAINER_ANCHORS_MAX, each one
 * verified to pick `el` back out through a relative locator with the returned relation and the
 * candidate filter (`el`'s tag, `role` when given, the returned selector) and the returned
 * `within`, the container's own stable class selector. Only candidates inside the anchor's nearest
 * ancestor matching `within` count, which is what keeps a record without the element (a sold-out
 * card with no price) from yielding its neighbour's. A level whose container has no stable class
 * selector, or one the anchor does not climb back to as its nearest match, yields no anchor: the
 * climb goes on. Empty when no container within reach has a usable anchor.
 */
export function containerAnchors(el: Element, role: string | undefined, c: LeafContext, byTag: Map<string, Element[]>): ContainerAnchor[] {
  const tag = tagOf(el);
  const ownText = c.textCache.get(el) || '';
  // A selector over the field cap could not be emitted intact; the tag-only filter (verified on its own) is used instead.
  const fullSelector = classSelector(el, ownText);
  const selector = fullSelector.length <= MAX_STRING ? fullSelector : '';
  const verify = (a: Element, text: string, container: Element, within: string): ContainerAnchor | undefined => {
    const ar = c.rect(a);
    const er = c.rect(el);
    const filters: CandidateFilter[] = selector
      ? [{ tag, role, selector, container, within }, { tag, role, selector: '', container, within }]
      : [{ tag, role, selector: '', container, within }];
    for (const rel of RELATIONS) {
      if (!satisfies(rel, ar, er)) continue;
      for (const f of filters) if (resolvesTo(el, a, rel, f, c, byTag)) return { text, relation: rel, selector: f.selector, within };
    }
    return undefined;
  };
  // Value-like anchors (a sibling price next to a button) are kept but do not end the climb: they
  // are record data, not the record's name, and go after the named anchors found further up.
  const valueLike: ContainerAnchor[] = [];
  const used = new Set<string>();
  let anc = el.parentElement;
  for (let depth = 0; anc && depth < CONTAINER_MAX_DEPTH; depth++, anc = anc.parentElement) {
    const at = tagOf(anc);
    if (at === 'body' || at === 'html') break;
    const all = anc.getElementsByTagName('*');
    if (all.length > CONTAINER_MAX_ELEMENTS) break;
    if (stableClasses(anc).length === 0) continue; // no stable container selector at this level
    const found: { a: Element; text: string; rank: number; order: number }[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < all.length; i++) {
      const a = all[i]!;
      if (!c.anchorCandidates.has(a) || a === el || el.contains(a) || a.contains(el)) continue;
      // An anchor renders its text itself: a wrapper whose innerText merely concatenates its
      // children ("Name Description") is not something a person reads as one label.
      if (!HAS_WORD_RE.test(directText(a))) continue;
      const text = c.textCache.get(a) || '';
      if (!text || text.length > ANCHOR_TEXT_MAX || text === ownText || seen.has(text) || used.has(text) || !c.isUniqueAnchorText(text)) continue;
      seen.add(text);
      found.push({ a, text, rank: anchorRank(a, text), order: i });
    }
    found.sort((p, q) => p.rank - q.rank || p.order - q.order);
    const named: ContainerAnchor[] = [];
    for (const cand of found) {
      const isValue = cand.rank >= 3;
      if ((isValue ? valueLike.length : named.length) >= CONTAINER_ANCHORS_MAX) continue;
      // The container's selector, without a class slugged from this anchor's or the element's own
      // text (`order-alpha` would only ever match ALPHA's card), and the anchor must climb back to
      // this very container as its nearest match.
      const within = ownClassSelector(anc, [cand.text, ownText]);
      if (!within || within.length > MAX_STRING || !cand.a.closest || cand.a.closest(within) !== anc) continue;
      const picked = verify(cand.a, cand.text, anc, within);
      if (picked) {
        used.add(cand.text);
        (isValue ? valueLike : named).push(picked);
      }
    }
    if (named.length > 0) return [...named, ...valueLike].slice(0, CONTAINER_ANCHORS_MAX);
  }
  return valueLike.slice(0, CONTAINER_ANCHORS_MAX);
}

// -------------------------------------------------------------------------------------------
// Row labels and record context (for the recorder's record-membership decision).
// -------------------------------------------------------------------------------------------

function cellText(cell: Element): string {
  return collapse((cell as HTMLElement).innerText || cell.textContent || '');
}

/** The cell the legacy row anchor comes from: the nearest preceding cell with text in the
 *  element's row (the same walk as naming.ts adjacentCellLabelInfo), or null. */
function adjacentAnchorCell(el: Element): Element | null {
  const cell = el.closest ? el.closest('td,th') : null;
  for (let prev = cell ? cell.previousElementSibling : null; prev; prev = prev.previousElementSibling) {
    const pt = tagOf(prev);
    if ((pt === 'td' || pt === 'th') && stripColon(cellText(prev))) return prev;
  }
  return null;
}

/**
 * True when the adjacent cell a row anchor comes from reads as the element's LABEL rather than as
 * the previous column's value: a `<th>`, a cell holding a `<label>`, text ending in a colon, a row
 * of at most two cells with text (a label/value row), or text identical in every row of that
 * column (a header-like constant). A cell of a row with three or more data cells is a value: in a
 * people list, the cell left of "View" is someone's e-mail address, and anchoring on it would both
 * persist that record's data and find the recorded person for any input.
 */
export function rowAnchorIsLabel(el: Element): boolean {
  const a = adjacentAnchorCell(el);
  if (!a) return false;
  if (tagOf(a) === 'th' || a.querySelector('label')) return true;
  const raw = cellText(a);
  if (/:\s*$/.test(raw)) return true;
  const row = a.parentElement;
  if (!row) return false;
  const cells = Array.from(row.children).filter((c) => (tagOf(c) === 'td' || tagOf(c) === 'th') && cellText(c) !== '');
  if (cells.length <= 2) return true;
  const col = Array.from(row.children).indexOf(a);
  const table = row.closest('table');
  if (!table || col < 0) return false;
  const texts: string[] = [];
  for (const r of Array.from(table.querySelectorAll('tr'))) {
    if (r.closest('table') !== table) continue;
    const c = r.children[col];
    if (c && (tagOf(c) === 'td' || tagOf(c) === 'th')) texts.push(cellText(c));
  }
  return texts.length >= 2 && texts.every((t) => t === raw);
}

/** A row cell's text and where it sits relative to the element (the element is right-of it when
 *  the cell is to its left). */
export interface RowCell {
  text: string;
  relation: 'right-of' | 'left-of';
  /** The cell's tag (`td`/`th`) and index among its row's children: its column. */
  tag: string;
  index: number;
  /** Text every cell of this column shares (see {@link columnAffixes}); absent when none or unknown. */
  shared?: ColumnAffixes;
}

/**
 * The static text around a column's values: the longest prefix and suffix every non-empty data
 * cell of the column shares ("Order " in "Order 2001", "Order 3005", "Order 4000"), cut back to a
 * word boundary, holding no digit. Only for a column of at least three data cells, so it is text the
 * page repeats for every record, not one record's data.
 */
export interface ColumnAffixes {
  prefix: string;
  suffix: string;
}

/** Fewest data cells a column needs before its shared affixes count as static text. */
const AFFIX_MIN_CELLS = 3;

/** Longest common prefix of `texts`. */
function commonPrefix(texts: readonly string[]): string {
  let p = texts[0] ?? '';
  for (const t of texts) {
    let i = 0;
    while (i < p.length && i < t.length && p[i] === t[i]) i++;
    p = p.slice(0, i);
    if (p === '') break;
  }
  return p;
}

const AFFIX_WORD_RE = /[\p{L}\p{N}]/u;

/** The shared affixes of column `index` in the table section holding `tr` (see {@link ColumnAffixes}). */
function columnAffixes(tr: Element, index: number, c: LeafContext): ColumnAffixes | null {
  const section = tr.parentElement;
  if (!section) return null;
  const cache = c.columnCache ?? (c.columnCache = new Map());
  let bySection = cache.get(section);
  if (!bySection) cache.set(section, (bySection = new Map()));
  const hit = bySection.get(index);
  if (hit !== undefined) return hit;
  const texts: string[] = [];
  for (const row of Array.from(section.children)) {
    if (texts.length > 200) break;
    const cell = row.children[index];
    if (!cell || tagOf(cell) !== 'td') continue;
    const t = cellText(cell);
    if (t) texts.push(t);
  }
  let out: ColumnAffixes | null = null;
  if (texts.length >= AFFIX_MIN_CELLS) {
    // Cut back to a word boundary: the prefix ends with a non-word character, the suffix starts with one.
    let prefix = commonPrefix(texts);
    while (prefix !== '' && AFFIX_WORD_RE.test(prefix[prefix.length - 1]!)) prefix = prefix.slice(0, -1);
    let suffix = commonPrefix(texts.map((t) => Array.from(t).reverse().join(''))).split('').reverse().join('');
    while (suffix !== '' && AFFIX_WORD_RE.test(suffix[0]!)) suffix = suffix.slice(1);
    if (/\d/.test(prefix)) prefix = '';
    if (/\d/.test(suffix)) suffix = '';
    if (prefix.trim() !== '' || suffix.trim() !== '') out = { prefix, suffix };
  }
  bySection.set(index, out);
  return out;
}

/** What the recorder needs to decide whether an element belongs to the record a run input names
 *  (see types.ts RecordContext). */
export interface RecordContextData {
  ownText: string;
  rowCells: RowCell[];
  cell: { tag: string; index: number } | null;
  containerText: string;
}

/** Largest subtree, in elements, still read as one record's container for `containerText`. */
const RECORD_CONTAINER_MAX_ELEMENTS = 60;

/**
 * The element's own text, its table row's other cells, its own cell's column, and the text of
 * the smallest ancestor that groups it with at least two other text blocks (a card, a list item;
 * at most RECORD_CONTAINER_MAX_ELEMENTS elements, so never the page). Strings capped at MAX_STRING.
 */
export function recordContextOf(el: Element, c: LeafContext): RecordContextData {
  const ownText = (c.textCache.get(el) || '').slice(0, MAX_STRING);
  const rowCells: RowCell[] = [];
  let cell: { tag: string; index: number } | null = null;
  const tr = tagOf(el) === 'tr' ? el : el.closest ? el.closest('tr') : null;
  if (tr) {
    const own = tagOf(el) === 'tr' ? null : el.closest('td,th');
    if (own && own.parentElement === tr) cell = { tag: tagOf(own), index: Array.from(tr.children).indexOf(own) };
    const er = c.rect(el);
    const cells = Array.from(tr.children);
    for (let index = 0; index < cells.length; index++) {
      const td = cells[index]!;
      if (rowCells.length >= 12) break;
      if (td === own || (tagOf(td) !== 'td' && tagOf(td) !== 'th') || td.contains(el)) continue;
      const text = cellText(td).slice(0, MAX_STRING);
      if (!text) continue;
      const r = c.rect(td);
      const relation = r.x + r.w <= er.x + 2 ? 'right-of' : r.x >= er.x + er.w - 2 ? 'left-of' : undefined;
      if (!relation) continue;
      const shared = tagOf(td) === 'td' ? columnAffixes(tr, index, c) : null;
      rowCells.push({ text, relation, tag: tagOf(td), index, ...(shared ? { shared } : {}) });
    }
  }
  let containerText = '';
  let anc = el.parentElement;
  for (let depth = 0; anc && depth < 6; depth++, anc = anc.parentElement) {
    const t = tagOf(anc);
    if (t === 'body' || t === 'html') break;
    if (anc.getElementsByTagName('*').length > RECORD_CONTAINER_MAX_ELEMENTS) break;
    let leaves = 0;
    const all = anc.getElementsByTagName('*');
    for (let i = 0; i < all.length && leaves < 3; i++) {
      const x = all[i]!;
      if (x !== el && !el.contains(x) && !x.contains(el) && c.anchorCandidates.has(x) && HAS_WORD_RE.test(directText(x))) leaves++;
    }
    if (leaves >= 2) {
      containerText = (c.textCache.get(anc) || collapse((anc as HTMLElement).innerText || '')).slice(0, MAX_STRING);
      break;
    }
  }
  return { ownText, rowCells, cell, containerText };
}

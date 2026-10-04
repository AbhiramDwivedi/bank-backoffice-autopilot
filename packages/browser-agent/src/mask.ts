/**
 * Screen-mask planning, in the page: decides what a driver must paint over before a screenshot
 * (and blank in a DOM snapshot), and reports the hidden text so the driver hides the same content
 * in its text channel. The driver owns policy and run values; this module only applies the rules it
 * is given to the document it runs in. It never inserts anything into the page (the package's
 * static scan pins that): its only writes are its mark attributes.
 *
 * Pixels are redacted in CSS: the driver captures with a stylesheet (Playwright's screenshot
 * `style`) keyed on this plan's nonce attributes, which makes marked content transparent and hides
 * everything inside it. The browser lays the redaction out and paints it together with the content,
 * in the same frame, so nothing a script does between a measurement and the pixels can separate
 * the two. What gets marked:
 *  - an element hidden by a rule: `attr="<nonce>"` plus `data-cu-mask-kind="<rule>"`; the text
 *    channel replaces its text, value and (unless it is a field) name;
 *  - a hidden text RANGE (an SSN inside a sentence, a value split across spans, the value after
 *    "Address:" in the same cell): its PAINT HOST, `data-cu-mask-paint="<nonce>"`, the innermost
 *    element holding the whole range. Pixels over-mask the rest of that element (the label in the
 *    same cell, the rest of the paragraph); the text channel stays precise
 *    (`Address: [MASKED:address]`). Paint hosts carry no kind: the text channel never treats them
 *    as hidden elements.
 * `maskSheetCheck` answers, before a capture, whether that stylesheet actually wins on every marked
 * element (a page's inline `!important` or `@layer` rule can out-rank it); the driver takes no
 * screenshot when it does not.
 *
 * Text is matched per block, never per text node: the text nodes under one block element (a cell,
 * a paragraph, a list item...) are concatenated, whitespace-collapsed, with `<br>` as a line break,
 * and a match maps back to a DOM Range across however many nodes it spans.
 *
 * Rules, in order:
 *  - selectors: every element matching one of `selectors`;
 *  - inputs: with `maskInputs: 'all'`, every text-like input, textarea, select and contenteditable
 *    region, EMPTY OR NOT, so a value that appears after the plan (a script filling the field, a
 *    human typing during a handoff) is already under a mask; with `'typed'`, none here (the driver
 *    marks what it typed into). A password field is always hidden by the driver's own selector;
 *  - labels, the value associated with a label matching one of `labels`: a form control's label
 *    (`labelFor`, its title or placeholder) and an `<output>`'s; a table cell whose
 *    `adjacentCellLabel` matches; the cells under a matching header cell (any header row, rowspan
 *    and colspan mapped on the table grid); the `<dd>`s after a `<dt>`; the content after a
 *    bold/strong/label caption up to the next line break, block or caption; and, anywhere in a line
 *    of a block, the value after `Label:` when the words right before the colon match
 *    (`<td>Address: 1 Main St</td>`, `... payment plan. Address: 1 Main St`), up to the next
 *    `Word:` or the end of the line. A value carried only by an `alt`, `aria-label` or `title`
 *    counts as the cell's content, and the same "Label: value" rule runs over those attributes;
 *  - text patterns: every match of `textPatterns` in a block's text;
 *  - propagation: every other occurrence of hidden text (3+ characters) in a block's text. Field
 *    values are not propagated (a typed search key is echoed all over a results page).
 * A range inside an interactive control marks the whole control, so the driver can still replace
 * only the matched text in the control's name ("Delete [MASKED:member]").
 * Rules run over the whole document, visible or not: a hidden tab's content is in a DOM snapshot,
 * and its marks are in place when a script shows it.
 *
 * What the driver must not send to a page (secrets, sensitive inputs, values typed elsewhere) it
 * compares itself: the result lists every block's text left visible and every field's value, and
 * `maskMark` hides the ranges and fields that matched.
 *
 * Change detection, for what CSS cannot cover (content that appears unmarked after the plan): a
 * MutationObserver, constructed from the global captured when this bundle first ran, counts node and
 * text changes, `value`/`alt` changes, and `style` changes inside marked content, since the agent's
 * first plan in this document; a content fingerprint compares the same content with DOM reads alone.
 * `maskVerify` after a capture answers whether the document changed and every mark is in place.
 *
 * An invalid selector or regex is an error, not a skipped rule: the result's `errors` is non-empty
 * and the driver must treat the plan as failed (fail closed).
 */
import { adjacentCellLabel, attr, collapse, labelFor, stripColon, tagOf } from './naming.js';
import { MASK_KIND_ATTR, MASK_PAINT_ATTR } from './constants.js';
import type { MaskedText, MaskMarkResult, MaskPlanOptions, MaskPlanResult, MaskRange } from './types.js';

/** Inner texts and field values reported back are cut to this length. */
const MAX_TEXT = 2000;
/** A hidden element's whole text is reported up to this length. */
const MAX_WHOLE_TEXT = 20000;
/** At most this many blocks and fields are reported; beyond it the result says `truncated`. */
const MAX_CANDIDATES = 200000;
/** Plans kept for `maskMark`/`maskVerify`/`maskClear`; older ones are cleared first. */
const MAX_PLANS = 4;
/** Hidden texts shorter than this are not propagated (a two-letter state code is everywhere). */
const MIN_PROPAGATE = 3;
/** A neighbouring cell longer than twice this is prose, not a label. */
const MAX_INLINE_LABEL = 40;
/** At most this many words right before a colon are tried as a label ("Mailing address:"). */
const MAX_LABEL_WORDS = 5;
/** Label separators besides `:`: FULLWIDTH COLON (U+FF1A) and SMALL COLON (U+FE55). */
const FULL_WIDTH_COLONS = '\uFF1A\uFE55';
/** Marks the stylesheet a driver captures with; the text after it is the plan's nonce. */
const SHEET_MARKER = '/*cu-mask:';

/** One block's text, with each character's source text node and offset (`null` for a `<br>` line break). */
interface Block {
  el: Element;
  text: string;
  map: ({ node: Text; off: number } | null)[];
}

interface PlanState {
  attr: string;
  nonce: string;
  blocks: Block[];
  fields: Element[];
  marked: Element[];
  /** Block elements holding a hidden text range. */
  rangeHosts: Element[];
  /** Every hidden text range, for `maskClone`. */
  ranges: { range: Range; kind: string }[];
  /** Paint hosts of hidden ranges (`MASK_PAINT_ATTR`). */
  painted: Element[];
  /** `contentFingerprint()` when the plan finished. */
  fingerprint: string;
  mutations: number;
}

const plans = new Map<string, PlanState>();

// --- change detection ----------------------------------------------------------------------

let mutationCount = 0;
let observer: MutationObserver | undefined;
/**
 * The observer constructor and methods as they were when this bundle first ran (a driver injects it
 * before page scripts), called through a captured `Reflect.apply`: a page that later replaces
 * `window.MutationObserver` or patches its prototype does not reach the agent's observer. A frame
 * the agent reaches only after its scripts ran gets whatever they left: that is why `maskVerify`
 * also compares a content fingerprint, which uses no page-replaceable API.
 */
const NativeMutationObserver: typeof MutationObserver | undefined = typeof MutationObserver === 'undefined' ? undefined : MutationObserver;
const nativeObserve = NativeMutationObserver ? NativeMutationObserver.prototype.observe : undefined;
const nativeTakeRecords = NativeMutationObserver ? NativeMutationObserver.prototype.takeRecords : undefined;
const applyFn = Reflect.apply;

/** True for the redaction stylesheet a driver captures with (for a plan of this document). */
function isRedactionSheet(el: Element): boolean {
  if (tagOf(el) !== 'style') return false;
  const t = el.textContent || '';
  if (!t.startsWith(SHEET_MARKER)) return false;
  const end = t.indexOf('*/');
  return end > 0 && plans.has(t.slice(SHEET_MARKER.length, end));
}

function isCaptureArtifact(n: Node): boolean {
  if (n.nodeType !== 1) return false;
  const el = n as Element;
  // The glass pane a screenshot tool adds to paint its element masks, and the redaction stylesheet.
  return tagOf(el) === 'x-pw-glass' || isRedactionSheet(el);
}

/** True when `el` is, or is inside, an element some plan marked or painted. */
function insideMask(el: Element): boolean {
  return el.closest('[' + MASK_KIND_ATTR + '],[' + MASK_PAINT_ATTR + ']') !== null;
}

/**
 * True when `n` is inside an element some plan marked whole (not a paint host). Whatever changes
 * in there is hidden anyway: the redaction stylesheet hides all of it in pixels, and a DOM snapshot
 * replaces all of it with the placeholder.
 */
function withinMarked(n: Node): boolean {
  const el = n.nodeType === 1 ? (n as Element) : n.parentElement;
  return !!el && el.closest('[' + MASK_KIND_ATTR + ']') !== null;
}

function countMutations(records: MutationRecord[]): void {
  for (const r of records) {
    if (r.type === 'childList') {
      const nodes = [...Array.from(r.addedNodes), ...Array.from(r.removedNodes)];
      if (nodes.length > 0 && nodes.every(isCaptureArtifact)) continue;
      // Nodes added or removed inside a marked element (not the element itself).
      if (withinMarked(r.target)) continue;
    }
    if (r.type === 'characterData' && withinMarked(r.target)) continue;
    if (r.type === 'attributes') {
      if (isCaptureArtifact(r.target)) continue;
      if (r.attributeName === 'style') {
        // An inline style can out-rank the redaction stylesheet, but only on marked content; a
        // ticker moving anything else must not starve capture.
        if (!(r.target.nodeType === 1 && insideMask(r.target as Element))) continue;
      } else if (withinMarked(r.target)) continue;
    }
    mutationCount++;
  }
}

function ensureObserver(): void {
  if (observer || !NativeMutationObserver) return;
  observer = new NativeMutationObserver(countMutations);
  // Text and node changes can bring content no plan saw; `value`/`alt` change rendered text; a
  // `style` change inside marked content can out-rank the redaction (filtered in countMutations).
  // Class and scroll changes cannot un-mask CSS redaction, so they are not counted.
  if (nativeObserve) {
    applyFn(nativeObserve, observer, [
      document,
      { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['value', 'alt', 'style'] },
    ]);
  }
}

/** The change count, with pending observer records counted first. */
function currentMutations(): number {
  if (observer && nativeTakeRecords) countMutations(applyFn(nativeTakeRecords, observer, []) as MutationRecord[]);
  return mutationCount;
}

/**
 * A hash of everything the plan read as content: every text node, every field's value, every
 * `alt`/`aria-label`/`title`. Uses only DOM reads (no observer), so a page that defeats the
 * observer still cannot change content between a plan and its verification unnoticed (a change
 * that is reverted before verification is the observer's job).
 */
function contentFingerprint(): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  const feed = (str: string): void => {
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
      h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
    }
    h1 = Math.imul(h1 ^ 0x1f, 0x01000193) >>> 0;
  };
  const root = document.documentElement;
  if (!root) return '';
  // A marked element's subtree is hidden whatever it holds (see withinMarked): not compared.
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode: (n) => (n.nodeType === 1 && (n as Element).hasAttribute(MASK_KIND_ATTR) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === 3) {
      const parent = n.parentElement;
      if (!parent || !isRedactionSheet(parent)) feed((n as Text).data);
      continue;
    }
    const el = n as Element;
    if (tagOf(el) === 'x-pw-glass') continue;
    if (isValueField(el)) feed('\u0000v' + fieldValue(el));
    for (const name of ['alt', 'aria-label', 'title']) {
      const v = el.getAttribute(name);
      if (v !== null) feed('\u0000' + name + v);
    }
  }
  return h1.toString(36) + '.' + h2.toString(36);
}

// --- helpers -------------------------------------------------------------------------------

/** `[a-z0-9_]` slug of a label or rule name, at most 32 chars; 'masked' when nothing is left. */
export function maskKindSlug(s: string): string {
  const slug = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32)
    .replace(/_+$/, '');
  return slug || 'masked';
}

function cut(s: string, max = MAX_TEXT): string {
  return s.length > max ? s.slice(0, max) : s;
}

/** Collapsed text of an element's direct text-node children only. */
export function ownTextNodes(el: Element): string {
  let t = '';
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 3) t += ' ' + (n as Text).data;
  }
  return collapse(t);
}

/** Rendered text when rendered, else the DOM text (a hidden tab's content). */
function textOf(el: Element): string {
  const h = el as HTMLElement;
  return collapse(h.innerText || el.textContent || '');
}

const SKIP_TAGS: Readonly<Record<string, true>> = { script: true, style: true, noscript: true, template: true, head: true, title: true, meta: true, link: true };
const NON_TEXT_INPUTS: Readonly<Record<string, true>> = {
  button: true,
  submit: true,
  reset: true,
  image: true,
  hidden: true,
  checkbox: true,
  radio: true,
  range: true,
  color: true,
  file: true,
};
/** Elements whose text is one block (text nodes under the nearest one are matched together). */
const BLOCK_TAGS: Readonly<Record<string, true>> = {
  body: true,
  p: true,
  div: true,
  table: true,
  tr: true,
  td: true,
  th: true,
  caption: true,
  ul: true,
  ol: true,
  li: true,
  dl: true,
  dt: true,
  dd: true,
  h1: true,
  h2: true,
  h3: true,
  h4: true,
  h5: true,
  h6: true,
  form: true,
  fieldset: true,
  legend: true,
  hr: true,
  section: true,
  article: true,
  header: true,
  footer: true,
  nav: true,
  main: true,
  aside: true,
  pre: true,
  blockquote: true,
  center: true,
  button: true,
  option: true,
  select: true,
  textarea: true,
  label: true,
  output: true,
};
const CAPTION_TAGS: Readonly<Record<string, true>> = { b: true, strong: true, label: true };
const INTERACTIVE_SEL = 'a[href],button,[onclick],[role=button],[role=link],[role=menuitem],[role=tab],input[type=button],input[type=submit],.btn';

/** A field whose value can be shown: text-like inputs, textareas, selects. */
function isValueField(el: Element): boolean {
  const tag = tagOf(el);
  if (tag === 'textarea' || tag === 'select') return true;
  if (tag !== 'input') return false;
  return !NON_TEXT_INPUTS[(attr(el, 'type') || 'text').toLowerCase()];
}

/** The value a field shows: an input's or textarea's value, a select's selected option text. */
function fieldValue(el: Element): string {
  const tag = tagOf(el);
  if (tag === 'select') {
    const sel = el as HTMLSelectElement;
    const opt = sel.selectedIndex >= 0 ? sel.options[sel.selectedIndex] : undefined;
    return opt ? collapse(opt.text) || sel.value : '';
  }
  return (el as HTMLInputElement | HTMLTextAreaElement).value || '';
}

/** True when `cell` is a `<th>` or its whole text is bold. */
function isHeaderCell(cell: HTMLTableCellElement, text: string): boolean {
  if (tagOf(cell) === 'th') return true;
  const b = cell.querySelector('b,strong');
  return !!b && textOf(b) === text;
}

/**
 * A column-header row: in a `<thead>`, or two or more non-empty cells that are all `<th>` or wholly
 * bold. A row pairing a header cell with a plain cell (`<th>SSN</th><td>...</td>`) is a
 * label/value row, not a header.
 */
function isHeaderRow(tr: HTMLTableRowElement): boolean {
  if (tr.parentElement && tagOf(tr.parentElement) === 'thead') return true;
  let n = 0;
  for (let i = 0; i < tr.cells.length; i++) {
    const cell = tr.cells[i]!;
    const t = textOf(cell);
    if (!t) continue;
    if (!isHeaderCell(cell, t)) return false;
    n++;
  }
  return n >= 2;
}

/** The table's grid: each row's cells with the columns they cover, rowspans and colspans applied. */
function tableGrid(table: HTMLTableElement): { row: HTMLTableRowElement; cells: { cell: HTMLTableCellElement; col: number; span: number }[] }[] {
  const occupied: Record<string, true> = {};
  const out: { row: HTMLTableRowElement; cells: { cell: HTMLTableCellElement; col: number; span: number }[] }[] = [];
  for (let r = 0; r < table.rows.length; r++) {
    const row = table.rows[r]!;
    const cells: { cell: HTMLTableCellElement; col: number; span: number }[] = [];
    let col = 0;
    for (let i = 0; i < row.cells.length; i++) {
      const cell = row.cells[i]!;
      while (occupied[`${r},${col}`]) col++;
      const span = Math.max(1, cell.colSpan || 1);
      const rows = Math.max(1, cell.rowSpan || 1);
      for (let dr = 0; dr < rows; dr++) for (let dc = 0; dc < span; dc++) occupied[`${r + dr},${col + dc}`] = true;
      cells.push({ cell, col, span });
      col += span;
    }
    out.push({ row, cells });
  }
  return out;
}

function compile(sources: string[], what: string, errors: string[], whole = false): RegExp[] {
  const out: RegExp[] = [];
  for (const s of sources) {
    try {
      new RegExp(s, 'i'); // reports the policy's own source when it is invalid
      out.push(new RegExp(whole ? '^(?:' + s + ')$' : s, 'i'));
    } catch (e) {
      errors.push(`${what} /${s}/: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return out;
}

function nearestBlock(n: Node): Element | null {
  let e: Element | null = n.parentElement;
  while (e && !BLOCK_TAGS[tagOf(e)]) e = e.parentElement;
  return e;
}

function skipped(n: Node): boolean {
  for (let e: Element | null = n.parentElement; e; e = e.parentElement) {
    if (SKIP_TAGS[tagOf(e)]) return true;
  }
  return false;
}

/** Every block's text, document order. */
function buildBlocks(): Block[] {
  const blocks = new Map<Element, Block & { space: boolean }>();
  const order: (Block & { space: boolean })[] = [];
  const root = document.body || document.documentElement;
  if (!root) return [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const isBr = n.nodeType === 1 && tagOf(n as Element) === 'br';
    if (n.nodeType !== 3 && !isBr) continue;
    if (skipped(n)) continue;
    const blockEl = nearestBlock(n) || root;
    let b = blocks.get(blockEl);
    if (!b) {
      b = { el: blockEl, text: '', map: [], space: true };
      blocks.set(blockEl, b);
      order.push(b);
    }
    if (isBr) {
      if (b.text !== '' && !b.text.endsWith('\n')) {
        if (b.text.endsWith(' ')) {
          b.text = b.text.slice(0, -1);
          b.map.pop();
        }
        b.text += '\n';
        b.map.push(null);
        b.space = true;
      }
      continue;
    }
    const node = n as Text;
    const data = node.data;
    for (let i = 0; i < data.length; i++) {
      const c = data[i]!;
      if (/\s/.test(c)) {
        if (!b.space) {
          b.text += ' ';
          b.map.push({ node, off: i });
          b.space = true;
        }
      } else {
        b.text += c;
        b.map.push({ node, off: i });
        b.space = false;
      }
    }
  }
  return order.map((b) => {
    let text = b.text;
    let map = b.map;
    while (text.endsWith(' ') || text.endsWith('\n')) {
      text = text.slice(0, -1);
      map = map.slice(0, -1);
    }
    return { el: b.el, text, map };
  });
}

/** A DOM Range for `[start, end)` of a block's text; null when it maps to no text node. */
function rangeOf(b: Block, start: number, end: number): Range | null {
  let s = start;
  while (s < end && !b.map[s]) s++;
  let e = end - 1;
  while (e >= s && !b.map[e]) e--;
  if (s > e) return null;
  const a = b.map[s]!;
  const z = b.map[e]!;
  const r = document.createRange();
  r.setStart(a.node, a.off);
  r.setEnd(z.node, z.off + 1);
  return r;
}

/** The innermost element holding the whole range: what a hidden range paints. */
function rangeHost(r: Range): Element | null {
  const c = r.commonAncestorContainer;
  return c.nodeType === 1 ? (c as Element) : c.parentElement;
}

/**
 * The value parts of every `Label: value` pair in `line` whose label matches (`labelKind`): the
 * words right before a colon (1 to MAX_LABEL_WORDS, not across a sentence end or another colon) are
 * tried shortest first, and must match a label rule whole; the value runs from after the colon to
 * the start of the next `Word:` or the end of the line. An ASCII colon followed by a non-space
 * (`10:30`, a URL) is not a label colon; the full-width colons (U+FF1A, U+FE55) always are.
 */
function labelledValues(line: string, labelKind: (t: string) => string | undefined): { start: number; end: number; kind: string }[] {
  const colons: number[] = [];
  for (let i = 1; i < line.length; i++) {
    const ch = line[i]!;
    // An ASCII colon needs a space (or the end) after it; the full-width forms never take one.
    if ((ch === ':' && (i + 1 >= line.length || /\s/.test(line[i + 1]!))) || FULL_WIDTH_COLONS.includes(ch)) colons.push(i);
  }
  const isSpace = (ch: string | undefined): boolean => ch !== undefined && /\s/.test(ch);
  /** Start of the word right before `c`. */
  const wordStart = (c: number): number => {
    let i = c;
    while (i > 0 && isSpace(line[i - 1])) i--;
    while (i > 0 && !isSpace(line[i - 1])) i--;
    return i;
  };
  const out: { start: number; end: number; kind: string }[] = [];
  colons.forEach((c, idx) => {
    let start = c;
    let kind: string | undefined;
    for (let w = 0; w < MAX_LABEL_WORDS && !kind; w++) {
      let i = start;
      while (i > 0 && isSpace(line[i - 1])) i--;
      if (i === 0) break;
      if (w > 0 && /[.;!?|:\uFF1A\uFE55\u3002]/.test(line[i - 1]!)) break; // a sentence end or another pair before it
      start = wordStart(i);
      kind = labelKind(line.slice(start, c));
    }
    if (!kind) return;
    let from = c + 1;
    while (from < line.length && isSpace(line[from])) from++;
    const next = colons[idx + 1];
    let to = next !== undefined ? wordStart(next) : line.length;
    while (to > from && (isSpace(line[to - 1]) || (next !== undefined && /[;,]/.test(line[to - 1]!)))) to--;
    if (to > from) out.push({ start: from, end: to, kind });
  });
  return out;
}

/** Texts an element carries outside its text nodes: `alt`, `aria-label`, `title` (on it and inside it). */
function attributeTexts(el: Element): string[] {
  const out: string[] = [];
  const own = [el, ...Array.from(el.querySelectorAll('[alt],[aria-label],[title]'))];
  for (const e of own) {
    for (const name of ['alt', 'aria-label', 'title']) {
      const v = collapse(attr(e, name));
      if (v) out.push(v);
    }
  }
  return out;
}

type NeedleIndex = Map<string, MaskedText[]>;

/** Needles (lower-cased, 3+ chars) by their first three characters, longest first. */
function needleIndex(needles: MaskedText[]): NeedleIndex {
  const index: NeedleIndex = new Map();
  for (const n of needles) {
    const k = n.text.slice(0, 3);
    let list = index.get(k);
    if (!list) index.set(k, (list = []));
    list.push(n);
  }
  for (const list of index.values()) list.sort((a, b) => b.text.length - a.text.length);
  return index;
}

/** Non-overlapping occurrences of indexed needles in `lower`, in one left-to-right pass. */
function scanNeedles(lower: string, index: NeedleIndex): { start: number; end: number; kind: string }[] {
  const out: { start: number; end: number; kind: string }[] = [];
  for (let i = 0; i + 3 <= lower.length; ) {
    const list = index.get(lower.slice(i, i + 3));
    const hit = list ? list.find((n) => lower.startsWith(n.text, i)) : undefined;
    if (hit) {
      out.push({ start: i, end: i + hit.text.length, kind: hit.kind });
      i += hit.text.length;
    } else {
      i++;
    }
  }
  return out;
}

// --- the plan --------------------------------------------------------------------------------

/**
 * Plans the masks for this document (see the module header) and leaves the marks in place until
 * `maskClear(attr, nonce)`. Never throws for a bad rule: it is reported in `errors`.
 */
export function maskPlan(opts: MaskPlanOptions): MaskPlanResult {
  ensureObserver();
  const errors: string[] = [];
  const texts: MaskedText[] = [];
  const marked = new Set<Element>();
  const markedList: Element[] = [];
  const rangeHosts = new Set<Element>();
  const markAttr = opts.attr;
  const nonce = opts.nonce;

  // Marks are collected first and written to the DOM at the end, so the layout reads the rules do
  // (innerText, client rects) never alternate with attribute writes.
  const markKinds = new Map<Element, string>();
  const insideMarked = (el: Element): boolean => {
    for (let e: Element | null = el; e; e = e.parentElement) if (marked.has(e)) return true;
    return false;
  };
  const setMark = (el: Element, kind: string): boolean => {
    if (marked.has(el)) return false;
    marked.add(el);
    markedList.push(el);
    markKinds.set(el, kind);
    return true;
  };
  const pendingRanges: { b: Block; start: number; end: number; kind: string }[] = [];

  /** Marks `el` and records its text (whole, and each inner element's own text as a part). */
  const mark = (el: Element, kind: string): void => {
    if (!setMark(el, kind)) return;
    if (tagOf(el) === 'select') {
      // Its rendered text lists the selected option and every alternative.
      const whole = textOf(el);
      if (whole) texts.push({ text: cut(whole, MAX_WHOLE_TEXT), kind });
      const options = el.querySelectorAll('option');
      for (let i = 0; i < options.length; i++) {
        const t = collapse(options[i]!.textContent);
        if (t) texts.push({ text: cut(t), kind, part: true });
      }
      return;
    }
    if (isValueField(el)) return; // a value is masked per element by the driver, never propagated
    const whole = textOf(el);
    if (whole) texts.push({ text: cut(whole, MAX_WHOLE_TEXT), kind });
    for (const t of attributeTexts(el)) if (t !== whole) texts.push({ text: cut(t), kind });
    const inner = el.querySelectorAll('*');
    for (let i = 0; i < inner.length; i++) {
      const own = ownTextNodes(inner[i]!);
      if (own && own !== whole) texts.push({ text: cut(own), kind, part: true });
    }
  };

  /** Hides `[start, end)` of block `b`: the whole block when it is the whole text, else a range (and any interactive control around it, whole). */
  const maskRange = (b: Block, start: number, end: number, kind: string): void => {
    const matched = b.text.slice(start, end).replace(/\n/g, ' ').trim();
    if (!matched) return;
    if (insideMarked(b.el)) return; // already inside something hidden
    if (start === 0 && end >= b.text.length && b.el !== document.body && b.el !== document.documentElement) {
      mark(b.el, kind);
      return;
    }
    const first = b.map[start];
    if (!first) return;
    texts.push({ text: cut(matched, MAX_WHOLE_TEXT), kind });
    rangeHosts.add(b.el);
    pendingRanges.push({ b, start, end, kind });
    const control = first.node.parentElement ? first.node.parentElement.closest(INTERACTIVE_SEL) : null;
    if (control) setMark(control, kind);
  };

  const all: Element[] = [];
  const nodes = document.querySelectorAll('*');
  for (let i = 0; i < nodes.length; i++) {
    const el = nodes[i]!;
    if (SKIP_TAGS[tagOf(el)]) continue;
    all.push(el);
  }

  /** A cell has content when it shows text or carries a value in `alt`/`aria-label`/`title`. */
  const hasContent = (el: Element): boolean => textOf(el) !== '' || attributeTexts(el).length > 0;

  // 1. Selectors.
  for (const s of opts.selectors) {
    let hits: NodeListOf<Element>;
    try {
      hits = document.querySelectorAll(s);
    } catch (e) {
      errors.push(`selector ${JSON.stringify(s)}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    for (let i = 0; i < hits.length; i++) mark(hits[i]!, 'selector');
  }

  // 2. Inputs: every text-holding field, empty or not, so a value that arrives after the plan is
  // already under an element mask.
  if (opts.maskInputs === 'all') {
    for (const el of all) {
      const h = el as HTMLElement;
      const editableRoot = h.isContentEditable && !(el.parentElement && (el.parentElement as HTMLElement).isContentEditable);
      if (isValueField(el) || editableRoot) mark(el, 'input');
    }
  }

  // 3. Labels.
  // A label rule must match the WHOLE label (trimmed, whitespace-collapsed, a trailing colon
  // dropped), never a substring of it: "Address book" or "Phone support hours" are not "Address" or
  // "Phone", and a label cell that carries data ("SSN 123-45-6789") is not a label at all. The kind
  // in the placeholder is the slug of that label.
  const labelRes = compile(opts.labels, 'label', errors, true);
  const labelKind = (text: string): string | undefined => {
    const t = stripColon(text).replace(/\s*[\uFF1A\uFE55]\s*$/, '');
    if (!t) return undefined;
    for (const re of labelRes) if (re.test(t)) return maskKindSlug(t);
    return undefined;
  };
  const captionNodes: { node: Text; kind: string }[] = [];
  if (labelRes.length > 0) {
    const headerRows = new Set<Element>();
    for (const el of all) {
      const tag = tagOf(el);
      if (isValueField(el)) {
        const lb = labelFor(el);
        const k = (lb ? labelKind(lb.text) : undefined) ?? labelKind(attr(el, 'title')) ?? labelKind(attr(el, 'placeholder'));
        if (k) mark(el, k);
        continue;
      }
      if (tag === 'output') {
        const labels = (el as HTMLOutputElement).labels;
        for (let i = 0; labels && i < labels.length; i++) {
          const k = labelKind(textOf(labels[i]!));
          if (k) {
            mark(el, k);
            break;
          }
        }
        continue;
      }
      if (tag === 'table') {
        // Column headers: every header row labels the rows below it, up to the next header row.
        let header: { col: number; span: number; kind: string | undefined }[] | undefined;
        for (const { row, cells } of tableGrid(el as HTMLTableElement)) {
          if (isHeaderRow(row)) {
            headerRows.add(row);
            header = cells.map((c) => ({ col: c.col, span: c.span, kind: labelKind(textOf(c.cell)) }));
            continue;
          }
          if (!header) continue;
          for (const c of cells) {
            if (!hasContent(c.cell)) continue;
            const h = header.find((x) => x.kind !== undefined && c.col < x.col + x.span && x.col < c.col + c.span);
            if (h?.kind) mark(c.cell, h.kind);
          }
        }
        continue;
      }
      if (tag === 'dt') {
        const k = labelKind(textOf(el));
        if (!k) continue;
        for (let s = el.nextElementSibling; s && tagOf(s) !== 'dt'; s = s.nextElementSibling) {
          if (tagOf(s) === 'dd') mark(s, k);
        }
        continue;
      }
      if (CAPTION_TAGS[tag]) {
        if (tag === 'label' && (el as HTMLLabelElement).control) continue; // a real <label> is handled through its control
        const k = labelKind(textOf(el));
        if (!k) continue;
        for (let n = el.nextSibling; n; n = n.nextSibling) {
          if (n.nodeType === 3) {
            const t = n as Text;
            if (!collapse(t.data)) continue;
            texts.push({ text: cut(collapse(t.data)), kind: k });
            const host = nearestBlock(t);
            if (host) rangeHosts.add(host);
            captionNodes.push({ node: t, kind: k });
            continue;
          }
          if (n.nodeType !== 1) continue;
          const t = tagOf(n as Element);
          if (t === 'br' || BLOCK_TAGS[t] || CAPTION_TAGS[t]) break;
          mark(n as Element, k);
        }
      }
    }
    // Label/value cells, outside header rows (checked after the tables collected them).
    for (const el of all) {
      const tag = tagOf(el);
      if (tag !== 'td' && tag !== 'th') continue;
      const row = el.parentElement;
      if (!row || tagOf(row) !== 'tr' || headerRows.has(row) || !hasContent(el)) continue;
      // A neighbour that is itself "Label: value" (or long prose) is not a label.
      const adjacent = adjacentCellLabel(el);
      if (/:\s*\S/.test(adjacent) || adjacent.length > MAX_INLINE_LABEL * 2) continue;
      const k = labelKind(adjacent);
      if (k) mark(el, k);
    }
  }

  const blocks = buildBlocks();

  // 3b. "Label: value" anywhere in a line of a block, and in alt / aria-label / title values.
  if (labelRes.length > 0) {
    for (const b of blocks) {
      let lineStart = 0;
      for (const line of b.text.split('\n')) {
        for (const v of labelledValues(line, labelKind)) maskRange(b, lineStart + v.start, lineStart + v.end, v.kind);
        lineStart += line.length + 1;
      }
    }
    for (const el of all) {
      if (insideMarked(el)) continue;
      for (const name of ['alt', 'aria-label', 'title']) {
        const value = collapse(attr(el, name));
        if (!value || !/[:\uFF1A\uFE55]/.test(value)) continue;
        for (const v of labelledValues(value, labelKind)) texts.push({ text: cut(value.slice(v.start, v.end)), kind: v.kind });
      }
    }
  }

  // 4. Text patterns, over each block's text.
  for (const p of opts.textPatterns) {
    let re: RegExp;
    try {
      re = new RegExp(p.regex, 'gi');
    } catch (e) {
      errors.push(`text pattern ${p.name} /${p.regex}/: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    const kind = maskKindSlug(p.name);
    for (const b of blocks) {
      re.lastIndex = 0;
      for (let m = re.exec(b.text); m; m = re.exec(b.text)) {
        if (m[0] === '') {
          re.lastIndex++;
          continue;
        }
        maskRange(b, m.index, m.index + m[0].length, kind);
      }
    }
  }

  // 5. Propagation: every other occurrence of hidden text.
  const needles: MaskedText[] = [];
  const seen = new Set<string>();
  for (const t of texts) {
    const key = t.text.toLowerCase();
    if (t.text.length >= MIN_PROPAGATE && !seen.has(key)) {
      seen.add(key);
      needles.push({ text: key, kind: t.kind });
    }
  }
  if (needles.length > 0) {
    const index = needleIndex(needles);
    for (const b of blocks) {
      if (insideMarked(b.el)) continue;
      for (const hit of scanNeedles(b.text.toLowerCase().replace(/\n/g, ' '), index)) maskRange(b, hit.start, hit.end, hit.kind);
    }
  }

  // Write the marks, then the paint hosts of the hidden ranges.
  for (const [el, kind] of markKinds) {
    el.setAttribute(markAttr, nonce);
    el.setAttribute(MASK_KIND_ATTR, kind);
  }
  const ranges: { range: Range; kind: string }[] = [];
  const paints = new Set<Element>();
  const paint = (r: Range): void => {
    const host = rangeHost(r);
    if (host && !insideMarked(host)) paints.add(host);
  };
  for (const pr of pendingRanges) {
    if (insideMarked(pr.b.el)) continue;
    const r = rangeOf(pr.b, pr.start, pr.end);
    if (!r) continue;
    ranges.push({ range: r, kind: pr.kind });
    paint(r);
  }
  for (const c of captionNodes) {
    const parent = c.node.parentElement;
    if (!parent || insideMarked(parent)) continue;
    const r = document.createRange();
    r.selectNodeContents(c.node);
    ranges.push({ range: r, kind: c.kind });
    paint(r);
  }
  const paintedList: Element[] = [];
  for (const el of paints) {
    el.setAttribute(MASK_PAINT_ATTR, nonce);
    paintedList.push(el);
  }

  // 6. What is left visible, for the driver's own comparison against values it never sends here.
  const visibleBlocks: Block[] = [];
  const fieldEls: Element[] = [];
  const fields: string[] = [];
  let truncated = false;
  for (const b of blocks) {
    if (insideMarked(b.el) || !b.text) continue;
    if (visibleBlocks.length >= MAX_CANDIDATES) {
      truncated = true;
      break;
    }
    visibleBlocks.push(b);
  }
  for (const el of all) {
    if (!isValueField(el) || insideMarked(el)) continue;
    const v = fieldValue(el);
    if (!v) continue;
    if (fieldEls.length >= MAX_CANDIDATES) {
      truncated = true;
      break;
    }
    fieldEls.push(el);
    fields.push(cut(v));
  }

  plans.set(nonce, {
    attr: markAttr,
    nonce,
    blocks: visibleBlocks,
    fields: fieldEls,
    marked: markedList,
    rangeHosts: [...rangeHosts],
    ranges,
    painted: paintedList,
    mutations: currentMutations(),
    fingerprint: contentFingerprint(),
  });
  while (plans.size > MAX_PLANS) {
    const oldest = plans.keys().next().value as string;
    maskClear(plans.get(oldest)!.attr, oldest);
  }
  return { marked: marked.size, texts, blocks: visibleBlocks.map((b) => b.text), fields, truncated, errors };
}

/**
 * Hides the block ranges and fields (indices into the last `maskPlan` result for `nonce`) the
 * driver matched against its own values. Returns what was hidden, or `null` when no plan with
 * that nonce exists here (the document was replaced): the driver must then treat the frame as unplanned.
 */
export function maskMark(nonce: string, ranges: MaskRange[], fieldIdx: number[], kind: string): MaskMarkResult | null {
  const state = plans.get(nonce);
  if (!state) return null;
  const k = maskKindSlug(kind);
  const out: MaskMarkResult = { texts: [] };
  const sel = '[' + state.attr + '="' + nonce + '"]';
  // The fingerprint skips marked subtrees, so it is taken again once these marks are in, but only
  // when nothing changed since the plan (otherwise the plan's fingerprint stands and verification fails).
  const unchanged = contentFingerprint() === state.fingerprint;
  for (const rg of ranges) {
    const b = state.blocks[rg.block];
    if (!b || !b.el.isConnected || rg.start < 0 || rg.end > b.text.length || rg.start >= rg.end) continue;
    const r = rangeOf(b, rg.start, rg.end);
    if (!r) continue;
    out.texts.push({ text: cut(b.text.slice(rg.start, rg.end).replace(/\n/g, ' ').trim(), MAX_WHOLE_TEXT), kind: k });
    state.rangeHosts.push(b.el);
    state.ranges.push({ range: r, kind: k });
    const control = r.startContainer.parentElement ? r.startContainer.parentElement.closest(INTERACTIVE_SEL) : null;
    if (control && !control.closest(sel)) {
      control.setAttribute(state.attr, nonce);
      control.setAttribute(MASK_KIND_ATTR, k);
      state.marked.push(control);
      continue;
    }
    const host = rangeHost(r);
    if (!host || host.closest(sel) || host.getAttribute(MASK_PAINT_ATTR) === nonce) continue;
    host.setAttribute(MASK_PAINT_ATTR, nonce);
    state.painted.push(host);
  }
  for (const i of fieldIdx) {
    const el = state.fields[i];
    if (!el || !el.isConnected) continue;
    el.setAttribute(state.attr, nonce);
    el.setAttribute(MASK_KIND_ATTR, k);
    state.marked.push(el);
  }
  if (unchanged) state.fingerprint = contentFingerprint();
  return out;
}

/**
 * True when the document is exactly as the `nonce` plan left it: no counted change since, and every
 * element it marked or painted still carries its mark. `null` when the plan is gone (the document
 * was replaced).
 */
export function maskVerify(nonce: string): boolean | null {
  const state = plans.get(nonce);
  if (!state) return null;
  if (currentMutations() !== state.mutations) return false;
  for (const el of state.marked) {
    if (!el.isConnected || el.getAttribute(state.attr) !== nonce) return false;
  }
  for (const el of state.painted) {
    if (!el.isConnected || el.getAttribute(MASK_PAINT_ATTR) !== nonce) return false;
  }
  return contentFingerprint() === state.fingerprint;
}

/** Elements whose own content is not text: the redaction hides them outright. */
const REPLACED_SEL = 'img,canvas,video,svg,object,embed,iframe,frame,picture,input[type=image i]';

/** True for a fully transparent computed colour (`transparent`, `rgba(..., 0)`, `color(... / 0)`). */
function isTransparent(c: string): boolean {
  return c === 'transparent' || /^rgba\((?:\s*[\d.]+\s*,){3}\s*0(?:\.0+)?\s*\)$/.test(c) || /\/\s*0(?:\.0+)?\s*\)$/.test(c);
}

/** True when nothing of `el`'s own content or its descendants can be painted under the redaction. */
function redacted(el: Element): boolean {
  const cs = getComputedStyle(el);
  if (el.matches(REPLACED_SEL)) return cs.visibility === 'hidden';
  if (!isTransparent(cs.color) || !isTransparent(cs.webkitTextFillColor) || cs.textShadow !== 'none') return false;
  if (parseFloat(cs.webkitTextStrokeWidth || '0') > 0) return false;
  for (const pseudo of ['::first-letter', '::first-line', '::placeholder']) {
    const ps = getComputedStyle(el, pseudo);
    if (!isTransparent(ps.color) || !isTransparent(ps.webkitTextFillColor)) return false;
  }
  const painted = (e: Element, pseudo: string): boolean => {
    const ps = getComputedStyle(e, pseudo);
    return ps.content !== 'none' && ps.content !== 'normal' && ps.visibility !== 'hidden';
  };
  if (painted(el, '::before') || painted(el, '::after')) return false;
  const inner = el.querySelectorAll('*');
  for (let i = 0; i < inner.length; i++) {
    const d = inner[i]!;
    if (getComputedStyle(d).visibility !== 'hidden') return false;
    if (painted(d, '::before') || painted(d, '::after')) return false;
  }
  return true;
}

/**
 * Before a capture: applies `css` (the redaction stylesheet the driver will capture with) as an
 * adopted stylesheet for a moment, and counts the elements of the `nonce` plan (marked, painted, and
 * every password field) on which it does not win: own text not transparent, a descendant not
 * hidden, a pseudo-element painted. A page's inline `!important` style or `@layer` `!important` rule
 * can out-rank it; the driver then takes no screenshot. `-1` when the stylesheet cannot be applied
 * here, `null` when the plan is gone.
 */
export function maskSheetCheck(nonce: string, css: string): number | null {
  const state = plans.get(nonce);
  if (!state) return null;
  if (typeof CSSStyleSheet !== 'function' || !('adoptedStyleSheets' in document)) return -1;
  let sheet: CSSStyleSheet;
  try {
    sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
  } catch {
    return -1;
  }
  const before = document.adoptedStyleSheets;
  document.adoptedStyleSheets = [...before, sheet];
  let losing = 0;
  try {
    const els = document.querySelectorAll('[' + state.attr + '="' + nonce + '"], [' + MASK_PAINT_ATTR + '="' + nonce + '"], input[type=password i]');
    for (let i = 0; i < els.length; i++) if (!redacted(els[i]!)) losing++;
  } finally {
    document.adoptedStyleSheets = before;
  }
  return losing;
}

/** Per element: the kind of the `nonce` mark on it or an ancestor, 'password' for a password field, else null. */
export function maskKindsOf(attrName: string, nonce: string, els: readonly Element[]): (string | null)[] {
  const sel = '[' + attrName + '="' + nonce + '"]';
  return els.map((e) => {
    const m = e.closest(sel);
    if (m) return m.getAttribute(MASK_KIND_ATTR) || 'masked';
    return e.matches('input[type=password i]') ? 'password' : null;
  });
}

/** True when `el`, an ancestor or a descendant was hidden by the `nonce` plan, or a hidden text range lies inside it. */
export function maskTouches(nonce: string, el: Element): boolean {
  const state = plans.get(nonce);
  if (!state) return false;
  const sel = '[' + state.attr + '="' + nonce + '"]';
  if (el.closest(sel) || el.querySelector(sel)) return true;
  return state.rangeHosts.some((h) => h === el || el.contains(h) || h.contains(el));
}

/**
 * A copy of the document with the `nonce` plan's masks applied, for a DOM snapshot: every marked
 * element's content is replaced by `[MASKED:<kind>]` (a select loses its `selected` option), every
 * hidden text range by the placeholder, and the marks are removed. The live
 * document is never touched. `null` when the plan is gone (the document was replaced).
 */
export function maskClone(nonce: string): Element | null {
  const state = plans.get(nonce);
  if (!state) return null;
  const live = document.documentElement;
  const copy = live.cloneNode(true) as Element;
  // Pair every live node with its copy (the clone has the same shape).
  const pairs = new Map<Node, Node>();
  const a = document.createTreeWalker(live, NodeFilter.SHOW_ALL);
  const b = document.createTreeWalker(copy, NodeFilter.SHOW_ALL);
  pairs.set(live, copy);
  for (let x = a.nextNode(), y = b.nextNode(); x && y; x = a.nextNode(), y = b.nextNode()) pairs.set(x, y);
  const ph = (kind: string): string => '[MASKED:' + maskKindSlug(kind) + ']';

  // Text ranges: per copied text node, the [from, to) offsets to hide and whether to write the placeholder there.
  const cuts = new Map<Text, { from: number; to: number; ph: string }[]>();
  const add = (node: Node, from: number, to: number, text: string): void => {
    const target = pairs.get(node);
    if (!target || target.nodeType !== 3) return;
    let list = cuts.get(target as Text);
    if (!list) cuts.set(target as Text, (list = []));
    list.push({ from, to, ph: text });
  };
  for (const { range, kind } of state.ranges) {
    const start = range.startContainer;
    const end = range.endContainer;
    if (start.nodeType !== 3 || end.nodeType !== 3) continue;
    if (start === end) {
      add(start, range.startOffset, range.endOffset, ph(kind));
      continue;
    }
    add(start, range.startOffset, (start as Text).data.length, ph(kind));
    const w = document.createTreeWalker(range.commonAncestorContainer, NodeFilter.SHOW_TEXT);
    let on = false;
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (n === start) {
        on = true;
        continue;
      }
      if (n === end) break;
      if (on) add(n, 0, (n as Text).data.length, '');
    }
    add(end, 0, range.endOffset, '');
  }
  for (const [node, list] of cuts) {
    list.sort((x, y) => x.from - y.from);
    let out = '';
    let at = 0;
    for (const c of list) {
      if (c.to <= at) continue;
      out += node.data.slice(at, Math.max(at, c.from)) + c.ph;
      at = Math.max(at, c.to);
    }
    node.data = out + node.data.slice(at);
  }

  // Marked elements: content replaced by the placeholder.
  const sel = '[' + state.attr + '="' + nonce + '"]';
  const marked = copy.querySelectorAll(sel);
  for (let i = 0; i < marked.length; i++) {
    const el = marked[i]!;
    if (el.parentElement && el.parentElement.closest(sel)) continue;
    const p = ph(el.getAttribute(MASK_KIND_ATTR) || 'masked');
    const tag = tagOf(el);
    if (tag === 'select') {
      const options = el.querySelectorAll('option');
      for (let j = 0; j < options.length; j++) {
        options[j]!.removeAttribute('selected');
        options[j]!.textContent = p;
      }
    } else if (tag !== 'input') {
      el.textContent = p;
    }
    for (const e of [el, ...Array.from(el.querySelectorAll('[alt],[aria-label],[title],[placeholder],[value]'))]) {
      for (const name of ['alt', 'aria-label', 'title', 'value']) if (e.hasAttribute(name)) e.setAttribute(name, p);
    }
  }
  const marks = copy.querySelectorAll('[' + state.attr + '], [' + MASK_KIND_ATTR + '], [' + MASK_PAINT_ATTR + ']');
  for (let i = 0; i < marks.length; i++) {
    marks[i]!.removeAttribute(state.attr);
    marks[i]!.removeAttribute(MASK_KIND_ATTR);
    marks[i]!.removeAttribute(MASK_PAINT_ATTR);
  }
  return copy;
}

/**
 * Removes every mark and paint mark carrying `nonce` under `markAttr`: the plan's own, and any a
 * driver set itself with the same attribute (elements it typed into).
 */
export function maskClear(markAttr: string, nonce: string): void {
  plans.delete(nonce);
  const els = document.querySelectorAll('[' + markAttr + '="' + nonce + '"]');
  for (let i = 0; i < els.length; i++) {
    els[i]!.removeAttribute(markAttr);
    els[i]!.removeAttribute(MASK_KIND_ATTR);
  }
  const painted = document.querySelectorAll('[' + MASK_PAINT_ATTR + '="' + nonce + '"]');
  for (let i = 0; i < painted.length; i++) painted[i]!.removeAttribute(MASK_PAINT_ATTR);
}

/** The last `maskKindOf` plan: valid while the document and the rules are unchanged. */
let kindCache: { key: string; mutations: number; kinds: Map<Element, string>; hosts: Element[]; failed: boolean } | undefined;

/**
 * The rule that would hide `el` (or an ancestor), or that hid a text range inside it: '' when none;
 * 'masked' when a rule is invalid (fail closed). Plans the document under a private nonce, then
 * caches the answer for every element until the document changes (the mutation counter) or the
 * rules do, so a policy check on every action does not re-plan an unchanged page.
 */
export function maskKindOf(el: Element, opts: Omit<MaskPlanOptions, 'nonce'>): string {
  ensureObserver();
  const key = JSON.stringify(opts);
  if (!kindCache || kindCache.key !== key || kindCache.mutations !== currentMutations()) {
    const nonce = 'k' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    try {
      const r = maskPlan({ ...opts, nonce });
      const state = plans.get(nonce)!;
      const kinds = new Map<Element, string>();
      for (const m of state.marked) kinds.set(m, m.getAttribute(MASK_KIND_ATTR) || 'masked');
      kindCache = { key, mutations: currentMutations(), kinds, hosts: state.rangeHosts, failed: r.errors.length > 0 };
    } finally {
      maskClear(opts.attr, nonce);
    }
  }
  if (kindCache.failed) return 'masked';
  for (let e: Element | null = el; e; e = e.parentElement) {
    const k = kindCache.kinds.get(e);
    if (k) return k;
  }
  for (const h of kindCache.hosts) if (h === el || el.contains(h)) return 'masked';
  return '';
}

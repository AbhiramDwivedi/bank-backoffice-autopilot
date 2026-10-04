/**
 * Interactivity and structural-selector primitives, ported near-literally from the driver's
 * legacy in-page library (see naming.ts's header for provenance). Same CLICKABLE_SEL, same
 * priority chain and same depth-10 selector-climb loop as the original.
 *
 * The only intentional deviation: `structuralSelector` returns `''` instead of a selector longer
 * than MAX_STRING (300) chars -- a selector truncated to fit a string cap would no longer be
 * valid or unique, so it is better omitted than wrong.
 */
import { MAX_STRING } from './constants.js';
import { attr, tagOf } from './naming.js';

/** Elements/attributes treated as clickable even without a native interactive tag or role. */
const CLICKABLE_SEL =
  'a[href],button,input[type=button],input[type=submit],input[type=image],input[type=reset],[onclick],.btn,[role=button],[role=link],[role=tab],[role=option],[role=menuitem],[role=checkbox],[role=radio],li[data-value],summary';

/** True when `el` is a native control, is content-editable, or matches CLICKABLE_SEL. Never
 * `<body>`/`<html>`, and a hidden `<input>` is never interactive. */
export function isInteractive(el: Element): boolean {
  if (!el || el.nodeType !== 1) return false;
  const tag = tagOf(el);
  if (tag === 'body' || tag === 'html') return false;
  if (tag === 'input') return attr(el, 'type').toLowerCase() !== 'hidden';
  if (tag === 'select' || tag === 'textarea' || tag === 'button') return true;
  if ((el as HTMLElement).isContentEditable) return true;
  return el.matches ? el.matches(CLICKABLE_SEL) : false;
}

/** `el` itself, or its closest interactive ancestor; `null` at (or above) `<body>`/`<html>`. Starts
 * from `el`'s parent when `el` itself is not an element (e.g. a text node hit by elementFromPoint
 * semantics upstream). */
export function closestClickable(el: Node | null | undefined): Element | null {
  let n: Element | null = el && el.nodeType === 1 ? (el as Element) : el ? el.parentElement : null;
  while (n && n.nodeType === 1) {
    const tag = tagOf(n);
    if (tag === 'body' || tag === 'html') return null;
    if (isInteractive(n)) return n;
    n = n.parentElement;
  }
  return null;
}

/** True when some ancestor of `el` (not `el` itself) is already interactive, e.g. a plain `<td>`
 * inside a `tr[onclick]`. */
export function isNestedInteractive(el: Element): boolean {
  let p = el.parentElement;
  while (p) {
    if (isInteractive(p)) return true;
    p = p.parentElement;
  }
  return false;
}

/** True when `id` looks framework/toolkit-generated (a long digit run, a `-`/`_`/`:`-prefixed hex
 * chunk, or a known generated-id prefix) rather than author-chosen. */
function isGeneratedId(id: string): boolean {
  return !id || /\d{3,}|[-_:][a-f0-9]{6,}|^(ext|ember|react|ng|j_id|gwt|ctl)/i.test(id);
}

/** True when `sel` matches exactly one element in this document (false, never throws, on an
 * invalid selector). */
function unique(sel: string): boolean {
  try {
    return document.querySelectorAll(sel).length === 1;
  } catch {
    return false;
  }
}

/** `[type=...]`/`[name=...]` qualifier for one element step, for form-ish tags only. */
function attrStep(n: Element): string {
  const tag = tagOf(n);
  let s = '';
  if (tag === 'input') s += '[type=' + JSON.stringify(attr(n, 'type').toLowerCase() || 'text') + ']';
  const nm = attr(n, 'name');
  if (nm && (tag === 'input' || tag === 'select' || tag === 'textarea' || tag === 'form' || tag === 'button')) {
    s += '[name=' + JSON.stringify(nm) + ']';
  }
  return s;
}

/** `tag` alone, or `tag:nth-of-type(n)` when `n` has same-tag siblings. */
function nthStep(n: Element): string {
  const tag = tagOf(n);
  const p = n.parentElement;
  if (!p) return tag;
  let sameTag = 0;
  let idx = 1;
  for (let c = p.firstElementChild; c; c = c.nextElementSibling) if (tagOf(c) === tag) sameTag++;
  if (sameTag <= 1) return tag;
  for (let d = n.previousElementSibling; d; d = d.previousElementSibling) if (tagOf(d) === tag) idx++;
  return tag + ':nth-of-type(' + idx + ')';
}

/** Unique structural CSS selector for `el` in this document, preferring (in order): its own
 * tag+attrs, a non-generated `id`, its own `nth-of-type`+attrs, then climbing ancestors (capped at
 * depth 10) prefixing `nth-of-type` steps (or `body`) until unique. `''` when none of these are
 * unique, or the found selector would exceed MAX_STRING (300) chars. */
export function structuralSelector(el: Element): string {
  const result = structuralSelectorRaw(el);
  return result.length > MAX_STRING ? '' : result;
}

function structuralSelectorRaw(el: Element): string {
  if (!el || el.nodeType !== 1) return '';
  const own = tagOf(el) + attrStep(el);
  if (unique(own)) return own;
  const id = attr(el, 'id');
  if (id && !isGeneratedId(id) && /^[A-Za-z][\w-]*$/.test(id) && unique('#' + id)) return '#' + id;
  const chain = [nthStep(el) + attrStep(el)];
  if (unique(chain[0]!)) return chain[0]!;
  let n: Element = el;
  for (let depth = 0; depth < 10 && n.parentElement; depth++) {
    const parent = n.parentElement;
    const ptag = tagOf(parent);
    if (ptag === 'html') break;
    chain.unshift(ptag === 'body' ? 'body' : nthStep(parent));
    const sel = chain.join(' > ');
    if (unique(sel)) return sel;
    n = parent;
  }
  return '';
}

/**
 * Naming primitives: whitespace collapsing, string caps, element tag/attribute reads, visibility,
 * role inference, label association and accessible-name computation.
 *
 * Ported near-literally from the adapter's former in-page library so the same naming heuristic
 * runs everywhere. The only intentional deviation from that source is `TextOptions`:
 * when `opts.valueFree` is true, a button-type input's own text comes from its `value` ATTRIBUTE
 * instead of its `.value` PROPERTY (capture always sets this, so it never reads live form state).
 * Every other function's logic, order and constants match the original exactly, including its JS
 * truthiness quirks (e.g. `max || 120` in ownText, `max && s.length > max` in trunc).
 */
import type { AccessibleName, LabelInfo, NameSource, RoleInfo, TextOptions } from './types.js';
import { MAX_STRING } from './constants.js';

/** ARIA roles real enough to be "real" in RoleInfo (mirrors REAL_ROLES in the legacy library). */
const REAL_ROLES: Readonly<Record<string, true>> = Object.freeze({
  button: true,
  link: true,
  textbox: true,
  searchbox: true,
  checkbox: true,
  radio: true,
  combobox: true,
  listbox: true,
  option: true,
  tab: true,
  tabpanel: true,
  heading: true,
  cell: true,
  row: true,
  rowheader: true,
  columnheader: true,
  table: true,
  grid: true,
  img: true,
  menuitem: true,
  switch: true,
  slider: true,
  spinbutton: true,
  progressbar: true,
  alert: true,
  dialog: true,
  list: true,
  listitem: true,
  navigation: true,
  form: true,
});

/** Whitespace-collapses and trims; `null`/`undefined` become `''`. */
export function collapse(s: unknown): string {
  return (s == null ? '' : String(s)).replace(/\s+/g, ' ').trim();
}

/** Collapses, then truncates to `max` chars. `max` falsy (0, undefined, NaN) or `Infinity` leaves
 * the string unchanged (JS truthiness / `s.length > Infinity` is always false, on purpose). */
export function trunc(s: unknown, max?: number): string {
  const collapsed = collapse(s);
  return max && collapsed.length > max ? collapsed.slice(0, max) : collapsed;
}

/** Collapses and strips a single trailing `:` (with surrounding space). */
export function stripColon(s: unknown): string {
  return collapse(s).replace(/\s*:\s*$/, '');
}

/** Lower-cased tag name, or `''` for a non-element. */
export function tagOf(el: Element | null | undefined): string {
  return el && el.tagName ? el.tagName.toLowerCase() : '';
}

/** Attribute value, or `''` when absent (never `null`). */
export function attr(el: Element | null | undefined, name: string): string {
  const v = el ? el.getAttribute(name) : null;
  return v == null ? '' : v;
}

/** Hard cap on string length, default MAX_STRING (300). Unlike `trunc`, this is unconditional: an
 * explicit `max` of 0 truncates to `''`. Used to bound every string field the agent emits, since a
 * field can otherwise carry arbitrary page-controlled text. */
export function cap(s: string, max: number = MAX_STRING): string {
  return s.length > max ? s.slice(0, max) : s;
}

/** True when `el` has visible layout: not `display:none`/`visibility:hidden` (via the modern
 * `checkVisibility` feature when present, else a `getComputedStyle` fallback), not a hidden input,
 * and a non-empty border box. */
export function isVisible(el: Element): boolean {
  if (!el || !el.getBoundingClientRect) return false;
  const tag = tagOf(el);
  if (tag === 'input' && attr(el, 'type').toLowerCase() === 'hidden') return false;
  if (el.checkVisibility) {
    if (!el.checkVisibility({ visibilityProperty: true })) return false;
  } else {
    const st = window.getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden') return false;
  }
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

/** ARIA/native role for an `<input>`, from its `type` attribute (default 'text'). */
function inputRole(el: Element): string {
  const t = (attr(el, 'type') || 'text').toLowerCase();
  if (t === 'checkbox') return 'checkbox';
  if (t === 'radio') return 'radio';
  if (t === 'button' || t === 'submit' || t === 'reset' || t === 'image') return 'button';
  if (t === 'search') return 'searchbox';
  if (t === 'range') return 'slider';
  if (t === 'number') return 'spinbutton';
  if (t === 'hidden') return 'generic';
  return 'textbox';
}

/** Infers `el`'s role: an explicit `role` attribute (other than presentation/none) first, else a
 * tag/attribute-based native-role heuristic, else 'generic'. */
export function inferRole(el: Element): RoleInfo {
  const explicit = collapse(attr(el, 'role')).split(' ')[0];
  if (explicit && explicit !== 'presentation' && explicit !== 'none') {
    return { role: explicit, real: !!REAL_ROLES[explicit] };
  }
  const tag = tagOf(el);
  if (tag === 'a' && el.hasAttribute('href')) return { role: 'link', real: true };
  if (tag === 'button') return { role: 'button', real: true };
  if (tag === 'input') {
    const ir = inputRole(el);
    return { role: ir, real: ir !== 'generic' };
  }
  if (tag === 'textarea') return { role: 'textbox', real: true };
  if (tag === 'select') {
    const sel = el as HTMLSelectElement;
    return { role: sel.multiple || sel.size > 1 ? 'listbox' : 'combobox', real: true };
  }
  if (/^h[1-6]$/.test(tag)) return { role: 'heading', real: true };
  if (tag === 'img' && attr(el, 'alt')) return { role: 'img', real: true };
  if (tag === 'option') return { role: 'option', real: true };
  if (tag === 'li' && el.hasAttribute('data-value')) return { role: 'clickable', real: false };
  if (el.hasAttribute && (el.hasAttribute('onclick') || (el.classList && el.classList.contains('btn')))) return { role: 'clickable', real: false };
  if (tag === 'td' || tag === 'th') return { role: 'cell', real: false };
  if (tag === 'label') return { role: 'label', real: false };
  return { role: 'generic', real: false };
}

/** Longest adjacent-cell label kept; a longer cell text is truncated to this many chars. */
export const ADJACENT_LABEL_MAX = 80;

/** An adjacent-cell label and whether it was cut at ADJACENT_LABEL_MAX. */
export interface AdjacentCellLabelInfo {
  text: string;
  truncated: boolean;
}

/** `adjacentCellLabel` plus whether the text was truncated. */
export function adjacentCellLabelInfo(el: Element): AdjacentCellLabelInfo {
  const cell = el.closest ? el.closest('td,th') : null;
  if (!cell || !cell.parentElement) return { text: '', truncated: false };
  let prev = cell.previousElementSibling;
  while (prev) {
    const pt = tagOf(prev);
    if (pt === 'td' || pt === 'th') {
      const txt = stripColon((prev as HTMLElement).innerText || prev.textContent || '');
      if (txt) {
        return txt.length > ADJACENT_LABEL_MAX ? { text: txt.slice(0, ADJACENT_LABEL_MAX), truncated: true } : { text: txt, truncated: false };
      }
    }
    prev = prev.previousElementSibling;
  }
  return { text: '', truncated: false };
}

/** Text of the nearest preceding sibling `<td>`/`<th>` with text in `el`'s own row (legacy
 * label/value table layouts; empty cells such as spacer cells are skipped), rendered text
 * (`innerText`, so CSS `text-transform` applies) stripped of a trailing colon and capped at
 * ADJACENT_LABEL_MAX chars. `''` when `el` is not in a cell, or no preceding cell has text. */
export function adjacentCellLabel(el: Element): string {
  return adjacentCellLabelInfo(el).text;
}

type FormControlElement = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

/** True for the element types a `<label>`/`labels` association applies to. */
function isFormControl(el: Element): el is FormControlElement {
  const tag = tagOf(el);
  return tag === 'input' || tag === 'select' || tag === 'textarea';
}

/** Label text and how it was found: `aria-label`/`aria-labelledby` first, then a real `<label>`
 * association (form controls only), then the legacy adjacent-cell heuristic (form controls only).
 * `null` when none apply. */
export function labelFor(el: Element): LabelInfo | null {
  const al = collapse(attr(el, 'aria-label'));
  if (al) return { text: al, kind: 'aria' };
  const lb = attr(el, 'aria-labelledby');
  if (lb) {
    const parts = lb
      .split(/\s+/)
      .map((id) => {
        const n = document.getElementById(id);
        return n ? collapse(n.innerText || n.textContent) : '';
      })
      .filter(Boolean);
    if (parts.length) return { text: parts.join(' '), kind: 'aria' };
  }
  if (isFormControl(el)) {
    if (el.labels && el.labels.length) {
      const lt = stripColon(
        Array.prototype.map
          .call(el.labels, (l: HTMLLabelElement) => l.innerText || l.textContent)
          .join(' '),
      );
      if (lt) return { text: lt, kind: 'label' };
    }
    const adj = adjacentCellLabel(el);
    if (adj) return { text: adj, kind: 'adjacent-cell' };
  }
  return null;
}

/**
 * The inverse of the adjacent-cell label heuristic: every visible form control whose `labelFor`
 * is an adjacent-cell label matching `label`, in document order. It uses `labelFor` itself, so a
 * label recorded from a control always finds that control again (same text source, same walk
 * over empty cells, same truncation). `label` is compared after `stripColon`; `exact` compares
 * case-sensitively for equality, otherwise case-insensitively as a substring (a truncated label
 * is a prefix of the full cell text).
 */
export function findAdjacentCellControls(label: unknown, exact: boolean): Element[] {
  const wanted = stripColon(label);
  if (!wanted) return [];
  const wantedLower = wanted.toLowerCase();
  const out: Element[] = [];
  const controls = document.querySelectorAll('input,select,textarea');
  for (let i = 0; i < controls.length; i++) {
    const el = controls[i]!;
    if (!el.closest('td,th') || !isVisible(el)) continue;
    const lb = labelFor(el);
    if (!lb || lb.kind !== 'adjacent-cell') continue;
    const match = exact ? lb.text === wanted : lb.text.toLowerCase().indexOf(wantedLower) !== -1;
    if (match) out.push(el);
  }
  return out;
}

/** Descendants whose rendered text can carry user input or a choice list (see ownText's valueFree). */
const VALUE_BEARING_SEL = 'select,textarea,[contenteditable]';

/** `el`'s own text: a button-type input's `value` (property, or its `value` attribute when
 * `opts.valueFree`), `innerText` for anything else except `<select>`/`<textarea>` (which have no
 * own text of interest), truncated to `max` (default 120; `max || 120`, so an explicit 0 also
 * falls back to 120). */
export function ownText(el: Element, max?: number, opts?: TextOptions): string {
  const tag = tagOf(el);
  let t = '';
  if (tag === 'input') {
    const ty = attr(el, 'type').toLowerCase();
    if (ty === 'button' || ty === 'submit' || ty === 'reset') {
      t = opts?.valueFree ? attr(el, 'value') : (el as HTMLInputElement).value || '';
    }
  } else if (tag !== 'select' && tag !== 'textarea') {
    // valueFree: innerText of an editable region is what the user typed, and innerText of a
    // container includes typed contenteditable text and every <option> label. Report no text
    // for either, so capture never derives a name or text from them.
    if (opts?.valueFree && ((el as HTMLElement).isContentEditable || el.querySelector(VALUE_BEARING_SEL))) return '';
    t = (el as HTMLElement).innerText || '';
  }
  return trunc(t, max || 120);
}


/**
 * True when no visible descendant of `el` carries the exact same collapsed own-text as `el`
 * itself -- i.e. `el` is the innermost ("leaf") element that actually renders this text, not a
 * container (a `tr`, its `td`, ...) that merely inherits it via `innerText` from one descendant.
 *
 * `textCache`, when given, is a Map from visible element to its collapsed own-text (exactly what
 * `enumerate()`'s own rawTextCache already is); every visible element has an entry there (even
 * `''`), so a cache hit also tells us the element is visible. Passing it in means each element's
 * own text is computed once during enumerate()'s single visible-elements pass, not recomputed here
 * for every candidate's whole subtree. Without a cache (a standalone call), it falls back to
 * computing directly.
 */
export function isTextLeaf(el: Element, textCache?: Map<Element, string>): boolean {
  const t = textCache ? textCache.get(el) || '' : collapse(ownText(el, Infinity));
  if (!t) return true;
  const kids = el.querySelectorAll ? el.querySelectorAll('*') : [];
  for (let ki = 0; ki < kids.length; ki++) {
    const kid = kids[ki];
    if (!kid) continue;
    const kt = textCache ? textCache.get(kid) : isVisible(kid) ? collapse(ownText(kid, Infinity)) : undefined;
    if (kt === undefined) continue; // not visible (absent from the cache, or isVisible() false)
    if (kt === t) return false;
  }
  return true;
}

/** Same priority chain as `accessibleName`, plus whether the winning raw text was truncated to
 * fit the 80-char cap (used by `enumerate()` to decide 'exact' on a role locator). */
export function accessibleNameInfo(el: Element, opts?: TextOptions): AccessibleName & { truncated: boolean } {
  const al = collapse(attr(el, 'aria-label'));
  if (al) return { name: trunc(al, 80), source: 'aria-label', truncated: al.length > 80 };
  const lb = labelFor(el);
  if (lb && lb.kind === 'aria') return { name: trunc(lb.text, 80), source: 'aria-labelledby', truncated: lb.text.length > 80 };
  if (lb && lb.kind === 'label') return { name: trunc(lb.text, 80), source: 'label', truncated: lb.text.length > 80 };
  const alt = collapse(attr(el, 'alt'));
  if (alt) return { name: trunc(alt, 80), source: 'alt', truncated: alt.length > 80 };
  const title = collapse(attr(el, 'title'));
  if (title) return { name: trunc(title, 80), source: 'title', truncated: title.length > 80 };
  const ph = collapse(attr(el, 'placeholder'));
  if (ph) return { name: trunc(ph, 80), source: 'placeholder', truncated: ph.length > 80 };
  if (lb && lb.kind === 'adjacent-cell') return { name: trunc(lb.text, 80), source: 'adjacent-cell', truncated: lb.text.length > 80 };
  const txt = ownText(el, Infinity, opts);
  if (txt) return { name: trunc(txt, 80), source: 'text', truncated: txt.length > 80 };
  const n = collapse(attr(el, 'name')) || collapse(attr(el, 'id'));
  if (n) return { name: trunc(n, 80), source: 'attr', truncated: n.length > 80 };
  return { name: '', source: '', truncated: false };
}

/** Accessible name and the rule that produced it (see `accessibleNameInfo` for the full chain). */
export function accessibleName(el: Element, opts?: TextOptions): AccessibleName {
  const info = accessibleNameInfo(el, opts);
  return { name: info.name, source: info.source as NameSource };
}

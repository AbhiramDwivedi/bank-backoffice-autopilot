/**
 * Element description and full-document enumeration, ported near-literally from the driver's
 * legacy in-page library (see naming.ts's header for provenance).
 *
 * `enumerate()` walks the document's visible elements, splits them into "interactive" (native
 * controls, links, [onclick], .btn, li[data-value], ARIA widget roles) and "informative" (headings,
 * label/value table cells, td.msg-style message cells, <b>/<font> short texts, <li> inside
 * <ul class="errors">) groups in document order, skipping any element whose closest interactive
 * ancestor is itself already selected. Per element it also precomputes what descriptor synthesis
 * needs: the accessible name (+ whether it was truncated), label/adjacent-cell association, a
 * row-anchor or above-anchor text for the 'relative' locator, a text-locator candidate (own text,
 * or -- for a clickable <tr> -- its first non-empty cell's text), whether that candidate is unique
 * among this document's visible elements' own texts, and a structural CSS selector.
 *
 * Intentional deviations from the legacy library (see the module-contract doc for the full list):
 *  - every string field of ElementData/ElementDescription is passed through `cap()` (300 chars);
 *  - `enumerate(opts)` supports `maxElements` (keep interactive first, then informative, then text
 *    leaves by priority, up to the cap; default: no cap) and `maxBodyTextChars` (default
 *    DEFAULT_MAX_BODY_TEXT, applied to `bodyText` only, which is a digest, not a field);
 *  - `describe()` threads `TextOptions` through to `ownText`/`accessibleName` (valueFree);
 *  - a third group, 'text': leaf text blocks no legacy rule selects (a price in a <div>), listed
 *    after every interactive and informative entry, so the legacy entries and their order are
 *    unchanged (leaves.ts has the rules and why);
 *  - per element, `containerAnchors` (verified 'relative' anchors from the element's container,
 *    when it has no row anchor) and `priority`; a text leaf's `cssSelector` prefers a unique class
 *    selector over the structural one, since a class survives a reordered list and a position does
 *    not.
 */
import { DEFAULT_MAX_BODY_TEXT, MAX_STRING, REDACTED_VALUE } from './constants.js';
import {
  accessibleName,
  accessibleNameInfo,
  adjacentCellLabel,
  adjacentCellLabelInfo,
  attr,
  cap,
  collapse,
  inferRole,
  isTextLeaf,
  isVisible,
  labelFor,
  ownText,
  tagOf,
} from './naming.js';
import {
  classSelector,
  containerAnchors,
  isUniqueSelector,
  leafTextIndex,
  recordContextOf,
  rowAnchorIsLabel,
  selectTextLeaves,
  verifiedAboveAnchor,
  visibleByTag,
  type LeafContext,
} from './leaves.js';
import { selectForCap } from './cap.js';
import { closestClickable, isInteractive, isNestedInteractive, structuralSelector } from './selectors.js';
import type { ElementData, ElementDescription, EnumerateOptions, EnumerateResult, Rect, TextOptions } from './types.js';

/** `el`'s border box in CSS px, relative to this document's viewport. */
export function rect(el: Element): Rect {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

/** Role, accessible name, label, own text and structural selector of one element. */
export function describe(el: Element, opts?: TextOptions): ElementDescription {
  const ro = inferRole(el);
  const nm = accessibleName(el, opts);
  const lb = labelFor(el);
  return {
    tag: tagOf(el),
    role: ro.role,
    realRole: ro.real,
    name: cap(nm.name),
    nameSource: nm.source,
    text: cap(ownText(el, 120, opts)),
    selector: structuralSelector(el),
    label: cap(lb ? lb.text : ''),
    labelKind: lb ? lb.kind : '',
    inputType: tagOf(el) === 'input' ? attr(el, 'type').toLowerCase() || 'text' : '',
  };
}

/** The element at viewport point `(x, y)`, or its closest interactive ancestor; `null` when
 * nothing is there, or only `<body>`/`<html>` is. */
export function elementAtPoint(x: number, y: number): Element | null {
  const hit = document.elementFromPoint(x, y);
  return hit ? closestClickable(hit) : null;
}

/** True unless `el` is `.disabled` or `aria-disabled="true"`. */
type DisableableElement = HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLOptGroupElement | HTMLOptionElement | HTMLFieldSetElement;
function isEnabled(el: Element): boolean {
  if ((el as DisableableElement).disabled) return false;
  if (collapse(attr(el, 'aria-disabled')).toLowerCase() === 'true') return false;
  return true;
}

/**
 * Field value for `ElementData.value`. A password's value is only ever truth-tested (never stored
 * or returned): `REDACTED_VALUE` when non-empty, `undefined` when empty, so a real secret can
 * never appear anywhere in enumerate() output.
 */
function valueOf(el: Element, tag: string, inputType: string): string | undefined {
  if (tag === 'input') {
    const input = el as HTMLInputElement;
    if (inputType === 'password') return input.value ? REDACTED_VALUE : undefined;
    if (inputType === 'checkbox' || inputType === 'radio') return input.checked ? 'true' : 'false';
    if (inputType === 'button' || inputType === 'submit' || inputType === 'reset' || inputType === 'image' || inputType === 'hidden' || inputType === 'file') {
      return undefined;
    }
    return input.value;
  }
  if (tag === 'textarea') return (el as HTMLTextAreaElement).value;
  if (tag === 'select') return (el as HTMLSelectElement).value;
  return undefined;
}

/** First non-empty cell's own text in `tr`'s first-child chain (a clickable row's text-locator
 * candidate, since the resolver climbs from a matched `<td>` to the row). */
function firstNonEmptyCellText(tr: Element): string {
  let c = tr.firstElementChild;
  while (c) {
    const ct = tagOf(c);
    if (ct === 'td' || ct === 'th') {
      const t = collapse(ownText(c, Infinity));
      if (t) return t;
    }
    c = c.nextElementSibling;
  }
  return '';
}

/**
 * Full-document enumeration. Returns `data` (one entry per `els[i]`), the parallel live `els`
 * array, this document's `viewport`, and `bodyText` (whitespace-collapsed `document.body.innerText`,
 * capped at `opts.maxBodyTextChars` (default DEFAULT_MAX_BODY_TEXT)).
 *
 * The interactive and informative entries, their order and their legacy fields match the legacy
 * in-page library (see this module's header); text leaves (leaves.ts) follow them.
 * `opts.maxElements`, when given, keeps interactive entries first, then informative, then text
 * leaves by priority, up to the cap -- computed only after selection, so it never changes which
 * elements are considered for text uniqueness or anchor candidacy.
 */
export function enumerate(opts?: EnumerateOptions): EnumerateResult {
  const body = document.body;
  const bodyTextFull = body ? collapse(body.innerText) : '';
  const bodyText = cap(bodyTextFull, opts?.maxBodyTextChars ?? DEFAULT_MAX_BODY_TEXT);
  const viewport = { width: window.innerWidth, height: window.innerHeight };

  const allNodes = document.querySelectorAll('*');
  const visible: Element[] = [];
  for (let i = 0; i < allNodes.length; i++) {
    const node = allNodes[i];
    if (node && isVisible(node)) visible.push(node);
  }

  // Own-text cache + a text -> Set(representative node) map for uniqueness checks. The
  // representative of an occurrence is its closest interactive ancestor (or itself when it has
  // none), so a wrapper and its sole text-bearing child collapse to one match.
  const rawTextCache = new Map<Element, string>();
  const textMap = new Map<string, Set<Element>>();
  for (const vEl of visible) {
    const vt = collapse(ownText(vEl, Infinity));
    rawTextCache.set(vEl, vt);
    if (vt && vt.length <= 80) {
      const rep = closestClickable(vEl) || vEl;
      let set = textMap.get(vt);
      if (!set) {
        set = new Set();
        textMap.set(vt, set);
      }
      set.add(rep);
    }
  }
  function isUniqueText(t: string): boolean {
    if (!t) return false;
    const s = textMap.get(t);
    return !!s && s.size === 1;
  }

  // Candidates for the "directly above" relative anchor: any visible element with non-empty own
  // text (no length limit -- capped only when it lands in the output, via cap()), excluding any
  // element whose text is only inherited from a visible descendant (isTextLeaf) -- see
  // isTextLeaf's doc comment (naming.ts) for why only leaves qualify.
  const labelCandidates: Element[] = [];
  for (const lEl of visible) {
    const lt = rawTextCache.get(lEl);
    if (lt && isTextLeaf(lEl, rawTextCache)) labelCandidates.push(lEl);
  }
  function findAboveAnchor(el: Element, elRect: Rect): string {
    let best = '';
    let bestGap = Infinity;
    for (const cand of labelCandidates) {
      if (cand === el || cand.contains(el) || el.contains(cand)) continue;
      const cr = rect(cand);
      const gap = elRect.y - (cr.y + cr.h);
      if (gap < 0 || gap > 60) continue;
      const overlap = cr.x < elRect.x + elRect.w && elRect.x < cr.x + cr.w;
      if (!overlap) continue;
      if (gap < bestGap) {
        bestGap = gap;
        best = rawTextCache.get(cand) || '';
      }
    }
    return best;
  }

  // Interactive: document order, drop nested ones (e.g. a <td> inside a tr[onclick]; a td is
  // never itself isInteractive() so this mainly guards onclick-on-descendant cases).
  const interactiveEls: Element[] = [];
  for (const iEl of visible) {
    if (!isInteractive(iEl)) continue;
    if (isNestedInteractive(iEl)) continue;
    interactiveEls.push(iEl);
  }
  const interactiveSet = new Set(interactiveEls);

  // Informative: headings, label/value cells, message cells, bold/font short texts, error list items.
  const informativeEls: Element[] = [];
  for (const el2 of visible) {
    if (interactiveSet.has(el2)) continue;
    const tag2 = tagOf(el2);
    if (/^h[1-6]$/.test(tag2)) {
      informativeEls.push(el2);
      continue;
    }
    if (tag2 === 'td' || tag2 === 'th') {
      if (isNestedInteractive(el2)) continue; // part of an already-selected clickable row
      const ownT = rawTextCache.get(el2) || '';
      if (!ownT) continue;
      const next = el2.nextElementSibling;
      const prev = el2.previousElementSibling;
      const nextTag = next ? tagOf(next) : '';
      const prevTag = prev ? tagOf(prev) : '';
      const nextT = nextTag === 'td' || nextTag === 'th' ? rawTextCache.get(next as Element) || '' : '';
      const prevT = prevTag === 'td' || prevTag === 'th' ? rawTextCache.get(prev as Element) || '' : '';
      if (nextT || prevT) {
        informativeEls.push(el2);
        continue;
      }
      const cls = collapse(attr(el2, 'class'));
      if (/\bmsg\b/.test(cls) || /msg/.test(cls)) {
        informativeEls.push(el2);
        continue;
      }
      continue;
    }
    if (tag2 === 'b' || tag2 === 'font') {
      const bt = rawTextCache.get(el2) || '';
      if (bt) {
        informativeEls.push(el2);
        continue;
      }
      continue;
    }
    if (tag2 === 'li') {
      if (el2.closest && el2.closest('ul.errors')) {
        informativeEls.push(el2);
        continue;
      }
    }
  }

  // Text leaves: every other leaf text block (leaves.ts), after all of the above.
  const rectCache = new Map<Element, Rect>();
  const leafCtx: LeafContext = {
    visible,
    visibleSet: new Set(visible),
    textCache: rawTextCache,
    interactiveSet,
    legacySet: new Set(informativeEls),
    anchorCandidates: new Set(labelCandidates),
    isUniqueLeafText: leafTextIndex(visible, rawTextCache, true),
    isUniqueAnchorText: leafTextIndex(visible, rawTextCache, false),
    rect: (el) => {
      let r = rectCache.get(el);
      if (!r) {
        r = rect(el);
        rectCache.set(el, r);
      }
      return r;
    },
  };
  const textLeaves = selectTextLeaves(leafCtx);
  const byTag = visibleByTag(visible);

  const data: ElementData[] = [];
  const els: Element[] = [];

  function pushEl(el: Element, group: ElementData['group'], priority: number, inViewport: boolean): void {
    const tag = tagOf(el);
    const ro = inferRole(el);
    const nm = accessibleNameInfo(el);
    const lb = labelFor(el);
    const r = rect(el);
    const inputType = tag === 'input' ? attr(el, 'type').toLowerCase() || 'text' : '';
    const ownRaw = rawTextCache.get(el) || '';

    let textLocatorCandidate = '';
    let textLocatorTagOmit = false;
    if (ro.role === 'clickable' && tag === 'tr') {
      const cellText = firstNonEmptyCellText(el);
      if (cellText && cellText.length <= 80) {
        textLocatorCandidate = cellText;
        textLocatorTagOmit = true;
      }
    } else if (ownRaw && ownRaw.length <= 80) {
      textLocatorCandidate = ownRaw;
    }

    const rowAnchor = adjacentCellLabel(el);
    const realRole = ro.real ? ro.role : undefined;
    const aboveAnchor = rowAnchor ? '' : group === 'text' ? verifiedAboveAnchor(el, realRole, leafCtx, byTag) : findAboveAnchor(el, r);
    const value = valueOf(el, tag, inputType);
    const anchors = rowAnchor ? [] : containerAnchors(el, realRole, leafCtx, byTag);
    let css = '';
    if (group === 'text') {
      const cls = classSelector(el, ownRaw);
      if (isUniqueSelector(cls)) css = cls;
    }
    if (!css) css = structuralSelector(el);

    data.push({
      tag,
      role: ro.role,
      roleReal: ro.real,
      name: cap(nm.name),
      nameSource: nm.source,
      nameTruncated: nm.truncated,
      text: cap(ownText(el, 120)),
      value: value === undefined ? undefined : cap(value),
      inputType,
      enabled: isEnabled(el),
      rect: r,
      group,
      labelKind: lb ? lb.kind : '',
      labelText: cap(lb ? lb.text : ''),
      labelTruncated: !!lb && (lb.text.length > MAX_STRING || (lb.kind === 'adjacent-cell' && adjacentCellLabelInfo(el).truncated)),
      rowAnchorText: cap(rowAnchor),
      aboveAnchorText: cap(aboveAnchor),
      textLocatorCandidate: cap(textLocatorCandidate),
      textLocatorTagOmit,
      // A text leaf (new group) is held to the lookup-accurate uniqueness; the legacy groups keep
      // the legacy map, whose answers their recorded chains were built from.
      textUnique: group === 'text' ? leafCtx.isUniqueLeafText(textLocatorCandidate) : isUniqueText(textLocatorCandidate),
      cssSelector: css,
      priority,
      containerAnchors: anchors.map((a) => ({ text: cap(a.text), relation: a.relation, selector: a.selector, within: a.within })),
      inViewport,
      rowAnchorIsLabel: rowAnchor ? rowAnchorIsLabel(el) : false,
      // labelUnique: the row anchor (its label) is the only such anchor text in the document.
      recordContext: { ...recordContextOf(el, leafCtx), ...(rowAnchor ? { labelUnique: leafCtx.isUniqueAnchorText(rowAnchor) } : {}) },
    });
    els.push(el);
  }

  // The cap (cap.ts, shared with the driver) is applied BEFORE per-element synthesis, so a page
  // with thousands of leaves pays for the descriptor inputs (container-anchor verification above
  // all) of the kept entries only. The kept entries stay in their original order.
  const inView = (el: Element): boolean => {
    const r = leafCtx.rect(el);
    return r.x < viewport.width && r.y < viewport.height && r.x + r.w > 0 && r.y + r.h > 0;
  };
  const entries: { el: Element; group: ElementData['group']; priority: number; inViewport: boolean }[] = [
    ...interactiveEls.map((el) => ({ el, group: 'interactive' as const, priority: 0, inViewport: inView(el) })),
    ...informativeEls.map((el) => ({ el, group: 'informative' as const, priority: 0, inViewport: inView(el) })),
    ...textLeaves.map((l) => ({ el: l.el, group: 'text' as const, priority: l.priority, inViewport: inView(l.el) })),
  ];
  const maxElements = opts?.maxElements;
  const kept = maxElements !== undefined && entries.length > maxElements ? selectForCap(entries, maxElements).map((i) => entries[i]!) : entries;
  for (const e of kept) pushEl(e.el, e.group, e.priority, e.inViewport);
  return { data, els, viewport, bodyText, ...(kept.length < entries.length ? { omitted: entries.length - kept.length } : {}) };
}

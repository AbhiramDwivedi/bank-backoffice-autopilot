/**
 * Frame and locator matching helpers shared by `FakeSurface`'s resolver: frame-path comparison,
 * locator text matching, relative/bbox geometry, and CSS-escape normalization for `css`
 * locators. Pure functions over `FakeElementSpec`/`FakeScreenSpec` data; no `FakeSurface`
 * instance state.
 */
import type { FrameHop, FramePath, LocatorStrategy } from '../../schema/index.js';
import { collapseWhitespace } from '../conditions.js';
import { holdsWholeWord } from '../whole-word.js';
import type { BBox } from '../types.js';
import { DEFAULT_VIEWPORT, type FakeElementSpec, type FakeScreenSpec } from './scenario.js';

/** One resolvable element on a screen: a stable per-screen `ref` plus its current spec. */
export interface RuntimeElement {
  ref: string;
  spec: FakeElementSpec;
}

function frameHopEquals(a: FrameHop, b: FrameHop): boolean {
  return a.name === b.name && a.index === b.index && a.urlPattern === b.urlPattern;
}

/** True if two frame paths name the same sequence of hops (name/index/urlPattern, hop by hop). */
export function framePathEquals(a: FramePath, b: FramePath): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!frameHopEquals(a[i]!, b[i]!)) return false;
  }
  return true;
}

function compileRegexOrThrow(pattern: string, context: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`${context}: invalid regex pattern ${JSON.stringify(pattern)}: ${reason}`, { cause: err });
  }
}

/** Hop-by-hop frame match: name equal when the hop has a name, index equal when it has an
 * index, urlPattern tested against the frame's declared url (from `screen.frames`) when it
 * has one. A hop with none of the three always matches (the schema requires at least one, so
 * this is defensive only). */
export function frameMatches(elementFrame: FramePath, targetFrame: FramePath, screen: FakeScreenSpec): boolean {
  if (elementFrame.length !== targetFrame.length) return false;
  for (let i = 0; i < targetFrame.length; i++) {
    const hop = targetFrame[i]!;
    const actual = elementFrame[i]!;
    if (hop.name !== undefined && actual.name !== hop.name) return false;
    if (hop.index !== undefined && actual.index !== hop.index) return false;
    if (hop.urlPattern !== undefined) {
      const cumPath = elementFrame.slice(0, i + 1);
      const entry = (screen.frames ?? []).find((f) => framePathEquals(f.path, cumPath));
      if (!entry) return false;
      if (!compileRegexOrThrow(hop.urlPattern, 'FrameHop.urlPattern').test(entry.url)) return false;
    }
  }
  return true;
}

/** exact=true: equal after whitespace-collapse. exact=false (default): case-insensitive
 * substring. This is the locator-matching convention (distinct from `text_visible`'s
 * condition semantics in conditions.ts, which is always substring even when exact). */
export function locatorTextMatches(actual: string | undefined, expected: string, exact = false, wholeWord = false): boolean {
  if (actual === undefined) return false;
  const a = collapseWhitespace(actual);
  const e = collapseWhitespace(expected);
  if (exact) return a === e;
  // Case-sensitive, like `exact`.
  if (wholeWord) return holdsWholeWord(a, e);
  return a.toLowerCase().includes(e.toLowerCase());
}

function centre(b: BBox): { x: number; y: number } {
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

/** Euclidean distance between two bboxes' centres (used to pick the nearest `relative` candidate). */
function centreDistance(a: BBox, b: BBox): number {
  const ca = centre(a);
  const cb = centre(b);
  return Math.hypot(ca.x - cb.x, ca.y - cb.y);
}

/** Clamps a number to `[0, 1]`, for normalizing a `bbox` locator to viewport-relative fractions. */
export function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/** The `relative` locator strategy, narrowed out of the full `LocatorStrategy` union. */
export type RelativeStrategy = Extract<LocatorStrategy, { kind: 'relative' }>;
/** The `bbox` locator strategy, narrowed out of the full `LocatorStrategy` union. */
export type BboxStrategy = Extract<LocatorStrategy, { kind: 'bbox' }>;

/** right-of/left-of: candidate must share the anchor's `row` key, or have its vertical centre
 * within the anchor's bbox band, AND be beyond the anchor horizontally. below/above: purely
 * bbox vertical comparison (no column constraint) -- see the file header for why these two
 * pairs are treated asymmetrically. */
function satisfiesRelation(anchor: FakeElementSpec, cand: FakeElementSpec, relation: RelativeStrategy['relation']): boolean {
  const ac = centre(anchor.bbox);
  const cc = centre(cand.bbox);
  switch (relation) {
    case 'same-row':
      return anchor.row !== undefined && anchor.row === cand.row;
    case 'right-of': {
      const rowish = (anchor.row !== undefined && anchor.row === cand.row) || (cc.y >= anchor.bbox.y && cc.y <= anchor.bbox.y + anchor.bbox.h);
      return rowish && cc.x > ac.x;
    }
    case 'left-of': {
      const rowish = (anchor.row !== undefined && anchor.row === cand.row) || (cc.y >= anchor.bbox.y && cc.y <= anchor.bbox.y + anchor.bbox.h);
      return rowish && cc.x < ac.x;
    }
    case 'below':
      return cc.y > ac.y;
    case 'above':
      return cc.y < ac.y;
    default: {
      const exhaustive: never = relation;
      return exhaustive;
    }
  }
}

/** Resolves CSS escapes (`\31 ` hex form and `\x` literal form) so selectors are compared the way a
 * browser parses them: `tr[x="\31 2"]` and `tr[x="12"]` denote the same selector. Needed because
 * the binder CSS-escapes bound input values (packages/core/src/schema/template.ts `bindCssSelector`), and this
 * fake matches css locators by string compare rather than by parsing. */
export function cssUnescape(sel: string): string {
  return sel.replace(/\\(?:([0-9a-fA-F]{1,6})[ \t\n]?|([^\n0-9a-fA-F]))/g, (_m, hex: string | undefined, ch: string | undefined) =>
    hex !== undefined ? String.fromCodePoint(parseInt(hex, 16) || 0xfffd) : (ch as string),
  );
}

/** What a `relative` lookup yields: the element, or why not. `matches` is set when the miss was an
 * ambiguity (several anchors, each as good as the other). */
export type RelativeResult = { element: RuntimeElement } | { error: string; matches?: number };

/**
 * The anchor of a `relative` locator, by the rule the real resolver applies
 * (packages/adapter-playwright/src/resolve.ts `findAnchor`): the one element whose text EQUALS the
 * anchor text wins outright; with no equal one, a single element CONTAINING it is the anchor;
 * several equal ones, or several containing ones, are an ambiguity and a miss, never "the first".
 * `exact` (an anchor bound to a run input) accepts only equality, case-sensitively; `wholeWord`
 * keeps only elements holding the text as a whole token, case-sensitively.
 *
 * An anchor is an element that shows the text: its `text`. Only when no element's text matches
 * does the lookup fall back to names and labels, for a scenario that does not model the label cell
 * (the labelled control then stands in for it).
 */
function findAnchor(pool: RuntimeElement[], anchor: RelativeStrategy['anchor']): { index: number } | { error: string; matches?: number } {
  const exact = anchor.exact === true;
  const ww = anchor.wholeWord === true;
  const sensitive = exact || ww;
  const fold = (t: string): string => (sensitive ? collapseWhitespace(t) : collapseWhitespace(t).toLowerCase());
  const wanted = fold(anchor.text);
  const lookup = (fields: (e: RuntimeElement) => (string | undefined)[]): { equal: number[]; containing: number[] } => {
    const equal: number[] = [];
    const containing: number[] = [];
    pool.forEach((e, i) => {
      const shown = fields(e).filter((t): t is string => t !== undefined);
      if (shown.some((t) => fold(t) === wanted)) equal.push(i);
      else if (!exact && shown.some((t) => locatorTextMatches(t, anchor.text, false, ww))) containing.push(i);
    });
    return { equal, containing };
  };
  let found = lookup((e) => [e.spec.text]);
  if (found.equal.length === 0 && found.containing.length === 0) found = lookup((e) => [e.spec.name, e.spec.label]);
  const { equal, containing } = found;
  if (equal.length === 1) return { index: equal[0]! };
  if (equal.length > 1) return { error: `ambiguous anchor: ${equal.length} ${exact ? 'exact ' : ''}matches`, matches: equal.length };
  if (exact) return { error: 'no exact anchor match' };
  if (containing.length === 1) return { index: containing[0]! };
  if (containing.length === 0) return { error: 'no anchor match' };
  return { error: `ambiguous anchor: ${containing.length} matches`, matches: containing.length };
}

/** Best `relative` match in `pool`: the anchor is found as {@link findAnchor} describes; among
 * candidates satisfying `strat.relation` (and `strat.role`/`strat.tag`/`strat.selector` when
 * given), the one with the nearest bbox centre to the anchor wins. The real resolver's 1px tie
 * rule between candidates is not modelled: this geometry is centre distance, not edge distance
 * along the relation's axis. */
export function resolveRelative(pool: RuntimeElement[], strat: RelativeStrategy): RelativeResult {
  const anchorResult = findAnchor(pool, strat.anchor);
  if ('error' in anchorResult) return anchorResult;
  const anchorIdx = anchorResult.index;
  // No DOM here, so no container or column: a `within` bound or an anchor `selector` cannot be honoured and is a miss.
  if (strat.within !== undefined || strat.anchor.selector !== undefined) return { error: 'no match' };
  const anchor = pool[anchorIdx]!;
  let candidates = pool.filter((_e, i) => i !== anchorIdx);
  if (strat.role !== undefined) candidates = candidates.filter((e) => e.spec.role === strat.role);
  if (strat.tag !== undefined) candidates = candidates.filter((e) => e.spec.tag === strat.tag);
  // NOT CSS semantics: there is no CSS engine here. A selector filter keeps an element only when
  // its spec lists that exact selector string among its `css` entries (the same literal
  // comparison the `css` strategy uses), so `div.price` does not match a spec listing `.price`.
  const selector = strat.selector;
  if (selector !== undefined) candidates = candidates.filter((e) => (e.spec.css ?? []).some((c) => cssUnescape(c) === cssUnescape(selector)));
  candidates = candidates.filter((e) => satisfiesRelation(anchor.spec, e.spec, strat.relation));
  if (candidates.length === 0) return { error: 'no match' };
  let best = candidates[0]!;
  let bestDist = centreDistance(anchor.spec.bbox, best.spec.bbox);
  for (const c of candidates.slice(1)) {
    const d = centreDistance(anchor.spec.bbox, c.spec.bbox);
    if (d < bestDist) {
      best = c;
      bestDist = d;
    }
  }
  return { element: best };
}

/** Best `bbox` match in `pool`: every element whose bbox contains the strategy's (viewport-
 * relative) centre point, narrowed to the smallest-area one when more than one does. */
export function resolveBbox(pool: RuntimeElement[], strat: BboxStrategy, viewport = DEFAULT_VIEWPORT): RuntimeElement | undefined {
  const cx = (strat.x + strat.w / 2) * viewport.width;
  const cy = (strat.y + strat.h / 2) * viewport.height;
  const matches = pool.filter(
    (e) => cx >= e.spec.bbox.x && cx <= e.spec.bbox.x + e.spec.bbox.w && cy >= e.spec.bbox.y && cy <= e.spec.bbox.y + e.spec.bbox.h,
  );
  if (matches.length === 0) return undefined;
  let best = matches[0]!;
  for (const m of matches.slice(1)) {
    if (m.spec.bbox.w * m.spec.bbox.h < best.spec.bbox.w * best.spec.bbox.h) best = m;
  }
  return best;
}

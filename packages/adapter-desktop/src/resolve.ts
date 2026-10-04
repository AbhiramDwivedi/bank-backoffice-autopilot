/**
 * Locator resolution over a desktop view: the same strategies and the same "first unique match
 * wins, ambiguity is a miss" rule the web surface applies, mapped onto UI Automation.
 *
 *   automation_id  exact AutomationId (case-sensitive)
 *   role           role (from ControlType) + UIA Name; for a value control only a genuine name
 *   label          the label tree.ts associated with the control (LabeledBy, else geometry)
 *   text           what a person sees on the control: Name, or the value of a value control;
 *                  `tag` filters by control type (`button`, `text`, `edit`...)
 *   relative       geometry around an anchor static, in window client coordinates, as on the web
 *   bbox           the smallest element containing the box centre, viewport-normalized
 *   css            no desktop equivalent: always a miss, so a web-recorded chain falls through
 *
 * Only visible elements in the target's frame are candidates. Pure; the surface re-snapshots and
 * calls this again until its timeout.
 *
 * An ambiguity is reported, not settled: a strategy that matches several elements, a relative
 * anchor that several elements show, or two candidates equally near the anchor is a miss marked
 * `ambiguous` with its match count. A found resolution lists the misses before the winner, so
 * replay can refuse a positional (bbox) winner after one (`positionalFallbackRefusal` in
 * @cu/core/surface).
 */
import type { FramePath, LocatorStrategy, LocatorStrategyKind, TargetDescriptor } from '@cu/core/schema';
import { collapseWhitespace, holdsWholeWord, type TriedStrategy } from '@cu/core/surface';
import { CT } from './protocol.js';
import { cleanLabel, type DesktopNode, type DesktopView } from './tree.js';

/** Outcome of resolving one descriptor against one view. */
export type ViewResolution =
  | { found: true; node: DesktopNode; strategyIndex: number; strategyKind: LocatorStrategyKind; tried: TriedStrategy[] }
  | { found: false; tried: TriedStrategy[] };

/** exact: equal after whitespace collapse; otherwise case-insensitive substring (the locator convention). */
export function textMatches(actual: string | undefined, expected: string, exact = false, wholeWord = false): boolean {
  if (actual === undefined) return false;
  const a = collapseWhitespace(actual);
  const e = collapseWhitespace(expected);
  if (exact) return a === e;
  // Case-sensitive, like `exact`.
  if (wholeWord) return holdsWholeWord(a, e);
  return a.toLowerCase().includes(e.toLowerCase());
}

/** Hop-by-hop frame match on name and index; a urlPattern hop is tested against the window's location. */
export function frameMatches(view: DesktopView, node: DesktopNode, target: FramePath): boolean {
  if (node.frame.length !== target.length) return false;
  for (let i = 0; i < target.length; i++) {
    const hop = target[i]!;
    const actual = node.frame[i]!;
    if (hop.name !== undefined && actual.name !== hop.name) return false;
    if (hop.index !== undefined && (actual.index ?? 0) !== hop.index) return false;
    if (hop.urlPattern !== undefined) {
      const url = view.windows.find((w) => w.hwnd === node.hwnd)?.url ?? view.url;
      if (!new RegExp(hop.urlPattern).test(url)) return false;
    }
  }
  return true;
}

function centre(n: DesktopNode): { x: number; y: number } {
  return { x: n.bbox.x + n.bbox.w / 2, y: n.bbox.y + n.bbox.h / 2 };
}

function inBand(anchor: DesktopNode, cand: DesktopNode): boolean {
  const c = centre(cand).y;
  const a = centre(anchor).y;
  return (c >= anchor.bbox.y && c <= anchor.bbox.y + anchor.bbox.h) || (a >= cand.bbox.y && a <= cand.bbox.y + cand.bbox.h);
}

type Relative = Extract<LocatorStrategy, { kind: 'relative' }>;

function satisfies(anchor: DesktopNode, cand: DesktopNode, relation: Relative['relation']): boolean {
  const a = centre(anchor);
  const c = centre(cand);
  switch (relation) {
    case 'right-of':
      return inBand(anchor, cand) && c.x > a.x;
    case 'left-of':
      return inBand(anchor, cand) && c.x < a.x;
    case 'same-row':
      return inBand(anchor, cand);
    case 'below':
      return c.y > a.y;
    case 'above':
      return c.y < a.y;
  }
}

/** Why a strategy yielded no element. `matches` is set when the miss was an ambiguity. */
export interface StrategyMiss {
  error: string;
  matches?: number;
}

/**
 * The anchor of a relative locator, by the web resolver's rule: the one element whose text EQUALS
 * the anchor text wins outright; with no equal one, a single element CONTAINING it is the anchor;
 * several equal ones, or several containing ones, are an ambiguity and a miss, never "the first in
 * the tree". `exact` (an anchor bound to a run input) accepts only equality; `wholeWord` keeps only
 * elements holding the text as a whole token. A plain anchor is looked up among statics first (a
 * label), and among every element's visible text only when no static matches.
 */
function findAnchor(pool: readonly DesktopNode[], text: string, exact = false, wholeWord = false): DesktopNode | StrategyMiss {
  // `exact` and `wholeWord` compare case-sensitively; a plain anchor does not.
  const sensitive = exact || wholeWord;
  const fold = (t: string): string => (sensitive ? collapseWhitespace(t) : collapseWhitespace(t).toLowerCase());
  const wanted = fold(text);
  const equals = (n: DesktopNode): boolean => [n.text, n.name].some((t) => t !== undefined && fold(t) === wanted);
  const holds = (n: DesktopNode): boolean => textMatches(n.text, text, false, wholeWord) || textMatches(n.name, text, false, wholeWord);
  const among = (nodes: readonly DesktopNode[]): DesktopNode | StrategyMiss | undefined => {
    const equal = nodes.filter(equals);
    if (equal.length === 1) return equal[0]!;
    if (equal.length > 1) return { error: `ambiguous anchor: ${equal.length} ${exact ? 'exact ' : ''}matches`, matches: equal.length };
    if (exact) return undefined;
    const holding = nodes.filter(holds);
    if (holding.length === 1) return holding[0]!;
    if (holding.length > 1) return { error: `ambiguous anchor: ${holding.length} matches`, matches: holding.length };
    return undefined;
  };
  const statics = sensitive ? undefined : among(pool.filter((n) => n.ct === CT.Text));
  return statics ?? among(pool) ?? { error: 'anchor not found' };
}

/** Candidates a single strategy yields in `pool` (already visible and in-frame), or why it yields none. */
export function candidatesFor(view: DesktopView, pool: readonly DesktopNode[], strat: LocatorStrategy): DesktopNode[] | StrategyMiss {
  switch (strat.kind) {
    case 'automation_id':
      return pool.filter((n) => n.rawAutomationId === strat.id);
    case 'role':
      return pool.filter((n) => n.role === strat.role && n.genuineName && textMatches(n.uiaName, strat.name, strat.exact));
    case 'label':
      return pool.filter((n) => n.label !== undefined && textMatches(n.label, cleanLabel(strat.label), strat.exact));
    case 'text':
      return pool.filter((n) => (strat.tag === undefined || n.tag === strat.tag) && textMatches(n.text, strat.text, strat.exact, strat.wholeWord));
    case 'relative': {
      // A CSS candidate filter cannot be evaluated here; ignoring it would widen the match.
      if (strat.selector !== undefined || strat.within !== undefined || strat.anchor.selector !== undefined) return { error: 'css selectors have no desktop equivalent' };
      const anchor = findAnchor(pool, strat.anchor.text, strat.anchor.exact === true, strat.anchor.wholeWord === true);
      if ('error' in anchor) return anchor;
      let cands = pool.filter((n) => n !== anchor && n.ct !== CT.Group && satisfies(anchor, n, strat.relation));
      if (strat.role !== undefined) cands = cands.filter((n) => n.role === strat.role);
      if (strat.tag !== undefined) cands = cands.filter((n) => n.tag === strat.tag);
      if (cands.length === 0) return [];
      const ac = centre(anchor);
      const dist = (n: DesktopNode): number => Math.hypot(centre(n).x - ac.x, centre(n).y - ac.y);
      const best = [...cands].sort((x, y) => dist(x) - dist(y));
      // Two candidates equally near (within a pixel) are a tie: ambiguous, as on the web.
      if (best.length > 1 && Math.abs(dist(best[0]!) - dist(best[1]!)) < 1) return best.slice(0, 2);
      return [best[0]!];
    }
    case 'bbox': {
      const cx = (strat.x + strat.w / 2) * view.viewport.width;
      const cy = (strat.y + strat.h / 2) * view.viewport.height;
      const hits = pool.filter((n) => n.ct !== CT.Group && cx >= n.bbox.x && cx <= n.bbox.x + n.bbox.w && cy >= n.bbox.y && cy <= n.bbox.y + n.bbox.h);
      if (hits.length === 0) return [];
      const area = (n: DesktopNode): number => n.bbox.w * n.bbox.h;
      return [[...hits].sort((x, y) => area(x) - area(y))[0]!];
    }
    case 'css':
      return { error: 'css selectors have no desktop equivalent' };
  }
}

/** Visible elements of the target's frame, in tree order. */
export function poolFor(view: DesktopView, frame: FramePath): DesktopNode[] {
  return view.nodes.filter((n) => n.visible && n.ct !== CT.Pane && n.ct !== CT.Window && frameMatches(view, n, frame));
}

/**
 * Tries each locator in order; the first that yields exactly one element wins. A found resolution
 * carries the misses before the winner (`tried[i]` is locator `i`); a miss that was an ambiguity is
 * marked `ambiguous` with its match count, which replay reads to refuse a positional fallback.
 */
export function resolveInView(view: DesktopView, target: TargetDescriptor): ViewResolution {
  const pool = poolFor(view, target.frame);
  const tried: TriedStrategy[] = [];
  if (pool.length === 0) {
    const where = target.frame.length === 0 ? 'the main window' : `frame ${JSON.stringify(target.frame)}`;
    return { found: false, tried: [{ strategyKind: '*', error: `${where} has no visible elements (window not open?)` }] };
  }
  for (let i = 0; i < target.locators.length; i++) {
    const strat = target.locators[i]!.strategy;
    const c = candidatesFor(view, pool, strat);
    if (!Array.isArray(c)) {
      tried.push({ strategyKind: strat.kind, error: c.error, ...(c.matches !== undefined ? { ambiguous: true as const, matches: c.matches } : {}) });
      continue;
    }
    if (c.length === 0) {
      tried.push({ strategyKind: strat.kind, error: 'no match' });
      continue;
    }
    if (c.length > 1) {
      tried.push({ strategyKind: strat.kind, error: `ambiguous: ${c.length} matches`, ambiguous: true, matches: c.length });
      continue;
    }
    return { found: true, node: c[0]!, strategyIndex: i, strategyKind: strat.kind, tried };
  }
  return { found: false, tried };
}

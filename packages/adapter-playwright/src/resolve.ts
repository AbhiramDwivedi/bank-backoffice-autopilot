/**
 * resolve(): try a TargetDescriptor's locators in order inside its frame.
 *
 * Strategy order: role, label (+ adjacent-cell heuristic), text (+ closest-clickable climb),
 * relative (anchor + geometry), css, bbox. Every strategy is evaluated without Playwright
 * auto-waiting (elementHandles(), not locator actions), filtered to visible elements via
 * `window.__cuAgent.lib.isVisible`. Polling happens at the round level (see `resolveDescriptor`),
 * not inside a single strategy attempt.
 *
 * The adjacent-cell label lookup is `window.__cuAgent.lib.findAdjacentCellControls`, the inverse of
 * the naming side's own heuristic, so a recorded label and its lookup cannot drift apart. In-page
 * helpers beyond what `window.__cuAgent.lib` (from `@cu/browser-agent`, installed by inpage.ts)
 * exports (bbox hit-test fallback, relative-anchor candidate gathering) are real anonymous inline
 * arrow functions defined in this file and run via
 * `frame.evaluateHandle`; see the "In-page lookups" comment below for why they must be actual
 * function values, not strings.
 */
import type { ElementHandle, Frame, JSHandle, Locator as PwLocator, Page } from 'playwright';
import type { LocatorStrategy, LocatorStrategyKind, TargetDescriptor } from '@cu/core/schema';
import { holdsWholeWord, type TriedStrategy } from '@cu/core/surface';
import { frameViewport, resolveFramePath } from './frames.js';
import { ensureAgent } from './inpage.js';
import type { RefEntry, RefInfo } from './refs.js';

/**
 * Outcome of resolveDescriptor(): the bound element, which strategy found it and the strategies
 * that missed before it in the winning round (`tried[i]` is locator `i`); or every strategy tried
 * and why each missed. A miss that was an ambiguity is marked `ambiguous` with its match count.
 */
export type DescriptorResolution =
  | { found: true; entry: RefEntry; strategyIndex: number; strategyKind: LocatorStrategyKind; tried: TriedStrategy[] }
  | { found: false; tried: TriedStrategy[] };

/** Options for resolveDescriptor(). */
export interface ResolveOptions {
  /** Diagnostic sink ("strategy 0 role: ambiguous (2 matches)"). */
  log?: (msg: string) => void;
}

const POLL_MS = 250;
/** Ties within this many px along the relation axis make a `relative` match ambiguous. */
const TIE_EPSILON_PX = 1;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// -------------------------------------------------------------------------------------------
// "Real" ARIA roles: the set Playwright's getByRole recognizes. A handful of these are
// deliberately excluded even though they are technically valid ARIA terms ('cell', 'generic')
// because they are exactly the synthetic/inferred role strings `@cu/browser-agent`'s naming.ts
// `inferRole()` assigns with `real: false` to legacy markup that carries no explicit role (a bare
// `<td>`, the catch-all fallback) -- along with 'clickable' (used for tr[onclick]/.btn/[onclick] divs, never
// a real ARIA role at all). A `role` locator naming any of these three, or anything outside the
// ARIA vocabulary, misses immediately instead of asking Playwright's accessibility tree to match
// it.
// -------------------------------------------------------------------------------------------
const ARIA_ROLES: ReadonlySet<string> = new Set([
  'alert', 'alertdialog', 'application', 'article', 'banner', 'blockquote', 'button', 'caption', 'cell', 'checkbox',
  'code', 'columnheader', 'combobox', 'complementary', 'contentinfo', 'definition', 'deletion', 'dialog', 'directory',
  'document', 'emphasis', 'feed', 'figure', 'form', 'generic', 'grid', 'gridcell', 'group', 'heading', 'img',
  'insertion', 'link', 'list', 'listbox', 'listitem', 'log', 'main', 'marquee', 'math', 'meter', 'menu', 'menubar',
  'menuitem', 'menuitemcheckbox', 'menuitemradio', 'navigation', 'none', 'note', 'option', 'paragraph',
  'presentation', 'progressbar', 'radio', 'radiogroup', 'region', 'row', 'rowgroup', 'rowheader', 'scrollbar',
  'search', 'searchbox', 'separator', 'slider', 'spinbutton', 'status', 'strong', 'subscript', 'superscript',
  'switch', 'tab', 'table', 'tablist', 'tabpanel', 'term', 'textbox', 'time', 'timer', 'toolbar', 'tooltip', 'tree',
  'treegrid', 'treeitem',
]);
const SYNTHETIC_ROLE_KINDS: ReadonlySet<string> = new Set(['clickable', 'cell', 'generic']);

function isRealAriaRole(role: string): boolean {
  return ARIA_ROLES.has(role) && !SYNTHETIC_ROLE_KINDS.has(role);
}

// -------------------------------------------------------------------------------------------
// In-page lookups not covered by `window.__cuAgent.lib`. These must be real anonymous inline
// arrow functions passed directly to evaluate/evaluateHandle, not strings. Playwright only
// special-cases a plain *expression* string (e.g. `'1 + 2'`, `'document'`; that's how
// `inpage.ts`'s agent-install string and `ensureAgent`'s readiness check work); a stringified
// arrow function is evaluated as an expression too, which just yields the Function value itself
// -- it is never called, and any `arg` passed alongside it is silently dropped. Real (uncalled,
// unnamed, inline) function values referencing only `window.__cuAgent` (typed globally by
// `@cu/browser-agent`'s `declare global`, see its src/types.ts) and plain DOM APIs avoid esbuild's
// `__name` helper (which only wraps *named* bindings) and behave exactly like Playwright's own
// documented `evaluateHandle(([a, b]) => ..., [a, b])` pattern.
// -------------------------------------------------------------------------------------------

/** Visible form controls whose adjacent-cell label matches `label` (see the module header). */
async function findAdjacentCellControls(frame: Frame, label: string, exact: boolean): Promise<ElementHandle<Element>[]> {
  const arrayHandle = await frame.evaluateHandle(
    (raw: unknown) => {
      const [lbl, ex] = raw as [string, boolean];
      const lib = window.__cuAgent!.lib;
      // An app-shipped agent of this major but an earlier build may lack the lookup: a miss, not an error.
      return typeof lib.findAdjacentCellControls === 'function' ? lib.findAdjacentCellControls(lbl, ex) : [];
    },
    [label, exact],
  );
  return handlesFromArrayHandle(arrayHandle);
}

/** Closest interactive ancestor of the element at `(x, y)`, else the hit element itself when
 * it's a td/th/label (a plain text cell), else null. */
async function hitTestBbox(frame: Frame, x: number, y: number): Promise<ElementHandle<Element> | null> {
  const handle = await frame.evaluateHandle(
    (raw: unknown) => {
      const [px, py] = raw as [number, number];
      const lib = window.__cuAgent!.lib;
      const hit = document.elementFromPoint(px, py);
      if (!hit) return null;
      const clickable = lib.closestClickable(hit);
      if (clickable) return clickable;
      const tag = hit.tagName.toLowerCase();
      if (tag === 'td' || tag === 'th' || tag === 'label') return hit;
      return null;
    },
    [x, y],
  );
  return handle.asElement() as ElementHandle<Element> | null;
}

/** Visible elements (excluding the anchor and its ancestors) matching `tag`/`role` when given,
 * else any interactive element or `td`, and matching the CSS `selector` when given (an invalid
 * selector matches nothing). Ancestor/descendant pairs within that set are then
 * collapsed to one candidate each (see the in-page function body for why and how) so a
 * non-actionable wrapper never ties with the actionable element it wraps. @cu/browser-agent's
 * leaves.ts simulates exactly this to verify a container anchor before emitting it; keep the two
 * in step. */
async function gatherRelativeCandidates(
  frame: Frame,
  anchor: ElementHandle<Element>,
  tag: string | undefined,
  role: string | undefined,
  selector: string | undefined,
  within: string | undefined,
): Promise<ElementHandle<Element>[]> {
  const arrayHandle = await frame.evaluateHandle(
    (raw: unknown) => {
      const [anchorEl, tg, rl, sel, wi] = raw as [Element, string | null, string | null, string | null, string | null];
      const lib = window.__cuAgent!.lib;
      // `within`: only candidates inside the anchor's own container (its nearest ancestor matching
      // the selector). No such container, or an invalid selector, means no candidates at all.
      let scope: Element | null = null;
      if (wi) {
        try {
          scope = anchorEl.closest(wi);
        } catch {
          scope = null;
        }
        if (!scope) return [];
      }
      const all = Array.from((scope ?? document).querySelectorAll('*'));
      const out: Element[] = [];
      for (const el of all) {
        if (el === anchorEl || el.contains(anchorEl)) continue;
        // Inside a nested container of the same kind (a card within the card): that one's, not this one's.
        if (scope && wi && el.closest(wi) !== scope) continue;
        if (!lib.isVisible(el)) continue;
        if (sel) {
          let ok: boolean;
          try {
            ok = el.matches(sel);
          } catch {
            ok = false; // an invalid selector matches nothing
          }
          if (!ok) continue;
        }
        if (tg) {
          if (el.tagName.toLowerCase() !== tg.toLowerCase()) continue;
          if (rl && lib.inferRole(el).role !== rl) continue;
        } else if (rl) {
          if (lib.inferRole(el).role !== rl) continue;
        } else {
          const t = el.tagName.toLowerCase();
          if (!(lib.isInteractive(el) || t === 'td')) continue;
        }
        out.push(el);
      }
      // Collapse ancestor/descendant pairs among the matched candidates -- symmetrically: either
      // direction can be the actionable one. A layout-only wrapper around one clickable child
      // (e.g. a zero-padding-top <div>) matches the same tag/role filter as its child and sits at
      // the exact same edge; a clickable <tr> containing a plain <td> that also passes the filter
      // is the same shape the other way around. Either way, without collapsing them the pair is
      // geometrically tied ("ambiguous: N candidates within Xpx") even though enumerate.ts only
      // ever synthesizes a descriptor for one of the two. For every contained pair, drop the
      // non-actionable one (per lib.closestClickable identifying the element itself, not
      // merely a clickable ancestor further up); if neither or both are actionable, drop the
      // ancestor and keep the innermost (descendant) -- the element lib.closestClickable
      // would actually resolve a click to, and the one enumerate.ts selects.
      // (No local helper function here on purpose -- see the top-of-file note on why these
      // in-page callbacks must avoid named function bindings.)
      const clickableSelf = new Set<Element>();
      for (const el of out) {
        if (lib.closestClickable(el) === el) clickableSelf.add(el);
      }
      const dominated = new Set<Element>();
      for (const a of out) {
        for (const b of out) {
          if (a === b || !a.contains(b)) continue; // a is a proper ancestor of b
          const aWins = clickableSelf.has(a) && !clickableSelf.has(b);
          dominated.add(aWins ? b : a);
        }
      }
      const kept: Element[] = [];
      for (const el of out) {
        if (!dominated.has(el)) kept.push(el);
      }
      return kept;
    },
    [anchor, tag ?? null, role ?? null, selector ?? null, within ?? null],
  );
  return handlesFromArrayHandle(arrayHandle);
}

// -------------------------------------------------------------------------------------------
// Handle plumbing
// -------------------------------------------------------------------------------------------

async function disposeAll(handles: readonly (ElementHandle<Element> | JSHandle<unknown>)[]): Promise<void> {
  for (const h of handles) await h.dispose().catch(() => undefined);
}

/** Unwraps a JSHandle to a JS array of elements (from evaluateHandle) into ElementHandles. */
async function handlesFromArrayHandle(arrayHandle: JSHandle<unknown>): Promise<ElementHandle<Element>[]> {
  const props = await arrayHandle.getProperties();
  const out: ElementHandle<Element>[] = [];
  for (const [key, h] of props) {
    if (!/^\d+$/.test(key)) {
      await h.dispose().catch(() => undefined);
      continue;
    }
    const el = h.asElement();
    if (el) out.push(el as ElementHandle<Element>);
    else await h.dispose().catch(() => undefined);
  }
  await arrayHandle.dispose().catch(() => undefined);
  return out;
}

async function elementHandlesFromLocator(loc: PwLocator): Promise<ElementHandle<Element>[]> {
  try {
    return (await loc.elementHandles()) as unknown as ElementHandle<Element>[];
  } catch {
    return [];
  }
}

async function isVisibleHandle(h: ElementHandle<Element>): Promise<boolean> {
  try {
    return await h.evaluate((el) => window.__cuAgent!.lib.isVisible(el));
  } catch {
    return false;
  }
}

async function filterVisible(handles: ElementHandle<Element>[]): Promise<ElementHandle<Element>[]> {
  const out: ElementHandle<Element>[] = [];
  for (const h of handles) {
    if (await isVisibleHandle(h)) out.push(h);
    else await h.dispose().catch(() => undefined);
  }
  return out;
}

async function collectVisible(loc: PwLocator): Promise<ElementHandle<Element>[]> {
  return filterVisible(await elementHandlesFromLocator(loc));
}

async function sameElement(a: ElementHandle<Element>, b: ElementHandle<Element>): Promise<boolean> {
  try {
    return await a.evaluate((el, other) => el === other, b);
  } catch {
    return false;
  }
}

async function dedupeByIdentity(handles: ElementHandle<Element>[]): Promise<ElementHandle<Element>[]> {
  const out: ElementHandle<Element>[] = [];
  for (const h of handles) {
    let dup = false;
    for (const existing of out) {
      if (await sameElement(h, existing)) {
        dup = true;
        break;
      }
    }
    if (dup) await h.dispose().catch(() => undefined);
    else out.push(h);
  }
  return out;
}

// -------------------------------------------------------------------------------------------
// Per-strategy matching. Each returns a "win" (exactly one visible match) or a "miss" with a
// short diagnostic; never throws (navigation/detach errors are caught and reported as a miss).
// A miss carries `matches` when it was an ambiguity: the strategy (or a relative strategy's
// anchor) matched that many elements and none could be preferred. Replay reads it to refuse a
// positional fallback after an ambiguity.
// -------------------------------------------------------------------------------------------

type StrategyOutcome = { kind: 'win'; handle: ElementHandle<Element> } | { kind: 'miss'; error: string; matches?: number };

async function pickUnique(handles: ElementHandle<Element>[]): Promise<StrategyOutcome> {
  if (handles.length === 0) return { kind: 'miss', error: 'no match' };
  if (handles.length === 1) return { kind: 'win', handle: handles[0]! };
  await disposeAll(handles);
  return { kind: 'miss', error: `ambiguous: ${handles.length} matches`, matches: handles.length };
}

async function matchRole(frame: Frame, strat: Extract<LocatorStrategy, { kind: 'role' }>): Promise<StrategyOutcome> {
  if (!isRealAriaRole(strat.role)) return { kind: 'miss', error: 'non-ARIA role' };
  const loc = frame.getByRole(strat.role as Parameters<Frame['getByRole']>[0], { name: strat.name, exact: strat.exact });
  return pickUnique(await collectVisible(loc));
}

async function matchLabel(frame: Frame, strat: Extract<LocatorStrategy, { kind: 'label' }>): Promise<StrategyOutcome> {
  const viaLabel = await collectVisible(frame.getByLabel(strat.label, { exact: strat.exact }));
  if (viaLabel.length > 0) return pickUnique(viaLabel);
  const controls = await filterVisible(await findAdjacentCellControls(frame, strat.label, strat.exact ?? false));
  return pickUnique(controls);
}

/** Disposes and drops every handle whose collapsed text does not hold `text` as a whole token
 *  (case-sensitive; see `holdsWholeWord`: a hyphen does not end a word). */
async function keepWholeWord(handles: ElementHandle<Element>[], text: string): Promise<ElementHandle<Element>[]> {
  // Case-sensitive, like `exact`: "lee" is another value than "Lee".
  const wanted = text.replace(/\s+/g, ' ').trim();
  const out: ElementHandle<Element>[] = [];
  for (const h of handles) {
    const t = await h
      .evaluate((el) => window.__cuAgent!.lib.collapse((el as HTMLElement).innerText || el.textContent || ''))
      .catch(() => '');
    const ok = holdsWholeWord(t, wanted);
    if (ok) out.push(h);
    else await h.dispose().catch(() => undefined);
  }
  return out;
}

async function matchText(frame: Frame, strat: Extract<LocatorStrategy, { kind: 'text' }>): Promise<StrategyOutcome> {
  const found = await elementHandlesFromLocator(frame.getByText(strat.text, { exact: strat.exact }));
  const raw = strat.wholeWord === true && strat.exact !== true ? await keepWholeWord(found, strat.text) : found;
  const mapped: ElementHandle<Element>[] = [];
  for (const h of raw) {
    let el: ElementHandle<Element> | null;
    try {
      const targetHandle = await h.evaluateHandle((node) => {
        const lib = window.__cuAgent!.lib;
        return lib.isInteractive(node) ? node : (lib.closestClickable(node) ?? node);
      });
      el = targetHandle.asElement() as ElementHandle<Element> | null;
      if (!el) await targetHandle.dispose().catch(() => undefined);
    } catch {
      el = null;
    }
    await h.dispose().catch(() => undefined);
    if (el) mapped.push(el);
  }
  // `tag` constrains the element that will actually be acted on, i.e. the one just climbed to
  // (a clickable ancestor for a plain text leaf), not the raw getByText match itself.
  let candidates = mapped;
  if (strat.tag) {
    const wantedTag = strat.tag.toLowerCase();
    const kept: ElementHandle<Element>[] = [];
    for (const h of candidates) {
      const tag = await h.evaluate((el) => el.tagName.toLowerCase()).catch(() => '');
      if (tag === wantedTag) kept.push(h);
      else await h.dispose().catch(() => undefined);
    }
    candidates = kept;
  }
  const deduped = await dedupeByIdentity(candidates);
  return pickUnique(await filterVisible(deduped));
}

async function matchCss(frame: Frame, strat: Extract<LocatorStrategy, { kind: 'css' }>): Promise<StrategyOutcome> {
  let loc: PwLocator;
  try {
    loc = frame.locator(strat.selector);
  } catch {
    return { kind: 'miss', error: 'invalid selector' };
  }
  return pickUnique(await collectVisible(loc));
}

async function matchBbox(frame: Frame, strat: Extract<LocatorStrategy, { kind: 'bbox' }>): Promise<StrategyOutcome> {
  const vp = await frameViewport(frame);
  const x = (strat.x + strat.w / 2) * vp.width;
  const y = (strat.y + strat.h / 2) * vp.height;
  const el = await hitTestBbox(frame, x, y);
  if (!el) return { kind: 'miss', error: 'no match' };
  return pickUnique(await filterVisible([el]));
}

/** Anchor lookup for `relative`: equals-match (case-insensitive) wins outright; contains-match
 * only used as a fallback when there is exactly one of it. With `exact` (an anchor bound to a run
 * input), only a case-sensitive, whitespace-collapsed equality counts, there is no contains
 * fallback, and anything but exactly one match is a miss: "Bike" must not find "Bike Light". */
async function findAnchor(
  frame: Frame,
  text: string,
  exact = false,
  wholeWord = false,
  selector?: string,
): Promise<{ handle: ElementHandle<Element> } | { error: string; matches?: number }> {
  let found = await collectVisible(frame.getByText(text, { exact: false }));
  // `anchor.selector`: only an anchor that is, or sits inside, an element matching it (one column).
  if (selector !== undefined) {
    const kept: ElementHandle<Element>[] = [];
    for (const h of found) {
      if (await h.evaluate((el, sel) => el.closest(sel) !== null, selector).catch(() => false)) kept.push(h);
      else await h.dispose().catch(() => undefined);
    }
    found = kept;
  }
  // wholeWord: an element counts only when the text sits in it as a whole token (case-sensitive).
  const substr = wholeWord ? await keepWholeWord(found, text) : found;
  const collapsedWanted = text.replace(/\s+/g, ' ').trim();
  const sensitive = exact || wholeWord;
  const wanted = sensitive ? collapsedWanted : collapsedWanted.toLowerCase();
  const equalsHandles: ElementHandle<Element>[] = [];
  const restHandles: ElementHandle<Element>[] = [];
  for (const h of substr) {
    const t = await h
      .evaluate((el) => window.__cuAgent!.lib.collapse((el as HTMLElement).innerText || el.textContent || ''))
      .catch(() => '');
    if ((sensitive ? t : t.toLowerCase()) === wanted) equalsHandles.push(h);
    else restHandles.push(h);
  }
  if (equalsHandles.length === 1) {
    await disposeAll(restHandles);
    return { handle: equalsHandles[0]! };
  }
  if (exact) {
    await disposeAll(substr);
    return equalsHandles.length === 0
      ? { error: 'no exact anchor match' }
      : { error: `ambiguous anchor: ${equalsHandles.length} exact matches`, matches: equalsHandles.length };
  }
  if (equalsHandles.length === 0) {
    if (substr.length === 1) return { handle: substr[0]! };
    await disposeAll(substr);
    return substr.length === 0 ? { error: 'no anchor match' } : { error: `ambiguous anchor: ${substr.length} matches`, matches: substr.length };
  }
  await disposeAll(substr);
  return { error: `ambiguous anchor: ${equalsHandles.length} matches`, matches: equalsHandles.length };
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

async function rectOf(handle: ElementHandle<Element>): Promise<Rect> {
  return handle.evaluate((el) => window.__cuAgent!.lib.rect(el));
}

function rowBand(anchor: Rect, cand: Rect): boolean {
  const cy = cand.y + cand.h / 2;
  return cy >= anchor.y && cy <= anchor.y + anchor.h;
}

function xBandOverlap(anchor: Rect, cand: Rect): boolean {
  return cand.x < anchor.x + anchor.w && cand.x + cand.w > anchor.x;
}

type Relation = Extract<LocatorStrategy, { kind: 'relative' }>['relation'];

async function satisfiesRelation(
  relation: Relation,
  anchorHandle: ElementHandle<Element>,
  anchorRect: Rect,
  candHandle: ElementHandle<Element>,
  candRect: Rect,
  anchorInTable: boolean,
): Promise<boolean> {
  switch (relation) {
    case 'right-of':
      return rowBand(anchorRect, candRect) && candRect.x >= anchorRect.x + anchorRect.w - 2;
    case 'left-of':
      return rowBand(anchorRect, candRect) && candRect.x + candRect.w <= anchorRect.x + 2;
    case 'below':
      return xBandOverlap(anchorRect, candRect) && candRect.y >= anchorRect.y + anchorRect.h - 2;
    case 'above':
      return xBandOverlap(anchorRect, candRect) && candRect.y + candRect.h <= anchorRect.y + 2;
    case 'same-row':
      if (anchorInTable) {
        return candHandle
          .evaluate((el, anchorEl) => {
            const at = (anchorEl as Element).closest('tr');
            const ct = el.closest('tr');
            return at !== null && at === ct;
          }, anchorHandle)
          .catch(() => false);
      }
      return rowBand(anchorRect, candRect);
    default: {
      const exhaustive: never = relation;
      return exhaustive;
    }
  }
}

function axisDistance(relation: Relation, anchor: Rect, cand: Rect): number {
  switch (relation) {
    case 'right-of':
      return cand.x - (anchor.x + anchor.w);
    case 'left-of':
      return anchor.x - (cand.x + cand.w);
    case 'below':
      return cand.y - (anchor.y + anchor.h);
    case 'above':
      return anchor.y - (cand.y + cand.h);
    case 'same-row':
      // No natural "axis" for same-row; nearest by horizontal centre distance is the closest
      // reasonable reading of "edge distance along the relation axis" for this relation.
      return Math.abs(cand.x + cand.w / 2 - (anchor.x + anchor.w / 2));
    default: {
      const exhaustive: never = relation;
      return exhaustive;
    }
  }
}

async function matchRelative(frame: Frame, strat: Extract<LocatorStrategy, { kind: 'relative' }>): Promise<StrategyOutcome> {
  const anchorResult = await findAnchor(frame, strat.anchor.text, strat.anchor.exact === true, strat.anchor.wholeWord === true, strat.anchor.selector);
  if ('error' in anchorResult) return { kind: 'miss', error: anchorResult.error, ...(anchorResult.matches !== undefined ? { matches: anchorResult.matches } : {}) };
  const anchor = anchorResult.handle;
  try {
    const candidates = await gatherRelativeCandidates(frame, anchor, strat.tag, strat.role, strat.selector, strat.within);
    if (candidates.length === 0) return { kind: 'miss', error: 'no match' };
    // Inside a record's container the element is the one candidate that fits the filter; two (a
    // struck-through list price above a sale price) means the filter cannot tell which is meant.
    if (strat.within !== undefined && candidates.length > 1) {
      await disposeAll(candidates);
      return { kind: 'miss', error: `ambiguous: ${candidates.length} candidates in the anchor's container`, matches: candidates.length };
    }
    const anchorRect = await rectOf(anchor);
    const anchorInTable = await anchor.evaluate((el) => el.closest('table') !== null).catch(() => false);
    const scored: { handle: ElementHandle<Element>; distance: number }[] = [];
    for (const cand of candidates) {
      const candRect = await rectOf(cand);
      const ok = await satisfiesRelation(strat.relation, anchor, anchorRect, cand, candRect, anchorInTable);
      if (!ok) {
        await cand.dispose().catch(() => undefined);
        continue;
      }
      scored.push({ handle: cand, distance: axisDistance(strat.relation, anchorRect, candRect) });
    }
    if (scored.length === 0) return { kind: 'miss', error: 'no match' };
    scored.sort((a, b) => a.distance - b.distance);
    const best = scored[0]!;
    const runnerUp = scored[1];
    if (runnerUp && Math.abs(runnerUp.distance - best.distance) <= TIE_EPSILON_PX) {
      await disposeAll(scored.map((s) => s.handle));
      return { kind: 'miss', error: `ambiguous: ${scored.length} candidates within ${TIE_EPSILON_PX}px`, matches: scored.length };
    }
    await disposeAll(scored.slice(1).map((s) => s.handle));
    return { kind: 'win', handle: best.handle };
  } finally {
    await anchor.dispose().catch(() => undefined);
  }
}

async function evalLocatorStrategy(frame: Frame, strategy: LocatorStrategy): Promise<StrategyOutcome> {
  try {
    await ensureAgent(frame);
    switch (strategy.kind) {
      case 'role':
        return await matchRole(frame, strategy);
      case 'label':
        return await matchLabel(frame, strategy);
      case 'text':
        return await matchText(frame, strategy);
      case 'relative':
        return await matchRelative(frame, strategy);
      case 'css':
        return await matchCss(frame, strategy);
      case 'bbox':
        return await matchBbox(frame, strategy);
      case 'automation_id':
        // A native-toolkit identifier: no web equivalent, so the chain falls through.
        return { kind: 'miss', error: 'automation_id has no equivalent on a web page' };
      default: {
        const exhaustive: never = strategy;
        throw new Error(`resolveDescriptor: unhandled locator kind ${JSON.stringify(exhaustive)}`);
      }
    }
  } catch (err) {
    // Never Playwright's message: it can quote the page (see act.ts mapPlaywrightError).
    return { kind: 'miss', error: `locator error (${err instanceof Error ? err.name : 'unknown'})` };
  }
}

// -------------------------------------------------------------------------------------------
// Round scheduling
// -------------------------------------------------------------------------------------------

interface RoundResult {
  winnerIndex?: number;
  winnerHandle?: ElementHandle<Element>;
  /** The misses of this round, in chain order: every strategy before the winner, or all of them. */
  tried: TriedStrategy[];
}

/**
 * One pass over the chain: the first strategy with exactly one visible match wins. Every other
 * outcome, an ambiguity included, is a miss and the next strategy is tried. The round only
 * REPORTS the ambiguity (`ambiguous`, `matches`). Whether a later, positional winner may be used
 * after it is replay's decision (`positionalFallbackRefusal` in @cu/core/surface), because only
 * replay has the target as recorded.
 */
async function runRound(frame: Frame, target: TargetDescriptor): Promise<RoundResult> {
  const tried: TriedStrategy[] = [];
  for (let i = 0; i < target.locators.length; i++) {
    const strat = target.locators[i]!.strategy;
    const outcome = await evalLocatorStrategy(frame, strat);
    if (outcome.kind === 'win') return { winnerIndex: i, winnerHandle: outcome.handle, tried };
    tried.push({ strategyKind: strat.kind, error: outcome.error, ...(outcome.matches !== undefined ? { ambiguous: true as const, matches: outcome.matches } : {}) });
  }
  return { tried };
}

async function isDocumentComplete(frame: Frame): Promise<boolean> {
  try {
    return (await frame.evaluate('document.readyState')) === 'complete';
  } catch {
    return false;
  }
}

async function buildFound(frame: Frame, target: TargetDescriptor, index: number, handle: ElementHandle<Element>, tried: TriedStrategy[]): Promise<DescriptorResolution> {
  let info: RefInfo | undefined;
  try {
    await ensureAgent(frame);
    info = await handle.evaluate((el) => {
      const d = window.__cuAgent!.lib.describe(el);
      return { tag: d.tag, role: d.role, name: d.name, text: d.text };
    });
  } catch {
    info = undefined;
  }
  return {
    found: true,
    entry: { frame, framePath: target.frame, handle, info },
    strategyIndex: index,
    strategyKind: target.locators[index]!.strategy.kind,
    tried,
  };
}

/**
 * Resolves a TargetDescriptor to a live element, retrying its locators until one wins or
 * `timeoutMs` elapses. `timeoutMs <= 0` performs exactly one round with no waiting (used by
 * check()/hasElement).
 */
export async function resolveDescriptor(page: Page, target: TargetDescriptor, timeoutMs: number, opts?: ResolveOptions): Promise<DescriptorResolution> {
  const log = opts?.log ?? ((): void => undefined);
  const oneRoundOnly = timeoutMs <= 0;
  const startedAt = Date.now();
  const deadline = startedAt + Math.max(timeoutMs, 0);
  let sawIndex0MissPriorRound = false;
  let lastTried: TriedStrategy[];
  let roundNum = 0;

  for (;;) {
    const frame = resolveFramePath(page, target.frame);

    if (!frame) {
      lastTried = target.locators.map((l) => ({ strategyKind: l.strategy.kind, error: `frame not found: ${JSON.stringify(target.frame)}` }));
      for (const t of lastTried) log(`resolve round ${roundNum}: ${t.strategyKind}: ${t.error}`);
    } else {
      const round = await runRound(frame, target);
      lastTried = round.tried;
      for (const t of round.tried) log(`resolve round ${roundNum}: ${t.strategyKind}: ${t.error}`);

      if (round.winnerIndex !== undefined && round.winnerHandle) {
        if (round.winnerIndex === 0) {
          return buildFound(frame, target, round.winnerIndex, round.winnerHandle, round.tried);
        }
        if (oneRoundOnly) {
          log(`resolve round ${roundNum}: accepting non-primary strategy ${round.winnerIndex} immediately (timeoutMs<=0)`);
          return buildFound(frame, target, round.winnerIndex, round.winnerHandle, round.tried);
        }
        const ready = await isDocumentComplete(frame);
        const elapsedFrac = timeoutMs > 0 ? (Date.now() - startedAt) / timeoutMs : 1;
        // Settle rule: accept a fallback once the frame is loaded and the primary already missed a
        // whole earlier round; regardless of readyState after 40% of the budget; and always on the
        // last round before the deadline (a held winner must never turn into a false "not found").
        const lastRound = deadline - Date.now() <= POLL_MS;
        const gateOpen = (ready && sawIndex0MissPriorRound) || elapsedFrac >= 0.4 || lastRound;
        if (gateOpen) {
          return buildFound(frame, target, round.winnerIndex, round.winnerHandle, round.tried);
        }
        log(`resolve round ${roundNum}: holding non-primary strategy ${round.winnerIndex} winner (readyState=${ready}, gate not yet open)`);
        await round.winnerHandle.dispose().catch(() => undefined);
      }
    }

    if (oneRoundOnly) break;
    // Reaching here means this round did not resolve at strategy index 0 (that path returns
    // immediately above), so the primary strategy missed this whole round.
    sawIndex0MissPriorRound = true;
    roundNum++;
    const now = Date.now();
    if (now >= deadline) break;
    await sleep(Math.min(POLL_MS, deadline - now));
  }

  return { found: false, tried: lastTried };
}

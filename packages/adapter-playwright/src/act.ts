/**
 * act() per-type behavior, readText, and Playwright error -> FailureCode mapping.
 *
 * surface.ts handles the closed-surface check, the pending-dialog gate (unexpected_dialog),
 * `dismiss_dialog`, `wait`, and `switch_frame` before delegating here, so this module only sees
 * navigate / click / type / select / press / extract.
 */
import type { ElementHandle, Frame, Page } from 'playwright';
import type { FailureCode } from '@cu/core/schema';
import { collapseWhitespace, normalizeKeyName, urlPreprocess, urlShapeRefusal } from '@cu/core/surface';
import type { ActResult, ReadTextResult, RecordTextResult, RecordTextWithin, ResolvedTarget, SurfaceAction } from '@cu/core/surface';
import { ensureAgent } from './inpage.js';
import type { RefEntry } from './refs.js';
import { debugRaw } from './debug.js';

/** Resolves a target to a bound element, or a failure code/message on a miss. */
export type TargetLookup = (target: ResolvedTarget, timeoutMs: number) => Promise<{ ok: true; entry: RefEntry } | { ok: false; code: FailureCode; message: string }>;

/** Dependencies performAction() needs from the surface: element lookup and dialog state. */
export interface ActContext {
  page: Page;
  /** Resolves a {ref} or descriptor to a bound element (surface.ts implements it via RefRegistry + resolveDescriptor). */
  lookup: TargetLookup;
  /**
   * Resolves when a native dialog opens (surface.ts holds dialogs). A click that triggers
   * alert/confirm never settles in Playwright until the dialog is handled, so act must race the
   * action promise against this and return ok:true when the dialog wins.
   */
  dialogOpened: () => Promise<void>;
  /** True while a native dialog is held. */
  hasPendingDialog: () => boolean;
  /** The context's base URL, against which a relative URL resolves when the page has none (about:blank). */
  baseUrl?: string;
}

/** The SurfaceAction variants this module handles directly. */
export type PageAction = Extract<SurfaceAction, { type: 'navigate' | 'click' | 'type' | 'select' | 'press' | 'extract' }>;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** How long to wait, after an action settles, for a navigation to start. */
const NAV_SETTLE_MS = 150;

/**
 * Option-like elements (li/option/[role=option]/a/div|span[data-value]) within `root` (or the
 * whole document when `root` is null) whose collapsed text equals `value`.
 *
 * IMPORTANT: a real anonymous inline arrow, not a string -- see resolve.ts's header comment.
 * Playwright only special-cases a plain *expression* string; a stringified function is
 * evaluated as an expression (yielding the Function value itself) and never invoked with `arg`.
 */
async function findVisibleOptionsByText(frame: Frame, root: ElementHandle<Element> | null, value: string): Promise<ElementHandle<Element>[]> {
  const arrayHandle = await frame.evaluateHandle(
    (raw: unknown) => {
      const [scopeEl, wantedRaw] = raw as [Element | null, string];
      const lib = window.__cuAgent!.lib;
      const wanted = lib.collapse(wantedRaw).toLowerCase();
      const scope: ParentNode = scopeEl ?? document;
      const nodes = Array.from(scope.querySelectorAll('li,option,[role=option],a,div[data-value],span[data-value]'));
      const out: Element[] = [];
      for (const n of nodes) {
        if (!lib.isVisible(n)) continue;
        const txt = lib.collapse(n.textContent || '').toLowerCase();
        if (txt === wanted) out.push(n);
      }
      return out;
    },
    [root, value],
  );
  const props = await arrayHandle.getProperties();
  const out: ElementHandle<Element>[] = [];
  for (const [key, h] of props) {
    if (!/^\d+$/.test(key)) {
      await h.dispose().catch(() => undefined);
      continue;
    }
    const el = h.asElement() as ElementHandle<Element> | null;
    if (el) out.push(el);
    else await h.dispose().catch(() => undefined);
  }
  await arrayHandle.dispose().catch(() => undefined);
  return out;
}

// -------------------------------------------------------------------------------------------
// Error mapping
// -------------------------------------------------------------------------------------------

/**
 * A Playwright error as a code and a fixed, short message of our own. Playwright's message is
 * never passed through: its call log quotes the page (an element preview such as "<div>Member
 * Jane Q Sample at 1 Main St</div> intercepts pointer events"), and the message reaches the
 * model, the evidence and the operator console. Only a `net::ERR_*` code is kept.
 */
export function mapPlaywrightError(err: unknown): { code: FailureCode; message: string } {
  const raw = err instanceof Error ? err.message : String(err);
  // The raw message can quote the page; it goes to the local debug sink only (CU_DEBUG), never into the result.
  debugRaw('act', err);
  if ((err instanceof Error && err.name === 'TimeoutError') || /Timeout \d+ms exceeded/.test(raw)) {
    const covered = /intercepts pointer events/.test(raw) ? ' (another element covers it)' : '';
    return { code: 'timeout', message: `the action timed out: the element was not actionable${covered} (hidden, disabled, covered or still loading)` };
  }
  if (/not attached|detached|Element is not|No node found|Target closed|Execution context was destroyed/.test(raw)) {
    return { code: 'element_not_found', message: 'the element is no longer attached to the page' };
  }
  if (/net::ERR|NS_ERROR|navigation/i.test(raw)) {
    const net = /net::ERR_[A-Z_]+|NS_ERROR_[A-Z_]+/.exec(raw);
    return { code: 'navigation_failed', message: `navigation failed${net ? ` (${net[0]})` : ''}` };
  }
  return { code: 'internal', message: `the browser reported an error (${err instanceof Error ? err.name : 'unknown'})` };
}

// -------------------------------------------------------------------------------------------
// Dialog racing (click / type-with-Enter / select-option clicks / press)
// -------------------------------------------------------------------------------------------

/**
 * Races `run()` against a native dialog opening. If the dialog wins, returns `{ok:true,
 * navigated:false}` immediately and leaves a `.catch` on the dangling action promise so it never
 * becomes an unhandled rejection once the dialog is eventually dismissed / the page navigates.
 */
async function raceAgainstDialog(ctx: ActContext, run: () => Promise<void>): Promise<ActResult> {
  const actionSettled = run()
    .then(() => ({ settled: true as const }))
    .catch((err: unknown) => ({ settled: false as const, err }));
  const dialogWon = ctx.dialogOpened().then(() => ({ dialogWon: true as const }));
  const winner = await Promise.race([actionSettled, dialogWon]);
  if ('dialogWon' in winner) {
    void actionSettled.catch(() => undefined);
    return { ok: true, navigated: false };
  }
  if (!winner.settled) return { ok: false, error: mapPlaywrightError(winner.err) };
  return { ok: true, navigated: false };
}

// -------------------------------------------------------------------------------------------
// Navigation detection (click / type / select / press)
// -------------------------------------------------------------------------------------------

async function withNavigationDetection(ctx: ActContext, timeoutMs: number, fn: () => Promise<ActResult>): Promise<ActResult> {
  const startedAt = Date.now();
  let navigatedFrame: Frame | undefined;
  const onNav = (frame: Frame): void => {
    navigatedFrame = navigatedFrame ?? frame;
  };
  ctx.page.on('framenavigated', onNav);
  try {
    const result = await fn();
    await sleep(NAV_SETTLE_MS);
    if (navigatedFrame && !navigatedFrame.isDetached()) {
      const remaining = Math.max(1, timeoutMs - (Date.now() - startedAt));
      try {
        await navigatedFrame.waitForLoadState('domcontentloaded', { timeout: remaining });
      } catch {
        /* best effort: still report navigated:true below */
      }
      return { ...result, navigated: true };
    }
    return result;
  } finally {
    ctx.page.off('framenavigated', onNav);
  }
}

// -------------------------------------------------------------------------------------------
// Per-type actions
// -------------------------------------------------------------------------------------------

/**
 * The exact URL a web surface navigates to for `url`, or why it refuses. Resolution happens here,
 * once, and `goto` is handed the resulting href, never the raw string: a raw `\\host\share\x`
 * would be resolved by this check to an http URL on the page's origin but loaded by Chromium as a
 * UNC path (a `file:` page).
 *
 * Refused before any resolution: a backslash anywhere, and a leading `//` (see `urlShapeRefusal`).
 * Then the URL is resolved (an absolute one as written; a relative one against the current page if
 * it is http(s), else against the context's base URL, else refused) and must be `http:` or
 * `https:`. The one other URL allowed is the exact string `about:blank` (after the parser's
 * whitespace preprocessing), which the surface itself starts on; `ABOUT:BLANK` and every other
 * `about:` page are refused, deliberately. Anything else (a `desktop://` location, `file:`,
 * `javascript:`, an external-protocol handler) is refused whatever the policy says.
 */
export function resolveNavigation(url: string, currentUrl: string, baseUrl?: string): { ok: true; href: string } | { ok: false; reason: string } {
  const shape = urlShapeRefusal(url);
  if (shape !== undefined) return { ok: false, reason: shape };
  if (urlPreprocess(url) === 'about:blank') return { ok: true, href: 'about:blank' };
  const httpBase = (u: string | undefined): string | undefined => (u !== undefined && /^https?:/i.test(u) ? u : undefined);
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    const base = httpBase(currentUrl) ?? httpBase(baseUrl);
    if (base === undefined) return { ok: false, reason: `the relative URL '${url}' has no http(s) page or base URL to resolve against` };
    try {
      target = new URL(url, base);
    } catch {
      return { ok: false, reason: `'${url}' is not a URL` };
    }
  }
  if (target.protocol === 'http:' || target.protocol === 'https:') return { ok: true, href: target.href };
  return { ok: false, reason: `a web surface navigates only to http(s) URLs (and about:blank), not ${target.protocol} URLs` };
}

/** Why a web surface refuses `url` (see {@link resolveNavigation}), or undefined when it navigates. */
export function navigationRefusal(url: string, currentUrl: string, baseUrl?: string): string | undefined {
  const r = resolveNavigation(url, currentUrl, baseUrl);
  return r.ok ? undefined : r.reason;
}

async function performNavigate(ctx: ActContext, action: Extract<PageAction, { type: 'navigate' }>, timeoutMs: number): Promise<ActResult> {
  const resolved = resolveNavigation(action.url, ctx.page.url(), ctx.baseUrl);
  if (!resolved.ok) return { ok: false, error: { code: 'navigation_failed', message: resolved.reason } };
  try {
    // The checked URL, never the raw string.
    await ctx.page.goto(resolved.href, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    return { ok: true, navigated: true };
  } catch (err) {
    return { ok: false, error: mapPlaywrightError(err) };
  }
}

async function performClick(ctx: ActContext, action: Extract<PageAction, { type: 'click' }>, timeoutMs: number): Promise<ActResult> {
  const r = await ctx.lookup(action.target, timeoutMs);
  if (!r.ok) return { ok: false, error: { code: r.code, message: r.message } };
  const entry = r.entry;
  return withNavigationDetection(ctx, timeoutMs, async () => {
    try {
      await entry.handle.scrollIntoViewIfNeeded({ timeout: timeoutMs });
    } catch {
      /* best effort: click below still attempts even if scrolling failed */
    }
    return raceAgainstDialog(ctx, () => entry.handle.click({ timeout: timeoutMs }));
  });
}

async function fillOrTypeInto(entry: RefEntry, value: string, clear: boolean, timeoutMs: number): Promise<ActResult> {
  if (clear) {
    try {
      await entry.handle.fill(value, { timeout: timeoutMs });
      return { ok: true, navigated: false };
    } catch {
      // Masked/odd field that rejects fill(): click + select-all + type character by character.
      try {
        await entry.handle.click({ timeout: timeoutMs });
        await entry.handle.press('Control+A', { timeout: timeoutMs });
        await entry.frame.page().keyboard.type(value);
        return { ok: true, navigated: false };
      } catch (err2) {
        return { ok: false, error: mapPlaywrightError(err2) };
      }
    }
  }
  // clear === false: append rather than replace (fill() always clears, so it's not used here).
  try {
    await entry.handle.click({ timeout: timeoutMs });
    await entry.handle.press('End', { timeout: timeoutMs });
    await entry.frame.page().keyboard.type(value);
    return { ok: true, navigated: false };
  } catch (err) {
    return { ok: false, error: mapPlaywrightError(err) };
  }
}

async function performType(ctx: ActContext, action: Extract<PageAction, { type: 'type' }>, timeoutMs: number): Promise<ActResult> {
  const r = await ctx.lookup(action.target, timeoutMs);
  if (!r.ok) return { ok: false, error: { code: r.code, message: r.message } };
  const entry = r.entry;
  return withNavigationDetection(ctx, timeoutMs, async () => {
    const filled = await fillOrTypeInto(entry, action.value, action.clear !== false, timeoutMs);
    if (!filled.ok) return filled;
    if (action.pressEnter) {
      return raceAgainstDialog(ctx, () => entry.handle.press('Enter', { timeout: timeoutMs }));
    }
    return filled;
  });
}

/**
 * Finds a visible option-like element whose collapsed text equals `value`, preferring
 * descendants of the target, then of its parent (which also covers the target's next siblings),
 * then anywhere in the frame.
 */
async function findOptionElement(entry: RefEntry, value: string): Promise<ElementHandle<Element> | undefined> {
  const frame = entry.frame;
  await ensureAgent(frame).catch(() => undefined);
  const parentHandle = await entry.handle.evaluateHandle((el) => el.parentElement);
  const parentEl = parentHandle.asElement() as ElementHandle<Element> | null;
  const tiers: (ElementHandle<Element> | null)[] = [entry.handle, parentEl, null];

  for (const root of tiers) {
    let matches: ElementHandle<Element>[];
    try {
      matches = await findVisibleOptionsByText(frame, root, value);
    } catch {
      continue;
    }
    if (matches.length > 0) {
      for (const extra of matches.slice(1)) await extra.dispose().catch(() => undefined);
      return matches[0];
    }
  }
  return undefined;
}

async function performSelect(ctx: ActContext, action: Extract<PageAction, { type: 'select' }>, timeoutMs: number): Promise<ActResult> {
  const r = await ctx.lookup(action.target, timeoutMs);
  if (!r.ok) return { ok: false, error: { code: r.code, message: r.message } };
  const entry = r.entry;
  return withNavigationDetection(ctx, timeoutMs, async () => {
    const tag = await entry.handle.evaluate((el) => el.tagName.toLowerCase()).catch(() => '');
    if (tag === 'select') {
      try {
        await entry.handle.selectOption({ label: action.value }, { timeout: timeoutMs });
        return { ok: true, navigated: false };
      } catch {
        try {
          await entry.handle.selectOption({ value: action.value }, { timeout: timeoutMs });
          return { ok: true, navigated: false };
        } catch (err) {
          return { ok: false, error: mapPlaywrightError(err) };
        }
      }
    }
    // Custom dropdown: click the target to open it, then click the matching option-like element.
    const opened = await raceAgainstDialog(ctx, () => entry.handle.click({ timeout: timeoutMs }));
    if (!opened.ok) return opened;
    const option = await findOptionElement(entry, action.value);
    if (!option) {
      return { ok: false, error: { code: 'element_not_found', message: 'no matching option found for select target' } };
    }
    return raceAgainstDialog(ctx, () => option.click({ timeout: timeoutMs }));
  });
}

async function performPress(ctx: ActContext, action: Extract<PageAction, { type: 'press' }>, timeoutMs: number): Promise<ActResult> {
  // The key the guard classified: committing keys in their canonical name ("\r" and "Return" press
  // Enter), everything else as given (core `normalizeKeyName`, shared with the guard).
  return withNavigationDetection(ctx, timeoutMs, () => raceAgainstDialog(ctx, () => ctx.page.keyboard.press(normalizeKeyName(action.key))));
}

async function performExtract(ctx: ActContext, action: Extract<PageAction, { type: 'extract' }>, timeoutMs: number): Promise<ActResult> {
  const r = await ctx.lookup(action.target, timeoutMs);
  if (!r.ok) return { ok: false, error: { code: r.code, message: r.message } };
  return { ok: true, navigated: false };
}

/** Runs one page action and reports whether it also triggered a navigation. */
export async function performAction(ctx: ActContext, action: PageAction, timeoutMs: number): Promise<ActResult> {
  switch (action.type) {
    case 'navigate':
      return performNavigate(ctx, action, timeoutMs);
    case 'click':
      return performClick(ctx, action, timeoutMs);
    case 'type':
      return performType(ctx, action, timeoutMs);
    case 'select':
      return performSelect(ctx, action, timeoutMs);
    case 'press':
      return performPress(ctx, action, timeoutMs);
    case 'extract':
      return performExtract(ctx, action, timeoutMs);
    default: {
      const exhaustive: never = action;
      throw new Error(`performAction: unhandled action type ${JSON.stringify(exhaustive)}`);
    }
  }
}

// -------------------------------------------------------------------------------------------
// readText
// -------------------------------------------------------------------------------------------

type ReadInfo = { kind: 'password' } | { kind: 'value' | 'text'; value: string };

/** Reads an element's visible text or field value. Fails with `input_validation` for a password field. */
export async function readTextOf(entry: RefEntry, timeoutMs: number): Promise<ReadTextResult> {
  void timeoutMs;
  try {
    const info: ReadInfo = await entry.handle.evaluate((elRaw) => {
      const el = elRaw as HTMLElement;
      const tag = el.tagName.toLowerCase();
      if (tag === 'input') {
        const input = el as HTMLInputElement;
        if ((input.type || 'text').toLowerCase() === 'password') return { kind: 'password' as const };
        return { kind: 'value' as const, value: input.value };
      }
      if (tag === 'textarea') return { kind: 'value' as const, value: (el as HTMLTextAreaElement).value };
      if (tag === 'select') {
        const sel = el as HTMLSelectElement;
        const opt = sel.options[sel.selectedIndex];
        return { kind: 'value' as const, value: opt ? opt.text : '' };
      }
      return { kind: 'text' as const, value: el.innerText || el.textContent || '' };
    });
    if (info.kind === 'password') {
      return { ok: false, error: { code: 'input_validation', message: 'refusing to read a password field' } };
    }
    return { ok: true, text: collapseWhitespace(info.value) };
  } catch (err) {
    return { ok: false, error: mapPlaywrightError(err) };
  }
}

// -------------------------------------------------------------------------------------------
// readRecordText
// -------------------------------------------------------------------------------------------

/**
 * Visible text of an element's record container, or of its whole frame (see
 * `Surface.readRecordText`). The container is the smallest ancestor, below the body and within six
 * levels and 60 elements, that groups the element with at least two other text blocks (a card, a
 * detail panel, a table): the same shape the browser agent's record context uses. An element with
 * none gets the frame's text, with `scope: 'page'`. The text is real; the caller compares and drops it.
 */
export async function readRecordTextOf(entry: RefEntry, within: RecordTextWithin): Promise<RecordTextResult> {
  try {
    const info = await entry.handle.evaluate((elRaw, wanted) => {
      const el = elRaw as HTMLElement;
      const doc = el.ownerDocument;
      const hasWord = /[\p{L}\p{N}]/u;
      const direct = (x: Element): string =>
        Array.from(x.childNodes)
          .filter((n) => n.nodeType === 3)
          .map((n) => n.textContent || '')
          .join(' ');
      if (wanted === 'container') {
        let anc = el.parentElement;
        for (let depth = 0; anc && depth < 6; depth++, anc = anc.parentElement) {
          const tag = anc.tagName.toLowerCase();
          if (tag === 'body' || tag === 'html') break;
          const all = anc.getElementsByTagName('*');
          if (all.length > 60) break;
          let blocks = 0;
          for (let i = 0; i < all.length && blocks < 2; i++) {
            const x = all[i]!;
            if (x !== el && !el.contains(x) && !x.contains(el) && hasWord.test(direct(x))) blocks++;
          }
          if (blocks >= 2) return { scope: 'container' as const, text: (anc as HTMLElement).innerText || anc.textContent || '' };
        }
      }
      const root = doc.body ?? doc.documentElement;
      return { scope: 'page' as const, text: (root as HTMLElement).innerText || root.textContent || '' };
    }, within);
    return { ok: true, text: collapseWhitespace(info.text), scope: info.scope };
  } catch (err) {
    return { ok: false, error: mapPlaywrightError(err) };
  }
}

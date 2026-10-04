/**
 * Condition evaluation shared by every Surface implementation. `FakeSurface` and the Playwright
 * surface each build a `ConditionView` snapshot of their own current state and pass it to
 * `evaluateCondition`; nothing here knows about screens, frames, or any particular runtime.
 *
 * Non-obvious behavior:
 *  - `text_visible`/`text_absent` whitespace-collapse both sides and default to
 *    case-insensitive. A missing frame makes `text_visible` false and `text_absent` true: the
 *    text can't be found in a frame that doesn't exist either way.
 *  - `url_matches` and `dialog_open` compile their patterns with no implicit flags, matching the
 *    rule that regex sources inside a Capability compile with no flags (only Policy regexes get
 *    an implicit `i`).
 *  - An invalid regex throws a plain `Error`. Capability validation is expected to compile every
 *    regex ahead of time, so this throw is a last-resort guard, not the primary validation path.
 *  - An element condition never holds because of a position that settled an ambiguity. When the
 *    view reports how the target resolved (`ElementProbe`), a positional locator that won after a
 *    naming locator matched several candidates does not count as "the element is there"
 *    (`positionalFallbackRefusal`, rule (a)). It still counts as "something is there": the refusal
 *    never makes a condition TRUE. So `element_visible` is false on a refused resolution, and
 *    `element_absent` and `not element_visible` are false on it too.
 */
import type { Condition, FramePath, TargetDescriptor } from '../schema/index.js';
import { positionalFallbackRefusal } from './positional-fallback.js';
import type { TriedStrategy } from './types.js';

/** How a view resolved an element condition's target: not found, or which locator won and what missed before it. */
export type ElementProbe = { found: false } | { found: true; strategyIndex: number; tried: readonly TriedStrategy[] };

/**
 * A read-only snapshot of "what the page currently looks like", as a particular Surface sees
 * it. Built fresh by the Surface for each `check()` / `waitFor()` poll.
 */
export interface ConditionView {
  url: string;
  /** Whole-page visible text (all frames), whitespace-collapsed. */
  textDigest: string;
  /** Visible text restricted to a frame; undefined if the frame does not exist. */
  frameText(frame: FramePath): string | undefined;
  /** URL of a frame; undefined if the frame does not exist. Used by frame-scoped `url_matches`. */
  frameUrl(frame: FramePath): string | undefined;
  /**
   * Resolver callback: does the target currently resolve to exactly one visible element? A
   * surface returns the probe (which locator won, what missed before it), so a positional fallback
   * that settled an ambiguity can be refused; a plain boolean is taken as it is. May be async (a
   * live browser resolves asynchronously); `evaluateCondition` awaits it.
   */
  hasElement(target: TargetDescriptor): boolean | ElementProbe | Promise<boolean | ElementProbe>;
  dialog?: { type: 'alert' | 'confirm' | 'prompt'; message: string };
}

/** Options for {@link evaluateCondition}. */
export interface EvaluateConditionOptions {
  /** The condition before input binding, same shape (`CheckOptions.recorded`). */
  recorded?: Condition;
}

/** Collapse all whitespace runs (including newlines/tabs) to a single space and trim. */
export function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Whitespace-collapsed substring test. `exact: true` is case-sensitive; the default
 * (`false`) is case-insensitive. Both sides are collapsed before comparing, so authored
 * conditions don't need to worry about how a legacy page happens to wrap its markup.
 */
export function textContains(haystack: string, needle: string, exact = false): boolean {
  const h = collapseWhitespace(haystack);
  const n = collapseWhitespace(needle);
  if (exact) return h.includes(n);
  return h.toLowerCase().includes(n.toLowerCase());
}

function compileRegex(pattern: string, context: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`${context}: invalid regex pattern ${JSON.stringify(pattern)}: ${reason}`, { cause: err });
  }
}

/**
 * Is the element there? `strict`: a resolution the positional-fallback rule refuses does not
 * count. Not strict: any resolution counts. The caller picks whichever keeps a refusal from making
 * its condition true.
 */
async function elementFound(target: TargetDescriptor, recorded: TargetDescriptor | undefined, view: ConditionView, strict: boolean): Promise<boolean> {
  const probe = await view.hasElement(target);
  if (typeof probe === 'boolean') return probe;
  if (!probe.found) return false;
  if (!strict) return true;
  // Same chain, before binding; a recorded target of another shape is not this one.
  const asRecorded = recorded !== undefined && recorded.locators.length === target.locators.length ? recorded : target;
  return positionalFallbackRefusal(asRecorded, probe, { read: false }) === undefined;
}

/**
 * `positive`: the node sits under an even number of `not`s, so its being true helps the whole
 * condition hold. An element lookup is strict exactly where finding the element helps.
 */
async function evaluateNode(c: Condition, view: ConditionView, recorded: Condition | undefined, positive: boolean): Promise<boolean> {
  // The recorded tree is followed only while it has the bound tree's shape.
  const rec = recorded !== undefined && recorded.kind === c.kind ? recorded : undefined;
  switch (c.kind) {
    case 'text_visible': {
      const haystack = c.frame === undefined ? view.textDigest : view.frameText(c.frame);
      if (haystack === undefined) return false;
      return textContains(haystack, c.text, c.exact ?? false);
    }
    case 'text_absent': {
      const haystack = c.frame === undefined ? view.textDigest : view.frameText(c.frame);
      if (haystack === undefined) return true;
      return !textContains(haystack, c.text, false);
    }
    case 'element_visible':
      return elementFound(c.target, rec?.kind === 'element_visible' ? rec.target : undefined, view, positive);
    case 'element_absent':
      return !(await elementFound(c.target, rec?.kind === 'element_absent' ? rec.target : undefined, view, !positive));
    case 'url_matches': {
      const url = c.frame ? view.frameUrl(c.frame) : view.url;
      if (url === undefined) return false;
      return compileRegex(c.pattern, 'url_matches').test(url);
    }
    case 'dialog_open': {
      if (!view.dialog) return false;
      if (c.messagePattern === undefined) return true;
      return compileRegex(c.messagePattern, 'dialog_open.messagePattern').test(view.dialog.message);
    }
    case 'all': {
      const recOf = rec?.kind === 'all' && rec.of.length === c.of.length ? rec.of : undefined;
      for (let i = 0; i < c.of.length; i++) if (!(await evaluateNode(c.of[i]!, view, recOf?.[i], positive))) return false;
      return true;
    }
    case 'any': {
      const recOf = rec?.kind === 'any' && rec.of.length === c.of.length ? rec.of : undefined;
      for (let i = 0; i < c.of.length; i++) if (await evaluateNode(c.of[i]!, view, recOf?.[i], positive)) return true;
      return false;
    }
    case 'not':
      return !(await evaluateNode(c.of, view, rec?.kind === 'not' ? rec.of : undefined, !positive));
    default: {
      const exhaustive: never = c;
      throw new Error(`evaluateCondition: unhandled condition kind ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * Evaluates a condition against a view. Async because `hasElement` may be (Playwright).
 * `all`/`any` short-circuit in order, like `every`/`some`.
 */
export async function evaluateCondition(c: Condition, view: ConditionView, opts?: EvaluateConditionOptions): Promise<boolean> {
  return evaluateNode(c, view, opts?.recorded, true);
}

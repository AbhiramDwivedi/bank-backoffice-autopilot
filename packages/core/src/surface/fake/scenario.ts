/**
 * Scenario authoring for `FakeSurface`: element/screen specs, transition rules, and a fluent
 * builder to assemble them. See `surface.ts`'s file header for how these specs drive resolve,
 * observe and act at runtime (refs, visibility, injections).
 */
import type { ActionType, FailureCode, FramePath } from '../../schema/index.js';
import type { BBox } from '../types.js';

// ---------------------------------------------------------------------------------------------
// Scenario authoring types
// ---------------------------------------------------------------------------------------------

/** One element on a `FakeScreenSpec`. See the file header for how refs/visibility work. */
export interface FakeElementSpec {
  /** Scenario-author id, e.g. 'memberId'; used as the key in the values store. */
  id: string;
  /** ARIA role or a synthetic one ('clickable', 'generic', ...); see `REAL_ARIA_ROLES`. */
  role: string;
  /** Accessible name. */
  name: string;
  /** Visible text, if any. */
  text?: string;
  tag: string;
  /** Text of the associated `<label>`, or of an adjacent label cell for a FORM CONTROL (legacy
   *  table heuristic) -- mirrors production's `labelFor()`/`adjacentCellLabel()`
   *  (packages/browser-agent/src/naming.ts), which only ever associates a label with an
   *  `input`/`select`/`textarea`, never with a plain read-only `<td>`. Do not set this on a
   *  non-form-control value cell; use `rowAnchorText` for that (see below). */
  label?: string;
  /** The row's own anchor text for a `relative` locator (e.g. a label cell's text, "Savings
   *  Balance"), independent of `label`. Falls back to `label` when unset, so existing
   *  form-control specs (where the same text is both the field's label AND its row anchor) don't
   *  need to repeat it. Set this (not `label`) on a plain value cell whose row has a label cell
   *  to its left -- matches production's `rowAnchorText`/`aboveAnchorText`
   *  (packages/browser-agent/src/enumerate.ts), which is computed independently of any label
   *  association. */
  rowAnchorText?: string;
  /** Selectors this element matches; matched by exact string compare against a css locator. */
  css?: string[];
  /** Native automation identifier, matched exactly by an `automation_id` locator. */
  automationId?: string;
  /** Row key for same-row relative matching. */
  row?: string;
  /**
   * The record container this element sits in (a card, a detail panel): elements sharing the id
   * are one container, for `readRecordText`. An element with none has no container, so its
   * `container` read falls back to the whole screen.
   */
  container?: string;
  /** Viewport px, top-document coordinates (independent of `frame`). */
  bbox: BBox;
  /** Default `[]` (top document). */
  frame?: FramePath;
  inputType?: 'text' | 'password';
  value?: string;
  /** Default `true`. */
  enabled?: boolean;
  /** Default `false`. */
  hidden?: boolean;
  /**
   * Screen masking: the surface paints this element over. `observe()`, `describeRef()` and
   * `domSnapshot()` report its text/value as `[MASKED:<kind>]` (the string given here, or
   * `masked` for `true`) and replace its text wherever else the screen shows it; `readText()` and
   * conditions still see the real text, as a real masking surface does.
   */
  masked?: true | string;
}

/** One named screen in a scenario graph. */
export interface FakeScreenSpec {
  id: string;
  url: string;
  title: string;
  /** Extra visible text not tied to any element; always scoped to the top document ([]). */
  text?: string[];
  elements: FakeElementSpec[];
  frames?: { path: FramePath; url: string }[];
  /** Screen masking: on this screen `observe()` reports no screenshot and `screenshot()` returns the omitted placeholder. */
  omitScreenshot?: true;
  /** After `afterMs` on this screen (per the surface's clock), auto-transition to `to`. */
  autoAdvance?: { afterMs: number; to: string };
}

/** Where a `TransitionRule` sends the surface. */
export type TransitionTarget =
  | string
  | { dialog: { type: 'alert' | 'confirm' | 'prompt'; message: string }; onAccept?: string; onDismiss?: string }
  | { error: FailureCode; message?: string };

/** Read-only scenario state a rule's `when` guard or a `to` function can inspect. */
export interface TransitionContext {
  values: Readonly<Record<string, string>>;
  screenId: string;
}

/** What a `TransitionRule` matches against: the action type plus optional target/url/key fields. */
export interface TransitionMatch {
  actionType: ActionType;
  targetId?: string;
  targetName?: string;
  targetText?: string;
  url?: string | RegExp;
  key?: string;
}

/** One scenario transition: from a screen (or `'*'` for any), matching `match` and an optional
 * `when` guard, going `to` a screen, an unexpected dialog, or an error. */
export interface TransitionRule {
  from: string | '*';
  match: TransitionMatch;
  when?: (ctx: TransitionContext) => boolean;
  to: TransitionTarget | ((ctx: TransitionContext) => TransitionTarget);
}

/** A complete scenario graph: screens, transition rules, and scenario-wide defaults (viewport,
 * latency, the session-expired screen). */
export interface FakeScenario {
  initial: string;
  viewport?: { width: number; height: number };
  latencyMs?: number;
  sessionExpiredScreen?: string;
  screens: Record<string, FakeScreenSpec>;
  rules: TransitionRule[];
}

/** Viewport used when a scenario, or a `bbox` locator's normalization, doesn't specify one. */
export const DEFAULT_VIEWPORT: { width: number; height: number } = { width: 1280, height: 800 };

/** Fills in the defaults every element needs (`enabled`, `hidden`, `frame`) so scenario
 * authors don't have to repeat them. Purely a convenience; `FakeElementSpec` objects can also
 * be written out by hand. */
export function el(
  spec: Omit<FakeElementSpec, 'enabled' | 'hidden' | 'frame'> & Partial<Pick<FakeElementSpec, 'enabled' | 'hidden' | 'frame'>>,
): FakeElementSpec {
  return { enabled: true, hidden: false, frame: [], ...spec };
}

/**
 * Fluent scenario builder. Typical usage:
 *
 * ```ts
 * const built = scenario()
 *   .screen('login', { url: '...', title: '...', elements: [...] })
 *   .on('click', { targetId: 'signOn' })
 *     .when((ctx) => ctx.values.userId === 'operator1')
 *     .goto('workstation')
 *   .onAny('navigate', { url: '.../login' }).goto('login')
 *   .sessionExpiredAt('session_expired')
 *   .build();
 * ```
 *
 * `.screen(id, spec)` both registers the screen and becomes the implicit `from` for the next
 * `.on(...)` (use `.onAny(...)` or `.rule(...)` for a `from: '*'` rule). `.on()`/`.onAny()`
 * start a pending rule; `.when()` and `.goto()` complete it and push it onto the scenario --
 * `.goto()` must be the last call in the chain for that rule.
 */
export class ScenarioBuilder {
  private readonly screensMap = new Map<string, FakeScreenSpec>();
  private readonly rulesList: TransitionRule[] = [];
  private initialScreenId: string | undefined;
  private currentScreenId: string | undefined;
  private viewportSize: { width: number; height: number } | undefined;
  private latencyMsVal: number | undefined;
  private sessionExpiredScreenId: string | undefined;
  private pending: { from: string | '*'; match: TransitionMatch; when?: (ctx: TransitionContext) => boolean } | undefined;

  screen(id: string, spec: Omit<FakeScreenSpec, 'id'>): this {
    if (this.screensMap.has(id)) throw new Error(`scenario error: duplicate screen id '${id}'`);
    this.screensMap.set(id, { id, ...spec });
    if (this.initialScreenId === undefined) this.initialScreenId = id;
    this.currentScreenId = id;
    return this;
  }

  initial(id: string): this {
    this.initialScreenId = id;
    return this;
  }

  viewport(width: number, height: number): this {
    this.viewportSize = { width, height };
    return this;
  }

  latency(ms: number): this {
    this.latencyMsVal = ms;
    return this;
  }

  sessionExpiredAt(id: string): this {
    this.sessionExpiredScreenId = id;
    return this;
  }

  /** Starts a rule from the most recently added screen (see `.onAny()` for `from: '*'`). */
  on(actionType: ActionType, match: Omit<TransitionMatch, 'actionType'> = {}): this {
    this.pending = { from: this.currentScreenId ?? '*', match: { actionType, ...match } };
    return this;
  }

  /** Starts a rule with `from: '*'` (matches regardless of current screen). */
  onAny(actionType: ActionType, match: Omit<TransitionMatch, 'actionType'> = {}): this {
    this.pending = { from: '*', match: { actionType, ...match } };
    return this;
  }

  /** Overrides the pending rule's `from`. Must follow `.on()`/`.onAny()`. */
  from(screenId: string | '*'): this {
    if (!this.pending) throw new Error('scenario builder: from() must follow on()/onAny()');
    this.pending.from = screenId;
    return this;
  }

  /** Adds a guard to the pending rule. Must follow `.on()`/`.onAny()`. */
  when(predicate: (ctx: TransitionContext) => boolean): this {
    if (!this.pending) throw new Error('scenario builder: when() must follow on()/onAny()');
    this.pending.when = predicate;
    return this;
  }

  /** Completes and pushes the pending rule. Must follow `.on()`/`.onAny()`. */
  goto(target: TransitionTarget | ((ctx: TransitionContext) => TransitionTarget)): this {
    if (!this.pending) throw new Error('scenario builder: goto() must follow on()/onAny()');
    this.rulesList.push({ from: this.pending.from, match: this.pending.match, when: this.pending.when, to: target });
    this.pending = undefined;
    return this;
  }

  /** Escape hatch: push a fully-formed rule directly. */
  rule(r: TransitionRule): this {
    this.rulesList.push(r);
    return this;
  }

  build(): FakeScenario {
    if (this.pending) throw new Error("scenario error: an on()/onAny() rule was started but never finished with .goto(...)");
    if (this.screensMap.size === 0) throw new Error('scenario error: no screens defined');
    if (this.initialScreenId === undefined || !this.screensMap.has(this.initialScreenId)) {
      throw new Error(`scenario error: initial screen '${String(this.initialScreenId)}' is not defined`);
    }
    if (this.sessionExpiredScreenId !== undefined && !this.screensMap.has(this.sessionExpiredScreenId)) {
      throw new Error(`scenario error: sessionExpiredScreen '${this.sessionExpiredScreenId}' is not defined`);
    }
    for (const rule of this.rulesList) {
      if (rule.from !== '*' && !this.screensMap.has(rule.from)) {
        throw new Error(`scenario error: rule references unknown 'from' screen '${rule.from}'`);
      }
      if (typeof rule.to === 'string' && !this.screensMap.has(rule.to)) {
        throw new Error(`scenario error: rule references unknown 'to' screen '${rule.to}'`);
      }
    }
    return {
      initial: this.initialScreenId,
      viewport: this.viewportSize,
      latencyMs: this.latencyMsVal,
      sessionExpiredScreen: this.sessionExpiredScreenId,
      screens: Object.fromEntries(this.screensMap),
      rules: [...this.rulesList],
    };
  }
}

/** Starts a new fluent `ScenarioBuilder`. */
export function scenario(): ScenarioBuilder {
  return new ScenarioBuilder();
}

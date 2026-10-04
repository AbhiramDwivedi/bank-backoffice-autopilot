/**
 * Which steps of a capability sign in, and what proves the session is signed in.
 *
 * One pure rule, used in two places so they can never disagree: the recorder writes its result into
 * a new capability's `auth` block, and the `relogin` scripted operator derives the same thing at run
 * time for a capability recorded before the block existed. `validateCapability` holds an explicit
 * block to the same principles (see `checkAuthBlock` in validate.ts).
 *
 * Principle: **signing in does not depend on the run's inputs.** A sign-in step never binds an
 * `{kind:'input'}` value, never carries an `{input.x}` placeholder and is never an `extract`, so a
 * relogin can never re-run part of the business flow (a member search, a record click) unattended.
 *
 * The rule, over the capability's steps:
 *
 * 1. The first step must be a `navigate` (the entry navigation): re-running the sign-in has to start
 *    from a known page, not from wherever the expired session left the browser.
 * 2. The sign-in can only lie before the first step that depends on the run's inputs (or is an
 *    `extract`). Within that prefix, find the LAST secret-bound step (a `type`/`select` whose value
 *    is `{kind:'secret'}`): a two-page login (user, Next, password, Sign on) and a second factor
 *    typed before any business step both stay inside; a PIN typed later in the business flow, after
 *    the member search, is outside by construction. No secret in the prefix: no sign-in.
 * 3. The sign-in ends at the SUBMIT: the first `press Enter` (or the secret step itself if it types
 *    with `pressEnter`), or the first `click` on a control that is not a checkbox, radio button,
 *    switch or text field, after that last secret. A "remember me" box between the password and the
 *    Sign on button is therefore part of the sign-in, not its end.
 * 4. No step of the run may be `irreversible`: relogin re-runs it unattended.
 * 5. The signed-in condition is the submit step's own postcondition when it has one that does not
 *    depend on inputs; otherwise **the form is gone**: `not element_visible(<the target the last
 *    secret was typed into>)`, bounding-box locators dropped (a coordinate always hits something on
 *    the next page). That holds on a single-page login that never changes URL, and is false after a
 *    wrong password because the form re-renders. Its failure mode: an error page that drops the form
 *    also satisfies it (replay's next step then fails and escalates again, bounded).
 */
import type { AuthBlock, Capability } from './capability.js';
import type { Condition, Step } from './action.js';
import type { Locator, TargetDescriptor } from './locator.js';
import { collectInputPlaceholders } from './template.js';

/** A step that types or selects a `{kind:'secret'}` value. */
export function isSecretBound(step: Step): boolean {
  return (step.action.type === 'type' || step.action.type === 'select') && step.action.value.kind === 'secret';
}

/** A step whose behaviour depends on the run's inputs (an input binding or an `{input.x}` placeholder
 *  anywhere in it), or that reads a value off the page. Never part of a sign-in. */
export function dependsOnRunInputs(step: Step): boolean {
  if (step.action.type === 'extract') return true;
  if ((step.action.type === 'type' || step.action.type === 'select') && step.action.value.kind === 'input') return true;
  return collectInputPlaceholders(step).size > 0;
}

const NON_SUBMIT_ROLES = new Set(['checkbox', 'radio', 'switch', 'textbox', 'searchbox', 'combobox', 'listbox', 'spinbutton', 'slider', 'option']);
const NON_SUBMIT_TAGS = new Set(['select', 'textarea']);
const TOGGLE_OR_FIELD_CSS_RE = /type\s*=\s*["']?(checkbox|radio|text|password|email|search|number|tel)\b/i;

/** A click target that is a toggle or a text field rather than something that submits. */
function isToggleOrField(t: TargetDescriptor): boolean {
  const role = t.snapshot?.role?.toLowerCase();
  if (role !== undefined && NON_SUBMIT_ROLES.has(role)) return true;
  const tag = t.snapshot?.tag?.toLowerCase();
  if (tag !== undefined && NON_SUBMIT_TAGS.has(tag)) return true;
  return t.locators.some(
    (l) => (l.strategy.kind === 'role' && NON_SUBMIT_ROLES.has(l.strategy.role.toLowerCase())) || (l.strategy.kind === 'css' && TOGGLE_OR_FIELD_CSS_RE.test(l.strategy.selector)),
  );
}

/** A step that submits a form: Enter pressed, a typed value followed by Enter, or a click on a
 *  control that is not a toggle or a text field. */
export function isSubmitStep(step: Step): boolean {
  const a = step.action;
  if (a.type === 'press') return a.key === 'Enter';
  if (a.type === 'type') return a.pressEnter === true;
  if (a.type === 'click') return !isToggleOrField(a.target);
  return false;
}

/** `target` without its bounding-box locators, or undefined when nothing else is left. */
function withoutBbox(target: TargetDescriptor): TargetDescriptor | undefined {
  const locators: Locator[] = target.locators.filter((l) => l.strategy.kind !== 'bbox');
  if (locators.length === 0) return undefined;
  return { ...target, locators };
}

/** "The sign-in form is gone": the last secret's field is no longer visible. */
export function formGoneCondition(secretStep: Step): Condition | undefined {
  if (!('target' in secretStep.action)) return undefined;
  const target = withoutBbox(secretStep.action.target);
  return target === undefined ? undefined : { kind: 'not', of: { kind: 'element_visible', target } };
}

/** The auth block the rule in this file's header derives from `steps`, or undefined when none. */
export function deriveAuth(cap: Pick<Capability, 'steps'>): AuthBlock | undefined {
  const steps = cap.steps;
  if (steps[0]?.action.type !== 'navigate') return undefined;
  let boundary = steps.findIndex(dependsOnRunInputs);
  if (boundary < 0) boundary = steps.length;

  let lastSecret = -1;
  for (let i = 0; i < boundary; i++) if (isSecretBound(steps[i]!)) lastSecret = i;
  if (lastSecret < 0) return undefined;

  const secretStep = steps[lastSecret]!;
  let submit = -1;
  if (isSubmitStep(secretStep)) {
    submit = lastSecret;
  } else {
    for (let i = lastSecret + 1; i < boundary; i++) {
      if (isSubmitStep(steps[i]!)) {
        submit = i;
        break;
      }
    }
  }
  if (submit < 0) return undefined;

  const run = steps.slice(0, submit + 1);
  if (run.some((s) => s.risk === 'irreversible')) return undefined;

  const own = steps[submit]!.postcondition;
  const signedIn = own !== undefined && collectInputPlaceholders(own).size === 0 ? own : formGoneCondition(secretStep);
  if (signedIn === undefined) return undefined;
  return { steps: run.map((s) => s.id), signedIn };
}

/** The sign-in a run would re-execute: the steps themselves, the condition, and where it came from. */
export interface ResolvedAuth {
  /** `explicit`: the capability's own `auth` block. `derived`: {@link deriveAuth}. */
  source: 'explicit' | 'derived';
  steps: Step[];
  signedIn: Condition;
}

/**
 * The capability's sign-in, from its `auth` block or else derived by the same rule the recorder
 * uses. `cap` is the capability as the run sees it (a tenant override already applied): an explicit
 * block's steps are taken from its first through its last id in that order, so an override's extra
 * step inserted inside the sign-in is re-run too. Undefined when there is no block, none can be
 * derived, or an explicit block names a step `cap` does not have.
 */
export function resolveAuth(cap: Pick<Capability, 'steps' | 'auth'>): ResolvedAuth | undefined {
  if (cap.auth !== undefined) {
    const ids = cap.auth.steps;
    const first = cap.steps.findIndex((s) => s.id === ids[0]);
    const last = cap.steps.findIndex((s) => s.id === ids[ids.length - 1]);
    if (first < 0 || last < first) return undefined;
    return { source: 'explicit', steps: cap.steps.slice(first, last + 1), signedIn: cap.auth.signedIn };
  }
  const derived = deriveAuth(cap);
  if (derived === undefined) return undefined;
  return { source: 'derived', steps: cap.steps.slice(0, derived.steps.length), signedIn: derived.signedIn };
}

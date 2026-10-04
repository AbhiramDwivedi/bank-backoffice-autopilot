/**
 * Input templating.
 *
 * Any string inside a Capability may contain placeholders:
 *   - `{baseUrl}`       -> the app base URL for this invocation
 *   - `{input.<name>}`  -> the invocation's value for a declared input
 *
 * Placeholders are resolved at replay time, immediately before a step runs, by `bindStep`.
 * Sensitive inputs are still bound here (the surface needs the real value); it is the
 * evidence sink's job to redact, never this module's. Unknown placeholders throw so that a
 * mis-declared capability fails loudly instead of typing "{input.memberId}" into a bank system.
 */
import type { Action, Condition, Step, TargetDescriptor, ValueBinding } from './index.js';

/** Values available to `bindTemplate` and friends when resolving placeholders. */
export interface BindContext {
  baseUrl: string;
  inputs: Record<string, string | number | boolean>;
  /** Resolves a secret binding's credential name (typically `CredentialSet.get`). Omitted: every
   *  secret binding is unavailable and binding it throws. */
  secret?: (env: string) => string | undefined;
}

const PLACEHOLDER_RE = /\{(baseUrl|input\.([A-Za-z_][A-Za-z0-9_]*))\}/g;

/** Thrown when a template references an unknown placeholder: an `{input.x}` name not present in
 * `ctx.inputs`. */
export class UnboundPlaceholderError extends Error {
  constructor(public readonly placeholder: string) {
    super(`unbound placeholder ${placeholder}`);
    this.name = 'UnboundPlaceholderError';
  }
}

/**
 * Escapes every JS regex metacharacter so a substituted value is matched as a literal
 * substring, never as regex syntax. Used for values bound into a `url_matches` pattern or a
 * `dialog_open.messagePattern`, where an unescaped accountId of `.*` would turn
 * `/accounts/{input.accountId}$` into "matches anything".
 */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A regex matching `value` literally as a whole token: never immediately preceded or followed by
 * an ASCII letter or digit, so "Active" does not match inside "Inactive" and "12345" does not
 * match inside "123456".
 */
export function wholeTokenRegex(value: string, flags = 'g'): RegExp {
  return new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(value)}(?![A-Za-z0-9])`, flags);
}

/**
 * Escapes a value for literal inclusion anywhere inside a CSS selector. Implements the WHATWG
 * CSSOM `CSS.escape()` algorithm: every character outside `[a-zA-Z0-9_-]` (plus a few
 * leading-digit/lone-hyphen special cases) is emitted as a backslash-escaped literal.
 *
 * This is safe both for an unquoted identifier position (`#{escaped}`) and for a value sitting
 * inside a quoted attribute selector (`[data-id="{escaped}"]`): per the CSS syntax spec, a
 * backslash followed by any character is an "escaped code point" denoting that literal
 * character, and this rule is applied by the tokenizer identically inside and outside quoted
 * strings. So escaping `"`, `\`, `]`, `)`, `,`, `*`, whitespace, etc. this way can never
 * terminate a string early or introduce a new selector, regardless of which of the two contexts
 * the placeholder happens to sit in -- unlike, say, only escaping `"` and `\`, which would leave
 * an *unquoted* substitution (e.g. `input[name={input.x}]`) exploitable.
 */
export function cssEscape(s: string): string {
  const length = s.length;
  let result = '';
  for (let i = 0; i < length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x0000) {
      result += String.fromCharCode(0xfffd);
      continue;
    }
    if (
      (c >= 0x0001 && c <= 0x001f) ||
      c === 0x007f ||
      (i === 0 && c >= 0x0030 && c <= 0x0039) ||
      (i === 1 && c >= 0x0030 && c <= 0x0039 && s.charCodeAt(0) === 0x002d)
    ) {
      result += `\\${c.toString(16)} `;
      continue;
    }
    if (i === 0 && length === 1 && c === 0x002d) {
      result += `\\${s[i]}`;
      continue;
    }
    if (c >= 0x0080 || c === 0x002d || c === 0x005f || (c >= 0x0030 && c <= 0x0039) || (c >= 0x0041 && c <= 0x005a) || (c >= 0x0061 && c <= 0x007a)) {
      result += s[i];
      continue;
    }
    result += `\\${s[i]}`;
  }
  return result;
}

/**
 * Core placeholder substitution. `escape`, when given, is applied to each substituted value
 * (both `{baseUrl}` and `{input.x}`) before it is spliced in -- this is what makes the binder
 * "field-aware": plain-text fields (locator names/labels/texts, description, literal values) call
 * `bindTemplate` with no escape (default identity), while regex-typed and selector-typed fields
 * call the field-specific wrapper below instead.
 */
export function bindTemplate(s: string, ctx: BindContext, escape: (value: string) => string = (v) => v): string {
  return s.replace(PLACEHOLDER_RE, (whole, key: string, inputName: string | undefined) => {
    if (key === 'baseUrl') return escape(ctx.baseUrl);
    if (inputName !== undefined && inputName in ctx.inputs) return escape(String(ctx.inputs[inputName]));
    throw new UnboundPlaceholderError(whole);
  });
}

/**
 * Binds a string that is compiled as a regex source (`dialog_open.messagePattern`; a
 * `url_matches.pattern` goes through {@link bindUrlPattern}): every substituted value is
 * regex-escaped, so it can only ever
 * match itself literally, never change the pattern's structure (extra alternation, an unanchored
 * `.*`, an unbalanced group, ...).
 */
export function bindPattern(s: string, ctx: BindContext): string {
  return bindTemplate(s, ctx, escapeRegExp);
}

/**
 * Regex source matching one input value the way a browser may report it inside a URL: the raw
 * value, its percent-encoded form (`encodeURIComponent`, so a space is `%20`), and its
 * form-encoded forms (a space is `+`), each regex-escaped, deduplicated, as one non-capturing
 * alternation. A value no encoding changes binds as the escaped value alone.
 */
export function urlValuePattern(value: string): string {
  const percent = encodeURIComponent(value);
  const forms = [value, percent, percent.replace(/%20/g, '+'), new URLSearchParams([['', value]]).toString().slice(1)];
  const unique = [...new Set(forms)].map(escapeRegExp);
  return unique.length === 1 ? unique[0]! : `(?:${unique.join('|')})`;
}

/**
 * Binds a `url_matches` pattern: like {@link bindPattern}, except each `{input.x}` value is bound
 * as {@link urlValuePattern}, so a URL carrying the value percent- or form-encoded (`Mary+Ann`,
 * `O%20Brien`) still matches. `{baseUrl}` is regex-escaped as is.
 */
export function bindUrlPattern(s: string, ctx: BindContext): string {
  return s.replace(PLACEHOLDER_RE, (whole, key: string, inputName: string | undefined) => {
    if (key === 'baseUrl') return escapeRegExp(ctx.baseUrl);
    if (inputName !== undefined && inputName in ctx.inputs) return urlValuePattern(String(ctx.inputs[inputName]));
    throw new UnboundPlaceholderError(whole);
  });
}

/**
 * Binds a `css` locator's selector string: every substituted value is CSS-escaped (see
 * `cssEscape`), so it can only ever match as a literal identifier/attribute-value fragment,
 * never break out into a fresh compound/complex selector (a comma to add a second selector, a
 * `*` universal selector, a `]`/`)` to close the enclosing construct early, ...).
 */
export function bindCssSelector(s: string, ctx: BindContext): string {
  return bindTemplate(s, ctx, cssEscape);
}

/** Resolves a `ValueBinding` to its runtime string value. Throws if an `input` binding names an
 * undeclared input, or if `ctx.secret` cannot resolve a `secret` binding's credential name. */
export function bindValue(v: ValueBinding, ctx: BindContext): string {
  switch (v.kind) {
    case 'literal':
      return bindTemplate(v.value, ctx);
    case 'input': {
      if (!(v.name in ctx.inputs)) throw new UnboundPlaceholderError(`{input.${v.name}}`);
      return String(ctx.inputs[v.name]);
    }
    case 'secret': {
      // No resolver means the run supplied no credentials: the secret is unavailable. Core never
      // falls back to the process environment; the env CredentialProvider is the caller's choice.
      const val = ctx.secret?.(v.env);
      if (val === undefined || val === '') throw new Error(`credential ${v.env} is not available to this run`);
      return val;
    }
  }
}

/** Binds every templated string inside a `TargetDescriptor` (description and each locator),
 * returning a new descriptor; does not mutate `t`. */
export function bindDescriptor(t: TargetDescriptor, ctx: BindContext): TargetDescriptor {
  return {
    ...t,
    description: bindTemplate(t.description, ctx),
    locators: t.locators.map((l) => {
      const s = l.strategy;
      switch (s.kind) {
        case 'role':
          return { ...l, strategy: { ...s, name: bindTemplate(s.name, ctx) } };
        case 'label':
          return { ...l, strategy: { ...s, label: bindTemplate(s.label, ctx) } };
        case 'text':
          return { ...l, strategy: { ...s, text: bindTemplate(s.text, ctx) } };
        case 'relative':
          return {
            ...l,
            strategy: {
              ...s,
              anchor: {
                ...s.anchor,
                text: bindTemplate(s.anchor.text, ctx),
                ...(s.anchor.selector !== undefined ? { selector: bindCssSelector(s.anchor.selector, ctx) } : {}),
              },
              ...(s.selector !== undefined ? { selector: bindCssSelector(s.selector, ctx) } : {}),
              ...(s.within !== undefined ? { within: bindCssSelector(s.within, ctx) } : {}),
            },
          };
        case 'css':
          return { ...l, strategy: { ...s, selector: bindCssSelector(s.selector, ctx) } };
        case 'automation_id':
          return { ...l, strategy: { ...s, id: bindTemplate(s.id, ctx) } };
        case 'bbox':
          return l;
      }
    }),
  };
}

/** Recursively binds every templated string inside a `Condition` tree, returning a new tree;
 * does not mutate `c`. */
export function bindCondition(c: Condition, ctx: BindContext): Condition {
  switch (c.kind) {
    case 'text_visible':
    case 'text_absent':
      return { ...c, text: bindTemplate(c.text, ctx) };
    case 'element_visible':
    case 'element_absent':
      return { ...c, target: bindDescriptor(c.target, ctx) };
    case 'url_matches':
      return { ...c, pattern: bindUrlPattern(c.pattern, ctx) };
    case 'dialog_open':
      return c.messagePattern !== undefined ? { ...c, messagePattern: bindPattern(c.messagePattern, ctx) } : c;
    case 'all':
    case 'any':
      return { ...c, of: c.of.map((x) => bindCondition(x, ctx)) };
    case 'not':
      return { ...c, of: bindCondition(c.of, ctx) };
  }
}

/**
 * An Action after binding: templated strings resolved and `value` narrowed to a plain string,
 * which is what a SurfaceAction carries.
 */
export type BoundAction =
  | Exclude<Action, { type: 'type' } | { type: 'select' }>
  | (Omit<Extract<Action, { type: 'type' }>, 'value'> & { value: string })
  | (Omit<Extract<Action, { type: 'select' }>, 'value'> & { value: string });

/** Binds every templated string in an `Action`, narrowing `value` to a plain string for
 * `type`/`select`. */
export function bindAction(a: Action, ctx: BindContext): BoundAction {
  switch (a.type) {
    case 'navigate':
      return { ...a, url: bindTemplate(a.url, ctx) };
    case 'click':
      return { ...a, target: bindDescriptor(a.target, ctx) };
    case 'type':
      return { ...a, target: bindDescriptor(a.target, ctx), value: bindValue(a.value, ctx) };
    case 'select':
      return { ...a, target: bindDescriptor(a.target, ctx), value: bindValue(a.value, ctx) };
    case 'press':
      return a;
    case 'extract':
      return { ...a, target: bindDescriptor(a.target, ctx) };
    case 'wait':
      return { ...a, condition: bindCondition(a.condition, ctx) };
    case 'dismiss_dialog':
      return a;
    case 'switch_frame':
      return a;
  }
}

/** A `Step` after binding; see {@link BoundAction}. */
export interface BoundStep extends Omit<Step, 'action' | 'precondition' | 'postcondition'> {
  action: BoundAction;
  precondition?: Condition;
  postcondition?: Condition;
}

/** Binds an entire `Step` (action, precondition, postcondition) against `ctx`, immediately
 * before it runs. */
export function bindStep(step: Step, ctx: BindContext): BoundStep {
  return {
    ...step,
    action: bindAction(step.action, ctx),
    precondition: step.precondition ? bindCondition(step.precondition, ctx) : undefined,
    postcondition: step.postcondition ? bindCondition(step.postcondition, ctx) : undefined,
  };
}

/** Collect every `{input.x}` placeholder name appearing anywhere in a JSON-like value. */
export function collectInputPlaceholders(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (typeof value === 'string') {
    for (const m of value.matchAll(PLACEHOLDER_RE)) if (m[2]) out.add(m[2]);
  } else if (Array.isArray(value)) {
    for (const v of value) collectInputPlaceholders(v, out);
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) collectInputPlaceholders(v, out);
  }
  return out;
}

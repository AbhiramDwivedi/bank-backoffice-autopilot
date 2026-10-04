import { z } from 'zod';
import { Identifier, NonEmpty } from './common.js';
import { FramePath, TargetDescriptor } from './locator.js';

/** How a step resolves a value at replay time: from capability inputs, a literal, or a named
 * credential. */
export const ValueBinding = z.discriminatedUnion('kind', [
  /** From capability inputs at invocation. */
  z.strictObject({ kind: z.literal('input'), name: Identifier }),
  z.strictObject({ kind: z.literal('literal'), value: z.string() }),
  /** `env` is the credential's NAME, resolved at runtime by whichever CredentialProvider the run
   *  uses (environment variables by default, hence the field name); the value is never persisted. */
  z.strictObject({ kind: z.literal('secret'), env: z.string().regex(/^[A-Z_][A-Z0-9_]*$/, 'must be an env var name') }),
]);
export type ValueBinding = z.infer<typeof ValueBinding>;

/** Recursive condition tree. Declared as a TS type first because zod cannot infer recursion. */
export type Condition =
  | { kind: 'text_visible'; text: string; frame?: FramePath; exact?: boolean }
  | { kind: 'text_absent'; text: string; frame?: FramePath }
  | { kind: 'element_visible'; target: TargetDescriptor }
  | { kind: 'element_absent'; target: TargetDescriptor }
  | { kind: 'url_matches'; pattern: string; frame?: FramePath }
  | { kind: 'dialog_open'; messagePattern?: string }
  | { kind: 'all'; of: Condition[] }
  | { kind: 'any'; of: Condition[] }
  | { kind: 'not'; of: Condition };

export const Condition: z.ZodType<Condition> = z
  .lazy(() =>
    z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('text_visible'), text: NonEmpty, frame: FramePath.optional(), exact: z.boolean().optional() }),
      z.strictObject({ kind: z.literal('text_absent'), text: NonEmpty, frame: FramePath.optional() }),
      z.strictObject({ kind: z.literal('element_visible'), target: TargetDescriptor }),
      z.strictObject({ kind: z.literal('element_absent'), target: TargetDescriptor }),
      /** Regex source, tested against the full URL of the top document, or of `frame` when given (framesets hide the content frame's URL). */
      z.strictObject({ kind: z.literal('url_matches'), pattern: NonEmpty, frame: FramePath.optional() }),
      /** Native alert/confirm/prompt. */
      z.strictObject({ kind: z.literal('dialog_open'), messagePattern: z.string().optional() }),
      z.strictObject({ kind: z.literal('all'), of: z.array(Condition).min(1) }),
      z.strictObject({ kind: z.literal('any'), of: z.array(Condition).min(1) }),
      z.strictObject({ kind: z.literal('not'), of: Condition }),
    ]),
  )
  .meta({ id: 'Condition' });

/** How a raw extracted string is parsed before it becomes an output value. */
export const ParseMode = z.enum(['text', 'number', 'currency', 'regex']);
export type ParseMode = z.infer<typeof ParseMode>;

/** Navigates to `url`, which may contain {baseUrl} and {input.name} placeholders. */
export const NavigateAction = z.strictObject({ type: z.literal('navigate'), url: NonEmpty });
/** Clicks a resolved target. */
export const ClickAction = z.strictObject({ type: z.literal('click'), target: TargetDescriptor });
/** Types `value` into a resolved target; `clear` empties it first, `pressEnter` submits via
 * Enter afterward. */
export const TypeAction = z.strictObject({
  type: z.literal('type'),
  target: TargetDescriptor,
  value: ValueBinding,
  clear: z.boolean().optional(),
  pressEnter: z.boolean().optional(),
});
/** Native <select> or custom dropdown (surface decides). */
export const SelectAction = z.strictObject({ type: z.literal('select'), target: TargetDescriptor, value: ValueBinding });
/** Presses a single key, not tied to any target. */
export const PressAction = z.strictObject({ type: z.literal('press'), key: NonEmpty });
/**
 * A record identity check on a read: the value of the declared input `input` must be visible in
 * the record container of the element read. `within: 'container'` is the smallest ancestor that
 * groups the element with at least two other text blocks (a card, a detail panel, a table);
 * `within: 'page'` is the whole frame, recorded when the element has no such ancestor (a record's
 * own page). The input is named, never quoted: its value is bound at replay and compared as a
 * whole token. Recorded only when the container showed the input at record time.
 */
export const ExtractIdentity = z.strictObject({ input: Identifier, within: z.enum(['container', 'page']) });
export type ExtractIdentity = z.infer<typeof ExtractIdentity>;
/** Reads a value from a resolved target into `output`, optionally parsed via `parse`/`pattern`.
 *  `identity`, when present, is checked before the value is returned. */
export const ExtractAction = z.strictObject({
  type: z.literal('extract'),
  target: TargetDescriptor,
  output: Identifier,
  parse: ParseMode.optional(),
  pattern: z.string().optional(),
  identity: ExtractIdentity.optional(),
});
/** Waits up to `timeoutMs` (default {@link DEFAULT_STEP_TIMEOUT_MS}) for `condition` to hold. */
export const WaitAction = z.strictObject({ type: z.literal('wait'), condition: Condition, timeoutMs: z.number().int().positive().optional() });
/** Accepts or dismisses a native dialog; `promptText` fills a prompt() before accepting. */
export const DismissDialogAction = z.strictObject({ type: z.literal('dismiss_dialog'), accept: z.boolean(), promptText: z.string().optional() });
/** Rarely needed; targets carry frame paths. */
export const SwitchFrameAction = z.strictObject({ type: z.literal('switch_frame'), frame: FramePath });

/** All `Action` variant schemas, in the order passed to `z.discriminatedUnion`. */
export const ACTION_VARIANTS = [
  NavigateAction,
  ClickAction,
  TypeAction,
  SelectAction,
  PressAction,
  ExtractAction,
  WaitAction,
  DismissDialogAction,
  SwitchFrameAction,
] as const;

/** Discriminated union of every action a capability step, recovery rule, or scripted operator
 * can perform. */
export const Action = z.discriminatedUnion('type', ACTION_VARIANTS).meta({ id: 'Action' });
export type Action = z.infer<typeof Action>;

/** The `type` discriminator values of {@link Action}. */
export const ActionType = z.enum(['navigate', 'click', 'type', 'select', 'press', 'extract', 'wait', 'dismiss_dialog', 'switch_frame']);
export type ActionType = z.infer<typeof ActionType>;
/** `ActionType`'s options, in declaration order. */
export const ACTION_TYPES: readonly ActionType[] = ActionType.options;

/** How consequential an action is: `read` (no side effects), `reversible`, or `irreversible`. */
export const RiskClass = z.enum(['read', 'reversible', 'irreversible']);
export type RiskClass = z.infer<typeof RiskClass>;
/** Total order over {@link RiskClass}, for comparing or raising risk levels. */
export const RISK_ORDER: Readonly<Record<RiskClass, number>> = { read: 0, reversible: 1, irreversible: 2 };

/** Default `Step.timeoutMs` when a step does not specify one, in milliseconds. */
export const DEFAULT_STEP_TIMEOUT_MS = 10_000;

/** One action within a capability, with its risk class and optional pre/postconditions. */
export const Step = z
  .strictObject({
    /** "s01" */
    id: NonEmpty,
    /** "Enter member ID" */
    name: NonEmpty,
    action: Action,
    /** Must hold before acting, else hard_failure: precondition_failed. */
    precondition: Condition.optional(),
    /** Checkpoint after acting, else hard_failure: checkpoint_failed. */
    postcondition: Condition.optional(),
    risk: RiskClass,
    /** Default 10000 (DEFAULT_STEP_TIMEOUT_MS). */
    timeoutMs: z.number().int().positive().optional(),
    /** Default 'fail'. */
    onFailure: z.enum(['fail', 'escalate']).optional(),
  })
  .meta({ id: 'Step' });
export type Step = z.infer<typeof Step>;

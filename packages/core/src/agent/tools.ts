/**
 * Tool definitions the discovery agent offers the model, plus a validator that turns a raw
 * `{name, input}` tool_use block into a typed `ToolCall`. Tool schemas are flat.
 *
 * Schemas are authored as zod objects (so parseToolCall can validate against the same source of
 * truth) and converted to strict-compatible JSON Schema via zod v4's `z.toJSONSchema`: every
 * property required, `additionalProperties: false`, no `$schema` wrapper (stripped before the
 * schema is handed to the model).
 */
import { z } from 'zod';
import { Identifier } from '../schema/index.js';
import type { LlmToolDef } from './types.js';

// ---------------------------------------------------------------------------------------------
// Shared field schemas
// ---------------------------------------------------------------------------------------------

/** An observation ref, e.g. "e12". Only valid for the turn it was shown in. */
const Ref = z.string().min(1, 'ref must not be empty');
/** Short, imperative description of the action; becomes the recorded step's name. */
const Why = z.string().min(1, 'why must not be empty');
/** Text expected to be visible after the action, verbatim from the app; "" if none specific. */
const Expect = z.string();
/** Where a typed/selected value comes from: a declared input name, a secret env name, or fixed literal text. */
const ValueSource = z.enum(['input', 'secret', 'literal']);
/** How to parse extracted text. (A subset of the schema's ParseMode: no 'regex' here -- the
 *  model never authors a regex pattern.) */
const ExtractParseMode = z.enum(['text', 'number', 'currency']);

// ---------------------------------------------------------------------------------------------
// Per-tool input schemas
// ---------------------------------------------------------------------------------------------

const ClickInput = z.strictObject({
  ref: Ref,
  why: Why,
  expect: Expect,
});

const TypeInput = z.strictObject({
  ref: Ref,
  source: ValueSource,
  /** The declared input NAME, the secret env NAME, or the literal text itself -- never a raw credential value. */
  value: z.string().min(1, 'value must not be empty'),
  why: Why,
  expect: Expect,
});

const SelectInput = z.strictObject({
  ref: Ref,
  source: ValueSource,
  value: z.string().min(1, 'value must not be empty'),
  why: Why,
  expect: Expect,
});

const PressInput = z.strictObject({
  key: z.string().min(1, 'key must not be empty'),
  why: Why,
  expect: Expect,
});

const NavigateInput = z.strictObject({
  url: z.string().min(1, 'url must not be empty'),
  why: Why,
  expect: Expect,
});

const DismissDialogInput = z.strictObject({
  accept: z.boolean(),
  why: Why,
});

const DismissInterstitialInput = z.strictObject({
  /** The control that dismisses the notice. */
  ref: Ref,
  /** Distinctive text of the notice, verbatim from the app. */
  trigger_text: z.string().min(1, 'trigger_text must not be empty'),
  /** The notice's own heading/title text if it has one, verbatim; "" if it has none. Used only to
   *  name the recorded recovery rule -- never derived from `trigger_text`, which is typically the
   *  notice's longer body copy and would make an unstable, run-on rule name. */
  title: z.string(),
  why: Why,
});

const ExtractInput = z.strictObject({
  ref: Ref,
  /** Identifier the extracted value is recorded under. */
  output: Identifier,
  parse: ExtractParseMode,
  why: Why,
});

const DeclareOutcomeReturn = z.strictObject({
  output: Identifier,
  ref: Ref,
  parse: ExtractParseMode,
  description: z.string().min(1, 'description must not be empty'),
});

const DeclareOutcomeInput = z.strictObject({
  /** snake_case, e.g. "member_not_found". */
  name: Identifier,
  description: z.string().min(1, 'description must not be empty'),
  /** Exact message text the app displayed, verbatim. */
  detector_text: z.string().min(1, 'detector_text must not be empty'),
  returns: z.array(DeclareOutcomeReturn),
});

const DoneInput = z.strictObject({
  /** A short, stable label/text visible on the final screen -- a field label, not a run-specific value. */
  success_text: z.string().min(1, 'success_text must not be empty'),
  summary: z.string().min(1, 'summary must not be empty'),
});

const StuckInput = z.strictObject({
  reason: z.string().min(1, 'reason must not be empty'),
});

// ---------------------------------------------------------------------------------------------
// ToolCall discriminated union
// ---------------------------------------------------------------------------------------------

/** Discriminated union of every action the model can take, keyed by `tool`. */
export type ToolCall =
  | ({ tool: 'click' } & z.infer<typeof ClickInput>)
  | ({ tool: 'type' } & z.infer<typeof TypeInput>)
  | ({ tool: 'select' } & z.infer<typeof SelectInput>)
  | ({ tool: 'press' } & z.infer<typeof PressInput>)
  | ({ tool: 'navigate' } & z.infer<typeof NavigateInput>)
  | ({ tool: 'dismiss_dialog' } & z.infer<typeof DismissDialogInput>)
  | ({ tool: 'dismiss_interstitial' } & z.infer<typeof DismissInterstitialInput>)
  | ({ tool: 'extract' } & z.infer<typeof ExtractInput>)
  | ({ tool: 'declare_outcome' } & z.infer<typeof DeclareOutcomeInput>)
  | ({ tool: 'done' } & z.infer<typeof DoneInput>)
  | ({ tool: 'stuck' } & z.infer<typeof StuckInput>);

/** Valid values of `ToolCall['tool']`. */
export type ToolName = ToolCall['tool'];

// ---------------------------------------------------------------------------------------------
// Tool definitions (name + description + strict JSON schema)
// ---------------------------------------------------------------------------------------------

/** Converts a zod object schema to a strict-compatible JSON Schema: draft 2020-12 shape with
 *  the `$schema` wrapper stripped (tool schemas are embedded, not standalone documents). */
function toolSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: 'draft-2020-12' }) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

interface ToolSpec {
  name: ToolName;
  description: string;
  schema: z.ZodType;
}

const TOOL_SPECS: readonly ToolSpec[] = [
  {
    name: 'click',
    description:
      'Click an interactive element identified by its observation ref (a button, link, tab, row, ' +
      'or any other clickable control). Use this for ordinary navigation and selection clicks -- ' +
      'not for dismissing a blocking notice/banner (use dismiss_interstitial) or a native browser ' +
      'dialog (use dismiss_dialog).',
    schema: ClickInput,
  },
  {
    name: 'type',
    description:
      'Type a value into a text field identified by its observation ref, replacing any existing ' +
      'content. Set `source` to "input" and `value` to the declared input\'s NAME to type run data ' +
      '(never invent it yourself); "secret" and `value` to an allowed environment variable NAME to ' +
      'type a credential (its real value is filled in only when the action runs and is never shown ' +
      'to you); or "literal" and `value` to the exact fixed text for anything else non-sensitive.',
    schema: TypeInput,
  },
  {
    name: 'select',
    description:
      'Choose an option in a dropdown or option list identified by its observation ref. Same ' +
      '`source`/`value` rules as `type`.',
    schema: SelectInput,
  },
  {
    name: 'press',
    description: 'Press a single keyboard key (e.g. "Enter", "Escape") without a specific target element.',
    schema: PressInput,
  },
  {
    name: 'navigate',
    description: 'Load a URL directly, instead of clicking through the page.',
    schema: NavigateInput,
  },
  {
    name: 'dismiss_dialog',
    description:
      'Accept or dismiss a dialog that the current observation reports is open: a native browser ' +
      'dialog (alert/confirm/prompt), or a desktop application\'s modal dialog window. ' +
      '`accept: true` accepts it (e.g. clicks OK); `accept: false` cancels it.',
    schema: DismissDialogInput,
  },
  {
    name: 'dismiss_interstitial',
    description:
      'Dismiss a notice, banner, or modal that is blocking the flow but is not part of the goal ' +
      '(e.g. a maintenance announcement). `ref` is the control that closes it (often an "OK" or ' +
      'close button); `trigger_text` is distinctive text of the notice itself, copied verbatim ' +
      '(often the notice\'s longer body copy); `title` is the notice\'s own short heading/title ' +
      'text if it has one, copied verbatim (e.g. "System Maintenance Notice") -- "" if it has ' +
      'none. This is recorded as a recovery step, not a step in the main path, so the discovered ' +
      'capability keeps working whether or not the notice appears on a later run.',
    schema: DismissInterstitialInput,
  },
  {
    name: 'extract',
    description:
      'Read a piece of data off the screen from the element identified by `ref` and record it ' +
      'under the identifier `output`. Prefer the element holding the value over its label. Use the declared output ' +
      'name when the goal specifies one. `parse` controls how the raw text is interpreted: "text" ' +
      'keeps it as trimmed text, "number" strips non-numeric characters, "currency" strips currency ' +
      'formatting (and treats parentheses as negative).',
    schema: ExtractInput,
  },
  {
    name: 'declare_outcome',
    description:
      'Record that the application produced a legitimate business result that is not the goal you ' +
      'were asked to reach -- a "not found", a permission denial, a validation error, or similar. ' +
      '`name` is a short snake_case identifier (e.g. "member_not_found"), `detector_text` is the ' +
      'exact message text the app displayed, and `returns` lists any data fields this outcome makes ' +
      'available, each with the ref of the element it can be read from.',
    schema: DeclareOutcomeInput,
  },
  {
    name: 'done',
    description:
      'Declare the goal complete: the requested data is visible on screen and every declared output ' +
      'has been extracted. `success_text` must be a short, stable label or heading visible on the ' +
      'final screen (a field label, not a value specific to this run); `summary` briefly describes ' +
      'what was accomplished.',
    schema: DoneInput,
  },
  {
    name: 'stuck',
    description:
      'Give up: nothing available on screen advances the goal, or you have exhausted reasonable ' +
      'attempts. `reason` explains why, for a human to read.',
    schema: StuckInput,
  },
];

const SPECS_BY_NAME: ReadonlyMap<string, ToolSpec> = new Map(TOOL_SPECS.map((s) => [s.name, s]));

export const TOOL_DEFS: LlmToolDef[] = TOOL_SPECS.map((s) => ({
  name: s.name,
  description: s.description,
  input_schema: toolSchema(s.schema),
}));

// ---------------------------------------------------------------------------------------------
// parseToolCall
// ---------------------------------------------------------------------------------------------

function formatZodError(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`).join('; ');
}

/** Result of {@link parseToolCall}: a validated `ToolCall`, or a readable error message. */
export type ParseToolCallResult = { ok: true; call: ToolCall } | { ok: false; error: string };

/** Validates a raw `{name, input}` tool_use block against the matching tool's schema and
 *  returns a typed `ToolCall` (field `tool`), or a readable error describing what was wrong. */
export function parseToolCall(block: { name: string; input: unknown }): ParseToolCallResult {
  const spec = SPECS_BY_NAME.get(block.name);
  if (!spec) {
    return { ok: false, error: `unknown tool "${block.name}"` };
  }
  const parsed = spec.schema.safeParse(block.input);
  if (!parsed.success) {
    return { ok: false, error: `invalid input for tool "${block.name}": ${formatZodError(parsed.error)}` };
  }
  return { ok: true, call: { tool: spec.name, ...(parsed.data as object) } as ToolCall };
}

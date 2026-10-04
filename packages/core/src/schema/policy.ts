import { z } from 'zod';
import { NonEmpty } from './common.js';
import { ActionType } from './action.js';

/**
 * What a surface hides from its screenshots, DOM snapshots and observed text before anything
 * leaves it (docs/design/screen-masking.md). Every field has a default, so a policy without the
 * block, or with only some fields, parses; the defaults are at least as strict as the behaviour
 * before the block existed (every typed field and every password masked, plus every other filled
 * field and every pattern match).
 */
export const ScreenMaskPolicy = z
  .strictObject({
    /** all = every text-like input/textarea/select/contenteditable is painted, empty or not (covers
     *  what a human types during handoff); typed = only the fields the automation typed into, plus passwords. */
    maskInputs: z.enum(['all', 'typed']).default('all'),
    /** CSS selectors always painted over. */
    maskSelectors: z.array(NonEmpty).default([]),
    /** Regex sources, each matched against a WHOLE label (as `^(?:source)$`): the value associated with a
     *  matching label (cell, `<label for>`, dt/dd, caption, column header, an inline `Label:` in a line) is painted. */
    maskLabels: z.array(NonEmpty).default([]),
    /** Paint any element whose own text matches `redaction.patterns` or contains one of the run's secret/sensitive values. */
    maskTextPatterns: z.boolean().default(true),
    /** Regex sources matched against the top document's and every frame's URL: no screenshot is taken on a match. */
    omitScreenshotUrlPatterns: z.array(NonEmpty).default([]),
  })
  .meta({ id: 'ScreenMaskPolicy' });
/** The resolved `redaction.screen` block a surface adapter honours (every default filled in). */
export type ScreenMaskConfig = z.output<typeof ScreenMaskPolicy>;

/** `redaction.screen` with every default applied, for a policy that omits the block or some of its fields. */
export function resolveScreenMask(screen: z.input<typeof ScreenMaskPolicy> | undefined): ScreenMaskConfig {
  return ScreenMaskPolicy.parse(screen ?? {});
}

/**
 * Judgment-based risk check layered over the lexical patterns (docs/design/risk-judge.md).
 * Optional so every existing policy file and hand-built `Policy` keeps parsing and type-checking;
 * `resolveRiskJudgeConfig` (policy module) fills the defaults when the block is absent. Inside a
 * present block every field also has a default, so `judge: { mode: advise }` is enough.
 */
export const RiskJudgeConfig = z.strictObject({
  /** off: never consulted. advise: judged and logged, decision unchanged. enforce: may raise risk. */
  mode: z.enum(['off', 'advise', 'enforce']).default('enforce'),
  /** pIrreversible at or above this counts as irreversible. */
  irreversibleThreshold: z.number().min(0).max(1).default(0.5),
  /** What an unavailable judge (error, timeout, malformed answer) means for the action. */
  onError: z.enum(['fail_closed', 'fail_open']).default('fail_closed'),
  /** Per-judgment budget, retries included. */
  timeoutMs: z.number().int().positive().default(5000),
});
export type RiskJudgeConfig = z.infer<typeof RiskJudgeConfig>;

/**
 * Guardrail policy.
 * Convention: every regex source in a Policy is compiled by consumers with the 'i' flag
 * (case-insensitive) and no others. Write sources without inline flags.
 */
export const Policy = z
  .strictObject({
    name: NonEmpty,
    /** Exact origins: "http://localhost:4173". */
    allowedOrigins: z.array(z.url()).min(1),
    /** Regex sources matched against pathname; empty = all paths on allowed origins. */
    allowedPathPatterns: z.array(z.string()),
    /** Wins over allowed. */
    deniedPathPatterns: z.array(z.string()),
    allowedActions: z.array(ActionType),
    risk: z.strictObject({
      /** Regex sources matched against target name/text. */
      irreversibleTextPatterns: z.array(z.string()),
      irreversibleUrlPatterns: z.array(z.string()),
      /** What discovery does when about to take an irreversible action. */
      discoveryMode: z.enum(['block', 'escalate']),
      /** Irreversible steps only run if capability.status === 'approved'. */
      replayRequiresApproved: z.boolean(),
      /** Judgment-based risk check at record/audit time; never consulted by replay. */
      judge: RiskJudgeConfig.optional(),
    }),
    redaction: z.strictObject({
      patterns: z.array(z.strictObject({ name: NonEmpty, regex: NonEmpty, replacement: z.string().optional() })),
      /** Screen masking; absent = every default (see ScreenMaskPolicy and resolveScreenMask). */
      screen: ScreenMaskPolicy.optional(),
    }),
    limits: z.strictObject({
      maxSteps: z.number().int().positive(),
      maxDurationMs: z.number().int().positive(),
      maxLlmCalls: z.number().int().positive(),
      /**
       * Replay: how many times one run may retry after a transient `app_error`, each time
       * restarting its steps (docs/design/replay.md, "Retrying a transient app error"). Only a
       * read-only run retries at all. Optional so existing policy files keep parsing; absent means
       * replay's own default (2). 0 disables the retry.
       */
      maxAppErrorRetries: z.number().int().min(0).optional(),
    }),
  })
  .meta({ id: 'Policy' });
export type Policy = z.infer<typeof Policy>;

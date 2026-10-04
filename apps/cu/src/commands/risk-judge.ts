/**
 * The one place the CLI turns `--risk-judge` and the environment into a `RiskJudge` adapter
 * (docs/design/risk-judge.md). Imported by `discover.ts`, `audit.ts` and the offline-runnable eval
 * script (`judge-eval.ts`) only: the composition root (`runtime/`), the catalog and `replay.ts` must
 * never reach it, which `packages/core/src/replay/no-llm.redteam.test.ts` pins.
 *
 * `auto` picks Claude when `ANTHROPIC_API_KEY` is set (always the case for `discover`, which needs
 * that key anyway), else Jev when `TYPESAFE_API_KEY` is set, else no judge. Claude first, for two
 * reasons: the default then sends page text to no vendor the run does not already use, and on the
 * labelled eval set the Claude judge caught every irreversible action on its first run, while Jev
 * needed a question reworded after a miss (docs/design/risk-judge.md). `jev` selects Jev explicitly.
 */
import { createAnthropicJudge } from '@cu/adapter-anthropic';
import { createJevJudge } from '@cu/adapter-jev';
import { resolveRiskJudgeConfig, type RiskJudge } from '@cu/core/policy';
import type { Policy } from '@cu/core/schema';

/** Values `--risk-judge` accepts. */
export const RISK_JUDGE_CHOICES = ['auto', 'jev', 'anthropic', 'off'] as const;
/** One of {@link RISK_JUDGE_CHOICES}. */
export type RiskJudgeChoice = (typeof RISK_JUDGE_CHOICES)[number];

/** Env var holding the TypeSafe (Jev) key. */
export const JEV_KEY_ENV = 'TYPESAFE_API_KEY';

/** Adapter constructors, injectable so tests never build a real client. */
export interface RiskJudgeFactories {
  jev(apiKey: string): RiskJudge;
  anthropic(): RiskJudge;
}

const REAL_FACTORIES: RiskJudgeFactories = {
  jev: (apiKey) => createJevJudge({ apiKey }),
  anthropic: () => createAnthropicJudge(),
};

/** What `--risk-judge` resolved to: a judge (or deliberately none) with a label, or a refusal. */
export type ResolvedRiskJudge = { ok: true; judge?: RiskJudge; label: string } | { ok: false; error: string };

function present(v: string | undefined): v is string {
  return v !== undefined && v.trim() !== '';
}

/** Resolves `--risk-judge <choice>` against `env`. An explicit `jev`/`anthropic` without its key is
 *  a refusal, never a silent downgrade to lexical-only. */
export function resolveRiskJudge(choice: RiskJudgeChoice, env: NodeJS.ProcessEnv = process.env, factories: RiskJudgeFactories = REAL_FACTORIES): ResolvedRiskJudge {
  const jevKey = env[JEV_KEY_ENV];
  const anthropicKey = env.ANTHROPIC_API_KEY;
  switch (choice) {
    case 'off':
      return { ok: true, label: 'off (--risk-judge off: lexical patterns only)' };
    case 'jev':
      if (!present(jevKey)) return { ok: false, error: `--risk-judge jev needs ${JEV_KEY_ENV} to be set` };
      return withLabel(factories.jev(jevKey));
    case 'anthropic':
      if (!present(anthropicKey)) return { ok: false, error: '--risk-judge anthropic needs ANTHROPIC_API_KEY to be set' };
      return withLabel(factories.anthropic());
    case 'auto':
      if (present(anthropicKey)) return withLabel(factories.anthropic());
      if (present(jevKey)) return withLabel(factories.jev(jevKey));
      return { ok: true, label: `off (no ANTHROPIC_API_KEY or ${JEV_KEY_ENV} set: lexical patterns only)` };
  }
}

function withLabel(judge: RiskJudge): ResolvedRiskJudge {
  return { ok: true, judge, label: judge.id };
}

/** The line a run prints at start: which judge is active and how the policy uses it. */
export function riskJudgeBanner(resolved: { judge?: RiskJudge; label: string }, policy: Pick<Policy, 'risk'>): string {
  if (resolved.judge === undefined) return `risk judge: ${resolved.label}`;
  const cfg = resolveRiskJudgeConfig(policy);
  if (cfg.mode === 'off') return `risk judge: off (policy risk.judge.mode is off; ${resolved.label} not consulted)`;
  return `risk judge: ${resolved.label} (${cfg.mode}, irreversible at p >= ${cfg.irreversibleThreshold}, ${cfg.onError}, ${cfg.timeoutMs}ms)`;
}

/** The operator-facing line for an unavailable judge, printed the first time it happens in a run. */
export function riskJudgeUnavailableLine(info: { judge: string; reason: string; onError: 'fail_closed' | 'fail_open' }): string {
  const effect =
    info.onError === 'fail_closed'
      ? 'fail_closed: every committing action it could not judge is treated as irreversible and escalates to a human (or is refused in block mode)'
      : 'fail_open: actions it could not judge keep their lexical risk';
  return `risk judge ${info.judge} is unavailable (${info.reason}); ${effect}. Re-run with --risk-judge off to proceed on the lexical patterns only.`;
}

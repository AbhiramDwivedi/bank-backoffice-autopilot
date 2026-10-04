/**
 * `cu audit <artifact.json> [--risk-judge auto|jev|anthropic|off] [--apply] [--out <path>]` --
 * judges every committing action of an existing capability, statically, and reports any the judge
 * (or the policy's own patterns) rates riskier than declared. See docs/design/risk-judge.md.
 *
 * Three kinds of recorded action are audited, each row marked with its origin:
 * - `step`: the base steps.
 * - `override`: tenant overrides' `extraSteps`.
 * - `recovery`: recovery-rule actions. These replay automatically, outside the approval gate,
 *   so they matter most; they have no risk field and must be read/reversible in effect.
 *
 * The judge sees what the artifact says about each action: the target's description, record-time
 * snapshot and locator texts, a stated reason (the step name; for a recovery action the rule's
 * name and description), the page it most likely runs on (the last navigate before it; the entry
 * URL for a recovery action, which can fire anywhere), and the capability's name and description.
 * Every string goes through the policy's redaction patterns first. No browser is started.
 *
 * Non-obvious decisions:
 * - Only actions that can commit something are judged (`isJudgeableAction`), and only when neither
 *   the declared risk nor the lexical patterns already say irreversible: those cannot go higher.
 * - The policy's `risk.judge.mode` does not gate an audit (running one is the explicit request),
 *   but its threshold and timeout apply. Under the default `--risk-judge auto` with no key for
 *   any judge, the audit refuses (exit 3) rather than pass on the patterns alone; a lexical-only
 *   audit needs an explicit `--risk-judge off`.
 * - An unavailable judge is reported per row and makes the audit incomplete. `--apply` then
 *   writes nothing at all: a partial raise would bump the version and read as a full audit.
 *   Fail-closed is a run-time behaviour; an audit rewrite must rest on actual judgments.
 * - `--apply` only ever raises: a base step's `risk` (and `onFailure: 'escalate'` when raised to
 *   irreversible), an override extra step's `risk` below irreversible; then bumps the patch
 *   version, resets `status` to `draft` (a deprecated capability stays deprecated), appends a
 *   provenance note, re-validates, and writes `--out` (default: in place).
 * - Two findings cannot be applied, and are reported as `needs-human` (exit 2): an irreversible
 *   recovery action (a recovery rule has no risk to raise; a human must remove or rework it), and
 *   an override extra step judged irreversible (`validateCapability` rejects an irreversible
 *   override step, because it would run under the base capability's approval).
 * - Everything printed is stripped of control characters: rationales are third-party text and
 *   artifact strings are not trusted to be terminal-safe.
 *
 * Exit codes: 0 clean (or `--apply` wrote every fixable raise and nothing needs a human); 1 bad
 * input or a failed write; 2 something is riskier than declared and is not (or cannot be) fixed
 * by this run; 3 incomplete -- the judge could not judge every action (with `--apply`: nothing
 * written), or no judge was available under `auto`.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { Command, Option } from 'commander';
import { globalsOf } from '../globals.js';
import {
  combineRisk,
  createGuardedJudge,
  createPolicyGuard,
  isJudgeableAction,
  judgeRequestForAction,
  loadPolicy,
  resolveRiskJudgeConfig,
  staticLexicalRisk,
  staticPageUrl,
  type RiskJudge,
} from '@cu/core/policy';
import { createRedactor, redactionPatternsFromPolicy } from '@cu/core/evidence';
import { RISK_ORDER, validateCapability, type Action, type Capability, type CapabilityIssue, type Policy, type RiskClass, type Step } from '@cu/core/schema';
import { RISK_JUDGE_CHOICES, resolveRiskJudge, riskJudgeBanner, type RiskJudgeChoice } from './risk-judge.js';

/** Exit code: something is riskier than declared and was not fixed by this run. */
export const AUDIT_RISKIER_EXIT_CODE = 2;
/** Exit code: incomplete -- the judge could not judge everything, or no judge was available. */
export const AUDIT_INCOMPLETE_EXIT_CODE = 3;

/** Where an audited action lives in the capability. */
export type AuditOrigin = 'step' | 'override' | 'recovery';

/** One audited action. */
export interface AuditRow {
  origin: AuditOrigin;
  /** `s07`; `riverbend-fcu/x01` (override tenant/step); `dismiss_notice#1` (rule name, action no.). */
  id: string;
  name: string;
  action: Action['type'];
  /** Declared risk; absent for a recovery action (which has none, and must be read/reversible). */
  declared?: RiskClass;
  lexical: RiskClass;
  /** What the judgment alone maps to; absent when the action was not sent to a judge. */
  judged?: RiskClass;
  /** max(lexical, judged): what the action should declare. */
  effective: RiskClass;
  pIrreversible?: number;
  rationale?: string;
  /** `riskier`: `--apply` can raise it. `needs-human`: it cannot be applied (see file header). */
  status: 'ok' | 'riskier' | 'needs-human' | 'unavailable';
  /** Why it was not sent, why the judge could not answer, or what a human must do. */
  note?: string;
}

/** Inputs to `runAudit`, gathered from CLI flags and globals. */
export interface RunAuditOptions {
  artifactPath: string;
  riskJudge: RiskJudgeChoice;
  apply: boolean;
  out?: string;
  /** `--policy` (globals). */
  policy: string;
}

/** Injectable collaborators, so tests never build a real adapter. */
export interface RunAuditDeps {
  /** Injected judge; `null` = run lexical-only (as `--risk-judge off`). Absent = resolve
   *  `--risk-judge` from the environment. */
  judge?: RiskJudge | null;
  policy?: Policy;
  print?: (line: string) => void;
  printError?: (line: string) => void;
  clock?: () => Date;
}

/** Outcome of `runAudit`. */
export interface RunAuditResult {
  exitCode: number;
  rows: AuditRow[];
  /** Where `--apply` wrote the raised capability. */
  written?: string;
}

function maxRisk(a: RiskClass, b: RiskClass): RiskClass {
  return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b;
}

/** '1.0.1' -> '1.0.2'; any prerelease/build metadata is dropped. */
function bumpPatch(version: string): string {
  const m = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) throw new Error(`bumpPatch: not a valid semver version: ${version}`);
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

function formatIssues(issues: CapabilityIssue[]): string[] {
  return issues.map((issue) => `  ${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: [${issue.code}] ${issue.message}`);
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Replaces C0/C1 control characters (ANSI escapes, carriage returns, ...) with spaces. */
export function terminalSafe(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
}

/** Renders rows as a fixed-width table. */
export function formatAuditTable(rows: readonly AuditRow[]): string[] {
  const header = ['origin', 'id', 'action', 'declared', 'lexical', 'judged', 'p', 'status', 'rationale'];
  const body = rows.map((r) => [
    r.origin,
    truncate(`${r.id} ${r.name}`, 40),
    r.action,
    r.declared ?? '-',
    r.lexical,
    r.judged ?? '-',
    r.pIrreversible !== undefined ? r.pIrreversible.toFixed(2) : '-',
    r.status === 'riskier' ? `RISKIER -> ${r.effective}` : r.status === 'needs-human' ? `NEEDS HUMAN (${r.effective})` : r.status,
    truncate(r.rationale ?? r.note ?? '', 90),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((row) => row[i]!.length)));
  const line = (cells: string[]): string => cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]!))).join('  ').trimEnd();
  return [line(header), line(widths.map((w) => '-'.repeat(w))), ...body.map(line)];
}

/** One recorded action to audit, wherever it lives. */
interface AuditItem {
  origin: AuditOrigin;
  id: string;
  name: string;
  action: Action;
  declared?: RiskClass;
  why: string;
  pageUrl: string;
}

function auditItems(cap: Capability): AuditItem[] {
  const items: AuditItem[] = cap.steps.map((s, i) => ({ origin: 'step', id: s.id, name: s.name, action: s.action, declared: s.risk, why: s.name, pageUrl: staticPageUrl(cap, i) }));
  for (const o of cap.overrides ?? []) {
    for (const es of o.extraSteps ?? []) {
      const after = cap.steps.findIndex((s) => s.id === es.afterStepId);
      const pageUrl = after >= 0 ? staticPageUrl(cap, after + 1) : (o.entryUrl ?? cap.app.entryUrl);
      items.push({ origin: 'override', id: `${o.tenant}/${es.step.id}`, name: es.step.name, action: es.step.action, declared: es.step.risk, why: es.step.name, pageUrl });
    }
  }
  for (const rule of cap.recoveryRules) {
    rule.actions.forEach((a, k) => {
      items.push({ origin: 'recovery', id: `${rule.name}#${k + 1}`, name: rule.description, action: a, why: `${rule.name}: ${rule.description}`, pageUrl: cap.app.entryUrl });
    });
  }
  return items;
}

/** What `--apply` cannot do for an irreversible finding, per origin. */
function needsHumanNote(origin: AuditOrigin): string {
  return origin === 'recovery'
    ? 'recovery rules replay automatically, outside the approval gate, and have no risk to raise: a human must remove or rework this rule'
    : 'a tenant override cannot carry an irreversible step (validateCapability rejects it): move it into the base capability as a new, separately approved version, or remove it';
}

/**
 * Audits the capability at `opts.artifactPath` against the risk judge (and the policy's lexical
 * patterns), prints a table, and with `opts.apply` raises what can be raised.
 */
export async function runAudit(opts: RunAuditOptions, deps: RunAuditDeps = {}): Promise<RunAuditResult> {
  const rawPrint = deps.print ?? ((line: string) => console.log(line));
  const rawPrintError = deps.printError ?? ((line: string) => console.error(line));
  const print = (line: string): void => rawPrint(terminalSafe(line));
  const printError = (line: string): void => rawPrintError(terminalSafe(line));
  const clock = deps.clock ?? ((): Date => new Date());

  // --- 1. Inputs ---------------------------------------------------------------------------
  if (opts.out !== undefined && !opts.apply) {
    printError('cu audit: --out only applies with --apply');
    return { exitCode: 1, rows: [] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(opts.artifactPath, 'utf8'));
  } catch (err) {
    printError(`cu audit: could not read/parse ${opts.artifactPath}: ${err instanceof Error ? err.message : String(err)}`);
    return { exitCode: 1, rows: [] };
  }
  const validated = validateCapability(raw);
  if (!validated.ok) {
    printError(`cu audit: ${opts.artifactPath} is not a valid capability:`);
    formatIssues(validated.issues).forEach(printError);
    return { exitCode: 1, rows: [] };
  }
  const cap = validated.capability;

  let policy: Policy;
  try {
    policy = deps.policy ?? loadPolicy(opts.policy);
  } catch (err) {
    printError(`cu audit: could not load policy ${opts.policy}: ${err instanceof Error ? err.message : String(err)}`);
    return { exitCode: 1, rows: [] };
  }

  let judge: RiskJudge | undefined;
  let label: string;
  if (deps.judge !== undefined) {
    judge = deps.judge ?? undefined;
    label = deps.judge?.id ?? 'off (lexical patterns only)';
  } else {
    const resolved = resolveRiskJudge(opts.riskJudge);
    if (!resolved.ok) {
      printError(`cu audit: ${resolved.error}`);
      return { exitCode: 1, rows: [] };
    }
    if (resolved.judge === undefined && opts.riskJudge === 'auto') {
      printError(
        'cu audit: no risk judge is available (set ANTHROPIC_API_KEY or TYPESAFE_API_KEY); refusing to report a judge audit ' +
          'with zero judgments. Pass --risk-judge off for a lexical-only audit.',
      );
      return { exitCode: AUDIT_INCOMPLETE_EXIT_CODE, rows: [] };
    }
    judge = resolved.judge;
    label = resolved.label;
  }
  // An audit is an explicit request: the policy's mode does not gate it; threshold and timeout do.
  const config = { ...resolveRiskJudgeConfig(policy), mode: 'enforce' as const };
  printError(`cu audit: ${riskJudgeBanner({ ...(judge !== undefined ? { judge } : {}), label }, { risk: { ...policy.risk, judge: config } })}`);

  // --- 2. Judge every committing action ----------------------------------------------------
  const guard = createPolicyGuard(policy);
  const guarded = judge !== undefined ? createGuardedJudge(judge, { timeoutMs: config.timeoutMs }) : undefined;
  const redactor = createRedactor({ patterns: redactionPatternsFromPolicy(policy.redaction.patterns) });
  const scrub = (s: string): string => {
    const r = redactor(s);
    return typeof r === 'string' ? r : s;
  };

  const rows: AuditRow[] = [];
  for (const item of auditItems(cap)) {
    if (!isJudgeableAction(item.action)) continue;
    const lexical = staticLexicalRisk(guard, item, item.pageUrl);
    // A recovery action has no declared risk; it must be read/reversible in effect.
    const declaredForCompare: RiskClass = item.declared ?? 'reversible';
    const base = { origin: item.origin, id: item.id, name: item.name, action: item.action.type, ...(item.declared !== undefined ? { declared: item.declared } : {}), lexical };
    const classify = (effective: RiskClass): Pick<AuditRow, 'status' | 'note'> => {
      if (RISK_ORDER[effective] <= RISK_ORDER[declaredForCompare]) return { status: 'ok' };
      if (effective === 'irreversible' && item.origin !== 'step') return { status: 'needs-human', note: needsHumanNote(item.origin) };
      return { status: 'riskier' };
    };

    if (declaredForCompare === 'irreversible' || lexical === 'irreversible') {
      const effective = maxRisk(declaredForCompare, lexical);
      const c = classify(effective);
      rows.push({ ...base, effective, ...c, note: c.note ?? 'already irreversible; not sent to the judge' });
      continue;
    }
    if (guarded === undefined) {
      const c = classify(lexical);
      rows.push({ ...base, effective: lexical, ...c, note: c.note ?? 'no judge: lexical patterns only' });
      continue;
    }
    const req = judgeRequestForAction(cap, item.action, item.why, item.pageUrl, lexical, scrub)!;
    const outcome = await guarded.judge(req);
    if (outcome.kind === 'unavailable') {
      rows.push({ ...base, effective: lexical, status: 'unavailable', note: `judge unavailable: ${scrub(outcome.reason)}` });
      continue;
    }
    const combo = combineRisk(lexical, outcome, config);
    const c = classify(combo.risk);
    rows.push({
      ...base,
      ...(combo.judgedRisk !== undefined ? { judged: combo.judgedRisk } : {}),
      effective: combo.risk,
      pIrreversible: outcome.judgment.pIrreversible,
      ...(outcome.judgment.rationale !== undefined ? { rationale: scrub(outcome.judgment.rationale) } : {}),
      ...c,
    });
  }

  // --- 3. Report ----------------------------------------------------------------------------
  const counts = { step: 0, override: 0, recovery: 0 };
  for (const r of rows) counts[r.origin] += 1;
  print(
    `audit: ${cap.id}@${cap.version} (${cap.status}), ${rows.length} committing action(s): ${counts.step} step, ` +
      `${counts.override} override extra step, ${counts.recovery} recovery; judge ${label}`,
  );
  if (rows.length > 0) formatAuditTable(rows).forEach(print);
  if (guarded !== undefined) print(`risk judge calls: ${guarded.calls} (cache hits ${guarded.cacheHits}, unavailable ${guarded.unavailable})`);

  const riskier = rows.filter((r) => r.status === 'riskier');
  const needsHuman = rows.filter((r) => r.status === 'needs-human');
  const unavailable = rows.filter((r) => r.status === 'unavailable');
  for (const r of needsHuman) print(`audit: ${r.origin} ${r.id} is judged ${r.effective}: ${r.note ?? ''}`);
  if (unavailable.length > 0) print(`audit: could not judge ${unavailable.length} action(s): ${unavailable.map((r) => `${r.origin} ${r.id}`).join(', ')}`);
  if (riskier.length > 0) print(`audit: ${riskier.length} action(s) riskier than declared: ${riskier.map((r) => `${r.id} ${r.declared ?? '-'} -> ${r.effective}`).join(', ')}`);
  if (riskier.length === 0 && needsHuman.length === 0) {
    print(unavailable.length > 0 ? 'audit: incomplete; nothing found riskier than declared among the actions judged' : 'audit: nothing is riskier than it declares');
  }

  if (!opts.apply) {
    if (riskier.length > 0) print('audit: re-run with --apply to raise them (the capability goes back to draft and needs re-approval)');
    if (riskier.length + needsHuman.length > 0) return { exitCode: AUDIT_RISKIER_EXIT_CODE, rows };
    return { exitCode: unavailable.length > 0 ? AUDIT_INCOMPLETE_EXIT_CODE : 0, rows };
  }

  // --- 4. --apply: raise, never lower, only on a complete audit -----------------------------
  if (unavailable.length > 0) {
    print('audit: --apply wrote nothing: the audit is incomplete, and a partial raise would read as a full one. Re-run when the judge is available.');
    return { exitCode: AUDIT_INCOMPLETE_EXIT_CODE, rows };
  }
  const residual = needsHuman.length > 0 ? AUDIT_RISKIER_EXIT_CODE : 0;
  if (riskier.length === 0) {
    print('audit: nothing to apply');
    return { exitCode: residual, rows };
  }

  const raise = new Map(riskier.map((r) => [`${r.origin}:${r.id}`, r]));
  const raised = (origin: AuditOrigin, id: string, step: Step): Step => {
    const r = raise.get(`${origin}:${id}`);
    if (r === undefined || RISK_ORDER[r.effective] <= RISK_ORDER[step.risk]) return step;
    return { ...step, risk: r.effective, ...(r.effective === 'irreversible' ? { onFailure: 'escalate' as const } : {}) };
  };
  const steps = cap.steps.map((s) => raised('step', s.id, s));
  const overrides = cap.overrides?.map((o) => ({
    ...o,
    ...(o.extraSteps !== undefined ? { extraSteps: o.extraSteps.map((es) => ({ ...es, step: raised('override', `${o.tenant}/${es.step.id}`, es.step) })) } : {}),
  }));
  const riskLevel = steps.reduce<RiskClass>((m, s) => maxRisk(m, s.risk), 'read');
  const newVersion = bumpPatch(cap.version);
  const detail = riskier.map((r) => `${r.id} ${r.declared ?? '-'}->${r.effective}${r.pIrreversible !== undefined ? ` (p=${r.pIrreversible.toFixed(2)})` : ' (lexical)'}`).join(', ');
  const noteLine =
    `Audited by risk judge ${label} on ${clock().toISOString()} (all ${rows.length} committing actions judged): raised ${detail}; ` +
    `status reset to draft for re-approval${needsHuman.length > 0 ? `; unresolved, needs a human: ${needsHuman.map((r) => r.id).join(', ')}` : ''}`;
  const updated: Capability = {
    ...cap,
    version: newVersion,
    status: cap.status === 'deprecated' ? 'deprecated' : 'draft',
    riskLevel,
    steps,
    ...(overrides !== undefined ? { overrides } : {}),
    provenance: { ...cap.provenance, notes: cap.provenance.notes !== undefined ? `${cap.provenance.notes}\n${noteLine}` : noteLine },
  };
  const revalidated = validateCapability(updated, {
    irreversibleTextPatterns: policy.risk.irreversibleTextPatterns,
    irreversibleUrlPatterns: policy.risk.irreversibleUrlPatterns,
  });
  if (!revalidated.ok) {
    printError('cu audit: internal error -- the raised capability failed re-validation; nothing written:');
    formatIssues(revalidated.issues).forEach(printError);
    return { exitCode: 1, rows };
  }
  const target = path.resolve(opts.out ?? opts.artifactPath);
  try {
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(revalidated.capability, null, 2)}\n`, 'utf8');
  } catch (err) {
    printError(`cu audit: could not write ${target}: ${err instanceof Error ? err.message : String(err)}`);
    return { exitCode: 1, rows };
  }
  print(`audit: wrote ${cap.id} ${cap.version} -> ${newVersion} (${updated.status}) to ${target}`);
  return { exitCode: residual, rows, written: target };
}

interface AuditCliOptions {
  riskJudge: RiskJudgeChoice;
  apply?: boolean;
  out?: string;
}

/** Registers the `audit` subcommand on `program`, wiring its flags to `runAudit`. */
export function registerAudit(program: Command): void {
  program
    .command('audit <artifact>')
    .description(
      'judge every committing action of a capability (steps, override extra steps, recovery actions) with the risk judge; ' +
        'exit 2 when something is riskier than declared, 3 when incomplete. --apply raises what it can and resets the capability to draft',
    )
    .addOption(
      new Option('--risk-judge <judge>', 'auto (anthropic when ANTHROPIC_API_KEY is set, else jev when TYPESAFE_API_KEY is set; refuses when neither is set), jev, anthropic, or off (lexical patterns only)')
        .choices([...RISK_JUDGE_CHOICES])
        .default('auto'),
    )
    .option('--apply', 'raise the riskier steps (risk, onFailure escalate), bump the patch version, reset status to draft, and write the file; writes nothing on an incomplete audit')
    .option('--out <path>', 'with --apply: where to write the raised capability (default: in place)')
    .action(async (artifactPath: string, options: AuditCliOptions, cmd: Command) => {
      const g = globalsOf(cmd);
      const result = await runAudit({
        artifactPath,
        riskJudge: options.riskJudge,
        apply: options.apply === true,
        ...(options.out !== undefined ? { out: options.out } : {}),
        policy: g.policy,
      });
      process.exitCode = result.exitCode;
    });
}

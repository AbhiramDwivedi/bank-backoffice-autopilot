/**
 * `optimizeCapability`: a deterministic, model-free search over an existing capability, verified
 * by replay.
 *
 * THE BOUNDARY. A trial executes the capability -- and mutated variants of it, with steps removed --
 * against the live target. A removed "select the Mobile slot" makes the next "type the phone
 * number" write somewhere else; `riskLevel` cannot tell that write from a read (every click is
 * `reversible`, "Save" matches no irreversible pattern). So:
 *
 * - Every rewrite is replay-verified. Nothing is applied on static grounds alone -- not even the
 *   collapse of an exact repeat, because a recorded retry is evidence the first write may not have
 *   stuck.
 * - The replay-backed passes run only on a capability the operator has DECLARED read-only
 *   (`capability.readOnly`). Without it the optimizer is analysis-only: it rewrites nothing and
 *   reports what it would look at, and how to enable trials.
 * - Models and heuristics may veto, never permit. Any declared or policy-classified irreversible
 *   step, a capability with no declared outputs (output equality would compare nothing), or a
 *   caller veto (`vetoStep`, e.g. a risk-judge raise) downgrades a read-only capability to
 *   analysis-only too.
 *
 * With the declaration and no veto, three passes, in order:
 * 1. Collapse candidates: consecutive redundant repeats (rewrite.ts, schema/step-equivalence.ts).
 * 2. Vacuity probe: replay the UNMODIFIED capability once as the baseline, observing before each
 *    step whether its (post-collapse) postcondition already holds. One that does is a drop
 *    candidate -- unless a tenant override references the step, or dropping it would add a
 *    validator warning.
 * 3. Replay-verified removal: from the most aggressive rewrite level that reproduces the baseline
 *    in one trial, try removing steps one at a time; a removal is kept iff the trial is `success`
 *    AND its outputs deep-equal the baseline's. Repeat to a fixpoint, bounded by `maxTrials`. Then
 *    verify with `verifyRuns` consecutive successful, output-equal replays (re-probing every
 *    dropped checkpoint); on failure fall back to the starting point, and then to the input,
 *    unchanged.
 *
 * Never removed: steps a tenant override or business outcome references, the last extract of each
 * declared output, the last step consuming each declared input. Step ids are never renumbered.
 * The result is always a `draft`; the report holds no output or input values.
 */
import { validateCapability, type Capability, type CapabilityIssue, type Condition, type Step } from '../schema/index.js';
import { DEFAULT_IRREVERSIBLE_TEXT_PATTERNS, findRedundantRepeats, targetTexts } from '../schema/index.js';
import { createBeforeStepProbe } from './probe.js';
import {
  bumpPatch,
  cloneCapability,
  collapseRedundantRepeats,
  describeCondition,
  dropPostconditions,
  lastExtractStepIds,
  lastInputUseStepIds,
  overrideReferencedIds,
  protectedStepIds,
  removeStep,
  trialCopy,
  withSteps,
} from './rewrite.js';
import { provenanceNote } from './report.js';
import {
  DEFAULT_MAX_TRIALS,
  DEFAULT_VERIFY_RUNS,
  type AnalysisReason,
  type KeptReason,
  type OptimizeAnalysis,
  type OptimizeChange,
  type OptimizeOptions,
  type OptimizeReport,
  type OptimizeResult,
  type OutputMap,
  type TrialOutcome,
  type TrialPurpose,
} from './types.js';

/** True when two output maps have the same keys and strictly equal values. */
export function outputsEqual(a: OutputMap | undefined, b: OutputMap | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  const ak = Object.keys(a).sort();
  const bk = Object.keys(b).sort();
  return ak.length === bk.length && ak.every((k, i) => k === bk[i] && a[k] === b[k]);
}

/** The names of the outputs on which `a` and `b` disagree (never their values). */
function differingOutputs(a: OutputMap | undefined, b: OutputMap): string[] {
  return Object.keys({ ...b, ...(a ?? {}) }).filter((k) => a?.[k] !== b[k]);
}

const DEFAULT_IRREVERSIBLE_RES = DEFAULT_IRREVERSIBLE_TEXT_PATTERNS.map((p) => new RegExp(p, 'i'));

/** Default irreversibility test when the caller supplies none: the schema's default
 *  irreversible-text patterns against a click/select/Enter-submitting type's target texts. */
function defaultIsIrreversible(step: Step): boolean {
  const a = step.action;
  const acts = a.type === 'click' || a.type === 'select' || (a.type === 'type' && a.pressEnter === true);
  if (!acts) return false;
  const texts = [...targetTexts(a.target), a.target.description];
  return texts.some((t) => DEFAULT_IRREVERSIBLE_RES.some((re) => re.test(t)));
}

function intOr(value: number | undefined, fallback: number, min: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min ? Math.floor(value) : fallback;
}

/** Warning codes a capability raises, ignoring the redundant-repeat warning (collapsing is what
 *  removes those). Used to refuse a change that weakens the capability. */
function warningCodes(warnings: readonly CapabilityIssue[]): Set<string> {
  return new Set(warnings.filter((w) => w.code !== 'redundant_repeated_step').map((w) => w.code));
}

function addsWarning(base: ReadonlySet<string>, cap: Capability): { invalid: boolean; weakens: boolean } {
  const v = validateCapability(cap);
  if (!v.ok) return { invalid: true, weakens: false };
  return { invalid: false, weakens: [...warningCodes(v.warnings)].some((c) => !base.has(c)) };
}

function failureReason(out: TrialOutcome, baseline: OutputMap): string {
  if (out.kind !== 'success') return `${out.kind}${out.detail !== undefined ? `: ${out.detail}` : ''}`;
  return `success, but outputs differ from the baseline (${differingOutputs(out.outputs, baseline).join(', ') || 'shape'})`;
}

/** Steps the removal search would never try, with the reason. */
function neverRemoved(cap: Capability, protectedIds: ReadonlyMap<string, KeptReason>): Map<string, KeptReason> {
  const out = new Map<string, KeptReason>();
  const extracts = lastExtractStepIds(cap);
  const inputs = lastInputUseStepIds(cap);
  for (const s of cap.steps) {
    const reason = protectedIds.get(s.id) ?? (extracts.has(s.id) ? 'last_extract' : inputs.has(s.id) ? 'last_input_use' : undefined);
    if (reason !== undefined) out.set(s.id, reason);
  }
  return out;
}

/** What the passes would look at: reported in every mode, and all there is in analysis-only. */
function analyse(cap: Capability, protectedIds: ReadonlyMap<string, KeptReason>): OptimizeAnalysis {
  const never = neverRemoved(cap, protectedIds);
  return {
    redundantRepeats: findRedundantRepeats(cap.steps).map((r) => ({ stepId: r.stepId, repeatOf: r.repeatOf })),
    checkpointsToProbe: cap.steps.filter((s) => s.postcondition !== undefined).map((s) => s.id),
    removalCandidates: cap.steps.filter((s) => !never.has(s.id)).map((s) => s.id),
  };
}

const ENABLE_HINT =
  'to let the optimizer replay it, declare the capability read-only (`cu optimize --read-only`, `discover --read-only`) -- an assertion that replaying it, whole or with steps removed, changes nothing in the target app';

/**
 * Every step a trial of `cap` can execute: the base steps, the extra steps of the override for
 * `tenant` (ids `override:<tenant>:<id>`), and each recovery-rule action as a pseudo-step (ids
 * `recovery:<rule>[<i>]`).
 */
function executableSteps(cap: Capability, tenant: string | undefined): Step[] {
  const override = tenant === undefined ? undefined : (cap.overrides ?? []).find((o) => o.tenant === tenant);
  const extra = (override?.extraSteps ?? []).map((x) => ({ ...x.step, id: `override:${override!.tenant}:${x.step.id}` }));
  const recovery = cap.recoveryRules.flatMap((r) =>
    r.actions.map((action, i): Step => ({ id: `recovery:${r.name}[${i}]`, name: r.description, action, risk: 'reversible' })),
  );
  return [...cap.steps, ...extra, ...recovery];
}

interface Level {
  name: 'original' | 'collapse' | 'collapse+vacuity';
  cap: Capability;
  changes: OptimizeChange[];
}

/** Thrown inside the search when the abort signal fires; caught in {@link optimizeCapability}. */
class Aborted extends Error {}

/**
 * Optimizes `input` (a validated capability). Never mutates it. See the module header for the
 * boundary, the passes and the protections. Expected outcomes (analysis-only, baseline failed,
 * aborted, verification fell back) are reported in `report`; only an error thrown by `runTrial`
 * (an interruption) propagates.
 */
export async function optimizeCapability(input: Capability, opts: OptimizeOptions = {}): Promise<OptimizeResult> {
  const log = opts.log ?? ((): void => undefined);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = opts.now ?? ((): Date => new Date());
  const maxTrials = intOr(opts.maxTrials, DEFAULT_MAX_TRIALS, 0);
  const verifyRuns = intOr(opts.verifyRuns, DEFAULT_VERIFY_RUNS, 1);
  const trialDelayMs = intOr(opts.trialDelayMs, 0, 0);
  const isIrreversible = opts.isIrreversible ?? defaultIsIrreversible;
  const aborted = (): boolean => opts.signal?.aborted === true;

  const original = cloneCapability(input);
  const protectedIds = protectedStepIds(original);
  const overrideIds = overrideReferencedIds(original);
  const baseValidation = validateCapability(original);
  const baseWarnings = warningCodes(baseValidation.ok ? baseValidation.warnings : []);
  const originalLevel: Level = { name: 'original', cap: original, changes: [] };
  let baselineOutputs: OutputMap | undefined;

  const report: OptimizeReport = {
    capabilityId: original.id,
    versionBefore: original.version,
    versionAfter: original.version,
    readOnly: original.readOnly === true,
    stop: 'completed',
    vetoes: [],
    analysis: analyse(original, protectedIds),
    changed: false,
    stepsBefore: original.steps.length,
    stepsAfter: original.steps.length,
    changes: [],
    rejected: [],
    kept: [],
    irreversibleSteps: [],
    trialsUsed: 0,
    removalTrialsUsed: 0,
    maxTrials,
    budgetExhausted: false,
    trials: [],
    notes: [],
  };

  const finish = (level: Level, extraChanges: OptimizeChange[] = []): OptimizeResult => {
    const changes = [...level.changes, ...extraChanges];
    report.changes = changes;
    report.changed = changes.length > 0;
    let capability: Capability = input;
    if (report.changed) {
      const removedIds = new Set(extraChanges.map((c) => c.stepId));
      const base = cloneCapability(level.cap);
      capability = { ...withSteps(base, base.steps.filter((s) => !removedIds.has(s.id))), status: 'draft' };
      if (opts.bumpVersion === true) capability.version = bumpPatch(original.version);
    }
    report.versionAfter = capability.version;
    report.stepsAfter = capability.steps.length;
    const present = new Set(capability.steps.map((s) => s.id));
    report.kept = report.kept.filter((k) => present.has(k.stepId));
    report.rejected = report.rejected.filter((r) => present.has(r.stepId));
    report.trialsUsed = report.trials.length;
    if (report.changed) {
      // Written last, from the finished report (step counts, trials, verification).
      const note = provenanceNote(report, opts.source ?? 'the optimizer', now());
      const prior = capability.provenance.notes;
      capability.provenance = { ...capability.provenance, notes: prior !== undefined && prior !== '' ? `${prior}\n${note}` : note };
    }
    return { capability, report, ...(baselineOutputs !== undefined ? { baselineOutputs } : {}) };
  };

  // ---- The boundary: declaration first, then vetoes ------------------------------------------
  // Everything a trial can execute is classified, not just the base steps: the trialled tenant's
  // override extra steps and every recovery-rule action (wrapped as a step for the classifier).
  // The validator covers these too, but `cu optimize` validates without the policy's URL patterns;
  // this veto does not depend on that, nor on the runtime's forced approval gate.
  report.irreversibleSteps = executableSteps(original, opts.tenant)
    .filter((s) => s.risk === 'irreversible' || isIrreversible(s))
    .map((s) => s.id);
  for (const id of report.irreversibleSteps) report.vetoes.push({ stepId: id, reason: 'irreversible' });
  for (const s of original.steps) {
    const reason = opts.vetoStep?.(s);
    if (reason !== undefined) report.vetoes.push({ stepId: s.id, reason });
  }
  const analysisReason: AnalysisReason | undefined =
    opts.analyzeOnly === true
      ? 'requested'
      : original.readOnly !== true
        ? 'not_read_only'
        : report.irreversibleSteps.length > 0
          ? 'irreversible_steps'
          : Object.keys(original.outputs).length === 0
            ? 'no_outputs'
            : report.vetoes.length > 0
              ? 'vetoed'
              : opts.runTrial === undefined
                ? 'no_trial_runner'
                : undefined;
  if (analysisReason !== undefined) {
    report.stop = 'analysis_only';
    report.analysisReason = analysisReason;
    report.stopDetail = {
      requested: 'analysis only (requested); nothing rewritten',
      not_read_only: `analysis only: the capability is not declared read-only, so nothing was replayed or rewritten; ${ENABLE_HINT}`,
      irreversible_steps: `analysis only: step(s) ${report.irreversibleSteps.join(', ')} are irreversible, and a trial executes the capability -- it is never replayed repeatedly to optimize it`,
      no_outputs: 'analysis only: the capability declares no outputs, so a trial has nothing to compare against the baseline (success alone cannot tell a step was needed)',
      vetoed: `analysis only: vetoed (${report.vetoes.map((v) => `${v.stepId}: ${v.reason}`).join('; ')})`,
      no_trial_runner: 'analysis only (no trial runner)',
    }[analysisReason];
    // Not logged: `stopDetail` is the report's own line, and whoever renders the report prints it
    // (`summarizeOptimization`). Logging it here too printed it twice.
    return finish(originalLevel);
  }
  const runTrial = opts.runTrial!;
  report.probedTenant = opts.tenant ?? 'base';

  try {
    return await search();
  } catch (err) {
    if (!(err instanceof Aborted)) throw err;
    report.stop = 'aborted';
    report.stopDetail = 'aborted before the optimization finished; nothing rewritten';
    return finish(originalLevel);
  }

  async function search(): Promise<OptimizeResult> {
    const untrialled = (original.overrides ?? []).map((o) => o.tenant).filter((t) => t !== opts.tenant);
    if (untrialled.length > 0) {
      report.notes.push(
        `tenant overrides (${untrialled.join(', ')}) were not trialled: trials and the vacuity probe observed ${opts.tenant !== undefined ? `the ${opts.tenant} override` : 'the base capability'} only; ` +
          'every step an override references was kept, with its checkpoint, but replay each tenant before approving',
      );
    }

    const trial = async (cap: Capability, purpose: TrialPurpose, label: string, beforeStep?: Parameters<typeof runTrial>[0]['beforeStep']): Promise<TrialOutcome> => {
      if (aborted()) throw new Aborted();
      if (report.trials.length > 0 && trialDelayMs > 0) await sleep(trialDelayMs);
      if (aborted()) throw new Aborted();
      const n = report.trials.length + 1;
      const out = await runTrial({ capability: trialCopy(cap, original.version, n), purpose, label, ...(beforeStep !== undefined ? { beforeStep } : {}) });
      report.trials.push({
        n,
        purpose,
        label,
        kind: out.kind,
        ...(out.kind === 'success' && baselineOutputs !== undefined ? { outputsMatch: outputsEqual(out.outputs, baselineOutputs) } : {}),
        ...(out.runId !== undefined ? { runId: out.runId } : {}),
        ...(out.detail !== undefined ? { detail: out.detail } : {}),
        ...(out.locatorDepth !== undefined ? { locatorDepth: out.locatorDepth } : {}),
      });
      return out;
    };

    // ---- Pass 1: collapse candidates ------------------------------------------------------
    const collapsed = collapseRedundantRepeats(original, protectedIds);
    const collapseLevel: Level = collapsed.changes.length > 0 ? { name: 'collapse', cap: collapsed.capability, changes: collapsed.changes } : originalLevel;
    for (const c of collapsed.changes) if (c.kind === 'collapsed_repeat') log(`optimize: ${c.stepId} repeats ${c.into} exactly; collapse candidate`);

    // ---- Pass 2: baseline + vacuity probe ---------------------------------------------------
    // Probed in the unmodified run, at the collapse survivors, with their merged postconditions:
    // a survivor runs from the same page state its first copy did.
    const probeConditions = new Map<string, Condition>();
    for (const s of collapseLevel.cap.steps) if (s.postcondition !== undefined) probeConditions.set(s.id, s.postcondition);
    const baselineProbe = createBeforeStepProbe(probeConditions);
    const base = await trial(original, 'baseline', 'baseline (unmodified capability)', baselineProbe.hook);
    const matchesReference = opts.referenceOutputs !== undefined && base.kind === 'success' ? outputsEqual(opts.referenceOutputs, base.outputs) : undefined;
    report.baseline = {
      kind: base.kind,
      outputNames: Object.keys(base.outputs ?? {}),
      ...(matchesReference !== undefined ? { matchesReference } : {}),
      ...(base.runId !== undefined ? { runId: base.runId } : {}),
      ...(base.detail !== undefined ? { detail: base.detail } : {}),
    };
    if (base.kind !== 'success' || base.outputs === undefined) {
      report.stop = 'baseline_failed';
      report.stopDetail = `the unmodified capability did not replay to success (${base.kind}${base.detail !== undefined ? `: ${base.detail}` : ''}); nothing to compare against, so nothing was rewritten`;
      return finish(originalLevel);
    }
    if (matchesReference === false) {
      report.stop = 'baseline_mismatch';
      report.stopDetail = `the baseline replay's outputs differ from the reference outputs (${differingOutputs(base.outputs, opts.referenceOutputs!).join(', ')}); nothing was rewritten`;
      return finish(originalLevel);
    }
    const baseline = base.outputs;
    baselineOutputs = { ...baseline };
    log(`optimize: baseline succeeded (outputs: ${Object.keys(baseline).join(', ')})`);

    const held = baselineProbe.results();
    const vacuous = new Map<string, Condition>();
    const vacuityChanges: OptimizeChange[] = [];
    for (const [id, condition] of probeConditions) {
      if (held.get(id) !== true) continue;
      if (overrideIds.has(id)) {
        // The probe observed one tenant; a tenant override changes this step for another, where the
        // same checkpoint may be the only thing that catches a failed step.
        report.kept.push({ stepId: id, reason: 'override_reference', what: 'postcondition' });
        log(`optimize: ${id} postcondition already held before the step, but a tenant override references the step; kept`);
        continue;
      }
      const next = new Set([...vacuous.keys(), id]);
      const effect = addsWarning(baseWarnings, dropPostconditions(collapseLevel.cap, next));
      if (effect.invalid || effect.weakens) {
        report.kept.push({ stepId: id, reason: effect.invalid ? 'invalid_without' : 'weakens_validation', what: 'postcondition' });
        log(`optimize: ${id} postcondition already held before the step, but dropping it would weaken validation; kept`);
        continue;
      }
      vacuous.set(id, condition);
      vacuityChanges.push({ kind: 'dropped_vacuous_postcondition', stepId: id, condition: describeCondition(condition) });
      log(`optimize: ${id} postcondition (${describeCondition(condition)}) already held before the step acted; drop candidate`);
    }
    const vacuityLevel: Level =
      vacuous.size > 0
        ? { name: 'collapse+vacuity', cap: dropPostconditions(collapseLevel.cap, new Set(vacuous.keys())), changes: [...collapseLevel.changes, ...vacuityChanges] }
        : collapseLevel;

    const passes = (out: TrialOutcome): boolean => out.kind === 'success' && outputsEqual(out.outputs, baseline);

    // ---- Starting point: the most aggressive rewrite level that reproduces the baseline --------
    let start: Level = originalLevel;
    const levelsToTry = [vacuityLevel, collapseLevel].filter((l, i, all) => l !== originalLevel && all.indexOf(l) === i);
    for (const level of levelsToTry) {
      const out = await trial(level.cap, 'start', `start: ${level.name} rewrite`);
      if (passes(out)) {
        start = level;
        break;
      }
      report.notes.push(`the ${level.name} rewrite did not reproduce the baseline (${failureReason(out, baseline)}); not used`);
      log(`optimize: the ${level.name} rewrite did not reproduce the baseline; falling back`);
    }

    // ---- Pass 3: replay-verified removal, to a fixpoint ----------------------------------------
    let current = start.cap;
    const removals: OptimizeChange[] = [];
    const rejectedAt = new Map<string, number>();
    const keptReason = new Map<string, KeptReason>();
    const rejectedReason = new Map<string, string>();
    removal: for (;;) {
      let progress = false;
      for (const step of [...current.steps]) {
        const reason = neverRemoved(current, protectedIds).get(step.id);
        if (reason !== undefined) {
          keptReason.set(step.id, reason);
          continue;
        }
        if (rejectedAt.get(step.id) === removals.length) continue; // nothing changed since it last failed
        const candidate = removeStep(current, step.id);
        const effect = addsWarning(baseWarnings, candidate);
        if (effect.invalid || effect.weakens) {
          keptReason.set(step.id, effect.invalid ? 'invalid_without' : 'weakens_validation');
          continue;
        }
        if (report.removalTrialsUsed >= maxTrials) {
          report.budgetExhausted = true;
          break removal;
        }
        report.removalTrialsUsed += 1;
        const out = await trial(candidate, 'removal', `remove ${step.id}`);
        if (passes(out)) {
          current = candidate;
          removals.push({ kind: 'removed_step', stepId: step.id, name: step.name, actionType: step.action.type });
          report.trials[report.trials.length - 1]!.accepted = true;
          keptReason.delete(step.id);
          rejectedReason.delete(step.id);
          progress = true;
          log(`optimize: removed ${step.id} "${step.name}": the replay still succeeds with the same outputs`);
        } else {
          report.trials[report.trials.length - 1]!.accepted = false;
          rejectedAt.set(step.id, removals.length);
          rejectedReason.set(step.id, failureReason(out, baseline));
          log(`optimize: kept ${step.id} "${step.name}": without it, ${failureReason(out, baseline)}`);
        }
      }
      if (!progress) break;
    }
    for (const [stepId, reason] of keptReason) report.kept.push({ stepId, reason, what: 'step' });
    for (const [stepId, reason] of rejectedReason) report.rejected.push({ stepId, reason });
    if (report.budgetExhausted) log(`optimize: removal budget of ${maxTrials} trial(s) used up; stopping the search`);

    // ---- Verification, with fallback ------------------------------------------------------------
    type Candidate = { name: 'search' | 'start'; level: Level; extra: OptimizeChange[] };
    const candidates: Candidate[] = [];
    if (removals.length > 0) candidates.push({ name: 'search', level: start, extra: removals });
    if (start !== originalLevel) candidates.push({ name: 'start', level: start, extra: [] });
    report.verification = { kept: 'unchanged', required: verifyRuns, attempts: [] };
    if (candidates.length === 0) {
      log('optimize: nothing to change');
      return finish(originalLevel);
    }
    for (const cand of candidates) {
      const removedIds = new Set(cand.extra.map((c) => c.stepId));
      const cap = cand.extra.length > 0 ? current : cand.level.cap;
      const drops = new Map([...vacuous].filter(([id]) => !removedIds.has(id) && cand.level === vacuityLevel));
      let passed = 0;
      let failure: string | undefined;
      for (let r = 1; r <= verifyRuns; r += 1) {
        const probe = createBeforeStepProbe(drops);
        const out = await trial(cap, 'verify', `verify ${cand.name} ${r}/${verifyRuns}`, drops.size > 0 ? probe.hook : undefined);
        if (!passes(out)) {
          failure = failureReason(out, baseline);
          break;
        }
        const notVacuous = [...probe.results()].filter(([, h]) => !h).map(([id]) => id);
        if (notVacuous.length > 0) {
          failure = `the dropped checkpoint on ${notVacuous.join(', ')} did not hold before its step in this run, so it is not reliably vacuous`;
          break;
        }
        passed += 1;
      }
      report.verification.attempts.push({ candidate: cand.name, passed, ...(failure !== undefined ? { failure } : {}) });
      if (failure === undefined) {
        report.verification.kept = cand.name;
        log(`optimize: verified ${cand.name} result: ${passed}/${verifyRuns} replays succeeded with the baseline outputs`);
        return finish(cand.level, cand.extra);
      }
      log(`optimize: verification of the ${cand.name} result failed (${failure}); falling back`);
    }
    report.notes.push('no candidate verified: nothing was rewritten');
    return finish(originalLevel);
  }
}

/**
 * `discover`'s built-in optimization stage: after a successful discovery, and before the capability
 * is written, the recorded capability goes through the optimizer (runtime/run-optimize.ts,
 * model-free) with the discovery run's own inputs; the discovery's extracted outputs are the
 * equality reference in addition to the baseline replay. Kept out of discover.ts so that file only
 * gains a call.
 *
 * Trials -- replays of the capability and of variants with steps removed, against the live app --
 * run only when the operator declared the goal read-only (`discover --read-only`, recorded as
 * `readOnly: true`). Otherwise the stage only analyses: one line says nothing was rewritten and how
 * to enable it, and `optimize.json` holds the analysis.
 *
 * The stage can never lose a discovered capability:
 * - the as-discovered capability is already in the run directory (`capability.json`) before the
 *   stage starts, and the stage says so;
 * - on ANY failure -- an error, an interruption, an optimized result that fails validation or the
 *   leak scan -- the un-optimized capability is what gets written, and the reason is reported;
 * - `signal` (Ctrl-C) stops the optimizer between trials, so the normal write path completes.
 *
 * Skipped (and said so) for `--no-optimize`, for `--extend` runs (they add outcomes to an existing
 * capability; its steps are not this run's to rewrite), and when the discovery surface was injected
 * without a factory for fresh trial sessions (tests).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Browser } from 'playwright';
import { summarizeOptimization, type OptimizeReport, type OutputMap } from '@cu/core/optimize';
import { validateCapability, type Capability, type Policy } from '@cu/core/schema';
import type { Surface } from '@cu/core/surface';
import { isInterruptedError, runOptimize, type RunOptimizeOptions, type TrialReplayPassThrough } from '../runtime/index.js';

/** The `discover` flags that control the stage. */
export interface DiscoverOptimizeSettings {
  /** `--no-optimize` sets this false. Default true. */
  enabled: boolean;
  maxTrials?: number;
  verifyRuns?: number;
}

/** Everything the stage needs from the discovery run. */
export interface DiscoverOptimizeContext {
  capability: Capability;
  /** The discovery run's own input values (sensitive ones included: trials need them). */
  inputs: Record<string, string>;
  /** Discovery's extracted outputs, when they cover every declared output. */
  referenceOutputs?: OutputMap;
  runId: string;
  runDir: string;
  runsDir: string;
  baseUrl: string;
  headless: boolean;
  tenant?: string;
  policy: Policy;
  isExtend: boolean;
  browser?: Browser;
  /** Set when the discovery surface was injected: trials then need their own fresh surfaces. */
  surfaceInjected: boolean;
  trialSurface?: () => Surface | Promise<Surface>;
  /** For a desktop://<process> base URL: how each trial starts its own instance of the app. */
  desktop?: RunOptimizeOptions['desktop'];
  /** Values that must never appear in a written capability (secrets, sensitive inputs). */
  forbidden: readonly string[];
  /** Ctrl-C: stop starting trials. */
  signal?: AbortSignal;
  /** The run was declared read-only but recorded these irreversible steps; the declaration was dropped. */
  readOnlyDropped?: readonly string[];
  /** Pass-through runReplay options for every trial (see RunOptimizeOptions.replayPassThrough). */
  replayPassThrough?: TrialReplayPassThrough;
  settings: DiscoverOptimizeSettings;
  report: (line: string) => void;
  progress: (line: string) => void;
}

/** What the stage produced: the capability to write, and the report if optimization ran. */
export interface DiscoverOptimizeOutcome {
  capability: Capability;
  optimized: boolean;
  report?: OptimizeReport;
  /** The baseline replay's output values, in memory only (never written): `--candidates` compares
   *  them across candidates. */
  baselineOutputs?: OutputMap;
  /** Why the optimized capability was not used, or why the stage did not run. */
  skipped?: string;
  error?: string;
  reportPath?: string;
}

function writeReport(runDir: string, body: unknown): string {
  const file = path.join(runDir, 'optimize.json');
  fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  return file;
}

/**
 * Discovery's extracted outputs as an equality reference, or `undefined` when they do not cover
 * every declared output (an output the discovery result withholds -- e.g. one named like a
 * sensitive input -- would make every comparison fail spuriously).
 */
export function referenceOutputsFor(capability: Capability, outputs: Record<string, string | number | boolean> | undefined): OutputMap | undefined {
  if (outputs === undefined) return undefined;
  const declared = Object.keys(capability.outputs);
  return declared.every((k) => Object.prototype.hasOwnProperty.call(outputs, k)) ? Object.fromEntries(declared.map((k) => [k, outputs[k]!])) : undefined;
}

/** Runs the stage. Never throws: every failure comes back as the un-optimized capability. */
export async function optimizeDiscovered(ctx: DiscoverOptimizeContext): Promise<DiscoverOptimizeOutcome> {
  const original = ctx.capability;
  const skip = (reason: string): DiscoverOptimizeOutcome => {
    ctx.report(`optimize: skipped (${reason})`);
    return { capability: original, optimized: false, skipped: reason };
  };
  if (!ctx.settings.enabled) return skip('--no-optimize');
  if (ctx.readOnlyDropped !== undefined && ctx.readOnlyDropped.length > 0) {
    const steps = ctx.readOnlyDropped.join(', ');
    ctx.report(
      `optimize: not run -- the goal was declared --read-only, but the run performed an irreversible action (step ${steps}). ` +
        'The read-only declaration was removed from the capability, and no optimization trials ran.',
    );
    return { capability: original, optimized: false, skipped: 'read-only declaration dropped: irreversible step recorded' };
  }
  if (ctx.isExtend) return skip('an --extend run adds outcomes to an existing capability; its steps are left as they are');
  if (ctx.surfaceInjected && ctx.trialSurface === undefined) return skip('the discovery surface was injected and there is no way to open fresh trial sessions on it');

  ctx.progress(`discover: the capability as discovered is saved at ${path.join(ctx.runDir, 'capability.json')}`);
  if (ctx.capability.readOnly === true) {
    ctx.progress('discover: optimizing the recorded capability under the --read-only declaration (model-free; every change verified by replay; Ctrl-C stops it and writes the capability as discovered)...');
  }
  let result: Awaited<ReturnType<typeof runOptimize>>;
  try {
    result = await runOptimize({
      capability: original,
      inputs: ctx.inputs,
      policy: ctx.policy,
      runsDir: ctx.runsDir,
      baseUrl: ctx.baseUrl,
      headless: ctx.headless,
      ...(ctx.tenant !== undefined ? { tenant: ctx.tenant } : {}),
      ...(ctx.browser !== undefined ? { browser: ctx.browser } : {}),
      ...(ctx.trialSurface !== undefined ? { surfaceFactory: ctx.trialSurface } : {}),
      ...(ctx.desktop !== undefined ? { desktop: ctx.desktop } : {}),
      ...(ctx.settings.maxTrials !== undefined ? { maxTrials: ctx.settings.maxTrials } : {}),
      ...(ctx.settings.verifyRuns !== undefined ? { verifyRuns: ctx.settings.verifyRuns } : {}),
      ...(ctx.referenceOutputs !== undefined ? { referenceOutputs: ctx.referenceOutputs } : {}),
      ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
      ...(ctx.replayPassThrough !== undefined ? { replayPassThrough: ctx.replayPassThrough } : {}),
      bumpVersion: false,
      source: `discover run ${ctx.runId}`,
      log: ctx.progress,
    });
  } catch (err) {
    const message = isInterruptedError(err) ? `interrupted (${err.message})` : err instanceof Error ? err.message : String(err);
    const reportPath = writeReport(ctx.runDir, { error: message });
    ctx.report(`optimize: failed (${message}); writing the capability as discovered`);
    return { capability: original, optimized: false, error: message, reportPath };
  }

  const { capability, report, baselineOutputs } = result;
  if (ctx.referenceOutputs === undefined && report.trialsUsed > 0) {
    report.notes.push("discovery's own outputs did not cover every declared output, so only the baseline replay was the equality reference");
  }
  const reportPath = writeReport(ctx.runDir, report);
  const mem = baselineOutputs !== undefined ? { baselineOutputs } : {};
  if (report.stop === 'analysis_only' && report.analysisReason === 'not_read_only') {
    ctx.report('optimize: not run -- the goal was not declared read-only, so nothing was replayed or rewritten (rerun discover with --read-only, or `cu optimize --read-only`, if replaying it changes nothing in the app)');
    return { capability: original, optimized: false, report, reportPath, skipped: 'not declared read-only' };
  }
  for (const line of summarizeOptimization(report)) ctx.report(line);
  ctx.report(`optimize: report: ${reportPath}`);
  if (report.stop === 'aborted') ctx.report('optimize: interrupted; writing the capability as discovered');
  if (!report.changed) return { capability: original, optimized: false, report, reportPath, ...mem };

  // The same two gates the discovered capability itself passed before it may be written.
  const validated = validateCapability(capability, {
    irreversibleTextPatterns: ctx.policy.risk.irreversibleTextPatterns,
    irreversibleUrlPatterns: ctx.policy.risk.irreversibleUrlPatterns,
  });
  if (!validated.ok) {
    const error = `the optimized capability failed validation: ${JSON.stringify(validated.issues)}`;
    ctx.report(`optimize: ${error}; writing the capability as discovered`);
    return { capability: original, optimized: false, report, error, reportPath, ...mem };
  }
  const serialized = JSON.stringify(validated.capability);
  if (ctx.forbidden.some((v) => v.length > 0 && serialized.includes(v))) {
    const error = 'the optimized capability contains a secret or sensitive input value';
    ctx.report(`optimize: ${error}; writing the capability as discovered`);
    return { capability: original, optimized: false, report, error, reportPath, ...mem };
  }
  return { capability: validated.capability, optimized: true, report, reportPath, ...mem };
}

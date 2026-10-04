/**
 * `cu optimize <artifact.json> --input name=value ...` -- optimize an existing capability without a
 * model (apps/cu/src/runtime/run-optimize.ts, packages/core/src/optimize).
 *
 * THE BOUNDARY. Optimizing means replaying the capability, and variants of it with steps removed,
 * against the live app. That is only acceptable for a capability whose replay changes nothing in
 * the app -- which the system cannot tell from `riskLevel` (every click is `reversible`, "Save"
 * matches no irreversible pattern). So trials run only for a capability the operator has declared
 * read-only: the artifact's own `readOnly: true`, or `--read-only` here, which asserts it for an
 * artifact that lacks the field and writes it into the optimized output. Without the declaration
 * the command is analysis-only: it prints what it would look at (and the validator's warnings, such
 * as `redundant_repeated_step`) and writes no artifact. `--analyze-only` forces that mode.
 *
 * With the declaration: every rewrite (collapse, dropped checkpoint, removed step) is verified by
 * replay. Output: a `draft` with its patch version bumped and a provenance note listing every
 * change, for a human to review and `cu approve`. Written to `--out`, by default next to the input
 * as `<name>.optimized.json`. The input is never overwritten -- paths are compared as real paths,
 * case-insensitively on Windows -- and neither is an existing default output (pass `--out` to
 * replace one). When nothing changes, nothing is written. The report (no input or output values)
 * goes to `<runs-dir>/optimize-<run id>/optimize.json`.
 *
 * Inputs are checked against the capability's declared inputs before anything starts.
 *
 * Exit codes: 0 done (a draft was written, nothing changed, or analysis only); 2 the unmodified
 * capability did not replay to success (or not to the reference outputs), so nothing was
 * rewritten; 1 a usage error or crash; 130 interrupted.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import type { Browser } from 'playwright';
import { newRunId } from '@cu/core/evidence';
import { summarizeOptimization, type OptimizeReport } from '@cu/core/optimize';
import { validateInputs } from '@cu/core/replay';
import { validateCapability, type Capability, type Policy } from '@cu/core/schema';
import type { Surface } from '@cu/core/surface';
import { credentialProviderOf, globalsOf, parseKeyValues, collect } from '../globals.js';
import { CRASH_EXIT_CODE } from '../exit-code.js';
import { baseUrlPolicyError } from '../base-url-policy.js';
import { INTERRUPTED_EXIT_CODE, isInterruptedError, runOptimize, type RunOptimizeOptions } from '../runtime/index.js';

/** Exit code when the baseline replay did not succeed (nothing could be verified). */
export const OPTIMIZE_UNVERIFIED_EXIT_CODE = 2;

/** Options for {@link runOptimizeCommand}, gathered from CLI flags and globals. */
export interface OptimizeCommandOptions {
  artifactPath: string;
  input: string[];
  out?: string;
  maxTrials?: number;
  verifyRuns?: number;
  trialDelayMs?: number;
  removalTimeoutMs?: number;
  /** The operator's assertion that the capability is read-only (see the module header). */
  readOnly?: boolean;
  analyzeOnly?: boolean;
  json?: boolean;
  // globals
  policy: string;
  runsDir: string;
  headless: boolean;
  baseUrl: string;
  overrideKey?: string;
  /** For a desktop://<process> --base-url: --app-command / --attach-pid. */
  desktop?: RunOptimizeOptions['desktop'];
}

/** Injectable collaborators (tests). */
export interface OptimizeCommandDeps {
  policy?: Policy;
  browser?: Browser;
  surfaceFactory?: () => Surface | Promise<Surface>;
  /** Allowlisted runReplay options for every trial (see RunOptimizeOptions.replayPassThrough). */
  replayPassThrough?: RunOptimizeOptions['replayPassThrough'];
  /** Step timeout for baseline and verification trials (tests). */
  stepTimeoutMs?: number;
  /** Progress / human output (default console.error / console.log). */
  progress?: (line: string) => void;
  stdout?: (line: string) => void;
}

/** What {@link runOptimizeCommand} did. */
export interface OptimizeCommandResult {
  exitCode: number;
  report?: OptimizeReport;
  /** Where the optimized draft was written, if it was. */
  outPath?: string;
  reportPath?: string;
}

/** The default output path: `<dir>/<name>.optimized.json` next to the input. */
export function defaultOptimizedPath(artifactPath: string): string {
  const dir = path.dirname(artifactPath);
  const base = path.basename(artifactPath).replace(/\.json$/i, '');
  return path.join(dir, `${base}.optimized.json`);
}

/**
 * Whether two paths name the same file: real paths when they exist (symlinks, `..`, 8.3 names),
 * compared case-insensitively on Windows, where `CASE.JSON` and `case.json` are one file.
 */
export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  const real = (p: string): string => {
    const abs = path.resolve(p);
    try {
      return fs.realpathSync.native(abs);
    } catch {
      // Not there (yet): resolve the existing parent, keep the name.
      try {
        return path.join(fs.realpathSync.native(path.dirname(abs)), path.basename(abs));
      } catch {
        return abs;
      }
    }
  };
  const ra = real(a);
  const rb = real(b);
  return platform === 'win32' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

function positiveInt(value: number | undefined, flag: string, min: number): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < min) throw new Error(`${flag} must be an integer >= ${min}, got "${value}"`);
}

/** The commander-free core of `cu optimize`. */
export async function runOptimizeCommand(opts: OptimizeCommandOptions, deps: OptimizeCommandDeps = {}): Promise<OptimizeCommandResult> {
  const progress = deps.progress ?? ((l: string): void => console.error(l));
  const stdout = deps.stdout ?? ((l: string): void => console.log(l));
  const fail = (message: string): OptimizeCommandResult => {
    progress(`cu optimize: ${message}`);
    return { exitCode: CRASH_EXIT_CODE };
  };

  let inputs: Record<string, string>;
  try {
    positiveInt(opts.maxTrials, '--max-trials', 0);
    positiveInt(opts.verifyRuns, '--verify-runs', 1);
    positiveInt(opts.trialDelayMs, '--trial-delay-ms', 0);
    positiveInt(opts.removalTimeoutMs, '--removal-timeout-ms', 1);
    inputs = parseKeyValues(opts.input, '--input');
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(opts.artifactPath, 'utf8'));
  } catch (err) {
    return fail(`could not read/parse ${opts.artifactPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const validated = validateCapability(raw);
  if (!validated.ok) {
    return fail(`${opts.artifactPath} is not a valid capability: ${validated.issues.map((i) => `${i.path.join('.')}: [${i.code}] ${i.message}`).join('; ')}`);
  }
  let capability: Capability = validated.capability;
  if (capability.status === 'deprecated') return fail(`capability "${capability.id}" is deprecated; refusing to optimize it`);
  for (const w of validated.warnings) {
    progress(`  warning ${w.path.length > 0 ? w.path.join('.') : '(root)'}: [${w.code}] ${w.message}`);
  }

  // --read-only: the operator's assertion, for an artifact that lacks the field. The validator
  // refuses it on anything irreversible.
  if (opts.readOnly === true && capability.readOnly !== true) {
    const declared = validateCapability({ ...capability, readOnly: true });
    if (!declared.ok) return fail(`--read-only cannot apply: ${declared.issues.map((i) => i.message).join('; ')}`);
    capability = declared.capability;
    progress('cu optimize: treating the capability as read-only (--read-only): replaying it, whole or with steps removed, is asserted to change nothing in the target app');
  }
  const willReplay = capability.readOnly === true && opts.analyzeOnly !== true;

  const outPath = path.resolve(opts.out ?? defaultOptimizedPath(opts.artifactPath));
  if (willReplay) {
    if (samePath(outPath, opts.artifactPath)) {
      return fail('--out names the input artifact; the optimized result is a draft and never replaces the artifact it came from. Pick another path.');
    }
    if (opts.out === undefined && fs.existsSync(outPath)) {
      return fail(`${outPath} already exists; refusing to overwrite it. Pass --out <path> to write elsewhere (or --out ${outPath} to replace it).`);
    }
    const inputCheck = validateInputs(capability.inputs, inputs);
    if (!inputCheck.ok) return fail(`--input ${inputCheck.input}: ${inputCheck.problem} (nothing started, nothing written)`);
    const originError = baseUrlPolicyError(opts.baseUrl, opts.policy, deps.policy);
    if (originError !== undefined) return fail(originError);
  }

  let result: Awaited<ReturnType<typeof runOptimize>>;
  try {
    result = await runOptimize({
      capability,
      inputs,
      ...(deps.policy !== undefined ? { policy: deps.policy } : { policyPath: opts.policy }),
      runsDir: opts.runsDir,
      baseUrl: opts.baseUrl,
      headless: opts.headless,
      ...(opts.overrideKey !== undefined ? { tenant: opts.overrideKey } : {}),
      ...(deps.browser !== undefined ? { browser: deps.browser } : {}),
      ...(deps.surfaceFactory !== undefined ? { surfaceFactory: deps.surfaceFactory } : {}),
      ...(opts.desktop !== undefined ? { desktop: opts.desktop } : {}),
      ...(deps.replayPassThrough !== undefined ? { replayPassThrough: deps.replayPassThrough } : {}),
      ...(deps.stepTimeoutMs !== undefined ? { stepTimeoutMs: deps.stepTimeoutMs } : {}),
      ...(opts.maxTrials !== undefined ? { maxTrials: opts.maxTrials } : {}),
      ...(opts.verifyRuns !== undefined ? { verifyRuns: opts.verifyRuns } : {}),
      ...(opts.trialDelayMs !== undefined ? { trialDelayMs: opts.trialDelayMs } : {}),
      ...(opts.removalTimeoutMs !== undefined ? { removalStepTimeoutMs: opts.removalTimeoutMs } : {}),
      ...(opts.analyzeOnly === true ? { analyzeOnly: true } : {}),
      bumpVersion: true,
      source: 'cu optimize',
      log: progress,
    });
  } catch (err) {
    if (isInterruptedError(err)) {
      progress(`cu optimize: ${err.message}; nothing written`);
      return { exitCode: INTERRUPTED_EXIT_CODE };
    }
    throw err;
  }
  const { capability: optimized, report } = result;

  const reportDir = path.resolve(opts.runsDir, `optimize-${newRunId()}`);
  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, 'optimize.json');
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  let written: string | undefined;
  if (report.changed) {
    // Defense in depth: the optimizer only removes things, but nothing invalid ever reaches disk.
    const check = validateCapability(optimized);
    if (!check.ok) return fail(`the optimized capability failed validation (not written): ${JSON.stringify(check.issues)}`);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${JSON.stringify(check.capability, null, 2)}\n`, 'utf8');
    written = outPath;
  }

  if (opts.json === true) {
    stdout(JSON.stringify({ ...(written !== undefined ? { out: written } : {}), report: reportPath, ...report }, null, 2));
  } else {
    for (const line of summarizeOptimization(report)) stdout(line);
    stdout(
      written !== undefined
        ? `optimized draft: ${written} (version ${report.versionAfter}, status draft: review it, replay it, then cu approve)`
        : report.stop === 'analysis_only'
          ? 'analysis only; nothing written'
          : 'no changes; nothing written',
    );
    stdout(`report: ${reportPath}`);
  }

  const unverified = report.stop === 'baseline_failed' || report.stop === 'baseline_mismatch';
  return { exitCode: unverified ? OPTIMIZE_UNVERIFIED_EXIT_CODE : 0, report, reportPath, ...(written !== undefined ? { outPath: written } : {}) };
}

interface RawOptimizeCliOptions {
  input: string[];
  out?: string;
  maxTrials?: number;
  verifyRuns?: number;
  trialDelayMs?: number;
  removalTimeoutMs?: number;
  readOnly?: boolean;
  analyzeOnly?: boolean;
  json?: boolean;
}

const int = (v: string): number => Number(v);

/** Registers the `optimize` command on `program`. */
export function registerOptimize(program: Command): void {
  program
    .command('optimize <artifact>')
    .description(
      'optimize a capability without a model: collapse exact repeated steps, drop checkpoints that already held before their step, and remove ' +
        'steps the replay does not need -- each change verified by replaying against the live app. Replays (and so rewrites) only a capability ' +
        'declared read-only; otherwise it only analyses. Writes a draft for approval',
    )
    .option('--input <name=value>', 'a capability input the trial replays use, repeatable (e.g. --input memberId=12345)', collect, [])
    .option(
      '--read-only',
      'assert that replaying this capability -- whole, or with any steps removed -- changes nothing in the target app. Required for trials ' +
        '(unless the artifact already says readOnly: true); written into the optimized output. A wrong assertion means trials write to the live app',
    )
    .option('--analyze-only', 'never replay and never write an artifact: report what the optimizer would look at')
    .option('--out <path>', 'where to write the optimized draft (default: <name>.optimized.json next to the input; the input itself is never overwritten)')
    .option('--max-trials <n>', 'cap on removal trials (each is one replay); baseline and verification replays are extra (default 25)', int)
    .option('--verify-runs <n>', 'consecutive successful replays with the baseline outputs the result must pass (default 3)', int)
    .option('--trial-delay-ms <n>', 'pause between trial replays, for a polite pace against a real site (default 0)', int)
    .option('--removal-timeout-ms <n>', 'step timeout for removal trials, so a removal that breaks the path fails fast (default 5000)', int)
    .option('--json', 'print the report JSON to stdout instead of the summary')
    .action(async (artifactPath: string, cli: RawOptimizeCliOptions, cmd: Command) => {
      const g = globalsOf(cmd);
      const result = await runOptimizeCommand({
        artifactPath,
        input: cli.input,
        ...(cli.out !== undefined ? { out: cli.out } : {}),
        ...(cli.maxTrials !== undefined ? { maxTrials: cli.maxTrials } : {}),
        ...(cli.verifyRuns !== undefined ? { verifyRuns: cli.verifyRuns } : {}),
        ...(cli.trialDelayMs !== undefined ? { trialDelayMs: cli.trialDelayMs } : {}),
        ...(cli.removalTimeoutMs !== undefined ? { removalTimeoutMs: cli.removalTimeoutMs } : {}),
        ...(cli.readOnly === true ? { readOnly: true } : {}),
        ...(cli.analyzeOnly === true ? { analyzeOnly: true } : {}),
        ...(cli.json === true ? { json: true } : {}),
        policy: g.policy,
        runsDir: g.runsDir,
        headless: g.headless,
        baseUrl: g.baseUrl,
        ...(g.overrideKey !== undefined ? { overrideKey: g.overrideKey } : {}),
        ...(g.desktop !== undefined ? { desktop: g.desktop } : {}),
      }, { replayPassThrough: { credentials: credentialProviderOf(g) } });
      process.exitCode = result.exitCode;
    });
}

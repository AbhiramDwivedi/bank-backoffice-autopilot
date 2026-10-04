/**
 * `cu approve <artifact.json> --by <name> [--notes <text>] [--force]` -- records that a capability
 * has passed review. Once a capability's status is `approved`, replay's approval gate allows its
 * irreversible steps to run.
 *
 * `runApprove` is the testable core (commander-free); `registerApprove` only parses flags and
 * calls it, the way `runDiscover` does in apps/cu/src/commands/discover.ts.
 *
 * Refuses (exit 1, message on stderr) an artifact that is invalid, already `approved` or
 * `deprecated`, that has a read whose target is positional-only (`positional_only_target`), or that has no successful replay recorded under `--runs-dir` -- unless `--force`.
 * On success it sets `status: 'approved'`, bumps the patch version, appends an approval line to
 * `provenance.notes`, re-validates, and writes the file back.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { globalsOf } from '../globals.js';
import { capabilityDigest, validateCapability, ReplayResult, type Capability, type CapabilityIssue } from '@cu/core/schema';

/**
 * Looks under `<runsDir>/*\/result.json` for a file that parses as a `ReplayResult` matching the
 * given capability id and version, with `kind` `success` or `business_outcome`. Returns the first
 * match, or `undefined` if none is found (including when `runsDir` does not exist).
 */
export function findSuccessfulReplay(runsDir: string, capabilityId: string, capabilityVersion: string, digest?: string): ReplayResult | undefined {
  let runIds: string[];
  try {
    runIds = readdirSync(runsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return undefined;
  }

  // A result that carries a content digest must match `digest` (when given): id + version alone
  // cannot tell apart two different contents published under one version (optimizer candidates,
  // two `cu optimize` runs). A legacy result without a digest is only a fallback, and only while NO
  // result for this id + version carries a digest: once one does, digest-bearing runs exist for
  // this version, so evidence for this content must carry one too.
  let legacy: ReplayResult | undefined;
  let anyDigested = false;
  for (const runId of runIds) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path.join(runsDir, runId, 'result.json'), 'utf8'));
    } catch {
      continue;
    }
    const parsed = ReplayResult.safeParse(raw);
    if (!parsed.success) continue;
    const result = parsed.data;
    if (
      result.capabilityId === capabilityId &&
      result.capabilityVersion === capabilityVersion &&
      (result.kind === 'success' || result.kind === 'business_outcome')
    ) {
      if (digest === undefined) return result;
      if (result.capabilityDigest === digest) return result;
      if (result.capabilityDigest === undefined) legacy ??= result;
    }
    if (result.capabilityId === capabilityId && result.capabilityVersion === capabilityVersion && result.capabilityDigest !== undefined) anyDigested = true;
  }
  return anyDigested ? undefined : legacy;
}

/** '1.0.1' -> '1.0.2'; any prerelease/build metadata is dropped. */
function bumpPatch(version: string): string {
  const m = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) throw new Error(`bumpPatch: not a valid semver version: ${version}`);
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

function formatIssues(issues: CapabilityIssue[]): string[] {
  return issues.map((issue) => {
    const p = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `  ${p}: [${issue.code}] ${issue.message}`;
  });
}

/** Inputs to `runApprove`, gathered from CLI flags and globals. */
export interface RunApproveOptions {
  artifactPath: string;
  by: string;
  notes?: string;
  force: boolean;
  /** `--runs-dir` (globalsOf(cmd).runsDir in the real CLI). */
  runsDir: string;
}

/** Injectable I/O for `runApprove`, so tests can capture its output and fix the clock. */
export interface RunApproveDeps {
  /** The final report line on success. Defaults to `console.log`. */
  print?: (line: string) => void;
  /** Refusal / warning lines. Defaults to `console.error`. */
  printError?: (line: string) => void;
  /** Defaults to `() => new Date()`. Injectable for deterministic tests. */
  clock?: () => Date;
}

/** The outcome of `runApprove`: the process exit code it decided on. */
export interface RunApproveResult {
  exitCode: number;
}

/**
 * Validates the artifact at `opts.artifactPath`, checks it is eligible for approval, and -- unless
 * `opts.force` is set -- requires a recorded successful replay under `opts.runsDir`. On success,
 * marks the capability `approved`, bumps its patch version, and writes the file back in place.
 */
export function runApprove(opts: RunApproveOptions, deps: RunApproveDeps = {}): RunApproveResult {
  const print = deps.print ?? ((line: string) => console.log(line));
  const printError = deps.printError ?? ((line: string) => console.error(line));
  const clock = deps.clock ?? ((): Date => new Date());

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(opts.artifactPath, 'utf8'));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    printError(`cu approve: could not read/parse ${opts.artifactPath}: ${message}`);
    return { exitCode: 1 };
  }

  const validated = validateCapability(raw);
  if (!validated.ok) {
    printError(`cu approve: ${opts.artifactPath} is not a valid capability:`);
    formatIssues(validated.issues).forEach(printError);
    return { exitCode: 1 };
  }

  const cap = validated.capability;
  if (cap.status === 'approved') {
    printError(`cu approve: ${cap.id}@${cap.version} is already approved`);
    return { exitCode: 1 };
  }
  if (cap.status === 'deprecated') {
    printError(`cu approve: ${cap.id}@${cap.version} is deprecated and cannot be approved`);
    return { exitCode: 1 };
  }

  // A read whose target names nothing (positional locators only) returns whatever sits at that
  // position. Replay cannot check it, so it must not run unattended: refuse unless --force. The
  // rule is the validator's `positional_only_target` warning; only reads raise it. Actions on an
  // unnamed control are not blocked: a checkpoint follows them.
  const positionalReads = validated.warnings.filter((w) => w.code === 'positional_only_target');
  if (positionalReads.length > 0 && !opts.force) {
    printError(`cu approve: ${cap.id}@${cap.version} has ${positionalReads.length === 1 ? 'a read' : 'reads'} that can only be found by position, so it can return another record's value:`);
    positionalReads.forEach((w) => printError(`  ${w.message}`));
    printError('  Fix: record the capability again so the value has a label anchor, or add a tenant override that names the value. Or pass --force.');
    return { exitCode: 1 };
  }

  if (!opts.force) {
    const replayed = findSuccessfulReplay(opts.runsDir, cap.id, cap.version, capabilityDigest(cap));
    if (replayed === undefined) {
      printError(
        `cu approve: no successful replay of ${cap.id}@${cap.version} with this content found under ${opts.runsDir}; run \`cu replay\` on this file first, or pass --force`,
      );
      return { exitCode: 1 };
    }
    if (replayed.capabilityDigest === undefined) {
      printError(
        `cu approve: note: the matching replay (${replayed.runId}) predates content digests, so it is matched by id and version only; replay this file again for a content-checked approval`,
      );
    }
  }

  const newVersion = bumpPatch(cap.version);
  const noteLine = `Approved by ${opts.by} on ${clock().toISOString()}${opts.notes !== undefined ? `: ${opts.notes}` : ''}`;
  const notes = cap.provenance.notes !== undefined ? `${cap.provenance.notes}\n${noteLine}` : noteLine;

  const updated: Capability = {
    ...cap,
    status: 'approved',
    version: newVersion,
    provenance: { ...cap.provenance, notes },
  };

  const revalidated = validateCapability(updated);
  if (!revalidated.ok) {
    printError('cu approve: internal error -- the approved artifact failed re-validation:');
    formatIssues(revalidated.issues).forEach(printError);
    return { exitCode: 1 };
  }

  writeFileSync(opts.artifactPath, `${JSON.stringify(revalidated.capability, null, 2)}\n`, 'utf8');

  print(`approved ${cap.id} ${cap.version} -> ${newVersion} (by ${opts.by})`);
  if (opts.force) printError('cu approve: --force skipped the successful-replay check');
  if (opts.force && positionalReads.length > 0) {
    printError(`cu approve: --force approved past ${positionalReads.length} positional-only read${positionalReads.length === 1 ? '' : 's'} (positional_only_target); they return whatever sits at that position`);
  }

  return { exitCode: 0 };
}

interface ApproveCliOptions {
  by: string;
  notes?: string;
  force?: boolean;
}

/** Registers the `approve` subcommand on `program`, wiring its flags to `runApprove`. */
export function registerApprove(program: Command): void {
  program
    .command('approve <artifact>')
    .description("mark a capability artifact 'approved' after a successful replay, bumping its patch version")
    .requiredOption('--by <name>', 'name of the person approving this capability')
    .option('--notes <text>', 'note appended to provenance.notes alongside the approval line')
    .option('--force', 'skip the successful-replay and positional-only-read checks')
    .action((artifactPath: string, options: ApproveCliOptions, cmd: Command) => {
      const g = globalsOf(cmd);
      const result = runApprove({
        artifactPath,
        by: options.by,
        ...(options.notes !== undefined ? { notes: options.notes } : {}),
        force: options.force === true,
        runsDir: g.runsDir,
      });
      process.exitCode = result.exitCode;
    });
}

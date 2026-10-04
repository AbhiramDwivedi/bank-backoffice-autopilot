/**
 * `discover --candidates <n>`: run the whole discovery n times (n times the model cost), let each
 * run's built-in optimization stage optimize and verify its own capability, then keep ONE: the
 * verified candidate with the fewest steps (tie: the smallest summed locator fallback depth on its
 * last successful trial, then the earliest). Different runs take different routes, and a
 * model-free optimizer can only shorten the route it is given -- comparing routes is the one thing
 * it cannot do alone.
 *
 * Requires `--read-only`: every candidate's stage replays it.
 *
 * Fewest steps is only a sound criterion between candidates that do the same job: a shorter
 * candidate that read the wrong field would otherwise win. So every verified candidate's baseline
 * outputs (held in memory, never written) must equal the winner's; on any disagreement NONE is
 * kept automatically -- the disagreement is reported (by output name) and every candidate stays in
 * its run directory for a human to choose.
 *
 * Each candidate is written straight into its own run directory as `candidate.json`; nothing the
 * CLI reports as written is ever deleted. Only the winner is also written to the real destination
 * (`--out`, or the default `artifacts/<id>.json`, checked up front and never overwritten). With no
 * verified candidate, the best successful one is kept, with a warning.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Capability } from '@cu/core/schema';
import { outputsEqual, type OutputMap } from '@cu/core/optimize';
import { CRASH_EXIT_CODE } from '../exit-code.js';
import { INTERRUPTED_EXIT_CODE } from '../runtime/index.js';
import type { RunDiscoverDeps, RunDiscoverOptions, RunDiscoverResult } from './discover.js';

/** Exit code when verified candidates disagree on the outputs (none kept automatically). */
export const CANDIDATES_DISAGREE_EXIT_CODE = 2;

interface Candidate {
  index: number;
  run: RunDiscoverResult;
  file: string;
  capability: Capability;
  verified: boolean;
  depth: number;
  outputs?: OutputMap;
}

function isVerified(run: RunDiscoverResult): boolean {
  const report = run.optimize?.report;
  if (report === undefined || report.stop !== 'completed') return false;
  const kept = report.verification?.kept;
  return kept === 'search' || kept === 'start' || kept === 'unchanged';
}

function depthOf(run: RunDiscoverResult): number {
  const trials = run.optimize?.report?.trials ?? [];
  const last = [...trials].reverse().find((t) => t.kind === 'success' && t.locatorDepth !== undefined);
  return last?.locatorDepth ?? Number.MAX_SAFE_INTEGER;
}

/** Ranks candidates: verified first, then fewest steps, then smallest fallback depth, then earliest. */
export function rankCandidates<T extends { verified: boolean; capability: Capability; depth: number; index: number }>(cands: readonly T[]): T[] {
  return [...cands].sort(
    (a, b) =>
      Number(b.verified) - Number(a.verified) ||
      a.capability.steps.length - b.capability.steps.length ||
      a.depth - b.depth ||
      a.index - b.index,
  );
}

/** discover.ts's pieces the candidate loop uses (passed in, so this file imports discover.ts for
 *  types only and there is no module cycle). */
export interface CandidateRunner {
  runOnce: (opts: RunDiscoverOptions, deps: RunDiscoverDeps) => Promise<RunDiscoverResult>;
  writeArtifact: (serialized: string, id: string, out: string | undefined, runDir: string, progress: (line: string) => void) => string;
  defaultArtifactPath: (id: string) => string;
}

/** Runs `runner.runOnce` `opts.candidates` times and writes the winner. See the module header. */
export async function runCandidates(opts: RunDiscoverOptions, deps: RunDiscoverDeps, runner: CandidateRunner): Promise<RunDiscoverResult> {
  const { runOnce, writeArtifact, defaultArtifactPath } = runner;
  const n = opts.candidates ?? 1;
  const progress = deps.print ?? ((line: string): void => console.error(line));
  const report = (line: string): void => console.log(line);
  if (n === 1) return runOnce(opts, deps);
  if (!Number.isInteger(n) || n < 1) {
    progress(`discover: --candidates must be a positive integer, got "${n}"`);
    return { exitCode: CRASH_EXIT_CODE, runDir: '' };
  }
  if (opts.readOnly !== true) {
    progress('discover: --candidates requires --read-only: comparing candidates means replaying each of them, and variants of them, against the live app');
    return { exitCode: CRASH_EXIT_CODE, runDir: '' };
  }
  if (opts.optimize === false) {
    progress('discover: --candidates needs the optimization stage (it verifies each candidate); drop --no-optimize');
    return { exitCode: CRASH_EXIT_CODE, runDir: '' };
  }
  if (opts.extend !== undefined) {
    progress('discover: --candidates does not apply to --extend runs');
    return { exitCode: CRASH_EXIT_CODE, runDir: '' };
  }
  if (opts.out === undefined && fs.existsSync(defaultArtifactPath(opts.id))) {
    progress(`discover: ${defaultArtifactPath(opts.id)} already exists; refusing to overwrite it. Pass --out <path> to write the new capability elsewhere.`);
    return { exitCode: CRASH_EXIT_CODE, runDir: '' };
  }

  const candidates: Candidate[] = [];
  let firstFailure: RunDiscoverResult | undefined;
  for (let i = 1; i <= n; i += 1) {
    progress(`discover: candidate ${i}/${n}`);
    // Written straight into the candidate's own run directory (candidate.json): never deleted.
    const run = await runOnce({ ...opts, candidates: 1, candidateInRunDir: true }, deps);
    if (run.exitCode === INTERRUPTED_EXIT_CODE) return run;
    if (run.exitCode !== 0 || run.artifactPath === undefined) {
      firstFailure ??= run;
      continue;
    }
    const capability = JSON.parse(fs.readFileSync(run.artifactPath, 'utf8')) as Capability;
    const outputs = run.optimize?.baselineOutputs;
    candidates.push({
      index: i,
      run,
      file: run.artifactPath,
      capability,
      verified: isVerified(run),
      depth: depthOf(run),
      ...(outputs !== undefined ? { outputs } : {}),
    });
  }

  for (const c of candidates) {
    report(`candidate ${c.index}: ${c.capability.steps.length} steps, ${c.verified ? 'verified' : 'NOT verified'}, ${path.relative(process.cwd(), c.file) || c.file}`);
  }
  const ranked = rankCandidates(candidates);
  const winner = ranked[0];
  if (winner === undefined) {
    progress(`discover: none of the ${n} candidates produced a capability`);
    return firstFailure ?? { exitCode: CRASH_EXIT_CODE, runDir: '' };
  }

  // Fewest steps only means "best" between candidates that do the same job.
  if (winner.verified) {
    const disagreeing = candidates.filter((c) => c !== winner && c.verified && !outputsEqual(c.outputs, winner.outputs));
    if (disagreeing.length > 0) {
      const names = new Set<string>();
      for (const c of disagreeing) {
        for (const k of Object.keys({ ...(c.outputs ?? {}), ...(winner.outputs ?? {}) })) if (c.outputs?.[k] !== winner.outputs?.[k]) names.add(k);
      }
      progress(
        `discover: the verified candidates disagree on ${[...names].join(', ') || 'their outputs'} (candidate ${winner.index} vs ${disagreeing.map((c) => c.index).join(', ')}); ` +
          'keeping none automatically -- every candidate is in its run directory as candidate.json; review them and copy the right one',
      );
      return { ...winner.run, exitCode: CANDIDATES_DISAGREE_EXIT_CODE, artifactPath: undefined } as RunDiscoverResult;
    }
  } else {
    progress('discover: warning: no candidate verified; keeping the best unverified one');
  }

  const serialized = fs.readFileSync(winner.file, 'utf8');
  const artifactPath = writeArtifact(serialized, winner.capability.id, opts.out, winner.run.runDir, progress);
  report(`kept candidate ${winner.index} (${winner.capability.steps.length} steps): ${artifactPath}`);
  return { ...winner.run, artifactPath };
}

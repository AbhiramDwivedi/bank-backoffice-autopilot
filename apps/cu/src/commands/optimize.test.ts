/**
 * `cu optimize` (runOptimizeCommand) end to end through the real runtime wiring -- runOptimize ->
 * runReplay -> compose -> replayCapability -- with the cu-core FakeSurface (a fresh one per trial)
 * standing in for Chromium. No browser, no network.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_POLICY_PATH, loadPolicy } from '@cu/core/policy';
import { createCuCoreScenario, createCuCoreSurface, FakeSurface, type Surface } from '@cu/core/surface';
import type { Capability, LocatorStrategy } from '@cu/core/schema';
import type { OptimizeReport } from '@cu/core/optimize';
import { defaultOptimizedPath, runOptimizeCommand, samePath, type OptimizeCommandOptions } from './optimize.js';

const SHIPPED = path.resolve('artifacts/lookup-member-savings-balance.json');
const BASE_URL = 'http://localhost:4173';
const POLICY = loadPolicy(DEFAULT_POLICY_PATH);
// The mock app's demo credentials (the same defaults apps/cu/src/env.ts applies to the real CLI).
const DEFAULT_USER_ID = 'operator1';
const DEFAULT_PASSWORD = 'demo-pass-123';

const saved = { user: process.env.MOCK_USER, password: process.env.MOCK_PASSWORD };
beforeAll(() => {
  process.env.MOCK_USER = DEFAULT_USER_ID;
  process.env.MOCK_PASSWORD = DEFAULT_PASSWORD;
});
afterAll(() => {
  if (saved.user === undefined) delete process.env.MOCK_USER;
  else process.env.MOCK_USER = saved.user;
  if (saved.password === undefined) delete process.env.MOCK_PASSWORD;
  else process.env.MOCK_PASSWORD = saved.password;
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/**
 * A copy of the shipped artifact in a temp dir, with one locator prepended to s05 and s08 so the
 * in-memory fake can resolve them (it matches CSS selectors by exact string and a table row by its
 * whole text). The real-browser run of the unpatched artifact is tests/e2e/optimize.test.ts.
 */
function shippedCopy(edit?: (cap: Capability) => void): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-optimize-'));
  dirs.push(dir);
  const cap = JSON.parse(fs.readFileSync(SHIPPED, 'utf8')) as Capability;
  const prepend = (id: string, strategy: LocatorStrategy): void => {
    const a = cap.steps.find((s) => s.id === id)!.action;
    if (a.type === 'click') a.target.locators.unshift({ strategy, confidence: 0.8, source: 'human' });
  };
  prepend('s05', { kind: 'role', role: 'button', name: 'login' });
  prepend('s08', { kind: 'text', text: '{input.memberId}' });
  edit?.(cap);
  const file = path.join(dir, 'lookup-member-savings-balance.json');
  fs.writeFileSync(file, JSON.stringify(cap, null, 2));
  return { dir, file };
}

function options(file: string, dir: string, extra: Partial<OptimizeCommandOptions> = {}): OptimizeCommandOptions {
  return { artifactPath: file, input: ['memberId=12345'], policy: DEFAULT_POLICY_PATH, runsDir: path.join(dir, 'runs'), headless: true, baseUrl: BASE_URL, verifyRuns: 2, ...extra };
}

function capture(): { lines: string[]; out: string[]; progress: (l: string) => void; stdout: (l: string) => void } {
  const lines: string[] = [];
  const out: string[] = [];
  return { lines, out, progress: (l) => lines.push(l), stdout: (l) => out.push(l) };
}

function countingFactory(opts: Parameters<typeof createCuCoreSurface>[0] = {}): { factory: () => Surface; count: () => number; surfaces: FakeSurface[] } {
  const surfaces: FakeSurface[] = [];
  return {
    factory: () => {
      const s = createCuCoreSurface(opts);
      surfaces.push(s);
      return s;
    },
    count: () => surfaces.length,
    surfaces,
  };
}

function resultOf(dir: string, runId: string): { capabilityVersion: string } {
  return JSON.parse(fs.readFileSync(path.join(dir, 'runs', runId, 'result.json'), 'utf8')) as { capabilityVersion: string };
}

describe('cu optimize: the read-only boundary', () => {
  it('without the declaration: analysis only -- no replay, no artifact, the repeat warning and how to enable trials', async () => {
    const { dir, file } = shippedCopy();
    const io = capture();
    const { factory, count } = countingFactory();
    const res = await runOptimizeCommand(options(file, dir), { policy: POLICY, surfaceFactory: factory, progress: io.progress, stdout: io.stdout });
    expect(res.exitCode).toBe(0);
    expect(count()).toBe(0);
    expect(res.outPath).toBeUndefined();
    expect(fs.existsSync(defaultOptimizedPath(file))).toBe(false);
    expect(res.report!.stop).toBe('analysis_only');
    expect(res.report!.analysisReason).toBe('not_read_only');
    expect(io.lines.join('\n')).toContain('[redundant_repeated_step]');
    const out = io.out.join('\n');
    expect(out).toContain('--read-only');
    expect(out).toContain('would try collapsing s04 into s03');
    expect(out).toContain('analysis only; nothing written');
    // Both streams together are what a terminal shows: the analysis line is there once.
    const printed = [...io.lines, ...io.out];
    expect(printed.filter((l) => l.startsWith('optimize: analysis only'))).toHaveLength(1);
    expect(new Set(printed).size).toBe(printed.length);
  });

  it('--analyze-only never replays or writes, even with --read-only', async () => {
    const { dir, file } = shippedCopy();
    const io = capture();
    const { factory, count } = countingFactory();
    const res = await runOptimizeCommand(options(file, dir, { readOnly: true, analyzeOnly: true }), { policy: POLICY, surfaceFactory: factory, progress: io.progress, stdout: io.stdout });
    expect(res.exitCode).toBe(0);
    expect(count()).toBe(0);
    expect(res.outPath).toBeUndefined();
    expect(res.report!.analysisReason).toBe('requested');
  });

  it('--read-only is refused on a capability with an irreversible step', async () => {
    const { dir, file } = shippedCopy((cap) => {
      cap.steps.find((s) => s.id === 's08')!.risk = 'irreversible';
      cap.riskLevel = 'irreversible';
    });
    const io = capture();
    const { factory, count } = countingFactory();
    const res = await runOptimizeCommand(options(file, dir, { readOnly: true }), { policy: POLICY, surfaceFactory: factory, progress: io.progress, stdout: io.stdout });
    expect(res.exitCode).toBe(1);
    expect(count()).toBe(0);
    expect(io.lines.join('\n')).toContain('--read-only cannot apply');
  });

  it('a step the POLICY classifies irreversible vetoes trials, even on a read-only capability', async () => {
    const { dir, file } = shippedCopy((cap) => {
      const a = cap.steps.find((s) => s.id === 's07')!.action;
      if (a.type === 'click') a.target.snapshot = { ...a.target.snapshot, name: 'Submit transfer' };
    });
    const { factory, count } = countingFactory();
    const io = capture();
    const res = await runOptimizeCommand(options(file, dir, { readOnly: true }), { policy: POLICY, surfaceFactory: factory, progress: io.progress, stdout: io.stdout });
    expect(count()).toBe(0);
    expect(res.report!.analysisReason).toBe('irreversible_steps');
    expect(res.report!.irreversibleSteps).toEqual(['s07']);
  });
});

/**
 * Surfaces whose clock is instant (a failing step does not wait out its timeout in real time).
 * On the FIRST one only, the first member search lands on the Application Error page; every later
 * search, on that surface or another, works. A retry on the same surface would therefore pass.
 */
function firstSearchFailsOnce(): () => Surface {
  let first = true;
  return () => {
    let now = 0;
    const clock = { now: () => now, sleep: (ms: number) => Promise.resolve(void (now += ms)) };
    const scenario = createCuCoreScenario();
    if (first) {
      first = false;
      let failed = false;
      for (const rule of scenario.rules) {
        if (rule.from !== 'workstation' || (rule.match.targetId !== 'search' && rule.match.key !== 'Enter')) continue;
        const real = rule.to;
        rule.to = (ctx) => {
          if (!failed) {
            failed = true;
            return 'app_error';
          }
          return typeof real === 'function' ? real(ctx) : real;
        };
      }
    }
    return new FakeSurface(scenario, { clock });
  };
}

describe('cu optimize: a trial never retries an app error', () => {
  it('a baseline that hits a transient app error fails, though a retry on the same page would have passed', async () => {
    // Pins `maxAppErrorRetries: 0` in runtime/run-optimize.ts: without it the read-only trial would
    // restart its steps, the second search would work, and a flaky baseline would count as clean.
    const { dir, file } = shippedCopy();
    const io = capture();
    const res = await runOptimizeCommand(options(file, dir, { readOnly: true }), { policy: POLICY, surfaceFactory: firstSearchFailsOnce(), progress: io.progress, stdout: io.stdout });
    expect(res.exitCode).toBe(2);
    expect(res.outPath).toBeUndefined();
  });
});

describe('cu optimize: irreversibility beyond the base steps', () => {
  it('a recovery action the POLICY classifies irreversible (by URL -- which the cu optimize validation cannot see) vetoes trials', async () => {
    const policy = { ...POLICY, risk: { ...POLICY.risk, irreversibleUrlPatterns: [...POLICY.risk.irreversibleUrlPatterns, '/accounts/close'] } };
    const { dir, file } = shippedCopy((cap) => {
      cap.recoveryRules[0]!.actions.push({ type: 'navigate', url: '{baseUrl}/accounts/close' });
    });
    const { factory, count } = countingFactory();
    const io = capture();
    const res = await runOptimizeCommand(options(file, dir, { readOnly: true }), { policy, surfaceFactory: factory, progress: io.progress, stdout: io.stdout });
    expect(res.exitCode).toBe(0);
    expect(count()).toBe(0);
    expect(res.report!.analysisReason).toBe('irreversible_steps');
    expect(res.report!.irreversibleSteps).toEqual(['recovery:dismiss_system_maintenance_notice[2]']);
  });
});

describe('cu optimize --read-only', () => {
  it('writes a verified draft next to the input: duplicate password step and vacuous checkpoints gone, readOnly recorded, version bumped', async () => {
    const { dir, file } = shippedCopy();
    const io = capture();
    const { factory } = countingFactory();
    const res = await runOptimizeCommand(options(file, dir, { readOnly: true }), { policy: POLICY, surfaceFactory: factory, progress: io.progress, stdout: io.stdout });

    expect(res.exitCode, io.lines.join('\n')).toBe(0);
    expect(res.outPath).toBe(path.resolve(defaultOptimizedPath(file)));
    const written = JSON.parse(fs.readFileSync(res.outPath!, 'utf8')) as Capability;
    expect(written.version).toBe('1.2.3');
    expect(written.status).toBe('draft');
    expect(written.readOnly).toBe(true);
    expect(written.steps.map((s) => s.id)).not.toContain('s04');
    expect(written.steps.find((s) => s.id === 's02')!.postcondition).toBeUndefined();
    expect(written.steps.find((s) => s.id === 's03')!.postcondition).toBeUndefined();
    expect(written.provenance.notes).toContain('Optimized by cu optimize');
    // The input is untouched.
    expect((JSON.parse(fs.readFileSync(file, 'utf8')) as Capability).version).toBe('1.2.2');

    const report = JSON.parse(fs.readFileSync(res.reportPath!, 'utf8')) as OptimizeReport;
    expect(report.stop).toBe('completed');
    expect(report.trials.length).toBeGreaterThan(2);
    // Every trial ran as a draft prerelease, never as 1.2.2 or 1.2.3.
    for (const t of report.trials) expect(resultOf(dir, t.runId!).capabilityVersion).toMatch(/^1\.2\.2-optimize\.\d+$/);
    // 10 -> 8: s04 collapsed, and s01 (navigate to the login page) removed -- on the FAKE only,
    // whose session starts on the login page already. A real browser starts on about:blank, where
    // the e2e test (tests/e2e/optimize.test.ts) shows s01 is kept.
    expect(io.out.join('\n')).toContain('steps 10 -> 8');
    expect(written.steps.map((s) => s.id)).toEqual(['s02', 's03', 's05', 's06', 's07', 's08', 's09', 's10']);
  });

  it('never overwrites the input -- also not through a differently-cased path on Windows -- nor an existing default output', async () => {
    const { dir, file } = shippedCopy();
    const io = capture();
    const same = await runOptimizeCommand(options(file, dir, { out: file, readOnly: true }), { policy: POLICY, progress: io.progress, stdout: io.stdout });
    expect(same.exitCode).toBe(1);
    expect(io.lines.join('\n')).toContain('never replaces the artifact it came from');

    if (process.platform === 'win32') {
      const upper = path.join(path.dirname(file), path.basename(file).toUpperCase());
      const res = await runOptimizeCommand(options(file, dir, { out: upper, readOnly: true }), { policy: POLICY, progress: io.progress, stdout: io.stdout });
      expect(res.exitCode).toBe(1);
    }

    fs.writeFileSync(defaultOptimizedPath(file), '{}');
    const exists = await runOptimizeCommand(options(file, dir, { readOnly: true }), { policy: POLICY, progress: io.progress, stdout: io.stdout });
    expect(exists.exitCode).toBe(1);
    expect(io.lines.join('\n')).toContain('already exists');
  });

  it('samePath compares real paths, case-insensitively on win32 only', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-samepath-'));
    dirs.push(dir);
    const f = path.join(dir, 'case.json');
    fs.writeFileSync(f, '{}');
    expect(samePath(path.join(dir, '.', 'x', '..', 'case.json'), f)).toBe(true);
    expect(samePath(path.join(dir, 'CASE.JSON'), f, 'win32')).toBe(true);
    expect(samePath('/tmp/a/CASE.JSON', '/tmp/a/case.json', 'linux')).toBe(false);
  });

  it('a missing or invalid required input is a usage error before anything starts: exit 1, nothing written', async () => {
    const { dir, file } = shippedCopy();
    const io = capture();
    const { factory, count } = countingFactory();
    for (const input of [[], ['memberId=abc']]) {
      const res = await runOptimizeCommand(options(file, dir, { readOnly: true, input }), { policy: POLICY, surfaceFactory: factory, progress: io.progress, stdout: io.stdout });
      expect(res.exitCode, JSON.stringify(input)).toBe(1);
      expect(res.reportPath).toBeUndefined();
    }
    expect(count()).toBe(0);
    expect(fs.existsSync(defaultOptimizedPath(file))).toBe(false);
    expect(io.lines.join('\n')).toContain('--input memberId');
  });

  it('exits 2 and writes nothing when the baseline replay does not succeed', async () => {
    const { dir, file } = shippedCopy();
    const io = capture();
    const { factory } = countingFactory();
    // 99999 is not found: the baseline ends in a business outcome, not success.
    const res = await runOptimizeCommand(options(file, dir, { readOnly: true, input: ['memberId=99999'] }), { policy: POLICY, surfaceFactory: factory, progress: io.progress, stdout: io.stdout });
    expect(res.exitCode).toBe(2);
    expect(res.report!.stop).toBe('baseline_failed');
    expect(res.outPath).toBeUndefined();
    // The reason is printed once across both streams, in the summary.
    const reason = `optimize: ${res.report!.stopDetail}`;
    expect(io.out).toContain(reason);
    expect([...io.lines, ...io.out].filter((l) => l === reason)).toHaveLength(1);
  });

  it('--json prints the report', async () => {
    const { dir, file } = shippedCopy();
    const io = capture();
    const res = await runOptimizeCommand(options(file, dir, { json: true }), { policy: POLICY, progress: io.progress, stdout: io.stdout });
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(io.out.join('\n')) as OptimizeReport & { out?: string };
    expect(parsed.stop).toBe('analysis_only');
    expect(parsed.out).toBeUndefined();
  });

  it('rejects a bad flag value before doing anything', async () => {
    const { dir, file } = shippedCopy();
    const io = capture();
    const res = await runOptimizeCommand(options(file, dir, { verifyRuns: 0 }), { policy: POLICY, progress: io.progress, stdout: io.stdout });
    expect(res.exitCode).toBe(1);
    expect(io.lines.join('\n')).toContain('--verify-runs');
  });
});

describe('cu optimize: trial safety wiring (real runReplay, FakeSurface)', () => {
  it('forces the approval gate in trials: with replayRequiresApproved false, an action the LIVE policy flags irreversible is blocked, not executed', async () => {
    // Statically nothing looks irreversible (the last navigate is /login); at run time every click on
    // /workstation is. Without the forced gate the draft would be allowed to run it.
    const policy = { ...POLICY, risk: { ...POLICY.risk, replayRequiresApproved: false, irreversibleUrlPatterns: ['/workstation'] } };
    const { dir, file } = shippedCopy();
    const io = capture();
    // No maintenance notice: its OK click would be flagged (and skipped) first, which would also
    // block the run, but less legibly.
    const { factory, surfaces } = countingFactory({ interstitial: false });
    const res = await runOptimizeCommand(options(file, dir, { readOnly: true }), { policy, surfaceFactory: factory, progress: io.progress, stdout: io.stdout });
    expect(res.exitCode).toBe(2);
    expect(res.report!.stop).toBe('baseline_failed');
    expect(res.report!.baseline!.detail).toContain('policy_violation at s07');
    // The Search click never reached the app: no session ever got to the search results.
    expect(surfaces.length).toBeGreaterThan(0);
    for (const s of surfaces) expect(s.currentScreenId()).not.toMatch(/^search_results|^member_/);
  });

  it('a trial that escalates is answered by the aborting operator and counts as failed -- no human prompt, no hang', async () => {
    const { dir, file } = shippedCopy((cap) => {
      const s09 = cap.steps.find((s) => s.id === 's09')!;
      s09.onFailure = 'escalate';
      if (s09.action.type === 'extract') s09.action.target.locators = [{ strategy: { kind: 'css', selector: '#does-not-exist' }, confidence: 0.3, source: 'inferred' }];
    });
    const io = capture();
    const { factory } = countingFactory();
    const res = await runOptimizeCommand(options(file, dir, { readOnly: true }), {
      policy: POLICY,
      surfaceFactory: factory,
      stepTimeoutMs: 300,
      progress: io.progress,
      stdout: io.stdout,
    });
    expect(res.exitCode).toBe(2);
    expect(res.report!.baseline!.kind).toBe('escalated');
    const events = fs
      .readFileSync(path.join(dir, 'runs', res.report!.baseline!.runId!, 'events.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { kind: string; data: Record<string, unknown> });
    const resolved = events.find((e) => e.kind === 'escalation' && e.data.phase === 'resolved');
    expect(resolved?.data).toMatchObject({ resumeFrom: 'abort', by: 'scripted-operator' });
  }, 30_000);
});

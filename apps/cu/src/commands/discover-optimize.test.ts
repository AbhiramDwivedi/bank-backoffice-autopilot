/**
 * `discover`'s automatic optimization stage and `--candidates`, through the real `runDiscover`
 * with a scripted LLM and the cu-core FakeSurface: the discovery runs on one fake session, and every
 * optimization trial gets a fresh one (`deps.trialSurface`). No browser, no network, no API key.
 *
 * Trials only run under the operator's read-only declaration (`readOnly: true` in these options);
 * one test runs without it. The scripted discovery takes a successful wrong turn -- it clicks the "Member Search" nav link,
 * which leaves the page as it was -- so the recorded capability carries a step the optimizer can
 * prove is unnecessary.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createScriptedLlm, requestText, type ScriptedTurn } from '@cu/core/agent';
import { findRef } from '@cu/core/agent/test-helpers';
import { DEFAULT_POLICY_PATH, loadPolicy } from '@cu/core/policy';
import type { Capability } from '@cu/core/schema';
import type { OptimizeReport } from '@cu/core/optimize';
import { createCuCoreSurface, type Surface } from '@cu/core/surface';
import { runDiscover, runDiscoverCandidates, type RunDiscoverOptions } from './discover.js';

const POLICY = loadPolicy(DEFAULT_POLICY_PATH);
const NOTICE = 'System Maintenance Notice';
const saved = { user: process.env.MOCK_USER, password: process.env.MOCK_PASSWORD };

beforeAll(() => {
  process.env.MOCK_USER = 'operator1';
  process.env.MOCK_PASSWORD = 'demo-pass-123';
});
afterAll(() => {
  if (saved.user === undefined) delete process.env.MOCK_USER;
  else process.env.MOCK_USER = saved.user;
  if (saved.password === undefined) delete process.env.MOCK_PASSWORD;
  else process.env.MOCK_PASSWORD = saved.password;
});

const dirs: string[] = [];
let logSpy: ReturnType<typeof vi.spyOn> | undefined;
afterEach(() => {
  logSpy?.mockRestore();
  logSpy = undefined;
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'discover-optimize-'));
  dirs.push(d);
  return d;
}

/** Captures the run's report lines (runDiscover writes them to console.log). */
function captureStdout(): string[] {
  const lines: string[] = [];
  logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  return lines;
}

const t = {
  typeSecret: (name: string, env: string, why: string): ScriptedTurn => (req) => ({
    tool: 'type',
    input: { ref: findRef(requestText(req), { role: 'textbox', nameIncludes: name }), source: 'secret', value: env, why, expect: '' },
  }),
  typeInput: (name: string, input: string, why: string): ScriptedTurn => (req) => ({
    tool: 'type',
    input: { ref: findRef(requestText(req), { role: 'textbox', nameIncludes: name }), source: 'input', value: input, why, expect: '' },
  }),
  click: (role: string, name: string, why: string, expectText = ''): ScriptedTurn => (req) => ({
    tool: 'click',
    input: { ref: findRef(requestText(req), { role, nameIncludes: name }), why, expect: expectText },
  }),
  dismiss: (): ScriptedTurn => (req) => ({
    tool: 'dismiss_interstitial',
    input: { ref: findRef(requestText(req), { role: 'clickable', nameIncludes: 'OK' }), trigger_text: NOTICE, title: NOTICE, why: 'Dismiss the notice' },
  }),
  extract: (name: string, output: string, parse: 'text' | 'currency', why: string): ScriptedTurn => (req) => ({
    tool: 'extract',
    input: { ref: findRef(requestText(req), { role: 'cell', nameIncludes: name }), output, parse, why },
  }),
};

function script({ wrongTurn, wrongBalance = false }: { wrongTurn: boolean; wrongBalance?: boolean }): ScriptedTurn[] {
  return [
    t.typeSecret('User ID', 'MOCK_USER', 'Enter the user ID'),
    t.typeSecret('Password', 'MOCK_PASSWORD', 'Enter the password'),
    t.click('button', 'login', 'Sign on', NOTICE),
    t.dismiss(),
    ...(wrongTurn ? [t.click('link', 'Member Search', 'Open the member search page')] : []),
    t.typeInput('Member ID', 'memberId', 'Enter the member ID'),
    t.click('clickable', 'Search', 'Search for the member', 'record(s) found'),
    t.click('clickable', '12345', 'Open the matching result', 'Savings Balance'),
    t.extract('Jane Q. Sample', 'memberName', 'text', 'Read the member name'),
    // wrongBalance: reads the CHECKING balance into savingsBalance -- a candidate that "succeeds" wrongly.
    wrongBalance ? t.extract('$310.00', 'savingsBalance', 'currency', 'Read the balance') : t.extract('$1,234.56', 'savingsBalance', 'currency', 'Read the savings balance'),
    { tool: 'done', input: { success_text: 'Savings Balance', summary: 'Read the name and balance.' } },
  ];
}

function options(dir: string, extra: Partial<RunDiscoverOptions> = {}): RunDiscoverOptions {
  return {
    goal: 'Log in, look up member 12345 and read their name and savings balance.',
    input: ['memberId=12345'],
    sensitive: [],
    output: ['savingsBalance:number', 'memberName:string'],
    id: 'discover-optimize-unit-test',
    out: path.join(dir, 'out.json'),
    entry: '/login',
    vendor: 'Acme Core Systems',
    product: 'CU Core Workstation',
    operatorPort: 0,
    autoOperator: 'abort',
    policy: DEFAULT_POLICY_PATH,
    runsDir: path.join(dir, 'runs'),
    headless: true,
    baseUrl: 'http://localhost:4173',
    optimizeVerifyRuns: 2,
    readOnly: true,
    ...extra,
  };
}

function deps(turns: ScriptedTurn[], trialSurface: () => Surface | Promise<Surface> = () => createCuCoreSurface(), print: (l: string) => void = () => undefined) {
  return { llm: createScriptedLlm(turns), surface: createCuCoreSurface(), trialSurface, policy: POLICY, print };
}

function stepNames(file: string): string[] {
  return (JSON.parse(fs.readFileSync(file, 'utf8')) as Capability).steps.map((s) => s.name);
}

describe('discover: built-in optimization stage', () => {
  it('with --read-only: optimizes before writing -- the wrong turn is gone, readOnly recorded, optimize.json in the run dir', async () => {
    const dir = tempDir();
    const out = captureStdout();
    const progress: string[] = [];
    const res = await runDiscover(options(dir), deps(script({ wrongTurn: true }), undefined, (l) => progress.push(l)));

    expect(res.exitCode, out.join('\n')).toBe(0);
    expect(res.optimize?.optimized).toBe(true);
    // The as-discovered capability is in the run dir, announced before the stage started.
    const discovered = path.join(res.runDir, 'capability.json');
    expect(stepNames(discovered)).toContain('Open the member search page');
    expect(progress.join('\n')).toContain(`the capability as discovered is saved at ${discovered}`);
    const written = JSON.parse(fs.readFileSync(res.artifactPath!, 'utf8')) as Capability;
    expect(written.steps.map((s) => s.name)).not.toContain('Open the member search page');
    expect(written.readOnly).toBe(true);
    expect(written.status).toBe('draft');
    expect(written.version).toBe('1.0.0');
    expect(written.provenance.notes).toContain(`Optimized by discover run ${res.result!.runId}`);

    const report = JSON.parse(fs.readFileSync(path.join(res.runDir, 'optimize.json'), 'utf8')) as OptimizeReport;
    expect(report.stop).toBe('completed');
    expect(report.changes.some((c) => c.kind === 'removed_step' && c.name === 'Open the member search page')).toBe(true);
    expect(out.join('\n')).toMatch(/optimize: steps \d+ -> \d+/);
  });

  it('without --read-only: no trial, nothing rewritten, one line saying why and how to enable it', async () => {
    const dir = tempDir();
    const out = captureStdout();
    const progress: string[] = [];
    let trials = 0;
    const res = await runDiscover(
      options(dir, { readOnly: false }),
      deps(
        script({ wrongTurn: true }),
        () => {
          trials += 1;
          return createCuCoreSurface();
        },
        (l) => progress.push(l),
      ),
    );
    expect(res.exitCode).toBe(0);
    expect(trials).toBe(0);
    expect(res.optimize?.optimized).toBe(false);
    expect(stepNames(res.artifactPath!)).toEqual(stepNames(path.join(res.runDir, 'capability.json')));
    // One line on both streams together: the progress stream used to carry the optimizer's own
    // wording of the same thing.
    expect([...progress, ...out].filter((l) => l.startsWith('optimize:'))).toEqual([
      'optimize: not run -- the goal was not declared read-only, so nothing was replayed or rewritten (rerun discover with --read-only, or `cu optimize --read-only`, if replaying it changes nothing in the app)',
    ]);
    expect((JSON.parse(fs.readFileSync(path.join(res.runDir, 'optimize.json'), 'utf8')) as OptimizeReport).analysisReason).toBe('not_read_only');
  });

  it('a baseline that does not replay: the reason is reported once, and the capability is written as discovered', async () => {
    const dir = tempDir();
    const out = captureStdout();
    const progress: string[] = [];
    // Every trial session fails the member search, so the unmodified capability does not replay.
    const res = await runDiscover(options(dir), deps(script({ wrongTurn: true }), () => createCuCoreSurface({ failSearch: true }), (l) => progress.push(l)));
    expect(res.exitCode, out.join('\n')).toBe(0);
    expect(res.optimize?.optimized).toBe(false);
    expect(res.optimize?.report?.stop).toBe('baseline_failed');
    expect(stepNames(res.artifactPath!)).toEqual(stepNames(path.join(res.runDir, 'capability.json')));
    const reason = `optimize: ${res.optimize!.report!.stopDetail}`;
    expect(out).toContain(reason);
    expect([...progress, ...out].filter((l) => l === reason)).toHaveLength(1);
  });

  it('--no-optimize writes the capability exactly as discovered', async () => {
    const dir = tempDir();
    const out = captureStdout();
    const res = await runDiscover(options(dir, { optimize: false }), deps(script({ wrongTurn: true })));
    expect(res.exitCode).toBe(0);
    expect(res.optimize?.skipped).toBe('--no-optimize');
    expect(stepNames(res.artifactPath!)).toEqual(stepNames(path.join(res.runDir, 'capability.json')));
    expect(out.join('\n')).toContain('optimize: skipped (--no-optimize)');
  });

  it('a failure inside the optimizer never loses the discovered capability', async () => {
    const dir = tempDir();
    const out = captureStdout();
    const res = await runDiscover(
      options(dir),
      deps(script({ wrongTurn: true }), () => {
        throw new Error('trial session could not be opened');
      }),
    );
    expect(res.exitCode).toBe(0);
    expect(res.optimize?.optimized).toBe(false);
    expect(res.optimize?.error).toContain('trial session could not be opened');
    expect(stepNames(res.artifactPath!)).toEqual(stepNames(path.join(res.runDir, 'capability.json')));
    expect(JSON.parse(fs.readFileSync(path.join(res.runDir, 'optimize.json'), 'utf8'))).toEqual({ error: 'trial session could not be opened' });
    expect(out.join('\n')).toContain('writing the capability as discovered');
  });

  it('Ctrl-C during the stage stops it between trials and still writes the capability as discovered', async () => {
    const dir = tempDir();
    captureStdout();
    let trials = 0;
    const savedExit = process.exitCode;
    try {
      const res = await runDiscover(
        options(dir),
        deps(script({ wrongTurn: true }), () => {
          trials += 1;
          if (trials === 2) process.emit('SIGINT', 'SIGINT');
          return createCuCoreSurface();
        }),
      );
      expect(res.exitCode).toBe(130);
      expect(trials).toBe(2);
      expect(res.artifactPath).toBeDefined();
      expect(stepNames(res.artifactPath!)).toEqual(stepNames(path.join(res.runDir, 'capability.json')));
      expect((JSON.parse(fs.readFileSync(path.join(res.runDir, 'optimize.json'), 'utf8')) as OptimizeReport).stop).toBe('aborted');
    } finally {
      process.exitCode = savedExit;
    }
  });

  it('--read-only on a run that performed an irreversible action: the declaration is dropped, the capability is still written, exit 0, no trials', async () => {
    const dir = tempDir();
    const out = captureStdout();
    const progress: string[] = [];
    let trials = 0;
    // The policy calls the Search click irreversible; the scripted operator confirms it.
    const policy = { ...POLICY, risk: { ...POLICY.risk, irreversibleTextPatterns: [...POLICY.risk.irreversibleTextPatterns, '^Search$'] } };
    const res = await runDiscover(options(dir, { autoOperator: 'approve', allowUnattendedIrreversible: true }), {
      ...deps(
        script({ wrongTurn: false }),
        () => {
          trials += 1;
          return createCuCoreSurface();
        },
        (l) => progress.push(l),
      ),
      policy,
    });
    expect(res.exitCode, out.join('\n')).toBe(0);
    expect(res.result?.readOnlyDropped?.length).toBe(1);
    const written = JSON.parse(fs.readFileSync(res.artifactPath!, 'utf8')) as Capability;
    expect(written.readOnly).toBeUndefined();
    expect(written.steps.some((s) => s.risk === 'irreversible')).toBe(true);
    expect(trials).toBe(0);
    expect(progress.join('\n')).toContain('the read-only declaration was removed from the capability');
    expect(out.join('\n')).toContain('performed an irreversible action');
  });

  it('passes --optimize-max-trials through', async () => {
    const dir = tempDir();
    captureStdout();
    const res = await runDiscover(options(dir, { optimizeMaxTrials: 0 }), deps(script({ wrongTurn: true })));
    expect(res.optimize?.report?.removalTrialsUsed).toBe(0);
    expect(stepNames(res.artifactPath!)).toContain('Open the member search page');
  });
});

describe('discover --candidates', () => {
  it('keeps the verified candidate with the fewest steps; every candidate stays in its own run dir', async () => {
    const dir = tempDir();
    const out = captureStdout();
    // With no removal trials the wrong turn survives optimization, so candidate 1 is longer.
    const turns = [...script({ wrongTurn: true }), ...script({ wrongTurn: false })];
    const res = await runDiscoverCandidates(options(dir, { candidates: 2, optimizeMaxTrials: 0 }), deps(turns));

    expect(res.exitCode, out.join('\n')).toBe(0);
    expect(res.artifactPath).toBe(path.resolve(dir, 'out.json'));
    expect(stepNames(res.artifactPath!)).not.toContain('Open the member search page');
    expect(out.join('\n')).toContain('kept candidate 2');

    const runDirs = fs.readdirSync(path.join(dir, 'runs')).filter((d) => fs.existsSync(path.join(dir, 'runs', d, 'candidate.json')));
    expect(runDirs).toHaveLength(2);
    const loser = runDirs.map((d) => path.join(dir, 'runs', d, 'candidate.json')).find((f) => stepNames(f).includes('Open the member search page'));
    expect(loser).toBeDefined();
  });

  it('keeps none when verified candidates disagree on the outputs (a shorter candidate read the wrong field)', async () => {
    const dir = tempDir();
    captureStdout();
    const lines: string[] = [];
    const turns = [...script({ wrongTurn: true }), ...script({ wrongTurn: false, wrongBalance: true })];
    const res = await runDiscoverCandidates(options(dir, { candidates: 2, optimizeMaxTrials: 0 }), deps(turns, undefined, (l) => lines.push(l)));
    expect(res.exitCode).toBe(2);
    expect(res.artifactPath).toBeUndefined();
    expect(fs.existsSync(path.join(dir, 'out.json'))).toBe(false);
    expect(lines.join('\n')).toContain('disagree on savingsBalance');
    expect(lines.join('\n')).not.toContain('1234.56');
    expect(fs.readdirSync(path.join(dir, 'runs')).filter((d) => fs.existsSync(path.join(dir, 'runs', d, 'candidate.json')))).toHaveLength(2);
  });

  it('requires --read-only, and rejects a non-positive count', async () => {
    const dir = tempDir();
    const lines: string[] = [];
    const noRo = await runDiscoverCandidates(options(dir, { candidates: 2, readOnly: false }), { ...deps([]), print: (l: string) => lines.push(l) });
    expect(noRo.exitCode).toBe(1);
    expect(lines.join('\n')).toContain('--candidates requires --read-only');
    const zero = await runDiscoverCandidates(options(dir, { candidates: 0 }), { ...deps([]), print: (l: string) => lines.push(l) });
    expect(zero.exitCode).toBe(1);
  });
});

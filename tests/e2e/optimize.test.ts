/**
 * End-to-end: the optimizer against the REAL mock app (tenant A, ephemeral port) in Chromium,
 * every trial a real replay through the CLI's own wiring (runOptimize -> runReplay -> compose).
 *
 * 1. The shipped artifact (artifacts/lookup-member-savings-balance.json, unpatched) under the
 *    operator's read-only declaration: the
 *    duplicate password step (s04) and the two vacuous "Password:" checkpoints (s02, and s04's,
 *    merged into s03) are gone, the entry navigate (s01) is kept -- a real browser starts on
 *    about:blank -- and the optimized draft still replays to the same balance.
 * 2. `cu optimize` as a real child process without --read-only (no browser): it only analyses,
 *    writes nothing, and prints the validator's repeat warning and how to enable trials.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { validateCapability, type Capability } from '@cu/core/schema';
import { runOptimize } from '@cu/cli/runtime';
import { launchBrowser, policyFor, replayOnce, runCli, startMock, tempRunsDir, PASSWORD, USER, type MockServer } from './harness.js';

const SHIPPED = path.resolve('artifacts/lookup-member-savings-balance.json');

function loadShipped(): Capability {
  const res = validateCapability(JSON.parse(fs.readFileSync(SHIPPED, 'utf8')));
  if (!res.ok) throw new Error(JSON.stringify(res.issues));
  return res.capability;
}

describe('optimize: the shipped artifact against the real mock app', () => {
  let browser: Browser;
  let mock: MockServer;

  beforeAll(async () => {
    process.env.MOCK_USER ??= USER;
    process.env.MOCK_PASSWORD ??= PASSWORD;
    browser = await launchBrowser();
    mock = await startMock('a');
  });

  afterAll(async () => {
    await mock.close();
    await browser.close();
  });

  it('drops the duplicate password step and both vacuous checkpoints, keeps the rest, and still returns the same balance', async () => {
    const shipped = loadShipped();
    const runsDir = tempRunsDir('optimize-e2e-');
    const lines: string[] = [];
    // The operator's read-only declaration (what `cu optimize --read-only` asserts): a lookup.
    const { capability, report, baselineOutputs } = await runOptimize({
      capability: { ...shipped, readOnly: true },
      inputs: { memberId: '12345' },
      policy: policyFor(mock.baseUrl),
      runsDir,
      baseUrl: mock.baseUrl,
      headless: true,
      browser,
      verifyRuns: 2,
      removalStepTimeoutMs: 2_000,
      bumpVersion: true,
      source: 'e2e',
      log: (l) => lines.push(l),
    });

    expect(report.stop, lines.join('\n')).toBe('completed');
    expect(baselineOutputs).toEqual({ savingsBalance: 1234.56, memberName: 'Jane Q. Sample' });

    const ids = capability.steps.map((s) => s.id);
    expect(ids).not.toContain('s04');
    expect(ids).toContain('s01'); // about:blank first: the entry navigate is needed
    expect(capability.steps.find((s) => s.id === 's02')!.postcondition).toBeUndefined();
    expect(capability.steps.find((s) => s.id === 's03')!.postcondition).toBeUndefined();
    expect(report.changes.filter((c) => c.kind === 'dropped_vacuous_postcondition').map((c) => c.stepId)).toEqual(['s02', 's03']);
    // The checkpoints that do real work are untouched, and so is every override-referenced step.
    expect(capability.steps.find((s) => s.id === 's07')!.postcondition).toEqual(shipped.steps.find((s) => s.id === 's07')!.postcondition);
    expect(capability.steps.find((s) => s.id === 's08')!.postcondition).toEqual(shipped.steps.find((s) => s.id === 's08')!.postcondition);
    for (const id of ['s06', 's07', 's08', 's09', 's10']) expect(ids).toContain(id);
    expect(capability.version).toBe('1.2.3');
    expect(capability.status).toBe('draft');
    expect(validateCapability(capability).ok).toBe(true);

    const replay = await replayOnce({ browser, mock, capability, inputs: { memberId: '12345' }, runsDir: tempRunsDir('optimize-e2e-replay-') });
    expect(replay.result.kind).toBe('success');
    if (replay.result.kind === 'success') expect(replay.result.outputs).toEqual({ savingsBalance: 1234.56, memberName: 'Jane Q. Sample' });
  }, 240_000);
});

describe('optimize: the cu optimize CLI', () => {
  it('without --read-only it only analyses: no browser, no artifact, the repeat warning and how to enable trials', async () => {
    const dir = tempRunsDir('optimize-cli-');
    const input = path.join(dir, 'lookup-member-savings-balance.json');
    fs.copyFileSync(SHIPPED, input);
    const res = await runCli(['--runs-dir', path.join(dir, 'runs'), 'optimize', input, '--input', 'memberId=12345']);
    expect(res.code, res.stderr).toBe(0);
    expect(res.stderr).toContain('[redundant_repeated_step]');
    expect(res.stdout).toContain('would try collapsing s04 into s03');
    expect(res.stdout).toContain('--read-only');
    expect(res.stdout).toContain('analysis only; nothing written');
    expect(fs.existsSync(path.join(dir, 'lookup-member-savings-balance.optimized.json'))).toBe(false);
    expect(fs.readFileSync(input, 'utf8')).toBe(fs.readFileSync(SHIPPED, 'utf8'));
  }, 60_000);

  it('cu validate prints the repeat as a warning and still exits 0', async () => {
    const res = await runCli(['validate', SHIPPED]);
    expect(res.code).toBe(0);
    expect(res.stderr).toContain('[redundant_repeated_step]');
  }, 60_000);
});

/**
 * End-to-end: the bounded retry of a transient app error, as `cu replay --read-only` in a real
 * child process against the real mock app with seeded chaos, real Chromium and the shipped
 * capability `artifacts/lookup-member-savings-balance.json`.
 *
 * The shipped artifact does not carry `readOnly` (it is approved and content-bound, and is not
 * modified here), so the assertion comes from the run: `--read-only`. Without it nothing changes.
 *
 * The seeds are pinned from the `failSearch` stream alone (it draws once per `GET /members/search`:
 * the workstation's first load of the search page, then the search itself):
 *
 *   seed 5   draws . X . .   the SEARCH fails. The Search click (s07) passes its checkpoint on the
 *                            error page, and the next step (s08) is the one that fails, classified
 *                            `app_error`. Retrying s08, or s07, in place cannot work, and neither
 *                            can resuming at the member-id step: the error page replaced the frame
 *                            that holds the search form. The retry restarts at s01.
 *   seed 31  draws . X X . . the search fails, then the restarted run's first search-page load
 *                            fails too: two retries, then the balance.
 *
 * `{"failSearch": true}` fails every search: the retries run out and the run is an honest
 * `hard_failure app_error` with both attempts in `recoveries`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { runCli, startMock, tempRunsDir, writePolicyFile, type MockServer } from './harness.js';
import type { ReplayResult } from '@cu/core/schema';
import type { StabilitySummary } from '@cu/core/replay';

const SHIPPED_ARTIFACT = path.resolve('artifacts/lookup-member-savings-balance.json');
const RETRY = 'retry_app_error';
const NOTICE = 'dismiss_system_maintenance_notice';
const BALANCE = { savingsBalance: 1234.56, memberName: 'Jane Q. Sample' };

interface ChaosOut {
  seed: number;
  report?: { stats: Record<string, { draws: number; fired: number }>; log: { kind: string; draw: number; path: string }[] };
}
interface SeriesOutput {
  runs: ReplayResult[];
  stability: StabilitySummary;
  chaos?: ChaosOut;
}

describe('cli e2e: replay --read-only retries a transient app error', () => {
  let mock: MockServer;
  let runsDir: string;
  let policyFile: string;

  beforeAll(async () => {
    mock = await startMock('a');
    runsDir = tempRunsDir('e2e-app-error-retry-');
    policyFile = writePolicyFile(runsDir, mock.baseUrl);
  });

  afterAll(async () => {
    await mock.close();
  });

  async function replay(fault: unknown, extra: string[] = []): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return runCli([
      'replay',
      SHIPPED_ARTIFACT,
      '--input',
      'memberId=12345',
      '--json',
      '--base-url',
      mock.baseUrl,
      '--policy',
      policyFile,
      '--runs-dir',
      runsDir,
      '--operator-port',
      '0',
      '--auto-operator',
      'abort',
      '--fault',
      JSON.stringify(fault),
      ...extra,
    ]);
  }

  function events(runId: string): { kind: string; stepId?: string; data: Record<string, unknown> }[] {
    return fs
      .readFileSync(path.join(runsDir, runId, 'events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { kind: string; stepId?: string; data: Record<string, unknown> });
  }
  const retries = (runId: string) => events(runId).filter((e) => e.kind === 'recovery' && e.data.rule === RETRY);

  it(
    'seed 5, the search itself fails: without --read-only a hard_failure app_error; with it, one retry from s01 and the real balance',
    async () => {
      const fault = { chaos: { seed: 5, failSearch: 0.2 } };

      // Nothing asserts read-only: the run ends where it always did, at the step AFTER the search.
      const plain = await replay(fault);
      expect(plain.code).toBe(4);
      const failed = JSON.parse(plain.stdout) as ReplayResult;
      expect(failed.kind).toBe('hard_failure');
      if (failed.kind !== 'hard_failure') throw new Error('expected hard_failure');
      expect(failed.code).toBe('app_error');
      expect(failed.stepId).toBe('s08');
      expect(failed.recoveries).not.toContain(RETRY);
      expect(retries(failed.runId)).toEqual([]);

      const res = await replay(fault, ['--read-only']);
      expect(res.code).toBe(0);
      expect(res.stderr).toContain('--read-only asserts, for this run only');
      const result = JSON.parse(res.stdout) as ReplayResult;
      expect(result.kind).toBe('success');
      if (result.kind !== 'success') throw new Error('expected success');
      expect(result.outputs).toEqual(BALANCE);
      // One notice per sign-in (the retry signs in again), the retry between them.
      expect(result.recoveries).toEqual([NOTICE, RETRY, NOTICE]);

      const log = events(result.runId);
      // The Search click passed on the error page; the failure surfaced one step later.
      expect(log.filter((e) => e.kind === 'error').map((e) => [e.stepId, e.data.code, e.data.originalCode])).toEqual([['s08', 'app_error', 'element_not_found']]);
      expect(retries(result.runId).map((e) => ({ stepId: e.stepId, ...e.data }))).toEqual([
        { stepId: 's08', rule: RETRY, attempt: 1, of: 2, backoffMs: 1000, restartAt: 's01', recoveryBudgetsReset: true },
      ]);
      // Every step ran again from the entry navigation: 7 completed before the failure, then all 10.
      expect(result.stepsExecuted).toBe(17);
    },
    240_000,
  );

  it(
    'seed 31, two failures in a row: two retries, then the balance; the stability report counts the retry next to the declared recovery rule',
    async () => {
      const fault = { chaos: { seed: 31, failSearch: 0.2 } };
      const res = await replay(fault, ['--read-only', '--times', '2']);
      expect(res.code).toBe(0);
      const out = JSON.parse(res.stdout) as SeriesOutput;

      expect(out.runs.map((r) => r.kind)).toEqual(['success', 'success']);
      for (const run of out.runs) expect(run.kind === 'success' ? run.outputs : undefined).toEqual(BALANCE);
      expect(out.runs[0]!.recoveries.filter((r) => r === RETRY)).toHaveLength(2);
      expect(out.runs[1]!.recoveries).not.toContain(RETRY);
      // Run 1's failures: the search (seen at s08), then the restarted run's first search-page load
      // (seen at s06, the member-id step, which has no field to type into).
      expect(retries(out.runs[0]!.runId).map((e) => [e.stepId, e.data.attempt, e.data.backoffMs, e.data.restartAt])).toEqual([
        ['s08', 1, 1000, 's01'],
        ['s06', 2, 2000, 's01'],
      ]);

      expect(out.stability.byKind).toEqual({ success: 2, business_outcome: 0, hard_failure: 0, escalated: 0 });
      expect(out.stability.recoveries[RETRY]).toEqual({ fired: 2, runs: 1 });
      expect(out.stability.recoveries[NOTICE]?.runs).toBe(2);
      expect(res.stderr).toMatch(/retry_app_error\s+2\s+in 1 run\(s\)/);

      expect(out.chaos?.seed).toBe(31);
      expect(out.chaos?.report?.stats.failSearch).toEqual({ draws: 7, fired: 2 });
      expect(out.chaos?.report?.log.map((e) => `${e.kind} ${e.path} draw ${e.draw}`)).toEqual(['failSearch /members/search draw 2', 'failSearch /members/search draw 3']);
    },
    300_000,
  );

  it(
    'every search fails: the retries run out and the result is hard_failure app_error, with both attempts in recoveries',
    async () => {
      const res = await replay({ failSearch: true }, ['--read-only']);
      expect(res.code).toBe(4);
      const result = JSON.parse(res.stdout) as ReplayResult;
      expect(result.kind).toBe('hard_failure');
      if (result.kind !== 'hard_failure') throw new Error('expected hard_failure');
      expect(result.code).toBe('app_error');
      expect(result.recoveries).toEqual([RETRY, RETRY]);
      const log = retries(result.runId).map((e) => e.data);
      expect(log).toHaveLength(3);
      expect(log[2]).toEqual({ rule: RETRY, skipped: true, reason: 'the retry budget is spent (2 of 2)' });
    },
    240_000,
  );
});

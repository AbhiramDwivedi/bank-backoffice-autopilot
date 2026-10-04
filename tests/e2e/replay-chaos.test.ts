/**
 * End-to-end: `cu replay --times N` under the mock app's seeded chaos (apps/mock-app/chaos.ts),
 * as a real child process against the real mock app on an ephemeral port, with real Chromium and
 * the shipped capability `artifacts/lookup-member-savings-balance.json`.
 *
 * This is the payoff of seeding: the runtime's behaviour under intermittent faults becomes a
 * deterministic regression test. The series below is pinned to seed 2, which over three runs
 * exercises both sides of the taxonomy:
 *
 *   run 1  the maintenance notice shows on the search page (once per session), and chaos shows it
 *          again on the results page and on the member page -> two `dismiss_system_maintenance_notice`
 *          recoveries (the rule's per-run budget is 2; the third notice is on the extract-only page
 *          and does not block it) -> success
 *   run 2  chaos fails the first member-search load (HTTP 500 "Application Error")
 *          -> hard_failure app_error
 *   run 3  the session notice plus one chaos notice on the results page -> two recoveries -> success
 *
 * The test runs the identical series twice and requires the identical breakdown, chaos counters
 * and chaos log, which is what "same seed, same request sequence" promises. If a change to the
 * replay engine, the capability or the mock app moves these numbers, that is a behaviour change
 * under intermittent faults and this test is where it shows.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { runCli, startMock, tempRunsDir, writePolicyFile, type MockServer } from './harness.js';
import type { ReplayResult } from '@cu/core/schema';
import type { StabilitySummary } from '@cu/core/replay';

const SHIPPED_ARTIFACT = path.resolve('artifacts/lookup-member-savings-balance.json');

interface SeriesOutput {
  runs: ReplayResult[];
  stability: StabilitySummary;
  chaos?: {
    seed: number;
    fault: unknown;
    report?: { config: unknown; stats: Record<string, { draws: number; fired: number }>; log: { seq: number; kind: string; draw: number; method: string; path: string }[] };
  };
}

describe('cli e2e: replay --times under seeded chaos', () => {
  let mock: MockServer;
  let runsDir: string;
  let policyFile: string;

  beforeAll(async () => {
    mock = await startMock('a');
    runsDir = tempRunsDir('e2e-chaos-');
    policyFile = writePolicyFile(runsDir, mock.baseUrl);
  });

  afterAll(async () => {
    await mock.close();
  });

  async function series(fault: unknown, times: number): Promise<{ code: number | null; out: SeriesOutput; stderr: string }> {
    const res = await runCli([
      'replay',
      SHIPPED_ARTIFACT,
      '--input',
      'memberId=12345',
      '--times',
      String(times),
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
      'relogin',
      '--fault',
      JSON.stringify(fault),
    ]);
    // `--times 1` prints the single ReplayResult rather than a series summary.
    const out = times === 1 ? ({ runs: [JSON.parse(res.stdout) as ReplayResult] } as SeriesOutput) : (JSON.parse(res.stdout) as SeriesOutput);
    return { code: res.code, out, stderr: res.stderr };
  }

  /** Everything about a series that the seed promises to reproduce (not run ids or durations). */
  function fingerprint(out: SeriesOutput): unknown {
    const s = out.stability;
    return {
      runs: out.runs.map((r) => ({ kind: r.kind, code: r.kind === 'hard_failure' ? r.code : undefined, recoveries: r.recoveries, steps: r.stepsExecuted })),
      stability: [s.byKind, s.failures, s.businessOutcomes, s.escalationBreakdown, s.recoveries, s.fallbackDepths, s.drift],
      chaos: out.chaos,
    };
  }

  it(
    'pinned seed: the exact breakdown, recoveries and injected faults, identical on a second run of the series',
    async () => {
      const fault = { chaos: { seed: 2, failSearch: 0.2, interstitial: 0.6 } };
      const first = await series(fault, 3);

      expect(first.code).toBe(4); // worst run: hard_failure
      expect(first.out.runs.map((r) => r.kind)).toEqual(['success', 'hard_failure', 'success']);
      const failed = first.out.runs[1]!;
      expect(failed.kind === 'hard_failure' ? failed.code : undefined).toBe('app_error');

      const s = first.out.stability;
      expect(s.byKind).toEqual({ success: 2, business_outcome: 0, hard_failure: 1, escalated: 0 });
      expect(s.failures).toEqual({ app_error: 1 });
      expect(s.businessOutcomes).toEqual({});
      expect(s.escalationBreakdown).toEqual({ reason: {}, resolution: {}, outcome: {} });
      expect(s.recoveries).toEqual({ dismiss_system_maintenance_notice: { fired: 4, runs: 2 } });
      // Every resolution at the first locator: 9 steps + 2 notice dismissals in each successful run,
      // 4 sign-on steps before the failed search in run 2 (the failing step resolves nothing).
      expect(s.fallbackDepths).toEqual({ '0': 26 });
      expect(s.drift.total).toBe(26);

      expect(first.out.chaos?.seed).toBe(2);
      expect(first.out.chaos?.fault).toEqual(fault);
      expect(first.out.chaos?.report?.stats).toEqual({ failSearch: { draws: 5, fired: 1 }, interstitial: { draws: 4, fired: 3 } });
      expect(first.out.chaos?.report?.log.map((e) => `${e.kind} ${e.path} draw ${e.draw}`)).toEqual([
        'interstitial /members/search draw 1',
        'interstitial /members/12345 draw 2',
        'failSearch /members/search draw 3',
        'interstitial /members/search draw 3',
      ]);
      expect(first.stderr).toContain(`re-run this exact series: the same replay command (artifact, --input and other flags unchanged) with --times 3 --fault '${JSON.stringify(fault)}'`);

      // The CLI restored the pre-run faults: chaos is off again.
      const after = (await (await fetch(`${mock.baseUrl}/__faults`)).json()) as { chaos: unknown };
      expect(after.chaos).toBeNull();

      const second = await series(fault, 3);
      expect(fingerprint(second.out)).toEqual(fingerprint(first.out));
    },
    240_000,
  );

  /** The run's escalations in order: `X@<step>` raised, `->sNN` the resume point replay accepted. */
  function escalationChain(runId: string): string[] {
    const events = fs
      .readFileSync(path.join(runsDir, runId, 'events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { kind: string; stepId?: string; data: Record<string, unknown> });
    return events
      .filter((e) => e.kind === 'escalation' && (e.data.phase === 'raised' || e.data.phase === 'resume_at' || e.data.phase === 'resume_at_refused'))
      .map((e) => (e.data.phase === 'raised' ? `X@${e.stepId ?? 'success'}` : `${e.data.phase === 'resume_at' ? '' : 'refused '}->${String(e.data.to)}`));
  }

  const BALANCE = { kind: 'success', outputs: { savingsBalance: 1234.56, memberName: 'Jane Q. Sample' } };

  /**
   * Found by chaos, fixed, and pinned here (docs/design/mock-app.md, "What chaos found"). Seed 38
   * expires the session on draw 2 of the expireSession stream (0.136): the results page that step
   * s07 ("Search for the member by ID") navigates to, after s06 typed the member id. Before the fix
   * the relogin operator handed back `current_step`, replay re-ran only s07 on the emptied form,
   * and the unbound `member_not_found` detector reported a member who exists as not found, as
   * `escalated / resumed_success`. Now relogin asks replay to resume at the first step after the
   * sign-in (s06), so the id is typed again.
   *
   * The stream's draws do not depend on the probability, only on the seed: at 0.2 that first
   * expiry is the only one and the balance comes back; at 0.5 (the original repro) three more
   * draws fire (the member page, then the workstation twice), each relogin resumes at s06 again,
   * and the run spends maxEscalations and ends in an honest session_expired. Seed 1 at 0.5 puts
   * the expiry on the member page instead (s08), after the search succeeded.
   */
  it.each([
    { name: 'seed 38 @ 0.2, expiry on the s07 search: resumes at s06, balance', seed: 38, p: 0.2, stepId: 's07', chain: ['X@s07', '->s06'], outcome: BALANCE, resolution: 'resumed_success' },
    { name: 'seed 1 @ 0.5, expiry on the s08 member page: rewinds to s06, balance', seed: 1, p: 0.5, stepId: 's08', chain: ['X@s08', '->s06'], outcome: BALANCE, resolution: 'resumed_success' },
    {
      // Three re-logins = four sessions, each showing the once-per-session maintenance notice: the
      // shipped rule's budget (2) is reset on each resume after a lost session, so every one is dismissed.
      name: 'seed 7 @ 0.5, three expiries (search, search, workstation load): a new notice per session, all dismissed, balance',
      seed: 7,
      p: 0.5,
      stepId: 's06',
      chain: ['X@s07', '->s06', 'X@s07', '->s06', 'X@s06', '->s06'],
      outcome: BALANCE,
      resolution: 'resumed_success',
    },
    {
      name: 'seed 38 @ 0.5 (the original repro), four expiries: every relogin resumes at s06, then the escalation budget runs out',
      seed: 38,
      p: 0.5,
      stepId: 's06',
      chain: ['X@s07', '->s06', 'X@s08', '->s06', 'X@s06', '->s06'],
      outcome: { kind: 'hard_failure', code: 'session_expired', stepId: 's06' },
      resolution: 'resumed_failed',
    },
  ])(
    'session expiry under chaos, relogin: $name',
    async ({ seed, p, stepId, chain, outcome, resolution }) => {
      const { out } = await series({ chaos: { seed, expireSession: p } }, 1);
      const run = out.runs[0]!;
      expect(run.kind).toBe('escalated');
      if (run.kind !== 'escalated') throw new Error(`expected escalated, got ${run.kind}`);
      // Never a business answer for member 12345, who exists.
      expect(run.outcome?.kind).not.toBe('business_outcome');
      expect(run.stepId).toBe(stepId);
      expect(run.resolution).toBe(resolution);
      expect(run.outcome).toMatchObject(outcome);
      expect(escalationChain(run.runId)).toEqual(chain);
    },
    180_000,
  );
});

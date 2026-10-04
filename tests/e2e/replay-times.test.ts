/**
 * End-to-end: `cu replay --times N` (apps/cu/src/commands/replay.ts) against the REAL mock app,
 * spawned as a real child process exactly like tests/e2e/cli.test.ts does. Proves the series runs
 * N times in one shared browser and the `--json` stability summary on stdout is `{ runs,
 * stability }` with `stability.runs === N` and every run successful.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXAMPLE_ARTIFACT, PASSWORD, runCli, startMock, tempRunsDir, writePolicyFile, type MockServer } from './harness.js';
import type { ReplayResult } from '@cu/core/schema';
import type { StabilitySummary } from '@cu/core/replay';

describe('cli e2e: replay --times', () => {
  let mock: MockServer;
  let runsDir: string;
  let policyFile: string;

  beforeAll(async () => {
    mock = await startMock('a');
    runsDir = tempRunsDir();
    policyFile = writePolicyFile(runsDir, mock.baseUrl);
  });

  afterAll(async () => {
    await mock.close();
  });

  it(
    '--times 2 runs the series in one browser, reports 2 successful runs, own run dirs, exit 0',
    async () => {
      const res = await runCli([
        'replay',
        EXAMPLE_ARTIFACT,
        '--input',
        'memberId=12345',
        '--times',
        '2',
        '--json',
        '--base-url',
        mock.baseUrl,
        '--policy',
        policyFile,
        '--runs-dir',
        runsDir,
        '--operator-port',
        '0',
      ]);
      expect(res.stdout).not.toContain(PASSWORD);
      expect(res.stderr).not.toContain(PASSWORD);
      expect(res.code).toBe(0);

      const parsed = JSON.parse(res.stdout) as { runs: ReplayResult[]; stability: StabilitySummary };
      expect(parsed.runs).toHaveLength(2);
      expect(parsed.runs.every((r) => r.kind === 'success')).toBe(true);
      // Every run's own runId is a distinct run directory under runsDir with its own result.json.
      const runIds = new Set(parsed.runs.map((r) => r.runId));
      expect(runIds.size).toBe(2);
      for (const runId of runIds) {
        expect(fs.existsSync(path.join(runsDir, runId, 'result.json'))).toBe(true);
      }

      expect(parsed.stability.runs).toBe(2);
      expect(parsed.stability.successes).toBe(2);
      expect(parsed.stability.escalations).toBe(0);
      expect(parsed.stability.failures).toEqual({});
      expect(parsed.stability.meanDurationMs).toBeGreaterThan(0);
    },
    120_000,
  );

  it('rejects a non-positive/non-integer --times (exit 1)', async () => {
    const res = await runCli([
      'replay',
      EXAMPLE_ARTIFACT,
      '--input',
      'memberId=12345',
      '--times',
      '0',
      '--json',
      '--base-url',
      mock.baseUrl,
      '--policy',
      policyFile,
      '--runs-dir',
      runsDir,
      '--operator-port',
      '0',
    ]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('--times must be a positive integer');
  }, 30_000);
});

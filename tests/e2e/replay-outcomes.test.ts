/**
 * e2e (tenant A, real mock app + real headless Chromium): the four replay result kinds that do
 * not involve a human handoff, plus the safety gate on an unapproved irreversible capability.
 * Escalation and handoff, and the tenant B override, live in replay-handoff-policy.test.ts so
 * each file stays under its own browser/mock pair.
 *
 * Works through the replay acceptance table (docs/design/replay.md) row by row.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PASSWORD, launchBrowser, readRunText, replayOnce, startMock, tempRunsDir, type MockServer, type ReplayRun } from './harness.js';

const OPEN_SUBACCOUNT_DRAFT_PATH = path.resolve('tests/fixtures/open-subaccount.draft.json');

/** Asserts `rel` is a defined, existing path under `runDir` (evidence.screenshot / evidence.dom). */
function expectEvidencePath(runDir: string, rel: string | undefined): void {
  expect(rel, 'evidence path should be defined').toBeDefined();
  expect(fs.existsSync(path.join(runDir, rel as string))).toBe(true);
}

describe('replay: outcomes and safety (tenant A)', () => {
  let mock: MockServer;
  let browser: Browser;
  let runsDir: string;

  beforeAll(async () => {
    mock = await startMock('a');
    browser = await launchBrowser();
    runsDir = tempRunsDir('e2e-outcomes-');
  });

  afterAll(async () => {
    await browser.close();
    await mock.close();
  });

  describe('memberId 12345', () => {
    let run: ReplayRun;

    beforeAll(async () => {
      run = await replayOnce({ browser, mock, inputs: { memberId: '12345' }, runsDir });
    }, 60_000);

    it(
      'succeeds with the savings balance, member name and the maintenance-notice recovery',
      () => {
        const { result, c, runDir } = run;
        expect(result.kind).toBe('success');
        if (result.kind !== 'success') throw new Error(`expected success, got ${result.kind}`);
        expect(result.outputs.savingsBalance).toBe(1234.56);
        expect(String(result.outputs.memberName)).toContain('Jane');
        expect(result.recoveries).toContain('dismiss_maintenance_notice');

        expect(fs.existsSync(path.join(runDir, 'events.jsonl'))).toBe(true);
        expect(fs.existsSync(path.join(runDir, 'result.json'))).toBe(true);
        expect(readRunText(runDir)).not.toContain(PASSWORD);

        // Control returns to automation once the run is over (no escalation on the happy path).
        expect(c.broker.token.state).toBe('automation');
      },
      60_000,
    );

    // Kept in its own `it` so a locator-drift failure here cannot mask the success assertions
    // above.
    it(
      'tenant A resolves every target with its primary locator',
      () => {
        const { result } = run;
        const drifted = result.locatorReport.filter((e) => e.fallbackDepth !== 0);
        expect(drifted, `drifted locatorReport entries: ${JSON.stringify(drifted)}`).toEqual([]);
      },
      60_000,
    );
  });

  it(
    'memberId 99999 -> business_outcome member_not_found',
    async () => {
      const { result } = await replayOnce({ browser, mock, inputs: { memberId: '99999' }, runsDir });
      expect(result.kind).toBe('business_outcome');
      if (result.kind !== 'business_outcome') throw new Error(`expected business_outcome, got ${result.kind}`);
      expect(result.name).toBe('member_not_found');
    },
    60_000,
  );

  it(
    'memberId 90001 -> business_outcome access_denied with the access-denied message',
    async () => {
      const { result } = await replayOnce({ browser, mock, inputs: { memberId: '90001' }, runsDir });
      expect(result.kind).toBe('business_outcome');
      if (result.kind !== 'business_outcome') throw new Error(`expected business_outcome, got ${result.kind}`);
      expect(result.name).toBe('access_denied');
      expect(String(result.data.message)).toContain('Access Denied');
    },
    60_000,
  );

  it(
    'failSearch fault -> hard_failure app_error with screenshot + DOM evidence',
    async () => {
      await mock.setFaults({ failSearch: true });
      try {
        const { result, runDir } = await replayOnce({ browser, mock, inputs: { memberId: '12345' }, runsDir });
        expect(result.kind).toBe('hard_failure');
        if (result.kind !== 'hard_failure') throw new Error(`expected hard_failure, got ${result.kind}`);
        expect(result.code).toBe('app_error');
        expect(result.stepId).toBeDefined();
        expectEvidencePath(runDir, result.evidence.screenshot);
        expectEvidencePath(runDir, result.evidence.dom);
        expect(readRunText(runDir)).not.toContain(PASSWORD);
        // `observed` is a page-text excerpt and the banner shows "Operator: operator1" (bound from
        // MOCK_USER): the result handed to the caller is scrubbed like result.json.
        expect(JSON.stringify(result)).not.toContain('operator1');
        expect(result.observed).toContain('[REDACTED]');
      } finally {
        await mock.setFaults({ failSearch: false });
      }
    },
    60_000,
  );

  it(
    'a draft capability with an irreversible step is refused before the browser makes a single request',
    async () => {
      const capability = JSON.parse(fs.readFileSync(OPEN_SUBACCOUNT_DRAFT_PATH, 'utf8')) as unknown;
      const requestsBefore = mock.requests.length;
      const { result } = await replayOnce({
        browser,
        mock,
        capability,
        inputs: { memberId: '12345', amount: 100 },
        runsDir,
      });
      expect(result.kind).toBe('hard_failure');
      if (result.kind !== 'hard_failure') throw new Error(`expected hard_failure, got ${result.kind}`);
      expect(result.code).toBe('policy_violation');
      expect(result.stepsExecuted).toBe(0);
      // The mock app's own request log (harness.ts's outer middleware) never grew: not even a
      // navigation was attempted.
      expect(mock.requests.length).toBe(requestsBefore);
    },
    60_000,
  );
});

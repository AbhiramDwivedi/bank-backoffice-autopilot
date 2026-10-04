/**
 * End-to-end: the shipped, approved capability (artifacts/lookup-member-savings-balance.json,
 * unmodified) resolves every target exactly as the committed evidence says it does.
 *
 * Replay refuses a positional fallback that settles an ambiguity or answers a read
 * (docs/design/replay.md, "Positional fallbacks"). This file pins what that rule must NOT change:
 *  - on tenant A every locator resolves at depth zero, for the success run and for both business
 *    outcomes (the `member_not_found` outcome's extract included);
 *  - on tenant B WITHOUT the override the run still succeeds, through the css fallback at the
 *    member-id field: a `type` step, at depth two, on `input[type="text"][name="memberId"]`, which
 *    names the field and is not positional. Both extracts still resolve at depth zero;
 *  - on tenant B with the override everything is at depth zero again.
 *
 * Each run's result kind, outputs and locator report are compared with the committed evidence
 * (evidence/replay-*), so "as before" means "as the evidence records it".
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { launchBrowser, replayOnce, startMock, tempRunsDir, type MockServer } from './harness.js';
import type { ReplayResult } from '@cu/core/schema';

const SHIPPED = path.resolve('artifacts/lookup-member-savings-balance.json');
const shipped = (): unknown => JSON.parse(readFileSync(SHIPPED, 'utf8'));
const evidence = (dir: string): ReplayResult => JSON.parse(readFileSync(path.resolve('evidence', dir, 'result.json'), 'utf8')) as ReplayResult;

/** What must not change: the kind, the caller's data, and which locator found every target. */
function comparable(r: ReplayResult): Record<string, unknown> {
  return {
    kind: r.kind,
    ...(r.kind === 'success' ? { outputs: r.outputs } : {}),
    ...(r.kind === 'business_outcome' ? { name: r.name, data: r.data, missing: r.missing } : {}),
    locatorReport: r.locatorReport,
    recoveries: r.recoveries,
  };
}

describe('the shipped capability resolves as the committed evidence records', () => {
  let browser: Browser;
  let mockA: MockServer;
  let mockB: MockServer;

  beforeAll(async () => {
    browser = await launchBrowser();
    mockA = await startMock('a');
    mockB = await startMock('b');
  });

  afterAll(async () => {
    await browser?.close();
    await mockA?.close();
    await mockB?.close();
  });

  async function run(mock: MockServer, memberId: string, tenant?: string): Promise<ReplayResult> {
    await mock.reset();
    const { result } = await replayOnce({ browser, mock, capability: shipped(), inputs: { memberId }, runsDir: tempRunsDir('shipped-locators-'), ...(tenant !== undefined ? { tenant } : {}) });
    return result;
  }

  it.each([
    ['12345', 'replay-success'],
    ['99999', 'replay-not-found'],
    ['90001', 'replay-access-denied'],
  ])('tenant A, member %s: same result and locator report as evidence/%s, every locator at depth zero', async (memberId, dir) => {
    const result = await run(mockA, memberId);
    expect(comparable(result)).toEqual(comparable(evidence(dir)));
    expect(result.locatorReport.every((e) => e.fallbackDepth === 0), JSON.stringify(result.locatorReport)).toBe(true);
  }, 60_000);

  it('tenant B without the override: still succeeds through the css fallback at the member-id field (a type step, depth two)', async () => {
    const result = await run(mockB, '12345');
    expect(comparable(result)).toEqual(comparable(evidence('replay-tenant-b-no-override')));
    expect(result.kind).toBe('success');
    // The one fallback: s06 types the member id through `input[type="text"][name="memberId"]`.
    expect(result.locatorReport.filter((e) => e.fallbackDepth > 0)).toEqual([{ stepId: 's06', strategyKind: 'css', fallbackDepth: 2 }]);
    // The two reads (s09, s10) are found by their label anchors, not by position.
    expect(result.locatorReport.filter((e) => e.stepId === 's09' || e.stepId === 's10')).toEqual([
      { stepId: 's09', strategyKind: 'relative', fallbackDepth: 0 },
      { stepId: 's10', strategyKind: 'relative', fallbackDepth: 0 },
    ]);
  }, 60_000);

  it('tenant B without the override, member not found: the outcome and its extracted message, read through its label anchor', async () => {
    const result = await run(mockB, '99999');
    expect(result.kind, JSON.stringify(result)).toBe('business_outcome');
    if (result.kind !== 'business_outcome') throw new Error('expected business_outcome');
    expect(result.name).toBe('member_not_found');
    expect(result.data).toEqual({ recordCountMessage: 'No records found.' });
    expect(result.missing).toBeUndefined();
    // Only the member-id field fell back; the outcome's extract did not.
    expect(result.locatorReport.filter((e) => e.fallbackDepth > 0)).toEqual([{ stepId: 's06', strategyKind: 'css', fallbackDepth: 2 }]);
  }, 60_000);

  it('tenant B with the riverbend-fcu override: every locator at depth zero', async () => {
    const result = await run(mockB, '12345', 'riverbend-fcu');
    expect(comparable(result)).toEqual(comparable(evidence('replay-tenant-b')));
    expect(result.locatorReport.every((e) => e.fallbackDepth === 0), JSON.stringify(result.locatorReport)).toBe(true);
  }, 60_000);
});

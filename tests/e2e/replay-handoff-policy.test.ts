/**
 * e2e (real mock app + real headless Chromium): session-expiry human handoff (tenant A) and the
 * tenant B override / drift pair. Split out of replay-outcomes.test.ts so each describe block
 * owns its own mock server(s); still one browser per file (beforeAll).
 *
 * Covers escalation (docs/design/replay.md), and "Tenants" and "Scripted operators"
 * (docs/design/integration.md).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runReplay } from '@cu/cli/runtime';
import {
  EXAMPLE_ARTIFACT,
  PASSWORD,
  USER,
  launchBrowser,
  policyFor,
  readEvents,
  readRunText,
  replayOnce,
  startMock,
  tempRunsDir,
  type MockServer,
} from './harness.js';

describe('replay: session-expiry escalation (tenant A)', () => {
  let mock: MockServer;
  let browser: Browser;
  let runsDir: string;

  beforeAll(async () => {
    mock = await startMock('a');
    browser = await launchBrowser();
    runsDir = tempRunsDir('e2e-handoff-');
  });

  afterAll(async () => {
    await browser.close();
    await mock.close();
  });

  // expireSession is one-shot and fires on the NEXT authenticated request, which is the sign-on
  // step's own navigation to /workstation (apps/mock-app/app.ts's auth gate) -- so it must be
  // armed right before each run, not earlier. Where the failure surfaces depends on the
  // artifact: the hand-written example's sign-on step (s04) checks "url /workstation" and fails
  // there; the model-recorded artifact's sign-on step has no checkpoint, so the failure surfaces
  // at the step that types the member id. Either way the relogin operator re-runs the sign-in and
  // asks replay to resume at the first step after it (the example: s05, after the failing s04; the
  // recorded artifact: the failing step itself), and both runs must end in the real success outcome.
  const RECORDED_FILE = path.resolve('artifacts/lookup-member-savings-balance.json');
  // The recorded artifact's step ids depend on how many actions the model took; find the step
  // that types the member id by what it does.
  const recordedTypingStepId = (() => {
    const cap = JSON.parse(fs.readFileSync(RECORDED_FILE, 'utf8')) as {
      steps: { id: string; action: { type: string; value?: { kind: string; name?: string } } }[];
    };
    const st = cap.steps.find((x) => x.action.type === 'type' && x.action.value?.kind === 'input' && x.action.value.name === 'memberId');
    if (!st) throw new Error('recorded artifact has no step typing the member id');
    return st.id;
  })();
  // The relogin operator re-runs the capability's own sign-in: the example carries an explicit
  // `auth` block; the recorded artifact has none, so the same steps are derived at run time.
  it.each([
    { name: 'hand-written example', file: EXAMPLE_ARTIFACT, stepId: 's04', resumeAt: 's05', signIn: 'explicit sign-in steps (s01, s02, s03, s04)' },
    {
      name: 'model-recorded artifact',
      file: RECORDED_FILE,
      stepId: recordedTypingStepId,
      resumeAt: recordedTypingStepId,
      signIn: 'derived sign-in steps (s01, s02, s03, s04, s05)',
    },
  ])(
    'expireSession + scripted relogin ($name) -> escalated at $stepId, resumed at $resumeAt, resumed_success with the real outcome',
    async ({ file, stepId, resumeAt, signIn }) => {
      process.env.MOCK_USER ??= USER;
      process.env.MOCK_PASSWORD ??= PASSWORD;
      await mock.setFaults({ expireSession: true });
      // runReplay is the CLI's own path (compose -> attachAutoOperator -> replayCapability): it is
      // what hands the relogin operator the capability and inputs it decides the hand-back from.
      const { result, runDir, controlState } = await runReplay({
        capability: JSON.parse(fs.readFileSync(file, 'utf8')) as unknown,
        inputs: { memberId: '12345' },
        policy: policyFor(mock.baseUrl),
        runsDir,
        baseUrl: mock.baseUrl,
        headless: true,
        browser,
        autoOperator: 'relogin',
      });

      expect(result.kind).toBe('escalated');
      if (result.kind !== 'escalated') throw new Error(`expected escalated, got ${result.kind}`);
      expect(result.resolution).toBe('resumed_success');
      expect(result.stepId).toBe(stepId);

      // `outcome` carries the underlying replay result once escalation resolves back to
      // automation (docs/schema/result.ts EscalatedOutcome). Assert on it directly rather than
      // treating a missing value as acceptable.
      expect(result.outcome?.kind).toBe('success');
      if (result.outcome?.kind === 'success') {
        expect(result.outcome.outputs.savingsBalance).toBe(1234.56);
      }

      expect(controlState).toBe('automation');

      const events = readEvents(runDir);
      expect(events.some((e) => e.kind === 'escalation' && e.data.phase === 'raised')).toBe(true);
      expect(events.some((e) => e.kind === 'escalation' && e.data.phase === 'resolved')).toBe(true);
      expect(events.some((e) => e.kind === 'control_transfer')).toBe(true);
      expect(events.some((e) => e.kind === 'human_action')).toBe(true);
      expect(events.some((e) => e.kind === 'escalation' && e.data.phase === 'resume_at' && e.data.to === resumeAt)).toBe(true);

      const interventionFile = path.join(runDir, 'interventions', `${result.interventionId}.json`);
      expect(fs.existsSync(interventionFile)).toBe(true);
      const intervention = JSON.parse(fs.readFileSync(interventionFile, 'utf8')) as {
        resolution?: { resumeFrom?: string; resumeAtStepId?: string; notes?: string };
      };
      expect(intervention.resolution?.resumeFrom).toBe('current_step');
      expect(intervention.resolution?.resumeAtStepId).toBe(resumeAt);
      expect(intervention.resolution?.notes).toContain(signIn);

      expect(readRunText(runDir)).not.toContain(PASSWORD);
    },
    60_000,
  );

  it(
    'expireSession + scripted abort -> escalated, abandoned',
    async () => {
      await mock.setFaults({ expireSession: true });
      const { result } = await replayOnce({
        browser,
        mock,
        inputs: { memberId: '12345' },
        runsDir,
        autoOperator: 'abort',
      });

      expect(result.kind).toBe('escalated');
      if (result.kind !== 'escalated') throw new Error(`expected escalated, got ${result.kind}`);
      expect(result.resolution).toBe('abandoned');
      // No broker.token assertion here: by design abort() is terminal and leaves state at
      // 'paused' (holder 'none'), not 'automation' (packages/core/src/session/broker.ts's module comment:
      // "abort() from paused | human | resuming -> terminal ... state stays 'paused'") and
      // compose.ts's resumingEscalation only calls broker.resumed() when resumeFrom !== 'abort'.
      // The token-back-to-automation assertion belongs to the relogin/resumed_success run above.
    },
    60_000,
  );
});

describe('replay: tenant B override and drift', () => {
  let mockB: MockServer;
  let browser: Browser;
  let runsDir: string;

  beforeAll(async () => {
    mockB = await startMock('b');
    browser = await launchBrowser();
    runsDir = tempRunsDir('e2e-tenant-b-');
  });

  afterAll(async () => {
    await browser.close();
    await mockB.close();
  });

  it(
    'with the riverbend-fcu override -> success, and the applied override is logged',
    async () => {
      const { result, runDir } = await replayOnce({
        browser,
        mock: mockB,
        inputs: { memberId: '12345' },
        tenant: 'riverbend-fcu',
        runsDir,
      });

      expect(result.kind).toBe('success');
      if (result.kind !== 'success') throw new Error(`expected success, got ${result.kind}`);
      expect(result.outputs.savingsBalance).toBe(1234.56);

      const events = readEvents(runDir);
      const overrideEvent = events.find(
        (e) => e.kind === 'observation' && typeof e.data.override === 'object' && e.data.override !== null,
      );
      expect(overrideEvent, 'expected an observation event recording the applied tenant override').toBeDefined();
      const applied = overrideEvent?.data.override as { tenant?: string; patchedSteps?: string[] } | undefined;
      expect(applied?.tenant).toBe('riverbend-fcu');
      expect(applied?.patchedSteps).toContain('s05');
    },
    60_000,
  );

  it(
    'WITHOUT the override, the base capability drifts against tenant B',
    async () => {
      const { result } = await replayOnce({
        browser,
        mock: mockB,
        inputs: { memberId: '12345' },
        runsDir,
      });

      // No override applied: s05's target still says "Member ID" (a role locator with that
      // accessible name, and a label locator matching that text via the adjacent-cell
      // heuristic), but tenant B labels the field "Member #" and renders `main` as an
      // <iframe name="main"> inside a table instead of tenant A's real frameset <frame>
      // (apps/mock-app/tenant.ts memberIdLabel/shell). The frame path itself ([{name:'main'}]) still
      // resolves on both shells, so the difference that bites is purely the label text: "Member
      // ID" is not a substring of "Member #", so locators 0 (role) and 1 (label) cannot match,
      // and only locator 2, the css fallback `input[name=memberId]` keyed on the field's name
      // attribute rather than its label, still does, because tenant B kept the same field name.
      // Recorded here as whatever it deterministically yields: either the s05 locator resolves
      // through a fallback (fallbackDepth > 0), or, if it cannot resolve at all, the run ends in
      // a hard_failure element_not_found at s05.
      if (result.kind === 'hard_failure') {
        expect(result.code).toBe('element_not_found');
        expect(result.stepId).toBe('s05');
        return;
      }
      const s05Entries = result.locatorReport.filter((e) => e.stepId === 's05');
      expect(s05Entries.length).toBeGreaterThan(0);
      expect(s05Entries.some((e) => e.fallbackDepth > 0)).toBe(true);
    },
    60_000,
  );
});

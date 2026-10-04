/**
 * The human path after a session expiry, end to end: the real mock app, real Chromium, and a
 * person working through the real Relay console page (no scripted operator, `autoOperator: 'none'`).
 * The human signs in again in the driven browser and hands back with the console's default choice.
 * The console can only send `current_step`, never a resume point.
 *
 * Three places the expiry can land:
 *
 * - **The search step** (shipped artifact, chaos seed 38 with `expireSession: 0.2`, the case
 *   `tests/e2e/replay-chaos.test.ts` pins for the scripted relogin). The session expires on the
 *   results page s07 navigates to, after s06 typed the member id. Before the engine defaulted the
 *   resume point, the hand-back re-ran only the search on the form the lost session had emptied,
 *   the artifact's `member_not_found` detector (which binds no input) matched, and the run
 *   reported "member not found" for member 12345, who exists. Now replay resumes at s06, the first
 *   step after the sign-in, so the member id is typed again.
 * - **The first step after the sign-in** (shipped artifact, `expireSession: true`): the retry
 *   resumes at the failing step itself, as it always did.
 * - **A sign-in step** (the hand-written example, `expireSession: true`, the walkthrough in the
 *   top-level README): the human completed the sign-in, and the run continues after it. Before,
 *   a retry clicked a Sign on button that was no longer on the page and escalated again.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright';
import { startRelayConsole, type RelayServerHandle } from '@cu/cli/runtime';
import { EXAMPLE_ARTIFACT, PASSWORD, USER, launchBrowser, readEvents, replayOnce, startMock, tempRunsDir, type MockServer } from './harness.js';

const SHIPPED_ARTIFACT = path.resolve('artifacts/lookup-member-savings-balance.json');
const BALANCE = { kind: 'success', outputs: { savingsBalance: 1234.56, memberName: 'Jane Q. Sample' } };

interface OpenIntervention {
  id: string;
  status: string;
  stepId?: string;
  context?: Record<string, unknown>;
}

async function waitForOpenIntervention(consoleUrl: string, timeoutMs: number): Promise<OpenIntervention> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const body = (await (await fetch(`${consoleUrl}/api/interventions?status=open`)).json()) as { interventions: OpenIntervention[] };
    const open = body.interventions.find((v) => v.status === 'open');
    if (open) return open;
    if (Date.now() > deadline) throw new Error(`no open intervention appeared within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

describe('handoff e2e: a human\'s "retry" in the Relay console after a session expiry', () => {
  let browser: Browser;
  let mock: MockServer;

  beforeAll(async () => {
    browser = await launchBrowser();
    mock = await startMock('a');
  });

  afterAll(async () => {
    await mock.close();
    await browser.close();
  });

  it.each([
    {
      name: 'expiry on the search step (shipped artifact): the member id is typed again, never member_not_found',
      artifact: SHIPPED_ARTIFACT,
      fault: { chaos: { seed: 38, expireSession: 0.2 } },
      failingStep: 's07',
      resumeStep: 's06',
      resumeStepName: 'Enter the member ID to look up',
      // s06 typed the member id before the expiry; it is `reversible`, so the console lists it.
      repeats: [{ stepId: 's06', stepName: 'Enter the member ID to look up' }],
    },
    {
      name: 'expiry found at the first step after the sign-in (shipped artifact): the retry resumes at that same step',
      artifact: SHIPPED_ARTIFACT,
      fault: { expireSession: true },
      failingStep: 's06',
      resumeStep: 's06',
      resumeStepName: 'Enter the member ID to look up',
    },
    {
      name: 'expiry on the sign-on step (hand-written example): the human signed in, the run continues after the sign-in',
      artifact: EXAMPLE_ARTIFACT,
      fault: { expireSession: true },
      failingStep: 's04',
      resumeStep: 's05',
      resumeStepName: 'Enter the member ID',
    },
  ])(
    '$name',
    async ({ artifact, fault, failingStep, resumeStep, resumeStepName, repeats }) => {
      const relay: RelayServerHandle = await startRelayConsole({ port: 0 });
      const runsDir = tempRunsDir();
      await mock.setFaults(fault);

      let page: Page | undefined;
      const runPromise = replayOnce({
        browser,
        mock,
        capability: JSON.parse(fs.readFileSync(artifact, 'utf8')) as unknown,
        inputs: { memberId: '12345' },
        runsDir,
        operator: relay,
        autoOperator: 'none',
        onComposed: (_c, p) => {
          page = p;
        },
      });

      const uiContext = await browser.newContext();
      try {
        const open = await waitForOpenIntervention(relay.url, 60_000);
        // Where the expiry landed, and what automation told the console a retry will do.
        expect(open.stepId).toBe(failingStep);
        expect(open.context?.code).toBe('session_expired');
        expect(open.context?.retryResume).toEqual({ stepId: resumeStep, stepName: resumeStepName, ...(repeats !== undefined ? { repeats } : {}) });

        // The operator's console, in its own browser context (never the page replay drives).
        const ui = await uiContext.newPage();
        await ui.goto(`${relay.url}/`);
        await ui.click(`.qcard[data-intervention-id="${open.id}"]`);
        await ui.click('#take-control');
        await ui.waitForSelector('#state-pill[data-state="mine"]', { timeout: 15_000 });
        expect((await ui.locator('#resume-current-label').innerText()).trim()).toBe('Start again after sign-in');
        expect(await ui.locator('#resume-current-help').innerText()).toContain(`step ${resumeStep} (“${resumeStepName}”), the first step after sign-in`);
        if (repeats !== undefined) expect(await ui.locator('#resume-current-repeats').innerText()).toContain(`step ${resumeStep} (“${resumeStepName}”)`);
        else expect(await ui.locator('#resume-current-repeats').count()).toBe(0);

        // The human signs in again in the SAME live page, and does nothing else: the search form
        // the new session shows is empty.
        expect(page).toBeDefined();
        const p = page!;
        await p.goto(`${mock.baseUrl}/login`);
        await p.fill('input[name=userId]', USER);
        await p.fill('input[name=password]', PASSWORD);
        await p.press('input[name=password]', 'Enter');
        await p.waitForURL(/\/workstation$/, { timeout: 15_000 });

        // Hand back with the console's default choice, exactly as it is offered.
        expect(await ui.isChecked('#resume-current')).toBe(true);
        await ui.click('#handback-submit');

        const run = await runPromise;

        expect(run.result.kind).toBe('escalated');
        if (run.result.kind !== 'escalated') throw new Error(`expected escalated, got ${run.result.kind}`);
        expect(run.result.stepId).toBe(failingStep);
        expect(run.result.resolution).toBe('resumed_success');
        // The real answer for member 12345. Never a business outcome: the member exists.
        expect(run.result.outcome).toEqual(BALANCE);

        const all = readEvents(run.runDir);
        const escalations = all.filter((e) => e.kind === 'escalation').map((e) => e.data);
        // One escalation, answered with what the console sends: current_step and no resume point...
        expect(escalations.filter((d) => d.phase === 'raised')).toHaveLength(1);
        const resolved = escalations.find((d) => d.phase === 'resolved');
        expect(resolved).toMatchObject({ resumeFrom: 'current_step' });
        expect(resolved).not.toHaveProperty('resumeAtStepId');
        // ...and the evidence says the engine chose the resume point.
        expect(escalations).toContainEqual({ phase: 'resume_at', to: resumeStep, defaulted: true, recoveryBudgetsReset: true });
        expect(all.filter((e) => e.kind === 'outcome' && typeof e.data.name === 'string')).toEqual([]);
        expect(run.c.broker.token.state).toBe('automation');
      } finally {
        await uiContext.close();
        await relay.close();
        await mock.reset();
      }
    },
    180_000,
  );
});

/**
 * Handoff through the real Relay HTTP API (docs/design/relay.md, apps/relay/src/server/app.ts).
 *
 * `expireSession` (apps/mock-app/README.md) is set right before the run and fires on the sign-on
 * step's (s04) own navigation to /workstation: replay classifies it `session_expired` /
 * `unrecoverable_condition`, escalates (s04's `onFailure: 'escalate'`), and a human takes over
 * through Relay's HTTP API exactly as an operator would: poll `GET /api/interventions`,
 * `POST .../take`, drive the same Playwright page directly (no scripted operator here,
 * `autoOperator: 'none'`), send one `POST .../heartbeat` while holding control, then
 * `POST .../handback`. `next_step` is correct here, not `current_step`: the human's re-login
 * already completed s04, so replay verifies s04's postcondition and continues at s05 instead of
 * re-clicking a login button that is no longer on the page. (The scripted relogin operator gets
 * the same result by naming s05 as the resume point, `resumeAtStepId`; see
 * docs/design/replay.md, "Resuming at another step". A human can send that too, through the API.)
 *
 * Also asserts that, while paused on the open intervention, `GET /` on that same console serves
 * the built Relay UI (a real console page, not just the HTTP API) -- checked from a second browser
 * context so it never interferes with the page the replay itself drives.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright';
import { startRelayConsole, type RelayServerHandle } from '@cu/cli/runtime';
import {
  PASSWORD,
  USER,
  launchBrowser,
  readEvents,
  readRunText,
  replayOnce,
  startMock,
  tempRunsDir,
  type MockServer,
} from './harness.js';

interface InterventionsResponse {
  interventions: { id: string; status: string; capabilityId?: string }[];
}
interface RunsResponse {
  runs: { runId: string; state: string; holder: string }[];
}
interface HeartbeatResponse {
  interventionId: string;
  at: string;
  lease: { ms: number; anchorAt: string; expiresAt: string };
}
interface PersistedIntervention {
  status: string;
  resolution?: {
    humanActions: { type: string; target?: Record<string, unknown>; key?: string; url?: string }[];
  };
}

async function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

/** Polls GET /api/interventions?status=open until one appears, or throws after `timeoutMs`. */
async function waitForOpenIntervention(consoleUrl: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await fetch(`${consoleUrl}/api/interventions?status=open`);
    const body = (await res.json()) as InterventionsResponse;
    const open = body.interventions.find((v) => v.status === 'open');
    if (open) return open.id;
    if (Date.now() > deadline) throw new Error('no open intervention appeared within ' + timeoutMs + 'ms');
    await new Promise((r) => setTimeout(r, 250));
  }
}

describe('handoff e2e: real Relay HTTP API', () => {
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

  it(
    'expireSession on sign-on escalates; a human takes control via Relay\'s HTTP API, re-logs in directly in the driven page, and hands back next_step -> resumed_success',
    async () => {
      const relay: RelayServerHandle = await startRelayConsole({ port: 0 });
      const runsDir = tempRunsDir();
      await mock.setFaults({ expireSession: true });

      let page: Page | undefined;
      const runPromise = replayOnce({
        browser,
        mock,
        inputs: { memberId: '12345' },
        runsDir,
        operator: relay,
        autoOperator: 'none',
        onComposed: (_c, p) => {
          page = p;
        },
      });

      try {
        // Relay pushes a new intervention to the console over SSE as soon as it opens; this polls the
        // API with a generous deadline since this is a cold Playwright + Express start under test load.
        const interventionId = await waitForOpenIntervention(relay.url, 20_000);

        // While the run is paused on the open intervention (before take/handback), the console's
        // `GET /` serves the real built Relay UI -- a separate browser context from the one the
        // replay drives, closed again right after.
        const uiContext = await browser.newContext();
        try {
          const uiPage = await uiContext.newPage();
          const uiRes = await uiPage.goto(`${relay.url}/`);
          expect(uiRes?.status()).toBe(200);
          expect(await uiPage.title()).toContain('Relay');
          // Server-rendered bootstrap data island; stable regardless of client-side rendering.
          expect(await uiPage.content()).toContain('lookup-member-savings-balance');
        } finally {
          await uiContext.close();
        }

        const takeRes = await postJson(`${relay.url}/api/interventions/${interventionId}/take`, { by: 'e2e-human' });
        expect(takeRes.status).toBe(200);

        const runsRes = await fetch(`${relay.url}/api/runs`);
        const runs = (await runsRes.json()) as RunsResponse;
        expect(runs.runs[0]?.holder).toBe('human');
        expect(runs.runs[0]?.state).toBe('human');

        // Drive the SAME live page a human would work in directly (docs/design/handoff.md
        // "Operating the same live session"): no new browser/context, the one replay was using.
        expect(page).toBeDefined();
        const p = page!;
        await p.goto(`${mock.baseUrl}/login`);
        await p.fill('input[name=userId]', USER);
        await p.fill('input[name=password]', PASSWORD);
        // Enter in the password field submits the form via the browser's own implicit-submission
        // mechanism (the form has a submit button, `<input type=image name=login>`) -- same
        // outcome as clicking it, plus it gives human-action capture a real keypress to record.
        await p.press('input[name=password]', 'Enter');
        await p.waitForURL(/\/workstation$/, { timeout: 15_000 });

        const heartbeatRes = await postJson(`${relay.url}/api/interventions/${interventionId}/heartbeat`, { by: 'e2e-human' });
        expect(heartbeatRes.status).toBe(200);
        const heartbeat = (await heartbeatRes.json()) as HeartbeatResponse;
        expect(heartbeat.lease.expiresAt).toBeTruthy();
        expect(typeof heartbeat.lease.ms).toBe('number');

        const handbackRes = await postJson(`${relay.url}/api/interventions/${interventionId}/handback`, {
          by: 'e2e-human',
          resumeFrom: 'next_step',
          notes: 'e2e: re-authenticated in the same browser',
        });
        expect(handbackRes.status).toBe(200);

        const run = await runPromise;

        expect(run.result.kind).toBe('escalated');
        if (run.result.kind === 'escalated') {
          expect(run.result.resolution).toBe('resumed_success');
          // `outcome` carries the underlying replay result once control returns to automation;
          // assert on it here rather than treating a missing value as acceptable.
          expect(run.result.outcome, 'escalated result carries the post-handoff outcome').toBeDefined();
          if (run.result.outcome) {
            expect(run.result.outcome.kind).toBe('success');
            if (run.result.outcome.kind === 'success') {
              expect(run.result.outcome.outputs.savingsBalance).toBe(1234.56);
            }
          }
        }

        // Control token is back at automation after the run (resumingEscalation in compose.ts).
        expect(run.c.broker.token.state).toBe('automation');

        // Human action capture: real capture on the Playwright surface, started on takeControl.
        const persisted = JSON.parse(
          fs.readFileSync(path.join(run.runDir, 'interventions', `${interventionId}.json`), 'utf8'),
        ) as PersistedIntervention;
        expect(persisted.resolution?.humanActions.length ?? 0).toBeGreaterThan(0);

        // The Enter keypress that submitted the re-login form: `key` carries it, never `target.text`
        // (packages/adapter-playwright/src/capture.ts drops target.text for keypress unconditionally).
        const keypress = persisted.resolution?.humanActions.find((a) => a.type === 'keypress');
        expect(keypress, 'expected a captured keypress action for the Enter that submitted re-login').toBeDefined();
        expect(keypress?.key).toBe('Enter');
        expect(keypress?.target?.text).toBeUndefined();

        // No captured action (or anything else in the run dir) ever contains the password.
        const allText = readRunText(run.runDir);
        expect(allText).not.toContain(PASSWORD);

        // control_transfer events, in order: automation -> paused -> human -> resuming -> automation.
        const transfers = readEvents(run.runDir)
          .filter((e) => e.kind === 'control_transfer')
          .map((e) => `${String(e.data.from)}->${String(e.data.to)}`);
        expect(transfers).toEqual(['automation->paused', 'paused->human', 'human->resuming', 'resuming->automation']);
      } finally {
        await relay.close();
      }
    },
    90_000,
  );
});

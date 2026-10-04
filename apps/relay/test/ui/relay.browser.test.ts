/**
 * End-to-end browser tests for Relay: a real headless chromium page against a real
 * `startRelayServer` backed by real `SessionBroker`s on `FakeSurface`s (see
 * `test/support/fixtures.ts`). Chromium is launched at module level so `describe.skipIf` can act
 * on the result, rather than faking a pass when chromium is unavailable in this environment.
 *
 * Each test builds its own broker(s) + server, so tests never share mutable state. Cleanup
 * (pages, servers, fixtures) is handled by `createHarness()` in `./harness.ts`.
 */
import { createServer } from 'node:http';
import { afterAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { createRelayApp, fromSessionBroker } from '../../src/server/index.js';
import { escalateSample, makeBrokerFixture, sampleAction } from '../support/fixtures.js';
import {
  createHarness,
  countHeartbeatRequests,
  dismissAllToasts,
  openRelay,
  renderCuCoreScreenshot,
  testResultsPath,
  waitFor,
} from './harness.js';

// ---------------------------------------------------------------------------------------------
// Module-level chromium launch attempt (so `describe.skipIf` can act on the result). If this
// fails, report why and skip, rather than faking a pass.
// ---------------------------------------------------------------------------------------------
let browser: Browser | undefined;
let launchError: string | undefined;
try {
  browser = await chromium.launch({ headless: true });
} catch (err) {
  launchError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

afterAll(async () => {
  await browser?.close();
});

/** Narrows the module-level `browser` for call sites inside tests gated by `describe.skipIf`. */
function requireBrowser(): Browser {
  if (browser === undefined) throw new Error('unreachable: browser unavailable inside a skipIf(browser === undefined) block');
  return browser;
}

const harness = createHarness({ getBrowser: () => browser });

const XSS = {
  reasonMessage: '<img src=x onerror="window.__xssReason=1"> blocked',
  goal: '<script>window.__xssGoal=1</script>',
  observed: '<svg onload="window.__xssCtx=1">',
  notes: '<img src=x onerror="window.__xssNotes=1">',
};

describe.skipIf(browser === undefined)('Relay UI, driven by a real headless browser', () => {
  it('an intervention appears via SSE without reload', async () => {
    const fixture = harness.trackFixture(makeBrokerFixture({ sessionLabel: 'cu-core session A' }));
    const server = await harness.startServer({ brokers: [fixture.broker] });
    const page = await harness.newPage(requireBrowser());

    await openRelay(page, server.url);
    await waitFor(() => page.isVisible('#empty-state'), 3000);

    await page.evaluate(() => {
      (window as unknown as { __marker?: number }).__marker = 1;
    });

    const { id } = await escalateSample(fixture.broker);

    await waitFor(async () => (await page.locator(`[data-group="open"] .qcard[data-intervention-id="${id}"]`).count()) > 0, 5000);
    // No reload happened: the marker set on the page before the escalation is still there.
    expect(await page.evaluate(() => (window as unknown as { __marker?: number }).__marker)).toBe(1);
  });

  it('take control, heartbeats, captured actions with redaction', async () => {
    const fixture = harness.trackFixture(makeBrokerFixture({ sessionLabel: 'cu-core session B', interventionLeaseMs: 60000 }));
    const server = await harness.startServer({ brokers: [fixture.broker], leaseMs: 60000 });
    const page = await harness.newPage(requireBrowser());
    const heartbeats = countHeartbeatRequests(page);

    await openRelay(page, server.url);
    const { id } = await escalateSample(fixture.broker);

    await waitFor(async () => (await page.locator(`.qcard[data-intervention-id="${id}"]`).count()) > 0, 5000);
    await page.click(`.qcard[data-intervention-id="${id}"]`);
    await waitFor(async () => (await page.getAttribute('#state-pill', 'data-state')) === 'paused', 3000);

    await page.click('#take-control');
    await waitFor(async () => (await page.getAttribute('#state-pill', 'data-state')) === 'mine', 5000);
    // textContent, not innerText: #state-pill is styled text-transform:uppercase, and innerText
    // reflects the rendered (visually transformed) text while textContent gives the literal DOM
    // text that actually matches VIEW_STATE_LABEL.
    expect(await page.locator('#state-pill').textContent()).toContain('You have control');
    expect(await page.locator('#instruction').innerText()).toContain('cu-core session B');

    // ~7s: the heartbeat is sent every 5s (and immediately), so 2 should have
    // landed well within that window.
    await waitFor(() => heartbeats.count() >= 2, 8000);
    expect(fixture.broker.view(id).lastHeartbeatAt).toBeDefined();

    const remaining = await page.getAttribute('#lease', 'data-remaining-ms');
    expect(remaining).not.toBeNull();
    expect(Number(remaining)).toBeGreaterThan(0);

    // A captured input action must never render its value, in either field: not the (dropped)
    // target text, and not the (never-stored) typed value.
    fixture.capture.emit({
      ...sampleAction({ type: 'input', target: { role: 'textbox', name: 'Member ID', text: 'SECRET-TEXT-4471' } }),
      value: 'SECRET-VALUE-90001',
    });
    fixture.capture.emit(sampleAction({ type: 'click' }));

    await waitFor(async () => (await page.locator('li.action[data-type="input"] .redacted-marker').count()) > 0, 3000);

    const bodyText = await page.evaluate(() => document.body.innerText);
    expect(bodyText).not.toContain('SECRET-VALUE-90001');
    expect(bodyText).not.toContain('SECRET-TEXT-4471');
    const html = await page.content();
    expect(html).not.toContain('SECRET-VALUE-90001');
    expect(html).not.toContain('SECRET-TEXT-4471');
  }, 20000);

  it('a hand-back made while the take is still settling is held until it lands, not dropped', async () => {
    const fixture = harness.trackFixture(makeBrokerFixture({ sessionLabel: 'cu-core session C2' }));
    const server = await harness.startServer({ brokers: [fixture.broker] });
    const page = await harness.newPage(requireBrowser());

    // Hold the take's response back: the server has already transferred control and said so over
    // SSE, so the panel shows 'mine' while the UI still has the take in flight.
    let releaseTake: () => void = () => undefined;
    const takeHeld = new Promise<void>((resolve) => {
      releaseTake = resolve;
    });
    await page.route('**/api/interventions/*/take', async (route) => {
      const response = await route.fetch();
      await takeHeld;
      await route.fulfill({ response });
    });

    await openRelay(page, server.url);
    const { id, resolution } = await escalateSample(fixture.broker);
    await waitFor(async () => (await page.locator(`.qcard[data-intervention-id="${id}"]`).count()) > 0, 5000);
    await page.click(`.qcard[data-intervention-id="${id}"]`);
    await page.click('#take-control');
    await waitFor(async () => (await page.getAttribute('#state-pill', 'data-state')) === 'mine', 5000);

    expect(await page.locator('#handback-submit').isDisabled()).toBe(true);
    const clicked = page.click('#handback-submit');
    releaseTake();
    await clicked;

    const res = await resolution;
    expect(res.resumeFrom).toBe('current_step');
  });

  it('hand-back resolves the awaiting escalate promise', async () => {
    const fixture = harness.trackFixture(makeBrokerFixture({ sessionLabel: 'cu-core session C' }));
    const server = await harness.startServer({ brokers: [fixture.broker] });
    const page = await harness.newPage(requireBrowser());

    await openRelay(page, server.url);
    await page.fill('#operator-name', 'dana.ops');
    await page.locator('#operator-name').blur();

    const { id, resolution } = await escalateSample(fixture.broker);
    await waitFor(async () => (await page.locator(`.qcard[data-intervention-id="${id}"]`).count()) > 0, 5000);
    await page.click(`.qcard[data-intervention-id="${id}"]`);
    await page.click('#take-control');
    await waitFor(async () => (await page.getAttribute('#state-pill', 'data-state')) === 'mine', 5000);

    await page.check('#resume-next');
    await page.fill('#handback-notes', 'Cleared the restriction flag with a supervisor.');
    await page.click('#handback-submit');

    const res = await resolution;
    expect(res.resumeFrom).toBe('next_step');
    expect(res.notes).toBe('Cleared the restriction flag with a supervisor.');
    expect(res.by).toBe('dana.ops');

    await waitFor(async () => {
      const state = await page.getAttribute('#state-pill', 'data-state');
      return state === 'resuming' || state === 'resolved';
    }, 5000);
  });

  it('the retry option says what automation will do: a plain retry, or after a lost session a restart after sign-in (or its refusal)', async () => {
    const plain = harness.trackFixture(makeBrokerFixture({ sessionLabel: 'cu-core session R1' }));
    const lost = harness.trackFixture(makeBrokerFixture({ sessionLabel: 'cu-core session R2' }));
    const refused = harness.trackFixture(makeBrokerFixture({ sessionLabel: 'cu-core session R3' }));
    const server = await harness.startServer({ brokers: [plain.broker, lost.broker, refused.broker] });
    const page = await harness.newPage(requireBrowser());
    await openRelay(page, server.url);

    const take = async (id: string): Promise<void> => {
      await waitFor(async () => (await page.locator(`.qcard[data-intervention-id="${id}"]`).count()) > 0, 5000);
      await page.click(`.qcard[data-intervention-id="${id}"]`);
      await page.click('#take-control');
      await waitFor(async () => (await page.getAttribute('#state-pill', 'data-state')) === 'mine', 5000);
    };

    // No hint from automation: the option is what it always was, with no help line.
    const a = await escalateSample(plain.broker);
    await take(a.id);
    expect((await page.locator('#resume-current-label').innerText()).trim()).toBe('Retry this step');
    expect(await page.locator('#resume-current-help').count()).toBe(0);
    expect(await page.locator('#resume-next-help').count()).toBe(0);

    // A lost session: automation says where a retry resumes, and the option says so.
    const expired = { expected: 'the search results', observed: 'Your session has expired.', code: 'session_expired' };
    const b = await escalateSample(lost.broker, {
      stepId: 's07',
      reason: { code: 'unrecoverable_condition', message: 'session expired (page shows "Your session has expired") while step s07 postcondition not met' },
      context: { ...expired, retryResume: { stepId: 's06', stepName: 'Enter the member ID to look up', repeats: [{ stepId: 's06', stepName: 'Enter the member ID to look up' }] } },
    });
    await take(b.id);
    expect((await page.locator('#resume-current-label').innerText()).trim()).toBe('Start again after sign-in');
    const help = await page.locator('#resume-current-help').innerText();
    expect(help).toContain('does not retry only this step');
    expect(help).toContain('step s06 (“Enter the member ID to look up”), the first step after sign-in');
    expect(help).toContain('leave the app on the screen shown right after sign-in');
    expect(await page.locator('#resume-current-repeats').innerText()).toContain('step s06 (“Enter the member ID to look up”)');
    expect(await page.getAttribute('#resume-current', 'aria-describedby')).toBe('resume-current-help');
    // "I completed this step" is taken at its word, so it carries a caution here.
    expect(await page.locator('#resume-next-help').innerText()).toBe(
      'Choose this only if you carried this step out yourself. If you only signed in again, choose “Start again after sign-in”.',
    );

    // The default choice is still current_step with no resume point: the engine picks the step.
    await page.click('#handback-submit');
    const res = await b.resolution;
    expect(res.resumeFrom).toBe('current_step');
    expect(res.resumeAtStepId).toBeUndefined();
    lost.broker.resumed();
    await waitFor(async () => (await page.getAttribute('#state-pill', 'data-state')) === 'resolved', 5000);
    expect(await page.locator('#continued-with').innerText()).toBe('Start again after sign-in, at step s06');

    // Automation already knows it will refuse the restart: the option says so and what to do instead.
    const why = 'resuming at "s06" would run irreversible step "s07" again: its action has already been carried out in this run';
    const c = await escalateSample(refused.broker, {
      stepId: 's07',
      reason: { code: 'policy_block', message: 'replay cannot retry after the lost session' },
      context: { ...expired, retryResume: { stepId: 's06', stepName: 'Enter the member ID to look up', refused: why } },
    });
    await take(c.id);
    expect((await page.locator('#resume-current-label').innerText()).trim()).toBe('Retry this step');
    const refusedHelp = await page.locator('#resume-current-help').innerText();
    expect(refusedHelp).toContain('Automation will refuse this');
    expect(refusedHelp).toContain(why);
    expect(refusedHelp).toContain('choose “I completed this step, continue”');
    expect(refusedHelp).toContain('abort the run');
    expect(await page.locator('#resume-next-help').count()).toBe(0);
  }, 30000);

  it('XSS payloads render as inert text', async () => {
    const fixture = harness.trackFixture(makeBrokerFixture({ sessionLabel: 'cu-core session D', runKind: 'discovery' }));
    const server = await harness.startServer({ brokers: [fixture.broker] });
    const page = await harness.newPage(requireBrowser());
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(String(err)));

    await openRelay(page, server.url);

    // Goal-only discovery escalation: no capabilityId, so the queue/detail must fall back to `goal`.
    const { id, resolution } = await escalateSample(fixture.broker, {
      capabilityId: undefined,
      goal: XSS.goal,
      reason: { code: 'stuck', message: XSS.reasonMessage },
      context: { expected: 'a', observed: XSS.observed },
    });

    await waitFor(async () => (await page.locator(`.qcard[data-intervention-id="${id}"]`).count()) > 0, 5000);
    await page.click(`.qcard[data-intervention-id="${id}"]`);
    await waitFor(async () => (await page.locator('#reason-message').count()) > 0, 3000);

    expect(await page.locator('#reason-message').textContent()).toContain('<img src=x');

    await page.click('#take-control');
    await waitFor(async () => (await page.getAttribute('#state-pill', 'data-state')) === 'mine', 5000);

    await page.check('#resume-current');
    await page.fill('#handback-notes', XSS.notes);
    await page.click('#handback-submit');
    await resolution;

    for (const flag of ['__xssReason', '__xssGoal', '__xssCtx', '__xssNotes']) {
      expect(await page.evaluate((f) => (window as unknown as Record<string, unknown>)[f], flag)).toBeUndefined();
    }
    expect(pageErrors).toEqual([]);

    for (const scope of ['#queue', '#detail', '#act']) {
      // Any raw <img>/<svg>/<script> element in one of these panes would mean a payload escaped
      // text rendering, except the one legitimate #shot-img.
      const count = await page.locator(`${scope} img:not(#shot-img), ${scope} svg, ${scope} script`).count();
      expect(count).toBe(0);
    }
  }, 20000);

  it('keyboard shortcuts', async () => {
    const f1 = harness.trackFixture(makeBrokerFixture({ sessionLabel: 'cu-core session E1' }));
    const f2 = harness.trackFixture(makeBrokerFixture({ sessionLabel: 'cu-core session E2' }));
    const f3 = harness.trackFixture(makeBrokerFixture({ sessionLabel: 'cu-core session E3' }));
    const server = await harness.startServer({ brokers: [f1.broker, f2.broker, f3.broker] });
    const page = await harness.newPage(requireBrowser());

    await openRelay(page, server.url);

    const e1 = await escalateSample(f1.broker, { capabilityId: 'cap-one' });
    const e2 = await escalateSample(f2.broker, { capabilityId: 'cap-two' });
    const e3 = await escalateSample(f3.broker, { capabilityId: 'cap-three' });

    await waitFor(async () => (await page.locator('.qcard').count()) >= 3, 5000);

    async function focusedInterventionId(): Promise<string | null> {
      return page.evaluate(() => document.activeElement?.getAttribute('data-intervention-id') ?? null);
    }

    // Open group is oldest-first, so e1, e2, e3 in creation order.
    await page.locator('.qcard').first().focus();
    await waitFor(async () => (await focusedInterventionId()) === e1.id, 2000);

    await page.keyboard.press('j');
    await waitFor(async () => (await focusedInterventionId()) === e2.id, 2000);
    // j/k move focus only: nothing becomes selected (aria-current) just from moving focus.
    expect(await page.locator('.qcard[aria-current="true"]').count()).toBe(0);

    await page.keyboard.press('k');
    await waitFor(async () => (await focusedInterventionId()) === e1.id, 2000);

    await page.keyboard.press('j');
    await page.keyboard.press('Enter');
    await waitFor(async () => (await page.locator(`.qcard[data-intervention-id="${e2.id}"]`).getAttribute('aria-current')) === 'true', 3000);
    const titleAfterSelect = await page.locator('#detail-title').innerText();

    await page.keyboard.press('t');
    await waitFor(async () => (await page.getAttribute('#state-pill', 'data-state')) === 'mine', 5000);
    // 'mine' can arrive over SSE before the take's own response; 'h' is a no-op until it lands.
    await waitFor(async () => page.locator('#handback-submit').isEnabled(), 5000);

    await page.keyboard.press('h');
    const res2 = await e2.resolution;
    expect(res2.resumeFrom).toBe('current_step'); // the default resumeFrom when handing back via 'h'.

    // Select a different still-open intervention, then abort it via the confirm dialog.
    await page.click(`.qcard[data-intervention-id="${e3.id}"]`);
    await waitFor(async () => {
      const title = await page.locator('#detail-title').innerText();
      return title !== titleAfterSelect;
    }, 3000);

    await page.keyboard.press('a');
    await waitFor(async () => (await page.locator('#confirm-dialog[open]').count()) > 0, 3000);
    await page.click('#confirm-ok');

    const res3 = await e3.resolution;
    expect(res3.resumeFrom).toBe('abort');
    await waitFor(async () => (await page.getAttribute('#state-pill', 'data-state')) === 'abandoned', 5000);

    // Typing 'j' while focus is inside the operator-name field must not move queue focus.
    await page.click(`.qcard[data-intervention-id="${e1.id}"]`);
    await page.focus('#operator-name');
    await page.keyboard.type('j');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('operator-name');
  }, 20000);

  it('light and dark themes render', async () => {
    const fPaused = harness.trackFixture(makeBrokerFixture({ sessionLabel: 'cu-core session F-paused', runKind: 'discovery' }));
    const fHeld = harness.trackFixture(makeBrokerFixture({ sessionLabel: 'cu-core session F-held' }));
    const fResolved = harness.trackFixture(makeBrokerFixture({ sessionLabel: 'cu-core session F-resolved' }));
    const server = await harness.startServer({ brokers: [fPaused.broker, fHeld.broker, fResolved.broker] });

    const png = await renderCuCoreScreenshot(requireBrowser());
    fHeld.surface.screenshot = async () => png;

    const page = await harness.newPage(requireBrowser());
    await page.setViewportSize({ width: 1440, height: 900 });
    await openRelay(page, server.url);

    // One paused discovery escalation, no capability, an 'unexpected_dialog' reason.
    await escalateSample(fPaused.broker, {
      capabilityId: undefined,
      goal: 'Find the payoff amount for loan 4471-02',
      reason: { code: 'unexpected_dialog', message: 'An unexpected confirmation dialog appeared.' },
    });

    // One held by "you" (default operator), with 4 captured actions including an input and a
    // keypress Enter, escalation screenshot showing.
    const held = await escalateSample(fHeld.broker, { screenshotPng: png });
    await waitFor(async () => (await page.locator(`.qcard[data-intervention-id="${held.id}"]`).count()) > 0, 5000);
    await page.click(`.qcard[data-intervention-id="${held.id}"]`);
    await page.click('#take-control');
    await waitFor(async () => (await page.getAttribute('#state-pill', 'data-state')) === 'mine', 5000);

    fHeld.capture.emit(sampleAction({ type: 'click' }));
    fHeld.capture.emit({ ...sampleAction({ type: 'input', target: { role: 'textbox', name: 'Payoff Amount' } }), value: 'x' });
    fHeld.capture.emit({ ...sampleAction({ type: 'keypress', key: 'Enter', target: { tag: 'input', name: 'Payoff Amount' } }) });
    fHeld.capture.emit(sampleAction({ type: 'click', target: { tag: 'button', role: 'button', name: 'Save' } }));
    await waitFor(async () => (await page.locator('#act li.action').count()) >= 4, 8000);

    // The keypress row (key: 'Enter', no target.text) renders the key itself, not a blank detail.
    expect(await page.locator('#act li.action[data-type="keypress"] .action-key kbd').innerText()).toBe('Enter');

    await page.click('[data-shot="escalation"]');
    await waitFor(async () => (await page.locator('#shot-img').count()) > 0, 3000);

    // One resolved via hand-back.
    const resolved = await escalateSample(fResolved.broker);
    await waitFor(async () => (await page.locator(`.qcard[data-intervention-id="${resolved.id}"]`).count()) > 0, 5000);
    await page.click(`.qcard[data-intervention-id="${resolved.id}"]`);
    await page.click('#take-control');
    await waitFor(async () => (await page.getAttribute('#state-pill', 'data-state')) === 'mine', 5000);
    await page.check('#resume-current');
    await page.click('#handback-submit');
    await resolved.resolution;

    // Reselect the held intervention so it (and its escalation screenshot) is what's on screen.
    await page.click(`.qcard[data-intervention-id="${held.id}"]`);
    await waitFor(async () => (await page.getAttribute('#state-pill', 'data-state')) === 'mine', 3000);

    await page.click('[data-theme-choice="light"]');
    await waitFor(async () => (await page.getAttribute('html', 'data-theme')) === 'light', 2000);
    const lightBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await dismissAllToasts(page);
    await page.screenshot({ path: testResultsPath('relay-light.png'), fullPage: true, animations: 'disabled' });

    await page.click('[data-theme-choice="dark"]');
    await waitFor(async () => (await page.getAttribute('html', 'data-theme')) === 'dark', 2000);
    const darkBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(darkBg).not.toBe(lightBg);
    await dismissAllToasts(page);
    await page.screenshot({ path: testResultsPath('relay-dark.png'), fullPage: true, animations: 'disabled' });

    await page.click('[data-shot="live"]');
    await waitFor(async () => (await page.getAttribute('#live-indicator', 'data-live')) === 'on', 5000);
    await waitFor(async () => (await page.locator('#live-updated').innerText()).startsWith('Updated'), 5000);
    await dismissAllToasts(page);
    await page.screenshot({ path: testResultsPath('relay-live-dark.png'), fullPage: true, animations: 'disabled' });

    await page.setViewportSize({ width: 900, height: 1100 });
    await dismissAllToasts(page);
    await page.screenshot({ path: testResultsPath('relay-narrow-dark.png'), fullPage: true, animations: 'disabled' });
  }, 30000);

  // SSE reconnect, via a real server-side drop. `context.setOffline`/`page.route`/CDP network
  // blocking all proved unable to affect an already-open localhost EventSource in this Chromium
  // (verified with an isolated repro outside the Relay stack), so this builds the relay app
  // directly (bypassing `harness.startServer`, which only exposes `startRelayServer`'s handle, not
  // the underlying `EventHub`) to call `events.disconnectAll()`: it ends every open SSE stream
  // while the hub keeps accepting connections and keeps its ring buffer, so the browser's own
  // EventSource reconnects (its `retry: 2000`) and replays via Last-Event-ID -- a real drop, not a
  // simulated one.
  it('SSE reconnect after a real server-side stream drop', async () => {
    const fixture = harness.trackFixture(makeBrokerFixture({ sessionLabel: 'cu-core session G' }));
    const registry = fromSessionBroker(fixture.broker);
    const relay = createRelayApp({ port: registry, redact: (v: unknown) => v, staticDir: harness.outdir() });
    const httpServer = createServer(relay.app);
    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(0, '127.0.0.1', () => resolve());
    });
    const address = httpServer.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    const url = `http://127.0.0.1:${port}`;

    const page = await harness.newPage(requireBrowser());
    const interventionsGets: string[] = [];
    page.on('request', (req) => {
      if (req.method() === 'GET' && new URL(req.url()).pathname === '/api/interventions') interventionsGets.push(req.url());
    });

    try {
      await openRelay(page, url);

      // Recorded via a MutationObserver (installed before the drop) rather than polling, since the
      // client may flip reconnecting->live again before a poll gets a chance to observe it.
      await page.evaluate(() => {
        (window as unknown as { __marker?: number }).__marker = 1;
        (window as unknown as { __sawReconnecting?: boolean }).__sawReconnecting = false;
        const target = document.querySelector('#conn-status');
        if (!target) return;
        const mo = new MutationObserver(() => {
          const state = target.getAttribute('data-state');
          if (state === 'reconnecting' || state === 'offline') {
            (window as unknown as { __sawReconnecting?: boolean }).__sawReconnecting = true;
          }
        });
        mo.observe(target, { attributes: true, attributeFilter: ['data-state'] });
      });

      relay.events.disconnectAll();
      // Published while the browser has no open connection: must arrive only via the Last-Event-ID
      // replay on reconnect, never through a live push (there's no live connection to push over).
      const { id } = await escalateSample(fixture.broker);

      await waitFor(() => page.evaluate(() => (window as unknown as { __sawReconnecting?: boolean }).__sawReconnecting === true), 10000);
      await waitFor(async () => (await page.getAttribute('#conn-status', 'data-state')) === 'live', 35000);
      await waitFor(async () => (await page.locator(`[data-group="open"] .qcard[data-intervention-id="${id}"]`).count()) > 0, 10000);

      // No reload happened, and the reconnect replayed the buffered event rather than falling back
      // to a REST refetch (that only happens on an SSE `reset`, which a plain disconnect never sends).
      expect(await page.evaluate(() => (window as unknown as { __marker?: number }).__marker)).toBe(1);
      expect(interventionsGets).toEqual([]);
    } finally {
      await relay.close();
      registry.dispose();
      httpServer.closeAllConnections?.();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
    }
  }, 60000);
});

if (browser === undefined) {
  describe('Relay UI, driven by a real headless browser', () => {
    it.skip(`SKIPPED: chromium failed to launch in this environment (${launchError}); ran no browser assertions`, () => {});
  });
}

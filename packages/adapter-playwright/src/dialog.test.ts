import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPlaywrightSurface, type PlaywrightSurface } from './surface.js';
import { startFixtureServer, type FixtureServer } from './test-helpers.js';

/**
 * Fires a click that opens a native dialog (`confirm()`/`alert()`) without awaiting it: the dialog
 * blocks the page until it is handled, so an awaited click would hang until the test dismisses it.
 * The button is awaited visible first, so the click has no actionability wait left to lose under
 * load, and the fire-and-forget promise gets a `.catch()`: if it settles only after `afterEach`
 * closed the surface, its rejection must not land as an unhandled rejection in some later test.
 */
async function clickOpeningDialog(surface: PlaywrightSurface, selector: string): Promise<void> {
  const locator = surface.page.locator(selector);
  await locator.waitFor({ state: 'visible' });
  void locator.click().catch(() => undefined);
}

describe('PlaywrightSurface: native dialog handling', () => {
  let fixtures: FixtureServer;
  let surface: PlaywrightSurface;

  beforeAll(async () => {
    fixtures = await startFixtureServer();
  });

  afterAll(async () => {
    await fixtures.close();
  });

  // Chromium launch and the first load run in the hook (hookTimeout), not the test body, so a slow
  // launch under full-suite load cannot eat the budget of the dialog steps each test times.
  beforeEach(async () => {
    surface = await createPlaywrightSurface({ headless: true });
    await surface.page.goto(fixtures.url('dialog-fixture.html'));
  });

  afterEach(async () => {
    await surface?.close();
  });

  it('holds a confirm() dialog, reports it, blocks other actions, and applies accept/dismiss', async () => {
    expect(await surface.check({ kind: 'dialog_open' })).toBe(false);

    // Dialog-safe click: fire-and-forget, then wait for the surface to observe the pending dialog.
    await clickOpeningDialog(surface, '#confirm-btn');
    expect(await surface.waitFor({ kind: 'dialog_open' }, 5000)).toBe(true);
    expect(await surface.check({ kind: 'dialog_open' })).toBe(true);
    expect(await surface.check({ kind: 'dialog_open', messagePattern: 'Delete' })).toBe(true);
    expect(await surface.check({ kind: 'dialog_open', messagePattern: 'Nope' })).toBe(false);

    // observe() reports the dialog directly (its dialog branch never touches the stubbed enumerator).
    const obs = await surface.observe();
    expect(obs.dialog).toEqual({ type: 'confirm', message: 'Delete record?' });

    // Any non-dismiss action fails fast while the dialog is pending.
    const clickWhilePending = await surface.act({ type: 'click', target: { ref: 'x' } }, 10_000);
    expect(clickWhilePending.ok).toBe(false);
    expect(clickWhilePending.error?.code).toBe('unexpected_dialog');

    const pressWhilePending = await surface.act({ type: 'press', key: 'a' }, 10_000);
    expect(pressWhilePending.ok).toBe(false);
    expect(pressWhilePending.error?.code).toBe('unexpected_dialog');

    // Accept -> confirm() returns true, DOM reflects it, dialog_open clears.
    const acceptResult = await surface.act({ type: 'dismiss_dialog', accept: true }, 10_000);
    expect(acceptResult.ok).toBe(true);
    expect(await surface.check({ kind: 'dialog_open' })).toBe(false);
    await expect.poll(() => surface.page.locator('#result').textContent()).toBe('true');

    // Repeat, this time dismissing -> confirm() returns false.
    await clickOpeningDialog(surface, '#confirm-btn');
    expect(await surface.waitFor({ kind: 'dialog_open' }, 5000)).toBe(true);
    const dismissResult = await surface.act({ type: 'dismiss_dialog', accept: false }, 10_000);
    expect(dismissResult.ok).toBe(true);
    expect(await surface.check({ kind: 'dialog_open' })).toBe(false);
    await expect.poll(() => surface.page.locator('#result').textContent()).toBe('false');
  });

  it('act(click) on a control that opens confirm() returns promptly with the dialog held', async () => {
    const target = {
      description: 'Delete button',
      frame: [],
      locators: [{ strategy: { kind: 'text' as const, text: 'Delete', exact: true, tag: 'button' }, confidence: 0.7, source: 'recorded' as const }],
    };
    // A click blocked by the dialog would run out the whole 15 s budget; returning in well under
    // that proves act() hands back as soon as the dialog opens, with headroom for a loaded machine.
    const started = Date.now();
    const res = await surface.act({ type: 'click', target }, 15_000);
    expect(res.ok).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(await surface.check({ kind: 'dialog_open', messagePattern: 'Delete record' })).toBe(true);
    expect((await surface.act({ type: 'dismiss_dialog', accept: true }, 10_000)).ok).toBe(true);
    await expect.poll(() => surface.page.locator('#result').textContent()).toBe('true');
  });

  it('holds and dismisses an alert()', async () => {
    await clickOpeningDialog(surface, '#alert-btn');
    expect(await surface.waitFor({ kind: 'dialog_open' }, 5000)).toBe(true);
    expect(await surface.check({ kind: 'dialog_open' })).toBe(true);

    const result = await surface.act({ type: 'dismiss_dialog', accept: true }, 10_000);
    expect(result.ok).toBe(true);
    expect(await surface.check({ kind: 'dialog_open' })).toBe(false);
    await expect.poll(() => surface.page.locator('#result2').textContent()).toBe('alert-done');
  });

  it('check() never blocks on a dialog that opens while it is reading the page', async () => {
    // The page opens confirm() from a timer, so the dialog can open while check() has an
    // evaluation in flight, before the surface has seen the dialog event. An evaluation blocks for
    // as long as a dialog is open, and this dialog is only dismissed below.
    for (let i = 0; i < 12; i++) {
      await surface.page.evaluate((delay) => {
        setTimeout(() => {
          document.getElementById('result')!.textContent = String(confirm('Timed'));
        }, delay);
      }, i % 6);
      const outcome = await Promise.race([
        (async () => {
          for (let k = 0; k < 100; k++) if (await surface.check({ kind: 'dialog_open' })) return 'open';
          return 'never';
        })(),
        new Promise<string>((r) => setTimeout(() => r('blocked'), 5000)),
      ]);
      expect(outcome, `iteration ${i}`).toBe('open');
      expect((await surface.act({ type: 'dismiss_dialog', accept: true }, 5000)).ok).toBe(true);
    }
  });

  it('dismiss_dialog with none pending is a graceful no-op', async () => {
    const result = await surface.act({ type: 'dismiss_dialog', accept: true }, 1000);
    expect(result).toEqual({ ok: true, navigated: false });
  });
});

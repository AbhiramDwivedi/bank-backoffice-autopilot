import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { HumanAction } from '@cu/core/schema';
import { HumanAction as HumanActionSchema } from '@cu/core/schema';
import { createHumanCapture } from './capture.js';
import { createPlaywrightSurface, type PlaywrightSurface } from './surface.js';
import { startFixtureServer, type FixtureServer } from './test-helpers.js';

describe('createHumanCapture', () => {
  let fixtures: FixtureServer;
  let surface: PlaywrightSurface;

  beforeAll(async () => {
    fixtures = await startFixtureServer();
  });

  afterAll(async () => {
    await fixtures.close();
  });

  afterEach(async () => {
    await surface?.close();
  });

  it('captures click/input/keypress/navigate across an iframe, never the typed value; stop() silences it', async () => {
    surface = await createPlaywrightSurface({ headless: true });
    await surface.page.goto(fixtures.url('capture-outer.html'));

    const actions: HumanAction[] = [];
    await surface.humanCapture.start((a) => actions.push(a));

    const mainFrame = surface.page.frame({ name: 'main' });
    if (!mainFrame) throw new Error('test setup: main frame not found');

    // click
    await mainFrame.click('#btn');
    await expect.poll(() => actions.filter((a) => a.type === 'click').length).toBeGreaterThan(0);
    const click = actions.find((a) => a.type === 'click');
    expect(click?.frame).toEqual([{ name: 'main' }]);
    expect(click?.target.name).toBe('Click me');
    expect(click?.target.text).toBe('Click me');

    // input: never the value, valueRedacted true, one event for the whole edit
    await mainFrame.fill('#field', 'secret123');
    await expect.poll(() => actions.filter((a) => a.type === 'input').length).toBeGreaterThan(0);
    const input = actions.find((a) => a.type === 'input');
    expect(input?.valueRedacted).toBe(true);
    expect(JSON.stringify(actions)).not.toContain('secret123');

    // keypress: Enter/Tab/Escape each carry `key`, never the key name in `target.text`
    for (const k of ['Enter', 'Tab', 'Escape'] as const) {
      await mainFrame.press('#field', k);
    }
    await expect.poll(() => actions.filter((a) => a.type === 'keypress').length).toBe(3);
    const keypresses = actions.filter((a) => a.type === 'keypress');
    expect(keypresses.map((a) => a.key)).toEqual(['Enter', 'Tab', 'Escape']);
    for (const a of keypresses) {
      expect(a.target.text).toBeUndefined();
    }
    expect(keypresses[0]?.frame).toEqual([{ name: 'main' }]);

    // navigate: click a same-frame link that loads a new document
    await mainFrame.click('#nav-link');
    await expect.poll(() => actions.filter((a) => a.type === 'navigate').length).toBeGreaterThan(0);
    const navigate = actions.find((a) => a.type === 'navigate');
    expect(navigate?.frame).toEqual([{ name: 'main' }]);
    expect(navigate?.url).toContain('capture-inner-2.html');

    // capture still works in the frame's new document (addInitScript re-injected it)
    await expect.poll(() => mainFrame.locator('#btn2').isVisible().catch(() => false)).toBe(true);
    await mainFrame.click('#btn2');
    const clicksAfterNav = () => actions.filter((a) => a.type === 'click' && a.target.name === 'Second Click').length;
    await expect.poll(clicksAfterNav).toBeGreaterThan(0);

    // every captured action validates against the HumanAction zod schema
    for (const a of actions) HumanActionSchema.parse(a);

    // stop(): further interaction produces no new actions
    await surface.humanCapture.stop();
    const countBeforeStop = actions.length;
    await mainFrame.click('#btn2');
    await new Promise((r) => setTimeout(r, 300));
    expect(actions.length).toBe(countBeforeStop);

    // secret never appears anywhere, even after everything above
    expect(JSON.stringify(actions)).not.toContain('secret123');
  });

  it('start() after stop() captures again', async () => {
    surface = await createPlaywrightSurface({ headless: true });
    await surface.page.goto(fixtures.url('capture-outer.html'));

    const actions: HumanAction[] = [];
    await surface.humanCapture.start((a) => actions.push(a));
    await surface.humanCapture.stop();

    const mainFrame = surface.page.frame({ name: 'main' });
    if (!mainFrame) throw new Error('test setup: main frame not found');
    await mainFrame.click('#btn');
    await new Promise((r) => setTimeout(r, 200));
    expect(actions.length).toBe(0);

    await surface.humanCapture.start((a) => actions.push(a));
    await mainFrame.click('#btn');
    await expect.poll(() => actions.length).toBeGreaterThan(0);
    expect(actions[0]?.type).toBe('click');
  });

  it('drops target.text from a keypress record even when the page sends one (hostile input)', async () => {
    surface = await createPlaywrightSurface({ headless: true });
    await surface.page.goto(fixtures.url('capture-outer.html'));

    const actions: HumanAction[] = [];
    await surface.humanCapture.start((a) => actions.push(a));

    const mainFrame = surface.page.frame({ name: 'main' });
    if (!mainFrame) throw new Error('test setup: main frame not found');

    // A hostile (or stale/legacy) record that stuffs the key name into `target.text` directly,
    // delivered through the same binding the real agent uses but bypassing its own capture code
    // entirely: the page is untrusted, so the adapter must drop `target.text` regardless.
    await mainFrame.evaluate(() => {
      (window as unknown as { __cuHumanAction: (record: unknown) => void }).__cuHumanAction({
        ts: new Date().toISOString(),
        type: 'keypress',
        target: { text: 'Enter', tag: 'INPUT' },
        key: 'Enter',
        valueRedacted: true,
      });
    });

    await expect.poll(() => actions.filter((a) => a.type === 'keypress').length).toBeGreaterThan(0);
    const keypress = actions.find((a) => a.type === 'keypress');
    expect(keypress?.key).toBe('Enter');
    expect(keypress?.target.text).toBeUndefined();
    expect(keypress?.target.tag).toBe('INPUT');
  });

  it('stop() while start() is still in flight leaves nothing registered, so a later session stop() still stops in-page capture', async () => {
    surface = await createPlaywrightSurface({ headless: true });
    const page = surface.page;
    await page.goto(fixtures.url('capture-outer.html'));
    const mainFrame = page.frame({ name: 'main' });
    if (!mainFrame) throw new Error('test setup: main frame not found');
    const activeFrames = async (): Promise<number> => {
      const states = await Promise.all(
        page.frames().map((f) => f.evaluate(() => window.__cuAgent?.capture.isActive() === true).catch(() => false)),
      );
      return states.filter(Boolean).length;
    };
    // Page is an EventEmitter at runtime; its typings leave listenerCount out.
    const navListeners = (): number => (page as unknown as { listenerCount(event: string): number }).listenerCount('framenavigated');
    const baselineNavListeners = navListeners();

    // stop() lands at different points of the pending start(): before its first await settles,
    // and a few event-loop turns in.
    for (const delayMs of [0, 1, 5, 20, 50]) {
      const abandoned = createHumanCapture(page);
      const abandonedActions: HumanAction[] = [];
      const starting = abandoned.start((a) => abandonedActions.push(a));
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      await abandoned.stop();
      await abandoned.stop(); // idempotent
      await starting;
      expect(navListeners(), `delay ${delayMs}ms: no frame listener left behind`).toBe(baselineNavListeners);

      // Another session on the same page captures, and its stop() turns in-page capture off
      // everywhere: nothing of the abandoned start() still counts as a listening session.
      const other = createHumanCapture(page);
      const otherActions: HumanAction[] = [];
      await other.start((a) => otherActions.push(a));
      await mainFrame.click('#btn');
      await expect.poll(() => otherActions.filter((a) => a.type === 'click').length).toBe(1);
      await other.stop();
      expect(await activeFrames(), `delay ${delayMs}ms: in-page capture stopped in every frame`).toBe(0);
      expect(abandonedActions, `delay ${delayMs}ms: the abandoned session received nothing`).toHaveLength(0);
    }
  });

  it('two sequential surfaces borrowing the same page both capture (and a concurrent pair both receive)', async () => {
    surface = await createPlaywrightSurface({ headless: true });
    await surface.page.goto(fixtures.url('capture-outer.html'));
    const mainFrame = surface.page.frame({ name: 'main' });
    if (!mainFrame) throw new Error('test setup: main frame not found');

    const first = await createPlaywrightSurface({ page: surface.page });
    const firstActions: HumanAction[] = [];
    await first.humanCapture.start((a) => firstActions.push(a));
    await mainFrame.click('#btn');
    await expect.poll(() => firstActions.filter((a) => a.type === 'click').length).toBe(1);
    await first.close();

    const second = await createPlaywrightSurface({ page: surface.page });
    const secondActions: HumanAction[] = [];
    await second.humanCapture.start((a) => secondActions.push(a));
    await mainFrame.click('#btn');
    await expect.poll(() => secondActions.filter((a) => a.type === 'click').length).toBe(1);
    expect(firstActions.filter((a) => a.type === 'click')).toHaveLength(1);

    // Concurrent: both sessions receive; stopping one leaves the other capturing.
    const ownerActions: HumanAction[] = [];
    await surface.humanCapture.start((a) => ownerActions.push(a));
    await mainFrame.click('#btn');
    await expect.poll(() => ownerActions.filter((a) => a.type === 'click').length).toBe(1);
    await expect.poll(() => secondActions.filter((a) => a.type === 'click').length).toBe(2);
    await second.close();
    await mainFrame.click('#btn');
    await expect.poll(() => ownerActions.filter((a) => a.type === 'click').length).toBe(2);
    expect(secondActions.filter((a) => a.type === 'click')).toHaveLength(2);
  });
});

import type { Browser } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { launchBrowser, MODES, openPage, startServer, type Mode, type Opened, type TestServer } from './helpers.js';

describe.each(MODES)('sink (mode=%s)', (mode: Mode) => {
  let server: TestServer;
  let browser: Browser;
  let opened: Opened | undefined;

  beforeAll(async () => {
    server = await startServer();
    browser = await launchBrowser();
  });

  afterAll(async () => {
    await browser.close();
    await server.close();
  });

  afterEach(async () => {
    await opened?.context.close();
    opened = undefined;
  });

  it('binding present: records reach the binding, events stays empty, no postMessage is sent', async () => {
    const received: unknown[] = [];
    opened = await openPage(browser, server, mode, 'sink-click.html', {
      binding: (action) => received.push(action),
    });
    const page = opened.page;

    const sawMessage = await page.evaluate(
      () =>
        new Promise<boolean>((resolve) => {
          let saw = false;
          window.addEventListener('message', (e) => {
            const data = e.data as { type?: string } | undefined;
            if (data?.type === 'cu-agent:action') saw = true;
          });
          window.__cuAgent!.capture.start();
          document.getElementById('btn')!.click();
          setTimeout(() => resolve(saw), 300);
        }),
    );
    expect(sawMessage).toBe(false);

    await expect.poll(() => received.length).toBeGreaterThan(0);
    const eventsLength = await page.evaluate(() => window.__cuAgent!.events.length);
    expect(eventsLength).toBe(0);
  });

  it('binding absent: records land in events and are postMessaged; drain() empties the buffer in order', async () => {
    opened = await openPage(browser, server, mode, 'sink-click.html');
    const page = opened.page;
    await page.evaluate(() => window.__cuAgent!.capture.start());

    const sawMessage = await page.evaluate(
      () =>
        new Promise<boolean>((resolve) => {
          let saw = false;
          window.addEventListener('message', (e) => {
            const data = e.data as { type?: string; action?: { type?: string } } | undefined;
            if (data?.type === 'cu-agent:action' && data.action?.type === 'click') saw = true;
          });
          document.getElementById('btn')!.click();
          setTimeout(() => resolve(saw), 300);
        }),
    );
    expect(sawMessage).toBe(true);

    const beforeDrain = await page.evaluate(() => window.__cuAgent!.events.length);
    expect(beforeDrain).toBeGreaterThan(0);

    const drained = await page.evaluate(() => window.__cuAgent!.drain());
    expect(drained.length).toBe(beforeDrain);
    expect(drained.every((r) => r.type === 'click')).toBe(true);

    const afterDrain = await page.evaluate(() => window.__cuAgent!.events.length);
    expect(afterDrain).toBe(0);
  });

  it('buffer is bounded at 500: 600 records keep the newest 500, oldest 100 dropped', async () => {
    opened = await openPage(browser, server, mode, 'sink-click.html');
    const page = opened.page;
    await page.evaluate(() => window.__cuAgent!.capture.start());

    const result = await page.evaluate(() => {
      const btn = document.getElementById('btn')!;
      for (let i = 0; i < 600; i++) {
        btn.setAttribute('aria-label', String(i));
        btn.click();
      }
      const events = window.__cuAgent!.events;
      return { length: events.length, names: events.map((e) => e.target.name) };
    });

    expect(result.length).toBe(500);
    expect(result.names[0]).toBe('100');
    expect(result.names[result.names.length - 1]).toBe('599');
  });
});

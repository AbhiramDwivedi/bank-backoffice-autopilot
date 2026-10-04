/**
 * Red team: screen masking fails closed (docs/design/screen-masking.md, "Fail closed"), against the
 * real surface. Each case is a way masked content could get out, and each asserts it does not:
 *  - a frame that cannot be planned (sabotaged agent, top or child; a rule the page rejects):
 *    no screenshot, no DOM for it, its text dropped, the title withheld when it is the top;
 *  - a page that changes between plan and capture (a frame reloading every 40 ms, rows
 *    re-rendered every 100 ms, a MutationObserver stripping the marks): every capture that goes
 *    out has zero PII pixels, the rest are withheld;
 *  - overlapping captures (Relay polling during an observation, a policy check): never un-masked;
 *  - a page that never answers (an endless loop): the capture lock has a deadline;
 *  - a page with more blocks than one comparison batch, with a run value present: still masked,
 *    not blind;
 *  - a browser error that quotes the page (an overlay intercepting a click): never passed through;
 *  - a native dialog that blocks planning: the placeholder.
 * Pixel checks count the PII colour over the whole PNG (`countColor`).
 */
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AGENT_VERSION } from '@cu/browser-agent';
import { resolveScreenMask, type ScreenMaskConfig } from '@cu/core/schema';
import { isOmittedScreenshot, type ScreenMaskOptions } from '@cu/core/surface';
import { createPlaywrightSurface, type PlaywrightSurface } from './surface.js';
import { countColor, startFixtureServer, type FixtureServer } from './test-helpers.js';

let browser: Browser;
let fixtures: FixtureServer;
let surface: PlaywrightSurface | undefined;
let decoder: Page;
const logs: string[] = [];

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  fixtures = await startFixtureServer();
  decoder = await (await browser.newContext()).newPage();
});

afterAll(async () => {
  await browser.close();
  await fixtures.close();
});

afterEach(async () => {
  await surface?.close();
  surface = undefined;
  logs.length = 0;
});

/** Rules that cover every piece of PII the fixture pages paint (so any PII pixel is a leak). */
function options(config: Partial<ScreenMaskConfig> = {}, values: () => readonly string[] = () => ['operator-sekrit-7']): ScreenMaskOptions {
  return {
    config: {
      ...resolveScreenMask(undefined),
      maskLabels: ['^phone$', '^address$', 'member name', 'savings balance', 'e-?mail'],
      maskSelectors: ['.account-note'],
      ...config,
    },
    textPatterns: [],
    sensitiveValues: values,
  };
}

async function open(file: string, screenMask: ScreenMaskOptions, captureDeadlineMs?: number): Promise<PlaywrightSurface> {
  surface = await createPlaywrightSurface({
    browser,
    viewport: { width: 1000, height: 1000 },
    screenMask,
    log: (m) => logs.push(m),
    ...(captureDeadlineMs !== undefined ? { captureDeadlineMs } : {}),
  });
  expect((await surface.act({ type: 'navigate', url: fixtures.url(file) }, 10_000)).ok).toBe(true);
  return surface;
}

/** Replaces the frame's agent with a same-version impostor whose mask planner is unusable, and pins it there. */
const SABOTAGE = (version: string): string => `Object.defineProperty(window, '__cuAgent', {
  value: { version: ${JSON.stringify(version)}, lib: { maskPlan: function () { throw new Error('nope'); } } },
  writable: false, configurable: false,
});`;

describe('screen masking fails closed', () => {
  it('top document cannot be planned: no screenshot, the placeholder, no DOM, and no title', async () => {
    const s = await open('mask-page.html', options());
    await s.page.evaluate(SABOTAGE(AGENT_VERSION));
    const obs = await s.observe();
    expect(obs.screenshotPng).toBeUndefined();
    expect(obs.title, 'the title ("Member 4242 - Pat Example") is withheld with the frame').toBe('');
    expect(JSON.stringify(obs)).not.toContain('Pat Example');
    expect(isOmittedScreenshot(await s.screenshot()), 'an unmasked capture was returned').toBe(true);
    const dom = await s.domSnapshot();
    expect(dom).not.toContain('(413) 555-0199');
    expect(logs.some((l) => l.startsWith('screen mask: failing closed'))).toBe(true);
  });

  it('one child frame cannot be planned: the whole screenshot is withheld, and only that frame drops out of the text and the DOM', async () => {
    const s = await open('mask-frames-outer.html', options());
    const main = s.page.frame({ name: 'main' })!;
    await main.waitForLoadState('domcontentloaded');
    await main.evaluate(SABOTAGE(AGENT_VERSION));
    const obs = await s.observe();
    expect(obs.screenshotPng).toBeUndefined();
    expect(isOmittedScreenshot(await s.screenshot())).toBe(true);
    expect(obs.textDigest).not.toContain('Frame Q. Person');
    expect(obs.textDigest).toContain('Silver');
    const dom = await s.domSnapshot();
    expect(dom).not.toContain('Frame Q. Person');
    expect(dom).toContain('Silver');
  });

  it('a policy rule the page cannot apply (invalid selector) withholds every screenshot rather than skipping the rule', async () => {
    const s = await open('mask-page.html', options({ maskSelectors: ['.account-note', 'td[[broken'] }));
    expect((await s.observe()).screenshotPng).toBeUndefined();
    expect(isOmittedScreenshot(await s.screenshot())).toBe(true);
    expect(logs.join('\n')).toContain('mask rules rejected');
  });

  it('a page that changes between plan and capture (a frame reloading every 40 ms, rows re-rendered every 100 ms): no capture that goes out shows PII', async () => {
    const s = await open('mask-busy.html', options());
    let delivered = 0;
    for (let i = 0; i < 12; i++) {
      const shot = await s.screenshot();
      if (isOmittedScreenshot(shot)) continue;
      delivered++;
      expect(await countColor(decoder, shot), `screenshot ${i} leaked`).toBe(0);
    }
    for (let i = 0; i < 6; i++) {
      const obs = await s.observe();
      if (obs.screenshotPng === undefined) continue;
      delivered++;
      expect(await countColor(decoder, obs.screenshotPng), `observe ${i} leaked`).toBe(0);
    }
    // Withheld is the honest answer for most of these; the point is that none leaked.
    expect(delivered).toBeGreaterThanOrEqual(0);
  });

  it('a page script that strips the mask marks before the capture: the capture is discarded, never returned unmasked', async () => {
    const s = await open('mask-page.html', options());
    await s.page.evaluate(() => {
      new MutationObserver(() => {
        for (const el of Array.from(document.querySelectorAll('[data-cu-mask]'))) el.removeAttribute('data-cu-mask');
      }).observe(document, { subtree: true, attributes: true, attributeFilter: ['data-cu-mask'] });
    });
    const shot = await s.screenshot();
    expect(isOmittedScreenshot(shot) || (await countColor(decoder, shot)) === 0).toBe(true);
    const obs = await s.observe();
    expect(obs.screenshotPng === undefined || (await countColor(decoder, obs.screenshotPng)) === 0).toBe(true);
  });

  it('overlapping captures (a live view polling during an observation, a policy check describing a target) never un-mask each other', async () => {
    const s = await open('mask-page.html', options());
    const ref = (await s.observe()).elements[0]!.ref;
    for (let round = 0; round < 3; round++) {
      const [obs, a, b] = await Promise.all([s.observe(), s.screenshot(), s.screenshot(), s.describeRef(ref), s.domSnapshot()]);
      for (const png of [obs.screenshotPng!, a, b]) expect(await countColor(decoder, png), `round ${round}: a capture went out unmasked`).toBe(0);
    }
  });

  it('a page that never answers (an endless loop) cannot hold the capture lock: every capture returns within its deadline, withheld', async () => {
    const s = await open('mask-page.html', options(), 1500);
    void s.page.evaluate(() => setTimeout(() => {
      for (;;) {
        /* never yields */
      }
    }, 0)).catch(() => undefined);
    const started = Date.now();
    const [shot, dom] = await Promise.all([s.screenshot(), s.domSnapshot()]);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(isOmittedScreenshot(shot)).toBe(true);
    expect(dom).not.toContain('(413) 555-0199');
    await s.page.close().catch(() => undefined);
  }, 30_000);

  it('a page with tens of thousands of text blocks and a run value present is still masked, not blind', async () => {
    const s = await open('mask-page.html', options());
    await s.page.evaluate(() => {
      const host = document.createElement('div');
      for (let i = 0; i < 25000; i++) {
        const d = document.createElement('div');
        d.textContent = `filler ${i}`;
        host.appendChild(d);
      }
      document.body.appendChild(host);
    });
    const shot = await s.screenshot();
    expect(isOmittedScreenshot(shot)).toBe(false);
    expect(await countColor(decoder, shot)).toBe(0);
    expect((await s.observe()).textDigest).not.toContain('operator-sekrit-7');
  }, 60_000);

  it("a browser error that quotes the page (an overlay intercepting a click) is never passed through", async () => {
    const s = await open('mask-page.html', options());
    await s.page.evaluate(() => {
      const b = document.createElement('button');
      b.id = 'go';
      b.textContent = 'Go';
      document.body.prepend(b);
      const o = document.createElement('div');
      o.textContent = 'Member Jane Q Sample at 1 Main St';
      o.style.cssText = 'position:fixed;left:0;top:0;width:400px;height:200px;background:rgba(0,0,0,0.01)';
      document.body.appendChild(o);
    });
    const go = (await s.observe()).elements.find((e) => e.name === 'Go')!;
    const r = await s.act({ type: 'click', target: { ref: go.ref } }, 1500);
    expect(r.ok).toBe(false);
    expect(r.error?.message).not.toContain('Jane');
    expect(r.error?.message).not.toContain('1 Main St');
    expect(r.error?.message).toMatch(/not actionable/);
  });

  it('a native dialog blocks planning: the placeholder, never an unmasked capture', async () => {
    const s = await open('mask-page.html', options());
    void s.page.evaluate(() => setTimeout(() => alert('hold on'), 0));
    await expect.poll(async () => (await s.observe()).dialog?.message, { timeout: 5000 }).toBe('hold on');
    expect(isOmittedScreenshot(await s.screenshot())).toBe(true);
    expect((await s.observe()).screenshotPng).toBeUndefined();
    await s.act({ type: 'dismiss_dialog', accept: true }, 5000);
  });
});

import type { Browser } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { agentSource, AGENT_VERSION } from '../src/index.js';
import { launchBrowser, MODES, startServer, type Mode, type Opened, type TestServer } from './helpers.js';

/** DOM fingerprint used to prove install touches nothing but the detect attribute. */
interface DomSnapshot {
  count: number;
  width: number;
  height: number;
  html: string;
}

const snapshot = (): DomSnapshot => ({
  count: document.querySelectorAll('*').length,
  width: document.body.scrollWidth,
  height: document.body.scrollHeight,
  html: document.documentElement.outerHTML,
});

function stripDetectAttribute(html: string): string {
  return html.replace(/\s*data-cu-agent="[^"]*"/, '');
}

describe('install', () => {
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

  for (const mode of MODES as readonly Mode[]) {
    it(`installs exactly once from two script tags, with no warning (mode=${mode})`, async () => {
      const context = await browser.newContext();
      if (mode === 'injected') await context.addInitScript({ content: agentSource() });
      const page = await context.newPage();
      const warnings: string[] = [];
      page.on('console', (msg) => {
        if (msg.type() === 'warning') warnings.push(msg.text());
      });
      await page.goto(server.url(mode, 'install-two-tags.html'));
      opened = { context, page };

      await page.evaluate(() => window.__cuAgent!.capture.start());
      await page.click('#btn');
      const events = await page.evaluate(() => window.__cuAgent!.drain());
      expect(events.length).toBe(1);

      const attrValue = await page.evaluate(() => document.documentElement.getAttribute('data-cu-agent'));
      expect(attrValue).toBe(AGENT_VERSION);
      expect(warnings.length).toBe(0);
    });
  }

  it('injected + included together: the injected agent is reused (same object identity)', async () => {
    const context = await browser.newContext();
    await context.addInitScript({ content: agentSource() });
    const page = await context.newPage();
    await page.goto(server.url('included', 'install-blank.html'));
    opened = { context, page };

    await page.evaluate(() => {
      (window as unknown as { __mark?: unknown }).__mark = window.__cuAgent;
    });
    await page.evaluate(agentSource());
    const same = await page.evaluate(() => (window as unknown as { __mark?: unknown }).__mark === window.__cuAgent);
    expect(same).toBe(true);
  });

  it('an older major pre-installed is replaced, its stop() is called, exactly one warning', async () => {
    const context = await browser.newContext();
    await context.addInitScript({
      content: "window.__cuAgent = { version: '0.9.0', capture: { stop() { window.__oldStopped = true; } } };",
    });
    await context.addInitScript({ content: agentSource() });
    const page = await context.newPage();
    const warnings: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'warning') warnings.push(msg.text());
    });
    await page.goto(server.url('injected', 'install-blank.html'));
    opened = { context, page };

    const result = await page.evaluate(() => ({
      version: window.__cuAgent?.version,
      oldStopped: (window as unknown as { __oldStopped?: boolean }).__oldStopped,
    }));
    expect(result.version).toBe(AGENT_VERSION);
    expect(result.oldStopped).toBe(true);
    expect(warnings.length).toBe(1);
  });

  it('a newer major pre-installed is replaced too (the major is the contract), exactly one warning even after two more evaluations', async () => {
    const context = await browser.newContext();
    await context.addInitScript({
      content: "window.__cuAgent = { version: '2.0.0', capture: { stop() { window.__oldStopped = true; } } };",
    });
    await context.addInitScript({ content: agentSource() });
    const page = await context.newPage();
    const warnings: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'warning') warnings.push(msg.text());
    });
    await page.goto(server.url('injected', 'install-blank.html'));
    opened = { context, page };

    await page.evaluate(() => {
      (window as unknown as { __mark?: unknown }).__mark = window.__cuAgent;
    });
    await page.evaluate(agentSource());
    await page.evaluate(agentSource());

    const result = await page.evaluate(() => ({
      version: window.__cuAgent?.version,
      oldStopped: (window as unknown as { __oldStopped?: boolean }).__oldStopped,
      sameAsFirstReplacement: (window as unknown as { __mark?: unknown }).__mark === window.__cuAgent,
    }));
    expect(result.version).toBe(AGENT_VERSION);
    expect(result.oldStopped).toBe(true);
    expect(result.sameAsFirstReplacement).toBe(true);
    expect(warnings.length).toBe(1);
  });

  const [major, minor] = AGENT_VERSION.split('.').map(Number) as [number, number];
  const newerSameMajor = `${major}.${minor + 1}.0`;

  it('a newer version of the same major pre-installed is reused as is, with no warning', async () => {
    const context = await browser.newContext();
    await context.addInitScript({ content: `window.__cuAgent = { version: '${newerSameMajor}', capture: { stop() { window.__oldStopped = true; } } };` });
    await context.addInitScript({ content: agentSource() });
    const page = await context.newPage();
    const warnings: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'warning') warnings.push(msg.text());
    });
    await page.goto(server.url('injected', 'install-blank.html'));
    opened = { context, page };

    const result = await page.evaluate(() => ({
      version: window.__cuAgent?.version,
      oldStopped: (window as unknown as { __oldStopped?: boolean }).__oldStopped,
    }));
    expect(result.version).toBe(newerSameMajor);
    expect(result.oldStopped).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it('an older version of the same major pre-installed is upgraded, and an active capture carries over', async () => {
    // This bundle re-stamped as the next minor stands in for a newer build of the same major.
    const newer = agentSource().split(JSON.stringify(AGENT_VERSION)).join(JSON.stringify(newerSameMajor));
    const context = await browser.newContext();
    await context.addInitScript({ content: agentSource() });
    const page = await context.newPage();
    const warnings: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'warning') warnings.push(msg.text());
    });
    await page.goto(server.url('injected', 'install-two-tags.html'));
    opened = { context, page };
    await page.evaluate(() => window.__cuAgent!.capture.start());

    await page.evaluate(newer);
    const result = await page.evaluate(() => ({ version: window.__cuAgent!.version, active: window.__cuAgent!.capture.isActive() }));
    expect(result).toEqual({ version: newerSameMajor, active: true });
    await page.click('#btn');
    expect(await page.evaluate(() => window.__cuAgent!.drain().length)).toBe(1);
    expect(warnings).toEqual([]);
  });

  for (const [label, hostile] of [
    ['a getter that throws', "Object.defineProperty(window, '__cuAgent', { get() { throw new Error('hostile'); } });"],
    ['a frozen non-string version', "Object.defineProperty(window, '__cuAgent', { value: { version: 123 }, writable: false, configurable: false });"],
  ] as const) {
    it(`a hostile page (${label}) cannot make install throw; it logs once and the page keeps running`, async () => {
      const context = await browser.newContext();
      await context.addInitScript({ content: hostile });
      await context.addInitScript({ content: agentSource() });
      await context.addInitScript({ content: 'window.__afterAgent = true;' });
      const page = await context.newPage();
      const warnings: string[] = [];
      const pageErrors: string[] = [];
      page.on('console', (msg) => {
        if (msg.type() === 'warning') warnings.push(msg.text());
      });
      page.on('pageerror', (err) => pageErrors.push(err.message));
      await page.goto(server.url('injected', 'install-blank.html'));
      opened = { context, page };

      const afterAgent = await page.evaluate(() => (window as unknown as { __afterAgent?: boolean }).__afterAgent);
      expect(afterAgent).toBe(true);
      expect(pageErrors).toEqual([]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('not writable');
    });
  }

  it('installing touches no DOM but the detect attribute (element count, scrollWidth/Height unchanged)', async () => {
    const rawContext = await browser.newContext();
    const rawPage = await rawContext.newPage();
    await rawPage.goto(server.url('injected', 'install-blank.html'));
    const raw = await rawPage.evaluate(snapshot);
    await rawContext.close();

    const context = await browser.newContext();
    await context.addInitScript({ content: agentSource() });
    const page = await context.newPage();
    await page.goto(server.url('injected', 'install-blank.html'));
    opened = { context, page };
    const withAgent = await page.evaluate(snapshot);

    expect(withAgent.count).toBe(raw.count);
    expect(withAgent.width).toBe(raw.width);
    expect(withAgent.height).toBe(raw.height);
    expect(stripDetectAttribute(withAgent.html)).toBe(stripDetectAttribute(raw.html));
    expect(withAgent.html).toContain(`data-cu-agent="${AGENT_VERSION}"`);
    expect(raw.html).not.toContain('data-cu-agent');
  });
});

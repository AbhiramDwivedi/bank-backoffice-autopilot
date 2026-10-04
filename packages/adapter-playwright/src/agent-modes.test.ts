/**
 * Browser-agent integration modes: the driver's own injection vs. an app that ships
 * `@cu/browser-agent` itself as a `<script>` tag (`agent-mode-plain.html` / `agent-mode-tag.html`,
 * identical except for that tag). See docs/design/browser-agent.md and inpage.ts's module header.
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AGENT_VERSION, compareAgentVersions } from '@cu/browser-agent';
import type { HumanAction } from '@cu/core/schema';
import { AgentVersionError, detectAgent, ensureAgent } from './inpage.js';
import { createPlaywrightSurface, type AgentModeDetail, type PlaywrightSurface, type PlaywrightSurfaceOptions } from './surface.js';
import { NEXT_MAJOR_VERSION, startFixtureServer, type FixtureServer } from './test-helpers.js';

let browser: Browser;
let fixtures: FixtureServer;
const surfaces: PlaywrightSurface[] = [];

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  fixtures = await startFixtureServer();
});

afterAll(async () => {
  await browser.close();
  await fixtures.close();
});

afterEach(async () => {
  while (surfaces.length > 0) {
    const s = surfaces.pop()!;
    await s.close().catch(() => undefined);
  }
});

async function newSurface(opts: PlaywrightSurfaceOptions = {}): Promise<PlaywrightSurface> {
  const surface = await createPlaywrightSurface({ browser, baseUrl: fixtures.baseUrl, ...opts });
  surfaces.push(surface);
  return surface;
}

describe('browser-agent injection mode (app does not ship the tag)', () => {
  it('installs and detects the driver-injected agent', async () => {
    const surface = await newSurface();
    const nav = await surface.act({ type: 'navigate', url: fixtures.url('agent-mode-plain.html') }, 5000);
    expect(nav.ok).toBe(true);
    await surface.observe();

    const detection = await detectAgent(surface.page.mainFrame());
    expect(detection.present).toBe(true);
    expect(detection.source).toBe('injected');
    expect(detection.version).toBe(AGENT_VERSION);
    expect(detection.compatible).toBe(true);
    expect(detection.replacedVersion).toBeUndefined();
  });
});

describe('browser-agent app-included mode (app ships the tag itself)', () => {
  it('detects source "app", installs exactly one agent instance, and leaves no trace on window', async () => {
    const surface = await newSurface();
    const consoleWarnings: string[] = [];
    surface.page.on('console', (msg) => {
      if (msg.type() === 'warning' || msg.type() === 'error') consoleWarnings.push(msg.text());
    });

    const nav = await surface.act({ type: 'navigate', url: fixtures.url('agent-mode-tag.html') }, 5000);
    expect(nav.ok).toBe(true);
    await surface.observe();

    const detection = await detectAgent(surface.page.mainFrame());
    expect(detection.present).toBe(true);
    expect(detection.source).toBe('app');
    expect(detection.version).toBe(AGENT_VERSION);

    const check = await surface.page.evaluate(() => {
      const K = Symbol.for('cu-agent.driver');
      const state = (window as unknown as Record<symbol, { agent: unknown } | undefined>)[K];
      return {
        singleInstance: !!state && state.agent === window.__cuAgent,
        datasetVersion: document.documentElement.dataset.cuAgent,
        hasOwnEnumerableKey: Object.keys(window).includes('__cuAgent'),
      };
    });
    expect(check.singleInstance).toBe(true);
    expect(check.datasetVersion).toBe(AGENT_VERSION);
    expect(check.hasOwnEnumerableKey).toBe(false);
    expect(consoleWarnings.filter((w) => w.includes('[cu-agent]'))).toHaveLength(0);
  });

  it('produces observe() output identical to the tag-less fixture (elements, textDigest, frame paths)', async () => {
    const plain = await newSurface();
    const tagged = await newSurface();

    await plain.act({ type: 'navigate', url: fixtures.url('agent-mode-plain.html') }, 5000);
    await tagged.act({ type: 'navigate', url: fixtures.url('agent-mode-tag.html') }, 5000);

    const obsPlain = await plain.observe();
    const obsTagged = await tagged.observe();

    expect(obsTagged.textDigest).toBe(obsPlain.textDigest);
    expect(obsTagged.frames.map((f) => f.path)).toEqual(obsPlain.frames.map((f) => f.path));

    // Compare everything except `ref`, which is just an observation-local counter (e1, e2, ...)
    // and is expected to match anyway since both fixtures enumerate the same elements in the
    // same order.
    const project = (els: typeof obsPlain.elements) =>
      els.map((e) => ({ role: e.role, name: e.name, text: e.text, tag: e.tag, value: e.value, bbox: e.bbox, frame: e.frame, enabled: e.enabled, descriptor: e.descriptor }));
    expect(project(obsTagged.elements)).toEqual(project(obsPlain.elements));
  });

  it('reports onAgentDetected exactly once per surface, with source "app"', async () => {
    const details: AgentModeDetail[] = [];
    const surface = await newSurface({ onAgentDetected: (d) => details.push(d) });

    await surface.act({ type: 'navigate', url: fixtures.url('agent-mode-tag.html') }, 5000);
    await surface.observe();
    await surface.observe();
    await surface.resolve(
      { description: 'go button', frame: [], locators: [{ strategy: { kind: 'css', selector: '#go' }, confidence: 0.5, source: 'recorded' as const }] },
      1000,
    );

    expect(details).toHaveLength(1);
    expect(details[0]?.browserAgent.source).toBe('app');
    expect(details[0]?.browserAgent.present).toBe(true);
    expect(details[0]?.browserAgent.version).toBe(AGENT_VERSION);
    expect(surface.agentDetection).toEqual(details[0]);
  });

  it('captures human actions through the binding, never a typed value, with no duplicate navigate records', async () => {
    const surface = await newSurface();
    await surface.act({ type: 'navigate', url: fixtures.url('agent-mode-tag.html') }, 5000);

    const actions: HumanAction[] = [];
    await surface.humanCapture.start((a) => actions.push(a));

    await surface.page.click('#go');
    await expect.poll(() => actions.some((a) => a.type === 'click')).toBe(true);

    await surface.page.fill('#name', 'super-secret-value');
    await expect.poll(() => actions.some((a) => a.type === 'input')).toBe(true);

    await surface.page.press('#name', 'Enter');
    await expect.poll(() => actions.some((a) => a.type === 'keypress')).toBe(true);

    const input = actions.find((a) => a.type === 'input');
    expect(input?.valueRedacted).toBe(true);
    const keypress = actions.find((a) => a.type === 'keypress');
    // @cu/browser-agent's capture stamps valueRedacted: true on every record, not just input's.
    expect(keypress?.valueRedacted).toBe(true);
    expect(keypress?.key).toBe('Enter');
    expect(JSON.stringify(actions)).not.toContain('super-secret-value');

    const navCountBefore = actions.filter((a) => a.type === 'navigate').length;
    const nav2 = await surface.act({ type: 'navigate', url: fixtures.url('agent-mode-tag.html') }, 5000);
    expect(nav2.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 300));
    expect(actions.filter((a) => a.type === 'navigate').length).toBe(navCountBefore + 1);
  });
});

describe('browser-agent pre-attach reuse', () => {
  it('reuses an already-installed app agent instead of injecting a second one', async () => {
    const bareContext = await browser.newContext();
    try {
      const page = await bareContext.newPage();
      await page.goto(fixtures.url('agent-mode-tag.html'));
      await page.evaluate(() => {
        (window as unknown as { __probe?: unknown }).__probe = window.__cuAgent;
      });

      const surface = await createPlaywrightSurface({ page });
      try {
        await surface.observe();

        const sameInstance = await page.evaluate(() => window.__cuAgent === (window as unknown as { __probe?: unknown }).__probe);
        expect(sameInstance).toBe(true);

        const detection = await detectAgent(page.mainFrame());
        expect(detection.source).toBe('app');
        expect(detection.present).toBe(true);
      } finally {
        await surface.close();
      }
    } finally {
      await bareContext.close();
    }
  });
});

describe('browser-agent of another major shipped by the app', () => {
  it('the driver replaces it with its own copy before use, and reports what it replaced', async () => {
    const details: AgentModeDetail[] = [];
    const surface = await newSurface({ onAgentDetected: (d) => details.push(d) });
    const nav = await surface.act({ type: 'navigate', url: fixtures.url('agent-mode-next-major.html') }, 5000);
    expect(nav.ok).toBe(true);

    // The surface's one-time detection ran right after navigate. The app's own tag had replaced
    // the driver's init-script copy (another major), so detection first put the driver's copy
    // back: the record describes the agent the driver uses, and names the app's version it replaced.
    expect(details).toHaveLength(1);
    expect(details[0]?.browserAgent).toMatchObject({
      source: 'injected',
      version: AGENT_VERSION,
      compatible: true,
      replacedVersion: NEXT_MAJOR_VERSION,
    });
    expect(details[0]?.browserAgent.frames).toEqual([{ frame: [], source: 'injected', compatible: true }]);
    expect(await surface.page.evaluate(() => window.__cuAgent?.version)).toBe(AGENT_VERSION);

    const obs = await surface.observe();
    expect(obs.elements.some((e) => e.tag === 'button' && e.name === 'Go')).toBe(true);
    expect(await surface.page.evaluate(() => window.__cuAgent?.version)).toBe(AGENT_VERSION);

    const detection = await detectAgent(surface.page.mainFrame());
    expect(detection).toMatchObject({ present: true, version: AGENT_VERSION, source: 'injected', compatible: true, replacedVersion: NEXT_MAJOR_VERSION });
    expect(surface.agentDetection).toEqual(details[0]);

    // A compatible agent is left alone: ensureAgent does not evaluate the bundle again.
    await surface.page.evaluate(() => {
      (window as unknown as { __probe?: unknown }).__probe = window.__cuAgent;
    });
    await ensureAgent(surface.page.mainFrame());
    await surface.observe();
    expect(await surface.page.evaluate(() => window.__cuAgent === (window as unknown as { __probe?: unknown }).__probe)).toBe(true);
  });

  it('detection reports compatible:false for an app copy of another major the driver has not replaced yet', async () => {
    const bareContext = await browser.newContext();
    try {
      const page = await bareContext.newPage();
      await page.goto(fixtures.url('agent-mode-next-major.html'));
      const detection = await detectAgent(page.mainFrame());
      expect(detection).toMatchObject({ present: true, version: NEXT_MAJOR_VERSION, source: 'app', compatible: false });
    } finally {
      await bareContext.close();
    }
  });

  it('ensureAgent throws AgentVersionError when the page pins an agent of another major', async () => {
    const bareContext = await browser.newContext();
    try {
      const page = await bareContext.newPage();
      await page.goto(fixtures.url('agent-mode-plain.html'));
      await page.evaluate((v) => {
        Object.defineProperty(window, '__cuAgent', { value: { version: v }, writable: false, configurable: false });
      }, NEXT_MAJOR_VERSION);
      const err = await ensureAgent(page.mainFrame()).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(AgentVersionError);
      expect((err as AgentVersionError).installedVersion).toBe(NEXT_MAJOR_VERSION);
      expect((await detectAgent(page.mainFrame())).compatible).toBe(false);
    } finally {
      await bareContext.close();
    }
  });

  it('observe() fails with AgentVersionError instead of returning an empty observation', async () => {
    const bareContext = await browser.newContext();
    try {
      const page = await bareContext.newPage();
      await page.goto(fixtures.url('agent-mode-plain.html'));
      await page.evaluate((v) => {
        Object.defineProperty(window, '__cuAgent', { value: { version: v }, writable: false, configurable: false });
      }, NEXT_MAJOR_VERSION);
      const surface = await createPlaywrightSurface({ page });
      try {
        const err = await surface.observe().then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(AgentVersionError);
        expect((err as AgentVersionError).installedVersion).toBe(NEXT_MAJOR_VERSION);
        expect((err as AgentVersionError).frameUrl).toBe(fixtures.url('agent-mode-plain.html'));
      } finally {
        await surface.close();
      }
    } finally {
      await bareContext.close();
    }
  });
});

describe('an older browser-agent of the same major already in the page', () => {
  const OLDER_VERSION = '1.0.0';

  /** A page that loaded before the driver attached, holding an app's 1.0.0 agent: it has no `lib.findAdjacentCellControls`. */
  async function pageWithOlderAgent(opts: { pinned?: boolean } = {}): Promise<{ page: Page; context: BrowserContext }> {
    expect(AGENT_VERSION.split('.')[0]).toBe(OLDER_VERSION.split('.')[0]);
    expect(compareAgentVersions(OLDER_VERSION, AGENT_VERSION)).toBeLessThan(0);
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(fixtures.url('resolve-search.html'));
    await page.evaluate(
      ([v, pinned]) => {
        const lib = Object.freeze({ collapse: (s: unknown) => String(s) });
        const agent = Object.freeze({ version: v, lib, enumerate: () => ({ data: [], els: [], viewport: { width: 1, height: 1 }, bodyText: '' }) });
        Object.defineProperty(window, '__cuAgent', { value: agent, writable: !pinned, configurable: !pinned, enumerable: false });
      },
      [OLDER_VERSION, opts.pinned === true] as const,
    );
    return { page, context };
  }

  const labelTarget = {
    description: 'Member ID field',
    frame: [],
    locators: [{ strategy: { kind: 'label' as const, label: 'Member ID' }, confidence: 0.8, source: 'recorded' as const }],
  };

  it('is replaced by the driver copy, so the adjacent-cell label strategy still resolves', async () => {
    const { page, context } = await pageWithOlderAgent();
    try {
      const details: AgentModeDetail[] = [];
      const surface = await createPlaywrightSurface({ page, onAgentDetected: (d) => details.push(d) });
      try {
        const r = await surface.resolve(labelTarget, 5000);
        expect(r.found).toBe(true);
        if (!r.found) return;
        expect(r.strategyKind).toBe('label');
        expect(await page.evaluate(() => window.__cuAgent?.version)).toBe(AGENT_VERSION);
        expect(await page.evaluate(() => typeof window.__cuAgent?.lib.findAdjacentCellControls)).toBe('function');

        expect(details).toHaveLength(1);
        expect(details[0]?.browserAgent).toMatchObject({ source: 'injected', version: AGENT_VERSION, compatible: true, replacedVersion: OLDER_VERSION });
      } finally {
        await surface.close();
      }
    } finally {
      await context.close();
    }
  });

  it('detection reports an older agent the driver has not replaced yet as not compatible', async () => {
    const { page, context } = await pageWithOlderAgent();
    try {
      expect(await detectAgent(page.mainFrame())).toMatchObject({ present: true, version: OLDER_VERSION, compatible: false });
    } finally {
      await context.close();
    }
  });

  it('ensureAgent throws AgentVersionError when the page pins the older agent', async () => {
    const { page, context } = await pageWithOlderAgent({ pinned: true });
    try {
      const err = await ensureAgent(page.mainFrame()).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(AgentVersionError);
      expect((err as AgentVersionError).installedVersion).toBe(OLDER_VERSION);
    } finally {
      await context.close();
    }
  });
});

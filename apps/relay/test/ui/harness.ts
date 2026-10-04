/**
 * Shared setup for Relay's browser-driven UI tests (`relay.browser.test.ts`).
 *
 * Builds the real UI bundle once per test file (`buildUi`, unminified) into a temp directory, then
 * hands each test a fresh `startRelayServer` (port 0, `staticDir` pointing at that bundle) and a
 * fresh playwright `Page`. Registers its own `beforeAll`/`afterEach`/`afterAll` hooks so importing
 * `createHarness()` and calling it once at module scope of the test file is enough to get cleanup
 * for free (tracked arrays, emptied after each test).
 *
 * Also renders a small legacy-cu-core-looking screenshot (grey toolbar, "Member Inquiry" header,
 * a red access-denied banner, a few labelled fields) for tests that want a realistic escalation /
 * live screenshot, and saves one copy to `test/support/cu-core-sample.png` the first time this
 * runs (skipped if that file already exists -- it's a checked-in-adjacent fixture, not something
 * to rewrite on every run).
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll } from 'vitest';
import type { Browser, Page } from 'playwright';
import { buildUi } from '../../scripts/build.js';
import { startRelayServer } from '../../src/server/index.js';
import type { BrokerFixture } from '../support/fixtures.js';
import type { SessionBroker } from '../support/core-testing.js';

const SAMPLE_FIXTURE_PATH = fileURLToPath(new URL('../support/cu-core-sample.png', import.meta.url));
const TEST_RESULTS_DIR = fileURLToPath(new URL('../../test-results/', import.meta.url));

/** Resolves a path under `apps/relay/test-results/`, creating the directory on first use. */
export function testResultsPath(filename: string): string {
  mkdirSync(TEST_RESULTS_DIR, { recursive: true });
  return path.join(TEST_RESULTS_DIR, filename);
}

// ---- A realistic cu-core-looking screenshot --------------------------------------------------

const CU_CORE_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  html, body { margin: 0; padding: 0; }
  body {
    font-family: Tahoma, "MS Sans Serif", Arial, sans-serif;
    font-size: 13px;
    color: #1a1a1a;
    background: #d4d0c8;
  }
  .titlebar { background: #000080; color: #fff; padding: 4px 10px; font-weight: bold; }
  .toolbar { background: #808080; color: #f0f0f0; padding: 5px 10px; border-bottom: 2px solid #404040; letter-spacing: 2px; }
  .content { padding: 16px; }
  h1 { font-size: 16px; margin: 0 0 10px; border-bottom: 1px solid #999; padding-bottom: 6px; }
  .denied {
    color: #b00000;
    font-weight: bold;
    background: #fff0f0;
    border: 1px solid #b00000;
    padding: 8px 12px;
    margin: 10px 0 16px;
    max-width: 560px;
  }
  table.fields { border-collapse: collapse; background: #ece9d8; }
  table.fields td { border: 1px solid #999; padding: 4px 10px; }
  table.fields td.label { font-weight: bold; width: 150px; background: #dcd9cd; }
</style>
</head>
<body>
  <div class="titlebar">CU-CORE &mdash; Member Services</div>
  <div class="toolbar">File&nbsp;&nbsp;Edit&nbsp;&nbsp;Member&nbsp;&nbsp;Accounts&nbsp;&nbsp;Reports&nbsp;&nbsp;Help</div>
  <div class="content">
    <h1>Member Inquiry</h1>
    <div class="denied">Access Denied: your role does not permit viewing this member.</div>
    <table class="fields">
      <tr><td class="label">Member ID</td><td>90001</td></tr>
      <tr><td class="label">Member Name</td><td>&mdash;</td></tr>
      <tr><td class="label">Branch</td><td>&mdash;</td></tr>
      <tr><td class="label">Status</td><td>RESTRICTED</td></tr>
    </table>
  </div>
</body>
</html>`;

/** Renders the fixture page above at 1280x800 and returns its PNG bytes. */
export async function renderCuCoreScreenshot(browser: Browser): Promise<Buffer> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  try {
    await page.setContent(CU_CORE_HTML, { waitUntil: 'load' });
    return await page.screenshot();
  } finally {
    await page.close();
  }
}

// ---- Small polling / navigation helpers -------------------------------------------------------

/** Polls `check` until it returns true, or throws once `timeoutMs` elapses. */
export async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5000, intervalMs = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() >= deadline) throw new Error(`waitFor: condition not satisfied within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Navigates to Relay and waits for the SSE connection indicator to report `live`. */
export async function openRelay(page: Page, url: string, timeoutMs = 10000): Promise<void> {
  await page.goto(url);
  await waitFor(async () => (await page.getAttribute('#conn-status', 'data-state')) === 'live', timeoutMs);
}

/** Clicks every toast's dismiss button until `#toasts` is empty, for a clean "resting state" screenshot. */
export async function dismissAllToasts(page: Page, timeoutMs = 3000): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const btn = page.locator('.toast button[aria-label="Dismiss notification"]').first();
    if ((await btn.count()) === 0) break;
    await btn.click();
  }
  await waitFor(async () => (await page.locator('#toasts .toast').count()) === 0, timeoutMs);
}

/** Counts POSTs to `/api/interventions/:id/heartbeat` seen by this page from here on. */
export function countHeartbeatRequests(page: Page): { count(): number } {
  let n = 0;
  page.on('request', (req) => {
    if (req.method() !== 'POST') return;
    if (/\/api\/interventions\/[^/]+\/heartbeat$/.test(new URL(req.url()).pathname)) n += 1;
  });
  return { count: () => n };
}

// ---- The harness itself ------------------------------------------------------------------------

export interface RelayServerHandle {
  url: string;
  port: number;
  register(broker: SessionBroker): void;
  unregister(runId: string): void;
  close(): Promise<void>;
}

export interface StartServerOptions {
  brokers?: SessionBroker[];
  leaseMs?: number;
}

export interface RelayHarness {
  /** The built UI bundle's directory. Only valid once `beforeAll` has run (i.e. inside a test). */
  outdir(): string;
  /** A playwright Page tracked for automatic close() in afterEach. */
  newPage(browser: Browser): Promise<Page>;
  /** A relay server (port 0) serving the built UI, tracked for automatic close() in afterEach. */
  startServer(opts?: StartServerOptions): Promise<RelayServerHandle>;
  /** Registers a BrokerFixture for automatic dispose() in afterEach. Returns it unchanged. */
  trackFixture<T extends BrokerFixture>(fixture: T): T;
}

export interface CreateHarnessOptions {
  /** Lazily read so the test file's module-level chromium launch (which runs first) is visible. */
  getBrowser: () => Browser | undefined;
}

export function createHarness(opts: CreateHarnessOptions): RelayHarness {
  let uiOutdir: string | undefined;
  let stopUi: (() => Promise<void>) | undefined;
  const pages: Page[] = [];
  const servers: RelayServerHandle[] = [];
  const fixtures: BrokerFixture[] = [];

  beforeAll(async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'relay-ui-'));
    const built = await buildUi({ outdir: dir, minify: false });
    uiOutdir = built.outdir;
    stopUi = built.stop;

    // Save one copy of the sample screenshot for the dev harness to reuse, the first time this runs.
    const browser = opts.getBrowser();
    if (browser !== undefined && !existsSync(SAMPLE_FIXTURE_PATH)) {
      const png = await renderCuCoreScreenshot(browser);
      writeFileSync(SAMPLE_FIXTURE_PATH, png);
    }
  });

  afterEach(async () => {
    await Promise.all(pages.splice(0).map((p) => p.close().catch(() => undefined)));
    await Promise.all(servers.splice(0).map((s) => s.close().catch(() => undefined)));
    for (const fixture of fixtures.splice(0)) fixture.dispose();
  });

  afterAll(async () => {
    await stopUi?.();
  });

  return {
    outdir() {
      if (uiOutdir === undefined) throw new Error('relay harness: UI is not built yet (beforeAll has not completed)');
      return uiOutdir;
    },
    async newPage(browser) {
      const page = await browser.newPage();
      pages.push(page);
      return page;
    },
    async startServer(o = {}) {
      if (uiOutdir === undefined) throw new Error('relay harness: UI is not built yet (beforeAll has not completed)');
      const handle = await startRelayServer({
        port: 0,
        staticDir: uiOutdir,
        brokers: o.brokers ?? [],
        ...(o.leaseMs !== undefined ? { leaseMs: o.leaseMs } : {}),
      });
      servers.push(handle);
      return handle;
    },
    trackFixture(fixture) {
      fixtures.push(fixture);
      return fixture;
    },
  };
}

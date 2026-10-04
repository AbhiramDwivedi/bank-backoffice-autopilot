/**
 * Recording stage of the explainer-video pipeline: produces one or more video segments for every
 * clip in tools/video/script.md and writes SEGMENTS_MANIFEST. See docs at the top of the other
 * tools/video/lib modules for the per-clip content rules (README, docs/design/handoff.md).
 *
 * Runnable directly: `npx tsx tools/video/record.ts`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Frame, type Page } from 'playwright';

import { parseScript, REPO_ROOT, BUILD_DIR, type Clip } from './lib/script.js';
import { SEGMENTS_MANIFEST, VIDEO_OUT_DIR, VIDEO_BASE_URL, VIDEO_PORTS, VIDEO_RUNS_DIR, VIDEO_POLICY, WIDTH, HEIGHT } from './lib/contracts.js';
import type { Segment, SegmentsManifest } from './lib/contracts.js';
import { sleep, runBatched, escapeHtml } from './lib/util.js';
import { maskAndVerify } from './lib/masker.js';
import { requiredMsFor, usingRealNarration } from './lib/narration.js';
import { resetMockApp, setFaults } from './lib/mockapp.js';
import { runCli, runVitest, type ProcResult } from './lib/proc.js';
import { renderTerminalSegment, type TerminalDoc } from './lib/terminal.js';
import { renderSlide, slidesHtmlExists, SLIDES_HTML_PATH } from './lib/slides.js';
import { setCaption } from './lib/caption.js';
import { ensureVideoPolicy, policyExcerpt, type PolicyExcerptBlock } from './lib/policy-file.js';
import { markupExcerpts, agentTagExcerpt, type MarkupExcerpt } from './lib/markup.js';
import { readInterventionExcerpt, grepEvents, findBrowserAgentEvent, readEvidenceReadmeSection, type BrowserAgentEvent } from './lib/evidence.js';

import { loadEnv } from '@cu/cli/env';
import { runReplay } from '@cu/cli/runtime';
import { createPlaywrightSurface } from '@cu/adapter-playwright';
import { formatElementLine } from '@cu/core/agent';
import { printReplayResult } from '@cu/cli/print-result';
import type { ReplayResult } from '@cu/core/schema';

// -------------------------------------------------------------------------------------------
// small local helpers
// -------------------------------------------------------------------------------------------

/**
 * The model-recorded, approved capability every replay-driven clip in this video uses: discovered
 * once, reviewed, and committed (approved 1.2.2), so the video is reproducible from a real run
 * rather than a hand-maintained example. `artifacts/examples/lookup-member-savings-balance.
 * example.json` is a separate, static reference copy for documentation, not this run's capability.
 */
function resolveArtifactPath(): string {
  return path.join(REPO_ROOT, 'artifacts', 'lookup-member-savings-balance.json');
}

/** Screenshots-for-review land here (gitignored under tools/video/.build/); segment video itself
 *  never reads from this directory. */
const STILLS_DIR = path.join(BUILD_DIR, 'stills');

/** Saves a PNG still of `page`'s current state for human review; never fails the recording. */
async function stillShot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(STILLS_DIR, { recursive: true });
  await page.screenshot({ path: path.join(STILLS_DIR, `${name}.png`) }).catch((err: unknown) => {
    console.warn(`stillShot(${name}) failed: ${err instanceof Error ? err.message : String(err)}`);
  });
}

function capOutput(s: string, max = 1600): string {
  return s.length > max ? `${s.slice(0, max - 1)}\u2026` : s;
}

function extractRunDir(output: string): string {
  const m = /run dir: (.+)/.exec(output);
  if (!m) throw new Error(`could not find "run dir:" in CLI output: ${output.slice(0, 300)}`);
  return m[1]!.trim();
}

/** Captures console.log output produced while `fn` runs (used to show printReplayResult's real
 *  output in the term:handoff-result clip). */
function captureConsoleLog(fn: () => void): string {
  const original = console.log;
  const lines: string[] = [];
  console.log = ((...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(' '));
  }) as typeof console.log;
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines.join('\n');
}

const MAX_DESCRIPTION_CHARS = 220;

/** Truncates long `description` string fields (deep) so the pretty-printed artifact stays
 *  scannable while scrolling; every other field is shown in full. */
function truncateLongDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(truncateLongDescriptions);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === 'description' && typeof v === 'string' && v.length > MAX_DESCRIPTION_CHARS) {
        out[k] = `${v.slice(0, MAX_DESCRIPTION_CHARS)}\u2026`;
      } else {
        out[k] = truncateLongDescriptions(v);
      }
    }
    return out;
  }
  return value;
}

function prettyArtifact(): string {
  const raw = JSON.parse(fs.readFileSync(resolveArtifactPath(), 'utf8')) as unknown;
  return JSON.stringify(truncateLongDescriptions(raw), null, 2);
}

async function waitForFrame(page: Page, name: string, timeoutMs = 5000): Promise<Frame> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const f = page.frame({ name });
    if (f) return f;
    if (Date.now() > deadline) throw new Error(`frame "${name}" did not appear within ${timeoutMs}ms`);
    await sleep(100);
  }
}

async function newRecordedContext(browser: Browser, opts: { baseUrl?: string } = {}) {
  return browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    recordVideo: { dir: VIDEO_OUT_DIR, size: { width: WIDTH, height: HEIGHT } },
    ...(opts.baseUrl ? { baseURL: opts.baseUrl } : {}),
  });
}

// -------------------------------------------------------------------------------------------
// live:app-tour (c04)
// -------------------------------------------------------------------------------------------

async function recordAppTour(browser: Browser, requiredMs: number): Promise<Segment> {
  const created = Date.now();
  const context = await newRecordedContext(browser, { baseUrl: VIDEO_BASE_URL });
  const page = await context.newPage();

  await page.goto('/login', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[name=userId]');
  const trimStartMs = Date.now() - created;

  const user = process.env.MOCK_USER ?? 'operator1';
  const password = process.env.MOCK_PASSWORD ?? 'demo-pass-123';

  await setCaption(page, '1998-era login table \u2014 label sits in the adjacent <td>, no <label>');
  await sleep(1800);
  await page.locator('input[name=userId]').pressSequentially(user, { delay: 70 });
  await page.locator('input[name=password]').pressSequentially(password, { delay: 70 });
  await setCaption(page, 'Signing on');
  await sleep(400);
  await page.click('input[name=login]');
  await page.waitForURL(/\/workstation$/, { timeout: 10000 });

  const main = await waitForFrame(page, 'main');
  await setCaption(page, 'Frameset shell: banner / nav / main frames');
  await sleep(1600);

  await main
    .getByText('System Maintenance Notice')
    .first()
    .waitFor({ timeout: 5000 })
    .catch(() => undefined);
  await setCaption(page, 'Maintenance notice \u2014 shown once per session');
  await sleep(1800);
  const okBtn = main.locator('div.maint-ok');
  if ((await okBtn.count()) > 0) await okBtn.click();

  await setCaption(page, 'Member search');
  await sleep(500);
  await main.locator('input[name=memberId]').fill('12345');
  await main.locator('div.btn[onclick^="doSearch"]').click();
  await main
    .getByText('record(s) found')
    .first()
    .waitFor({ timeout: 10000 });
  await sleep(1400);

  await setCaption(page, 'Opening member 12345 \u2014 a <tr onclick>, not a link');
  await main.locator('tr[onclick*="/members/12345"]').click();
  await main.waitForURL(/\/members\/12345/, { timeout: 10000 });
  await sleep(1200);

  await setCaption(page, 'Profile tab');
  await sleep(900);
  await main.locator('#tabAccounts').click();
  await setCaption(page, 'Accounts tab \u2014 bare <span onclick>, no ARIA role');
  await sleep(1500);
  await main.locator('#tabNotes').click();
  await setCaption(page, 'Notes tab');
  await sleep(1200);
  await main.locator('#tabProfile').click();
  await setCaption(page, 'Back to profile');

  const elapsed = Date.now() - created;
  const remaining = Math.max(500, trimStartMs + requiredMs - elapsed);
  await sleep(remaining);

  await context.close();
  const file = await page.video()!.path();
  return { clipId: 'c04', file, trimStartMs, durationMs: requiredMs };
}

// -------------------------------------------------------------------------------------------
// live:observe (c06)
// -------------------------------------------------------------------------------------------

function buildObserveHtml(opts: { title: string; screenshotB64: string; elementLines: string[]; url: string }): string {
  const MAX_ROWS = 26;
  const shown = opts.elementLines.slice(0, MAX_ROWS);
  if (opts.elementLines.length > MAX_ROWS) shown.push(`\u2026 (${opts.elementLines.length - MAX_ROWS} more not shown)`);
  const rows = shown.map((l) => `<div class="row">${escapeHtml(l)}</div>`).join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(opts.title)}</title>
<style>
  html,body{margin:0;padding:0;width:${WIDTH}px;height:${HEIGHT}px;overflow:hidden;background:#0b0e11;color:#e8edf2;font-family:system-ui,Segoe UI,sans-serif;}
  header{padding:14px 22px;background:#1b2430;border-bottom:1px solid #2a3542;font-size:20px;font-weight:700;}
  .wrap{position:absolute;top:56px;left:0;right:0;bottom:0;display:flex;}
  .left{flex:0 0 55%;display:flex;align-items:center;justify-content:center;background:#0f1419;border-right:1px solid #2a3542;padding:10px;}
  .left img{max-width:100%;max-height:100%;border:1px solid #2a3542;}
  .right{flex:1;min-width:0;overflow:hidden;padding:14px 18px;font-family:Consolas,"Cascadia Mono",monospace;font-size:14px;line-height:1.5;}
  .right .url{color:#7d8a97;margin-bottom:8px;font-size:13px;}
  .row{white-space:pre-wrap;word-break:break-word;border-bottom:1px dashed #2a3542;padding:2px 0;}
</style></head>
<body>
<header>${escapeHtml(opts.title)}</header>
<div class="wrap">
  <div class="left"><img src="data:image/png;base64,${opts.screenshotB64}"></div>
  <div class="right"><div class="url">url: ${escapeHtml(opts.url)}</div>${rows}</div>
</div>
<script>document.body.dataset.ready='1';</script>
</body></html>`;
}

async function recordObserve(browser: Browser, requiredMs: number): Promise<Segment> {
  const rawContext = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, baseURL: VIDEO_BASE_URL });
  const rawPage = await rawContext.newPage();
  await rawPage.goto('/login', { waitUntil: 'domcontentloaded' });
  const surface = await createPlaywrightSurface({ page: rawPage });
  const observation = await surface.observe();
  await rawContext.close();

  const created = Date.now();
  const context = await newRecordedContext(browser);
  const page = await context.newPage();
  const html = buildObserveHtml({
    title: 'What the model sees: screenshot + element list (login page)',
    // A login page is never on an omit list; an absent screenshot (screen masking) shows as blank.
    screenshotB64: (observation.screenshotPng ?? Buffer.alloc(0)).toString('base64'),
    elementLines: observation.elements.map((e) => maskAndVerify(formatElementLine(e))),
    url: observation.url,
  });
  await page.setContent(html, { waitUntil: 'load' });
  await page
    .waitForSelector('body[data-ready="1"]', { timeout: 5000 })
    .catch(() => undefined);
  const trimStartMs = Date.now() - created;
  await sleep(requiredMs);
  await context.close();
  const file = await page.video()!.path();
  return { clipId: 'c06', file, trimStartMs, durationMs: requiredMs };
}

// -------------------------------------------------------------------------------------------
// live:handoff-escalate / live:handoff-human / live:handoff-resume (c16 / c17 / c18)
// -------------------------------------------------------------------------------------------

interface HandoffOutcome {
  result: ReplayResult;
  runDir: string;
  controlState: string;
  segments: Segment[];
}

/** Recorded in this theme by default (the two reviewer screenshots below cover the other one);
 *  flip this one constant to change which the pipeline records by default. */
const RELAY_THEME: 'light' | 'dark' = 'light';

/** Required picture length (ms) for each of the handoff's three clips. */
interface HandoffReqMs {
  c16: number;
  c17: number;
  c18: number;
}

/** Sleeps until `Date.now() - startMark >= requiredMs`, then returns the new "now". Pads a run of
 *  contiguous segments (no dead gap between them) up to its clip's required picture length, by
 *  holding whatever is currently on screen -- the same idea as recordAppTour's single-segment pad,
 *  generalized to a clip made of several back-to-back cuts. */
async function padTo(startMark: number, requiredMs: number): Promise<number> {
  const target = startMark + requiredMs;
  const now = Date.now();
  if (now < target) await sleep(target - now);
  return Date.now();
}

/** Clicks every visible toast's dismiss button, for a clean screenshot (mirrors apps/relay/test/ui/harness.ts's dismissAllToasts). */
async function dismissToasts(page: Page): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    const btn = page.locator('.toast button[aria-label="Dismiss notification"]').first();
    if ((await btn.count()) === 0) return;
    await btn.click().catch(() => undefined);
    await sleep(120);
  }
}

async function recordHandoff(browser: Browser, reqMs: HandoffReqMs): Promise<HandoffOutcome> {
  await setFaults({ expireSession: true });

  const context = await newRecordedContext(browser, { baseUrl: VIDEO_BASE_URL });

  // ---- pageA: automation (replay), driven by runReplay ------------------------------------
  const tA0 = Date.now();
  const pageA = await context.newPage();
  const surface = await createPlaywrightSurface({ page: pageA });
  await setCaption(pageA, 'Automation (replay) driving the app');

  const capability = JSON.parse(fs.readFileSync(resolveArtifactPath(), 'utf8')) as unknown;
  const logLines: string[] = [];
  const runReplayPromise = runReplay({
    capability,
    inputs: { memberId: '12345' },
    policyPath: VIDEO_POLICY,
    runsDir: VIDEO_RUNS_DIR,
    baseUrl: VIDEO_BASE_URL,
    headless: true,
    autoOperator: 'none',
    operator: { port: VIDEO_PORTS.operator },
    surface,
    log: (line) => logLines.push(line),
  });

  await pageA.waitForSelector('input[name=userId]', { timeout: 15000 });
  const tLoginReady = Date.now();
  await stillShot(pageA, 'handoff-01-login');

  // ---- c16: escalation ----------------------------------------------------------------------
  // Replay escalates a few seconds after the expired page appears (s05's locators have to time
  // out first). pageA stays on screen until Relay actually has the case, so the cut to Relay
  // lands on the queue card rather than on an empty queue.
  await pageA.waitForURL(/\/session-expired$/, { timeout: 20000 });
  const tExpired = Date.now();
  const c16Start = Math.max(tLoginReady, tExpired - 1500);
  await setCaption(pageA, 'Session expired mid run — replay escalates');
  await stillShot(pageA, 'handoff-02-session-expired');

  const tB0 = Date.now();
  const pageB = await context.newPage();
  // Pre-seed the theme this page boots with (topbar.ts / boot.js read `relay.theme` from
  // localStorage) so the recording never shows a theme switch; RELAY_THEME is the one constant to
  // flip to record the other theme by default.
  await pageB.addInitScript((theme: string) => {
    try {
      window.localStorage.setItem('relay.theme', theme);
    } catch {
      /* private window / storage blocked: falls back to the system theme, harmless for recording */
    }
  }, RELAY_THEME);

  const operatorUrl = `http://127.0.0.1:${VIDEO_PORTS.operator}/`;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await pageB.goto(operatorUrl, { waitUntil: 'domcontentloaded' });
      break;
    } catch (err) {
      if (attempt >= 15) throw err;
      await sleep(300);
    }
  }
  await setCaption(pageB, 'Relay — the operator console');
  await pageB.waitForSelector('#conn-status[data-state="live"]', { timeout: 20000 });
  await pageB.locator('#operator-name').fill('ops-reviewer');
  await pageB.locator('#operator-name').blur();

  // Jump cut: 3 s of the expired page, then Relay from the moment the case is queued. The wait
  // in between (automation giving up on s05) is dead time and is left out of the picture.
  const c16PageAEnd = tExpired + 3000;
  const queueCard = pageB.locator('[data-group="open"] .qcard[data-intervention-id]').first();
  await queueCard.waitFor({ timeout: 30000 });
  if (Date.now() < c16PageAEnd) await sleep(c16PageAEnd - Date.now()); // pageA must have recorded up to its cut
  const tBready = Date.now();
  await stillShot(pageB, 'handoff-03-queue');
  await sleep(1200);
  await queueCard.click();
  await pageB.waitForSelector('#state-pill[data-state="paused"]', { timeout: 10000 });
  await pageB.locator('#compare').scrollIntoViewIfNeeded();
  await setCaption(pageB, 'Queued — screenshot and what automation expected');
  await dismissToasts(pageB);
  await stillShot(pageB, 'handoff-04-detail');
  // The detail stays on screen at least 3 s, and the clip lasts at least as long as its narration.
  await sleep(3000);
  const c16End = await padTo(tBready, reqMs.c16 - (c16PageAEnd - c16Start));

  // ---- c17: the operator takes control, re-authenticates, and Relay shows the captured actions
  await setCaption(pageB, 'Taking control');
  await pageB.click('#take-control');
  await pageB.waitForSelector('#state-pill[data-state="mine"]', { timeout: 10000 });
  await stillShot(pageB, 'handoff-05-take-control');
  await dismissToasts(pageB);
  await sleep(900);
  const c17TakeControlEnd = Date.now();

  await setCaption(pageA, 'Human in control — same browser, same cookies');
  await pageA.locator('a:has-text("Click here")').click();
  await pageA.waitForSelector('input[name=userId]', { timeout: 10000 });
  const user = process.env.MOCK_USER ?? 'operator1';
  const password = process.env.MOCK_PASSWORD ?? 'demo-pass-123';
  await pageA.locator('input[name=userId]').pressSequentially(user, { delay: 90 });
  await pageA.locator('input[name=password]').pressSequentially(password, { delay: 90 });
  await sleep(300);
  await pageA.click('input[name=login]');
  await pageA.waitForURL(/\/workstation$/, { timeout: 10000 });
  const main = await waitForFrame(pageA, 'main');
  await main
    .getByText('System Maintenance Notice')
    .first()
    .waitFor({ timeout: 5000 })
    .catch(() => undefined);
  const okBtn = main.locator('div.maint-ok');
  if ((await okBtn.count()) > 0) await okBtn.click();
  await setCaption(pageA, 'Typing the member number');
  await main.locator('input[name=memberId]').fill('12345');
  await stillShot(pageA, 'handoff-06-member-id');
  await sleep(700);
  const c17ReloginEnd = Date.now();

  await setCaption(pageB, 'Captured actions — no values');
  await pageB.locator('#act li.action').first().waitFor({ timeout: 10000 });
  await pageB.locator('#captured').scrollIntoViewIfNeeded();
  await stillShot(pageB, 'handoff-07-captured-actions');
  const c17End = await padTo(c16End, reqMs.c17);

  // ---- reviewer screenshots: light + dark, mid-intervention, captured actions visible --------
  // Taken in the dead time between c17 (ends at c17End) and c18 (starts fresh below), so the
  // theme toggle this needs never lands inside either clip's recorded segment range.
  await dismissToasts(pageB);
  await pageB.locator('#handback-submit').scrollIntoViewIfNeeded();
  fs.mkdirSync(STILLS_DIR, { recursive: true });
  await pageB.screenshot({ path: path.join(STILLS_DIR, 'relay-light.png') });
  await pageB.click('[data-theme-choice="dark"]');
  await pageB.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'dark');
  await dismissToasts(pageB);
  await pageB.screenshot({ path: path.join(STILLS_DIR, 'relay-dark.png') });
  await pageB.click(`[data-theme-choice="${RELAY_THEME}"]`);
  await pageB.waitForFunction((theme) => document.documentElement.getAttribute('data-theme') === theme, RELAY_THEME);

  // ---- c18: hand back, choosing "I completed this step, continue" --------------------------
  // Paced to the narration: the choice is made on screen while "choosing: I completed this step,
  // continue" is spoken, then the cut to pageA shows automation carrying on.
  await dismissToasts(pageB);
  await pageB.locator('#handback-submit').scrollIntoViewIfNeeded();
  await setCaption(pageB, 'Hand back — continue with the next step');
  const c18Start = Date.now();
  await sleep(1000);
  await pageB.check('#resume-next');
  await sleep(500);
  await pageB.locator('#handback-notes').pressSequentially('Logged back in and entered the member number.', { delay: 25 });
  await sleep(500);
  await stillShot(pageB, 'handoff-08-handback');
  await pageB.click('#handback-submit');
  await sleep(500);
  const c18PageAStart = Date.now();

  await setCaption(pageA, 'Automation resumes — next step, same run');
  const runReplayResult = await runReplayPromise;
  await stillShot(pageA, 'handoff-09-result');
  const c18End = await padTo(c18Start, reqMs.c18);

  await context.close();
  const fileA = await pageA.video()!.path();
  const fileB = await pageB.video()!.path();

  if (runReplayResult.result.kind !== 'escalated') {
    throw new Error(`live:handoff: expected result.kind 'escalated', got '${runReplayResult.result.kind}'`);
  }
  if (runReplayResult.result.resolution !== 'resumed_success' || runReplayResult.result.outcome?.kind !== 'success') {
    throw new Error(
      `live:handoff: expected resolution 'resumed_success' with a success outcome, got resolution=${String(runReplayResult.result.resolution)} outcome.kind=${String(runReplayResult.result.outcome?.kind)}`,
    );
  }

  const segments: Segment[] = [
    { clipId: 'c16', file: fileA, trimStartMs: c16Start - tA0, durationMs: c16PageAEnd - c16Start, note: 'automation drives to the expired page' },
    { clipId: 'c16', file: fileB, trimStartMs: tBready - tB0, durationMs: c16End - tBready, note: 'Relay: queue -> detail (screenshot, expected/observed)' },
    { clipId: 'c17', file: fileB, trimStartMs: c16End - tB0, durationMs: c17TakeControlEnd - c16End, note: 'Relay: take control' },
    { clipId: 'c17', file: fileA, trimStartMs: c17TakeControlEnd - tA0, durationMs: c17ReloginEnd - c17TakeControlEnd, note: 'human re-logs in and types the member id' },
    { clipId: 'c17', file: fileB, trimStartMs: c17ReloginEnd - tB0, durationMs: c17End - c17ReloginEnd, note: 'Relay: captured actions (redacted)' },
    { clipId: 'c18', file: fileB, trimStartMs: c18Start - tB0, durationMs: c18PageAStart - c18Start, note: 'Relay: hand back' },
    { clipId: 'c18', file: fileA, trimStartMs: c18PageAStart - tA0, durationMs: c18End - c18PageAStart, note: 'automation finishes to the profile/balance' },
  ];

  return { result: runReplayResult.result, runDir: runReplayResult.runDir, controlState: runReplayResult.controlState, segments };
}

// -------------------------------------------------------------------------------------------
// term:* content -> TerminalDoc builders
// -------------------------------------------------------------------------------------------

function markupDoc(blocks: MarkupExcerpt[]): TerminalDoc {
  return {
    title: 'mock-app views \u2014 real markup',
    mode: 'static',
    blocks: blocks.map((b) => ({ label: b.label, code: maskAndVerify(b.code) })),
  };
}

function artifactDoc(): TerminalDoc {
  return {
    title: 'artifacts/lookup-member-savings-balance.json',
    mode: 'scroll',
    scrollText: maskAndVerify(prettyArtifact()),
    footerNote: 'long description strings truncated with \u2026 to keep it scannable',
  };
}

function tenantDriftDoc(): TerminalDoc {
  const noOverride = readEvidenceReadmeSection('replay-tenant-b-no-override');
  const withOverride = readEvidenceReadmeSection('replay-tenant-b');
  return {
    title: 'evidence/README.md',
    mode: 'static',
    blocks: [
      { label: 'replay-tenant-b-no-override: no override', code: maskAndVerify(noOverride) },
      { label: 'replay-tenant-b: with the hand-authored override', code: maskAndVerify(withOverride) },
    ],
  };
}

function agentTagDoc(tagBlocks: MarkupExcerpt[], event: BrowserAgentEvent): TerminalDoc {
  return {
    title: 'the browser agent \u2014 shipped in the page, detected at runtime',
    mode: 'static',
    blocks: [
      ...tagBlocks.map((b) => ({ label: b.label, code: maskAndVerify(b.code) })),
      // The real line, unmodified: short enough to show whole.
      { label: 'events.jsonl \u2014 detection event (the replay-success run above)', code: maskAndVerify(event.line) },
    ],
  };
}

function cliDoc(titleSuffix: string, r: ProcResult, commandDisplay: string): TerminalDoc {
  return {
    title: `cu replay \u2014 PowerShell (${titleSuffix})`,
    mode: 'typed',
    prompt: 'PS C:\\work\\cu-capability-runtime>',
    command: commandDisplay,
    outputText: maskAndVerify(capOutput(r.combined.trimEnd())),
    exitCode: r.code,
  };
}

function noLlmDoc(r: ProcResult): TerminalDoc {
  return {
    title: 'cu \u2014 PowerShell (replay has no LLM dependency)',
    mode: 'typed',
    prompt: 'PS C:\\work\\cu-capability-runtime>',
    command: 'npx vitest run packages/core/src/replay/no-llm.test.ts',
    outputText: maskAndVerify(capOutput(r.combined.trimEnd())),
    exitCode: r.code,
  };
}

function policyDoc(blocks: PolicyExcerptBlock[]): TerminalDoc {
  return {
    title: 'policies/default.yaml (this video run: ports 4183/4184)',
    mode: 'static',
    blocks: blocks.map((b) => ({ label: b.label, code: maskAndVerify(b.code) })),
  };
}

function handoffResultDoc(handoff: HandoffOutcome): TerminalDoc {
  const printed = captureConsoleLog(() => printReplayResult(handoff.result, handoff.runDir, { json: false }));
  const intervention = readInterventionExcerpt(handoff.runDir);
  const excerpt = {
    status: intervention?.status,
    resolution: intervention?.resolution
      ? {
          by: intervention.resolution.by,
          resumeFrom: intervention.resolution.resumeFrom,
          humanActions: intervention.resolution.humanActions.slice(0, 4),
        }
      : undefined,
  };
  return {
    title: 'cu replay \u2014 result after hand-back',
    mode: 'static',
    blocks: [
      { label: 'printReplayResult(result, runDir)', code: maskAndVerify(printed) },
      { label: `interventions/${String(intervention?.id ?? '<id>')}.json (excerpt)`, code: maskAndVerify(JSON.stringify(excerpt, null, 2)) },
    ],
  };
}

function redactionDoc(handoffRunDir: string, fallbackRunDir: string | undefined): TerminalDoc {
  const fromHandoff = grepEvents(handoffRunDir);
  let redactedLines = fromHandoff.redactedLines;
  let redactedLabel = 'handoff run \u2014 the login user (a bound secret) scrubbed from logged page text';
  if (redactedLines.length === 0 && fallbackRunDir) {
    // The handoff run never logs page text that carries the login user; the app-error run logs the
    // error page, whose banner shows it.
    const fromFallback = grepEvents(fallbackRunDir);
    redactedLines = fromFallback.redactedLines;
    redactedLabel = "app-error run \u2014 the login user (a bound secret) scrubbed from the app's own banner text";
  }
  return {
    title: 'runs-video/<runId>/events.jsonl (excerpt)',
    mode: 'static',
    blocks: [
      { label: redactedLabel, code: maskAndVerify(redactedLines.join('\n\n')) || '(none captured)' },
      {
        label: "handoff run \u2014 the human's typed input: human_action, valueRedacted:true, no value",
        code: maskAndVerify(fromHandoff.humanActionLines.join('\n\n')) || '(none captured)',
      },
    ],
    footerNote: "real lines from this recording run's events.jsonl, shortened with … where long",
  };
}

// -------------------------------------------------------------------------------------------
// main
// -------------------------------------------------------------------------------------------

const SLIDE_NUMBER_OF: Readonly<Record<string, number>> = {
  c01: 1,
  c02: 2,
  c03: 3,
  c07: 4,
  c08: 5,
  c11: 6,
  c15: 7,
  c20: 8,
  c25: 9,
  c26: 10,
};

export async function record(): Promise<void> {
  const t0 = Date.now();
  loadEnv(REPO_ROOT);

  const clips = parseScript();
  const byId = new Map<string, Clip>(clips.map((c) => [c.id, c]));
  const reqMs = (clipId: string): number => {
    const clip = byId.get(clipId);
    if (!clip) throw new Error(`script.md has no clip ${clipId}`);
    return requiredMsFor(clipId, clip.text);
  };

  ensureVideoPolicy();
  fs.mkdirSync(VIDEO_OUT_DIR, { recursive: true });
  fs.mkdirSync(VIDEO_RUNS_DIR, { recursive: true });

  if (!slidesHtmlExists()) {
    console.warn(`warning: ${SLIDES_HTML_PATH} does not exist \u2014 slide clips will fail`);
  }

  const browser = await chromium.launch({ headless: true });
  const segments: Segment[] = [];
  const table: { clipId: string; segments: number; pictureMs: number; requiredMs: number }[] = [];

  /** Records `segs` (which may span several clip ids, e.g. the handoff's three clips) and adds one
   *  table row per clip id they cover. */
  function addSegments(segs: Segment[]): void {
    segments.push(...segs);
    const byClip = new Map<string, Segment[]>();
    for (const s of segs) {
      const arr = byClip.get(s.clipId) ?? [];
      arr.push(s);
      byClip.set(s.clipId, arr);
    }
    for (const [clipId, arr] of byClip) {
      table.push({ clipId, segments: arr.length, pictureMs: arr.reduce((n, s) => n + s.durationMs, 0), requiredMs: reqMs(clipId) });
    }
  }

  try {
    // ---- Phase 1 (background, no mock-app dependency) ----
    const staticContentPromise = (async () => {
      const noLlm = await runVitest(['run', 'packages/core/src/replay/no-llm.test.ts']);
      return { noLlm, markup: markupExcerpts(), policy: policyExcerpt(), agentTag: agentTagExcerpt() };
    })();

    // ---- Phase 2 (sequential: everything touching the shared mock-app instance) ----
    await resetMockApp();
    const appTour = await recordAppTour(browser, reqMs('c04'));
    addSegments([appTour]);

    await resetMockApp();
    const observe = await recordObserve(browser, reqMs('c06'));
    addSegments([observe]);

    const artifactPath = resolveArtifactPath();
    const artifactDisplay = path.relative(REPO_ROOT, artifactPath).replace(/\\/g, '/');
    const commonFlags = `--base-url ${VIDEO_BASE_URL} --runs-dir runs-video --operator-port ${VIDEO_PORTS.operator} --policy tools/video/.build/policy.yaml`;
    const commonArgs = ['--base-url', VIDEO_BASE_URL, '--runs-dir', 'runs-video', '--operator-port', String(VIDEO_PORTS.operator), '--policy', 'tools/video/.build/policy.yaml'];
    const replayCli = (extra: string[]): Promise<ProcResult> => runCli(['replay', artifactPath, ...extra, ...commonArgs]);

    await resetMockApp();
    const success = await replayCli(['--input', 'memberId=12345']);
    const successRunDir = extractRunDir(success.combined);
    // compose.ts only logs the browser-agent detection event when it builds the surface itself,
    // which a plain CLI run (unlike this pipeline's in-process handoff recording) always does.
    const agentEvent = findBrowserAgentEvent(successRunDir);
    if (agentEvent === undefined || agentEvent.source !== 'app') {
      throw new Error(
        `term:agent-tag: expected the success run's events.jsonl (${successRunDir}) to carry a browserAgent detection event with source "app"; got ${
          agentEvent ? JSON.stringify(agentEvent.source) : 'no such event'
        }`,
      );
    }

    await resetMockApp();
    const notfound = await replayCli(['--input', 'memberId=99999']);

    await resetMockApp();
    const apperror = await replayCli(['--input', 'memberId=12345', '--fault', '{"failSearch":true}']);
    let apperrorRunDir: string | undefined;
    try {
      apperrorRunDir = extractRunDir(apperror.combined);
    } catch {
      apperrorRunDir = undefined;
    }

    await resetMockApp();
    const handoff = await recordHandoff(browser, { c16: reqMs('c16'), c17: reqMs('c17'), c18: reqMs('c18') });
    addSegments(handoff.segments);
    await resetMockApp();

    const staticContent = await staticContentPromise;

    // ---- Phase 3 (parallel render batch) ----
    interface Job {
      clipId: string;
      run: () => Promise<Segment>;
    }
    const jobs: Job[] = [];

    for (const [clipId, slideNum] of Object.entries(SLIDE_NUMBER_OF)) {
      jobs.push({ clipId, run: () => renderSlide(browser, clipId, slideNum, reqMs(clipId)) });
    }

    jobs.push({ clipId: 'c05', run: () => renderTerminalSegment(browser, 'c05', markupDoc(staticContent.markup), reqMs('c05')) });
    jobs.push({ clipId: 'c09', run: () => renderTerminalSegment(browser, 'c09', artifactDoc(), reqMs('c09')) });
    jobs.push({ clipId: 'c10', run: () => renderTerminalSegment(browser, 'c10', tenantDriftDoc(), reqMs('c10')) });
    jobs.push({
      clipId: 'c12',
      run: () => renderTerminalSegment(browser, 'c12', cliDoc('member 12345, success', success, `npm run --silent replay -- ${artifactDisplay} --input memberId=12345 ${commonFlags}`), reqMs('c12')),
    });
    jobs.push({
      clipId: 'c13',
      run: () => renderTerminalSegment(browser, 'c13', cliDoc('member not found', notfound, `npm run --silent replay -- ${artifactDisplay} --input memberId=99999 ${commonFlags}`), reqMs('c13')),
    });
    jobs.push({
      clipId: 'c14',
      run: () =>
        renderTerminalSegment(
          browser,
          'c14',
          cliDoc('app error', apperror, `npm run --silent replay -- ${artifactDisplay} --input memberId=12345 --fault '{"failSearch":true}' ${commonFlags}`),
          reqMs('c14'),
        ),
    });
    jobs.push({ clipId: 'c19', run: () => renderTerminalSegment(browser, 'c19', handoffResultDoc(handoff), reqMs('c19')) });
    jobs.push({ clipId: 'c21', run: () => renderTerminalSegment(browser, 'c21', agentTagDoc(staticContent.agentTag, agentEvent), reqMs('c21')) });
    jobs.push({ clipId: 'c22', run: () => renderTerminalSegment(browser, 'c22', policyDoc(staticContent.policy), reqMs('c22')) });
    jobs.push({ clipId: 'c23', run: () => renderTerminalSegment(browser, 'c23', redactionDoc(handoff.runDir, apperrorRunDir), reqMs('c23')) });
    jobs.push({ clipId: 'c24', run: () => renderTerminalSegment(browser, 'c24', noLlmDoc(staticContent.noLlm), reqMs('c24')) });

    const rendered = await runBatched(
      jobs.map((j) => async () => ({ clipId: j.clipId, seg: await j.run() })),
      6,
    );
    for (const r of rendered) addSegments([r.seg]);

    // ---- validate coverage ----
    const covered = new Set(segments.map((s) => s.clipId));
    const missing = clips.filter((c) => !covered.has(c.id));
    if (missing.length > 0) {
      throw new Error(`record(): no segment recorded for clip(s): ${missing.map((c) => c.id).join(', ')}`);
    }

    // ---- order + write manifest ----
    const order = new Map(clips.map((c, i) => [c.id, i]));
    segments.sort((a, b) => (order.get(a.clipId) ?? 0) - (order.get(b.clipId) ?? 0));
    fs.mkdirSync(path.dirname(SEGMENTS_MANIFEST), { recursive: true });
    const manifest: SegmentsManifest = { segments };
    fs.writeFileSync(SEGMENTS_MANIFEST, JSON.stringify(manifest, null, 2));

    // ---- per-clip table ----
    table.sort((a, b) => (order.get(a.clipId) ?? 0) - (order.get(b.clipId) ?? 0));
    console.log('');
    console.log('clip   segments  picture(ms)  required(ms)');
    for (const row of table) {
      console.log(`${row.clipId.padEnd(6)} ${String(row.segments).padStart(8)}  ${String(row.pictureMs).padStart(11)}  ${String(row.requiredMs).padStart(12)}`);
    }
    console.log('');
    console.log(`wrote ${segments.length} segment(s) for ${table.length} clip(s) -> ${SEGMENTS_MANIFEST}`);
    console.log(`narration source: ${usingRealNarration() ? 'real NARRATION_MANIFEST' : '150wpm estimate (narration.json not found yet)'}`);
    const handoffResolution = handoff.result.kind === 'escalated' ? handoff.result.resolution : undefined;
    console.log(`handoff result: kind=${handoff.result.kind} resolution=${String(handoffResolution)} controlState=${handoff.controlState}`);
    console.log(`record() wall time: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  record().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}

/**
 * Test-only stand-in for record.ts: for every clip in the script, records a Playwright
 * recordVideo webm (1280x720, headless Chromium) showing the clip id, segment part, and a
 * running counter for at least minClipMs(narration) ms, and writes a valid SEGMENTS_MANIFEST.
 *
 * Deliberately exercises assemble.ts's edge cases:
 *  - one clip's recording is ~2s short of minClipMs, to exercise the last-frame hold.
 *  - one clip gets two segments instead of one.
 *
 * Requires narrate.ts to have already run (reads NARRATION_MANIFEST for per-clip durations).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright';
import { parseScript } from './lib/script.js';
import { NARRATION_MANIFEST, SEGMENTS_MANIFEST, VIDEO_OUT_DIR, WIDTH, HEIGHT, minClipMs } from './lib/contracts.js';
import type { NarrationManifest, Segment } from './lib/contracts.js';

const SHORT_CLIP_SHORTFALL_MS = 2000;
const CONCURRENCY = 4;

function placeholderHtml(clipId: string, part: number): string {
  return `<!doctype html><html><body style="margin:0;background:#111;color:#0f0;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh;">
<div id="content" style="font-size:56px;text-align:center;">${clipId}<br/>part ${part}<br/><span id="counter">0</span></div>
<span id="ready" style="display:none">ready</span>
<script>
  let n = 0;
  setInterval(() => { n++; const el = document.getElementById('counter'); if (el) el.textContent = String(n); }, 100);
</script>
</body></html>`;
}

async function recordSegment(browser: Browser, clipId: string, part: number, durationMs: number): Promise<Segment> {
  const rawDir = path.join(VIDEO_OUT_DIR, 'raw');
  mkdirSync(rawDir, { recursive: true });
  const context = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    recordVideo: { dir: rawDir, size: { width: WIDTH, height: HEIGHT } },
  });
  const page = await context.newPage();
  const renderStart = Date.now();
  await page.setContent(placeholderHtml(clipId, part));
  await page.waitForSelector('#ready', { state: 'attached' });
  const trimStartMs = Date.now() - renderStart;
  await page.waitForTimeout(durationMs);
  const video = page.video();
  await context.close();
  if (!video) throw new Error(`no video recorded for ${clipId} part ${part}`);
  const tmpPath = await video.path();
  const finalPath = path.join(VIDEO_OUT_DIR, `${clipId}-${part}.webm`);
  renameSync(tmpPath, finalPath);
  return { clipId, file: finalPath, trimStartMs, durationMs };
}

export async function placeholder(): Promise<void> {
  const clips = parseScript();
  if (clips.length === 0) throw new Error('script has no clips');
  if (!existsSync(NARRATION_MANIFEST)) {
    throw new Error(`missing ${NARRATION_MANIFEST}; run narrate.ts before placeholder.ts`);
  }
  const narration = JSON.parse(readFileSync(NARRATION_MANIFEST, 'utf8')) as NarrationManifest;
  const narrById = new Map(narration.clips.map((c) => [c.id, c] as const));

  mkdirSync(VIDEO_OUT_DIR, { recursive: true });

  // Pick two distinct clips (deterministic, not the first) to exercise the edge cases.
  const shortClipId = clips[Math.min(2, clips.length - 1)]!.id;
  const twoSegClipId = clips[Math.min(5, clips.length - 1)]!.id === shortClipId
    ? clips[Math.min(6, clips.length - 1)]!.id
    : clips[Math.min(5, clips.length - 1)]!.id;

  console.log(`short clip (exercises last-frame hold): ${shortClipId}`);
  console.log(`two-segment clip: ${twoSegClipId}`);

  const browser = await chromium.launch({ headless: true });
  const segments: Segment[] = [];

  try {
    for (let i = 0; i < clips.length; i += CONCURRENCY) {
      const batch = clips.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (clip) => {
          const narr = narrById.get(clip.id);
          if (!narr) throw new Error(`no narration for clip ${clip.id}, run narrate.ts first`);
          const targetMs = minClipMs(narr.durationMs);

          if (clip.id === twoSegClipId) {
            const half1 = Math.ceil(targetMs / 2);
            const half2 = targetMs - half1;
            const seg1 = await recordSegment(browser, clip.id, 0, half1);
            const seg2 = await recordSegment(browser, clip.id, 1, half2);
            return [seg1, seg2];
          }
          const recordMs = clip.id === shortClipId ? Math.max(500, targetMs - SHORT_CLIP_SHORTFALL_MS) : targetMs;
          const seg = await recordSegment(browser, clip.id, 0, recordMs);
          return [seg];
        }),
      );
      for (const r of results) segments.push(...r);
      console.log(`recorded ${Math.min(i + CONCURRENCY, clips.length)}/${clips.length} clips`);
    }
  } finally {
    await browser.close();
  }

  mkdirSync(path.dirname(SEGMENTS_MANIFEST), { recursive: true });
  writeFileSync(SEGMENTS_MANIFEST, JSON.stringify({ segments }, null, 2));
  console.log(`wrote ${segments.length} segment(s) for ${clips.length} clip(s) -> ${SEGMENTS_MANIFEST}`);
}

function isMainModule(): boolean {
  return !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  placeholder().catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
}

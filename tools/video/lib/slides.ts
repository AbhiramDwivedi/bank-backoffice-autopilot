/**
 * Records one slide:N clip from tools/video/slides.html (owned by another agent in this
 * pipeline). Loads it via a file:// URL with `?slide=N` and waits for `body[data-ready="1"]`,
 * with a short fixed-grace fallback if that attribute never appears (e.g. an older slides.html).
 */
import path from 'node:path';
import { existsSync } from 'node:fs';
import type { Browser } from 'playwright';
import type { Segment } from './contracts.js';
import { VIDEO_OUT_DIR, WIDTH, HEIGHT } from './contracts.js';
import { VIDEO_DIR } from './script.js';
import { sleep } from './util.js';

export const SLIDES_HTML_PATH = path.join(VIDEO_DIR, 'slides.html');

export function slidesHtmlExists(): boolean {
  return existsSync(SLIDES_HTML_PATH);
}

function fileUrl(filePath: string, query: string): string {
  return `file:///${filePath.replace(/\\/g, '/')}${query}`;
}

export async function renderSlide(browser: Browser, clipId: string, slideNum: number, durationMs: number): Promise<Segment> {
  const created = Date.now();
  const context = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    recordVideo: { dir: VIDEO_OUT_DIR, size: { width: WIDTH, height: HEIGHT } },
  });
  const page = await context.newPage();
  const url = fileUrl(SLIDES_HTML_PATH, `?slide=${slideNum}`);
  await page.goto(url, { waitUntil: 'load' });
  try {
    await page.waitForSelector('body[data-ready="1"]', { timeout: 5000 });
  } catch {
    await page.waitForTimeout(300);
  }
  const trimStartMs = Date.now() - created;
  await sleep(durationMs);
  await context.close();
  const file = await page.video()!.path();
  return { clipId, file, trimStartMs, durationMs, note: `slide ${slideNum}` };
}

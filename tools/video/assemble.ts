/**
 * Reads NARRATION_MANIFEST and SEGMENTS_MANIFEST, lays out the timeline (clips in script
 * order; each clip's picture = its segments in order, extended by a held last frame if its
 * segments run shorter than the narration needs), writes a plan JSON, renders OUTPUT_MP4 via
 * compose.ps1 (Windows.Media.Editing.MediaComposition), then verifies the result by parsing
 * the mp4 boxes directly (no ffmpeg needed for playback/inspection at this stage).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseScript, BUILD_DIR } from './lib/script.js';
import { AUDIO_LEAD_MS, minClipMs, NARRATION_MANIFEST, OUTPUT_MP4, SEGMENTS_MANIFEST, WIDTH, HEIGHT } from './lib/contracts.js';
import type { NarrationManifest, Segment, SegmentsManifest } from './lib/contracts.js';
import { probeMp4, formatDuration } from './lib/mp4.js';

const FRAME_RATE_NUM = 25;
const FRAME_RATE_DEN = 1;
const DEFAULT_VIDEO_KBPS = 550;
const AUDIO_KBPS = 96;

type ComposeClipItem =
  | { kind: 'video'; file: string; trimStartMs: number; durationMs: number }
  | { kind: 'image'; file: string; durationMs: number };

interface ComposeAudioItem {
  /** Index into plan.clips of this clip's first picture item; compose.ps1 re-anchors the delay to that item's actual start. */
  clipIndex: number;
  leadMs: number;
  file: string;
  delayMs: number;
}

interface ComposePlan {
  outputMp4: string;
  width: number;
  height: number;
  frameRateNum: number;
  frameRateDen: number;
  videoKbps: number;
  audioKbps: number;
  clips: ComposeClipItem[];
  audioTracks: ComposeAudioItem[];
}

function findFfmpeg(): string {
  const base = path.join(process.env.LOCALAPPDATA ?? '', 'ms-playwright');
  if (!existsSync(base)) throw new Error(`ms-playwright dir not found: ${base}`);
  const entries = readdirSync(base).filter((n) => n.startsWith('ffmpeg-'));
  if (entries.length === 0) throw new Error(`no ffmpeg-* dir under ${base}`);
  entries.sort();
  const chosen = entries[entries.length - 1]!;
  const exe = path.join(base, chosen, 'ffmpeg-win64.exe');
  if (!existsSync(exe)) throw new Error(`ffmpeg exe not found: ${exe}`);
  return exe;
}

function extractLastFrame(ffmpegPath: string, webmPath: string, seekMs: number, outPngPath: string): void {
  mkdirSync(path.dirname(outPngPath), { recursive: true });
  const seekSeconds = (Math.max(0, seekMs) / 1000).toFixed(3);
  const args = ['-y', '-i', webmPath, '-ss', seekSeconds, '-frames:v', '1', '-update', '1', '-vf', `scale=${WIDTH}:${HEIGHT}`, outPngPath];
  const res = spawnSync(ffmpegPath, args, { stdio: 'inherit' });
  if (res.status !== 0) {
    throw new Error(`ffmpeg frame extraction failed for ${webmPath} at ${seekSeconds}s (exit ${String(res.status)})`);
  }
}

function fmtSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(2)}s`;
}

export async function assemble(): Promise<void> {
  const clips = parseScript();

  if (!existsSync(NARRATION_MANIFEST)) throw new Error(`missing ${NARRATION_MANIFEST}; run narrate.ts first`);
  if (!existsSync(SEGMENTS_MANIFEST)) throw new Error(`missing ${SEGMENTS_MANIFEST}; run record.ts (or placeholder.ts) first`);

  const narration = JSON.parse(readFileSync(NARRATION_MANIFEST, 'utf8')) as NarrationManifest;
  const segmentsManifest = JSON.parse(readFileSync(SEGMENTS_MANIFEST, 'utf8')) as SegmentsManifest;

  const narrationById = new Map(narration.clips.map((c) => [c.id, c] as const));
  const segmentsById = new Map<string, Segment[]>();
  for (const seg of segmentsManifest.segments) {
    const arr = segmentsById.get(seg.clipId) ?? [];
    arr.push(seg);
    segmentsById.set(seg.clipId, arr);
  }

  const ffmpeg = findFfmpeg();
  const holdsDir = path.join(BUILD_DIR, 'holds');

  const composeClips: ComposeClipItem[] = [];
  const audioTracks: ComposeAudioItem[] = [];
  const timelineLines: string[] = [];
  let cursorMs = 0;

  for (const clip of clips) {
    const narr = narrationById.get(clip.id);
    if (!narr) throw new Error(`no narration for clip ${clip.id} in ${NARRATION_MANIFEST}`);
    const segs = segmentsById.get(clip.id);
    if (!segs || segs.length === 0) throw new Error(`no video segments for clip ${clip.id} in ${SEGMENTS_MANIFEST}`);

    const clipStartMs = cursorMs;
    const firstItemIndex = composeClips.length;
    let segTotalMs = 0;
    for (const seg of segs) {
      composeClips.push({ kind: 'video', file: seg.file, trimStartMs: seg.trimStartMs, durationMs: seg.durationMs });
      segTotalMs += seg.durationMs;
    }

    const neededMs = minClipMs(narr.durationMs);
    let pictureMs = segTotalMs;
    let heldMs = 0;
    if (segTotalMs < neededMs) {
      heldMs = neededMs - segTotalMs;
      const last = segs[segs.length - 1]!;
      const seekMs = last.trimStartMs + last.durationMs - 40;
      const pngPath = path.join(holdsDir, `${clip.id}.png`);
      extractLastFrame(ffmpeg, last.file, seekMs, pngPath);
      composeClips.push({ kind: 'image', file: pngPath, durationMs: heldMs });
      pictureMs = neededMs;
    }

    audioTracks.push({ file: narr.wav, delayMs: clipStartMs + AUDIO_LEAD_MS, clipIndex: firstItemIndex, leadMs: AUDIO_LEAD_MS });

    const holdNote = heldMs > 0 ? `  held=${fmtSeconds(heldMs)}` : '';
    timelineLines.push(
      `${clip.id.padEnd(6)} start=${formatDuration(clipStartMs).padStart(6)}  picture=${fmtSeconds(pictureMs).padStart(7)}` +
        `  narration=${fmtSeconds(narr.durationMs).padStart(7)}  segments=${segs.length}${holdNote}`,
    );

    cursorMs += pictureMs;
  }

  const totalMs = cursorMs;
  const videoKbps = Number(process.env.VIDEO_KBPS ?? String(DEFAULT_VIDEO_KBPS));

  const plan: ComposePlan = {
    outputMp4: OUTPUT_MP4,
    width: WIDTH,
    height: HEIGHT,
    frameRateNum: FRAME_RATE_NUM,
    frameRateDen: FRAME_RATE_DEN,
    videoKbps,
    audioKbps: AUDIO_KBPS,
    clips: composeClips,
    audioTracks,
  };

  mkdirSync(BUILD_DIR, { recursive: true });
  const planFile = path.join(BUILD_DIR, 'compose-plan.json');
  writeFileSync(planFile, JSON.stringify(plan, null, 2));

  const timelinePath = path.join(BUILD_DIR, 'timeline.txt');
  writeFileSync(
    timelinePath,
    `clip   start    picture  narration  segments\n${timelineLines.join('\n')}\n\ntotal picture length: ${formatDuration(totalMs)} (${fmtSeconds(totalMs)})\n`,
  );

  console.log(`compose plan: ${composeClips.length} clip item(s), ${audioTracks.length} audio track(s), total ${formatDuration(totalMs)}`);
  console.log(`wrote ${planFile}`);
  console.log(`wrote ${timelinePath}`);

  mkdirSync(path.dirname(OUTPUT_MP4), { recursive: true });
  const composePs = path.join(path.dirname(fileURLToPath(import.meta.url)), 'compose.ps1');
  const renderStart = Date.now();
  const res = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', composePs, '-PlanFile', planFile], {
    stdio: 'inherit',
  });
  const renderMs = Date.now() - renderStart;
  if (res.status !== 0) throw new Error(`compose.ps1 failed with exit code ${String(res.status)}`);
  console.log(`render took ${(renderMs / 1000).toFixed(1)}s`);

  const info = probeMp4(OUTPUT_MP4);
  const sizeMb = info.sizeBytes / (1024 * 1024);
  console.log(
    `duration: ${formatDuration(info.durationMs)}  size: ${sizeMb.toFixed(2)} MB  resolution: ${info.width}x${info.height}` +
      `  video: ${info.videoCodec ?? 'NONE'}  audio: ${info.audioCodec ?? 'NONE'}`,
  );

  let ok = true;
  if (sizeMb >= 25) {
    console.error(`FAIL: size ${sizeMb.toFixed(2)} MB >= 25 MB (lower VIDEO_KBPS, currently ${videoKbps})`);
    ok = false;
  }
  if (!info.audioCodec) {
    console.error('FAIL: no audio track found');
    ok = false;
  }
  if (info.width !== WIDTH || info.height !== HEIGHT) {
    console.error(`FAIL: resolution ${info.width}x${info.height} != ${WIDTH}x${HEIGHT}`);
    ok = false;
  }
  if (!ok) process.exit(1);
}

function isMainModule(): boolean {
  return !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  assemble().catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
}

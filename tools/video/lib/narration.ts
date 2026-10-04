/**
 * Narration durations for record.ts's "hold the picture at least this long" rule. Reads the real
 * per-clip WAV duration from NARRATION_MANIFEST (narrate.ts's output) when it exists; otherwise
 * estimates from the clip's word count at 150 words/minute.
 */
import { existsSync, readFileSync } from 'node:fs';
import { NARRATION_MANIFEST, minClipMs } from './contracts.js';
import type { NarrationManifest } from './contracts.js';

const WORDS_PER_MINUTE = 150;

let cachedManifest: NarrationManifest | undefined | null = null;

function loadManifest(): NarrationManifest | undefined {
  if (cachedManifest !== null) return cachedManifest ?? undefined;
  if (!existsSync(NARRATION_MANIFEST)) {
    cachedManifest = undefined;
    return undefined;
  }
  try {
    cachedManifest = JSON.parse(readFileSync(NARRATION_MANIFEST, 'utf8')) as NarrationManifest;
  } catch {
    cachedManifest = undefined;
  }
  return cachedManifest ?? undefined;
}

/** 150 words/minute estimate, used only when the real narration manifest is unavailable. */
export function estimateNarrationMs(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.round((words / WORDS_PER_MINUTE) * 60000);
}

/** Real WAV duration for `clipId` if narrate.ts has already run, else the word-count estimate. */
export function narrationMsFor(clipId: string, text: string): number {
  const clip = loadManifest()?.clips.find((c) => c.id === clipId);
  return clip?.durationMs ?? estimateNarrationMs(text);
}

/** The minimum picture length (ms) clip `clipId` needs, per contracts.ts's `minClipMs`. */
export function requiredMsFor(clipId: string, text: string): number {
  return minClipMs(narrationMsFor(clipId, text));
}

/** True when the real (synthesized) narration manifest was found — for the report table. */
export function usingRealNarration(): boolean {
  return loadManifest() !== undefined;
}

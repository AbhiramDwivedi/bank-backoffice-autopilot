/**
 * Shared file contracts between the pipeline stages. All paths are absolute.
 *
 *   narrate.ts  -> .build/narration.json  (+ .build/audio/<clipId>.wav)
 *   record.ts   -> .build/segments.json   (+ .build/video/*.webm)
 *   assemble.ts -> evidence/explainer.mp4 (reads both manifests)
 */
import path from 'node:path';
import { BUILD_DIR, REPO_ROOT } from './script.js';

export const NARRATION_MANIFEST = path.join(BUILD_DIR, 'narration.json');
export const SEGMENTS_MANIFEST = path.join(BUILD_DIR, 'segments.json');
export const AUDIO_DIR = path.join(BUILD_DIR, 'audio');
export const VIDEO_OUT_DIR = path.join(BUILD_DIR, 'video');
export const OUTPUT_MP4 = path.join(REPO_ROOT, 'evidence', 'explainer.mp4');

/** Ports and dirs the video pipeline uses (never the defaults 4173/4174/4300/runs). */
export const VIDEO_PORTS = { tenantA: 4183, tenantB: 4184, operator: 4310 } as const;
export const VIDEO_BASE_URL = `http://localhost:${VIDEO_PORTS.tenantA}`;
export const VIDEO_RUNS_DIR = path.join(REPO_ROOT, 'runs-video');
/** policies/default.yaml with 4173->4183 and 4174->4184; written by build.ts (or record.ts if missing). */
export const VIDEO_POLICY = path.join(BUILD_DIR, 'policy.yaml');

export const WIDTH = 1280;
export const HEIGHT = 720;
/** Silence after each clip's narration before the next clip starts. */
export const CLIP_GAP_MS = 500;
/** Narration starts this long after its clip's picture starts. */
export const AUDIO_LEAD_MS = 250;

export interface NarrationClip {
  id: string;
  wav: string;
  /** Exact duration of the (normalised) WAV. */
  durationMs: number;
}
export interface NarrationManifest {
  voice: string;
  clips: NarrationClip[];
}

/** One piece of recorded video. A clip may have several segments (the handoff cuts between pages). */
export interface Segment {
  clipId: string;
  /** A Playwright recordVideo .webm. */
  file: string;
  /** Skip this much from the start of the webm (blank frames before the page rendered). */
  trimStartMs: number;
  /** Use this much after trimStartMs. */
  durationMs: number;
  note?: string;
}
export interface SegmentsManifest {
  segments: Segment[];
}

/** The picture length a clip needs: its narration plus lead and gap. record.ts holds each segment at least this long. */
export function minClipMs(narrationMs: number): number {
  return AUDIO_LEAD_MS + narrationMs + CLIP_GAP_MS;
}

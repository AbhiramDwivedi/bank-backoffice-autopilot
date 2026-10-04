/**
 * Synthesizes one WAV per clip (System.Speech, via a single batched PowerShell process),
 * then trims edge silence and normalises loudness in pure TypeScript (no ffmpeg).
 * Writes AUDIO_DIR/<clipId>.wav and NARRATION_MANIFEST.
 *
 * Voice/rate: env VIDEO_VOICE (default "Microsoft David Desktop"), VIDEO_RATE (default 1).
 * Re-synthesis is skipped per-clip when text+voice+rate is unchanged (hash cache).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseScript } from './lib/script.js';
import { AUDIO_DIR, NARRATION_MANIFEST } from './lib/contracts.js';
import type { NarrationManifest } from './lib/contracts.js';
import { readWavFile, writeWavFile, trimSilence, normalizeLoudness, durationMsOf } from './lib/wav.js';

const VOICE = process.env.VIDEO_VOICE ?? 'Microsoft David Desktop';
const RATE = Number(process.env.VIDEO_RATE ?? '1');

const RAW_DIR = path.join(AUDIO_DIR, 'raw');
const CACHE_FILE = path.join(RAW_DIR, '.cache.json');

function hashFor(id: string, text: string): string {
  return crypto.createHash('sha256').update(`${id}\u0000${text}\u0000${VOICE}\u0000${RATE}`).digest('hex');
}

function loadCache(): Record<string, string> {
  if (!existsSync(CACHE_FILE)) return {};
  try {
    return JSON.parse(readFileSync(CACHE_FILE, 'utf8')) as Record<string, string>;
  } catch {
    return {};
  }
}

export async function narrate(): Promise<void> {
  const clips = parseScript();
  mkdirSync(RAW_DIR, { recursive: true });
  mkdirSync(AUDIO_DIR, { recursive: true });

  const cache = loadCache();
  const toSynthesize = clips.filter((c) => {
    const rawPath = path.join(RAW_DIR, `${c.id}.wav`);
    return cache[c.id] !== hashFor(c.id, c.text) || !existsSync(rawPath);
  });

  if (toSynthesize.length > 0) {
    console.log(`synthesizing ${toSynthesize.length}/${clips.length} clip(s) with voice "${VOICE}" rate ${RATE}...`);
    const planFile = path.join(RAW_DIR, '.plan.json');
    writeFileSync(
      planFile,
      JSON.stringify(
        {
          outDir: RAW_DIR,
          items: toSynthesize.map((c) => ({ id: c.id, text: c.text })),
        },
        null,
        2,
      ),
    );
    const psScript = path.join(path.dirname(fileURLToPath(import.meta.url)), 'synthesize.ps1');
    const result = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psScript, '-PlanFile', planFile, '-Voice', VOICE, '-Rate', String(RATE)],
      { stdio: 'inherit' },
    );
    if (result.status !== 0) {
      throw new Error(`synthesize.ps1 failed with exit code ${String(result.status)}`);
    }
    for (const c of toSynthesize) cache[c.id] = hashFor(c.id, c.text);
    writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  } else {
    console.log('all clips cached (text+voice+rate unchanged), skipping synthesis');
  }

  const manifestClips: NarrationManifest['clips'] = [];
  let totalMs = 0;
  for (const c of clips) {
    const rawPath = path.join(RAW_DIR, `${c.id}.wav`);
    if (!existsSync(rawPath)) throw new Error(`missing synthesized wav for clip ${c.id}: ${rawPath}`);
    const raw = readWavFile(rawPath);
    const trimmed = trimSilence(raw);
    const normalized = normalizeLoudness(trimmed);
    const outPath = path.join(AUDIO_DIR, `${c.id}.wav`);
    writeWavFile(outPath, normalized);
    const ms = durationMsOf(normalized);
    totalMs += ms;
    console.log(`  ${c.id}: ${ms.toFixed(0)} ms`);
    manifestClips.push({ id: c.id, wav: outPath, durationMs: Math.round(ms) });
  }

  mkdirSync(path.dirname(NARRATION_MANIFEST), { recursive: true });
  writeFileSync(NARRATION_MANIFEST, JSON.stringify({ voice: VOICE, clips: manifestClips }, null, 2));
  console.log(`wrote ${NARRATION_MANIFEST}`);
  console.log(`total narration: ${(totalMs / 1000).toFixed(1)}s across ${clips.length} clips`);
}

function isMainModule(): boolean {
  return !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  narrate().catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
}

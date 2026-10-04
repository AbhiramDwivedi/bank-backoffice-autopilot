/**
 * Minimal PCM WAV read/write/trim/normalise helpers. No ffmpeg, no dependencies.
 * Only supports 16-bit integer PCM (what System.Speech's SpeechAudioFormatInfo
 * produces and what MediaComposition's BackgroundAudioTrack consumes happily).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface WavData {
  sampleRate: number;
  numChannels: number;
  bitsPerSample: number;
  /** Interleaved 16-bit PCM samples. */
  samples: Int16Array;
}

/** Walks RIFF chunks to find 'fmt ' and 'data'. Tolerant of extra chunks (e.g. 'fact', 'LIST'). */
export function parseWav(buf: Buffer): WavData {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }
  let offset = 12;
  let sampleRate = 0;
  let numChannels = 0;
  let bitsPerSample = 0;
  let dataStart = -1;
  let dataLen = 0;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const bodyStart = offset + 8;
    if (id === 'fmt ') {
      numChannels = buf.readUInt16LE(bodyStart + 2);
      sampleRate = buf.readUInt32LE(bodyStart + 4);
      bitsPerSample = buf.readUInt16LE(bodyStart + 14);
    } else if (id === 'data') {
      dataStart = bodyStart;
      dataLen = Math.min(size, buf.length - bodyStart);
    }
    offset = bodyStart + size + (size % 2); // chunks are word-aligned
  }
  if (dataStart < 0) throw new Error('no data chunk found in wav');
  if (bitsPerSample !== 16) throw new Error(`unsupported bits per sample: ${bitsPerSample} (only 16-bit PCM supported)`);
  const numSamples = Math.floor(dataLen / 2);
  const samples = new Int16Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    samples[i] = buf.readInt16LE(dataStart + i * 2);
  }
  return { sampleRate, numChannels: numChannels || 1, bitsPerSample, samples };
}

export function readWavFile(filePath: string): WavData {
  return parseWav(readFileSync(filePath));
}

export function encodeWav(data: WavData): Buffer {
  const { sampleRate, numChannels, bitsPerSample, samples } = data;
  const bytesPerSample = bitsPerSample / 8;
  const byteRate = sampleRate * numChannels * bytesPerSample;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = samples.length * bytesPerSample;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(numChannels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples.length; i++) {
    buf.writeInt16LE(samples[i]!, 44 + i * bytesPerSample);
  }
  return buf;
}

export function writeWavFile(filePath: string, data: WavData): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, encodeWav(data));
}

export function durationMsOf(data: WavData): number {
  return (data.samples.length / data.numChannels / data.sampleRate) * 1000;
}

/**
 * Trims leading/trailing near-silence down to at most `maxEdgeMs` of padding around the
 * loudest region (voice onset..offset), instead of stripping every last sample of silence.
 */
export function trimSilence(data: WavData, opts?: { thresholdRatio?: number; maxEdgeMs?: number }): WavData {
  const thresholdRatio = opts?.thresholdRatio ?? 0.02;
  const maxEdgeMs = opts?.maxEdgeMs ?? 80;
  const { samples, numChannels, sampleRate, bitsPerSample } = data;
  if (samples.length === 0) return data;

  let peak = 0;
  for (const s of samples) peak = Math.max(peak, Math.abs(s));
  const threshold = Math.max(peak * thresholdRatio, 200);

  let firstLoud = 0;
  while (firstLoud < samples.length && Math.abs(samples[firstLoud]!) < threshold) firstLoud++;
  let lastLoud = samples.length - 1;
  while (lastLoud > firstLoud && Math.abs(samples[lastLoud]!) < threshold) lastLoud--;

  const padSamples = Math.round((maxEdgeMs / 1000) * sampleRate) * Math.max(1, numChannels);
  const start = Math.max(0, firstLoud - padSamples);
  const end = Math.min(samples.length, lastLoud + 1 + padSamples);

  return { sampleRate, numChannels, bitsPerSample, samples: samples.slice(start, end) };
}

function rms(samples: Int16Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const s of samples) sum += s * s;
  return Math.sqrt(sum / samples.length);
}

function dbfsFromAmplitude(amp: number): number {
  if (amp <= 0) return -Infinity;
  return 20 * Math.log10(amp / 32768);
}

function amplitudeFromDbfs(db: number): number {
  return 32768 * Math.pow(10, db / 20);
}

/**
 * RMS-based loudness normalisation to a common target, with a hard peak ceiling so nothing
 * clips. Silent/near-silent clips (rms ~ 0) are left alone.
 */
export function normalizeLoudness(data: WavData, targetRmsDb = -20, peakCeilingDb = -1): WavData {
  const { samples } = data;
  const currentRms = rms(samples);
  if (currentRms <= 1) return { ...data, samples: samples.slice() };

  const targetRmsAmp = amplitudeFromDbfs(targetRmsDb);
  let gain = targetRmsAmp / currentRms;

  let peak = 0;
  for (const s of samples) peak = Math.max(peak, Math.abs(s));
  const peakCeilingAmp = amplitudeFromDbfs(peakCeilingDb);
  if (peak > 0 && peak * gain > peakCeilingAmp) gain = peakCeilingAmp / peak;

  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    let v = Math.round(samples[i]! * gain);
    if (v > 32767) v = 32767;
    if (v < -32768) v = -32768;
    out[i] = v;
  }
  return { ...data, samples: out };
}

export function measuredRmsDbfs(data: WavData): number {
  return dbfsFromAmplitude(rms(data.samples));
}

export function measuredPeakDbfs(data: WavData): number {
  let peak = 0;
  for (const s of data.samples) peak = Math.max(peak, Math.abs(s));
  return dbfsFromAmplitude(peak);
}

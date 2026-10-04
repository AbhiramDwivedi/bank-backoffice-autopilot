/**
 * Minimal ISO-BMFF (mp4) box walker, just enough to verify what MediaComposition rendered:
 * moov -> mvhd (duration/timescale), each trak -> mdia -> hdlr (vide/soun), stsd fourcc
 * (avc1/mp4a expected), and tkhd width/height. No dependencies.
 */
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface Box {
  type: string;
  bodyStart: number;
  bodyEnd: number;
}

function readBoxes(buf: Buffer, start: number, end: number): Box[] {
  const boxes: Box[] = [];
  let offset = start;
  while (offset + 8 <= end) {
    let size = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > end) break;
      size = Number(buf.readBigUInt64BE(offset + 8));
      headerSize = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < headerSize) break;
    boxes.push({ type, bodyStart: offset + headerSize, bodyEnd: offset + size });
    offset += size;
  }
  return boxes;
}

function findBox(boxes: Box[], type: string): Box | undefined {
  return boxes.find((b) => b.type === type);
}

export interface Mp4Info {
  durationMs: number;
  width: number;
  height: number;
  sizeBytes: number;
  videoCodec?: string;
  audioCodec?: string;
}

export function probeMp4(filePath: string): Mp4Info {
  const buf = readFileSync(filePath);
  const sizeBytes = statSync(filePath).size;

  const top = readBoxes(buf, 0, buf.length);
  const moov = findBox(top, 'moov');
  if (!moov) throw new Error(`no moov box found in ${filePath}`);
  const moovChildren = readBoxes(buf, moov.bodyStart, moov.bodyEnd);

  const mvhd = findBox(moovChildren, 'mvhd');
  if (!mvhd) throw new Error(`no mvhd box found in ${filePath}`);
  const mvhdVersion = buf.readUInt8(mvhd.bodyStart);
  let timescale: number;
  let duration: number;
  if (mvhdVersion === 1) {
    timescale = buf.readUInt32BE(mvhd.bodyStart + 20);
    duration = Number(buf.readBigUInt64BE(mvhd.bodyStart + 24));
  } else {
    timescale = buf.readUInt32BE(mvhd.bodyStart + 12);
    duration = buf.readUInt32BE(mvhd.bodyStart + 16);
  }
  const durationMs = timescale > 0 ? (duration / timescale) * 1000 : 0;

  let width = 0;
  let height = 0;
  let videoCodec: string | undefined;
  let audioCodec: string | undefined;

  for (const trak of moovChildren.filter((b) => b.type === 'trak')) {
    const trakChildren = readBoxes(buf, trak.bodyStart, trak.bodyEnd);
    const tkhd = findBox(trakChildren, 'tkhd');
    const mdia = findBox(trakChildren, 'mdia');
    if (!mdia) continue;
    const mdiaChildren = readBoxes(buf, mdia.bodyStart, mdia.bodyEnd);
    const hdlr = findBox(mdiaChildren, 'hdlr');
    if (!hdlr) continue;
    // hdlr: version/flags(4) + pre_defined(4) + handler_type(4)
    const handlerType = buf.toString('ascii', hdlr.bodyStart + 8, hdlr.bodyStart + 12);

    let fourcc: string | undefined;
    const minf = findBox(mdiaChildren, 'minf');
    if (minf) {
      const minfChildren = readBoxes(buf, minf.bodyStart, minf.bodyEnd);
      const stbl = findBox(minfChildren, 'stbl');
      if (stbl) {
        const stblChildren = readBoxes(buf, stbl.bodyStart, stbl.bodyEnd);
        const stsd = findBox(stblChildren, 'stsd');
        if (stsd) {
          // stsd: version/flags(4) + entry_count(4) + first entry: size(4) + format(4)
          fourcc = buf.toString('ascii', stsd.bodyStart + 12, stsd.bodyStart + 16);
        }
      }
    }

    if (handlerType === 'vide') {
      videoCodec = fourcc;
      if (tkhd) {
        const v = buf.readUInt8(tkhd.bodyStart);
        // tkhd: version0 width/height at +76/+80; version1 at +88/+92 (32-bit 16.16 fixed point)
        const whOffset = v === 1 ? tkhd.bodyStart + 88 : tkhd.bodyStart + 76;
        width = buf.readUInt32BE(whOffset) / 65536;
        height = buf.readUInt32BE(whOffset + 4) / 65536;
      }
    } else if (handlerType === 'soun') {
      audioCodec = fourcc;
    }
  }

  const info: Mp4Info = { durationMs, width, height, sizeBytes };
  if (videoCodec) info.videoCodec = videoCodec;
  if (audioCodec) info.audioCodec = audioCodec;
  return info;
}

export function formatDuration(ms: number): string {
  const totalSeconds = ms / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds - minutes * 60;
  return `${minutes}:${seconds.toFixed(1).padStart(4, '0')}`;
}

function isMainModule(): boolean {
  return !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: npx tsx lib/mp4.ts <file.mp4>');
    process.exit(1);
  }
  const info = probeMp4(file);
  console.log(
    JSON.stringify(
      { ...info, sizeMB: info.sizeBytes / (1024 * 1024), durationFormatted: formatDuration(info.durationMs) },
      null,
      2,
    ),
  );
}

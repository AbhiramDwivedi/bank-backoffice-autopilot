/**
 * The placeholder a surface returns from `screenshot()` when it must not take one (the page
 * matches `redaction.screen.omitScreenshotUrlPatterns`, or the mask plan could not be computed and
 * the surface fails closed). `observe()` reports no screenshot at all in that case (the model's
 * prompt then says "screenshot omitted"); `screenshot()` callers (escalation requests, Relay's live
 * view, failure evidence) expect bytes, so they get this: a grey image reading
 * "SCREENSHOT OMITTED" over "BY SCREEN MASKING POLICY", plus a PNG text chunk saying the same, so
 * an operator, a reviewer of evidence and a test can all tell it from a real capture.
 *
 * Built once, with no dependency beyond node:zlib: an 8-bit greyscale PNG drawn from a 5x7 bitmap
 * font that covers exactly the characters used.
 */
import { deflateSync } from 'node:zlib';

/** Machine-readable marker in the PNG's tEXt chunk. */
export const OMITTED_SCREENSHOT_TEXT = 'cu:screenshot-omitted';

const GLYPHS: Record<string, readonly string[]> = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  G: ['01110', '10001', '10000', '10111', '10001', '10001', '01111'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
};

const LINES = ['SCREENSHOT OMITTED', 'BY SCREEN MASKING POLICY'];
const WIDTH = 640;
const HEIGHT = 160;
const BACKGROUND = 0x7f; // the mask colour the Playwright surface paints with
const INK = 0xff;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function drawText(pixels: Uint8Array, text: string, top: number, scale: number): void {
  const advance = 6 * scale;
  const left = Math.floor((WIDTH - text.length * advance + scale) / 2);
  [...text].forEach((ch, i) => {
    const glyph = GLYPHS[ch] ?? GLYPHS[' ']!;
    glyph.forEach((row, gy) => {
      for (let gx = 0; gx < 5; gx++) {
        if (row[gx] !== '1') continue;
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) {
            const x = left + i * advance + gx * scale + dx;
            const y = top + gy * scale + dy;
            if (x >= 0 && x < WIDTH && y >= 0 && y < HEIGHT) pixels[y * WIDTH + x] = INK;
          }
        }
      }
    });
  });
}

function buildPng(): Buffer {
  const pixels = new Uint8Array(WIDTH * HEIGHT).fill(BACKGROUND);
  drawText(pixels, LINES[0]!, 40, 5);
  drawText(pixels, LINES[1]!, 105, 3);
  const raw = Buffer.alloc((WIDTH + 1) * HEIGHT);
  for (let y = 0; y < HEIGHT; y++) {
    raw[y * (WIDTH + 1)] = 0; // filter: none
    Buffer.from(pixels.buffer, y * WIDTH, WIDTH).copy(raw, y * (WIDTH + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(WIDTH, 0);
  ihdr.writeUInt32BE(HEIGHT, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // greyscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('tEXt', Buffer.from(`Comment\0${OMITTED_SCREENSHOT_TEXT}`, 'latin1')),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

let cached: Buffer | undefined;

/** The placeholder PNG (a fresh copy, so a caller can never alter the shared one). */
export function omittedScreenshotPng(): Buffer {
  cached ??= buildPng();
  return Buffer.from(cached);
}

/** True when `png` is the placeholder (or any PNG carrying its marker), not a real capture. */
export function isOmittedScreenshot(png: Buffer | undefined): boolean {
  return png !== undefined && png.includes(Buffer.from(`Comment\0${OMITTED_SCREENSHOT_TEXT}`, 'latin1'));
}

/**
 * Test helpers for the desktop adapter: a minimal PNG reader (8-bit RGB/RGBA, non-interlaced,
 * which is what System.Drawing writes) so screenshot masking can be checked pixel by pixel without
 * an image library, and a Windows-only guard.
 */
import { inflateSync } from 'node:zlib';

/** True on Windows, where the real bridge and the real app can run. */
export const ON_WINDOWS = process.platform === 'win32';

/** A decoded image: `pixel(x, y)` returns [r, g, b, a]. */
export interface DecodedPng {
  width: number;
  height: number;
  pixel(x: number, y: number): [number, number, number, number];
}

/** Decodes an 8-bit truecolor (RGB or RGBA) non-interlaced PNG. Throws on anything else. */
export function decodePng(buf: Buffer): DecodedPng {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let off = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8) throw new Error(`unsupported bit depth ${data[8]}`);
      colorType = data[9]!;
      if (data[12] !== 0) throw new Error('interlaced PNG not supported');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (bpp === 0) throw new Error(`unsupported color type ${colorType}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[y * stride + x - bpp]! : 0;
      const b = y > 0 ? out[(y - 1) * stride + x]! : 0;
      const c = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp]! : 0;
      let v = line[x]!;
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += Math.floor((a + b) / 2);
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * stride + x] = v & 0xff;
    }
  }
  return {
    width,
    height,
    pixel(x, y) {
      const i = Math.round(y) * stride + Math.round(x) * bpp;
      return [out[i]!, out[i + 1]!, out[i + 2]!, bpp === 4 ? out[i + 3]! : 255];
    },
  };
}

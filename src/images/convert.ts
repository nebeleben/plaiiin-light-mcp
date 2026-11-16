import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { PNG } from 'pngjs';

/** Input files larger than this are refused before reading (server memory). */
export const MAX_PNG_BYTES = 16 * 1024 * 1024;
/** Input PNGs wider or taller than this are refused from the header, before decoding. */
export const MAX_PNG_SIDE = 4096;
/** Output PNGs (image_get) never exceed this on either side. */
export const MAX_OUT_SIDE = 1024;
const MIN_OUT_SIDE = 256;

export type PixelColor = string | [number, number, number];
export type GridInput = { pixels: PixelColor[][] } | { pngPath: string };

/** An RGBA image as decoded from a PNG. */
export interface Rgba { w: number; h: number; data: Uint8Array }

const HEX = /^#?([0-9a-fA-F]{6})$/;
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function color(c: PixelColor, x: number, y: number): [number, number, number] {
  if (typeof c === 'string') {
    const m = HEX.exec(c.trim());
    if (m) { const v = parseInt(m[1]!, 16); return [v >> 16, (v >> 8) & 255, v & 255]; }
  } else if (Array.isArray(c) && c.length === 3 && c.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)) {
    return c;
  }
  throw new Error(`bad colour at row ${y}, column ${x}: use "#rrggbb" or [r, g, b] with 0–255`);
}

/** Rows of colours → row-major RGB; must be exactly h rows of w. */
export function gridToRgb(rows: PixelColor[][], w: number, h: number): Uint8Array {
  if (rows.length !== h || rows.some((r) => !Array.isArray(r) || r.length !== w)) throw new Error(`needs a ${w}×${h} grid`);
  const out = new Uint8Array(w * h * 3);
  rows.forEach((row, y) => row.forEach((c, x) => out.set(color(c, x, y), (y * w + x) * 3)));
  return out;
}

/**
 * Check a PNG file without decoding it: a file, at most 16 MB, a PNG signature + IHDR, at most
 * 4096×4096, not interlaced. Returns its size in pixels.
 */
export function checkPng(path: string): { w: number; h: number } {
  const st = statSync(path);
  if (!st.isFile()) throw new Error('pngPath is not a file');
  if (st.size > MAX_PNG_BYTES) throw new Error(`PNG file is ${st.size} bytes; at most ${MAX_PNG_BYTES} (16 MB)`);
  // Signature (8) + IHDR length/type (8) + width, height, depth, colour type, compression, filter, interlace (13).
  const head = Buffer.alloc(29);
  const fd = openSync(path, 'r');
  let n: number;
  try { n = readSync(fd, head, 0, 29, 0); } finally { closeSync(fd); }
  if (n < 29 || !head.subarray(0, 8).equals(SIG) || head.toString('ascii', 12, 16) !== 'IHDR') throw new Error('not a PNG file');
  const w = head.readUInt32BE(16), h = head.readUInt32BE(20);
  if (w > MAX_PNG_SIDE || h > MAX_PNG_SIDE) throw new Error(`PNG is ${w}×${h} px; at most ${MAX_PNG_SIDE}×${MAX_PNG_SIDE}`);
  // pngjs bounds inflate to the image size only for non-interlaced images (parser-sync.js inflates
  // interlaced data without maxLength: a 16 MB file could inflate to gigabytes). Any bit depth is
  // fine for non-interlaced images: the bound covers it (row size uses the depth).
  if (head[28] !== 0) throw new Error("interlaced PNGs aren't supported — save it non-interlaced");
  return { w, h };
}

/**
 * Decode a PNG file, refusing it before decoding (file size, then the IHDR header) when it is too large
 * or interlaced. Non-interlaced PNGs of any bit depth / colour type are accepted.
 */
export function readPng(path: string): Rgba {
  checkPng(path);
  let png: PNG;
  try {
    png = PNG.sync.read(readFileSync(path));
  } catch (e) {
    throw new Error(`can't decode the PNG: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { w: png.width, h: png.height, data: new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.length) };
}

/**
 * Area-weighted box filter from RGBA (alpha composited over black — an unlit LED) to w×h RGB.
 * Each target pixel averages the source area it covers, so it works for shrinking and growing.
 */
export function resizeToRgb(src: Rgba, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h * 3);
  const sx = src.w / w, sy = src.h / h;
  for (let ty = 0; ty < h; ty++) {
    const y0 = ty * sy, y1 = y0 + sy;
    for (let tx = 0; tx < w; tx++) {
      const x0 = tx * sx, x1 = x0 + sx;
      let r = 0, g = 0, b = 0, area = 0;
      for (let y = Math.floor(y0); y < Math.min(src.h, Math.ceil(y1)); y++) {
        const wy = Math.min(y + 1, y1) - Math.max(y, y0);
        for (let x = Math.floor(x0); x < Math.min(src.w, Math.ceil(x1)); x++) {
          const wgt = wy * (Math.min(x + 1, x1) - Math.max(x, x0));
          const i = (y * src.w + x) * 4;
          const a = src.data[i + 3]! / 255;
          r += src.data[i]! * a * wgt; g += src.data[i + 1]! * a * wgt; b += src.data[i + 2]! * a * wgt;
          area += wgt;
        }
      }
      const o = (ty * w + tx) * 3;
      out[o] = Math.round(r / area); out[o + 1] = Math.round(g / area); out[o + 2] = Math.round(b / area);
    }
  }
  return out;
}

/** Pixel rows (exactly h×w) or a PNG file (resized to w×h) → row-major RGB for `POST /api/frame`. */
export function toGrid(input: GridInput, w: number, h: number): Uint8Array {
  if ('pixels' in input) return gridToRgb(input.pixels, w, h);
  return resizeToRgb(readPng(input.pngPath), w, h);
}

/**
 * Row-major RGB → PNG for viewing: small images are scaled up (nearest neighbour, integer factor,
 * to about 256 px on the long side); nothing is ever larger than 1024 px on either side.
 */
export function toPng(rgb: Uint8Array, w: number, h: number): Buffer {
  const long = Math.max(w, h);
  let pw = w, ph = h;
  let pick = (x: number, y: number) => (y * w + x) * 3;
  let src = rgb;
  if (long > MAX_OUT_SIDE) {
    pw = Math.max(1, Math.round(w * MAX_OUT_SIDE / long)); ph = Math.max(1, Math.round(h * MAX_OUT_SIDE / long));
    const rgba = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) { rgba.set(rgb.subarray(i * 3, i * 3 + 3), i * 4); rgba[i * 4 + 3] = 255; }
    src = resizeToRgb({ w, h, data: rgba }, pw, ph);
    pick = (x, y) => (y * pw + x) * 3;
  }
  const s = Math.max(1, Math.min(Math.floor(MAX_OUT_SIDE / Math.max(pw, ph)), Math.ceil(MIN_OUT_SIDE / Math.max(pw, ph))));
  const png = new PNG({ width: pw * s, height: ph * s });
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const i = pick(Math.floor(x / s), Math.floor(y / s)), o = (y * png.width + x) * 4;
      png.data[o] = src[i] ?? 0; png.data[o + 1] = src[i + 1] ?? 0; png.data[o + 2] = src[i + 2] ?? 0; png.data[o + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

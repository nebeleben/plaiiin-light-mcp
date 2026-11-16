import { readFileSync, statSync } from 'node:fs';
import { GifReader } from 'omggif';
import { checkPng, MAX_PNG_BYTES, MAX_PNG_SIDE, readPng, resizeToRgb } from '../images/convert';
import { MAX_FRAMES, renderFrames } from '../preview/shade';

export type StreamSource = { gifPath: string } | { pngPaths: string[] } | { script: string; params?: Record<string, number> };

/** Frame `i` of a stream (row-major RGB over the lamp's logical grid, w·h·3 bytes). Sources loop. */
export type FrameSource = (frameIndex: number) => Promise<Uint8Array>;

export const MAX_GIF_FRAMES = 1000;
export const MAX_PNG_FRAMES = 1000;
/** Source pixels decoded in all (frames × width × height), so a stream can't pin the server for minutes. */
export const MAX_DECODE_PIXELS = 256 * 1024 * 1024;
/** GIF frames without a usable delay (0 or 1 cs) play at 100 ms, as browsers do. */
const DEFAULT_GIF_DELAY_MS = 100;

/** `[0x01, count_hi, count_lo, r, g, b, …]` — a colour frame on `/ws` (firmware docs/protocol.md). */
export function encodeColorFrame(rgb: Uint8Array): Buffer {
  if (rgb.length % 3 !== 0) throw new Error('a colour frame needs 3 bytes per LED');
  const count = rgb.length / 3;
  if (count > 0xffff) throw new Error(`a colour frame carries at most 65535 LEDs (got ${count})`);
  const b = Buffer.allocUnsafe(3 + rgb.length);
  b[0] = 0x01;
  b.writeUInt16BE(count, 1);
  b.set(rgb, 3);
  return b;
}

export const CLEAR_FRAME = Buffer.from([0x03]);

/** A source whose files have been checked (sizes, headers, frame counts) but not decoded yet. */
export interface PreparedSource {
  kind: 'gif' | 'png' | 'script';
  /** Decode / render for one grid. */
  forGrid(w: number, h: number, fps: number): FrameSource;
}

/**
 * Check a source up front (before any lamp is touched). GIFs and PNGs are refused from their headers
 * when too large: 16 MB per file, 4096×4096 px, 1000 frames; scripts are only checked when rendered.
 */
export function prepareSource(src: StreamSource): PreparedSource {
  if ('gifPath' in src) {
    const gif = openGif(src.gifPath);
    return { kind: 'gif', forGrid: (w, h, fps) => gifFrames(gif, w, h, fps) };
  }
  if ('pngPaths' in src) {
    if (src.pngPaths.length === 0) throw new Error('pngPaths is empty');
    if (src.pngPaths.length > MAX_PNG_FRAMES) throw new Error(`${src.pngPaths.length} PNG files; at most ${MAX_PNG_FRAMES}`);
    let total = 0;
    for (const p of src.pngPaths) {
      const { w, h } = checkPng(p);
      total += w * h;
    }
    if (total > MAX_DECODE_PIXELS) throw new Error(`the PNG files are too large to stream together (${total} pixels; at most ${MAX_DECODE_PIXELS})`);
    return { kind: 'png', forGrid: (w, h) => pngFrames(src.pngPaths, w, h) };
  }
  return { kind: 'script', forGrid: (w, h, fps) => scriptFrames(src.script, src.params, w, h, fps) };
}

/**
 * Frames of a source for a w×h grid. GIF / PNG frames are decoded now (resized to the grid, looped);
 * a script is rendered in the sandboxed preview worker, in batches of up to 2 s (≤ 60 frames), the
 * next batch prefetched — so at most about two batches are ever held.
 */
export function frameSource(src: StreamSource, w: number, h: number, fps = 20): FrameSource {
  return prepareSource(src).forGrid(w, h, fps);
}

function pngFrames(paths: string[], w: number, h: number): FrameSource {
  const frames = paths.map((p) => resizeToRgb(readPng(p), w, h));
  return async (i) => frames[i % frames.length]!;
}

interface OpenGif { reader: GifReader; w: number; h: number }

/**
 * Count image descriptors (0x2c) by walking the GIF's blocks, stopping past `limit` — before omggif,
 * which keeps an object per descriptor, parses the file. Malformed structure is left for omggif to report.
 */
export function countGifFrames(buf: Buffer, limit: number): number {
  let p = 13;
  if (buf[10]! & 0x80) p += 3 * (1 << ((buf[10]! & 7) + 1));
  const skipSubBlocks = () => {
    while (p < buf.length) {
      const n = buf[p++]!;
      if (n === 0) return;
      p += n;
    }
  };
  let frames = 0;
  while (p < buf.length) {
    const b = buf[p++];
    if (b === 0x21) {
      p++; // extension label
      skipSubBlocks();
    } else if (b === 0x2c) {
      if (++frames > limit) return frames;
      const flags = buf[p + 8] ?? 0;
      p += 9;
      if (flags & 0x80) p += 3 * (1 << ((flags & 7) + 1));
      p++; // LZW minimum code size
      skipSubBlocks();
    } else {
      break; // 0x3b trailer, or something omggif will reject
    }
  }
  return frames;
}

function openGif(path: string): OpenGif {
  const st = statSync(path);
  if (!st.isFile()) throw new Error('gifPath is not a file');
  if (st.size > MAX_PNG_BYTES) throw new Error(`GIF file is ${st.size} bytes; at most ${MAX_PNG_BYTES} (16 MB)`);
  const buf = readFileSync(path);
  const sig = buf.toString('ascii', 0, 6);
  if (buf.length < 13 || (sig !== 'GIF87a' && sig !== 'GIF89a')) throw new Error('not a GIF file');
  const w = buf.readUInt16LE(6), h = buf.readUInt16LE(8);
  if (w > MAX_PNG_SIDE || h > MAX_PNG_SIDE) throw new Error(`GIF is ${w}×${h} px; at most ${MAX_PNG_SIDE}×${MAX_PNG_SIDE}`);
  if (w === 0 || h === 0) throw new Error('GIF has an empty logical screen');
  const counted = countGifFrames(buf, MAX_GIF_FRAMES);
  if (counted > MAX_GIF_FRAMES) throw new Error(`GIF has more than ${MAX_GIF_FRAMES} frames; at most ${MAX_GIF_FRAMES}`);
  let reader: GifReader;
  try {
    reader = new GifReader(buf); // parses block headers only; no frame is decoded here
  } catch (e) {
    throw new Error(`can't read the GIF: ${e instanceof Error ? e.message : String(e)}`);
  }
  const n = reader.numFrames();
  if (n === 0) throw new Error('GIF has no frames');
  if (n > MAX_GIF_FRAMES) throw new Error(`GIF has ${n} frames; at most ${MAX_GIF_FRAMES}`);
  if (n * w * h > MAX_DECODE_PIXELS) throw new Error(`GIF is too large to stream: ${n} frames of ${w}×${h} px (at most ${MAX_DECODE_PIXELS} pixels in all)`);
  for (let i = 0; i < n; i++) {
    const f = reader.frameInfo(i);
    // omggif blits into a w×h canvas and sizes its index buffer from the frame header.
    if (f.x + f.width > w || f.y + f.height > h) throw new Error(`GIF frame ${i + 1} lies outside the ${w}×${h} image`);
    if (f.palette_offset === null) throw new Error(`GIF frame ${i + 1} has no colour table`);
  }
  return { reader, w, h };
}

/** Composite every frame (disposal 0/1 keep, 2 clears its rectangle, 3 restores), resize, place by delay. */
function gifFrames(gif: OpenGif, w: number, h: number, fps: number): FrameSource {
  const { reader, w: sw, h: sh } = gif;
  let canvas = new Uint8Array(sw * sh * 4);
  const frames: Uint8Array[] = [];
  const ends: number[] = [];
  let t = 0;
  for (let i = 0; i < reader.numFrames(); i++) {
    const f = reader.frameInfo(i);
    const saved = f.disposal === 3 ? canvas.slice() : undefined;
    try {
      reader.decodeAndBlitFrameRGBA(i, canvas);
    } catch (e) {
      throw new Error(`can't decode GIF frame ${i + 1}: ${e instanceof Error ? e.message : String(e)}`);
    }
    frames.push(resizeToRgb({ w: sw, h: sh, data: canvas }, w, h));
    t += f.delay >= 2 ? f.delay * 10 : DEFAULT_GIF_DELAY_MS;
    ends.push(t);
    if (f.disposal === 2) {
      for (let y = f.y; y < f.y + f.height; y++) canvas.fill(0, (y * sw + f.x) * 4, (y * sw + f.x + f.width) * 4);
    } else if (saved) {
      canvas = saved;
    }
  }
  const total = t;
  return async (i) => {
    const at = ((i * 1000) / fps) % total;
    let lo = 0, hi = ends.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (ends[mid]! > at) hi = mid; else lo = mid + 1; }
    return frames[lo]!;
  };
}

function scriptFrames(script: string, params: Record<string, number> | undefined, w: number, h: number, fps: number): FrameSource {
  const batch = Math.max(1, Math.min(MAX_FRAMES, Math.round(fps * 2)));
  const batches = new Map<number, Promise<Uint8Array[]>>();
  const get = (k: number) => {
    let p = batches.get(k);
    if (!p) {
      p = renderFrames(script, { w, h, fps, frames: batch, start: k * batch, ...(params ? { params } : {}) });
      p.catch(() => undefined); // a prefetch nobody waits for must not become an unhandled rejection
      batches.set(k, p);
    }
    return p;
  };
  return async (i) => {
    const k = Math.floor(i / batch);
    for (const key of batches.keys()) if (key < k || key > k + 1) batches.delete(key);
    const cur = get(k);
    get(k + 1);
    return (await cur)[i - k * batch]!;
  };
}

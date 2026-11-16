import { PNG } from 'pngjs';

/** A frame is enlarged until its long side is about this many pixels: big enough to judge an effect by. */
const FRAME_TARGET = 192;
/** …and its short side at least this many, so a one-pixel-high strip lamp is still visible. */
const FRAME_MIN_SHORT = 24;
/** Frames wrap into rows about this wide, which a chat window shows without shrinking them much. */
const ROW_TARGET = 1024;
export const MAX_STRIP_WIDTH = 4096;
export const MAX_STRIP_HEIGHT = 4096;

export interface PreviewLayout { scale: number; columns: number; rows: number; shown: number; gap: number }

/**
 * How `n` frames of `w`×`h` lamp pixels are laid out in the preview picture: each lamp pixel becomes
 * a `scale`×`scale` block, frames go in reading order (left to right, then top to bottom), `columns`
 * per row, `gap` transparent pixels apart so neighbouring frames do not run into each other. The
 * picture is never wider or taller than 4096 px: a scale that is too large is lowered, and frames
 * that do not fit are left out (`shown` < n).
 */
export function previewLayout(n: number, w: number, h: number, scale?: number): PreviewLayout {
  const fit = Math.max(1, Math.min(Math.floor(MAX_STRIP_WIDTH / w), Math.floor(MAX_STRIP_HEIGHT / h)));
  const wanted = scale ?? Math.min(
    Math.max(Math.ceil(FRAME_TARGET / Math.max(w, h)), Math.ceil(FRAME_MIN_SHORT / Math.min(w, h))),
    Math.max(1, Math.floor(ROW_TARGET / w)),            // one frame should still fit a row
  );
  const s = Math.max(1, Math.min(wanted, fit));
  const gap = Math.max(2, Math.round(s / 2));
  const columns = Math.max(1, Math.min(n, Math.floor((ROW_TARGET + gap) / (w * s + gap))));
  const rows = Math.max(1, Math.min(Math.ceil(n / columns), Math.floor((MAX_STRIP_HEIGHT + gap) / (h * s + gap))));
  return { scale: s, columns, rows, shown: Math.min(n, columns * rows), gap };
}

/**
 * Frames (each w·h·3 RGB) in one PNG, nearest-neighbour enlarged and laid out as `previewLayout`
 * says. The gaps and the cells after the last frame stay transparent. A frame wider or taller than
 * 4096 px is refused.
 */
export function framesToPng(frames: Uint8Array[], w: number, h: number, scale?: number): Buffer {
  if (!frames.length) throw new Error('no frames');
  if (w > MAX_STRIP_WIDTH) throw new Error(`a frame ${w} px wide can't be shown (at most ${MAX_STRIP_WIDTH})`);
  if (h > MAX_STRIP_HEIGHT) throw new Error(`a frame ${h} px tall can't be shown (at most ${MAX_STRIP_HEIGHT})`);
  const { scale: s, columns, rows, shown, gap } = previewLayout(frames.length, w, h, scale);
  const png = new PNG({ width: columns * w * s + (columns - 1) * gap, height: rows * h * s + (rows - 1) * gap });
  png.data.fill(0);
  const W = png.width;
  frames.slice(0, shown).forEach((f, i) => {
    const ox = (i % columns) * (w * s + gap), oy = Math.floor(i / columns) * (h * s + gap);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const src = (y * w + x) * 3;
        for (let dy = 0; dy < s; dy++) {
          let dst = ((oy + y * s + dy) * W + ox + x * s) * 4;
          for (let dx = 0; dx < s; dx++, dst += 4) {
            png.data[dst] = f[src] ?? 0;
            png.data[dst + 1] = f[src + 1] ?? 0;
            png.data[dst + 2] = f[src + 2] ?? 0;
            png.data[dst + 3] = 255;
          }
        }
      }
    }
  });
  return PNG.sync.write(png);
}

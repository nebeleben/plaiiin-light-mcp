export interface Grid { w: number; h: number }

export const MAX_GRID_SIDE = 4096;
export const MAX_GRID_PIXELS = 65535;

/**
 * A lamp-reported (or fleet-cached) logical grid, sanity-checked before anything is sized from it:
 * a broken or hostile lamp must not make this server allocate gigabytes.
 */
export function checkGrid(g: Grid): Grid {
  const { w, h } = g;
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1
    || w > MAX_GRID_SIDE || h > MAX_GRID_SIDE || w * h > MAX_GRID_PIXELS) {
    throw new Error(`the lamp reports grid ${w}×${h}, which can't be right (at most ${MAX_GRID_SIDE} px a side and ${MAX_GRID_PIXELS} pixels)`);
  }
  return { w, h };
}

/** `GET /api` logical size, checked; undefined when the lamp reports none. */
export function apiGrid(a: { logicalW?: number; logicalH?: number } | undefined): Grid | undefined {
  return a?.logicalW && a.logicalH ? checkGrid({ w: a.logicalW, h: a.logicalH }) : undefined;
}

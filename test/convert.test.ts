import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { toGrid, toPng } from '../src/images/convert';

let dir: string | undefined;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });
const tmp = () => (dir = mkdtempSync(join(tmpdir(), 'lamp-mcp-conv-')));

function writePng(file: string, w: number, h: number, px: (x: number, y: number) => [number, number, number, number]): void {
  const png = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r, g, b, a] = px(x, y); const i = (y * w + x) * 4;
    png.data[i] = r; png.data[i + 1] = g; png.data[i + 2] = b; png.data[i + 3] = a;
  }
  writeFileSync(file, PNG.sync.write(png));
}

describe('toGrid', () => {
  it('turns a 2×2 hex / rgb grid into 12 bytes row-major RGB', () => {
    const out = toGrid({ pixels: [['#ff0000', [0, 255, 0]], ['#0000FF', '#010203']] }, 2, 2);
    expect([...out]).toEqual([255, 0, 0, 0, 255, 0, 0, 0, 255, 1, 2, 3]);
  });

  it('refuses a grid of the wrong size', () => {
    expect(() => toGrid({ pixels: [['#ff0000', '#ff0000']] }, 2, 2)).toThrow('needs a 2×2 grid');
    expect(() => toGrid({ pixels: [['#ff0000'], ['#ff0000']] }, 2, 2)).toThrow('needs a 2×2 grid');
  });

  it('refuses a bad colour', () => {
    expect(() => toGrid({ pixels: [['red']] }, 1, 1)).toThrow(/colour/);
    expect(() => toGrid({ pixels: [[[0, 300, 0]]] }, 1, 1)).toThrow(/colour/);
  });

  it('resizes a 4×4 PNG to 2×2 with a box filter', () => {
    const f = join(tmp(), 'a.png');
    // quadrants: TL red, TR green, BL blue, BR alternating white/black (avg 127.5 → 128)
    writePng(f, 4, 4, (x, y) => {
      if (x < 2 && y < 2) return [255, 0, 0, 255];
      if (x >= 2 && y < 2) return [0, 255, 0, 255];
      if (x < 2) return [0, 0, 255, 255];
      return (x + y) % 2 ? [255, 255, 255, 255] : [0, 0, 0, 255];
    });
    expect([...toGrid({ pngPath: f }, 2, 2)]).toEqual([255, 0, 0, 0, 255, 0, 0, 0, 255, 128, 128, 128]);
  });

  it('composites transparency over black', () => {
    const f = join(tmp(), 't.png');
    writePng(f, 1, 1, () => [255, 255, 255, 0]);
    expect([...toGrid({ pngPath: f }, 1, 1)]).toEqual([0, 0, 0]);
  });

  it('refuses a PNG larger than 4096 px before decoding', () => {
    const f = join(tmp(), 'big.png');
    // A valid signature + IHDR claiming 5000×10, no image data: must be refused from the header alone.
    const head = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0);
    head.writeUInt32BE(13, 8); head.write('IHDR', 12, 'ascii'); head.writeUInt32BE(5000, 16); head.writeUInt32BE(10, 20);
    writeFileSync(f, head);
    expect(() => toGrid({ pngPath: f }, 2, 2)).toThrow('PNG is 5000×10 px; at most 4096×4096');
  });

  it('refuses an interlaced PNG before decoding', () => {
    const f = join(tmp(), 'i.png');
    // signature + IHDR 2×2, 8-bit RGBA, interlace = 1, and no data: refused from the header alone.
    const head = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0);
    head.writeUInt32BE(13, 8); head.write('IHDR', 12, 'ascii'); head.writeUInt32BE(2, 16); head.writeUInt32BE(2, 20);
    head[24] = 8; head[25] = 6; head[28] = 1;
    writeFileSync(f, head);
    expect(() => toGrid({ pngPath: f }, 2, 2)).toThrow("interlaced PNGs aren't supported — save it non-interlaced");
  });

  it('refuses a file that is not a PNG', () => {
    const f = join(tmp(), 'x.png');
    writeFileSync(f, 'hello');
    expect(() => toGrid({ pngPath: f }, 2, 2)).toThrow('not a PNG file');
  });
});

describe('toPng', () => {
  it('scales a small image up, never beyond 1024 px', () => {
    const px = new Uint8Array(16 * 8 * 3).fill(9);
    const a = PNG.sync.read(toPng(px, 16, 8));
    expect(a.width).toBeGreaterThanOrEqual(256);
    expect(a.width / 16).toBe(a.height / 8);
    const big = PNG.sync.read(toPng(new Uint8Array(2000 * 10 * 3), 2000, 10));
    expect(Math.max(big.width, big.height)).toBeLessThanOrEqual(1024);
  });
});

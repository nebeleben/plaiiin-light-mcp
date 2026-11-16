import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { inspectScript, renderFrames } from '../src/preview/shade';
import { framesToPng, previewLayout } from '../src/preview/png';

const RED = 'function shade(x, y, idx, frame, base, params) { emit(255, 0, 0); }';
const one = { w: 1, h: 1, frames: 1, fps: 10 };

describe('renderFrames', () => {
  it('renders an all-red script into w*h*3 frames', async () => {
    const frames = await renderFrames(RED, { w: 4, h: 3, frames: 5, fps: 10 });
    expect(frames).toHaveLength(5);
    for (const f of frames) {
      expect(f).toBeInstanceOf(Uint8Array);
      expect(f.length).toBe(4 * 3 * 3);
      for (let i = 0; i < f.length; i += 3) expect([f[i], f[i + 1], f[i + 2]]).toEqual([255, 0, 0]);
    }
  });

  it('applies @param defaults and overrides, base color, frame and time (ms)', async () => {
    const src = [
      '// @param level 0..255 = 10 brightness',
      'function shade(x, y, idx, frame, base, params) { emit(params.level, frame, (time / 100) | 0); }',
    ].join('\n');
    const def = await renderFrames(src, { w: 1, h: 1, frames: 3, fps: 10 });
    expect([...def[2]!]).toEqual([10, 2, 2]);         // frame 2 at 10 fps = 200 ms
    const ov = await renderFrames(src, { ...one, params: { level: 99 } });
    expect([...ov[0]!]).toEqual([99, 0, 0]);
    const bright = await renderFrames('function shade(){ emitBright(1); }', { ...one, base: { r: 1, g: 2, b: 3 } });
    expect([...bright[0]!]).toEqual([1, 2, 3]);
  });

  it('rejects with the syntax error', async () => {
    await expect(renderFrames('function shade( {', { w: 2, h: 2, frames: 1, fps: 10 })).rejects.toThrow(/SyntaxError|Unexpected/);
    await expect(renderFrames('var x = 1;', { w: 2, h: 2, frames: 1, fps: 10 })).rejects.toThrow(/shade/);
  });

  it('inspectScript lists params and state', async () => {
    const info = await inspectScript('// @param speed 0..5 = 1 how fast\n// @state t : 0\nfunction shade(){}');
    expect(info.params).toEqual([{ name: 'speed', min: 0, max: 5, def: 1, desc: 'how fast', type: 'range' }]);
    expect(info.frameState).toEqual([{ name: 't', def: 0 }]);
  });
});

describe('preview sandbox (scripts are untrusted)', () => {
  it('an endless loop times out', async () => {
    await expect(renderFrames('function shade(){ for(;;){} }', { ...one, timeoutMs: 200 })).rejects.toThrow(/timed out/);
  });

  it('constructor chains lead nowhere outside the sandbox', async () => {
    const attempts = [
      "var g = (function(){ return this; })(); var P = g.constructor.constructor('return typeof process')();",
      "var P = emit.constructor('return typeof process')();",
      "var P = ({}).constructor.constructor('return typeof process')();",
      "var P = (function(){ try { null.x } catch(e) { return e.constructor.constructor('return typeof process')(); } })();",
    ];
    for (const a of attempts) {
      const f = await renderFrames(`${a} function shade(){ emit(P === 'undefined' ? 255 : 0, 0, 0); }`, one);
      expect(f[0]![0], a).toBe(255);
    }
  });

  it('require, process and import are unavailable to the script', async () => {
    const f = await renderFrames(
      "var R = typeof require, P = typeof process, M = typeof module;\n" +
      "function shade(){ emit(R === 'undefined' && P === 'undefined' && M === 'undefined' ? 255 : 0, 0, 0); }", one);
    expect(f[0]![0]).toBe(255);
    await expect(renderFrames("var fs = require('fs'); function shade(){ emit(1,1,1); }", one)).rejects.toThrow(/require is not defined/);
  });

  it('a getter on a thrown object that loops forever is killed by the watchdog', async () => {
    const thrown = "JSON.stringify = function(){ return '{}'; }; throw { get message(){ for(;;){} }, get name(){ for(;;){} } };";
    // a getter the worker's own code reads after the vm call returned (outside the vm timeout)
    const proto = "Object.defineProperty(Object.prototype, 'error', { get: function(){ for(;;){} } }); function shade(){ emit(1,1,1); }";
    for (const src of [thrown, proto]) {
      const t0 = Date.now();
      await expect(renderFrames(src, { ...one, timeoutMs: 200 })).rejects.toThrow(/timed out/);
      expect(Date.now() - t0).toBeLessThan(5000);
    }
  });

  it('typed arrays, ArrayBuffer, Wasm and friends are gone from the script\'s world', async () => {
    const names = ['ArrayBuffer', 'SharedArrayBuffer', 'DataView', 'Atomics', 'WebAssembly', 'Int8Array', 'Uint8Array',
      'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array',
      'BigInt64Array', 'BigUint64Array', 'Buffer'];
    const f = await renderFrames(
      `var N = ${JSON.stringify(names)}, bad = 0; for (var i = 0; i < N.length; i++) if (typeof globalThis[N[i]] !== 'undefined') bad++;\n` +
      "function shade(){ emit(bad === 0 ? 255 : bad, 0, 0); }", one);
    expect(f[0]![0]).toBe(255);
  });

  it('a Uint8Array bomb and a 1 GB ArrayBuffer fail fast with an error, and previews still work', async () => {
    for (const bomb of [
      'var a = []; for(;;) a.push(new Uint8Array(1e8).fill(1)); function shade(){}',
      'var b = new ArrayBuffer(1e9); function shade(){}',
    ]) {
      const t0 = Date.now();
      await expect(renderFrames(bomb, { ...one, timeoutMs: 20000 })).rejects.toThrow(/ReferenceError: (Uint8Array|ArrayBuffer) is not defined/);
      expect(Date.now() - t0).toBeLessThan(3000);
    }
    expect([...(await renderFrames(RED, one))[0]!]).toEqual([255, 0, 0]);
  });

  it('a memory bomb fails on its own and later previews still work', async () => {
    const bomb = "var a = []; for(;;) a.push(new Array(1e6).fill(1.5)); function shade(){}";
    await expect(renderFrames(bomb, { ...one, timeoutMs: 20000 })).rejects.toThrow(/out of memory/);
    expect([...(await renderFrames(RED, one))[0]!]).toEqual([255, 0, 0]);
  }, 30000);
});

describe('preview picture', () => {
  const blank = (w: number, h: number) => new Uint8Array(w * h * 3);
  const solid = (w: number, h: number, r: number, g: number, b: number) => { const f = blank(w, h); for (let i = 0; i < f.length; i += 3) { f[i] = r; f[i + 1] = g; f[i + 2] = b; } return f; };
  const px = (png: PNG, x: number, y: number) => [...png.data.subarray((y * png.width + x) * 4, (y * png.width + x) * 4 + 4)];
  const size = (frames: Uint8Array[], w: number, h: number, scale?: number) => { const p = PNG.sync.read(framesToPng(frames, w, h, scale)); return [p.width, p.height]; };

  it('enlarges each frame so it can be looked at: about 192 px on its long side', () => {
    // a 16×16 panel used to come out as 32 px frames — too small to judge an effect by
    expect(previewLayout(8, 16, 16)).toEqual({ scale: 12, columns: 5, rows: 2, shown: 8, gap: 6 });
    expect(size(Array(8).fill(blank(16, 16)), 16, 16)).toEqual([5 * 192 + 4 * 6, 2 * 192 + 6]);
    expect(previewLayout(8, 16, 8)).toMatchObject({ scale: 12, columns: 5, rows: 2, shown: 8 });      // tower: 192×96 frames
    expect(previewLayout(2, 8, 8)).toMatchObject({ scale: 24, columns: 2, rows: 1, shown: 2 });       // cube face
    expect(previewLayout(1, 64, 64)).toMatchObject({ scale: 3, columns: 1, rows: 1, shown: 1 });
  });

  it('wraps into rows about 1024 px wide instead of one long strip', () => {
    expect(previewLayout(16, 16, 16)).toMatchObject({ scale: 12, columns: 5, rows: 4, shown: 16 });
    const [width, height] = size(Array(16).fill(blank(16, 16)), 16, 16);
    expect(width).toBeLessThanOrEqual(1024);
    expect(height).toBe(4 * 192 + 3 * 6);
  });

  it('puts the frames in reading order, apart; gaps and unused cells stay transparent', () => {
    const frames = [0, 1, 2, 3, 4, 5].map((i) => solid(16, 16, 40 * i + 10, 0, 0));
    const png = PNG.sync.read(framesToPng(frames, 16, 16));     // 5 per row → frame 5 starts the second row
    const cell = 192 + 6;
    expect(px(png, 0, 0)).toEqual([10, 0, 0, 255]);
    expect(px(png, 191, 191)).toEqual([10, 0, 0, 255]);
    expect(px(png, 193, 50)[3]).toBe(0);                          // the gap between frame 0 and 1
    expect(px(png, cell, 0)).toEqual([50, 0, 0, 255]);
    expect(px(png, 4 * cell + 5, 100)).toEqual([170, 0, 0, 255]);
    expect(px(png, 3, cell + 3)).toEqual([210, 0, 0, 255]);
    expect(px(png, cell + 3, cell + 3)[3]).toBe(0);               // no seventh frame
  });

  it('keeps an explicit scale, nearest-neighbour', async () => {
    const frames = await renderFrames(RED, { w: 4, h: 2, frames: 3, fps: 10 });
    const png = PNG.sync.read(framesToPng(frames, 4, 2, 5));
    expect(previewLayout(3, 4, 2, 5)).toEqual({ scale: 5, columns: 3, rows: 1, shown: 3, gap: 3 });
    expect([png.width, png.height]).toEqual([3 * 20 + 2 * 3, 10]);
    expect(px(png, 0, 0)).toEqual([255, 0, 0, 255]);
  });

  it('gives a one-pixel-high strip lamp some height', () => {
    expect(previewLayout(8, 128, 1)).toEqual({ scale: 8, columns: 1, rows: 8, shown: 8, gap: 4 });   // 1024×8 per frame, one per row
    expect(size(Array(8).fill(blank(128, 1)), 128, 1)).toEqual([1024, 8 * 8 + 7 * 4]);
  });

  it('never exceeds 4096 px either way: frames that do not fit are left out', () => {
    const l = previewLayout(100, 256, 256);
    expect(l).toMatchObject({ scale: 1, columns: 3, shown: 45 });
    const [width, height] = size(Array(100).fill(blank(256, 256)), 256, 256);
    expect(width).toBeLessThanOrEqual(4096);
    expect(height).toBeLessThanOrEqual(4096);
    expect(size([blank(4096, 1)], 4096, 1, 8)[0]).toBe(4096);          // scale lowered
    expect(() => framesToPng([blank(16384, 1)], 16384, 1)).toThrow(/16384 px wide/);
    expect(() => framesToPng([], 4, 4)).toThrow(/no frames/);
  });
});

describe('vendored shade runtime', () => {
  it('check-vendor passes on a clean tree (identical when the canonical file exists)', () => {
    const out = execFileSync(process.execPath, [join(__dirname, '..', 'scripts', 'check-vendor.mjs')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (existsSync(join(__dirname, '..', '..', 'lampos', 'portal', 'shade-runtime.js'))) expect(out).toMatch(/is identical to/);
  });
});

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { inspectScript, renderFrames } from '../src/preview/shade';
import { framesToPngStrip } from '../src/preview/png';

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

describe('framesToPngStrip', () => {
  it('puts the frames side by side, nearest-neighbour scaled', async () => {
    const frames = await renderFrames(RED, { w: 4, h: 2, frames: 3, fps: 10 });
    const png = PNG.sync.read(framesToPngStrip(frames, 4, 2, 5));
    expect(png.width).toBe(4 * 3 * 5);
    expect(png.height).toBe(2 * 5);
    expect([...png.data.subarray(0, 4)]).toEqual([255, 0, 0, 255]);
  });

  it('defaults to a scale that makes the strip at least 256 px wide', () => {
    const f = new Uint8Array(8 * 8 * 3);
    const png = PNG.sync.read(framesToPngStrip([f, f], 8, 8));
    expect(png.width).toBeGreaterThanOrEqual(256);
    expect(png.width % 16).toBe(0);
    expect(png.height).toBe(png.width / 2);
  });

  it('never exceeds 4096 px: frames that do not fit are left out', () => {
    const w = 256, f = new Uint8Array(w * 1 * 3);
    const png = PNG.sync.read(framesToPngStrip(Array(60).fill(f), w, 1));
    expect(png.width).toBeLessThanOrEqual(4096);
    expect(png.width % w).toBe(0);
    expect(PNG.sync.read(framesToPngStrip(Array(60).fill(f), w, 1, 3)).width).toBeLessThanOrEqual(4096);
    expect(PNG.sync.read(framesToPngStrip([new Uint8Array(4096 * 3)], 4096, 1, 8)).width).toBe(4096); // scale lowered
    expect(() => framesToPngStrip([new Uint8Array(16384 * 3)], 16384, 1)).toThrow(/16384 px wide/);
  });

  it('never exceeds 4096 px in height either: scale from both sides, too-tall frames refused', () => {
    const tall = PNG.sync.read(framesToPngStrip([new Uint8Array(1 * 2048 * 3)], 1, 2048));
    expect(tall.height).toBeLessThanOrEqual(4096);
    expect(PNG.sync.read(framesToPngStrip([new Uint8Array(1 * 1024 * 3)], 1, 1024, 8)).height).toBe(4096); // scale lowered
    expect(() => framesToPngStrip([new Uint8Array(16384 * 3)], 1, 16384)).toThrow(/16384 px tall/);
  });

  it('keeps distinct pixels where they are', () => {
    const f = new Uint8Array([10, 20, 30, 40, 50, 60]); // 2x1
    const png = PNG.sync.read(framesToPngStrip([f], 2, 1, 2));
    const px = (x: number, y: number) => [...png.data.subarray((y * png.width + x) * 4, (y * png.width + x) * 4 + 3)];
    expect(px(0, 0)).toEqual([10, 20, 30]);
    expect(px(1, 1)).toEqual([10, 20, 30]);
    expect(px(2, 0)).toEqual([40, 50, 60]);
    expect(px(3, 1)).toEqual([40, 50, 60]);
  });
});

describe('vendored shade runtime', () => {
  it('check-vendor passes on a clean tree (identical when the canonical file exists)', () => {
    const out = execFileSync(process.execPath, [join(__dirname, '..', 'scripts', 'check-vendor.mjs')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (existsSync(join(__dirname, '..', '..', 'lampos', 'portal', 'shade-runtime.js'))) expect(out).toMatch(/is identical to/);
  });
});

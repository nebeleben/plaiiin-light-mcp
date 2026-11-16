import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { GifWriter } from 'omggif';
import { PNG } from 'pngjs';
import { countGifFrames, encodeColorFrame, frameSource } from '../src/stream/sources';
import { makeHarness, type Harness } from './harness';

let h: Harness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });
const tmp = mkdtempSync(join(tmpdir(), 'lamp-mcp-stream-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
};

/** A GIF with one solid-colour frame per entry (palette index per frame). */
function gif(path: string, w: number, h: number, colors: number[][], frames = colors.length): void {
  const buf = Buffer.alloc(1024 + frames * (w * h + 64));
  const palette = [0]; // index 0 = black; padded to a power of two below
  for (const c of colors) palette.push((c[0]! << 16) | (c[1]! << 8) | c[2]!);
  while (palette.length & (palette.length - 1)) palette.push(0);
  const g = new GifWriter(buf, w, h, { palette, loop: 0 });
  for (let f = 0; f < frames; f++) g.addFrame(0, 0, Math.min(w, 4), Math.min(h, 4), new Array(Math.min(w, 4) * Math.min(h, 4)).fill(1 + (f % colors.length)), { delay: 10 });
  writeFileSync(path, buf.subarray(0, g.end()));
}

function png(path: string, rgb: [number, number, number]): void {
  const p = new PNG({ width: 2, height: 2 });
  for (let i = 0; i < 4; i++) p.data.set([...rgb, 255], i * 4);
  writeFileSync(path, PNG.sync.write(p));
}

describe('encodeColorFrame', () => {
  it('prefixes 0x01 and the big-endian LED count', () => {
    expect([...encodeColorFrame(new Uint8Array([1, 2, 3, 4, 5, 6]))]).toEqual([0x01, 0x00, 0x02, 1, 2, 3, 4, 5, 6]);
  });
  it('counts above 255 use both bytes', () => {
    const b = encodeColorFrame(new Uint8Array(300 * 3));
    expect([b[0], b[1], b[2]]).toEqual([0x01, 0x01, 0x2c]);
  });
});

describe('frameSource', () => {
  it('a script renders w*h*3 bytes per frame in the sandbox', async () => {
    const src = frameSource({ script: 'function shade(x, y, idx, frame) { emit(frame, 0, 0); }' }, 3, 2, 10);
    const f = await src(0);
    expect(f.length).toBe(3 * 2 * 3);
    expect(f[0]).toBe(0);
    expect((await src(1))[0]).toBe(1);
    const later = await src(75); // a later batch keeps the frame count going
    expect(later.length).toBe(18);
    expect(later[0]).toBe(75);
  });

  it('a GIF is resized to the grid and loops', async () => {
    const p = join(tmp, 'two.gif');
    gif(p, 4, 4, [[255, 0, 0], [0, 0, 255]]);
    const src = frameSource({ gifPath: p }, 2, 2, 10);
    const f0 = await src(0), f1 = await src(1), f2 = await src(2);
    expect([...f0.subarray(0, 3)]).toEqual([255, 0, 0]);
    expect([...f1.subarray(0, 3)]).toEqual([0, 0, 255]);
    expect([...f2]).toEqual([...f0]);
    expect(f0.length).toBe(12);
  });

  it('a GIF with a logical screen above 4096 px is refused before decoding', () => {
    const p = join(tmp, 'wide.gif');
    gif(p, 5000, 4, [[1, 2, 3]]);
    expect(() => frameSource({ gifPath: p }, 2, 2, 10)).toThrow(/5000×4.*4096/);
  });

  it('a GIF with more than 1000 frames is refused before decoding', () => {
    const p = join(tmp, 'long.gif');
    gif(p, 4, 4, [[1, 2, 3]], 1001);
    expect(() => frameSource({ gifPath: p }, 2, 2, 10)).toThrow(/more than 1000 frames/);
  });

  it('image descriptors are counted by walking the blocks, stopping past the limit', () => {
    const p2 = join(tmp, 'count2.gif'), pl = join(tmp, 'count-long.gif');
    gif(p2, 4, 4, [[1, 2, 3], [4, 5, 6]]);
    gif(pl, 4, 4, [[1, 2, 3]], 1500);
    expect(countGifFrames(readFileSync(p2), 1000)).toBe(2);
    expect(countGifFrames(readFileSync(pl), 1000)).toBe(1001);
  });

  it('PNG files play in order and loop', async () => {
    const a = join(tmp, 'a.png'), b = join(tmp, 'b.png');
    png(a, [10, 20, 30]); png(b, [40, 50, 60]);
    const src = frameSource({ pngPaths: [a, b] }, 1, 1, 10);
    expect([...await src(0)]).toEqual([10, 20, 30]);
    expect([...await src(1)]).toEqual([40, 50, 60]);
    expect([...await src(2)]).toEqual([10, 20, 30]);
  });
});

describe('stream tools', () => {
  const script = 'function shade() { emit(0, 255, 0); }';

  it('streams colour frames over /ws, then stream_stop sends clear; the token never shows', async () => {
    const t = (h = await makeHarness());
    const a = await t.addFake({ deviceId: 'aaaaaaaaaaaa', name: 'Alpha', role: 'ai', perms: ['stream'], grid: { w: 2, h: 2 } });
    const text = await t.raw('stream_start', { lamps: 'Alpha', source: { script }, fps: 10, seconds: 0.3 });
    expect(text).not.toContain(a.token);
    const r = JSON.parse(text);
    expect(r.streamId).toMatch(/^s-/);
    expect(r.results[0]).toMatchObject({ lamp: 'Alpha', ok: true, grid: { w: 2, h: 2 } });
    await until(() => a.state.wsFrames.filter((f) => f[0] === 0x01).length >= 2);
    const color = a.state.wsFrames.find((f) => f[0] === 0x01)!;
    expect([...color]).toEqual([0x01, 0x00, 0x04, 0, 255, 0, 0, 255, 0, 0, 255, 0, 0, 255, 0]);
    const listed = await t.raw('streams_list');
    expect(listed).not.toContain(a.token);
    const stop = await t.call('stream_stop', { streamId: r.streamId });
    expect(stop.stopped).toEqual([r.streamId]);
    await until(() => a.state.wsFrames.some((f) => f.length === 1 && f[0] === 0x03));
    expect((await t.call('streams_list')).streams).toEqual([]);
  });

  it('stream_stop without an id stops every stream', async () => {
    const t = (h = await makeHarness());
    const a = await t.addFake({ deviceId: 'aaaaaaaaaaaa', name: 'Alpha', grid: { w: 1, h: 1 } });
    const r1 = await t.call('stream_start', { lamps: 'Alpha', source: { script }, fps: 5, seconds: 30 });
    const list = await t.call('streams_list');
    expect(list.streams).toHaveLength(1);
    expect(list.streams[0]).toMatchObject({ streamId: r1.streamId, fps: 5, lamps: [{ lamp: 'Alpha', state: 'streaming' }] });
    const stop = await t.call('stream_stop', {});
    expect(stop.stopped).toEqual([r1.streamId]);
    await until(() => a.state.wsFrames.some((f) => f[0] === 0x03));
  });

  it('stream_stop returns promptly when the lamp never takes the clear frame', async () => {
    const t = (h = await makeHarness());
    await t.addFake({ deviceId: 'aaaaaaaaaaaa', name: 'Alpha', grid: { w: 1, h: 1 } });
    const r = await t.call('stream_start', { lamps: 'Alpha', source: { script }, fps: 5, seconds: 30 });
    const real = WebSocket.prototype.send;
    // A stalled lamp: the clear frame's send callback never fires.
    const spy = vi.spyOn(WebSocket.prototype, 'send').mockImplementation(function (this: WebSocket, data: any, ...rest: any[]) {
      if (Buffer.isBuffer(data) && data.length === 1 && data[0] === 0x03) return;
      return (real as any).call(this, data, ...rest);
    });
    try {
      const t0 = Date.now();
      const stop = await t.call('stream_stop', { streamId: r.streamId });
      expect(stop.stopped).toEqual([r.streamId]);
      expect(Date.now() - t0).toBeLessThan(2000);
    } finally {
      spy.mockRestore();
    }
  });

  it('two concurrent starts to one lamp leave exactly one connection streaming', async () => {
    const t = (h = await makeHarness());
    await t.addFake({ deviceId: 'aaaaaaaaaaaa', name: 'Alpha', grid: { w: 1, h: 1 } });
    const args = { lamps: 'Alpha', source: { script }, fps: 5, seconds: 30 };
    const [a, b] = await Promise.all([t.call('stream_start', args), t.call('stream_start', args)]);
    expect([a.results[0].ok, b.results[0].ok]).toEqual([true, true]);
    const streaming = (await t.call('streams_list')).streams.flatMap((s: any) => s.lamps).filter((l: any) => l.state === 'streaming');
    expect(streaming).toHaveLength(1);
    expect([a.results[0].replaced, b.results[0].replaced].filter(Boolean)).toHaveLength(1);
    await t.call('stream_stop', {});
  });

  it('a stop during a slow render returns without waiting for it', async () => {
    const t = (h = await makeHarness());
    const lamp = await t.addFake({ deviceId: 'aaaaaaaaaaaa', name: 'Alpha', grid: { w: 1, h: 1 } });
    // Batch 0 (frames 0–9 at 5 fps) is quick; every frame of batch 1 burns 280 ms, so frame 10 is
    // still rendering well after it is due at 2 s.
    const slow = 'function shade(x, y, idx, frame) { if (frame >= 10) { var e = Date.now() + 280; while (Date.now() < e) {} } emit(1, 2, 3); }';
    const r = await t.call('stream_start', { lamps: 'Alpha', source: { script: slow }, fps: 5, seconds: 30 });
    expect(r.results[0].ok).toBe(true);
    await until(() => lamp.state.wsFrames.filter((f) => f[0] === 0x01).length >= 10, 4000);
    await new Promise((res) => setTimeout(res, 300));
    const t0 = Date.now();
    await t.call('stream_stop', { streamId: r.streamId });
    expect(Date.now() - t0).toBeLessThan(300);
  }, 10000);

  it('an AI key without `stream` is refused before connecting', async () => {
    const t = (h = await makeHarness());
    const a = await t.addFake({ deviceId: 'aaaaaaaaaaaa', name: 'Alpha', role: 'ai', perms: ['control'], grid: { w: 2, h: 2 } });
    const r = await t.call('stream_start', { lamps: 'Alpha', source: { script } });
    expect(r.results[0]).toMatchObject({ ok: false, skipped: true, reason: "not permitted by this lamp's AI key (needs stream)" });
    expect(a.state.wsConnections + a.state.wsRefused).toBe(0);
    expect(r.streamId).toBeUndefined();
  });

  it('a lamp that closes right after the upgrade is reported as refused', async () => {
    const t = (h = await makeHarness());
    const a = await t.addFake({ deviceId: 'aaaaaaaaaaaa', name: 'Alpha', role: 'ai', perms: ['stream'], onlyWhenOn: true, grid: { w: 2, h: 2 } });
    const r = await t.call('stream_start', { lamps: 'Alpha', source: { script } });
    expect(a.state.wsRefused).toBe(1);
    expect(r.results[0].ok).toBe(false);
    expect(r.results[0].reason).toMatch(/closed the stream/);
  });

  it('a bad source file fails before any lamp is touched', async () => {
    const t = (h = await makeHarness());
    const a = await t.addFake({ deviceId: 'aaaaaaaaaaaa', name: 'Alpha', grid: { w: 2, h: 2 } });
    const r = await t.call('stream_start', { lamps: 'Alpha', source: { gifPath: join(tmp, 'missing.gif') } });
    expect(r.ok).toBe(false);
    expect(a.state.wsConnections).toBe(0);
  });
});

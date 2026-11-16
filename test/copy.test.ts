import { afterEach, describe, expect, it } from 'vitest';
import { LampClient } from '../src/lamp/client';
import { copyImage, copyScene, copyScript } from '../src/sync/copy';
import { startFakeLamp, type FakeLamp } from './fakeLamp';

let lamps: FakeLamp[] = [];
let clients: LampClient[] = [];
afterEach(async () => {
  for (const c of clients) c.destroy();
  for (const l of lamps) await l.close();
  lamps = []; clients = [];
});
async function lamp(grid = { w: 2, h: 2 }) {
  const l = await startFakeLamp({ deviceId: 'aaaaaaaaaaaa', name: 'Alpha', grid });
  const c = new LampClient({ host: '127.0.0.1', port: l.port, token: l.token });
  lamps.push(l); clients.push(c);
  return { l, c };
}
const px = (v: number, n = 12) => new Uint8Array(n).fill(v);
const count = (l: FakeLamp, method: string, path: string) => l.state.requests.filter((r) => r.method === method && r.path === path).length;

describe('copyImage', () => {
  it('posts the frame, saves, then restores the previous frame', async () => {
    const { l, c } = await lamp();
    l.state.frame = Buffer.from(px(7));
    const id = await copyImage(c, { w: 2, h: 2, pixels: px(200), label: 'Heart' });
    expect(id).toBe('img-001');
    expect(l.state.frames.map((f) => [...f])).toEqual([[...px(200)], [...px(7)]]);
    expect(l.state.frame).toEqual(Buffer.from(px(7)));
    expect(l.state.images.get('img-001')).toMatchObject({ w: 2, h: 2, label: 'Heart', data: Buffer.from(px(200)) });
  });

  it('restores the previous frame when saving fails', async () => {
    const { l, c } = await lamp();
    l.state.frame = Buffer.from(px(7));
    for (let i = 1; i <= 30; i++) l.state.images.set(`img-${String(i).padStart(3, '0')}`, { w: 1, h: 1, data: Buffer.from([i, 0, 0]) });
    await expect(copyImage(c, { w: 2, h: 2, pixels: px(200) })).rejects.toThrow(/image store full/);
    expect(l.state.frame).toEqual(Buffer.from(px(7)));
  });

  it('dedupes: the same image twice returns the same id and saves once', async () => {
    const { l, c } = await lamp();
    const img = { w: 2, h: 2, pixels: px(200), label: 'Heart' };
    const a = await copyImage(c, img);
    const b = await copyImage(c, img);
    expect(b).toBe(a);
    expect(count(l, 'POST', '/api/images')).toBe(1);
    // different label → a new image
    expect(await copyImage(c, { ...img, label: 'Other' })).not.toBe(a);
  });

  it('without a previous frame nothing is restored', async () => {
    const { l, c } = await lamp();
    await copyImage(c, { w: 2, h: 2, pixels: px(200) });
    expect(l.state.frames.length).toBe(1);
  });
});

describe('copyScript', () => {
  it('writes the source and the tunes', async () => {
    const { l, c } = await lamp();
    await copyScript(c, { name: 'mine', source: '// @param speed 0..10 = 3\nfunction shade(){}', params: { speed: 7 } });
    expect(l.state.effects.get('mine')).toContain('function shade');
    expect(l.state.params.get('mine')).toEqual({ speed: 7 });
  });

  it('without source the target must have it', async () => {
    const { l, c } = await lamp();
    await copyScript(c, { name: 'rainbow', params: { speed: 2 } });
    expect(l.state.params.get('rainbow')).toEqual({ speed: 2 });
    await expect(copyScript(c, { name: 'nope' })).rejects.toThrow("script nope isn't on this lamp");
  });
});

describe('copyScene', () => {
  it('copies the image, rewrites the scene to the new id and drops `on`', async () => {
    const { l, c } = await lamp();
    l.state.images.set('img-001', { w: 1, h: 1, data: Buffer.from([1, 2, 3]) });
    const warnings = await copyScene(c, { w: 2, h: 2 }, {
      name: 'cozy', scene: { on: true, mode: 'frame', image: 'img-009', brightness: 40 },
      image: { w: 2, h: 2, pixels: px(50), label: 'Pic' },
    });
    expect(warnings).toEqual([]);
    expect(l.state.scenes.get('cozy')).toEqual({ mode: 'frame', image: 'img-002', brightness: 40 });
  });

  it('skips an image for another grid with a warning, scene written without image and without on', async () => {
    const { l, c } = await lamp({ w: 2, h: 2 });
    const warnings = await copyScene(c, { w: 2, h: 2 }, {
      name: 'cozy', scene: { on: false, mode: 'frame', image: 'img-001', brightness: 40 },
      image: { w: 4, h: 1, pixels: px(50), label: 'Pic' },
    });
    expect(warnings).toEqual(['image not copied (needs a 4×1 lamp)']);
    expect(l.state.scenes.get('cozy')).toEqual({ mode: 'frame', brightness: 40 });
    expect(l.state.images.size).toBe(0);
  });

  it('a scene image without pixels is dropped with "image not copied"', async () => {
    const { l, c } = await lamp();
    const warnings = await copyScene(c, { w: 2, h: 2 }, { name: 's', scene: { image: 'img-001' } });
    expect(warnings).toEqual(['image not copied']);
    expect(l.state.scenes.get('s')).toEqual({});
  });

  it('takes its script along', async () => {
    const { l, c } = await lamp();
    await copyScene(c, { w: 2, h: 2 }, {
      name: 'fx', scene: { script: 'mine', params: { speed: 1 } },
      script: { name: 'mine', source: 'function shade(){}', params: { speed: 4 } },
    });
    expect(l.state.effects.get('mine')).toBe('function shade(){}');
    expect(l.state.params.get('mine')).toEqual({ speed: 4 });
    expect(l.state.scenes.get('fx')).toEqual({ script: 'mine', params: { speed: 1 } });
  });
});

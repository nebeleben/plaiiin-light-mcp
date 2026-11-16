import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { makeHarness, type Harness } from './harness';

let h: Harness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });
const harness = async () => (h = await makeHarness());
const grid2 = [['#ff0000', '#00ff00'], ['#0000ff', '#ffffff']];
const RGB2 = [255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255];

describe('image_draw', () => {
  it('a fixed-size pixel grid fits one lamp; the other reports the grid it needs', async () => {
    const t = await harness();
    const a = await t.addFake({ deviceId: 'aaaaaaaaaaaa', name: 'Alpha', grid: { w: 2, h: 2 } });
    const b = await t.addFake({ deviceId: 'bbbbbbbbbbbb', name: 'Beta', grid: { w: 3, h: 1 } });
    const r = await t.call('image_draw', { lamps: ['Alpha', 'Beta'], pixels: grid2, label: 'Quad' });
    expect(r.results[0]).toMatchObject({ lamp: 'Alpha', ok: true, id: 'img-001', saved: true });
    expect(r.results[1]).toMatchObject({ lamp: 'Beta', ok: false, reason: 'needs a 3×1 grid' });
    expect([...a.state.frame!]).toEqual(RGB2);
    expect(a.state.mode).toBe('frame');
    expect(a.state.images.get('img-001')).toMatchObject({ label: 'Quad' });
    expect(b.state.frame).toBeNull();
  });

  it('drawing the same image twice reuses the saved one', async () => {
    const t = await harness();
    const a = await t.addFake({ deviceId: 'aaaaaaaaaaaa', name: 'Alpha', grid: { w: 2, h: 2 } });
    const r1 = await t.call('image_draw', { lamps: 'Alpha', pixels: grid2, label: 'Quad' });
    const r2 = await t.call('image_draw', { lamps: 'Alpha', pixels: grid2, label: 'Quad' });
    expect(r2.results[0]).toMatchObject({ ok: true, saved: true, id: r1.results[0].id, reused: true });
    expect(a.state.images.size).toBe(1);
    expect(r2.results[0].note).toMatch(/replaced the lamp's current drawing/);
  });

  it('a failing show after a successful save still returns the new id', async () => {
    const t = await harness();
    const a = await t.addFake({ deviceId: 'aaaaaaaaaaaa', name: 'Alpha', grid: { w: 2, h: 2 } });
    a.state.override = (_req, res, path) => {
      if (!path.endsWith('/show')) return false;
      res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('boom'); return true;
    };
    const r = await t.call('image_draw', { lamps: 'Alpha', pixels: grid2 });
    expect(r.results[0]).toMatchObject({ ok: true, saved: true, id: 'img-001' });
    expect(r.results[0].warning).toMatch(/saved as img-001 but not shown: boom/);
  });

  it('save=false draws and enters frame mode without saving', async () => {
    const t = await harness();
    const a = await t.addFake({ deviceId: 'aaaaaaaaaaaa', name: 'Alpha', grid: { w: 2, h: 2 } });
    const r = await t.call('image_draw', { lamps: 'Alpha', pixels: grid2, save: false });
    expect(r.results[0]).toMatchObject({ ok: true, saved: false });
    expect(a.state.mode).toBe('frame');
    expect(a.state.images.size).toBe(0);
  });

  it('a PNG is resized to each lamp\'s grid', async () => {
    const t = await harness();
    const a = await t.addFake({ deviceId: 'aaaaaaaaaaaa', name: 'Alpha', grid: { w: 2, h: 2 } });
    const b = await t.addFake({ deviceId: 'bbbbbbbbbbbb', name: 'Beta', grid: { w: 1, h: 1 } });
    const png = new PNG({ width: 4, height: 4 });
    png.data.fill(255);
    const f = join(t.dir, 'w.png');
    writeFileSync(f, PNG.sync.write(png));
    const r = await t.call('image_draw', { lamps: 'all', pngPath: f });
    expect(r.results.every((x: { ok: boolean }) => x.ok)).toBe(true);
    expect(a.state.frame!.length).toBe(12);
    expect([...b.state.frame!]).toEqual([255, 255, 255]);
  });

  it('needs images on AI keys', async () => {
    const t = await harness();
    const ai = await t.addFake({ deviceId: 'ai0000000001', name: 'Desk', role: 'ai', perms: ['control'], grid: { w: 2, h: 2 } });
    const r = await t.call('image_draw', { lamps: 'Desk', pixels: grid2 });
    expect(r.results[0]).toMatchObject({ ok: false, skipped: true, reason: "not permitted by this lamp's AI key (needs images)" });
    expect(ai.state.frame).toBeNull();
  });
});

describe('image management', () => {
  it('images_list, image_show, image_label', async () => {
    const t = await harness();
    const a = await t.addFake({ deviceId: 'aaaaaaaaaaaa', name: 'Alpha', grid: { w: 2, h: 2 } });
    a.state.images.set('img-001', { w: 2, h: 2, label: 'Heart', data: Buffer.from(RGB2) });
    const l = await t.call('images_list', { lamp: 'Alpha' });
    expect(l).toMatchObject({ ok: true, grid: { w: 2, h: 2 }, max: 30, images: [{ id: 'img-001', w: 2, h: 2, label: 'Heart', fitsGrid: true }] });
    expect((await t.call('image_show', { lamps: 'Alpha', id: 'img-001' })).results[0]).toMatchObject({ ok: true });
    expect(a.state.mode).toBe('frame');
    expect(await t.call('image_label', { lamp: 'Alpha', id: 'img-001', label: 'Love' })).toMatchObject({ ok: true, label: 'Love' });
    expect(a.state.images.get('img-001')!.label).toBe('Love');
    expect(await t.raw('image_label', { lamp: 'Alpha', id: 'img-001', label: 'x'.repeat(33) })).toContain('at most 32 bytes');
    expect(await t.call('image_label', { lamp: 'Alpha', id: 'img-001', label: '' })).toMatchObject({ ok: true, label: null });
    expect(a.state.images.get('img-001')!.label).toBeUndefined();
  });

  it('image_delete needs confirmation', async () => {
    const t = await harness();
    const a = await t.addFake({ deviceId: 'aaaaaaaaaaaa', name: 'Alpha', grid: { w: 2, h: 2 } });
    a.state.images.set('img-001', { w: 2, h: 2, data: Buffer.from(RGB2) });
    a.state.images.set('img-002', { w: 2, h: 2, data: Buffer.from(RGB2) });
    const ask = await t.call('image_delete', { lamps: 'Alpha', id: 'img-001' });
    expect(ask).toMatchObject({ needsConfirmation: true });
    expect(a.state.images.has('img-001')).toBe(true);
    // a token for img-001 can't delete img-002
    expect(await t.call('image_delete', { lamps: 'Alpha', id: 'img-002', confirm: ask.confirm })).toMatchObject({ needsConfirmation: true, refused: expect.any(String) });
    expect(a.state.images.has('img-002')).toBe(true);
    const ask2 = await t.call('image_delete', { lamps: 'Alpha', id: 'img-001' });
    const r = await t.call('image_delete', { lamps: 'Alpha', id: 'img-001', confirm: ask2.confirm });
    expect(r.results[0]).toMatchObject({ ok: true, deleted: 'img-001' });
    expect(a.state.images.has('img-001')).toBe(false);
    expect(a.state.images.has('img-002')).toBe(true);
  });

  it('image_delete binds the confirmed lamps: a lamp added after the ask is not deleted from', async () => {
    const t = await harness();
    const a = await t.addFake({ deviceId: 'aaaaaaaaaaaa', name: 'Alpha', grid: { w: 2, h: 2 } });
    a.state.images.set('img-001', { w: 2, h: 2, data: Buffer.from(RGB2) });
    const ask = await t.call('image_delete', { lamps: 'all', id: 'img-001' });
    expect(ask).toMatchObject({ needsConfirmation: true });
    const b = await t.addFake({ deviceId: 'bbbbbbbbbbbb', name: 'Beta', grid: { w: 2, h: 2 } });
    b.state.images.set('img-001', { w: 2, h: 2, data: Buffer.from(RGB2) });
    const r = await t.call('image_delete', { lamps: 'all', id: 'img-001', confirm: ask.confirm });
    expect(r).toMatchObject({ needsConfirmation: true, refused: expect.stringMatching(/invalid, expired/) });
    expect(r.summary).toContain('Beta');
    expect(a.state.images.has('img-001')).toBe(true);
    expect(b.state.images.has('img-001')).toBe(true);
    const done = await t.call('image_delete', { lamps: 'all', id: 'img-001', confirm: r.confirm });
    expect(done.results).toHaveLength(2);
    expect(b.state.images.has('img-001')).toBe(false);
  });

  it('a lamp-reported grid larger than 4096 px a side or 65535 pixels is refused clearly', async () => {
    const t = await harness();
    const a = await t.addFake({ deviceId: 'aaaaaaaaaaaa', name: 'Alpha', grid: { w: 300, h: 300 } });
    const r = await t.call('image_draw', { lamps: 'Alpha', pixels: [['#ff0000']] });
    expect(r.results[0]).toMatchObject({ ok: false, reason: expect.stringMatching(/grid 300×300.*65535 pixels/) });
    expect(a.state.requests.some((x) => x.path === '/api/frame')).toBe(false);
  });

  it('image_get returns a PNG of the image', async () => {
    const t = await harness();
    const a = await t.addFake({ deviceId: 'aaaaaaaaaaaa', name: 'Alpha', grid: { w: 2, h: 2 } });
    a.state.images.set('img-001', { w: 2, h: 2, label: 'Quad', data: Buffer.from(RGB2) });
    const r = await t.client.callTool({ name: 'image_get', arguments: { lamp: 'Alpha', id: 'img-001' } });
    const content = r.content as Array<{ type: string; data?: string; mimeType?: string; text?: string }>;
    const img = content.find((c) => c.type === 'image')!;
    expect(img.mimeType).toBe('image/png');
    const png = PNG.sync.read(Buffer.from(img.data!, 'base64'));
    expect(png.width).toBe(png.height);
    expect(png.width).toBeLessThanOrEqual(1024);
    expect([...png.data.subarray(0, 4)]).toEqual([255, 0, 0, 255]);
    expect(JSON.parse(content.find((c) => c.type === 'text')!.text!)).toMatchObject({ ok: true, id: 'img-001', w: 2, h: 2, label: 'Quad' });
  });
});

describe('image_copy and the library', () => {
  it('image_copy is grid-checked and deduped', async () => {
    const t = await harness();
    const a = await t.addFake({ deviceId: 'aaaaaaaaaaaa', name: 'Alpha', grid: { w: 2, h: 2 } });
    const b = await t.addFake({ deviceId: 'bbbbbbbbbbbb', name: 'Beta', grid: { w: 2, h: 2 } });
    await t.addFake({ deviceId: 'cccccccccccc', name: 'Gamma', grid: { w: 4, h: 4 } });
    a.state.images.set('img-001', { w: 2, h: 2, label: 'Quad', data: Buffer.from(RGB2) });
    const r = await t.call('image_copy', { from: 'Alpha', id: 'img-001', to: ['Beta', 'Gamma'] });
    expect(r.results[0]).toMatchObject({ lamp: 'Beta', ok: true, id: 'img-001' });
    expect(r.results[1]).toMatchObject({ lamp: 'Gamma', ok: false, reason: 'needs a 2×2 lamp' });
    expect(b.state.images.get('img-001')).toMatchObject({ label: 'Quad', data: Buffer.from(RGB2) });
    await t.call('image_copy', { from: 'Alpha', id: 'img-001', to: 'Beta' });
    expect(b.state.images.size).toBe(1);
  });

  it('library_save_image / library_push_image; overwriting a different entry needs confirmation', async () => {
    const t = await harness();
    const a = await t.addFake({ deviceId: 'aaaaaaaaaaaa', name: 'Alpha', grid: { w: 2, h: 2 } });
    const b = await t.addFake({ deviceId: 'bbbbbbbbbbbb', name: 'Beta', grid: { w: 2, h: 2 } });
    a.state.images.set('img-001', { w: 2, h: 2, label: 'Quad', data: Buffer.from(RGB2) });
    a.state.images.set('img-002', { w: 2, h: 2, label: 'Quad', data: Buffer.alloc(12, 9) });
    expect(await t.call('library_save_image', { lamp: 'Alpha', id: 'img-001' })).toMatchObject({ ok: true, name: 'Quad', replaced: false });
    expect(await t.call('library_list', { kind: 'images' })).toMatchObject({ names: ['Quad'] });
    // same content again: no confirmation
    expect(await t.call('library_save_image', { lamp: 'Alpha', id: 'img-001' })).toMatchObject({ ok: true, replaced: false });
    const ask = await t.call('library_save_image', { lamp: 'Alpha', id: 'img-002' });
    expect(ask).toMatchObject({ needsConfirmation: true });
    expect(await t.call('library_save_image', { lamp: 'Alpha', id: 'img-002', confirm: ask.confirm })).toMatchObject({ ok: true, replaced: true });
    const r = await t.call('library_push_image', { name: 'Quad', lamps: 'Beta' });
    expect(r.results[0]).toMatchObject({ lamp: 'Beta', ok: true, id: 'img-001' });
    expect(b.state.images.get('img-001')!.data).toEqual(Buffer.alloc(12, 9));
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { makeHarness, type Harness } from './harness';

let h: Harness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });
const harness = async () => (h = await makeHarness());

const SRC = '// @param speed 0..10 = 3 how fast\nfunction shade(x, y, idx, frame, base, params) { emit(255, 0, 0); }';
const GRID = { w: 4, h: 2 };
const reqs = (l: { state: { requests: Array<{ method: string; path: string }> } }, method: string, re: RegExp) =>
  l.state.requests.filter((r) => r.method === method && re.test(r.path)).length;

async function sourceLamp(t: Harness) {
  const a = await t.addFake({ deviceId: 'aaaaaaaaaaaa', name: 'Alpha', grid: GRID });
  a.state.effects.set('blaze', SRC);
  a.state.params.set('blaze', { speed: 7 });
  a.state.images.set('img-001', { ...GRID, label: 'Sunset', data: Buffer.alloc(24, 9) });
  a.state.scenes.set('evening', { script: 'blaze', params: { speed: 7 }, brightness: 90 });
  a.state.scenes.set('pic', { image: 'img-001' });
  return a;
}

describe('scene tools', () => {
  it('lists, reads and captures', async () => {
    const t = await harness();
    const a = await sourceLamp(t);
    a.state.scene = 'evening';
    const l = await t.call('scenes_list', { lamp: 'Alpha' });
    expect(l).toMatchObject({ ok: true, count: 2, active: 'evening' });
    expect(await t.call('scene_get', { lamp: 'Alpha', name: 'evening' })).toMatchObject({ ok: true, scene: { script: 'blaze' } });
    expect(await t.call('scene_get', { lamp: 'Alpha', name: 'nope' })).toMatchObject({ ok: false, reason: expect.stringContaining('no scene nope') });
    expect(await t.call('scene_capture', { lamp: 'Alpha', name: 'snap' })).toMatchObject({ ok: true, name: 'snap' });
    expect(a.state.scenes.has('snap')).toBe(true);
    expect(await t.call('scene_capture', { lamp: 'Alpha', name: 'snap' })).toMatchObject({ needsConfirmation: true });
  });

  it('scene_copy carries script source, tunes and image; other grids get no image', async () => {
    const t = await harness();
    const a = await sourceLamp(t);
    const b = await t.addFake({ deviceId: 'bbbbbbbbbbbb', name: 'Beta', grid: GRID });
    const c = await t.addFake({ deviceId: 'cccccccccccc', name: 'Gamma', grid: { w: 3, h: 3 } });
    const r = await t.call('scene_copy', { from: 'Alpha', name: 'evening', to: ['Beta'] });
    expect(r.results[0]).toMatchObject({ lamp: 'Beta', ok: true });
    expect(b.state.effects.get('blaze')).toBe(SRC);
    expect(b.state.params.get('blaze')).toEqual({ speed: 7 });
    expect(b.state.scenes.get('evening')).toMatchObject({ script: 'blaze', brightness: 90 });

    const p = await t.call('scene_copy', { from: 'Alpha', name: 'pic', to: ['Beta', 'Gamma'] });
    expect(p.results.find((x: any) => x.lamp === 'Beta')).toMatchObject({ ok: true });
    const bs = b.state.scenes.get('pic') as { image: string };
    expect(b.state.images.has(bs.image)).toBe(true);
    expect(b.state.images.get(bs.image)).toMatchObject({ label: 'Sunset' });
    const g = p.results.find((x: any) => x.lamp === 'Gamma');
    expect(g).toMatchObject({ ok: true, warning: expect.stringContaining('needs a 4×2 lamp') });
    expect(c.state.scenes.get('pic')).toEqual({});
    expect(a.state.scenes.get('pic')).toEqual({ image: 'img-001' });
  });

  it('scene_copy asks before overwriting a scene or a different script', async () => {
    const t = await harness();
    await sourceLamp(t);
    const b = await t.addFake({ deviceId: 'bbbbbbbbbbbb', name: 'Beta', grid: GRID });
    b.state.scenes.set('evening', { color: [1, 2, 3] });
    const ask = await t.call('scene_copy', { from: 'Alpha', name: 'evening', to: 'Beta' });
    expect(ask).toMatchObject({ needsConfirmation: true, summary: expect.stringContaining('Beta') });
    expect(b.state.scenes.get('evening')).toEqual({ color: [1, 2, 3] });
    const done = await t.call('scene_copy', { from: 'Alpha', name: 'evening', to: 'Beta', confirm: ask.confirm });
    expect(done.results[0]).toMatchObject({ ok: true });
    expect(b.state.scenes.get('evening')).toMatchObject({ script: 'blaze' });
  });

  it('scene_activate sends one request per swarm', async () => {
    const t = await harness();
    const a = await t.addFake({ deviceId: 'aaaaaaaaaaaa', name: 'Alpha', swarmId: 'sw1' });
    const b = await t.addFake({ deviceId: 'bbbbbbbbbbbb', name: 'Beta', swarmId: 'sw1' });
    const c = await t.addFake({ deviceId: 'cccccccccccc', name: 'Gamma' });
    for (const l of [a, b, c]) l.state.scenes.set('calm', { color: [10, 20, 30] });
    const r = await t.call('scene_activate', { lamps: 'all', name: 'calm' });
    expect(r.results).toHaveLength(3);
    const n = [a, b, c].map((l) => reqs(l, 'POST', /\/activate$/));
    expect(n.reduce((x, y) => x + y, 0)).toBe(2);
    expect(n[2]).toBe(1);
    expect(r.results.filter((x: any) => x.viaSwarm)).toHaveLength(1);
    expect(r.results.every((x: any) => x.ok)).toBe(true);
  });

  it('scene_put: validates, asks before overwriting, binds the document', async () => {
    const t = await harness();
    const a = await t.addFake({ deviceId: 'aaaaaaaaaaaa', name: 'Alpha' });
    const fresh = await t.call('scene_put', { lamps: 'Alpha', name: 'mood', doc: { color: [255, 140, 40] } });
    expect(fresh.results[0]).toMatchObject({ ok: true });
    expect(a.state.scenes.get('mood')).toEqual({ color: [255, 140, 40] });
    const ask = await t.call('scene_put', { lamps: 'Alpha', name: 'mood', doc: { color: [1, 1, 1] } });
    expect(ask).toMatchObject({ needsConfirmation: true });
    const swapped = await t.call('scene_put', { lamps: 'Alpha', name: 'mood', doc: { color: [9, 9, 9] }, confirm: ask.confirm });
    expect(swapped.needsConfirmation).toBe(true);
    expect(swapped.refused).toBeTruthy();
    expect(a.state.scenes.get('mood')).toEqual({ color: [255, 140, 40] });
    const ok = await t.call('scene_put', { lamps: 'Alpha', name: 'mood', doc: { color: [1, 1, 1] }, confirm: ask.confirm });
    expect(ok.results[0]).toMatchObject({ ok: true });
    expect(a.state.scenes.get('mood')).toEqual({ color: [1, 1, 1] });
    // identical document: nothing to lose, no question
    expect((await t.call('scene_put', { lamps: 'Alpha', name: 'mood', doc: { color: [1, 1, 1] } })).results[0].ok).toBe(true);
    // validation
    const bad = await t.client.callTool({ name: 'scene_put', arguments: { lamps: 'Alpha', name: 'bad name', doc: {} } });
    expect(bad.isError).toBe(true);
    const bad2 = await t.client.callTool({ name: 'scene_put', arguments: { lamps: 'Alpha', name: 'x', doc: { colour: 1 } } });
    expect(bad2.isError).toBe(true);
  });

  it('an AI key with only control can activate but not write scenes', async () => {
    const t = await harness();
    const ai = await t.addFake({ deviceId: 'ai0000000001', name: 'Desk', role: 'ai', perms: ['control'] });
    ai.state.scenes.set('calm', { brightness: 50 });
    expect((await t.call('scene_activate', { lamps: 'Desk', name: 'calm' })).results[0]).toMatchObject({ ok: true });
    const put = await t.call('scene_put', { lamps: 'Desk', name: 'new', doc: { brightness: 5 } });
    expect(put.results[0]).toMatchObject({ ok: false, reason: expect.stringContaining('needs scenes') });
    expect(ai.state.scenes.has('new')).toBe(false);
  });

  it('scene_delete binds the resolved lamps and the name', async () => {
    const t = await harness();
    const a = await t.addFake({ deviceId: 'aaaaaaaaaaaa', name: 'Alpha' });
    const b = await t.addFake({ deviceId: 'bbbbbbbbbbbb', name: 'Beta' });
    for (const l of [a, b]) { l.state.scenes.set('rain', { brightness: 1 }); l.state.scenes.set('fire', { brightness: 2 }); }
    const ask = await t.call('scene_delete', { lamps: 'all', name: 'rain' });
    expect(ask).toMatchObject({ needsConfirmation: true, summary: expect.stringContaining('Alpha') });
    const wrong = await t.call('scene_delete', { lamps: 'all', name: 'fire', confirm: ask.confirm });
    expect(wrong.needsConfirmation).toBe(true);
    expect(a.state.scenes.has('fire')).toBe(true);
    const ask2 = await t.call('scene_delete', { lamps: 'all', name: 'rain' });
    const done = await t.call('scene_delete', { lamps: 'all', name: 'rain', confirm: ask2.confirm });
    expect(done.results.map((x: any) => x.ok)).toEqual([true, true]);
    expect(a.state.scenes.has('rain')).toBe(false);
    expect(b.state.scenes.has('fire')).toBe(true);
  });

  it('library_save_scene / library_push_scene round trip', async () => {
    const t = await harness();
    await sourceLamp(t);
    const b = await t.addFake({ deviceId: 'bbbbbbbbbbbb', name: 'Beta', grid: GRID });
    expect(await t.call('library_save_scene', { lamp: 'Alpha', name: 'evening' })).toMatchObject({ ok: true, script: 'blaze', scriptSource: true, replaced: false });
    expect(await t.call('library_save_scene', { lamp: 'Alpha', name: 'pic' })).toMatchObject({ ok: true, image: true });
    expect((await t.call('library_list', { kind: 'scenes' })).names).toEqual(['evening', 'pic']);
    // unchanged re-save: no question
    expect(await t.call('library_save_scene', { lamp: 'Alpha', name: 'evening' })).toMatchObject({ ok: true, replaced: false });
    const r = await t.call('library_push_scene', { name: 'pic', lamps: ['Beta'] });
    expect(r.results[0]).toMatchObject({ ok: true });
    const id = (b.state.scenes.get('pic') as { image: string }).image;
    expect(b.state.images.get(id)).toMatchObject({ label: 'Sunset' });
    await t.call('library_push_scene', { name: 'evening', lamps: 'Beta' });
    expect(b.state.effects.get('blaze')).toBe(SRC);
    // changed scene on the lamp: replacing the library entry asks
    const edit = { lamps: 'Alpha', name: 'evening', doc: { script: 'blaze', brightness: 10 } };
    await t.call('scene_put', { ...edit, confirm: (await t.call('scene_put', edit)).confirm });
    expect(await t.call('library_save_scene', { lamp: 'Alpha', name: 'evening' })).toMatchObject({ needsConfirmation: true });
  });

  it('scene_put asks when only nested params differ', async () => {
    const t = await harness();
    const a = await t.addFake({ deviceId: 'aaaaaaaaaaaa', name: 'Alpha' });
    a.state.scenes.set('s', { script: 'b', params: { speed: 1 } });
    const ask = await t.call('scene_put', { lamps: 'Alpha', name: 's', doc: { script: 'b', params: { speed: 9 } } });
    expect(ask.needsConfirmation).toBe(true);
    expect(a.state.scenes.get('s')).toEqual({ script: 'b', params: { speed: 1 } });
  });

  it('re-running an identical scene_copy does not ask again', async () => {
    const t = await harness();
    await sourceLamp(t);
    const b = await t.addFake({ deviceId: 'bbbbbbbbbbbb', name: 'Beta', grid: GRID });
    for (const name of ['evening', 'pic']) {
      const first = await t.call('scene_copy', { from: 'Alpha', name, to: 'Beta' });
      expect(first.results[0].ok).toBe(true);
      const again = await t.call('scene_copy', { from: 'Alpha', name, to: 'Beta' });
      expect(again.needsConfirmation).toBeUndefined();
      expect(again.results[0].ok).toBe(true);
    }
    expect(b.state.images.size).toBe(1);
  });

  it('scene_delete confirms only lamps that have the scene and reports the rest as skipped', async () => {
    const t = await harness();
    const a = await t.addFake({ deviceId: 'aaaaaaaaaaaa', name: 'Alpha' });
    const b = await t.addFake({ deviceId: 'bbbbbbbbbbbb', name: 'Beta' });
    const u = await t.addFake({ deviceId: 'uuuuuuuuuuuu', name: 'User', role: 'user' });
    a.state.scenes.set('rain', {}); u.state.scenes.set('rain', {});
    const ask = await t.call('scene_delete', { lamps: 'all', name: 'rain' });
    expect(ask.needsConfirmation).toBe(true);
    expect(ask.summary).toContain('Alpha');
    expect(ask.summary).not.toContain('Beta');
    expect(ask.summary).not.toContain('User');
    expect(ask.skipped.map((x: any) => x.lamp).sort()).toEqual(['Beta', 'User']);
    const done = await t.call('scene_delete', { lamps: 'all', name: 'rain', confirm: ask.confirm });
    expect(done.results.filter((x: any) => x.ok).map((x: any) => x.lamp)).toEqual(['Alpha']);
    expect(done.results.filter((x: any) => x.skipped)).toHaveLength(2);
    expect(a.state.scenes.has('rain')).toBe(false);
    expect(u.state.scenes.has('rain')).toBe(true);
    // nothing to delete anywhere: no confirmation
    const none = await t.call('scene_delete', { lamps: 'all', name: 'rain' });
    expect(none.needsConfirmation).toBeUndefined();
    expect(none.results.every((x: any) => x.skipped)).toBe(true);
    void b;
  });
});

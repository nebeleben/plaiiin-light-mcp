import { afterEach, describe, expect, it } from 'vitest';
import { makeHarness, type Harness, type HarnessOpts } from './harness';
import { fanout } from '../src/tools/fanout';

let h: Harness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });
const harness = async (o?: HarnessOpts) => (h = await makeHarness(o));

describe('control tools', () => {
  it("lamp_power({lamps:'all', on:true}) gives one ok result per lamp", async () => {
    const t = await harness();
    const a = await t.addFake({ deviceId: 'aaaaaaaaaaaa', name: 'Alpha' });
    const b = await t.addFake({ deviceId: 'bbbbbbbbbbbb', name: 'Beta', role: 'user' });
    const r = await t.call('lamp_power', { lamps: 'all', on: true });
    expect(r.results).toHaveLength(2);
    expect(r.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ lamp: 'Alpha', ok: true }),
      expect.objectContaining({ lamp: 'Beta', ok: true }),
    ]));
    expect(a.state.on).toBe(true);
    expect(b.state.on).toBe(true);
  });

  it('an AI key without control is refused locally after a whoami re-check; the lamp never sees the request', async () => {
    const t = await harness();
    const l = await t.addFake({ deviceId: 'ai0000000001', name: 'Desk', role: 'ai', perms: ['images'] });
    const before = l.state.requests.length;
    const r = await t.call('lamp_power', { lamps: ['Desk'], on: true });
    expect(r.results).toEqual([{ lamp: 'Desk', deviceId: 'ai0000000001', ok: false, skipped: true, reason: "not permitted by this lamp's AI key (needs control)" }]);
    expect(l.state.requests.slice(before).map((q) => `${q.method} ${q.path}`)).toEqual(['GET /api/whoami']);
    expect(l.state.on).toBe(false);
  });

  it('a 403 from the lamp is explained, not bare', async () => {
    const t = await harness();
    const l = await t.addFake({ deviceId: 'ai0000000002', name: 'Desk', role: 'ai', perms: ['control'] });
    l.state.perms = []; // key edited in the app after we read whoami
    const r = await t.call('lamp_power', { lamps: 'Desk', on: true });
    expect(r.results[0]).toMatchObject({ ok: false, reason: "not permitted by this lamp's AI key (needs control)" });
  });

  it('a permission added in the app after we read whoami is picked up before refusing', async () => {
    const t = await harness();
    const l = await t.addFake({ deviceId: 'ai0000000011', name: 'Desk', role: 'ai', perms: ['images'] });
    l.state.perms = ['images', 'control']; // owner added control in the Share tab
    const r = await t.call('lamp_power', { lamps: 'Desk', on: true });
    expect(r.results[0]).toMatchObject({ ok: true, on: true });
    expect(t.fleet.get('Desk')?.perms).toEqual(['images', 'control']);
  });

  it('a permission removed in the app is re-read after the lamp refuses', async () => {
    const t = await harness();
    const l = await t.addFake({ deviceId: 'ai0000000012', name: 'Desk', role: 'ai', perms: ['control', 'images'] });
    l.state.perms = ['images'];
    const r = await t.call('lamp_power', { lamps: 'Desk', on: true });
    expect(r.results[0]).toMatchObject({ ok: false, reason: "not permitted by this lamp's AI key (needs control)" });
    expect(t.fleet.get('Desk')?.perms).toEqual(['images']);
  });

  it('an only-while-on key on a switched-off lamp is refused as "lamp is off"', async () => {
    const t = await harness();
    await t.addFake({ deviceId: 'ai0000000013', name: 'Desk', role: 'ai', perms: ['control'], onlyWhenOn: true });
    const r = await t.call('lamp_brightness', { lamps: 'Desk', value: 50 });
    expect(r.results[0].ok).toBe(false);
    expect(r.results[0].reason).toMatch(/lamp is off/);
    expect(r.results[0].reason).not.toMatch(/needs control/);
  });

  it('Review Focus 2: one wedged lamp times out alone', async () => {
    const timeoutMs = 600;
    const t = await harness({ timeoutMs });
    const good = await t.addFake({ deviceId: 'aaaaaaaaaaaa', name: 'Good' });
    // two wedged lamps: a sequential fan-out would need >= 2 × timeout
    for (const id of ['hhhhhhhhhhhh', 'iiiiiiiiiiii']) {
      const wedged = await t.fake({ deviceId: id, name: `Wedged-${id[0]}`, hang: true });
      t.fleet.upsert({ deviceId: id, name: `Wedged-${id[0]}`, host: '127.0.0.1', port: wedged.port, role: 'admin', shared: false, lastSeen: new Date().toISOString() });
    }
    const t0 = Date.now();
    const r = await t.call('lamp_power', { lamps: 'all', on: true });
    const took = Date.now() - t0;
    expect(r.results.find((x: any) => x.lamp === 'Good')).toMatchObject({ ok: true });
    expect(r.results).toHaveLength(3);
    for (const hung of r.results.filter((x: any) => x.lamp.startsWith('Wedged'))) {
      expect(hung.ok).toBe(false);
      expect(hung.reason).toMatch(/timed out/);
    }
    expect(took).toBeLessThan(2 * timeoutMs);
    expect(good.state.on).toBe(true);
  });

  it('lamp_color accepts hex and rgb arrays', async () => {
    const t = await harness();
    const l = await t.addFake({ deviceId: 'aaaaaaaaaaaa', name: 'Alpha' });
    expect((await t.call('lamp_color', { lamps: 'all', color: '#ff8000' })).results[0].ok).toBe(true);
    expect(l.state.color).toEqual([255, 128, 0]);
    await t.call('lamp_color', { lamps: ['Alpha'], color: [1, 2, 3] });
    expect(l.state.color).toEqual([1, 2, 3]);
    const bad = await t.client.callTool({ name: 'lamp_color', arguments: { lamps: 'all', color: 'red' } });
    expect(bad.isError).toBe(true);
  });

  it('lamp_brightness reports the cap an AI key applied', async () => {
    const t = await harness();
    const l = await t.addFake({ deviceId: 'ai0000000003', name: 'Desk', role: 'ai', perms: ['control'], maxBrightness: 100 });
    const r = await t.call('lamp_brightness', { lamps: 'all', value: 200 });
    expect(r.results[0]).toMatchObject({ ok: true, brightness: 100 });
    expect(l.state.brightness).toBe(100);
  });

  it('lamp_mode and lamp_play', async () => {
    const t = await harness();
    const l = await t.addFake({ deviceId: 'aaaaaaaaaaaa', name: 'Alpha' });
    await t.call('lamp_mode', { lamps: 'all', mode: 'frame' });
    expect(l.state.mode).toBe('frame');
    await t.call('lamp_play', { lamps: 'all', action: 'play', effect: 'rainbow' });
    expect(l.state).toMatchObject({ mode: 'js', current: 'rainbow' });
    await t.call('lamp_play', { lamps: 'all', action: 'next' });
    expect(l.state.current).toBe('carousel');
    await t.call('lamp_play', { lamps: 'all', action: 'stop' });
    expect(l.state.current).toBeNull();
    const missing = await t.call('lamp_play', { lamps: 'all', action: 'play', effect: 'nope' });
    expect(missing.results[0]).toMatchObject({ ok: false, reason: 'no such effect' });
  });

  it('lamp_play play without an effect resumes the current selection', async () => {
    const t = await harness();
    const l = await t.addFake({ deviceId: 'aaaaaaaaaaaa', name: 'Alpha' });
    l.state.current = 'carousel'; l.state.mode = 'api';
    const r = await t.call('lamp_play', { lamps: 'all', action: 'play' });
    expect(r.results[0]).toMatchObject({ ok: true });
    expect(l.state).toMatchObject({ mode: 'js', current: 'carousel' });
  });

  it('lamp_state reads every lamp; an AI key without control can still read', async () => {
    const t = await harness();
    await t.addFake({ deviceId: 'aaaaaaaaaaaa', name: 'Alpha' });
    await t.addFake({ deviceId: 'ai0000000004', name: 'Desk', role: 'ai', perms: [] });
    const r = await t.call('lamp_state', { lamps: 'all' });
    expect(r.results).toHaveLength(2);
    for (const x of r.results) expect(x).toMatchObject({ ok: true, on: false, mode: 'api' });
  });

  it('lamp response fields cannot overwrite lamp, deviceId or ok', async () => {
    const t = await harness();
    await t.addFake({ deviceId: 'aaaaaaaaaaaa', name: 'Alpha' });
    const r = await fanout(t.ctx, 'all', { minRole: 'user' }, async () => ({ lamp: 'evil', deviceId: 'evil', ok: false, extra: 1 }));
    expect(r).toEqual([{ lamp: 'Alpha', deviceId: 'aaaaaaaaaaaa', ok: true, extra: 1 }]);
  });

  it('unknown lamp names fail the call with a reason', async () => {
    const t = await harness();
    const r = await t.call('lamp_power', { lamps: ['Nope'], on: true });
    expect(r).toMatchObject({ ok: false, reason: 'unknown lamp: Nope' });
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeHarness, type Harness, type HarnessOpts } from './harness';

let h: Harness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });
const harness = async (o?: HarnessOpts) => (h = await makeHarness(o));

describe('tool list', () => {
  it('registers every tool with the three annotations', async () => {
    const t = await harness();
    const { tools } = await t.client.listTools();
    const names = tools.map((x) => x.name).sort();
    expect(names).toEqual([
      'effect_compile', 'effect_copy', 'effect_delete', 'effect_preview', 'effect_read', 'effect_tunes_get',
      'effect_tunes_set', 'effect_upload', 'effect_validate', 'effects_list', 'firmware_check', 'firmware_update',
      'image_copy', 'image_delete', 'image_draw', 'image_get', 'image_label', 'image_show', 'images_list',
      'lamp_add_shared', 'lamp_brightness', 'lamp_color', 'lamp_forget', 'lamp_form_prompt', 'lamp_info', 'lamp_mode', 'lamp_play',
      'lamp_power', 'lamp_rename', 'lamp_state', 'lamps_discover', 'lamps_list',
      'library_list', 'library_push_effect', 'library_push_image', 'library_push_scene', 'library_save_effect', 'library_save_image',
      'library_save_scene', 'scene_activate', 'scene_capture', 'scene_copy', 'scene_delete', 'scene_get', 'scene_put', 'scenes_list',
      'stream_start', 'stream_stop', 'streams_list', 'swarms_list',
    ]);
    for (const tool of tools) {
      expect(typeof tool.annotations?.readOnlyHint, tool.name).toBe('boolean');
      expect(typeof tool.annotations?.destructiveHint, tool.name).toBe('boolean');
      expect(typeof tool.annotations?.idempotentHint, tool.name).toBe('boolean');
      expect(tool.description!.length, tool.name).toBeGreaterThan(40);
    }
    const forget = tools.find((x) => x.name === 'lamp_forget')!;
    expect(forget.annotations?.destructiveHint).toBe(true);
    expect(forget.description).toMatch(/confirm/i);
  });
});

describe('lamp_add_shared', () => {
  it('adds a lamp from a pasted URL; the result has the role and never the key', async () => {
    const t = await harness();
    const l = await t.fake({ deviceId: 'ai0000000001', name: 'Desk', role: 'ai', perms: ['control', 'images'] });
    const url = `http://127.0.0.1:${l.port}/config?t=${l.token}`;
    const text = await t.raw('lamp_add_shared', { url });
    expect(text).not.toContain(l.token);
    const r = JSON.parse(text);
    expect(r).toMatchObject({ ok: true, name: 'Desk', deviceId: 'ai0000000001', role: 'ai', perms: ['control', 'images'] });
    expect(await t.secrets.get('ai0000000001')).toBe(l.token);
  });

  it('reads the link from the clipboard', async () => {
    let link = '';
    const t = await harness({ readClipboard: async () => `here you go: ${link}` });
    const l = await t.fake({ deviceId: 'cr0000000001', name: 'Shelf', role: 'creator' });
    link = `http://127.0.0.1:${l.port}/config?t=${l.token}`;
    const text = await t.raw('lamp_add_shared', { fromClipboard: true });
    expect(text).not.toContain(l.token);
    expect(JSON.parse(text)).toMatchObject({ ok: true, name: 'Shelf', role: 'creator' });
  });

  it('a clipboard without a link fails without echoing the clipboard', async () => {
    const t = await harness({ readClipboard: async () => 'secretish clipboard text' });
    const text = await t.raw('lamp_add_shared', {});
    expect(text).not.toContain('secretish');
    expect(JSON.parse(text)).toMatchObject({ ok: false });
  });

  it('a wrong key fails without the key in the message', async () => {
    const t = await harness();
    const l = await t.fake({ deviceId: 'ai0000000002', name: 'Desk', role: 'ai', perms: ['control'] });
    const text = await t.raw('lamp_add_shared', { url: `http://127.0.0.1:${l.port}/config?t=WRONGKEY123` });
    expect(text).not.toContain('WRONGKEY123');
    expect(JSON.parse(text).ok).toBe(false);
  });
});

describe('lamps_list / lamp_info', () => {
  it('lamps_list shows both fakes with live state', async () => {
    const t = await harness();
    const a = await t.addFake({ deviceId: 'aaaaaaaaaaaa', name: 'Alpha' });
    await t.addFake({ deviceId: 'bbbbbbbbbbbb', name: 'Beta', role: 'creator' });
    a.state.on = true;
    const r = await t.call('lamps_list');
    expect(r.lamps).toHaveLength(2);
    const alpha = r.lamps.find((x: any) => x.name === 'Alpha');
    const beta = r.lamps.find((x: any) => x.name === 'Beta');
    expect(alpha).toMatchObject({ deviceId: 'aaaaaaaaaaaa', role: 'admin', online: true, state: { on: true } });
    expect(beta).toMatchObject({ role: 'creator', online: true, state: { on: false } });
  });

  it('lamp_info on an offline lamp is ok:false with a reason', async () => {
    const t = await harness({ timeoutMs: 300 });
    const w = await t.fake({ deviceId: 'hhhhhhhhhhhh', name: 'Wedged', hang: true });
    t.fleet.upsert({ deviceId: 'hhhhhhhhhhhh', name: 'Wedged', host: '127.0.0.1', port: w.port, role: 'admin', shared: false, lastSeen: new Date().toISOString() });
    const r = await t.call('lamp_info', { lamp: 'Wedged' });
    expect(r).toMatchObject({ ok: false, name: 'Wedged', online: false });
    expect(r.reason).toMatch(/timed out/);
  });

  it('lamp_info returns fleet entry plus live /api', async () => {
    const t = await harness();
    await t.addFake({ deviceId: 'aaaaaaaaaaaa', name: 'Alpha', grid: { w: 16, h: 16 } });
    const r = await t.call('lamp_info', { lamp: 'alpha' });
    expect(r).toMatchObject({ ok: true, name: 'Alpha', deviceId: 'aaaaaaaaaaaa', grid: { w: 16, h: 16 }, info: { firmwareVersion: '2.8.0' } });
  });

  it('an unknown lamp is reported, not thrown', async () => {
    const t = await harness();
    const r = await t.call('lamp_info', { lamp: 'Nope' });
    expect(r).toMatchObject({ ok: false, reason: 'unknown lamp: Nope' });
  });

  it('a name shared by two lamps asks for the deviceId', async () => {
    const t = await harness();
    await t.addFake({ deviceId: 'aaaaaaaaaaaa', name: 'Tower' });
    await t.addFake({ deviceId: 'bbbbbbbbbbbb', name: 'Tower' });
    const r = await t.call('lamp_info', { lamp: 'Tower' });
    expect(r).toMatchObject({ ok: false, reason: '"Tower" matches several lamps — use the deviceId' });
    const p = await t.call('lamp_power', { lamps: ['Tower'], on: true });
    expect(p).toMatchObject({ ok: false, reason: '"Tower" matches several lamps — use the deviceId' });
    expect((await t.call('lamp_info', { lamp: 'bbbbbbbbbbbb' })).ok).toBe(true);
  });
});

describe('lamp_forget', () => {
  it('needs a confirmation, then removes the lamp and deletes its secret', async () => {
    const t = await harness();
    const l = await t.fake({ deviceId: 'ai0000000003', name: 'Desk', role: 'ai', perms: ['control'] });
    await t.registry.addShared({ host: '127.0.0.1', port: l.port, key: l.token });
    const first = await t.call('lamp_forget', { lamp: 'Desk' });
    expect(first.needsConfirmation).toBe(true);
    expect(first.summary).toMatch(/Desk/);
    expect(t.fleet.get('Desk')).toBeDefined();

    const done = await t.call('lamp_forget', { lamp: 'Desk', confirm: first.confirm });
    expect(done).toMatchObject({ ok: true });
    expect(t.fleet.get('Desk')).toBeUndefined();
    expect(await t.secrets.get('ai0000000003')).toBeUndefined();
    expect(JSON.parse(readFileSync(join(t.dir, 'fleet.json'), 'utf8')).lamps).toHaveLength(0);
  });

  it('a bad token is refused and nothing changes', async () => {
    const t = await harness();
    await t.addFake({ deviceId: 'aaaaaaaaaaaa', name: 'Alpha' });
    const r = await t.call('lamp_forget', { lamp: 'Alpha', confirm: 'ABCDEFGH' });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/confirm/);
    expect(t.fleet.get('Alpha')).toBeDefined();
  });
});

describe('lamp_rename', () => {
  it('needs a confirmation, renames on the lamp and in the fleet', async () => {
    const t = await harness();
    const l = await t.addFake({ deviceId: 'aaaaaaaaaaaa', name: 'Alpha' });
    const first = await t.call('lamp_rename', { lamp: 'Alpha', name: 'Omega' });
    expect(first.needsConfirmation).toBe(true);
    expect(first.summary).toMatch(/restart/);
    expect(l.state.name).toBe('Alpha');
    const done = await t.call('lamp_rename', { lamp: 'Alpha', name: 'Omega', confirm: first.confirm });
    expect(done).toMatchObject({ ok: true, name: 'Omega' });
    expect(l.state.name).toBe('Omega');
    expect(t.fleet.get('aaaaaaaaaaaa')!.name).toBe('Omega');
  });

  it('the token for one name does not rename to another', async () => {
    const t = await harness();
    const l = await t.addFake({ deviceId: 'aaaaaaaaaaaa', name: 'Alpha' });
    const first = await t.call('lamp_rename', { lamp: 'Alpha', name: 'Omega' });
    const r = await t.call('lamp_rename', { lamp: 'Alpha', name: 'Hacked', confirm: first.confirm });
    expect(r.ok).toBe(false);
    expect(l.state.name).toBe('Alpha');
  });

  it('a creator key is refused before asking for confirmation', async () => {
    const t = await harness();
    await t.addFake({ deviceId: 'cccccccccccc', name: 'Shelf', role: 'creator' });
    const r = await t.call('lamp_rename', { lamp: 'Shelf', name: 'X' });
    expect(r.ok).toBe(false);
    expect(r.needsConfirmation).toBeUndefined();
  });
});

describe('lamps_discover', () => {
  it('adds unpaired lamps as admin and lists paired unknown ones with a hint', async () => {
    let found: any[] = [];
    const t = await harness({ discover: async () => found });
    const open = await t.fake({ deviceId: 'oooooooooooo', name: 'Open' });
    const paired = await t.fake({ deviceId: 'pppppppppppp', name: 'Paired', role: 'creator' });
    found = [
      { deviceId: 'oooooooooooo', name: 'Open', host: '127.0.0.1', port: open.port, paired: false },
      { deviceId: 'pppppppppppp', name: 'Paired', host: '127.0.0.1', port: paired.port, paired: true },
    ];
    const r = await t.call('lamps_discover');
    expect(r.added).toEqual([expect.objectContaining({ name: 'Open', deviceId: 'oooooooooooo', role: 'admin' })]);
    expect(r.needsKey).toEqual([expect.objectContaining({ name: 'Paired', deviceId: 'pppppppppppp' })]);
    expect(r.needsKey[0].hint).toMatch(/AI/);
    expect(t.fleet.get('oooooooooooo')!.role).toBe('admin');
    expect(t.fleet.get('pppppppppppp')).toBeUndefined();
    // a second run reports it as known
    const r2 = await t.call('lamps_discover');
    expect(r2.known).toEqual([expect.objectContaining({ deviceId: 'oooooooooooo' })]);
    expect(r2.added).toEqual([]);
  });

  it('a known lamp seen at a new address is only moved when that host reports the same deviceId', async () => {
    let found: any[] = [];
    const t = await harness({ discover: async () => found });
    const a = await t.addFake({ deviceId: 'aaaaaaaaaaaa', name: 'Alpha', role: 'creator' });
    const other = await t.fake({ deviceId: 'zzzzzzzzzzzz', name: 'Other', role: 'creator' });
    found = [{ deviceId: 'aaaaaaaaaaaa', name: 'Alpha', host: '127.0.0.1', port: other.port, paired: true }];
    const r = await t.call('lamps_discover');
    expect(r.known).toEqual([expect.objectContaining({ deviceId: 'aaaaaaaaaaaa', port: a.port })]);
    expect(t.fleet.get('aaaaaaaaaaaa')!.port).toBe(a.port);
    expect(other.state.requests.every((x) => x.auth === undefined)).toBe(true);
  });
});

describe('swarms_list read classification', () => {
  it('a creator lamp is unknown: no /api/swarm request, not solo, not unreachable', async () => {
    const t = await harness();
    const l = await t.addFake({ deviceId: 'cccccccccccc', name: 'Shelf', role: 'creator', swarmId: 'sw1' });
    expect(l.state.requests.some((x) => x.path === '/api/swarm')).toBe(false); // not even on add
    const r = await t.call('swarms_list');
    expect(r.unknown.map((x: any) => x.name)).toEqual(['Shelf']);
    expect(r.solo).toEqual([]);
    expect(r.swarms).toEqual([]);
    expect(r.unreachable).toBeUndefined();
    expect(l.state.requests.some((x) => x.path === '/api/swarm')).toBe(false);
  });

  it('a 403 on the swarm read (key edited since) counts as unknown', async () => {
    const t = await harness();
    const l = await t.addFake({ deviceId: 'ai0000000009', name: 'Desk', role: 'ai', perms: ['swarm'], swarmId: 'sw1' });
    l.state.perms = [];
    const r = await t.call('swarms_list');
    expect(r.unknown.map((x: any) => x.name)).toEqual(['Desk']);
    expect(r.swarms).toEqual([]);
    expect(r.unreachable).toBeUndefined();
  });

  it('a 404 (firmware without swarm) counts as solo', async () => {
    const t = await harness();
    const l = await t.addFake({ deviceId: 'aaaaaaaaaaaa', name: 'Old', swarmId: 'sw1' });
    l.state.swarm = null;
    const r = await t.call('swarms_list');
    expect(r.solo.map((x: any) => x.name)).toEqual(['Old']);
    expect(r.swarms).toEqual([]);
    expect(r.unreachable).toBeUndefined();
    expect(t.fleet.get('Old')!.swarmId).toBeNull();
  });

  it('only a timeout / unreachable lamp is unreachable, shown with its last known swarm', async () => {
    const t = await harness({ timeoutMs: 300 });
    const w = await t.fake({ deviceId: 'hhhhhhhhhhhh', name: 'Wedged', hang: true });
    t.fleet.upsert({ deviceId: 'hhhhhhhhhhhh', name: 'Wedged', host: '127.0.0.1', port: w.port, role: 'admin', swarmId: 'sw2', shared: false, lastSeen: new Date().toISOString() });
    const r = await t.call('swarms_list');
    expect(r.unreachable).toEqual(['Wedged']);
    expect(r.swarms).toEqual([{ swarmId: 'sw2', members: [expect.objectContaining({ name: 'Wedged' })] }]);
  });
});

describe('swarms_list', () => {
  it('groups by swarm id and lists lamps whose membership is unknown', async () => {
    const t = await harness();
    await t.addFake({ deviceId: 'aaaaaaaaaaaa', name: 'A', swarmId: 'sw1' });
    await t.addFake({ deviceId: 'bbbbbbbbbbbb', name: 'B', role: 'ai', perms: ['swarm'], swarmId: 'sw1' });
    await t.addFake({ deviceId: 'cccccccccccc', name: 'C' });
    await t.addFake({ deviceId: 'dddddddddddd', name: 'D', role: 'ai', perms: ['control'], swarmId: 'sw1' });
    const r = await t.call('swarms_list');
    expect(r.swarms).toEqual([{ swarmId: 'sw1', members: [expect.objectContaining({ name: 'A' }), expect.objectContaining({ name: 'B' })] }]);
    expect(r.solo.map((x: any) => x.name)).toEqual(['C']);
    expect(r.unknown.map((x: any) => x.name)).toEqual(['D']);
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FleetStore } from '../src/store/fleet';
import { makeSecrets } from '../src/store/secrets';
import { Registry } from '../src/lamp/registry';
import type { Discovered } from '../src/lamp/discovery';
import { startFakeLamp, type FakeLampOpts } from './fakeLamp';

const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f(); });

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'lamp-mcp-'));
  cleanup.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}
async function fake(o: Partial<FakeLampOpts> = {}) {
  const l = await startFakeLamp({ deviceId: 'aabbccddeeff', name: 'Kitchen', ...o });
  cleanup.push(() => l.close());
  return l;
}
function setup(resolve?: (id: string) => Promise<Discovered | undefined>) {
  const dir = tmp();
  const fleet = new FleetStore(dir);
  const secrets = makeSecrets(dir, 'linux');
  const reg = new Registry(fleet, secrets, resolve ?? (async () => undefined));
  cleanup.push(() => reg.close());
  return { dir, fleet, secrets, reg };
}
/** A port nothing listens on (bound, then released). */
function deadPort(): Promise<number> {
  return new Promise((r) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)); });
  });
}

describe('Registry', () => {
  it('addShared stores the key in Secrets, not in fleet.json', async () => {
    const l = await fake({ role: 'ai', perms: ['control', 'swarm'], swarmId: 'sw1', maxBrightness: 100, onlyWhenOn: true, grid: { w: 16, h: 8 } });
    const { dir, secrets, reg } = setup();
    const added = await reg.addShared({ host: '127.0.0.1', port: l.port, key: l.token });
    expect(added).toMatchObject({
      deviceId: 'aabbccddeeff', name: 'Kitchen', role: 'ai', perms: ['control', 'swarm'], maxBrightness: 100, onlyWhenOn: true,
      grid: { w: 16, h: 8 }, firmware: '2.8.0', form: 'display', target: 'esp32', swarmId: 'sw1', shared: true,
    });
    expect(await secrets.get('aabbccddeeff')).toBe(l.token);
    const text = readFileSync(join(dir, 'fleet.json'), 'utf8');
    expect(text).not.toContain(l.token);
    // and the stored key is used for calls
    await reg.call('Kitchen', (c) => c.send('POST', '/api/power', { on: true }));
    expect(l.state.on).toBe(true);
  });

  it('addShared skips the swarm read when the AI key lacks swarm', async () => {
    const l = await fake({ role: 'ai', perms: ['control'], swarmId: 'sw1' });
    const { reg } = setup();
    const added = await reg.addShared({ host: '127.0.0.1', port: l.port, key: l.token });
    expect(added.swarmId).toBeNull();
    expect(l.state.requests.some((r) => r.path === '/api/swarm')).toBe(false);
  });

  it('addShared refuses a bad key without leaking it', async () => {
    const l = await fake({ role: 'creator' });
    const { reg, fleet } = setup();
    const err = await reg.addShared({ host: '127.0.0.1', port: l.port, key: 'WRONGKEY' }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain('WRONGKEY');
    expect(fleet.list()).toEqual([]);
  });

  it('Review Focus 1: re-resolves a moved lamp by deviceId, retries, and updates fleet.json', async () => {
    const l = await fake({ role: 'creator' });
    const stale = await deadPort();
    let resolved = 0;
    const { dir, fleet, secrets, reg } = setup(async (id) => {
      resolved++;
      return id === 'aabbccddeeff' ? { deviceId: id, name: 'Kitchen', host: '127.0.0.1', port: l.port, paired: true } : undefined;
    });
    fleet.upsert({ deviceId: 'aabbccddeeff', name: 'Kitchen', host: '127.0.0.1', port: stale, role: 'creator', shared: true, lastSeen: '2026-01-01T00:00:00.000Z' });
    await secrets.set('aabbccddeeff', l.token);
    const st = await reg.call('kitchen', (c) => c.get<{ on: boolean }>('/api/state'));
    expect(st.on).toBe(false);
    expect(resolved).toBe(1);
    const saved = JSON.parse(readFileSync(join(dir, 'fleet.json'), 'utf8')) as { lamps: Array<{ port: number; lastSeen: string }> };
    expect(saved.lamps[0]!.port).toBe(l.port);
    expect(saved.lamps[0]!.lastSeen).not.toBe('2026-01-01T00:00:00.000Z');
    // later calls go straight to the new address
    await reg.call('kitchen', (c) => c.get('/api/state'));
    expect(resolved).toBe(1);
  });

  it('re-resolve: the stored key is not sent to a new host that reports another deviceId', async () => {
    const l = await fake({ role: 'creator' });
    const impostor = await fake({ deviceId: '999999999999', name: 'Other', role: 'creator' });
    const stale = await deadPort();
    const { fleet, secrets, reg } = setup(async (id) => ({ deviceId: id, name: 'Kitchen', host: '127.0.0.1', port: impostor.port, paired: true }));
    fleet.upsert({ deviceId: 'aabbccddeeff', name: 'Kitchen', host: '127.0.0.1', port: stale, role: 'creator', shared: true, lastSeen: '' });
    await secrets.set('aabbccddeeff', l.token);
    await expect(reg.call('kitchen', (c) => c.get('/api/state'))).rejects.toThrow(/unreachable/);
    expect(impostor.state.requests.map((r) => r.path)).toEqual(['/api']);
    expect(impostor.state.requests.every((r) => r.auth === undefined)).toBe(true);
    expect(fleet.get('aabbccddeeff')!.port).toBe(stale);
  });

  it('relocate verifies the deviceId (tokenless GET /api) before saving a new address', async () => {
    const l = await fake({ role: 'creator' });
    const other = await fake({ deviceId: '999999999999', name: 'Other', role: 'creator' });
    const { fleet, reg } = setup();
    fleet.upsert({ deviceId: 'aabbccddeeff', name: 'Kitchen', host: '127.0.0.1', port: 1, role: 'creator', shared: true, lastSeen: '' });
    expect(await reg.relocate('aabbccddeeff', '127.0.0.1', other.port)).toBe(false);
    expect(fleet.get('aabbccddeeff')!.port).toBe(1);
    expect(await reg.relocate('aabbccddeeff', '127.0.0.1', l.port)).toBe(true);
    expect(fleet.get('aabbccddeeff')!.port).toBe(l.port);
    expect(l.state.requests.every((r) => r.auth === undefined)).toBe(true);
  });

  it('caches secrets per deviceId; set/forget/addShared invalidate', async () => {
    const l = await fake({ role: 'creator' });
    const { fleet, secrets, reg: _unused } = setup();
    let gets = 0;
    const counting = { ...secrets, get: async (id: string) => { gets++; return secrets.get(id); },
      set: (id: string, v: string) => secrets.set(id, v), delete: (id: string) => secrets.delete(id) };
    const reg = new Registry(fleet, counting, async () => undefined);
    cleanup.push(() => reg.close());
    await reg.addShared({ host: '127.0.0.1', port: l.port, key: l.token });
    await reg.call('Kitchen', (c) => c.get('/api/state'));
    await reg.call('Kitchen', (c) => c.get('/api/state'));
    await reg.endpoint('Kitchen');
    expect(gets).toBe(1);
    // a re-add with a new key is used at once
    l.state.requests.length = 0;
    await reg.addShared({ host: '127.0.0.1', port: l.port, key: l.token });
    await reg.call('Kitchen', (c) => c.get('/api/state'));
    expect(gets).toBe(2);
    await reg.forget('aabbccddeeff');
    fleet.upsert({ deviceId: 'aabbccddeeff', name: 'Kitchen', host: '127.0.0.1', port: l.port, role: 'creator', shared: true, lastSeen: '' });
    expect((await reg.endpoint('Kitchen')).token).toBeUndefined();
    expect(gets).toBe(3);
  });

  it('gives up after one re-resolve when the lamp is not found', async () => {
    const stale = await deadPort();
    let resolved = 0;
    const { fleet, reg } = setup(async () => { resolved++; return undefined; });
    fleet.upsert({ deviceId: 'aa', name: 'Gone', host: '127.0.0.1', port: stale, role: 'admin', shared: false, lastSeen: '' });
    await expect(reg.call('Gone', (c) => c.get('/api/state'))).rejects.toThrow(/unreachable/);
    expect(resolved).toBe(1);
  });

  it('Review Focus 5: old firmware whoami without perms → ladder access, no crash', async () => {
    const l = await fake({ role: 'creator' });
    l.state.whoamiPerms = false;
    const { reg, fleet } = setup();
    const added = await reg.addShared({ host: '127.0.0.1', port: l.port, key: l.token });
    expect(added.role).toBe('creator');
    expect(added.perms).toBeUndefined();
    await reg.refreshAccess();
    expect(fleet.get('Kitchen')?.role).toBe('creator');
  });

  it('refreshAccess picks up a changed AI key and survives an unreachable lamp', async () => {
    const l = await fake({ role: 'ai', perms: ['control'] });
    const { reg, fleet } = setup();
    await reg.addShared({ host: '127.0.0.1', port: l.port, key: l.token });
    fleet.upsert({ deviceId: 'dead', name: 'Dead', host: '127.0.0.1', port: await deadPort(), role: 'user', shared: true, lastSeen: '' });
    l.state.perms = ['control', 'effects'];
    l.state.maxBrightness = 50;
    await reg.refreshAccess();
    expect(fleet.get('Kitchen')).toMatchObject({ perms: ['control', 'effects'], maxBrightness: 50 });
    expect(fleet.get('Dead')?.role).toBe('user');
  });

  it('addUnpaired adds an admin lamp with no secret', async () => {
    const l = await fake({ role: 'admin', deviceId: '112233445566', name: 'Desk', grid: { w: 4, h: 4 } });
    const { reg, secrets } = setup();
    const added = await reg.addUnpaired({ deviceId: '112233445566', name: 'Desk', host: '127.0.0.1', port: l.port, paired: false });
    expect(added).toMatchObject({ role: 'admin', shared: false, grid: { w: 4, h: 4 } });
    expect(await secrets.get('112233445566')).toBeUndefined();
    await reg.call('Desk', (c) => c.send('POST', '/api/power', { on: true }));
    expect(l.state.on).toBe(true);
    expect(l.state.lastAuthorization).toBeUndefined();
  });

  it('addUnpaired refuses a paired lamp', async () => {
    const l = await fake({ role: 'creator' });
    const { reg, fleet } = setup();
    await expect(reg.addUnpaired({ deviceId: 'aabbccddeeff', name: 'Kitchen', host: '127.0.0.1', port: l.port, paired: true }))
      .rejects.toThrow(/paired/);
    expect(fleet.list()).toEqual([]);
  });

  it('resolveTargets: all, by name/id, unknown → error, deduped', () => {
    const { fleet, reg } = setup();
    fleet.upsert({ deviceId: 'aa', name: 'A', host: 'h', port: 80, role: 'admin', shared: false, lastSeen: '' });
    fleet.upsert({ deviceId: 'bb', name: 'B', host: 'h', port: 80, role: 'admin', shared: false, lastSeen: '' });
    expect(reg.resolveTargets('all').map((l) => l.deviceId)).toEqual(['aa', 'bb']);
    expect(reg.resolveTargets(['b', 'aa', 'A']).map((l) => l.deviceId)).toEqual(['bb', 'aa']);
    expect(() => reg.resolveTargets(['zz'])).toThrow(/unknown lamp: zz/);
  });

  it('forget removes the fleet entry first and keeps it gone when deleting the secret fails', async () => {
    const dir = tmp();
    const fleet = new FleetStore(dir);
    const order: string[] = [];
    const secrets = {
      get: async () => undefined, set: async () => {},
      delete: async () => { order.push(`delete:${fleet.get('aabbccddeeff') ? 'present' : 'gone'}`); throw new Error('keychain: security delete-generic-password failed (exit 1)'); },
    };
    const reg = new Registry(fleet, secrets, async () => undefined);
    cleanup.push(() => reg.close());
    fleet.upsert({ deviceId: 'aabbccddeeff', name: 'Kitchen', host: '127.0.0.1', port: 1, role: 'ai', shared: true, lastSeen: '' });
    const r = await reg.forget('aabbccddeeff');
    expect(order).toEqual(['delete:gone']);
    expect(r.secretError).toMatch(/delete-generic-password/);
    expect(new FleetStore(dir).get('aabbccddeeff')).toBeUndefined();
  });

  it('client() rejects an unknown lamp', async () => {
    const { reg } = setup();
    await expect(reg.client('nope')).rejects.toThrow(/unknown lamp: nope/);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FleetStore, type FleetLamp } from '../src/store/fleet';
import { makeSecrets, keychainArgs, keychainSetCommand, type Runner } from '../src/store/secrets';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function tmp(): string { const d = mkdtempSync(join(tmpdir(), 'lamp-mcp-')); dirs.push(d); return d; }

const lamp = (o: Partial<FleetLamp> = {}): FleetLamp => ({
  deviceId: 'aabbccddeeff', name: 'Kitchen', host: '192.168.1.5', port: 80, role: 'creator',
  shared: true, lastSeen: '2026-11-10T00:00:00.000Z', ...o,
});

describe('FleetStore', () => {
  it('upserts and gets by deviceId and by name (case-insensitive)', () => {
    const f = new FleetStore(tmp());
    f.upsert(lamp());
    f.upsert(lamp({ deviceId: '112233445566', name: 'Desk' }));
    expect(f.get('aabbccddeeff')?.name).toBe('Kitchen');
    expect(f.get('kitchen')?.deviceId).toBe('aabbccddeeff');
    expect(f.get('Desk')?.deviceId).toBe('112233445566');
    expect(f.get('nope')).toBeUndefined();
    f.upsert(lamp({ name: 'Kitchen 2', port: 8080 }));
    expect(f.list()).toHaveLength(2);
    expect(f.get('aabbccddeeff')?.port).toBe(8080);
  });

  it('persists across instances and removes', () => {
    const d = tmp();
    new FleetStore(d).upsert(lamp());
    const f = new FleetStore(d);
    expect(f.get('Kitchen')?.host).toBe('192.168.1.5');
    f.remove('aabbccddeeff');
    expect(new FleetStore(d).list()).toEqual([]);
  });

  it('never writes key/token fields and leaves valid JSON with no tmp files', () => {
    const d = tmp();
    const f = new FleetStore(d);
    f.upsert({ ...lamp(), key: 'SECRET1', token: 'SECRET2' } as FleetLamp);
    const text = readFileSync(join(d, 'fleet.json'), 'utf8');
    expect(() => JSON.parse(text)).not.toThrow();
    expect(text).not.toContain('SECRET');
    expect(text).not.toMatch(/"(key|token)"/);
    expect(readdirSync(d)).toEqual(['fleet.json']);
  });

  it('starts empty when there is no file', () => {
    expect(new FleetStore(join(tmp(), 'sub')).list()).toEqual([]);
  });

  it('moves an unparsable fleet.json aside, logs one stderr line and starts empty', () => {
    const d = tmp();
    writeFileSync(join(d, 'fleet.json'), '{"lamps": [ broken');
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const f = new FleetStore(d);
      expect(f.list()).toEqual([]);
      expect(err).toHaveBeenCalledTimes(1);
      expect(String(err.mock.calls[0]![0])).toMatch(/fleet\.json\.bad-/);
    } finally { err.mockRestore(); }
    const files = readdirSync(d);
    expect(files.some((n) => /^fleet\.json\.bad-\d+/.test(n))).toBe(true);
    expect(files).not.toContain('fleet.json');
    const bad = files.find((n) => n.startsWith('fleet.json.bad-'))!;
    expect(readFileSync(join(d, bad), 'utf8')).toBe('{"lamps": [ broken');
  });

  it.skipIf(process.getuid?.() === 0)('never overwrites a fleet.json it cannot read', () => {
    const d = tmp();
    const file = join(d, 'fleet.json');
    writeFileSync(file, JSON.stringify({ lamps: [lamp()] }));
    chmodSync(file, 0o000);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const f = new FleetStore(d);
      expect(f.list()).toEqual([]);
      expect(err).toHaveBeenCalledTimes(1);
      expect(String(err.mock.calls[0]![0])).toMatch(/can't read .*fleet\.json/);
      expect(() => f.upsert(lamp({ deviceId: '112233445566', name: 'Desk' }))).toThrow(/not overwriting/);
      expect(() => f.remove('aabbccddeeff')).not.toThrow();
    } finally { err.mockRestore(); }
    chmodSync(file, 0o600);
    expect(JSON.parse(readFileSync(file, 'utf8')).lamps.map((l: FleetLamp) => l.name)).toEqual(['Kitchen']);
    expect(readdirSync(d)).toEqual(['fleet.json']);
  });

  it('moves a fleet.json without a lamps list aside instead of overwriting it', () => {
    const d = tmp();
    writeFileSync(join(d, 'fleet.json'), '{"lamp": []}');
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const f = new FleetStore(d);
      expect(f.list()).toEqual([]);
      expect(err).toHaveBeenCalledTimes(1);
      f.upsert(lamp());
    } finally { err.mockRestore(); }
    const bad = readdirSync(d).find((n) => n.startsWith('fleet.json.bad-'))!;
    expect(readFileSync(join(d, bad), 'utf8')).toBe('{"lamp": []}');
    expect(new FleetStore(d).list().map((l) => l.name)).toEqual(['Kitchen']);
  });

  it('drops entries without a deviceId or name', () => {
    const d = tmp();
    writeFileSync(join(d, 'fleet.json'), JSON.stringify({ lamps: [lamp(), { name: 'NoId' }, { deviceId: 'x1' }, null, 'junk', lamp({ deviceId: '112233445566', name: 'Desk' })] }));
    expect(new FleetStore(d).list().map((l) => l.name)).toEqual(['Kitchen', 'Desk']);
  });
});

describe('Secrets (file backend)', () => {
  it('set/get/delete with mode 0600', async () => {
    const d = tmp();
    const s = makeSecrets(d, 'linux');
    expect(await s.get('aa')).toBeUndefined();
    await s.set('aa', 'k1');
    await s.set('bb', 'k2');
    expect(await s.get('aa')).toBe('k1');
    expect(statSync(join(d, 'secrets.json')).mode & 0o777).toBe(0o600);
    await s.delete('aa');
    expect(await s.get('aa')).toBeUndefined();
    expect(await makeSecrets(d, 'linux').get('bb')).toBe('k2');
    expect(statSync(join(d, 'secrets.json')).mode & 0o777).toBe(0o600);
  });

  it('a missing file is empty; any other read error is thrown with the path only', async () => {
    const d = tmp();
    mkdirSync(join(d, 'secrets.json')); // EISDIR
    const err = await makeSecrets(d, 'linux').get('aa').catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain(join(d, 'secrets.json'));
    // a failed read must never look like "no secrets" (set would then drop every other lamp's key)
    await expect(makeSecrets(d, 'linux').set('aa', 'k1')).rejects.toThrow(/secrets\.json/);
  });
});

describe('Secrets (macOS Keychain backend)', () => {
  it('builds security commands; the secret only travels on stdin (security -i), quoted', () => {
    expect(keychainSetCommand('aa', 'k1')).toBe('add-generic-password -U -s "plaiiin-lamp-mcp" -a "aa" -w "k1"\n');
    expect(keychainSetCommand('aa', 'a"b\\c d\'e')).toBe('add-generic-password -U -s "plaiiin-lamp-mcp" -a "aa" -w "a\\"b\\\\c d\'e"\n');
    expect(() => keychainSetCommand('aa', 'a\nb')).toThrow(/control character/);
    expect(() => keychainSetCommand('aa', 'a\nb')).not.toThrow(/a\nb/);
    expect(keychainArgs.get('aa')).toEqual(['find-generic-password', '-s', 'plaiiin-lamp-mcp', '-a', 'aa', '-w']);
    expect(keychainArgs.delete('aa')).toEqual(['delete-generic-password', '-s', 'plaiiin-lamp-mcp', '-a', 'aa']);
  });

  it('runs /usr/bin/security via the injected runner; not-found maps to undefined; errors hide the secret', async () => {
    const calls: Array<{ cmd: string; args: string[]; input?: string }> = [];
    let reply = { code: 0, stdout: 'k1\n', stderr: '' };
    const run: Runner = async (cmd, args, input) => { calls.push({ cmd, args, ...(input !== undefined ? { input } : {}) }); return reply; };
    const s = makeSecrets(tmp(), 'darwin', run);
    expect(await s.get('aa')).toBe('k1');
    expect(calls[0]).toEqual({ cmd: '/usr/bin/security', args: keychainArgs.get('aa') });
    reply = { code: 44, stdout: '', stderr: 'The specified item could not be found in the keychain.' };
    expect(await s.get('aa')).toBeUndefined();
    await expect(s.delete('aa')).resolves.toBeUndefined();
    reply = { code: 1, stdout: '', stderr: 'boom TOPSECRET' };
    const err = await s.set('aa', 'TOPSECRET').catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String((err as Error).message)).not.toContain('TOPSECRET');
    const setCall = calls.find((c) => c.input !== undefined)!;
    expect(setCall).toEqual({ cmd: '/usr/bin/security', args: ['-i'], input: keychainSetCommand('aa', 'TOPSECRET') });
    for (const c of calls) expect(c.args.join(' ')).not.toContain('TOPSECRET');
  });
});

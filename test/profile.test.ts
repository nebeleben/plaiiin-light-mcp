import { describe, expect, it } from 'vitest';
import { resolveProfile } from '../src/profile';
import { makeSecrets, keychainArgs, keychainSetCommand, type Runner } from '../src/store/secrets';

describe('state profile', () => {
  it('no profile keeps the existing folder and Keychain service', () => {
    expect(resolveProfile({}, '/h')).toEqual({ stateDir: '/h/.plaiiin/lamps', keychainService: 'plaiiin-lamp-mcp' });
  });

  it('a profile gets its own folder and Keychain service', () => {
    expect(resolveProfile({ PLAIIIN_LAMPS_PROFILE: 'chatgpt' }, '/h'))
      .toEqual({ stateDir: '/h/.plaiiin/lamps-chatgpt', keychainService: 'plaiiin-lamp-mcp-chatgpt' });
  });

  it('PLAIIIN_LAMPS_DIR still overrides the folder, not the service', () => {
    expect(resolveProfile({ PLAIIIN_LAMPS_PROFILE: 'chatgpt', PLAIIIN_LAMPS_DIR: '/tmp/x' }, '/h'))
      .toEqual({ stateDir: '/tmp/x', keychainService: 'plaiiin-lamp-mcp-chatgpt' });
    expect(resolveProfile({ PLAIIIN_LAMPS_DIR: '/tmp/x' }, '/h'))
      .toEqual({ stateDir: '/tmp/x', keychainService: 'plaiiin-lamp-mcp' });
  });

  it('refuses a malformed profile', () => {
    for (const bad of ['../x', 'a b', 'A', '', 'x/y', 'x.y', '-', 'x'.repeat(40)])
      expect(() => resolveProfile({ PLAIIIN_LAMPS_PROFILE: bad }, '/h'), JSON.stringify(bad)).toThrow(/PLAIIIN_LAMPS_PROFILE/);
  });
});

describe('Keychain service per profile', () => {
  const SERVICE = 'plaiiin-lamp-mcp-chatgpt';

  it('the command builders carry the given service', () => {
    expect(keychainSetCommand('aa', 'k1', SERVICE)).toBe('add-generic-password -U -s "plaiiin-lamp-mcp-chatgpt" -a "aa" -w "k1"\n');
    expect(keychainArgs.get('aa', SERVICE)).toEqual(['find-generic-password', '-s', SERVICE, '-a', 'aa', '-w']);
    expect(keychainArgs.delete('aa', SERVICE)).toEqual(['delete-generic-password', '-s', SERVICE, '-a', 'aa']);
  });

  it('a store made for a service reads, writes and deletes only under it', async () => {
    const calls: Array<{ args: string[]; input?: string }> = [];
    const run: Runner = async (_cmd, args, input) => { calls.push({ args, input }); return { code: 0, stdout: 'k\n', stderr: '' }; };
    const s = makeSecrets('/unused', 'darwin', run, SERVICE);
    await s.get('aa'); await s.set('aa', 'k1'); await s.delete('aa');
    expect(calls).toHaveLength(3);
    for (const c of calls) {
      const text = [...c.args, c.input ?? ''].join(' ');
      expect(text).toContain(SERVICE);
      expect(text.replaceAll(SERVICE, '')).not.toContain('plaiiin-lamp-mcp');
    }
  });
});

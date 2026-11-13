import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = resolve(__dirname, '..');
const dir = join(root, 'plugin-chatgpt');
const claude = join(root, 'plugin');
const json = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const launch = join(dir, 'bin/launch');

/** All files under `d`, relative, sorted. */
// Another test file may be running the build right now: its in-flight temp files are not part of the result.
const files = (d: string): string[] => readdirSync(d, { recursive: true, withFileTypes: true })
  .filter((e) => e.isFile() && !/\.tmp-\d+(-\d+)?$/.test(e.name)).map((e) => join(e.parentPath, e.name).slice(d.length + 1)).sort();

// The Claude Code public repo carries no plugin-chatgpt/ folder: there this whole file is skipped.
describe.skipIf(!existsSync(join(dir, '.codex-plugin/plugin.json')))('ChatGPT plugin packaging', () => {
  beforeAll(() => { execFileSync(process.execPath, ['esbuild.mjs'], { cwd: root, stdio: 'ignore' }); }, 60_000);

  it('has only the Codex-style manifest', () => {
    // With a root plugin.json / mcp.json beside it, the host loads the skills but registers no server.
    expect(existsSync(join(dir, 'plugin.json'))).toBe(false);
    expect(existsSync(join(dir, 'mcp.json'))).toBe(false);
    const pkg = json(join(root, 'package.json'));
    const m = json(join(dir, '.codex-plugin/plugin.json'));
    expect(m).toMatchObject({ name: 'plaiiin-lamps', version: pkg.version, license: 'Apache-2.0', skills: './skills/', mcpServers: './.mcp.json' });
    expect(m.interface).toMatchObject({
      displayName: 'PlaiiinLight lamps', developerName: 'plaiiin', category: 'Lifestyle', capabilities: ['Read', 'Write'],
      logo: './assets/logo.png', logoDark: './assets/logo-dark.png', composerIcon: './assets/composer-icon.png',
      websiteURL: 'https://plaiiin-light.com/integrations.html#chatgpt', privacyPolicyURL: 'https://plaiiin-light.com/privacy.html',
    });
    expect(m.interface.brandColor).toMatch(/^#[0-9a-fA-F]{6}$/);
    for (const k of ['logo', 'logoDark', 'composerIcon']) expect(statSync(join(dir, m.interface[k])).size, k).toBeGreaterThan(200);
    expect(Array.isArray(m.interface.defaultPrompt) && m.interface.defaultPrompt.length >= 2).toBe(true);
  });

  it('starts the launcher from the plugin folder and sets no approval mode', () => {
    const servers = json(join(dir, '.mcp.json')).mcpServers;
    expect(Object.keys(servers)).toEqual(['lamps']);
    expect(servers.lamps).toEqual({ command: '/bin/sh', args: ['./bin/launch'], cwd: '.' });
  });

  it('marketplace lists the plugin from ./plugin-chatgpt', () => {
    const mk = json(join(root, '.agents/plugins/marketplace.json'));
    expect(mk.name).toBe('plaiiin-lamps');
    expect(mk.plugins).toEqual([expect.objectContaining({ name: 'plaiiin-lamps', source: { source: 'local', path: './plugin-chatgpt' } })]);
  });

  it('ships bundle, notices and skills; the same ones as the Claude Code target', () => {
    expect(files(join(dir, 'dist'))).toEqual(['index.js', 'package.json', 'preview-worker.mjs']);
    expect(files(join(dir, 'skills'))).toEqual(files(join(root, 'skills')));
    for (const f of files(join(root, 'skills'))) expect(readFileSync(join(dir, 'skills', f), 'utf8'), f).toBe(readFileSync(join(root, 'skills', f), 'utf8'));
    expect(statSync(join(dir, 'THIRD-PARTY-NOTICES.txt')).size).toBeGreaterThan(1000);
    if (!existsSync(join(claude, '.claude-plugin/plugin.json'))) return;   // the ChatGPT public repo has no plugin/
    for (const f of ['dist/index.js', 'dist/package.json', 'dist/preview-worker.mjs', 'THIRD-PARTY-NOTICES.txt'])
      expect(readFileSync(join(dir, f)).equals(readFileSync(join(claude, f))), f).toBe(true);
  });

  describe('bin/launch', () => {
    /** A stand-in `node`: reports `version`, otherwise says who ran and with what. */
    function fakeNode(where: string, version: string): string {
      mkdirSync(where, { recursive: true });
      const p = join(where, 'node');
      writeFileSync(p, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${version}"; exit 0; fi\necho "RAN ${p} PROFILE=$PLAIIIN_LAMPS_PROFILE CWD=$(pwd) ARGS=$*"\n`);
      chmodSync(p, 0o755);
      return p;
    }
    /** Run the launcher in a world where only what the test put there exists. */
    function run(env: Record<string, string>, cwd = dir) {
      const empty = mkdtempSync(join(tmpdir(), 'launch-'));
      return spawnSync('/bin/sh', [launch], {
        cwd, encoding: 'utf8',
        env: { HOME: join(empty, 'home'), PATH: '/usr/bin:/bin', PLAIIIN_CHATGPT_APP: join(empty, 'NoSuch.app'), PLAIIIN_LAMPS_EXTRA_PATH: join(empty, 'nobin'), ...env },
      });
    }
    const tmp = () => mkdtempSync(join(tmpdir(), 'nodes-'));

    it('launcher prefers a usable runtime', () => {
      const hinted = fakeNode(join(tmp(), 'hint'), 'v22.3.0');
      const onPath = fakeNode(join(tmp(), 'path'), 'v22.9.0');
      const r = run({ CODEX_MCP_NODE_PATH: hinted, PATH: `${join(onPath, '..')}:/usr/bin:/bin` });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(`RAN ${hinted} PROFILE=chatgpt`);
      expect(r.stdout).toContain('ARGS=dist/index.js');
    });

    it('launcher uses the Node inside the ChatGPT app', () => {
      const app = join(tmp(), 'ChatGPT.app');
      const inApp = fakeNode(join(app, 'Contents/Resources/cua_node/bin'), 'v24.22.1');
      const r = run({ PLAIIIN_CHATGPT_APP: app });
      expect(r.stdout).toContain(`RAN ${inApp} PROFILE=chatgpt`);
    });

    it('launcher falls back to node on the extended PATH', () => {
      const extra = fakeNode(join(tmp(), 'homebrew'), 'v20.0.0');
      const r = run({ PLAIIIN_LAMPS_EXTRA_PATH: join(extra, '..') });
      expect(r.stdout).toContain(`RAN ${extra} PROFILE=chatgpt`);
    });

    it('launcher skips Node older than 20', () => {
      const old = fakeNode(join(tmp(), 'old'), 'v18.20.4');
      const ok = fakeNode(join(tmp(), 'ok'), 'v22.1.0');
      const r = run({ CODEX_MCP_NODE_PATH: old, PATH: `${join(ok, '..')}:/usr/bin:/bin` });
      expect(r.stdout).toContain(`RAN ${ok} `);
    });

    it('launcher fails with a clear message', () => {
      const old = fakeNode(join(tmp(), 'old'), 'v18.20.4');
      const r = run({ CODEX_MCP_NODE_PATH: old });
      expect(r.status).toBe(127);
      expect(r.stdout).toBe('');
      expect(r.stderr.trim().split('\n')).toHaveLength(1);
      expect(r.stderr).toMatch(/Node\.js 20/);
    });

    it('launcher runs from the plugin folder wherever it is started', () => {
      const ok = fakeNode(join(tmp(), 'ok'), 'v22.1.0');
      const r = run({ CODEX_MCP_NODE_PATH: ok }, tmpdir());
      expect(r.stdout).toContain(`CWD=${dir} `);
    });
  });

  it('the launched server keeps its own lamp list, apart from other assistants', async () => {
    // A home where another assistant's plugin already knows a lamp, and this one knows a different one.
    const home = mkdtempSync(join(tmpdir(), 'home-'));
    const seed = (folder: string, name: string, deviceId: string) => {
      mkdirSync(join(home, '.plaiiin', folder), { recursive: true });
      writeFileSync(join(home, '.plaiiin', folder, 'fleet.json'), JSON.stringify({ lamps: [
        { deviceId, name, host: '127.0.0.1', port: 9, role: 'admin', shared: false, lastSeen: '2026-01-01T00:00:00.000Z' },
      ] }));
    };
    seed('lamps', 'other-assistants-lamp', 'aaaaaaaaaaaa');
    seed('lamps-chatgpt', 'chatgpt-lamp', 'bbbbbbbbbbbb');
    const env = Object.fromEntries(Object.entries({ ...process.env, HOME: home }).filter(([k, v]) => v !== undefined && !k.startsWith('PLAIIIN_LAMPS_'))) as Record<string, string>;
    const transport = new StdioClientTransport({ command: '/bin/sh', args: ['./bin/launch'], cwd: dir, env });
    const client = new Client({ name: 'packaging-test', version: '0' });
    await client.connect(transport);
    try {
      expect(client.getServerVersion()).toMatchObject({ name: 'plaiiin-lamps', version: json(join(root, 'package.json')).version });
      const r = await client.callTool({ name: 'lamps_list', arguments: {} }) as { content: Array<{ text: string }> };
      const names = (JSON.parse(r.content[0]!.text) as { lamps: Array<{ name: string }> }).lamps.map((l) => l.name);
      expect(names).toEqual(['chatgpt-lamp']);
      expect((await client.listTools()).tools.length).toBeGreaterThanOrEqual(30);
    } finally { await client.close(); }
  }, 30_000);
});

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { hasTarget } from './targets';

// These tests start git / npm / node processes; on a busy machine the default 10 s is too tight.
vi.setConfig({ testTimeout: 60_000 });

const root = resolve(__dirname, '..');
const dir = join(root, 'npm');
const bin = join(dir, 'bin/plaiiinlight-mcp.mjs');
const json = (p: string) => JSON.parse(readFileSync(p, 'utf8'));

/** The environment a client would start it in, minus anything of ours it might have inherited. */
function cleanEnv(extra: Record<string, string>): Record<string, string> {
  return { ...Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !k.startsWith('PLAIIIN_LAMPS_'))) as Record<string, string>, ...extra };
}
function run(args: string[], env: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'npmhome-'));
  const r = spawnSync(process.execPath, [bin, ...args], { env: cleanEnv({ HOME: home, ...env }), input: '', encoding: 'utf8', timeout: 20_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, home };
}
const oneLine = (s: string) => s.trim().split('\n').length === 1 && s.trim().length > 0;

/** A home where three profiles each know a different lamp. */
function seededHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'npmhome-'));
  for (const [folder, name, id] of [['lamps', 'other-assistants-lamp', 'aaaaaaaaaaaa'], ['lamps-chatgpt', 'chatgpt-lamp', 'bbbbbbbbbbbb'], ['lamps-gemini', 'gemini-lamp', 'cccccccccccc']] as const) {
    mkdirSync(join(home, '.plaiiin', folder), { recursive: true });
    writeFileSync(join(home, '.plaiiin', folder, 'fleet.json'), JSON.stringify({ lamps: [
      { deviceId: id, name, host: '127.0.0.1', port: 9, role: 'admin', shared: false, lastSeen: '2026-01-01T00:00:00.000Z' },
    ] }));
  }
  return home;
}
async function withClient<T>(args: string[], env: Record<string, string>, f: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: 'packaging-test', version: '0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [bin, ...args], env: cleanEnv(env), stderr: 'ignore' }));
  try { return await f(client); } finally { await client.close(); }
}
const lampNames = async (c: Client) => {
  const r = await c.callTool({ name: 'lamps_list', arguments: {} }) as { content: Array<{ text: string }> };
  return (JSON.parse(r.content[0]!.text) as { lamps: Array<{ name: string }> }).lamps.map((l) => l.name);
};

// The plugin repos carry no npm/ folder: there this whole file is skipped.
describe.skipIf(!hasTarget(root, 'npm'))('npm package plaiiinlight-mcp', () => {
  const pkg = json(join(root, 'package.json'));
  beforeAll(() => { execFileSync(process.execPath, ['esbuild.mjs'], { cwd: root, stdio: 'ignore' }); }, 60_000);

  it('package.json is what npm and trusted publishing need', () => {
    const p = json(join(dir, 'package.json'));
    expect(p).toMatchObject({
      name: 'plaiiinlight-mcp', version: pkg.version, type: 'module', license: 'Apache-2.0',
      bin: { 'plaiiinlight-mcp': 'bin/plaiiinlight-mcp.mjs' }, engines: { node: '>=20' },
      // trusted publishing compares this with the repository the workflow runs in
      repository: { type: 'git', url: 'git+https://github.com/nebeleben/plaiiin-light-mcp.git' },
    });
    expect(p.dependencies).toBeUndefined();
    expect(p.scripts).toBeUndefined();
    expect(p.private).toBeUndefined();
  });

  it('server.json describes the package for the MCP Registry', () => {
    const p = json(join(dir, 'package.json'));
    const sj = json(join(dir, 'server.json'));
    // the registry verifies ownership by finding this name inside the published npm package
    expect(p.mcpName).toBe('io.github.nebeleben/plaiiinlight-mcp');
    expect(sj.name).toBe(p.mcpName);
    expect(sj.$schema).toBe('https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json');
    expect(sj.version).toBe(pkg.version);
    expect(sj.description.length).toBeLessThanOrEqual(100);
    expect(sj.description).toMatch(/macOS/);
    expect(sj.title.length).toBeLessThanOrEqual(100);
    expect(sj.repository).toEqual({ url: 'https://github.com/nebeleben/plaiiin-light-mcp', source: 'github', subfolder: 'npm' });
    expect(sj.packages).toHaveLength(1);
    expect(sj.packages[0]).toMatchObject({ registryType: 'npm', identifier: 'plaiiinlight-mcp', version: pkg.version, runtimeHint: 'npx', transport: { type: 'stdio' } });
    // the one thing the server insists on: a client that reads this prompts the user for it
    expect(sj.packages[0].packageArguments).toEqual([expect.objectContaining({ type: 'named', name: '--profile', isRequired: true, format: 'string' })]);
    expect(sj.packages[0].packageArguments[0].description.length).toBeGreaterThan(40);
    for (const icon of sj.icons) expect(icon.src).toMatch(/^https:\/\/raw\.githubusercontent\.com\/nebeleben\/plaiiin-light-mcp\/main\/npm\//);
    expect(existsSync(join(dir, 'icon.png'))).toBe(true);
  });

  it('the packed file list is exactly the published surface', () => {
    // its own cache: the result must not depend on the state of the machine's ~/.npm
    const cache = mkdtempSync(join(tmpdir(), 'npmcache-'));
    const out = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--cache', cache], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
    expect(out[0].files.map((f: { path: string }) => f.path).sort()).toEqual([
      'LICENSE', 'README.md', 'THIRD-PARTY-NOTICES.txt', 'bin/plaiiinlight-mcp.mjs',
      'dist/index.js', 'dist/package.json', 'dist/preview-worker.mjs', 'package.json',
    ]);
  });

  it('refuses without a profile', () => {
    const r = run([]);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
    expect(oneLine(r.stderr)).toBe(true);
    expect(r.stderr).toMatch(/--profile <name>/);
    expect(r.stderr).toMatch(/--profile gemini/);
    expect(existsSync(join(r.home, '.plaiiin'))).toBe(false);
  });

  it('refuses a malformed profile', () => {
    const cases: Array<[string[], Record<string, string>]> = [
      [['--profile', '../x'], {}], [['--profile', 'A b'], {}], [['--profile='], {}], [['--profile', ''], {}],
      [[], { PLAIIIN_LAMPS_PROFILE: '../x' }], [[], { PLAIIIN_LAMPS_PROFILE: '' }],
    ];
    for (const [args, env] of cases) {
      const r = run(args, env);
      const what = JSON.stringify([args, env]);
      expect(r.status, what).toBe(2);
      expect(r.stdout, what).toBe('');
      expect(oneLine(r.stderr), what).toBe(true);
      expect(existsSync(join(r.home, '.plaiiin')), what).toBe(false);
    }
  });

  it('refuses arguments it does not understand', () => {
    for (const args of [['--profile'], ['--profile', 'a', '--profile', 'b'], ['--frobnicate'], ['gemini'], ['--profile', 'a', 'extra']]) {
      const r = run(args);
      expect(r.status, String(args)).toBe(2);
      expect(r.stdout, String(args)).toBe('');
      expect(oneLine(r.stderr), String(args)).toBe(true);
      expect(existsSync(join(r.home, '.plaiiin')), String(args)).toBe(false);
    }
  });

  it('a refusal stays one short line whatever was passed', () => {
    const r = run(['--' + 'x'.repeat(100_000)]);
    expect(r.status).toBe(2);
    expect(oneLine(r.stderr)).toBe(true);
    expect(r.stderr.length).toBeLessThan(400);
    const nl = run(['--profile', 'a\nb']);
    expect(nl.status).toBe(2);
    expect(oneLine(nl.stderr)).toBe(true);
  });

  it('--version and --help do not start the server', () => {
    expect(run(['--version'])).toMatchObject({ status: 0, stdout: `${pkg.version}\n`, stderr: '' });
    const h = run(['--help']);
    expect(h.status).toBe(0);
    expect(h.stdout).toBe('');   // stdout belongs to the protocol; help is for a person at a terminal
    expect(h.stderr).toMatch(/npx -y plaiiinlight-mcp --profile/);
    expect(h.stderr).toMatch(/github\.com\/nebeleben\/plaiiin-light-mcp/);
  });

  it('with a profile: tools, guidance and only that profile\'s lamps', async () => {
    await withClient(['--profile', 'gemini'], { HOME: seededHome() }, async (c) => {
      expect(c.getServerVersion()).toMatchObject({ name: 'plaiiin-lamps', version: pkg.version });
      expect((await c.listTools()).tools.length).toBeGreaterThanOrEqual(30);
      expect((await c.listPrompts()).prompts).toHaveLength(5);
      expect((await c.listResources()).resources).toHaveLength(5);
      expect(await lampNames(c)).toEqual(['gemini-lamp']);
    });
  }, 30_000);

  it('--profile=name works too', async () => {
    await withClient(['--profile=gemini'], { HOME: seededHome() }, async (c) => { expect(await lampNames(c)).toEqual(['gemini-lamp']); });
  }, 30_000);

  it('the argument wins over the environment', async () => {
    await withClient(['--profile', 'gemini'], { HOME: seededHome(), PLAIIIN_LAMPS_PROFILE: 'chatgpt' }, async (c) => { expect(await lampNames(c)).toEqual(['gemini-lamp']); });
  }, 30_000);

  it('the environment alone is enough', async () => {
    await withClient([], { HOME: seededHome(), PLAIIIN_LAMPS_PROFILE: 'gemini' }, async (c) => { expect(await lampNames(c)).toEqual(['gemini-lamp']); });
  }, 30_000);
});

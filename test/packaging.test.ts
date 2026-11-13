import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = resolve(__dirname, '..');
// Each public repo carries one packaging folder. The checks that are about the server, the build
// and the skills run against whichever is here; the Claude Code specifics are skipped without it.
const hasClaude = existsSync(join(root, 'plugin/.claude-plugin/plugin.json'));
const plugin = join(root, hasClaude ? 'plugin' : 'plugin-chatgpt');
// Build once for the whole file: the tool checks below run against the bundle Claude Code would start.
beforeAll(() => { execFileSync(process.execPath, ['esbuild.mjs'], { cwd: root, stdio: 'ignore' }); }, 60_000);

const json = (p: string) => JSON.parse(readFileSync(p, 'utf8'));

/** YAML frontmatter of a markdown file as flat `key: value` pairs (enough for these files). */
function frontmatter(path: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(readFileSync(path, 'utf8'));
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of m[1]!.split('\n')) {
    const kv = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]!] = kv[2]!.replace(/^["']|["']$/g, '').trim();
  }
  return out;
}

describe('plugin packaging', () => {
  it('one version everywhere', () => {
    // The release refuses to publish unless the tag agrees with package.json and the target's manifest.
    const pkg = json(join(root, 'package.json'));
    expect(readFileSync(join(root, 'src/server.ts'), 'utf8')).toContain(`export const SERVER_VERSION = '${pkg.version}';`);
    expect(json(join(root, 'package-lock.json')).version).toBe(pkg.version);
    const manifests = ['plugin/.claude-plugin/plugin.json', 'plugin-chatgpt/.codex-plugin/plugin.json'].filter((m) => existsSync(join(root, m)));
    expect(manifests.length).toBeGreaterThan(0);
    for (const m of manifests) expect(json(join(root, m)).version, m).toBe(pkg.version);
  });

  it.skipIf(!hasClaude)('plugin.json and marketplace.json agree on the plugin name', () => {
    const manifest = json(join(plugin, '.claude-plugin/plugin.json'));
    const market = json(join(root, '.claude-plugin/marketplace.json'));
    expect(manifest.name).toBe('plaiiin-lamps');
    expect(manifest.author).toEqual({ name: 'plaiiin' });
    expect(market.name).toBe('plaiiin-lamps');
    expect(market.owner).toEqual({ name: 'plaiiin' });
    expect(market.plugins).toHaveLength(1);
    expect(market.plugins[0]).toMatchObject({
      name: 'plaiiin-lamps', source: './plugin', license: 'Apache-2.0',
      homepage: 'https://github.com/nebeleben/plaiiin-light-claudecode',
    });
    expect(market.plugins[0].version).toBeUndefined();   // plugin.json is the only version source
  });

  it.skipIf(!hasClaude)('.mcp.json starts the bundled server', () => {
    const mcp = json(join(plugin, '.mcp.json'));
    expect(mcp.mcpServers.lamps).toEqual({ command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/dist/index.js'] });
  });

  it('ships no package.json or node_modules at the plugin root', () => {
    expect(existsSync(join(plugin, 'package.json'))).toBe(false);
    expect(existsSync(join(plugin, 'node_modules'))).toBe(false);
  });

  it('every skill has a description; the expected skills exist', () => {
    const skills = readdirSync(join(plugin, 'skills'));
    expect(skills.sort()).toEqual(['compose-effect', 'draw-image', 'fleet-ota', 'lamp-access', 'scenes']);
    for (const s of skills) {
      const fm = frontmatter(join(plugin, 'skills', s, 'SKILL.md'));
      expect(fm.description, s).toBeTruthy();
      expect(fm.description!.length, s).toBeGreaterThan(40);
    }
  });

  it('skills come from the shared source and are worded for any assistant', () => {
    const names = readdirSync(join(root, 'skills'));
    expect(readdirSync(join(plugin, 'skills')).sort()).toEqual([...names].sort());
    for (const s of names) {
      const src = readFileSync(join(root, 'skills', s, 'SKILL.md'), 'utf8');
      expect(readFileSync(join(plugin, 'skills', s, 'SKILL.md'), 'utf8')).toBe(src);
      // "Claude" may only appear inside a quotation of the app's own UI text
      expect(src.replace(/"[^"\n]*"/g, '').replace(/“[^”\n]*”/g, ''), s).not.toMatch(/\bClaude\b/);
    }
  });

  it.skipIf(!hasClaude)('commands have descriptions; compose takes arguments', () => {
    const lamps = frontmatter(join(plugin, 'commands/lamps.md'));
    const compose = frontmatter(join(plugin, 'commands/compose.md'));
    expect(lamps.description).toBeTruthy();
    expect(compose.description).toBeTruthy();
    expect(compose['argument-hint']).toBe('<idea> [lamp]');
    expect(readFileSync(join(plugin, 'commands/compose.md'), 'utf8')).toContain('$ARGUMENTS');
  });

  it('skills mention only tools the server has', async () => {
    const names = new Set(await toolNames());
    for (const s of readdirSync(join(plugin, 'skills'))) {
      const text = readFileSync(join(plugin, 'skills', s, 'SKILL.md'), 'utf8');
      const used = [...text.matchAll(/`((?:lamps?|effects?|image|images|scenes?|swarms|stream|streams|firmware|library)_[a-z_]+)`/g)].map((m) => m[1]!);
      for (const t of used) expect(names.has(t), `${s} mentions ${t}`).toBe(true);
    }
    for (const c of hasClaude ? ['lamps.md', 'compose.md'] : []) {
      const text = readFileSync(join(plugin, 'commands', c), 'utf8');
      const used = [...text.matchAll(/`((?:lamps?|effects?|swarms)_[a-z_]+)`/g)].map((m) => m[1]!);
      for (const t of used) expect(names.has(t), `${c} mentions ${t}`).toBe(true);
    }
  }, 60_000);
});

let cached: Awaited<ReturnType<Client['listTools']>>['tools'] | undefined;
async function listTools() {
  if (cached) return cached;
  const dir = mkdtempSync(join(tmpdir(), 'lamp-mcp-pkg-'));
  const transport = new StdioClientTransport({
    command: process.execPath, args: [join(plugin, 'dist/index.js')],
    env: { ...process.env, PLAIIIN_LAMPS_DIR: dir } as Record<string, string>,
    stderr: 'ignore',
  });
  const client = new Client({ name: 'packaging-test', version: '0.0.0' });
  try {
    await client.connect(transport);
    cached = (await client.listTools()).tools;
    return cached;
  } finally {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
const toolNames = async () => (await listTools()).map((t) => t.name);

describe('built plugin server', () => {
  it('ships third-party notices for every bundled package', () => {
    const text = readFileSync(join(plugin, 'THIRD-PARTY-NOTICES.txt'), 'utf8');
    for (const dep of ['@modelcontextprotocol/sdk', 'bonjour-service', 'jpeg-js', 'jsqr', 'omggif', 'pngjs', 'ws', 'zod'])
      expect(text, dep).toContain(`\n${dep}@`);
    expect(text).not.toMatch(/node_modules\/|\/Users\/|\/home\//);   // no build-machine paths
  });

  it('every bundled package comes with its licence text', () => {
    const text = readFileSync(join(plugin, 'THIRD-PARTY-NOTICES.txt'), 'utf8');
    expect(text).not.toContain('ships no licence file');
    // omggif has no LICENSE file: its MIT notice lives in the header of its main file
    const omggif = text.slice(text.indexOf('\nomggif@'));
    expect(omggif.slice(0, 1500)).toContain('Permission is hereby granted, free of charge');
    expect(omggif.slice(0, 1500)).toContain('Dean McNamee');
  });

  it('the licence file names this project', () => {
    const text = readFileSync(join(root, 'LICENSE'), 'utf8');
    expect(text).toContain('Copyright 2026 plaiiin.com — plaiiin-lamps');
    expect(text).not.toContain('node-red');
  });

  it('build is deterministic', () => {
    const files = ['dist/index.js', 'dist/preview-worker.mjs', 'THIRD-PARTY-NOTICES.txt'];
    const read = () => files.map((f) => readFileSync(join(plugin, f)));
    const first = read();
    execFileSync(process.execPath, ['esbuild.mjs'], { cwd: root, stdio: 'ignore' });
    read().forEach((b, i) => expect(b.equals(first[i]!), files[i]).toBe(true));
  }, 60_000);

  it('refuses to start under a malformed profile', () => {
    const r = spawnSync(process.execPath, [join(plugin, 'dist/index.js')], {
      env: { ...process.env, PLAIIIN_LAMPS_PROFILE: '../elsewhere', PLAIIIN_LAMPS_DIR: mkdtempSync(join(tmpdir(), 'pl-')) },
      input: '', encoding: 'utf8', timeout: 20_000,
    });
    expect(r.status).toBe(1);
    expect(r.stderr.trim().split('\n')).toHaveLength(1);
    expect(r.stderr).toMatch(/^plaiiin-lamps: PLAIIIN_LAMPS_PROFILE must be/);
    expect(r.stdout).toBe('');
  });

  it('bundles the server and the preview worker', () => {
    expect(existsSync(join(plugin, 'dist/index.js'))).toBe(true);
    expect(existsSync(join(plugin, 'dist/preview-worker.mjs'))).toBe(true);
  });

  it('lists the tools, each with a description and annotations', async () => {
    const tools = await listTools();
    expect(tools.length).toBeGreaterThanOrEqual(30);
    const names = tools.map((t) => t.name);
    for (const t of ['lamps_list', 'effect_preview', 'firmware_update']) expect(names).toContain(t);
    for (const t of tools) {
      expect(t.description, t.name).toBeTruthy();
      expect(t.annotations, t.name).toBeDefined();
      expect(typeof t.annotations!.readOnlyHint, t.name).toBe('boolean');
      expect(typeof t.annotations!.destructiveHint, t.name).toBe('boolean');
    }
  }, 30_000);
});

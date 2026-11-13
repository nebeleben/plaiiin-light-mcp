import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = resolve(__dirname, '..');
// whichever packaging folder this tree has (a public repo carries only one); the bundle is the same
const dist = join(root, existsSync(join(root, 'plugin/.claude-plugin/plugin.json')) ? 'plugin' : 'plugin-chatgpt', 'dist/index.js');

describe('built server over stdio', () => {
  beforeAll(() => { execFileSync(process.execPath, ['esbuild.mjs'], { cwd: root }); }, 60_000);

  it('starts and answers tools/list', async () => {
    expect(existsSync(dist)).toBe(true);
    const dir = mkdtempSync(join(tmpdir(), 'lamp-mcp-stdio-'));
    const transport = new StdioClientTransport({
      command: process.execPath, args: [dist],
      env: { ...process.env, PLAIIIN_LAMPS_DIR: dir } as Record<string, string>,
      stderr: 'ignore',
    });
    const client = new Client({ name: 'stdio-test', version: '0.0.0' });
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain('lamps_list');
      const r = await client.callTool({ name: 'lamps_list', arguments: {} });
      expect(JSON.parse((r.content as Array<{ text: string }>)[0]!.text)).toEqual({ lamps: [] });
      // the bundled shade runtime renders a preview (no file reads outside the bundle)
      const p = await client.callTool({ name: 'effect_preview', arguments: { source: 'function shade(){ emit(0, 255, 0); }', w: 4, h: 4, frames: 2 } });
      const parts = p.content as Array<{ type: string; mimeType?: string; text?: string }>;
      expect(parts.find((c) => c.type === 'image')?.mimeType).toBe('image/png');
      expect(JSON.parse(parts.find((c) => c.type === 'text')!.text!)).toMatchObject({ ok: true, grid: { w: 4, h: 4 }, frames: 2 });
    } finally {
      await client.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('library console.log output goes to stderr; stdout stays pure JSON-RPC', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lamp-mcp-stdio-'));
    const p = spawn(process.execPath, ['--import', join(__dirname, 'fixtures/console-noise.mjs'), dist], {
      env: { ...process.env, PLAIIIN_LAMPS_DIR: dir }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    p.stdout.on('data', (c: Buffer) => { out += c.toString('utf8'); });
    p.stderr.on('data', (c: Buffer) => { err += c.toString('utf8'); });
    try {
      p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } }) + '\n');
      await new Promise((r) => setTimeout(r, 1200));
      expect(err).toContain('gif stream longer');
      expect(err).toContain('bonjour noise');
      const lines = out.split('\n').filter(Boolean);
      expect(lines.length).toBeGreaterThan(0);
      for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
    } finally {
      p.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

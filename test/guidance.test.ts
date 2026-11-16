import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SKILLS } from '../src/guidance';
import { buildServer } from '../src/server';
import { Confirmations } from '../src/tools/confirm';
import type { ToolContext } from '../src/tools/context';
import { FleetStore } from '../src/store/fleet';
import { makeSecrets } from '../src/store/secrets';
import { Registry } from '../src/lamp/registry';

const root = resolve(__dirname, '..');
const dirs: string[] = [];

async function connect(opts?: { guidance?: boolean }): Promise<Client> {
  const dir = mkdtempSync(join(tmpdir(), 'lamp-mcp-g-'));
  dirs.push(dir);
  const registry = new Registry(new FleetStore(dir), makeSecrets(dir, 'linux'), async () => undefined);
  const ctx: ToolContext = { registry, confirm: new Confirmations(), stateDir: dir, discover: async () => [], readClipboard: async () => '' };
  const server = buildServer(ctx, opts);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(ct);
  return client;
}
const text = (name: string) => SKILLS.find((s) => s.name === name)!.text;

describe('guidance', () => {
  let client: Client, plain: Client;
  beforeAll(async () => { client = await connect({ guidance: true }); plain = await connect(); });
  afterAll(async () => { await client.close(); await plain.close(); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

  it('every skill folder is offered', () => {
    expect(SKILLS.map((s) => s.name).sort()).toEqual(readdirSync(join(root, 'skills')).sort());
    for (const s of SKILLS) {
      expect(s.description.length, s.name).toBeGreaterThan(40);
      expect(s.text, s.name).not.toMatch(/^---/);
      expect(s.text.startsWith('# '), s.name).toBe(true);
    }
  });

  it('with guidance: one prompt per skill, returning its text', async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(SKILLS.map((s) => s.name).sort());
    expect(prompts.find((p) => p.name === 'compose-effect')!.description).toBe(SKILLS.find((s) => s.name === 'compose-effect')!.description);
    const got = await client.getPrompt({ name: 'compose-effect' });
    expect(got.messages).toHaveLength(1);
    expect(got.messages[0]).toEqual({ role: 'user', content: { type: 'text', text: text('compose-effect') } });
  });

  it('with guidance: one Markdown resource per skill', async () => {
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri).sort()).toEqual(SKILLS.map((s) => `plaiiin-lamps://skills/${s.name}`).sort());
    expect(resources.every((r) => r.mimeType === 'text/markdown')).toBe(true);
    const read = await client.readResource({ uri: 'plaiiin-lamps://skills/lamp-access' });
    expect(read.contents).toHaveLength(1);
    expect(read.contents[0]).toMatchObject({ uri: 'plaiiin-lamps://skills/lamp-access', mimeType: 'text/markdown', text: text('lamp-access') });
  });

  it('with guidance: a tool returns a guide, for clients that only do tools', async () => {
    const tool = (await client.listTools()).tools.find((t) => t.name === 'lamps_guide')!;
    expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect((tool.inputSchema.properties as { topic: { enum: string[] } }).topic.enum.sort()).toEqual(SKILLS.map((s) => s.name).sort());
    for (const s of SKILLS) expect(tool.description, s.name).toContain(s.name);
    const r = await client.callTool({ name: 'lamps_guide', arguments: { topic: 'scenes' } }) as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(r.isError).toBeFalsy();
    expect(r.content).toEqual([{ type: 'text', text: text('scenes') }]);
  });

  it('with guidance: the instructions say the guides exist', () => {
    expect(client.getInstructions()).toMatch(/plaiiin-lamps:\/\/skills\//);
    expect(client.getInstructions()).toMatch(/lamps_guide/);
    expect(client.getInstructions()).toContain(plain.getInstructions()!);   // the rest is unchanged
  });

  it('without guidance: no prompts, no resources, no guide tool, instructions unchanged', async () => {
    expect(plain.getServerCapabilities()?.prompts).toBeUndefined();
    expect(plain.getServerCapabilities()?.resources).toBeUndefined();
    expect(plain.getInstructions()).not.toMatch(/skills/);
    expect(plain.getServerCapabilities()?.tools).toBeDefined();
    expect((await plain.listTools()).tools.some((t) => t.name === 'lamps_guide')).toBe(false);
  });
});

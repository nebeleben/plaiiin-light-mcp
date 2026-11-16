/**
 * Builds the MCP server against fake lamps and a temp state dir, connected to an SDK Client over
 * InMemoryTransport. No network beyond 127.0.0.1 fakes: discovery and the clipboard are injected.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../src/server';
import { Confirmations } from '../src/tools/confirm';
import type { ToolContext } from '../src/tools/context';
import { FleetStore } from '../src/store/fleet';
import { makeSecrets, type Secrets } from '../src/store/secrets';
import { Registry } from '../src/lamp/registry';
import type { Discovered } from '../src/lamp/discovery';
import { startFakeLamp, type FakeLamp, type FakeLampOpts } from './fakeLamp';

export interface Harness {
  client: Client; ctx: ToolContext; dir: string; fleet: FleetStore; secrets: Secrets; registry: Registry;
  /** Call a tool and parse its JSON text content. */
  call(name: string, args?: Record<string, unknown>): Promise<any>;
  /** The raw text of a tool result (for "no secret anywhere" checks). */
  raw(name: string, args?: Record<string, unknown>): Promise<string>;
  fake(o: Partial<FakeLampOpts> & { deviceId: string; name: string }): Promise<FakeLamp>;
  /** Start a fake lamp and add it to the fleet the way a user would (share link, or unpaired admin). */
  addFake(o: Partial<FakeLampOpts> & { deviceId: string; name: string }): Promise<FakeLamp>;
  close(): Promise<void>;
}

export interface HarnessOpts {
  timeoutMs?: number;
  discover?: () => Promise<Discovered[]>;
  readClipboard?: () => Promise<string>;
  /** GitHub API / asset downloads (firmware tools); tests never reach the network. */
  fetchImpl?: typeof fetch;
  /** Interval between `GET /api` polls after an OTA upload. */
  otaPollMs?: number;
}

export async function makeHarness(opts: HarnessOpts = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'lamp-mcp-h-'));
  const fleet = new FleetStore(dir);
  const secrets = makeSecrets(dir, 'linux');
  const registry = new Registry(fleet, secrets, async () => undefined, { timeoutMs: opts.timeoutMs });
  const ctx: ToolContext = {
    registry, confirm: new Confirmations(), stateDir: dir,
    discover: opts.discover ?? (async () => []),
    readClipboard: opts.readClipboard ?? (async () => ''),
    fetchImpl: opts.fetchImpl ?? (async () => { throw new Error('test: no network'); }),
    otaPollMs: opts.otaPollMs ?? 10,
  };
  const server = buildServer(ctx);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(ct);
  const fakes: FakeLamp[] = [];

  const raw = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const content = r.content as Array<{ type: string; text?: string }>;
    return content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  };
  const fake = async (o: Partial<FakeLampOpts> & { deviceId: string; name: string }) => {
    const l = await startFakeLamp(o);
    fakes.push(l);
    return l;
  };
  return {
    client, ctx, dir, fleet, secrets, registry, raw, fake,
    call: async (name, args) => JSON.parse(await raw(name, args)),
    addFake: async (o) => {
      const l = await fake(o);
      if ((o.role ?? 'admin') === 'admin') await registry.addUnpaired({ deviceId: o.deviceId, name: o.name, host: '127.0.0.1', port: l.port, paired: false });
      else await registry.addShared({ host: '127.0.0.1', port: l.port, key: l.token });
      return l;
    },
    close: async () => {
      await client.close();
      await server.close();
      registry.close();
      for (const f of fakes) await f.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

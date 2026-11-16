import { homedir } from 'node:os';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Registry } from './lamp/registry';
import { resolveProfile } from './profile';
import { FleetStore } from './store/fleet';
import { makeSecrets } from './store/secrets';
import { buildServer } from './server';
import { Confirmations } from './tools/confirm';
import { errorText, type ToolContext } from './tools/context';
import { consoleToStderr } from './util/stdout';

// stdout is the JSON-RPC channel: library console output must not corrupt it.
consoleToStderr();

// Each assistant's plugin runs under its own profile: own lamp list, own keys (see profile.ts).
let profile: ReturnType<typeof resolveProfile>;
try {
  profile = resolveProfile(process.env, homedir());
} catch (e) {
  process.stderr.write(`plaiiin-lamps: ${errorText(e)}\n`);
  process.exit(1);
}
const { stateDir } = profile;
const registry = new Registry(new FleetStore(stateDir), makeSecrets(stateDir, process.platform, undefined, profile.keychainService));
const ctx: ToolContext = { registry, confirm: new Confirmations(), stateDir };

// PLAIIIN_LAMPS_GUIDANCE=1 is set by the npm package's entry; the plugins leave it unset.
const server = buildServer(ctx, { guidance: process.env.PLAIIIN_LAMPS_GUIDANCE === '1' });
await server.connect(new StdioServerTransport());

// Re-read every lamp's access in the background; startup must not wait for slow or offline lamps.
registry.refreshAccess().catch((e) => process.stderr.write(`plaiiin-lamps: access refresh failed: ${errorText(e)}\n`));

const shutdown = () => { registry.close(); void server.close().finally(() => process.exit(0)); };
process.stdin.on('end', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

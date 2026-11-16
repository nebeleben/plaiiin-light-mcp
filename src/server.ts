import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { GUIDANCE_INSTRUCTIONS, registerGuidance } from './guidance';
import type { ToolContext } from './tools/context';
import { registerControlTools } from './tools/control';
import { registerEffectsTools } from './tools/effects';
import { registerFleetTools } from './tools/fleet';
import { registerImagesTools } from './tools/images';
import { registerOtaTools } from './tools/ota';
import { registerScenesTools } from './tools/scenes';
import { registerStreamTools } from './tools/stream';
import { registerSwarmTools } from './tools/swarm';

export const SERVER_NAME = 'plaiiin-lamps';
export const SERVER_VERSION = '0.3.1';

const INSTRUCTIONS =
  'Controls PlaiiinLight lamps on the local network. Start with lamps_list (or lamps_discover to find lamps). ' +
  'Tools that target lamps take `lamps` as names, deviceIds or "all" and report one result per lamp. ' +
  'Access is per lamp: an AI access key only allows the permissions the owner granted — a refusal names the ' +
  'missing permission; never try to work around it. Destructive tools first return {needsConfirmation, summary, ' +
  'confirm}: show the summary to the user and call again with confirm only after they agree. ' +
  'Reach lamps only through these tools: if one you need seems to be missing, say so instead of calling a ' +
  "lamp's web interface or HTTP API yourself.";

/**
 * The MCP server with every tool group registered.
 *
 * `guidance`: also offer the skills as prompts and resources (see guidance.ts). Off for the
 * plugins, which ship the skills as skills; on for the npm package, whose clients have none.
 */
export function buildServer(ctx: ToolContext, opts: { guidance?: boolean } = {}): McpServer {
  const instructions = opts.guidance ? INSTRUCTIONS + GUIDANCE_INSTRUCTIONS : INSTRUCTIONS;
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions });
  if (opts.guidance) registerGuidance(server);
  registerFleetTools(server, ctx);
  registerSwarmTools(server, ctx);
  registerControlTools(server, ctx);
  registerEffectsTools(server, ctx);
  registerImagesTools(server, ctx);
  registerScenesTools(server, ctx);
  registerStreamTools(server, ctx);
  registerOtaTools(server, ctx);
  return server;
}

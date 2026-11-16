/**
 * The plugins' skills, offered through MCP itself.
 *
 * A plugin host (Claude Code, the ChatGPT app) loads the skills as skills. A generic MCP client has
 * no such thing, so when the server is started by the npm package it also offers each skill three
 * ways, because MCP programs differ in what they support: through the read-only tool `lamps_guide`
 * (every program has tools), as a prompt (where the user picks one) and as a Markdown resource
 * (where the model reads them). The text is bundled, so it always matches the tools of this server.
 *
 * Adding a skill folder means adding one import below — a test fails until it is here.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import composeEffect from '../skills/compose-effect/SKILL.md?raw';
import drawImage from '../skills/draw-image/SKILL.md?raw';
import fleetOta from '../skills/fleet-ota/SKILL.md?raw';
import lampAccess from '../skills/lamp-access/SKILL.md?raw';
import scenes from '../skills/scenes/SKILL.md?raw';

export interface Skill { name: string; description: string; text: string }

/** Front matter (`description:`) and body of a SKILL.md. */
function parse(name: string, source: string): Skill {
  const m = /^---\n([\s\S]*?)\n---\n+([\s\S]*)$/.exec(source.replace(/\r\n/g, '\n'));
  if (!m) throw new Error(`guidance: skills/${name}/SKILL.md has no front matter`);
  const description = /^description:\s*(.*)$/m.exec(m[1]!)?.[1]?.replace(/^["']|["']$/g, '').trim();
  if (!description) throw new Error(`guidance: skills/${name}/SKILL.md has no description`);
  return { name, description, text: m[2]!.trimEnd() + '\n' };
}

export const SKILLS: ReadonlyArray<Skill> = [
  parse('compose-effect', composeEffect),
  parse('draw-image', drawImage),
  parse('fleet-ota', fleetOta),
  parse('lamp-access', lampAccess),
  parse('scenes', scenes),
];

export const skillUri = (name: string): string => `plaiiin-lamps://skills/${name}`;

/** One sentence for the server instructions, so the model knows the guides exist. */
export const GUIDANCE_INSTRUCTIONS =
  ' Guides for the common jobs (composing an effect, drawing, scenes, firmware updates, access) are available ' +
  `through the lamps_guide tool (also as prompts, and as resources under ${skillUri('')}) — read the matching ` +
  'one before starting such a job.';

export function registerGuidance(server: McpServer): void {
  const names = SKILLS.map((s) => s.name) as [string, ...string[]];
  server.registerTool('lamps_guide', {
    title: 'Read a guide',
    description:
      'Read the guide for a job before doing it — how the tools fit together, what to check, what to avoid. Topics: ' +
      SKILLS.map((s) => `${s.name} (${s.description})`).join('; ') + '. Read-only.',
    inputSchema: { topic: z.enum(names).describe('Which guide') },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ topic }) => ({ content: [{ type: 'text', text: SKILLS.find((s) => s.name === topic)!.text }] }));

  for (const s of SKILLS) {
    server.registerPrompt(s.name, { title: s.name, description: s.description },
      () => ({ messages: [{ role: 'user', content: { type: 'text', text: s.text } }] }));
    server.registerResource(s.name, skillUri(s.name), { title: s.name, description: s.description, mimeType: 'text/markdown' },
      (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: s.text }] }));
  }
}

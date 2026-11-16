import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Need } from '../lamp/access';
import { guard, lampsArg, normLamps, result, type ToolContext } from './context';
import { fanout } from './fanout';

const CONTROL: Need = { perm: 'control', minRole: 'user' };
const READ: Need = { minRole: 'user' };
const PER_LAMP = 'Returns one result per lamp: `{lamp, ok: true, …}` or `{lamp, ok: false, skipped?, reason}`.';
const NEEDS_CONTROL = 'Needs the `control` permission on AI keys (any user/creator/admin key works).';

// An array of exactly three, not z.tuple: tuple schemas (`items` as a list) make the ChatGPT/Codex
// host drop the whole tool without a word.
const rgb = z.array(z.number().int().min(0).max(255)).length(3);
const color = z.union([z.string().regex(/^#?[0-9a-fA-F]{6}$/, 'a "#rrggbb" hex color'), rgb])
  .describe('"#rrggbb" or [r, g, b] with 0–255 each');

function toRgb(c: string | [number, number, number]): [number, number, number] {
  if (Array.isArray(c)) return c;
  const h = c.replace(/^#/, '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

const ann = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

export function registerControlTools(server: McpServer, ctx: ToolContext): void {
  const run = (lamps: string | string[], need: Need, fn: Parameters<typeof fanout>[3]) =>
    guard(async () => result({ results: await fanout(ctx, normLamps(lamps), need, fn) }));

  server.registerTool('lamp_state', {
    title: 'Lamp state',
    description: `Read the live state of one or more lamps (on, color, mode, brightness, current effect, fps, active scene). Read-only; any key may read. ${PER_LAMP}`,
    inputSchema: { lamps: lampsArg },
    annotations: { ...ann, readOnlyHint: true },
  }, async ({ lamps }) => run(lamps, READ, (c) => c.get<object>('/api/state')));

  server.registerTool('lamp_power', {
    title: 'Power on/off',
    description: `Switch one or more lamps on or off. ${NEEDS_CONTROL} ${PER_LAMP}`,
    inputSchema: { lamps: lampsArg, on: z.boolean().describe('true = on, false = off') },
    annotations: ann,
  }, async ({ lamps, on }) => run(lamps, CONTROL, async (c) => { await c.send('POST', '/api/power', { on }); return { on }; }));

  server.registerTool('lamp_color', {
    title: 'Solid color',
    description: `Fill one or more lamps with one solid color (switches them to api mode, stopping any effect). ${NEEDS_CONTROL} ${PER_LAMP}`,
    inputSchema: { lamps: lampsArg, color },
    annotations: ann,
  }, async ({ lamps, color: c0 }) => {
    const rgbv = toRgb(c0 as string | [number, number, number]);   // the schema guarantees exactly three
    return run(lamps, CONTROL, async (c) => { await c.send('POST', '/api/color', { color: rgbv }); return { color: rgbv }; });
  });

  server.registerTool('lamp_brightness', {
    title: 'Brightness',
    description:
      `Set the brightness (0–255) of one or more lamps. An AI key may carry a brightness cap; the lamp clamps to it and ` +
      `the result reports the brightness actually applied. ${NEEDS_CONTROL} ${PER_LAMP}`,
    inputSchema: { lamps: lampsArg, value: z.number().int().min(0).max(255).describe('Brightness 0–255') },
    annotations: ann,
  }, async ({ lamps, value }) => run(lamps, CONTROL, async (c) => {
    const r = await c.send<{ brightness?: number }>('POST', '/api/brightness', { brightness: value });
    return { brightness: typeof r.brightness === 'number' ? r.brightness : value };
  }));

  server.registerTool('lamp_mode', {
    title: 'Render mode',
    description:
      'Set the render mode of one or more lamps: `api` (solid color), `js` (effect scripts), `frame` (the stored still ' +
      `image) or \`stream\` (live frames over the WebSocket). ${NEEDS_CONTROL} ${PER_LAMP}`,
    inputSchema: { lamps: lampsArg, mode: z.enum(['api', 'js', 'frame', 'stream']) },
    annotations: ann,
  }, async ({ lamps, mode }) => run(lamps, CONTROL, async (c) => { await c.send('POST', '/api/mode', { mode }); return { mode }; }));

  server.registerTool('lamp_play', {
    title: 'Play effects',
    description:
      'Effect playback on one or more lamps: `play` with `effect` runs that effect (name from effects_list); `play` ' +
      'without `effect` resumes the lamp\'s current selection; `next` / `prev` step through the effects alphabetically; ' +
      `\`stop\` stops playback. ${NEEDS_CONTROL} ${PER_LAMP}`,
    inputSchema: {
      lamps: lampsArg,
      action: z.enum(['play', 'next', 'prev', 'stop']),
      effect: z.string().min(1).optional().describe('Effect name for action "play"'),
    },
    annotations: { ...ann, idempotentHint: false },
  }, async ({ lamps, action, effect }) => run(lamps, CONTROL, async (c) => {
    if (action === 'stop') { await c.send('POST', '/api/stop'); return { action }; }
    if (action === 'next' || action === 'prev') {
      await c.send('POST', `/api/play/${action}`);
      const cur = await c.get<{ playing?: string | null; current?: string | null }>('/api/play/current').catch(() => undefined);
      return { action, playing: cur?.playing ?? cur?.current ?? null };
    }
    let file = effect;
    if (!file) {
      const cur = await c.get<{ current?: string | null }>('/api/play/current');
      if (!cur.current) throw new Error('no effect selected on this lamp; pass `effect`');
      file = cur.current;
    }
    await c.send('POST', '/api/play', { file });
    return { action, playing: file };
  }));
}

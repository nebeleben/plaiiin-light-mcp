import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { allows, SWARM_READ } from '../lamp/access';
import { LampHttpError, LampUnreachable } from '../lamp/errors';
import type { FleetLamp } from '../store/fleet';
import { describeLamp, guard, result, type ToolContext } from './context';

/** Can we read this lamp's swarm membership? (admin, or an AI key with the `swarm` permission) */
export function swarmKnown(l: FleetLamp): boolean {
  return allows(l, SWARM_READ);
}

/**
 * Group lamps by swarm id (key = swarmId, or `solo:<deviceId>` for lamps outside a swarm or whose
 * membership we can't read — those count as their own group).
 */
export function swarmGroups(_ctx: ToolContext, lamps: FleetLamp[]): Map<string, FleetLamp[]> {
  const groups = new Map<string, FleetLamp[]>();
  for (const l of lamps) {
    const key = swarmKnown(l) && l.swarmId ? l.swarmId : `solo:${l.deviceId}`;
    const g = groups.get(key);
    if (g) g.push(l); else groups.set(key, [l]);
  }
  return groups;
}

export interface SwarmRefresh {
  lamps: FleetLamp[];
  /** No swarm read access: not allowed by the stored access, or the lamp answered 403. */
  unknown: Set<string>;
  /** Names of lamps that didn't answer (shown with their last known swarm). */
  unreachable: string[];
}

/**
 * Re-read `GET /api/swarm` on every lamp we may read it from (all lamps, or just `targets`). 403 →
 * membership unknown; 404 (firmware without swarm) → solo, saved; unreachable / timeout → keeps its
 * stored id; any other error → unknown.
 */
export async function refreshSwarms(ctx: ToolContext, targets?: FleetLamp[]): Promise<SwarmRefresh> {
  const unknown = new Set<string>();
  const unreachable: string[] = [];
  const save = (l: FleetLamp, swarmId: string | null): FleetLamp => {
    const cur = ctx.registry.lookup(l.deviceId);
    if (cur.swarmId !== swarmId) ctx.registry.update({ ...cur, swarmId });
    return { ...cur, swarmId };
  };
  const lamps = await Promise.all((targets ?? ctx.registry.list()).map(async (l) => {
    if (!swarmKnown(l)) { unknown.add(l.deviceId); return l; }
    try {
      const sw = await ctx.registry.call(l.deviceId, (c) => c.get<{ member?: boolean; id?: string }>('/api/swarm'));
      return save(l, sw.member && sw.id ? sw.id : null);
    } catch (e) {
      if (e instanceof LampHttpError && (e.status === 401 || e.status === 403)) { unknown.add(l.deviceId); return l; }
      if (e instanceof LampHttpError && e.status === 404) return save(l, null);
      if (e instanceof LampUnreachable) { unreachable.push(l.name); return l; }
      unknown.add(l.deviceId);
      return l;
    }
  }));
  return { lamps, unknown, unreachable };
}

const brief = (l: FleetLamp) => ({ name: l.name, deviceId: l.deviceId });

export function registerSwarmTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool('swarms_list', {
    title: 'List swarms',
    description:
      'Show which lamps are linked in a swarm (lamps in one swarm mirror scene changes and effect tunes to each other). ' +
      'Reads GET /api/swarm on every lamp live. Returns `swarms` (swarm id + members), `solo` (lamps in no swarm) and ' +
      '`unknown` (lamps whose key can\'t read membership: the lamp only shows it to its owner or to an AI key with the ' +
      '`swarm` permission — ask the owner to add `swarm` to the AI key in the app\'s Share tab). Unreachable lamps are ' +
      'listed under `unreachable` and grouped by their last known swarm. Read-only; this server never joins or leaves swarms.',
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => guard(async () => {
    const { lamps, unknown, unreachable } = await refreshSwarms(ctx);
    const known = lamps.filter((l) => !unknown.has(l.deviceId));
    const swarms = [...swarmGroups(ctx, known)].filter(([k]) => !k.startsWith('solo:'))
      .map(([swarmId, members]) => ({ swarmId, members: members.map(brief) }));
    return result({
      swarms,
      solo: known.filter((l) => !l.swarmId).map(brief),
      unknown: lamps.filter((l) => unknown.has(l.deviceId)).map(brief),
      ...(unreachable.length ? { unreachable, note: 'unreachable lamps are shown with their last known swarm' } : {}),
    });
  }));
}

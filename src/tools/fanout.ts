import type { Need } from '../lamp/access';
import type { LampClient } from '../lamp/client';
import type { FleetLamp } from '../store/fleet';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { explain, result, type ToolContext } from './context';
import { refreshSwarms, swarmGroups } from './swarm';

export type LampOk<T> = { lamp: string; deviceId: string; ok: true; viaSwarm?: string } & T;
export type LampFail = { lamp: string; deviceId: string; ok: false; skipped?: true; reason: string };
export type LampResult<T> = LampOk<T> | LampFail;

/**
 * Run `fn` on every target in parallel (each lamp's own client queues its requests and times out on its
 * own, so one wedged lamp can't hold the others). Lamps whose access doesn't allow `need` are skipped
 * without a request. Unknown / ambiguous names throw before anything is sent.
 */
export async function fanout<T extends object>(
  ctx: ToolContext, lamps: string[] | 'all', need: Need,
  fn: (c: LampClient, l: FleetLamp) => Promise<T>,
): Promise<LampResult<T>[]> {
  const targets = ctx.registry.resolveTargets(lamps);
  return Promise.all(targets.map(async (l): Promise<LampResult<T>> => {
    const base = { lamp: l.name, deviceId: l.deviceId };
    const refused = await ctx.registry.refusalFresh(l, need);
    if (refused) return { ...base, ok: false, skipped: true, reason: refused };
    try {
      const r = await ctx.registry.call(l.deviceId, fn);
      return { ...r, ...base, ok: true } as LampOk<T>;
    } catch (e) {
      return { ...base, ok: false, reason: explain(e, l, need) };
    }
  }));
}

/**
 * Fan-out for actions a swarm mirrors to its members (effect tunes, scene activation): membership
 * is re-read live for the targets first, then per swarm among the targets one member gets the
 * request and the others report `{ok: true, viaSwarm: <member>}`. If that member fails, the next
 * one is tried (a member that failed before one succeeded is reached via the swarm too); members
 * whose access refuses `need` are skipped. Lamps outside a swarm (or whose membership we can't
 * read) get their own request. Target order is kept.
 */
export async function swarmFanout<T extends object>(
  ctx: ToolContext, lamps: string[] | 'all', need: Need,
  fn: (c: LampClient, l: FleetLamp) => Promise<T>,
): Promise<LampResult<T>[]> {
  const targets = ctx.registry.resolveTargets(lamps);
  const { lamps: fresh, unknown } = await refreshSwarms(ctx, targets);
  const grouped = fresh.map((l) => (unknown.has(l.deviceId) ? { ...l, swarmId: null } : l));
  const out = new Map<string, LampResult<T>>();
  await Promise.all([...swarmGroups(ctx, grouped).values()].map(async (members) => {
    const allowed: FleetLamp[] = [];
    for (const l of members) {
      const refused = await ctx.registry.refusalFresh(l, need);
      if (refused) out.set(l.deviceId, { lamp: l.name, deviceId: l.deviceId, ok: false, skipped: true, reason: refused });
      else allowed.push(l);
    }
    for (let i = 0; i < allowed.length; i++) {
      const l = allowed[i]!;
      try {
        const r = await ctx.registry.call(l.deviceId, fn);
        out.set(l.deviceId, { ...r, lamp: l.name, deviceId: l.deviceId, ok: true } as LampOk<T>);
        for (const o of allowed) if (o !== l) out.set(o.deviceId, { lamp: o.name, deviceId: o.deviceId, ok: true, viaSwarm: l.name } as LampOk<T>);
        return;
      } catch (e) {
        out.set(l.deviceId, { lamp: l.name, deviceId: l.deviceId, ok: false, reason: explain(e, l, need) });
      }
    }
  }));
  return targets.map((l) => out.get(l.deviceId)!);
}

/** One lamp → `{lamp, deviceId, ok, …}` as the whole result (isError when not ok). */
export async function single<T extends object>(ctx: ToolContext, lamp: string, need: Need, fn: (c: LampClient, l: FleetLamp) => Promise<T>): Promise<CallToolResult> {
  const [r] = await fanout(ctx, [lamp], need, fn);
  return result(r, !r!.ok);
}

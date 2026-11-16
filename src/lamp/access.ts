import type { FleetLamp } from '../store/fleet';

/** AI-key permissions (firmware repo nebeleben/plaiiin-light, docs/sharing-api.md). */
export type Perm = 'control' | 'effects' | 'images' | 'scenes' | 'stream' | 'ota' | 'rename' | 'swarm';
export type MinRole = 'user' | 'creator' | 'admin';

/** What a tool needs. Read-only tools pass no `perm`. */
export interface Need { perm?: Perm; minRole: MinRole }

/**
 * Reading swarm membership (`GET /api/swarm`, `/api/swarm/stats`): admin-only on the firmware
 * (light_api.c swarm_get_handler / swarm_stats_handler), or an AI key with `swarm`.
 */
export const SWARM_READ: Need = { perm: 'swarm', minRole: 'admin' };

const LADDER: Record<MinRole, number> = { user: 1, creator: 2, admin: 3 };

/**
 * admin → always. AI key → with `perm`: the key's `perms` include it; without: only reads a `user`
 * may make (the firmware's read rule). user/creator → role ladder (a `perm` is ignored).
 */
export function allows(l: FleetLamp, need: Need): boolean {
  if (l.role === 'admin') return true;
  if (l.role === 'ai') return need.perm ? (l.perms ?? []).includes(need.perm) : need.minRole === 'user';
  return LADDER[l.role] >= LADDER[need.minRole];
}

/** The text a refused tool call returns for this lamp, or undefined when allowed. */
export function refusal(l: FleetLamp, need: Need): string | undefined {
  if (allows(l, need)) return undefined;
  if (l.role === 'ai') return `not permitted by this lamp's AI key (needs ${need.perm ?? `${need.minRole} access`})`;
  return `not permitted: needs ${need.minRole} access, this lamp's key is ${l.role}`;
}

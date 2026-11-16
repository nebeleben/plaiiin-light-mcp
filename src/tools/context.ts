import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Registry } from '../lamp/registry';
import type { Discovered } from '../lamp/discovery';
import type { Need } from '../lamp/access';
import { LampHttpError } from '../lamp/errors';
import type { FleetLamp } from '../store/fleet';
import { scrub } from '../util/scrub';
import type { Confirmations } from './confirm';

export interface ToolContext {
  registry: Registry;
  confirm: Confirmations;
  stateDir: string;
  /** mDNS browse; injected so tests never touch the network. */
  discover?: () => Promise<Discovered[]>;
  /** Clipboard text (`pbpaste` on macOS); injected in tests. */
  readClipboard?: () => Promise<string>;
  /** GitHub release list + asset downloads (firmware tools); injected in tests. Default: global fetch. */
  fetchImpl?: typeof fetch;
  /** Interval between `GET /api` polls while a lamp reboots after an OTA upload (default 2000 ms). */
  otaPollMs?: number;
  /** How long a lamp may take to come back on the new firmware (default 90 000 ms). */
  otaRebootTimeoutMs?: number;
  /** How long the firmware release list is cached (default 10 min). */
  releaseCacheMs?: number;
}

/** `lamps` argument of fan-out tools: names or deviceIds, a single one, or "all". */
export const lampsArg = z.union([z.literal('all'), z.string().min(1), z.array(z.string().min(1)).min(1)])
  .describe('Lamp names or deviceIds (one string, a list), or "all" for every lamp in the fleet');

export const lampArg = z.string().min(1).describe('Lamp name or deviceId');

export function normLamps(v: string | string[]): string[] | 'all' {
  if (v === 'all') return 'all';
  return Array.isArray(v) ? v : [v];
}

/** A JSON text result. Every string passes through `scrub` as a last line of defence against leaked secrets. */
export function result(value: unknown, isError = false): CallToolResult {
  return { content: [{ type: 'text', text: scrub(JSON.stringify(value, null, 2)) }], ...(isError ? { isError: true } : {}) };
}

export function failure(reason: string): CallToolResult {
  return result({ ok: false, reason: scrub(reason) }, true);
}

export function errorText(e: unknown): string {
  return scrub(e instanceof Error ? e.message : String(e));
}

/** Map an error from a lamp call to the reason a tool reports (never a bare 403). */
export function explain(e: unknown, lamp: FleetLamp, need?: Need): string {
  if (e instanceof LampHttpError && e.status === 403) {
    if (lamp.role === 'ai') {
      if (/lamp is off/i.test(e.message)) return 'the lamp is off and this AI key only works while it is on (switching it on is allowed)';
      if (/insufficient role/i.test(e.message)) return 'an AI key can never be granted this (owner-only)';
      return `not permitted by this lamp's AI key (needs ${need?.perm ?? `${need?.minRole ?? 'user'} access`})`;
    }
    return `not permitted by this lamp's ${lamp.role} key${e.message ? ` (${e.message})` : ''}`;
  }
  if (e instanceof LampHttpError && e.status === 401) return `the lamp no longer accepts the stored key (revoked?) — add it again with a new share link`;
  return errorText(e);
}

/** Run a tool body; any thrown error becomes `{ok:false, reason}`. */
export async function guard(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (e) {
    return failure(errorText(e));
  }
}

/** Fleet entry as tools show it (no secrets exist in it). */
export function describeLamp(l: FleetLamp) {
  return {
    name: l.name, deviceId: l.deviceId, host: l.host, port: l.port, role: l.role,
    ...(l.role === 'ai' ? { perms: l.perms ?? [], maxBrightness: l.maxBrightness ?? null, onlyWhenOn: l.onlyWhenOn ?? false } : {}),
    form: l.form, target: l.target, grid: l.grid, firmware: l.firmware, swarmId: l.swarmId ?? null, shared: l.shared, lastSeen: l.lastSeen,
  };
}

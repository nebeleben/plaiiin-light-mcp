import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Need } from '../lamp/access';
import { discover as mdnsDiscover, type Discovered } from '../lamp/discovery';
import { decodeQrImage, parseShareLink } from '../lamp/shareLink';
import { CONFIRM_REFUSED } from './confirm';
import { describeLamp, errorText, explain, failure, guard, lampArg, result, type ToolContext } from './context';

const RENAME: Need = { perm: 'rename', minRole: 'admin' };
const KEY_HINT =
  'paired by its owner — ask them for an AI access key (app → Share tab → AI access) and add it with lamp_add_shared';

/** `pbpaste` (macOS only), spawned without a shell. */
export function pbpaste(): Promise<string> {
  if (process.platform !== 'darwin') return Promise.reject(new Error('reading the clipboard works on macOS only; pass url or qrImagePath'));
  return new Promise((resolve, reject) => {
    const p = spawn('/usr/bin/pbpaste', [], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    p.stdout.on('data', (c: Buffer) => { out += c.toString('utf8'); });
    p.on('error', () => reject(new Error('could not run pbpaste')));
    p.on('close', () => resolve(out));
  });
}

/** Valid node names: 1..32 bytes, no quote, backslash or control characters (as the firmware checks). */
const lampName = z.string().min(1)
  .refine((n) => Buffer.byteLength(n) <= 32, 'at most 32 bytes')
  .refine((n) => !/["\\\x00-\x1f]/.test(n), 'no quotes, backslashes or control characters');

export function registerFleetTools(server: McpServer, ctx: ToolContext): void {
  const discover = ctx.discover ?? (() => mdnsDiscover());
  const readClipboard = ctx.readClipboard ?? pbpaste;

  server.registerTool('lamps_discover', {
    title: 'Discover lamps on the LAN',
    description:
      'Browse the local network (mDNS, ~3 s) for PlaiiinLight lamps. Unpaired lamps (no owner yet) are added to the fleet ' +
      'with full (admin) access. Lamps already in the fleet are reported as `known` (their address is refreshed). Lamps ' +
      'that are paired but not in the fleet are listed under `needsKey`: the user must create an AI access key for this ' +
      'computer in the PlaiiinLight app (Share tab → AI access) and add it with lamp_add_shared.',
    inputSchema: {},
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => guard(async () => {
    const found: Discovered[] = await discover();
    const added: unknown[] = [], known: unknown[] = [], needsKey: unknown[] = [], failed: unknown[] = [];
    const fleet = ctx.registry.list();
    await Promise.all(found.map(async (d) => {
      const have = fleet.find((l) => l.deviceId === d.deviceId);
      if (have) {
        // Moved only when the new host itself reports this deviceId (mDNS answers are unauthenticated).
        const moved = await ctx.registry.relocate(have.deviceId, d.host, d.port);
        const at = moved ? d : have;
        known.push({ name: have.name, deviceId: d.deviceId, host: at.host, port: at.port, role: have.role,
          ...(moved ? {} : { addressNotUpdated: `${d.host}:${d.port} did not identify as this lamp` }) });
      } else if (d.paired) {
        needsKey.push({ name: d.name, deviceId: d.deviceId, host: d.host, hint: KEY_HINT });
      } else {
        try {
          const l = await ctx.registry.addUnpaired(d);
          added.push({ name: l.name, deviceId: l.deviceId, host: l.host, role: l.role, form: l.form, grid: l.grid, firmware: l.firmware });
        } catch (e) {
          failed.push({ name: d.name, deviceId: d.deviceId, host: d.host, reason: errorText(e) });
        }
      }
    }));
    return result({ found: found.length, added, known, needsKey, ...(failed.length ? { failed } : {}) });
  }));

  server.registerTool('lamps_list', {
    title: 'List lamps',
    description:
      'List every lamp in this computer\'s fleet with its access (role, and for AI keys the granted permissions and ' +
      'brightness cap), form, grid, firmware and swarm, plus live state (on, color, mode, brightness, current effect, ' +
      'scene) read from each lamp in parallel. Offline lamps show `online: false` with the reason. Read-only.',
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => guard(async () => {
    const lamps = await Promise.all(ctx.registry.list().map(async (l) => {
      try {
        const state = await ctx.registry.call(l.deviceId, (c) => c.get<Record<string, unknown>>('/api/state'));
        return { ...describeLamp(ctx.registry.lookup(l.deviceId)), online: true, state };
      } catch (e) {
        return { ...describeLamp(l), online: false, reason: explain(e, l) };
      }
    }));
    return result({ lamps });
  }));

  server.registerTool('lamp_info', {
    title: 'Lamp details',
    description:
      'Details of one lamp: the fleet entry (access role / AI permissions, form, grid, firmware, swarm) plus the lamp\'s ' +
      'live GET /api info and GET /api/state. Read-only.',
    inputSchema: { lamp: lampArg },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ lamp }) => guard(async () => {
    const l = ctx.registry.lookup(lamp);
    try {
      const { info, state } = await ctx.registry.call(l.deviceId, async (c) => ({
        info: await c.get<Record<string, unknown>>('/api'),
        state: await c.get<Record<string, unknown>>('/api/state'),
      }));
      return result({ ok: true, ...describeLamp(ctx.registry.lookup(l.deviceId)), online: true, info, state });
    } catch (e) {
      return result({ ok: false, ...describeLamp(l), online: false, reason: explain(e, l) });
    }
  }));

  server.registerTool('lamp_add_shared', {
    title: 'Add a shared lamp',
    description:
      'Add a lamp someone shared with this computer (an AI access key or a creator/user share key, made in the ' +
      'PlaiiinLight app\'s Share tab). Give exactly one source: `fromClipboard: true` (preferred — the share link is ' +
      'read from the macOS clipboard so the key never passes through the chat), `qrImagePath` (path to a PNG/JPEG of the ' +
      'share QR code), or `url` (a pasted http://<lamp>/config?t=… link). With no source the clipboard is used. The key ' +
      'is stored in the macOS Keychain and never returned; the result shows the lamp name, role and permissions.',
    inputSchema: {
      url: z.string().optional().describe('Share link http://<lamp>/config?t=<key> (may be inside other text)'),
      qrImagePath: z.string().optional().describe('Absolute path to a PNG or JPEG of the share QR code'),
      fromClipboard: z.boolean().optional().describe('Read the share link from the clipboard (macOS)'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ url, qrImagePath, fromClipboard }) => guard(async () => {
    const sources = [url !== undefined, qrImagePath !== undefined, fromClipboard === true].filter(Boolean).length;
    if (sources > 1) return failure('give only one of url, qrImagePath or fromClipboard');
    let text: string | undefined;
    let from: string;
    if (url !== undefined) { text = url; from = 'the url'; }
    else if (qrImagePath !== undefined) {
      try { text = decodeQrImage(qrImagePath); } catch (e) { return failure(`${qrImagePath}: ${errorText(e)}`); }
      from = 'the QR image';
      if (text === undefined) return failure(`no QR code could be read from ${qrImagePath}`);
    } else { text = await readClipboard(); from = 'the clipboard'; }
    const link = parseShareLink(text ?? '');
    if (!link) return failure(`no share link (http://<lamp>/config?t=…) found in ${from}`);
    try {
      const l = await ctx.registry.addShared(link);
      return result({
        ok: true, name: l.name, deviceId: l.deviceId, host: l.host, role: l.role,
        ...(l.role === 'ai' ? { perms: l.perms ?? [], maxBrightness: l.maxBrightness ?? null, onlyWhenOn: l.onlyWhenOn ?? false } : {}),
        form: l.form, grid: l.grid, firmware: l.firmware, swarmId: l.swarmId ?? null,
      });
    } catch (e) {
      const msg = errorText(e).split(link.key).join('***');
      return failure(/\b401\b|unauthorized/i.test(msg) ? 'the lamp did not accept this share key (revoked or mistyped?)' : msg);
    }
  }));

  server.registerTool('lamp_forget', {
    title: 'Forget a lamp',
    description:
      'Remove a lamp from this computer\'s fleet and delete its stored key. Only local: the lamp and its key on the lamp ' +
      'are not changed (revoke the key in the app\'s Share tab if wanted). Destructive and two-step: the first call ' +
      'returns `{needsConfirmation, summary, confirm}` and does nothing — show the summary to the user, and only after ' +
      'they agree call again with the same arguments plus `confirm: "<token>"` (valid 120 s).',
    inputSchema: { lamp: lampArg, confirm: z.string().optional().describe('Token from the first call, after the user agreed') },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async (args) => guard(async () => {
    const l = ctx.registry.lookup(args.lamp);
    if (args.confirm === undefined) {
      return result(ctx.confirm.request('lamp_forget', args, `Forget "${l.name}" (${l.deviceId}, ${l.host}) on this computer: ` +
        `remove it from the fleet and delete its stored ${l.role === 'admin' ? 'entry' : `${l.role} key`}. The lamp itself is not ` +
        'changed; using it again needs a new share link' + (l.role === 'admin' ? ' (or lamps_discover while it is unpaired).' : '.')));
    }
    if (!ctx.confirm.consume('lamp_forget', args, args.confirm)) return failure(CONFIRM_REFUSED);
    const { secretError } = await ctx.registry.forget(l.deviceId);
    return result({
      ok: true, forgot: l.name, deviceId: l.deviceId,
      ...(secretError ? { warning: `removed from the fleet, but its stored key could not be deleted: ${secretError}` } : {}),
    });
  }));

  server.registerTool('lamp_rename', {
    title: 'Rename a lamp',
    description:
      'Change a lamp\'s name (POST /api/name; 1–32 bytes, no quotes/backslashes). Needs an unpaired lamp or an AI key with ' +
      'the `rename` permission. The lamp restarts to apply it and is offline for a few seconds. Destructive and two-step: ' +
      'the first call returns `{needsConfirmation, summary, confirm}` and does nothing — show the summary to the user, and ' +
      'only after they agree call again with the same arguments plus `confirm: "<token>"` (valid 120 s).',
    inputSchema: {
      lamp: lampArg,
      name: lampName.describe('New name, 1–32 bytes'),
      confirm: z.string().optional().describe('Token from the first call, after the user agreed'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async (args) => guard(async () => {
    const l = ctx.registry.lookup(args.lamp);
    const refused = await ctx.registry.refusalFresh(l, RENAME);
    if (refused) return failure(refused);
    if (args.confirm === undefined) {
      return result(ctx.confirm.request('lamp_rename', args,
        `Rename "${l.name}" (${l.deviceId}) to "${args.name}". The lamp restarts to apply the new name and is offline for a few seconds; ` +
        'apps and Home Assistant follow it by deviceId.'));
    }
    if (!ctx.confirm.consume('lamp_rename', args, args.confirm)) return failure(CONFIRM_REFUSED);
    try {
      await ctx.registry.call(l.deviceId, (c) => c.send('POST', '/api/name', { name: args.name }));
    } catch (e) {
      return failure(explain(e, l, RENAME));
    }
    ctx.registry.update({ ...ctx.registry.lookup(l.deviceId), name: args.name });
    return result({ ok: true, name: args.name, previous: l.name, deviceId: l.deviceId, note: 'the lamp is restarting (a few seconds)' });
  }));
}

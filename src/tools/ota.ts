import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Need } from '../lamp/access';
import type { LampClient } from '../lamp/client';
import { LampUnreachable } from '../lamp/errors';
import { assetName, downloadAsset, isNewer, latestRelease, MAX_SUMS_BYTES, parseSha256Sums, type FirmwareRelease } from '../ota/releases';
import type { FleetLamp } from '../store/fleet';
import { confirmContent } from './confirm';
import { errorText, explain, failure, guard, lampsArg, normLamps, result, type ToolContext } from './context';
import { fanout, type LampResult } from './fanout';

const READ: Need = { minRole: 'user' };
/** `POST /api/ota`: admin, or an AI key with `ota` (the one admin action that can be granted). */
const OTA: Need = { perm: 'ota', minRole: 'admin' };
const UPLOAD_TIMEOUT_MS = 120_000;
const SUMS = 'SHA256SUMS';
/** As the Mac app (FirmwareUpdate.swift): a release without checksums is never flashed. */
const NO_SUMS = 'the release has no SHA256SUMS — not flashing unverified firmware';

interface OtaInfo { version?: string; form?: string; target?: string }

type Plan =
  | { kind: 'update'; current: string; asset: string; url: string }
  | { kind: 'current'; current: string }
  | { kind: 'none'; current: string | null; reason: string };

/** What the release means for one lamp (`GET /api/ota/info`). */
async function planFor(c: LampClient, rel: FirmwareRelease): Promise<Plan> {
  const info = await c.get<OtaInfo>('/api/ota/info');
  const current = typeof info.version === 'string' ? info.version : null;
  if (!info.form || !info.target || current === null) {
    return { kind: 'none', current, reason: 'the lamp\'s firmware doesn\'t report its form and chip (too old for updates from here) — update it with the PlaiiinLight app' };
  }
  if (!isNewer(rel.version, current)) return { kind: 'current', current };
  const asset = assetName(info.form, info.target);
  const url = rel.assets[asset];
  if (!url) return { kind: 'none', current, reason: `no build for ${info.form}/${info.target}` };
  return { kind: 'update', current, asset, url };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function registerOtaTools(server: McpServer, ctx: ToolContext): void {
  const fetchImpl = () => ctx.fetchImpl ?? fetch;
  let cache: { at: number; rel: FirmwareRelease } | undefined;
  const release = async (): Promise<FirmwareRelease> => {
    const ttl = ctx.releaseCacheMs ?? 10 * 60_000;
    if (cache && Date.now() - cache.at < ttl) return cache.rel;
    const rel = await latestRelease(fetchImpl());
    cache = { at: Date.now(), rel };
    return rel;
  };
  const releaseOrFail = async () => {
    try { return { rel: await release() }; } catch (e) { return { err: failure(`can't read the firmware releases from GitHub: ${errorText(e)}`) }; }
  };

  server.registerTool('firmware_check', {
    title: 'Check for firmware updates',
    description:
      'Compare lamps\' firmware with the newest PlaiiinLight firmware release on GitHub. Per lamp: `current`, `latest`, ' +
      '`update` (true when a newer build for the lamp\'s form and chip exists, with its `asset`), `upToDate`, or a `reason` ' +
      'such as "no build for <form>/<target>". Read-only (reads GitHub and the lamps).',
    inputSchema: { lamps: lampsArg },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ lamps }) => guard(async () => {
    const targets = ctx.registry.resolveTargets(normLamps(lamps));
    const r = await releaseOrFail();
    if (!r.rel) return r.err;
    const rel = r.rel;
    return result({ latest: rel.version, results: await fanout(ctx, targets.map((l) => l.deviceId), READ, async (c) => {
      const p = await planFor(c, rel);
      if (p.kind === 'update') return { current: p.current, latest: rel.version, update: true, asset: p.asset };
      if (p.kind === 'current') return { current: p.current, latest: rel.version, update: false, upToDate: true };
      return { current: p.current, latest: rel.version, update: false, reason: p.reason };
    }) });
  }));

  server.registerTool('firmware_update', {
    title: 'Update lamp firmware',
    description:
      'Install the newest PlaiiinLight firmware release from GitHub on lamps that run an older version (see firmware_check). ' +
      'Always two-step: the first call returns {needsConfirmation, summary, confirm} listing each lamp `current → new`; ' +
      'show the summary to the user and repeat with `confirm` only after they agree. Lamps are updated one at a time: ' +
      'the image is downloaded once (≤ 8 MB) and checked against the release\'s SHA256SUMS (a release without one is refused), uploaded, and the ' +
      'lamp reboots (unavailable for up to a minute); the tool waits until it reports the new version (≤ 90 s). The first ' +
      'failure stops the run: later lamps are reported `skipped`. Needs the `ota` permission on AI keys, admin otherwise. ' +
      'Returns one result per lamp: `{lamp, ok: true, from, to, verified}` or `{lamp, ok: false, skipped?, reason}`.',
    inputSchema: { lamps: lampsArg, confirm: z.string().optional().describe('Token from a previous needsConfirmation answer') },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async (args) => guard(async () => {
    const targets = ctx.registry.resolveTargets(normLamps(args.lamps));
    const out = new Map<string, LampResult<Record<string, unknown>>>();
    const allowed: FleetLamp[] = [];
    for (const l of targets) {
      const refused = await ctx.registry.refusalFresh(l, OTA);
      if (refused) out.set(l.deviceId, { lamp: l.name, deviceId: l.deviceId, ok: false, skipped: true, reason: refused });
      else allowed.push(l);
    }
    const ordered = () => ({ results: targets.map((l) => out.get(l.deviceId)!) });
    if (!allowed.length) return result(ordered(), true);

    const r = await releaseOrFail();
    if (!r.rel) return r.err;
    const rel = r.rel;
    const plans = await fanout(ctx, allowed.map((l) => l.deviceId), READ, async (c) => ({ plan: await planFor(c, rel) }));
    const updates: Array<{ lamp: FleetLamp; current: string; asset: string; url: string }> = [];
    const hasSums = !!rel.assets[SUMS];
    for (const p of plans) {
      if (!p.ok) { out.set(p.deviceId, p); continue; }
      const base = { lamp: p.lamp, deviceId: p.deviceId };
      const plan = p.plan;
      if (plan.kind === 'current') out.set(p.deviceId, { ...base, ok: true, upToDate: true, current: plan.current });
      else if (plan.kind === 'none') out.set(p.deviceId, { ...base, ok: false, reason: plan.reason });
      else if (!hasSums) out.set(p.deviceId, { ...base, ok: false, reason: NO_SUMS });
      else updates.push({ lamp: allowed.find((l) => l.deviceId === p.deviceId)!, current: plan.current, asset: plan.asset, url: plan.url });
    }
    if (!updates.length) return result({ version: rel.version, ...ordered() });

    const others = targets.filter((l) => !updates.some((u) => u.lamp.deviceId === l.deviceId)).map((l) => {
      const o = out.get(l.deviceId)!;
      return `- ${l.name}: not updated (${o.ok ? 'already up to date' : o.reason})`;
    });
    const summary = [
      `Update the firmware to ${rel.version}, one lamp at a time (each lamp reboots and is unavailable for up to a minute):`,
      ...updates.map((u) => `- ${u.lamp.name}: ${u.current} → ${rel.version} (${u.asset})`),
      ...others,
      'Each image is checked against the release\'s SHA256SUMS before upload.',
    ].join('\n');
    const content = { version: rel.version, sums: rel.assets[SUMS], plan: updates.map((u) => ({ deviceId: u.lamp.deviceId, from: u.current, asset: u.asset, url: u.url })) };
    const ask = confirmContent(ctx, 'firmware_update', args, args.confirm, content, updates.map((u) => u.lamp.deviceId), summary);
    if (ask) return result(ask);

    const dir = mkdtempSync(join(tmpdir(), 'plaiiin-ota-'));
    const images = new Map<string, Buffer>();
    let sums: Record<string, string> | undefined;
    /**
     * Each asset is downloaded once per call (≤ 8 MB), its hash checked, and kept in memory: the exact
     * verified bytes are what gets uploaded. A copy goes to the temp dir (removed at the end).
     */
    const image = async (name: string, url: string): Promise<Buffer> => {
      let data = images.get(name);
      if (!data) {
        data = await downloadAsset(fetchImpl(), name, url);
        sums ??= parseSha256Sums((await downloadAsset(fetchImpl(), SUMS, rel.assets[SUMS]!, MAX_SUMS_BYTES)).toString('utf8'));
        const want = sums[name];
        if (!want) throw new Error(`${SUMS} has no entry for ${name} — not flashing it`);
        if (createHash('sha256').update(data).digest('hex') !== want) throw new Error(`${name} doesn't match its SHA-256 in ${SUMS} — not flashing it`);
        writeFileSync(join(dir, name), data);
        images.set(name, data);
      }
      return data;
    };
    const pollMs = ctx.otaPollMs ?? 2000;
    const rebootMs = ctx.otaRebootTimeoutMs ?? 90_000;

    try {
      let failed: string | undefined;
      for (const u of updates) {
        const l = u.lamp;
        const base = { lamp: l.name, deviceId: l.deviceId };
        if (failed) { out.set(l.deviceId, { ...base, ok: false, skipped: true, reason: `not attempted: the update of ${failed} failed` }); continue; }
        try {
          const bin = await image(u.asset, u.url);
          let uploadError: unknown;
          try {
            await ctx.registry.call(l.deviceId, (c) => c.sendBinary('POST', '/api/ota', bin, UPLOAD_TIMEOUT_MS));
          } catch (e) {
            // The lamp may reboot before it answers: then only the version it comes back with tells.
            if (!(e instanceof LampUnreachable)) throw e;
            uploadError = e;
          }
          const deadline = Date.now() + rebootMs;
          let seen: string | undefined;
          for (;;) {
            await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
            try {
              seen = (await ctx.registry.call(l.deviceId, (c) => c.get<{ firmwareVersion?: string }>('/api'))).firmwareVersion ?? seen;
            } catch { /* rebooting */ }
            if (seen === rel.version || Date.now() >= deadline) break;
          }
          if (seen !== rel.version) {
            if (uploadError) throw uploadError;
            const secs = Math.round(rebootMs / 1000);
            throw new Error(seen ? `the lamp still reports ${seen} ${secs} s after the upload` : `the lamp didn't come back within ${secs} s after the upload`);
          }
          const cur = ctx.registry.lookup(l.deviceId);
          ctx.registry.update({ ...cur, firmware: rel.version, lastSeen: new Date().toISOString() });
          out.set(l.deviceId, {
            ...base, ok: true, from: u.current, to: rel.version, asset: u.asset,
            verified: 'sha256',
          });
        } catch (e) {
          failed = l.name;
          out.set(l.deviceId, { ...base, ok: false, reason: explain(e, l, OTA) });
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    return result({ version: rel.version, ...ordered() });
  }));
}

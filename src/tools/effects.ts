import { join } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Need } from '../lamp/access';
import type { LampClient } from '../lamp/client';
import {
  builtIn, listing, present, putSource, putTunes, readTunes, values, type ParamSchema,
} from '../lamp/scripts';
import { LampHttpError } from '../lamp/errors';
import { framesToPng, previewLayout } from '../preview/png';
import { apiGrid, checkGrid } from '../lamp/grid';
import { MAX_FRAMES, previewScript, type Rgb } from '../preview/shade';
import type { FleetLamp } from '../store/fleet';
import { Library } from '../store/library';
import { scrub } from '../util/scrub';
import { confirmContent, confirmTargets, digest } from './confirm';
import {
  errorText, explain, failure, guard, lampArg, lampsArg, normLamps, result, type ToolContext,
} from './context';
import { fanout, single, swarmFanout, type LampResult } from './fanout';

const READ: Need = { minRole: 'user' };
/** Upload / delete / validate / compile scripts. */
const EFFECTS: Need = { perm: 'effects', minRole: 'creator' };
/** Tune values: any user key, AI keys need `effects`. */
const TUNES: Need = { perm: 'effects', minRole: 'user' };

const PER_LAMP = 'Returns one result per lamp: `{lamp, ok: true, …}` or `{lamp, ok: false, skipped?, reason}`.';
const NEEDS_EFFECTS = 'Needs the `effects` permission on AI keys, creator or admin otherwise.';
const CONFIRM_NOTE =
  'If the effect already exists (with a different script) on any target, the first call returns ' +
  '{needsConfirmation, summary, confirm}: show the summary to the user and repeat the call with `confirm` only after they agree.';

/** Effect names on the lamp (firmware js_storage name_is_valid: letters, digits, _ - ., no leading dot, ≤ 48). */
const effectName = z.string().regex(/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,47}$/, 'letters, digits, _ - . (no leading dot), at most 48')
  .describe('Effect name as listed by effects_list');
const newEffectName = z.string().regex(/^[A-Za-z0-9_-]{1,32}$/, '1–32 letters, digits, _ or -').describe('Effect name (1–32 letters, digits, _ or -)');
const source = z.string().min(1).max(32768).describe('JavaScript source defining `function shade(x, y, idx, frame, base, params)`');
const tuneValues = z.record(z.string(), z.number()).describe('Tune values by param name, e.g. {"speed": 3}');
const confirmArg = z.string().optional().describe('Token from a previous needsConfirmation answer');

const CONTRACT =
  'Write one `function shade(x, y, idx, frame, base, params)`; it runs once per LED per frame and must call ' +
  '`emit(r, g, b)` (0–255) or `emitBright(v)` (0–1 × base color) once. In scope: x, y (grid position, 0,0 = top-left), ' +
  'idx = y*w + x, frame (counter), w, h, time (ms since play), playStart, base {r,g,b} (the lamp color), params. ' +
  'Built-ins: sinLUT, cosLUT, floor, ceil, round, abs, sqrt, pow, min, max, clamp01, hash, random. Annotations: ' +
  '`// @param NAME MIN..MAX = DEF description` (→ params.NAME, a tune the user can change), `// @param NAME switch = 0|1`, ' +
  '`// @state NAME : DEF` (variable kept across frames), `// @state.pixel NAME : DEF` (per-LED, as NAME.pixel), ' +
  '`// @description …` and `// @tags a,b` (shown in effect lists). No other globals, no closures over host objects.';

const enc = (n: string) => encodeURIComponent(n);
const BUILTIN_NO_SOURCE = (name: string) => `${name} is a built-in effect (compiled into the firmware, no source)`;

type WriteState = 'new' | 'replace' | 'same';
interface Write { lamp: FleetLamp; state: WriteState }

/**
 * Before writing `name` (with `src`) to the targets: who has it already, and with what. A built-in of
 * that name, a refused key or an unreachable lamp ends that lamp's part here.
 */
async function planWrites(ctx: ToolContext, targets: FleetLamp[], name: string, src: string): Promise<{ writes: Write[]; done: Map<string, LampResult<object>> }> {
  const writes: Write[] = [];
  const done = new Map<string, LampResult<object>>();
  await Promise.all(targets.map(async (l) => {
    const base = { lamp: l.name, deviceId: l.deviceId };
    const refused = await ctx.registry.refusalFresh(l, EFFECTS);
    if (refused) { done.set(l.deviceId, { ...base, ok: false, skipped: true, reason: refused }); return; }
    try {
      const state = await ctx.registry.call(l.deviceId, async (c): Promise<WriteState | 'builtin'> => {
        const ls = await listing(c);
        if (builtIn(ls, name)) return 'builtin';
        if (!present(ls, name)) return 'new';
        const cur = await c.getText(`/api/js/${enc(name)}`).catch(() => undefined);
        return cur === src ? 'same' : 'replace';
      });
      if (state === 'builtin') done.set(l.deviceId, { ...base, ok: false, skipped: true, reason: `${name} is a built-in effect on this lamp; pick another name` });
      else writes.push({ lamp: l, state });
    } catch (e) {
      done.set(l.deviceId, { ...base, ok: false, reason: explain(e, l, EFFECTS) });
    }
  }));
  return { writes, done };
}

/**
 * Write a script (+ tune values) to lamps; asks for confirmation first when that would replace a
 * different script of the same name on any target. Shared by effect_upload, library_push_effect, effect_copy.
 */
async function writeEffect(
  ctx: ToolContext, tool: string, args: object, confirm: string | undefined,
  targets: FleetLamp[], name: string, src: string, tunes: Record<string, number> | undefined, extra: object = {},
): Promise<CallToolResult> {
  const { writes, done } = await planWrites(ctx, targets, name, src);
  const replacing = writes.filter((w) => w.state === 'replace');
  if (replacing.length) {
    const others = writes.filter((w) => w.state !== 'replace').map((w) => w.lamp.name);
    const ask = confirmContent(ctx, tool, args, confirm, { src, tunes: tunes ?? null }, replacing.map((w) => w.lamp.deviceId),
      `Replace the existing effect "${name}" on ${replacing.map((w) => w.lamp.name).join(', ')} with the new script` +
      `${others.length ? `; also write it to ${others.join(', ')}` : ''}.`);
    if (ask) return result(ask);
  }
  const ids = new Set(writes.map((w) => w.lamp.deviceId));
  const stateOf = new Map(writes.map((w) => [w.lamp.deviceId, w.state]));
  const written = ids.size ? await fanout(ctx, [...ids], EFFECTS, async (c, l) => {
    if (stateOf.get(l.deviceId) !== 'same') await putSource(c, name, src);
    const applied = tunes && Object.keys(tunes).length ? values(await putTunes(c, name, tunes)) : undefined;
    return { name, ...extra, replaced: stateOf.get(l.deviceId) === 'replace', ...(applied ? { tunes: applied } : {}) };
  }) : [];
  for (const r of written) done.set(r.deviceId, r);
  return result({ results: targets.map((l) => done.get(l.deviceId)!) });
}

export function registerEffectsTools(server: McpServer, ctx: ToolContext): void {
  const library = new Library(join(ctx.stateDir, 'library'));
  const ro = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

  server.registerTool('effects_list', {
    title: 'List effects',
    description:
      'List the effects on a lamp with description, tags and `builtIn` (built-ins are compiled into the firmware: they ' +
      'can be played and tuned but have no source to read, copy or delete). `playing` is the running effect. Read-only.',
    inputSchema: { lamp: lampArg },
    annotations: ro,
  }, async ({ lamp }) => guard(() => single(ctx, lamp, READ, async (c) => {
    const ls = await listing(c);
    const effects = ls.effects?.map((e) => ({ name: e.name, description: e.description ?? '', tags: e.tags ?? [], builtIn: e.source === 'hardcoded' }))
      ?? (ls.scripts ?? []).map((name) => ({ name, description: '', tags: [], builtIn: null }));
    return { playing: ls.playing ?? null, effects };
  })));

  server.registerTool('effect_read', {
    title: 'Read effect source',
    description: 'Read the JavaScript source of an uploaded effect on a lamp (built-ins have none). Read-only.',
    inputSchema: { lamp: lampArg, name: effectName },
    annotations: ro,
  }, async ({ lamp, name }) => guard(() => single(ctx, lamp, READ, async (c) => {
    const ls = await listing(c);
    if (builtIn(ls, name)) throw new Error(BUILTIN_NO_SOURCE(name));
    if (!present(ls, name)) throw new Error(`no effect ${name} on this lamp`);
    return { name, source: await c.getText(`/api/js/${enc(name)}`) };
  })));

  server.registerTool('lamp_form_prompt', {
    title: 'Lamp form for effect writing',
    description:
      'Before writing an effect for a lamp: its physical form and pixel layout in words (`prompt`, from the lamp; the ' +
      'owner may have customised it), its grid size, and the `shade()` script contract (`contract`). Write the script ' +
      'for exactly this grid, check it with effect_preview, then effect_validate, then effect_upload. Read-only.',
    inputSchema: { lamp: lampArg },
    annotations: ro,
  }, async ({ lamp }) => guard(() => single(ctx, lamp, READ, async (c, l) => {
    const fp = await c.get<{ form?: string; effective?: string; default?: string; hasOverride?: boolean; mode?: string; byMode?: object }>('/api/form-prompt');
    const grid = l.grid ? checkGrid(l.grid) : apiGrid(await c.get<{ logicalW?: number; logicalH?: number }>('/api'));
    return {
      form: fp.form ?? l.form ?? null, prompt: fp.effective ?? fp.default ?? '', customised: fp.hasOverride ?? false,
      ...(fp.mode ? { mode: fp.mode } : {}), ...(fp.byMode ? { byMode: fp.byMode } : {}),
      grid: grid ?? null, contract: CONTRACT,
    };
  })));

  const check = (tool: 'effect_validate' | 'effect_compile', path: string, what: string) =>
    server.registerTool(tool, {
      title: tool === 'effect_validate' ? 'Validate effect on the lamp' : 'Compile effect on the lamp',
      description:
        `${what} Nothing is stored. Returns \`{valid: true}\` or \`{valid: false, error}\` with the lamp's own error text. ${NEEDS_EFFECTS}`,
      inputSchema: { lamp: lampArg, source },
      annotations: ro,
    }, async ({ lamp, source: src }) => guard(() => single(ctx, lamp, EFFECTS, async (c) => {
      try {
        const r = await c.sendRaw('POST', path, src, 'text/javascript');
        return tool === 'effect_compile' ? { valid: true, bytecodeBytes: r.data.length } : { valid: true };
      } catch (e) {
        if (e instanceof LampHttpError && e.status === 400) return { valid: false, error: e.message };
        throw e;
      }
    })));
  check('effect_validate', '/api/js/validate', 'Check a script with the lamp\'s own validator (the same check an upload runs).');
  check('effect_compile', '/api/js/compile', 'Compile a script to the lamp\'s bytecode (reports the bytecode size).');

  server.registerTool('effect_preview', {
    title: 'Preview effect locally',
    description:
      'Render a `shade()` script on this computer with the lamp runtime (no lamp needed, nothing is sent) and return the ' +
      'first frames as one PNG, already enlarged for viewing (each frame about 192 px): frames in reading order — left ' +
      'to right, then top to bottom, `columns` per row as the text part says — frame i at time i·1000/fps ms, pixel ' +
      '(0,0) top-left of each frame. Show this picture to the user as it is. Give ' +
      '`lamp` to use its grid and base color, or `w` and `h`. `params` overrides @param defaults. The text part lists the ' +
      'grid, the params found and a warning when every frame is black. Read-only.',
    inputSchema: {
      source,
      lamp: lampArg.optional(),
      w: z.number().int().min(1).max(256).optional().describe('Grid width (without `lamp`)'),
      h: z.number().int().min(1).max(256).optional().describe('Grid height (without `lamp`)'),
      frames: z.number().int().min(1).max(MAX_FRAMES).default(8).describe(`Frames to render (1–${MAX_FRAMES}, default 8)`),
      fps: z.number().min(1).max(120).default(10).describe('Frames per second the frames are spaced at (default 10)'),
      params: tuneValues.optional(),
    },
    annotations: ro,
  }, async ({ source: src, lamp, w, h, frames, fps, params }) => guard(async () => {
    let grid = w && h ? { w, h } : undefined;
    let base: Rgb | undefined;
    if (lamp) {
      const [r] = await fanout(ctx, [lamp], READ, async (c, l) => {
        const g = l.grid ? checkGrid(l.grid) : apiGrid(await c.get<{ logicalW?: number; logicalH?: number }>('/api'));
        const bc = await c.get<{ color?: number[] }>('/api/base_color').catch(() => undefined);
        return { grid: g, base: bc?.color?.length === 3 ? { r: bc.color[0]!, g: bc.color[1]!, b: bc.color[2]! } : undefined };
      });
      if (!r!.ok) return failure(r!.reason);
      grid = grid ?? r!.grid;
      base = r!.base;
      if (!grid) return failure(`${r!.lamp} reports no grid size; pass w and h`);
    }
    if (!grid) return failure('pass `lamp` or both `w` and `h`');
    let info, rendered;
    try {
      ({ info, frames: rendered } = await previewScript(src, { w: grid.w, h: grid.h, frames, fps, params, base }));
    } catch (e) {
      return failure(errorText(e));
    }
    const png = framesToPng(rendered, grid.w, grid.h);
    const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
    const layout = previewLayout(rendered.length, grid.w, grid.h);
    const shown = layout.shown;
    const known = new Set(info.params.map((p) => p.name));
    const unknown = Object.keys(params ?? {}).filter((k) => !known.has(k));
    const dark = rendered.every((f) => f.every((v) => v === 0));
    const summary = {
      ok: true, grid, frames, fps, ...(base ? { base } : {}),
      image: {
        width, height, columns: layout.columns, rows: layout.rows, scale: layout.scale, gap: layout.gap,
        layout: 'frames in reading order: left to right, then top to bottom; each lamp pixel is a scale×scale block; frames are gap px apart',
        ...(shown < frames ? { framesShown: shown, note: 'the picture is capped at 4096 px; later frames are left out' } : {}),
      },
      params: info.params.map((p) => ({ name: p.name, min: p.min, max: p.max, default: p.def, value: params?.[p.name] ?? p.def, description: p.desc, type: p.type })),
      state: { frame: info.frameState.map((s) => s.name), pixel: info.pixelState.map((s) => s.name) },
      ...(info.mode ? { mode: info.mode } : {}),
      ...(unknown.length ? { warning: `unknown params ignored: ${unknown.join(', ')}` } : {}),
      ...(dark ? { note: 'every frame is black — check that shade() calls emit()/emitBright() with non-zero values' } : {}),
    };
    return {
      content: [
        { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
        { type: 'text', text: scrub(JSON.stringify(summary, null, 2)) },
      ],
    };
  }));

  server.registerTool('effect_upload', {
    title: 'Upload effect',
    description:
      `Store a \`shade()\` script on one or more lamps under \`name\` (the lamp validates it; its error text comes back ` +
      `as the reason). It does not start playing — use lamp_play. A name that is a built-in on a lamp is skipped there. ` +
      `${CONFIRM_NOTE} ${NEEDS_EFFECTS} ${PER_LAMP}`,
    inputSchema: { lamps: lampsArg, name: newEffectName, source, confirm: confirmArg },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async (args) => guard(() => writeEffect(ctx, 'effect_upload', args, args.confirm,
    ctx.registry.resolveTargets(normLamps(args.lamps)), args.name, args.source, undefined)));

  server.registerTool('effect_delete', {
    title: 'Delete effect',
    description:
      'Delete an uploaded effect from one or more lamps (built-ins can\'t be deleted). Always two-step: the first call ' +
      'returns {needsConfirmation, summary, confirm}; show the summary to the user and repeat with `confirm` only after ' +
      `they agree. ${NEEDS_EFFECTS} ${PER_LAMP}`,
    inputSchema: { lamps: lampsArg, name: effectName, confirm: confirmArg },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async (args) => guard(async () => {
    const targets = ctx.registry.resolveTargets(normLamps(args.lamps));
    const ids = targets.map((l) => l.deviceId);
    const ask = await confirmTargets(ctx, 'effect_delete', args, args.confirm, args.name, ids,
      () => `Delete the effect "${args.name}" from ${targets.map((l) => l.name).join(', ')}. This can't be undone.`);
    if (ask) return result(ask);
    return result({ results: await fanout(ctx, ids, EFFECTS, async (c) => {
      await c.send('DELETE', `/api/js/${enc(args.name)}`);
      return { deleted: args.name };
    }) });
  }));

  server.registerTool('effect_tunes_get', {
    title: 'Read effect tunes',
    description: 'Read an effect\'s tunable params on a lamp: range, default, live `value` and description; `values` maps name → live value. Read-only.',
    inputSchema: { lamp: lampArg, name: effectName },
    annotations: ro,
  }, async ({ lamp, name }) => guard(() => single(ctx, lamp, READ, async (c) => {
    const s = await c.get<ParamSchema>(`/api/js/${enc(name)}/params`);
    return {
      name, params: s.items ?? [], values: values(s),
      ...(s.mode ? { mode: s.mode } : {}), ...(s.modeSwitch !== undefined ? { modeSwitch: s.modeSwitch } : {}),
    };
  })));

  server.registerTool('effect_tunes_set', {
    title: 'Set effect tunes',
    description:
      'Set tune values of an effect (partial: only the params given). They apply live and persist; the lamp clamps them ' +
      'to range and the result reports the applied values. Lamps in one swarm mirror tunes, so per swarm one member gets ' +
      `the request and the others report \`viaSwarm\`. Needs \`effects\` on AI keys (any user key works). ${PER_LAMP}`,
    inputSchema: { lamps: lampsArg, name: effectName, values: tuneValues },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ lamps, name, values: v }) => guard(async () => result({
    results: await swarmFanout(ctx, normLamps(lamps), TUNES, async (c) => {
      const applied = values(await putTunes(c, name, v));
      return { name, values: Object.fromEntries(Object.keys(v).filter((k) => k in applied).map((k) => [k, applied[k]!])) };
    }),
  })));

  server.registerTool('effect_copy', {
    title: 'Copy effect between lamps',
    description:
      'Copy an effect from one lamp to others, with the source lamp\'s tune values (as the apps\' swarm sync does). A ' +
      'built-in effect has no source to copy: only its tunes travel, and a target without that built-in fails with ' +
      `"script <name> isn't on this lamp". ${CONFIRM_NOTE} ${NEEDS_EFFECTS} ${PER_LAMP}`,
    inputSchema: { from: lampArg.describe('Source lamp name or deviceId'), name: effectName, to: lampsArg, confirm: confirmArg },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async (args) => guard(async () => {
    const from = ctx.registry.lookup(args.from);
    const refused = await ctx.registry.refusalFresh(from, READ);
    if (refused) return failure(`${from.name}: ${refused}`);
    let src: string | undefined;
    let tunes: Record<string, number> | undefined;
    try {
      ({ src, tunes } = await ctx.registry.call(from.deviceId, async (c) => {
        const ls = await listing(c);
        if (!present(ls, args.name)) throw new Error(`script ${args.name} isn't on ${from.name}`);
        return { src: builtIn(ls, args.name) ? undefined : await c.getText(`/api/js/${enc(args.name)}`), tunes: await readTunes(c, args.name) };
      }));
    } catch (e) {
      return failure(explain(e, from, READ));
    }
    const targets = ctx.registry.resolveTargets(normLamps(args.to)).filter((l) => l.deviceId !== from.deviceId);
    if (src !== undefined) {
      return writeEffect(ctx, 'effect_copy', args, args.confirm, targets, args.name, src, tunes, { source: true });
    }
    const name = args.name;
    return result({ results: await fanout(ctx, targets.map((l) => l.deviceId), TUNES, async (c) => {
      const ls = await listing(c);
      if (!present(ls, name)) throw new Error(`script ${name} isn't on this lamp`);
      const entry = ls.effects?.find((e) => e.name === name);
      // Tune only the same built-in: never an unrelated uploaded script that happens to share the name.
      if (entry && entry.source !== 'hardcoded') throw new Error(`${name} on this lamp is an uploaded script, not the built-in; tunes not copied`);
      if (!entry) return { name, source: false, warning: 'this lamp doesn\'t say whether its effect is the built-in; tunes not copied' };
      const applied = tunes ? values(await putTunes(c, name, tunes)) : undefined;
      return { name, source: false, ...(applied ? { tunes: applied } : {}) };
    }) });
  }));

  server.registerTool('library_list', {
    title: 'List the local library',
    description: 'List what is saved in the local library of this plugin, on this computer: effects, images or scenes. Read-only.',
    inputSchema: { kind: z.enum(['effects', 'images', 'scenes']) },
    annotations: ro,
  }, async ({ kind }) => guard(async () => result({ kind, names: library.list(kind) })));

  server.registerTool('library_save_effect', {
    title: 'Save effect to the library',
    description:
      'Save an uploaded effect from a lamp (source + its current tune values) into the library on this computer, under ' +
      'the same name. Replacing a different library entry of that name first returns {needsConfirmation, summary, ' +
      'confirm}: show the summary and repeat with `confirm` only after the user agrees. Built-ins have no source and ' +
      'can\'t be saved. Reads the lamp only.',
    inputSchema: { lamp: lampArg, name: newEffectName, confirm: confirmArg },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async (args) => guard(async () => {
    const { name } = args;
    const [r] = await fanout(ctx, [args.lamp], READ, async (c) => {
      const ls = await listing(c);
      if (builtIn(ls, name)) throw new Error(`${BUILTIN_NO_SOURCE(name)}; only uploaded effects can be saved`);
      if (!present(ls, name)) throw new Error(`no effect ${name} on this lamp`);
      return { src: await c.getText(`/api/js/${enc(name)}`), tunes: await readTunes(c, name) };
    });
    if (!r!.ok) return result(r, true);
    const { src, tunes } = r!;
    const existing = library.list('effects').includes(name) ? library.readEffect(name) : undefined;
    const same = existing && existing.source === src && digest(existing.params ?? null) === digest(tunes ?? null);
    if (existing && !same) {
      const ask = confirmContent(ctx, 'library_save_effect', args, args.confirm, { src, tunes: tunes ?? null }, [name],
        `Replace the library effect "${name}" with the version from ${r!.lamp}.`);
      if (ask) return result(ask);
    }
    library.writeEffect(name, src, tunes);
    return result({ lamp: r!.lamp, deviceId: r!.deviceId, ok: true, name, replaced: !!existing && !same, ...(tunes ? { tunes } : {}) });
  }));

  server.registerTool('library_push_effect', {
    title: 'Push a library effect to lamps',
    description:
      `Upload an effect from the library on this computer (with its saved tune values) to one or more lamps. ${CONFIRM_NOTE} ` +
      `${NEEDS_EFFECTS} ${PER_LAMP}`,
    inputSchema: { name: newEffectName, lamps: lampsArg, confirm: confirmArg },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async (args) => guard(async () => {
    const fx = library.readEffect(args.name);
    return writeEffect(ctx, 'library_push_effect', args, args.confirm,
      ctx.registry.resolveTargets(normLamps(args.lamps)), args.name, fx.source, fx.params);
  }));
}


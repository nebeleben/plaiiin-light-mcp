import { join } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { allows, type Need } from '../lamp/access';
import type { LampClient } from '../lamp/client';
import { LampHttpError } from '../lamp/errors';
import { builtIn, listing, present, readTunes } from '../lamp/scripts';
import type { FleetLamp } from '../store/fleet';
import { Library } from '../store/library';
import { copyScene, findSavedImage, type ImagePayload, type SceneDoc, type ScriptPayload } from '../sync/copy';
import { confirmContent, digest, stable } from './confirm';
import { explain, failure, guard, lampArg, lampsArg, normLamps, result, type ToolContext } from './context';
import { fanout, single, swarmFanout } from './fanout';
import { fetchImage, gridOf } from './images';

const READ: Need = { minRole: 'user' };
/** Write / delete / capture scenes. */
const SCENES: Need = { perm: 'scenes', minRole: 'creator' };
/** Activate a scene (`POST /api/scenes/<n>/activate`). */
const CONTROL: Need = { perm: 'control', minRole: 'user' };

const PER_LAMP = 'Returns one result per lamp: `{lamp, ok: true, …}` or `{lamp, ok: false, skipped?, reason}`.';
const NEEDS_SCENES = 'Needs the `scenes` permission on AI keys, creator or admin otherwise.';
const CONFIRM_NOTE =
  'If a target already has a scene of that name (or, for a copy, a different script of the script\'s name), the first call ' +
  'returns {needsConfirmation, summary, confirm}: show the summary to the user and repeat the call with `confirm` only after they agree.';

const sceneName = z.string().regex(/^[A-Za-z0-9_-]{1,32}$/, '1–32 letters, digits, _ or -').describe('Scene name (1–32 letters, digits, _ or -)');
const confirmArg = z.string().optional().describe('Token from a previous needsConfirmation answer');
const sceneDoc = z.object({
  on: z.boolean().optional().describe('Power. Leave out: a scene does not change power (only set it for a deliberate "good night"/"wake up" scene)'),
  mode: z.enum(['stream', 'api', 'js', 'frame']).optional(),
  script: z.string().min(1).optional().describe('Effect name (implies js mode); must exist on the lamp'),
  params: z.record(z.string(), z.number()).optional().describe('Tune values for the script'),
  image: z.string().min(1).optional().describe('Saved image id (implies frame mode); ids are per lamp'),
  color: z.tuple([z.number().int().min(0).max(255), z.number().int().min(0).max(255), z.number().int().min(0).max(255)]).optional(),
  brightness: z.number().int().min(0).max(255).optional(),
}).strict().describe('Scene document; every field optional, an absent field means "leave as is"');

const enc = (n: string) => encodeURIComponent(n);
const ro = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

/** A scene with everything needed to recreate it on another lamp. */
interface Bundle { scene: SceneDoc; script?: ScriptPayload; image?: ImagePayload }

/** The scene on a lamp, or null when it has none of that name. */
async function getScene(c: LampClient, name: string): Promise<SceneDoc | null> {
  try {
    return await c.get<SceneDoc>(`/api/scenes/${enc(name)}`);
  } catch (e) {
    if (e instanceof LampHttpError && e.status === 404) return null;
    throw e;
  }
}

/** The scene plus its script source/tunes (uploaded scripts only) and image pixels, from one lamp. */
async function readBundle(c: LampClient, name: string): Promise<Bundle> {
  const scene = await getScene(c, name);
  if (!scene) throw new Error(`no scene ${name} on this lamp`);
  const bundle: Bundle = { scene };
  if (typeof scene.script === 'string') {
    const ls = await listing(c);
    if (present(ls, scene.script) && !builtIn(ls, scene.script)) {
      const params = await readTunes(c, scene.script);
      bundle.script = { name: scene.script, source: await c.getText(`/api/js/${enc(scene.script)}`), ...(params ? { params } : {}) };
    } else bundle.script = { name: scene.script };
  }
  if (typeof scene.image === 'string') bundle.image = await fetchImage(c, scene.image).catch(() => undefined);
  return bundle;
}

const bundleKey = (b: Bundle) => ({
  scene: b.scene, script: b.script ?? null,
  image: b.image ? { w: b.image.w, h: b.image.h, label: b.image.label ?? null, pixels: digest(Buffer.from(b.image.pixels).toString('base64')) } : null,
});

const sansPower = (s: SceneDoc): SceneDoc => { const { on: _p, ...rest } = s; return rest; };
const sameDoc = (a: object, b: object) => stable(a) === stable(b);

/**
 * Which of `targets` would lose something: a scene of that name, or (when copying a bundle with a script
 * source) a different uploaded script of the script's name. Only lamps that may write scenes are looked at.
 */
async function overwrites(ctx: ToolContext, targets: FleetLamp[], name: string, b?: Bundle): Promise<{ replacing: string[]; what: string[] }> {
  const ids = targets.filter((l) => allows(l, SCENES)).map((l) => l.deviceId);
  const seen = await fanout(ctx, ids, READ, async (c, l) => {
    const existing = await getScene(c, name);
    let scene = false;
    if (existing && b) {
      // what the copy would write there: the source scene without power, its image as the target's id
      const expected: SceneDoc = sansPower(b.scene);
      if (typeof expected.image === 'string') {
        const grid = await gridOf(c, l);
        const id = b.image && b.image.w === grid.w && b.image.h === grid.h ? await findSavedImage(c, b.image) : undefined;
        if (id) expected.image = id; else delete expected.image;
        scene = !id && b.image && b.image.w === grid.w && b.image.h === grid.h ? true : !sameDoc(sansPower(existing), expected);
      } else scene = !sameDoc(sansPower(existing), expected);
    } else scene = !!existing;
    let script = false;
    if (b?.script?.source !== undefined) {
      const ls = await listing(c);
      script = present(ls, b.script.name) && !builtIn(ls, b.script.name)
        && (await c.getText(`/api/js/${enc(b.script.name)}`)) !== b.script.source;
    }
    return { scene, script };
  });
  const replacing: string[] = [];
  const what: string[] = [];
  for (const r of seen) {
    if (!r.ok) continue;
    if (r.scene) { replacing.push(`scene@${r.deviceId}`); what.push(`scene "${name}" on ${r.lamp}`); }
    if (r.script) { replacing.push(`script@${r.deviceId}`); what.push(`script "${b!.script!.name}" on ${r.lamp}`); }
  }
  return { replacing, what };
}

/** Write a bundle to `targets` (after the confirmation step). Shared by scene_copy and library_push_scene. */
async function writeBundle(
  ctx: ToolContext, tool: string, args: { confirm?: string }, targets: FleetLamp[], name: string, b: Bundle, from?: string,
): Promise<CallToolResult> {
  const { replacing, what } = await overwrites(ctx, targets, name, b);
  if (replacing.length) {
    const ask = confirmContent(ctx, tool, args, args.confirm, bundleKey(b), [...replacing, ...targets.map((l) => `to@${l.deviceId}`)],
      `Overwrite ${what.join(', ')}${from ? ` with the scene from ${from}` : ' with the library scene'}.`);
    if (ask) return result(ask);
  }
  return result({ results: await fanout(ctx, targets.map((l) => l.deviceId), SCENES, async (c, l) => {
    const grid = await gridOf(c, l);
    const warnings = await copyScene(c, grid, { name, scene: b.scene, ...(b.script ? { script: b.script } : {}), ...(b.image ? { image: b.image } : {}) });
    return { name, ...(warnings.length ? { warning: warnings.join('; ') } : {}) };
  }) });
}

export function registerScenesTools(server: McpServer, ctx: ToolContext): void {
  const library = new Library(join(ctx.stateDir, 'library'));

  server.registerTool('scenes_list', {
    title: 'List scenes',
    description: 'List the scenes saved on a lamp (name and document; up to 32) and which one is active (`active`, null when the lamp no longer shows it). Read-only.',
    inputSchema: { lamp: lampArg },
    annotations: ro,
  }, async ({ lamp }) => guard(() => single(ctx, lamp, READ, async (c) => {
    const r = await c.get<{ scenes?: Array<{ name: string; scene: SceneDoc }> }>('/api/scenes');
    const st = await c.get<{ scene?: string | null }>('/api/state').catch(() => undefined);
    const scenes = r.scenes ?? [];
    return { scenes, count: scenes.length, max: 32, active: st?.scene ?? null };
  })));

  server.registerTool('scene_get', {
    title: 'Read a scene',
    description: 'Read one scene document from a lamp. Read-only.',
    inputSchema: { lamp: lampArg, name: sceneName },
    annotations: ro,
  }, async ({ lamp, name }) => guard(() => single(ctx, lamp, READ, async (c) => {
    const scene = await getScene(c, name);
    if (!scene) throw new Error(`no scene ${name} on this lamp`);
    return { name, scene };
  })));

  server.registerTool('scene_put', {
    title: 'Write a scene',
    description:
      'Create or overwrite a scene on lamps from a document (`script` must exist on the lamp, `image` is a saved image id ' +
      'of that lamp; a scene does not change power unless `on` is given explicitly). Up to 32 scenes per lamp (more fails ' +
      `with "scene store full"). ${CONFIRM_NOTE} ${NEEDS_SCENES} ${PER_LAMP}`,
    inputSchema: { lamps: lampsArg, name: sceneName, doc: sceneDoc, confirm: confirmArg },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async (args) => guard(async () => {
    const targets = ctx.registry.resolveTargets(normLamps(args.lamps));
    const stale = await differing(ctx, targets, args.name, args.doc);
    if (stale.length) {
      const ask = confirmContent(ctx, 'scene_put', args, args.confirm, args.doc, stale.map((s) => `scene@${s.deviceId}`),
        `Overwrite scene "${args.name}" on ${stale.map((s) => s.lamp).join(', ')}.`);
      if (ask) return result(ask);
    }
    return result({ results: await fanout(ctx, targets.map((l) => l.deviceId), SCENES, async (c) => {
      await c.send('PUT', `/api/scenes/${enc(args.name)}`, args.doc);
      return { name: args.name };
    }) });
  }));

  server.registerTool('scene_capture', {
    title: 'Capture the current state as a scene',
    description:
      'Save what a lamp shows right now (effect + tunes, image, colour, brightness; not power) as a scene. Replacing an ' +
      `existing scene of that name first returns {needsConfirmation, summary, confirm}: show it and repeat with \`confirm\` only after the user agrees. ${NEEDS_SCENES}`,
    inputSchema: { lamp: lampArg, name: sceneName, confirm: confirmArg },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async (args) => guard(async () => {
    const l = ctx.registry.lookup(args.lamp);
    const refused = await ctx.registry.refusalFresh(l, SCENES);
    if (refused) return failure(`${l.name}: ${refused}`);
    const existing = await ctx.registry.call(l.deviceId, (c) => getScene(c, args.name)).catch(() => null);
    if (existing) {
      const ask = confirmContent(ctx, 'scene_capture', args, args.confirm, existing, [`scene@${l.deviceId}`],
        `Replace the scene "${args.name}" on ${l.name} with what the lamp shows now.`);
      if (ask) return result(ask);
    }
    return single(ctx, args.lamp, SCENES, async (c) => {
      const r = await c.send<{ scene?: SceneDoc }>('POST', `/api/scenes/${enc(args.name)}/capture`);
      return { name: args.name, scene: r.scene ?? null };
    });
  }));

  server.registerTool('scene_activate', {
    title: 'Activate a scene',
    description:
      'Apply a saved scene on lamps (effect/image/colour/brightness; power is left as is). Lamps in one swarm mirror it, ' +
      'so one member gets the request and the others report `viaSwarm`. Needs the `control` permission on AI keys. ' + PER_LAMP,
    inputSchema: { lamps: lampsArg, name: sceneName },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ lamps, name }) => guard(async () => result({ results: await swarmFanout(ctx, normLamps(lamps), CONTROL, async (c) => {
    const r = await c.send<{ scene?: SceneDoc }>('POST', `/api/scenes/${enc(name)}/activate`);
    return { name, active: true, ...(r?.scene ? { scene: r.scene } : {}) };
  }) })));

  server.registerTool('scene_delete', {
    title: 'Delete a scene',
    description:
      'Delete a scene from lamps. Always two-step: the first call returns {needsConfirmation, summary, confirm} naming the lamps ' +
      `that have it; show it to the user and repeat with \`confirm\` only after they agree. ${NEEDS_SCENES} ${PER_LAMP}`,
    inputSchema: { lamps: lampsArg, name: sceneName, confirm: confirmArg },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async (args) => guard(async () => {
    const targets = ctx.registry.resolveTargets(normLamps(args.lamps));
    const skipped: Array<{ lamp: string; deviceId: string; ok: false; skipped: true; reason: string }> = [];
    const checkable: FleetLamp[] = [];
    for (const l of targets) {
      const refused = await ctx.registry.refusalFresh(l, SCENES);
      if (refused) skipped.push({ lamp: l.name, deviceId: l.deviceId, ok: false, skipped: true, reason: refused });
      else checkable.push(l);
    }
    const seen = await fanout(ctx, checkable.map((l) => l.deviceId), READ, (c) => getScene(c, args.name).then((s) => ({ has: s !== null })));
    const real: FleetLamp[] = [];
    for (const r of seen) {
      const l = checkable.find((x) => x.deviceId === r.deviceId)!;
      if (r.ok && r.has) real.push(l);
      else skipped.push({ lamp: r.lamp, deviceId: r.deviceId, ok: false, skipped: true, reason: r.ok ? `no scene ${args.name} on this lamp` : r.reason });
    }
    if (!real.length) return result({ results: skipped });
    const ids = real.map((l) => l.deviceId);
    const ask = confirmContent(ctx, 'scene_delete', args, args.confirm, { name: args.name, ids: [...ids].sort() }, ids,
      `Delete the scene "${args.name}" from ${real.map((l) => l.name).join(', ')}. This can't be undone.`);
    if (ask) return result({ ...ask, ...(skipped.length ? { skipped } : {}) });
    const done = await fanout(ctx, ids, SCENES, async (c) => {
      await c.send('DELETE', `/api/scenes/${enc(args.name)}`);
      return { deleted: args.name };
    });
    return result({ results: [...done, ...skipped] });
  }));

  server.registerTool('scene_copy', {
    title: 'Copy a scene between lamps',
    description:
      'Copy a scene from one lamp to others as the apps\' swarm sync does: an uploaded script (source + tune values) and the ' +
      'scene\'s image travel along (the image is saved on the target, the scene points at its new id); a target with another ' +
      'grid gets the scene without the image and a `warning`; a built-in script must exist on the target. The scene is ' +
      `written without power. ${CONFIRM_NOTE} ${NEEDS_SCENES} ${PER_LAMP}`,
    inputSchema: { from: lampArg.describe('Source lamp name or deviceId'), name: sceneName, to: lampsArg, confirm: confirmArg },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async (args) => guard(async () => {
    const from = ctx.registry.lookup(args.from);
    const refused = await ctx.registry.refusalFresh(from, READ);
    if (refused) return failure(`${from.name}: ${refused}`);
    let b: Bundle;
    try {
      b = await ctx.registry.call(from.deviceId, (c) => readBundle(c, args.name));
    } catch (e) {
      return failure(`${from.name}: ${explain(e, from, READ)}`);
    }
    const targets = ctx.registry.resolveTargets(normLamps(args.to)).filter((l) => l.deviceId !== from.deviceId);
    return writeBundle(ctx, 'scene_copy', args, targets, args.name, b, from.name);
  }));

  server.registerTool('library_save_scene', {
    title: 'Save a scene to the library',
    description:
      'Save a scene from a lamp into the library on this computer under the same name, with its uploaded script (source + ' +
      'tune values) and its image pixels, so it can be pushed to other lamps. Replacing a different library entry first returns ' +
      '{needsConfirmation, summary, confirm}: show it and repeat with `confirm` only after the user agrees. Reads the lamp only.',
    inputSchema: { lamp: lampArg, name: sceneName, confirm: confirmArg },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async (args) => guard(async () => {
    const [r] = await fanout(ctx, [args.lamp], READ, (c) => readBundle(c, args.name));
    if (!r!.ok) return result(r, true);
    const b: Bundle = { scene: r!.scene, ...(r!.script ? { script: r!.script } : {}), ...(r!.image ? { image: r!.image } : {}) };
    const doc = toLibrary(b);
    const exists = library.list('scenes').includes(args.name);
    const replaced = exists && digest(library.readScene(args.name)) !== digest(doc);
    if (replaced) {
      const ask = confirmContent(ctx, 'library_save_scene', args, args.confirm, doc, [args.name],
        `Replace the library scene "${args.name}" with the one from ${r!.lamp}.`);
      if (ask) return result(ask);
    }
    library.writeScene(args.name, doc);
    return result({ lamp: r!.lamp, deviceId: r!.deviceId, ok: true, name: args.name, replaced,
      script: b.script?.name ?? null, scriptSource: b.script?.source !== undefined, image: !!b.image });
  }));

  server.registerTool('library_push_scene', {
    title: 'Push a library scene to lamps',
    description:
      'Write a scene from the library on this computer to lamps, with its script and image (as scene_copy). ' +
      `${CONFIRM_NOTE} ${NEEDS_SCENES} ${PER_LAMP}`,
    inputSchema: { name: sceneName.describe('Library scene name (see library_list)'), lamps: lampsArg, confirm: confirmArg },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async (args) => guard(async () => {
    const b = fromLibrary(library.readScene(args.name));
    const targets = ctx.registry.resolveTargets(normLamps(args.lamps));
    return writeBundle(ctx, 'library_push_scene', args, targets, args.name, b);
  }));
}

/** Targets whose existing scene differs from `doc` (scene_put only asks when something would change). */
async function differing(ctx: ToolContext, targets: FleetLamp[], name: string, doc: object): Promise<Array<{ lamp: string; deviceId: string }>> {
  const ids = targets.filter((l) => allows(l, SCENES)).map((l) => l.deviceId);
  const seen = await fanout(ctx, ids, READ, (c) => getScene(c, name).then((scene) => ({ scene })));
  return seen.filter((r) => r.ok && r.scene && !sameDoc(r.scene, doc)).map((r) => ({ lamp: r.lamp, deviceId: r.deviceId }));
}

/** Library file: `{scene, script?: {name, source?, params?}, image?: {w, h, label?, pixels: base64}}`. */
function toLibrary(b: Bundle): object {
  return {
    scene: b.scene,
    ...(b.script ? { script: b.script } : {}),
    ...(b.image ? { image: { w: b.image.w, h: b.image.h, ...(b.image.label ? { label: b.image.label } : {}), pixels: Buffer.from(b.image.pixels).toString('base64') } } : {}),
  };
}

/** Also accepts a plain scene document (a file dropped into the library by hand). */
function fromLibrary(o: object): Bundle {
  const j = o as { scene?: SceneDoc; script?: ScriptPayload; image?: { w: number; h: number; label?: string; pixels: string } };
  if (!j.scene || typeof j.scene !== 'object') return { scene: o as SceneDoc };
  return {
    scene: j.scene,
    ...(j.script ? { script: j.script } : {}),
    ...(j.image ? { image: { w: j.image.w, h: j.image.h, pixels: new Uint8Array(Buffer.from(j.image.pixels, 'base64')), ...(j.image.label ? { label: j.image.label } : {}) } } : {}),
  };
}

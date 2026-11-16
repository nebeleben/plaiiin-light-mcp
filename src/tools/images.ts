import { join } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { allows, type Need } from '../lamp/access';
import type { LampClient } from '../lamp/client';
import { apiGrid, checkGrid } from '../lamp/grid';
import { LampHttpError } from '../lamp/errors';
import { gridToRgb, readPng, resizeToRgb, toPng, type Rgba } from '../images/convert';
import type { FleetLamp } from '../store/fleet';
import { Library } from '../store/library';
import { copyImage, findSavedImage, listImages, readImage } from '../sync/copy';
import { scrub } from '../util/scrub';
import { confirmContent, confirmTargets, digest } from './confirm';
import { errorText, explain, failure, guard, lampArg, lampsArg, normLamps, result, type ToolContext } from './context';
import { fanout, single } from './fanout';

const READ: Need = { minRole: 'user' };
/** Draw / save / show / label / delete images. */
const IMAGES: Need = { perm: 'images', minRole: 'creator' };
/** Switching to frame mode without saving (`POST /api/mode`). */
const CONTROL: Need = { perm: 'control', minRole: 'user' };

const PER_LAMP = 'Returns one result per lamp: `{lamp, ok: true, …}` or `{lamp, ok: false, skipped?, reason}`.';
const NEEDS_IMAGES = 'Needs the `images` permission on AI keys, creator or admin otherwise.';
const ID_NOTE = 'Image ids (`img-001`, …) are per lamp: the same id on two lamps is usually a different image.';

const imageId = z.string().regex(/^[A-Za-z0-9_-]{1,32}$/, 'an image id such as img-001').describe('Image id as listed by images_list (e.g. img-001)');
const ctrlChars = /[\x00-\x1f\x7f]/;
const label = z.string()
  .refine((s) => Buffer.byteLength(s, 'utf8') <= 32, 'at most 32 bytes (UTF-8)')
  .refine((s) => !ctrlChars.test(s), 'no control characters');
const colorCell = z.union([z.string(), z.tuple([z.number().int(), z.number().int(), z.number().int()])]);
const confirmArg = z.string().optional().describe('Token from a previous needsConfirmation answer');
const libName = z.string().regex(/^[A-Za-z0-9_-]{1,32}$/, '1–32 letters, digits, _ or -');

const enc = (n: string) => encodeURIComponent(n);

/** The lamp's logical grid, live (`POST /api/frame` must match it exactly), else the fleet's cached one. */
export async function gridOf(c: LampClient, l: FleetLamp): Promise<{ w: number; h: number }> {
  const a = await c.get<{ logicalW?: number; logicalH?: number }>('/api').catch(() => undefined);
  const live = apiGrid(a);
  if (live) return live;
  if (l.grid) return checkGrid(l.grid);
  throw new Error('the lamp reports no grid size');
}

/** Scene names / library names: spaces → dashes, other characters dropped, ≤ 32 (as SceneEntry.sanitizedName). */
function sanitized(raw: string): string {
  return raw.trim().replace(/ /g, '-').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
}

/** A source image with its label, as copied between lamps / to the library. */
export async function fetchImage(c: LampClient, id: string) {
  const entry = (await listImages(c)).find((e) => e.name === id);
  if (!entry) throw new Error(`no image ${id} on this lamp`);
  const img = await readImage(c, id);
  return { ...img, ...(entry.label ? { label: entry.label } : {}) };
}

export function registerImagesTools(server: McpServer, ctx: ToolContext): void {
  const library = new Library(join(ctx.stateDir, 'library'));
  const ro = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

  server.registerTool('images_list', {
    title: 'List saved images',
    description:
      'List the images saved on a lamp (at most `max`, usually 30): id, label, size and `fitsGrid` (only images drawn ' +
      `for the lamp's current grid can be shown). ${ID_NOTE} Read-only.`,
    inputSchema: { lamp: lampArg },
    annotations: ro,
  }, async ({ lamp }) => guard(() => single(ctx, lamp, READ, async (c, l) => {
    const grid = await gridOf(c, l).catch(() => undefined);
    const r = await c.get<{ images?: Array<{ name: string; w: number; h: number; label?: string }>; count?: number; max?: number }>('/api/images');
    const images = (r.images ?? []).map((i) => ({
      id: i.name, label: i.label ?? null, w: i.w, h: i.h, ...(grid ? { fitsGrid: i.w === grid.w && i.h === grid.h } : {}),
    }));
    return { grid: grid ?? null, images, count: r.count ?? images.length, max: r.max ?? 30 };
  })));

  server.registerTool('image_draw', {
    title: 'Draw an image',
    description:
      'Draw a still image on lamps and show it (frame mode). Give either `pixels` — rows (top to bottom) of colours ' +
      '("#rrggbb" or [r,g,b]), exactly the lamp\'s grid (see images_list / lamp_form_prompt; a grid of another size fails ' +
      'there with "needs a W×H grid") — or `pngPath`, a PNG file on this computer (≤ 16 MB, ≤ 4096×4096 px) that is ' +
      'resized to each lamp\'s grid (transparent = off). This replaces the lamp\'s current drawing (an unsaved drawing ' +
      'is lost) and stops the playing effect or scene. With `save` (default true) the image is also saved on the lamp ' +
      '(with `label`) and its `id` returned; an identical image already saved (same size, label and pixels) is reused ' +
      `(\`reused: true\`) instead of taking a new slot. ${NEEDS_IMAGES} ${PER_LAMP}`,
    inputSchema: {
      lamps: lampsArg,
      pixels: z.array(z.array(colorCell).min(1).max(256)).min(1).max(256).optional().describe('Rows of colours, exactly the lamp grid (h rows of w)'),
      pngPath: z.string().min(1).optional().describe('Absolute path of a PNG file to draw, resized to each lamp\'s grid'),
      label: label.optional().describe('Label for the saved image (1–32 bytes)'),
      save: z.boolean().default(true).describe('Also save it on the lamp (default true)'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (args) => guard(async () => {
    if ((args.pixels === undefined) === (args.pngPath === undefined)) return failure('give either `pixels` or `pngPath`');
    let png: Rgba | undefined;
    if (args.pngPath !== undefined) {
      try { png = readPng(args.pngPath); } catch (e) { return failure(e instanceof Error ? e.message : String(e)); }
    }
    const lbl = args.label || undefined;
    return result({ results: await fanout(ctx, normLamps(args.lamps), IMAGES, async (c, l) => {
      const grid = await gridOf(c, l);
      const rgb = png ? resizeToRgb(png, grid.w, grid.h) : gridToRgb(args.pixels!, grid.w, grid.h);
      await c.sendBinary('POST', '/api/frame', Buffer.from(rgb));
      let id: string | undefined;
      let reused = false;
      let shown = false;
      const warnings: string[] = [];
      if (args.save) {
        id = await findSavedImage(c, { w: grid.w, h: grid.h, pixels: rgb, ...(lbl ? { label: lbl } : {}) });
        reused = !!id;
        if (!id) {
          try {
            id = (await c.send<{ name?: string }>('POST', '/api/images', lbl ? { label: lbl } : {})).name;
          } catch (e) {
            if (!(e instanceof LampHttpError && e.status === 409)) throw e;
            warnings.push('drawn but not saved: the lamp\'s image store is full — delete one with image_delete');
          }
        }
        if (id) {
          try {
            await c.send('POST', `/api/images/${enc(id)}/show`);
            shown = true;
          } catch (e) {
            warnings.push(`saved as ${id} but not shown: ${errorText(e)} — try image_show`);
          }
        }
      }
      if (!id) {
        if (allows(l, CONTROL)) { await c.send('POST', '/api/mode', { mode: 'frame' }); shown = true; }
        else warnings.push('stored as the lamp\'s frame, but switching to frame mode needs the control permission');
      }
      return {
        grid, saved: !!id, ...(id ? { id, reused } : {}), ...(lbl && id ? { label: lbl } : {}), shown,
        note: shown
          ? 'replaced the lamp\'s current drawing (an unsaved drawing is lost) and stopped the playing effect/scene'
          : 'replaced the lamp\'s stored drawing (an unsaved drawing is lost)',
        ...(warnings.length ? { warning: warnings.join('; ') } : {}),
      };
    }) });
  }));

  server.registerTool('image_show', {
    title: 'Show a saved image',
    description: `Show a saved image on lamps (frame mode). ${ID_NOTE} An image drawn for another grid fails with "geometry mismatch". ${NEEDS_IMAGES} ${PER_LAMP}`,
    inputSchema: { lamps: lampsArg, id: imageId },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ lamps, id }) => guard(async () => result({ results: await fanout(ctx, normLamps(lamps), IMAGES, async (c) => {
    await c.send('POST', `/api/images/${enc(id)}/show`);
    return { id, shown: true };
  }) })));

  server.registerTool('image_label', {
    title: 'Label a saved image',
    description: `Set the label of a saved image (1–32 bytes, no control characters; "" clears it). Scenes keep working (they use the id). ${NEEDS_IMAGES}`,
    inputSchema: { lamp: lampArg, id: imageId, label: label.describe('New label; "" clears it') },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (args) => guard(() => single(ctx, args.lamp, IMAGES, async (c) => {
    await c.send('POST', `/api/images/${enc(args.id)}/label`, { label: args.label || null });
    return { id: args.id, label: args.label || null };
  })));

  server.registerTool('image_delete', {
    title: 'Delete a saved image',
    description:
      `Delete a saved image from lamps. ${ID_NOTE} Scenes that show it can't be activated afterwards. Always two-step: ` +
      'the first call returns {needsConfirmation, summary, confirm}; show the summary to the user and repeat with ' +
      `\`confirm\` only after they agree. ${NEEDS_IMAGES} ${PER_LAMP}`,
    inputSchema: { lamps: lampsArg, id: imageId, confirm: confirmArg },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async (args) => guard(async () => {
    const targets = ctx.registry.resolveTargets(normLamps(args.lamps));
    const ids = targets.map((l) => l.deviceId);
    const ask = await confirmTargets(ctx, 'image_delete', args, args.confirm, args.id, ids, async () => {
      const seen = await fanout(ctx, ids, READ, async (c) =>
        ({ label: (await listImages(c)).find((e) => e.name === args.id)?.label ?? null }));
      const what = seen.map((r) => `${r.lamp}${r.ok && r.label ? ` ("${r.label}")` : ''}`).join(', ');
      return `Delete the saved image ${args.id} from ${what}. This can't be undone.`;
    });
    if (ask) return result(ask);
    return result({ results: await fanout(ctx, ids, IMAGES, async (c) => {
      await c.send('DELETE', `/api/images/${enc(args.id)}`);
      return { deleted: args.id };
    }) });
  }));

  server.registerTool('image_get', {
    title: 'Look at a saved image',
    description: 'Return a saved image as a PNG (scaled up for viewing, at most 1024 px a side) plus its id, label and size. Read-only.',
    inputSchema: { lamp: lampArg, id: imageId },
    annotations: ro,
  }, async ({ lamp, id }) => guard(async () => {
    const [r] = await fanout(ctx, [lamp], READ, (c) => fetchImage(c, id));
    if (!r!.ok) return result(r, true);
    const png = toPng(r!.pixels, r!.w, r!.h);
    const info = { lamp: r!.lamp, deviceId: r!.deviceId, ok: true, id, w: r!.w, h: r!.h, label: r!.label ?? null,
      png: { width: png.readUInt32BE(16), height: png.readUInt32BE(20) } };
    return {
      content: [
        { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
        { type: 'text', text: scrub(JSON.stringify(info, null, 2)) },
      ],
    };
  }));

  server.registerTool('image_copy', {
    title: 'Copy an image between lamps',
    description:
      'Copy a saved image (with its label) from one lamp to others, as the apps\' swarm sync does. Only lamps with the ' +
      'same grid can take it (others fail with "needs a W×H lamp"); a target that already has the identical image ' +
      `reuses it. The target's current drawing is kept. Returns the image's \`id\` on each target. ${NEEDS_IMAGES} ${PER_LAMP}`,
    inputSchema: { from: lampArg.describe('Source lamp name or deviceId'), id: imageId, to: lampsArg },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (args) => guard(async () => {
    const from = ctx.registry.lookup(args.from);
    const refused = await ctx.registry.refusalFresh(from, READ);
    if (refused) return failure(`${from.name}: ${refused}`);
    let img: Awaited<ReturnType<typeof fetchImage>>;
    try {
      img = await ctx.registry.call(from.deviceId, (c) => fetchImage(c, args.id));
    } catch (e) {
      return failure(`${from.name}: ${explain(e, from, READ)}`);
    }
    const targets = ctx.registry.resolveTargets(normLamps(args.to)).filter((l) => l.deviceId !== from.deviceId);
    return result({ results: await fanout(ctx, targets.map((l) => l.deviceId), IMAGES, async (c, l) => {
      const grid = await gridOf(c, l);
      if (grid.w !== img.w || grid.h !== img.h) throw new Error(`needs a ${img.w}×${img.h} lamp`);
      return { id: await copyImage(c, img) };
    }) });
  }));

  server.registerTool('library_save_image', {
    title: 'Save image to the library',
    description:
      'Save an image from a lamp into the library on this computer. `name` defaults to the image\'s label (spaces → ' +
      'dashes, other characters dropped) or its id. Replacing a different library image of that name first returns ' +
      '{needsConfirmation, summary, confirm}: show the summary and repeat with `confirm` only after the user agrees. Reads the lamp only.',
    inputSchema: { lamp: lampArg, id: imageId, name: libName.optional().describe('Library name (1–32 letters, digits, _ or -)'), confirm: confirmArg },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async (args) => guard(async () => {
    const [r] = await fanout(ctx, [args.lamp], READ, (c) => fetchImage(c, args.id));
    if (!r!.ok) return result(r, true);
    const img = { w: r!.w, h: r!.h, pixels: r!.pixels, ...(r!.label ? { label: r!.label } : {}) };
    const name = args.name ?? (sanitized(img.label ?? '') || args.id);
    const key = (i: { w: number; h: number; label?: string; pixels: Uint8Array }) =>
      digest({ w: i.w, h: i.h, label: i.label ?? null, pixels: Buffer.from(i.pixels).toString('base64') });
    const existing = library.list('images').includes(name) ? library.readImage(name) : undefined;
    const replaced = !!existing && key(existing) !== key(img);
    if (replaced) {
      const ask = confirmContent(ctx, 'library_save_image', args, args.confirm, key(img), [name],
        `Replace the library image "${name}" with ${args.id} from ${r!.lamp}.`);
      if (ask) return result(ask);
    }
    library.writeImage(name, img);
    return result({ lamp: r!.lamp, deviceId: r!.deviceId, ok: true, name, w: img.w, h: img.h, label: img.label ?? null, replaced });
  }));

  server.registerTool('library_push_image', {
    title: 'Push a library image to lamps',
    description:
      'Save an image from the library on this computer onto lamps (with its label). Only lamps with the image\'s grid ' +
      'can take it (others fail with "needs a W×H lamp"); a lamp that already has the identical image reuses it. ' +
      `Returns the image's \`id\` on each lamp; use image_show to display it. ${NEEDS_IMAGES} ${PER_LAMP}`,
    inputSchema: { name: libName.describe('Library image name (see library_list)'), lamps: lampsArg },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (args) => guard(async () => {
    const img = library.readImage(args.name);
    return result({ results: await fanout(ctx, normLamps(args.lamps), IMAGES, async (c, l) => {
      const grid = await gridOf(c, l);
      if (grid.w !== img.w || grid.h !== img.h) throw new Error(`needs a ${img.w}×${img.h} lamp`);
      return { id: await copyImage(c, img) };
    }) });
  }));
}

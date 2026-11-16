/**
 * Copying scripts, images and scenes to a lamp — the same semantics as the swarm sync in the
 * PlaiiinLight apps. Used by the image, scene and effect copy tools.
 */
import type { LampClient } from '../lamp/client';
import { listing, present, putSource, putTunes } from '../lamp/scripts';

/** A saved lamp state (firmware docs/protocol.md "Scenes"); every field optional. */
export interface SceneDoc {
  on?: boolean; mode?: string; script?: string; params?: Record<string, number>;
  image?: string; color?: number[]; brightness?: number;
  [k: string]: unknown;
}
/** A script to copy. No `source` = nothing to copy (a built-in): the target must already have it. */
export interface ScriptPayload { name: string; source?: string; params?: Record<string, number> }
/** An image to copy: row-major RGB, w·h·3 bytes. */
export interface ImagePayload { w: number; h: number; pixels: Uint8Array; label?: string }

interface ImageList { images?: Array<{ name: string; w: number; h: number; label?: string }> }

const enc = (n: string) => encodeURIComponent(n);
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && Buffer.from(a).equals(Buffer.from(b));

/** Write the script (when it has a source) and its tune values; without a source the target must have it. */
export async function copyScript(c: LampClient, s: ScriptPayload): Promise<void> {
  if (s.source !== undefined) await putSource(c, s.name, s.source);
  else if (!present(await listing(c), s.name)) throw new Error(`script ${s.name} isn't on this lamp`);
  if (s.params && Object.keys(s.params).length) await putTunes(c, s.name, s.params);
}

/** The lamp's image ids/labels/sizes. */
export async function listImages(c: LampClient): Promise<NonNullable<ImageList['images']>> {
  return (await c.get<ImageList>('/api/images')).images ?? [];
}

/** A saved image's pixels and size (from the `X-Frame-W`/`X-Frame-H` headers). */
export async function readImage(c: LampClient, id: string): Promise<{ w: number; h: number; pixels: Uint8Array }> {
  const r = await c.getBinary(`/api/images/${enc(id)}`);
  const w = Number(r.headers['x-frame-w']), h = Number(r.headers['x-frame-h']);
  if (!(w > 0 && h > 0) || r.data.length !== w * h * 3) throw new Error(`image ${id}: the lamp sent ${r.data.length} bytes without a matching size`);
  return { w, h, pixels: new Uint8Array(r.data) };
}

/** The id of an identical image already saved on the lamp (same size, label and pixels), if any. */
export async function findSavedImage(c: LampClient, img: ImagePayload): Promise<string | undefined> {
  const label = img.label || undefined;
  for (const e of await listImages(c)) {
    if (e.w !== img.w || e.h !== img.h || (e.label || undefined) !== label) continue;
    if (same((await readImage(c, e.name)).pixels, img.pixels)) return e.name;
  }
  return undefined;
}

/**
 * Save `img` on the lamp and return its id there. An identical image already saved (same size, label
 * and pixels) is reused, so repeated copies don't fill the lamp's 30 slots. Saving goes through the
 * lamp's frame (the firmware snapshots its current frame), which is put back afterwards — also when
 * saving fails.
 */
export async function copyImage(c: LampClient, img: ImagePayload): Promise<string> {
  const label = img.label || undefined;
  const existing = await findSavedImage(c, img);
  if (existing) return existing;
  const previous = await c.getBinary('/api/frame').then((r) => r.data, () => undefined);
  await c.sendBinary('POST', '/api/frame', Buffer.from(img.pixels));
  const restore = async () => {
    if (previous && previous.length === img.pixels.length) await c.sendBinary('POST', '/api/frame', previous).catch(() => undefined);
  };
  try {
    const r = await c.send<{ name?: string }>('POST', '/api/images', label ? { label } : {});
    if (!r.name) throw new Error('the lamp saved the image but returned no id');
    return r.name;
  } finally {
    await restore();
  }
}

/**
 * Write a scene to a lamp with a `w`×`h` grid. Its script travels along; its image is re-saved on the
 * target and the scene rewritten to the new id — or, when the image is for another grid (or its pixels
 * aren't available), left out with a warning. The scene is written without power (`on`).
 * Returns the warnings.
 */
export async function copyScene(
  c: LampClient, grid: { w: number; h: number },
  p: { name: string; scene: SceneDoc; script?: ScriptPayload; image?: ImagePayload },
): Promise<string[]> {
  const warnings: string[] = [];
  const { on: _power, ...scene } = p.scene;
  if (p.script) await copyScript(c, p.script);
  if (scene.image === null) delete scene.image;
  if (scene.image !== undefined) {
    if (p.image && p.image.w === grid.w && p.image.h === grid.h) {
      scene.image = await copyImage(c, p.image);
    } else {
      warnings.push(p.image ? `image not copied (needs a ${p.image.w}×${p.image.h} lamp)` : 'image not copied');
      delete scene.image;
    }
  }
  await c.send('PUT', `/api/scenes/${enc(p.name)}`, scene);
  return warnings;
}
